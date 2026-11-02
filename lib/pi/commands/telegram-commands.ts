import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addBot, ONE_BOT_TEXT, readBotRegistry, removeBot, removeProjectBinding, updateBot, updateProjectBindingLocked, readProjectBinding, readResolvedTelegramConfig, withTelegramConfigLock } from "../../core/config.ts";
import { escapeHtml } from "../../core/html.ts";
import { getTelegramBotUsername } from "../../core/telegram-api.ts";
import { createTelegramPairingCode, ensureTelegramPairingCode, formatPairingInstructions, isPairingCodeExpired, pairingCodeExpiry } from "../../core/pairing.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig, TelegramTransport } from "../../core/types.ts";
import { log } from "../../core/logger.ts";

const tgCmdLog = log.child("tg-commands");

/** Live Telegram connection state of THIS pi process, as reported by the runtime. */
export type TelegramConnectionState = "connected" | "connecting" | "disconnected";

export type TelegramCommandDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (c: TelegramConfig) => void;
  persistConfig: (c: TelegramConfig) => Promise<void>;
  getResolvedConfig: () => ResolvedTelegramConfig | undefined;
  switchResolvedConfig: (next: ResolvedTelegramConfig) => void;
  isTelegramEnabled: () => boolean;
  transport: TelegramTransport;
  /** This session's link to the agent2telegram gateway (connect / disconnect). */
  getConnection: () => { start(): void; stop(): Promise<void>; isActive(): boolean };
  refreshStatus: () => void;
  syncTelegramCommands: () => Promise<void>;
  startStatusHeartbeat: () => void;
  clearStatusError: () => void;
  /** Actual runtime connection state (status-bar source), not config fields. */
  connectionState: () => TelegramConnectionState;
  /** Trigger a coordinator reconcile and wait for it to settle (so the menu
   *  can re-render with the real connection state right after a toggle). */
  awaitReconcile: () => Promise<void>;
};

// ── Shared UI type ─────────────────────────────────────────────────────────

export type MenuUi = {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  /** Telegram only: select that edits one menu message in place across calls. */
  menu?: (title: string, options: string[]) => Promise<string | undefined>;
  /** Telegram only: drop the keyboard of the live menu message. */
  closeMenu?: () => Promise<void>;
};

// ── Reusable flow functions (shared by the /tg menu) ───────────────────────

export async function listBotsFlow(ui: MenuUi): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Add one in /tg → Bots → ➕ Add bot.", "info");
    return;
  }
  const lines = registry.bots.map((bot) => {
    const defaultMarker = registry.defaultBotId === bot.id ? " ⭐ default" : "";
    const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
    const paired = bot.allowedUserId !== undefined ? `paired (user ${bot.allowedUserId})`
      : bot.pairingCode && !isPairingCodeExpired({ pairingCodeExpiresAt: bot.pairingCodeExpiresAt }) ? `pairing: ${bot.pairingCode}`
      : bot.pairingCode ? "pairing code expired" : "not paired";
    return `- ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)}) · ${username} · ${paired}${defaultMarker}`;
  });
  ui.notify(`Registered bots:\n${lines.join("\n")}`, "info");
}

export async function addBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  name?: string,
  token?: string,
): Promise<void> {
  if ((await readBotRegistry()).bots.length > 0) {
    ui.notify(ONE_BOT_TEXT, "error");
    return;
  }
  const botName = name ?? await ui.input("Bot name (unique label, e.g. 'work-bot')");
  if (!botName) return;
  const botToken = token ?? await (ui.inputSecret?.("Telegram bot token (from @BotFather)") ?? ui.input("Telegram bot token (from @BotFather)"));
  if (!botToken) return;
  const registry = await readBotRegistry();
  if (registry.bots.some((b) => b.name.toLowerCase() === botName.toLowerCase())) {
    ui.notify(`A bot named "${escapeHtml(botName)}" already exists. Choose a different name.`, "error");
    return;
  }
  const apiBase = deps.getConfig().apiBase;
  const botUsername = await getTelegramBotUsername(botToken, apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-add"));
  const pairingCode = createTelegramPairingCode();
  const bot: BotRecord = {
    id: randomUUID(),
    name: botName,
    token: botToken,
    ...(botUsername === undefined ? {} : { botUsername }),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(pairingCode === undefined ? {} : { pairingCode, pairingCodeExpiresAt: pairingCodeExpiry() }),
  };
  const updatedRegistry = await addBot(bot);
  const isDefault = updatedRegistry.defaultBotId === bot.id;
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ui.notify(
    `Bot added: ${escapeHtml(botName)}${botUsername ? ` (@${botUsername})` : ""}${isDefault ? " — set as default" : ""}\n${formatPairingInstructions({ ...bot, botToken } as TelegramConfig)}`,
    "info",
  );
}

/** Re-resolve this process's routing after a registry change, so a token
 *  switch or removal takes effect now instead of on restart. The upstream
 *  status error belongs to the previous routing; drop it so a stopped poller
 *  does not show a stale "error" instead of "not configured". */
async function refreshRouting(deps: TelegramCommandDeps, cwd: string): Promise<void> {
  deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
  deps.clearStatusError();
  deps.refreshStatus();
}

export async function updateBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  field?: string,
  value?: string,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  const selectedField = field ?? await ui.input("Field to update (token, name, allowedUserId, apiBase, forumChatId)");
  if (!selectedField) return;
  const validFields = ["token", "name", "allowedUserId", "apiBase", "forumChatId"];
  if (!validFields.includes(selectedField)) {
    ui.notify(`Invalid field. Choose from: ${validFields.join(", ")}`, "error");
    return;
  }
  let fieldValue: string | undefined;
  if (selectedField === "token") {
    fieldValue = value ?? await (ui.inputSecret?.("New token") ?? ui.input("New token"));
  } else {
    fieldValue = value ?? await ui.input(`New value for ${selectedField}`);
  }
  if (!fieldValue) return;
  const updates: Partial<Omit<BotRecord, "id">> = {};
  if (selectedField === "token") {
    updates.token = fieldValue;
    const botUsername = await getTelegramBotUsername(fieldValue, bot.apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-update"));
    if (botUsername) updates.botUsername = botUsername;
  } else if (selectedField === "name") {
    if (registry.bots.some((b) => b.id !== bot.id && b.name.toLowerCase() === fieldValue!.toLowerCase())) {
      ui.notify(`A bot named "${escapeHtml(fieldValue)}" already exists.`, "error");
      return;
    }
    updates.name = fieldValue;
  } else if (selectedField === "allowedUserId") {
    const userId = Number(fieldValue);
    if (!Number.isInteger(userId)) {
      ui.notify(`Invalid allowedUserId: must be an integer.`, "error");
      return;
    }
    updates.allowedUserId = userId;
  } else if (selectedField === "apiBase") {
    updates.apiBase = fieldValue;
  } else if (selectedField === "forumChatId") {
    const chatId = Number(fieldValue);
    if (fieldValue !== "off" && (!Number.isSafeInteger(chatId) || chatId >= 0)) {
      ui.notify("forumChatId must be a negative supergroup ID, or 'off'.", "error"); return;
    }
    updates.forumChatId = fieldValue === "off" ? undefined : chatId;
  }
  await updateBot(bot.id, updates);
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.syncTelegramCommands();
    deps.refreshStatus();
  }
  ui.notify(`Bot updated: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})`, "info");
}

export async function removeBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  skipConfirm = false,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  if (!skipConfirm) {
    const confirmed = await ui.confirm(`Remove bot "${bot.name}"?`, `This will remove the bot from the registry. Any project .pi/telegram.json referencing this bot will lose its binding.`);
    if (!confirmed) return;
  }
  const wasDefault = registry.defaultBotId === bot.id;
  await removeBot(bot.id);
  if (wasDefault) {
    ui.notify(`Warning: removed bot was the default. ${registry.bots.length > 1 ? "A remaining bot was promoted." : "No default bot is set."}`, "warning");
  }
  ui.notify(
    `Bot removed: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})\nAny project .pi/telegram.json referencing this bot will lose its binding.`,
    "warning",
  );
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.getConnection().stop();
    deps.refreshStatus();
  }
}

/** Issue a fresh pairing code for a bot. When this pi runs exactly this bot,
 *  mirror the code into the live config so the poller accepts the new
 *  `/pair <code>` without a restart. */
export async function regeneratePairingCodeFlow(ui: MenuUi, deps: TelegramCommandDeps, botId: string): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  const pairingCode = createTelegramPairingCode();
  const pairingCodeExpiresAt = pairingCodeExpiry();
  await updateBot(bot.id, { pairingCode, pairingCodeExpiresAt });
  if (deps.getConfig().botToken === bot.token) {
    deps.setConfig({ ...deps.getConfig(), pairingCode, pairingCodeExpiresAt });
    deps.refreshStatus();
  }
  ui.notify(formatPairingInstructions({ ...bot, botToken: bot.token, pairingCode, pairingCodeExpiresAt } as TelegramConfig), "info");
}

/** Unpair the authorized Telegram user from a bot: clear allowedUserId and
 *  issue a fresh pairing code (the old code must not re-authorize the old
 *  user's chat). Destructive for the live chat, so confirm first. Re-pairing
 *  itself still happens on Telegram via `/pair <code>`. */
export async function unpairBotFlow(ui: MenuUi, deps: TelegramCommandDeps, botId: string): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  const confirmed = await ui.confirm("Unpair?", "This chat will stop working until you pair again with the new code.");
  if (!confirmed) return;
  const pairingCode = createTelegramPairingCode();
  const pairingCodeExpiresAt = pairingCodeExpiry();
  await updateBot(bot.id, { allowedUserId: undefined, pairingCode, pairingCodeExpiresAt });
  if (deps.getConfig().botToken === bot.token) {
    deps.setConfig({ ...deps.getConfig(), allowedUserId: undefined, pairingCode, pairingCodeExpiresAt });
    deps.refreshStatus();
  }
  ui.notify(formatPairingInstructions({ ...bot, botToken: bot.token, allowedUserId: undefined, pairingCode, pairingCodeExpiresAt } as TelegramConfig), "info");
}

export async function enableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Add one in /tg → Bots → ➕ Add bot.", "error");
    return;
  }
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (project) {
    if (project.binding.botId === undefined) {
      // Disconnect record for the default bot (written by disableProjectFlow
      // with no botId): re-enabling means "back to plain default-bot
      // behavior" → remove the binding entirely. Under the config lock so a
      // concurrent runtime-state persist cannot resurrect the file.
      await withTelegramConfigLock(() => removeProjectBinding(project.path));
    } else {
      await updateProjectBindingLocked(project.path, (b) => ({ ...b, enabled: true }));
    }
  } else {
    // The agent's one Bot is used; the binding records only that this folder is on.
    await updateProjectBindingLocked(workspacePath, () => ({ enabled: true }));
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  deps.setConfig({ ...deps.getConfig(), telegramEnabled: true });
  await deps.getConnection().stop();
  if (deps.isTelegramEnabled()) deps.getConnection().start();
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  await deps.awaitReconcile();
  deps.refreshStatus();
  ui.notify("Telegram connected for this folder.", "info");
}

export async function disableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  // Notify BEFORE the disconnect: once reconcile below releases the active
  // role, the active transport suppresses outbound sends, so this is the last
  // message Telegram will deliver for this project. Reconnect is terminal-only
  // from here on (/tg → Project → Connect).
  ui.notify("Telegram disconnected for this folder. It will stop responding; reconnect from the terminal with /tg.", "info");
  if (project) {
    await updateProjectBindingLocked(project.path, (b) => ({ ...b, enabled: false }));
  } else {
    // No binding: write a disconnect record WITHOUT botId — "still uses the
    // default bot, but disconnected" — so the readResolvedTelegramConfig
    // re-read below sees enabled=false instead of materializing the default
    // enabled=true (an in-memory setConfig would be reverted by that re-read).
    await updateProjectBindingLocked(workspacePath, () => ({ enabled: false }));
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  await deps.getConnection().stop();
  deps.clearStatusError();
  await deps.awaitReconcile();
  deps.refreshStatus();
}
