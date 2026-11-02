import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { forumTopicLink } from "../../core/forum-binding.ts";
import { basename } from "node:path";
import { agentBot, readBotRegistry } from "../../core/config.ts";
import type { MenuUi, TelegramCommandDeps, TelegramConnectionState } from "./telegram-commands.ts";
import type { TgConfigDeps, SessionDeps } from "./register.ts";
import type { BotRecord, BotRegistry, TelegramConfig } from "../../core/types.ts";
import type { CapturedAgentSession } from "../captured-session.ts";
import { currentHostName } from "../tui/host.ts";
import type { TuiHost } from "../tui-bridge.ts";
import { configToolFlow, configRetryFlow } from "./tg-config.ts";
import { formatPairingInstructions } from "../../core/pairing.ts";
import { getCurrentTelegramTurn } from "../../core/turn-context.ts";
import { formatDebugReport } from "./info.ts";
import {
  addBotFlow,
  regeneratePairingCodeFlow,
  unpairBotFlow,
  updateBotFlow,
  removeBotFlow,
  enableProjectFlow,
  disableProjectFlow,
} from "./telegram-commands.ts";

// ── Menu option labels ─────────────────────────────────────────────────────

const MAIN_MENU_OPTIONS = [
  "🤖 Bots",
  "📁 Project",
  "⌨️ Commands",
  "⚙️ Config",
  "🧵 Online sessions",
  "🛠 Debug info",
  "❌ Close",
] as const;

const BOTS_MENU_ADD = "➕ Add bot";
const BOTS_MENU_LIST = "Bot list";

const BOT_ACTION_UPDATE = "Update";
const BOT_ACTION_PAIRING = "Pairing";
const BOT_ACTION_REMOVE = "Remove";
const PAIRING_ACTION_UNPAIR = "Unpair";
const PAIRING_ACTION_NEW_CODE = "New pairing code";

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";

/** Format a registered bot for display in bot-list / pickers. */
function formatBotLabel(bot: BotRecord, registry: BotRegistry): string {
  const marker = registry.defaultBotId === bot.id ? " ⭐ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  const paired = bot.allowedUserId !== undefined ? "paired" : "not paired";
  return `${bot.name}${marker} · ${username} · ${paired}`;
}

/** Thrown from a leaf action that moves this pi off the current bot: the menu's
 *  chat stops being polled, so the whole /tg menu exits instead of returning
 *  to a submenu nobody can press. */
class MenuClosed extends Error {}

/** Navigation select. On Telegram, ui.menu edits one message in place so the
 *  whole /tg navigation stays on a single message; the TUI has no edit concept
 *  and falls back to ui.select. */
function pick(ui: MenuUi, title: string, options: string[]): Promise<string | undefined> {
  return ui.menu ? ui.menu(title, options) : ui.select(title, options);
}

// ── Switch instance flow deps ──────────────────────────────────────────────

export type CommandMenuDeps = {
  /** Full catalog (plugin + host builtins/extensions), deduped by the caller. */
  getCommands: () => Promise<Array<{ name: string; description?: string }>>;
  /** Execute a command in the current Telegram chat. */
  runCommand: (name: string, args: string) => Promise<void>;
};

export type SwitchInstanceDeps = {
  /** The online sessions of this Bot, from the agent2telegram gateway. */
  listSessions: () => Promise<Array<{ cwd: string; threadId?: number; sessionId?: string; pid?: number }>>;
  getForumChatId: () => number | undefined;
};

// ── Menu registration ──────────────────────────────────────────────────────

export function registerTgMenuCommand(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps?: CommandMenuDeps,
  sessionDeps?: SessionDeps,
): void {
  registry.registerCommand("tg", {
    description: "Open the Telegram management menu",
    handler: (_args, ctx) => runTgMenu(
      // MenuUi is the structural subset of ExtensionUIContext the menu flows
      // consume (plus Telegram-only menu/closeMenu hooks injected by the
      // controller's run-with-UI wrapper).
      ctx.ui as unknown as MenuUi,
      deps, configDeps, switchDeps, commandDeps, sessionDeps, ctx.cwd || process.cwd(),
      getCurrentTelegramTurn() !== undefined,
    ),
  });
}

// ── Menu driver ─────────────────────────────────────────────────────────────

async function runTgMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
  telegramOrigin: boolean,
): Promise<void> {
  try {
    await mainMenu(ui, deps, configDeps, switchDeps, commandDeps, sessionDeps, cwd, telegramOrigin);
  } catch (error) {
    if (!(error instanceof MenuClosed)) throw error;
  } finally {
    await ui.closeMenu?.();
  }
}

async function mainMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
  telegramOrigin: boolean,
): Promise<void> {
  const forumMode = deps.getConfig().forumChatId !== undefined;
  const options: string[] = MAIN_MENU_OPTIONS
    .filter(option => (commandDeps || option !== "⌨️ Commands")
      && (!forumMode || !telegramOrigin || (option !== "🤖 Bots" && option !== "📁 Project")));
  while (true) {
    const choice = await pick(ui, "Telegram Management", options);
    if (!choice || choice === "❌ Close") return;

    if (forumMode && telegramOrigin && (choice === "🤖 Bots" || choice === "📁 Project")) {
      ui.notify("Bot、密钥和项目连接维护请使用手机 SSH；话题菜单不会修改全局 Bot。", "warning");
      continue;
    }
    if (choice === "🤖 Bots") {
      if (await botsMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "📁 Project") {
      if (await projectMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "⌨️ Commands") {
      if (commandDeps) await commandsMenu(ui, commandDeps);
      continue;
    } else if (choice === "⚙️ Config") {
      if (await configMenu(ui, configDeps, sessionDeps)) continue;
      return;
    } else if (choice === "🧵 Online sessions") {
      if (await switchInstanceMenu(ui, switchDeps, deps.getConfig().forumChatId)) continue;
      return;
    } else if (choice === "🛠 Debug info") {
      const session = sessionDeps?.getSession();
      if (session) {
        ui.notify(formatDebugReport(session, cwd), "info");
      } else {
        ui.notify("No active session", "error");
      }
      continue;
    }
    // Unknown choice — return to main menu
  }
}

// ── Full command catalog ───────────────────────────────────────────────────

async function commandsMenu(ui: MenuUi, deps: CommandMenuDeps): Promise<void> {
  const commands = (await deps.getCommands()).filter((command) => command.name !== "tg");
  if (commands.length === 0) {
    ui.notify("No commands are available.", "info");
    return;
  }
  const labels = commands.map((command) => `/${command.name}${command.description ? ` — ${command.description}` : ""}`);
  const selected = await pick(ui, `⌨️ Commands (${commands.length})`, [...labels, BACK_LABEL]);
  if (!selected || selected === BACK_LABEL) return;
  const index = labels.indexOf(selected);
  const command = commands[index];
  if (!command) return;
  await deps.runCommand(command.name, "");
}

// ── Bots submenu ───────────────────────────────────────────────────────────

async function botsMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    // One agent, one Bot: offer "Add" only while there is none.
    const registry = await readBotRegistry();
    const choice = await pick(ui, "🤖 Bots", [...(registry.bots.length === 0 ? [BOTS_MENU_ADD] : []), BOTS_MENU_LIST, BACK_LABEL]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice === BOTS_MENU_ADD) {
      await addBotFlow(ui, deps);
    } else if (choice === BOTS_MENU_LIST) {
      await botListMenu(ui, deps, cwd);
    }
    // loop re-renders the Bots submenu
  }
}

// ── Bot list (object-first: pick a bot → per-bot actions) ──────────────────

async function botListMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify(`No bots registered. Use ${BOTS_MENU_ADD} first.`, "info");
      return;
    }
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await pick(ui, "Bot list", [...choices, BACK_LABEL]);
    if (!selected || selected === BACK_LABEL) return; // back to Bots submenu
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot) await botDetailMenu(ui, deps, cwd, bot);
    // loop re-renders the bot list (reflects remove/pairing changes)
  }
}

// ── Per-bot actions ──────────────────────────────────────────────────────────

async function botDetailMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  bot: BotRecord,
): Promise<void> {
  while (true) {
    // Re-read each iteration so the bot's existence stays fresh.
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return; // removed elsewhere → back to bot list
    }
    const choice = await pick(ui, `🤖 ${botNow.name}`, [BOT_ACTION_UPDATE, BOT_ACTION_PAIRING, BOT_ACTION_REMOVE, BACK_LABEL]);
    if (!choice || choice === BACK_LABEL) return; // back to bot list

    if (choice === BOT_ACTION_UPDATE) {
      await updateBotFlow(ui, deps, cwd, botNow.id);
    } else if (choice === BOT_ACTION_PAIRING) {
      await pairingMenu(ui, deps, botNow);
    } else if (choice === BOT_ACTION_REMOVE) {
      await removeBotFlow(ui, deps, cwd, botNow.id);
      const removed = !(await readBotRegistry()).bots.some((b) => b.id === botNow.id);
      if (removed) return; // back to bot list (re-reads without this bot); declined → stay here
    }
    // loop re-renders the per-bot action menu (re-reads registry)
  }
}

// ── Per-bot pairing page ─────────────────────────────────────────────────────

async function pairingMenu(ui: MenuUi, deps: TelegramCommandDeps, bot: BotRecord): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return;
    }
    const paired = botNow.allowedUserId !== undefined;
    // The menu UI only offers select/notify: the state/instructions go out as
    // a notify right before the choices render.
    if (paired) {
      ui.notify(`Paired user: ${botNow.allowedUserId}`, "info");
    } else {
      ui.notify(formatPairingInstructions({ ...botNow, botToken: botNow.token } as TelegramConfig), "info");
    }
    const choice = await pick(
      ui,
      `🔑 Pairing · ${botNow.name}`,
      paired ? [PAIRING_ACTION_UNPAIR, BACK_LABEL] : [PAIRING_ACTION_NEW_CODE, BACK_LABEL],
    );
    if (!choice || choice === BACK_LABEL) return; // back to bot detail

    if (choice === PAIRING_ACTION_NEW_CODE) {
      await regeneratePairingCodeFlow(ui, deps, botNow.id);
    } else if (choice === PAIRING_ACTION_UNPAIR) {
      await unpairBotFlow(ui, deps, botNow.id);
    }
    // loop re-renders the pairing page (fresh code / pairing state)
  }
}

// ── Project submenu (binding + real connection state) ──────────────────────

/** Second item: the actual runtime connection state (same source as the
 *  status bar), offered as the matching action. */
function connectionChoice(state: TelegramConnectionState): string {
  if (state === "connected") return "🟢 Connected → Disconnect";
  if (state === "connecting") return "🔄 Connecting → Disconnect";
  return "⚪ Disconnected → Connect";
}

async function projectMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    // The agent's one Bot (an old binding botId is ignored, as the gateway does).
    const effectiveBot = agentBot(await readBotRegistry());
    const botLabel = effectiveBot ? `Bot: ${effectiveBot.name}` : "Bot: not set";

    const connection = deps.connectionState();
    const connectLabel = connectionChoice(connection);

    const choice = await pick(ui, "📁 Project", [
      botLabel,
      // No usable bot means nothing to connect; hide this entry.
      ...(effectiveBot ? [connectLabel] : []),
      BACK_LABEL,
    ]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice === botLabel) {
      // Each agent has one Bot (its default) and the gateway polls it.
      ui.notify(effectiveBot
        ? "每个 Agent 只有一个 Bot；更换 Bot 请在终端运行 a2t setup pi，然后 a2t gateway restart。"
        : "还没有配置 Bot：在终端运行 a2t setup pi。", "info");
    } else if (choice === connectLabel) {
      if (connection === "disconnected") {
        // flow awaits reconcile, so the next render shows the new state.
        await enableProjectFlow(ui, deps, cwd);
      } else {
        const ok = await ui.confirm(
          "Disconnect Telegram for this folder?",
          "Telegram will stop responding. Reconnect only from the terminal with /tg.",
        );
        if (ok) await disableProjectFlow(ui, deps, cwd);
      }
    }
    // loop re-renders Project (binding + live connection state)
  }
}

// ── Config submenu ─────────────────────────────────────────────────────────

/** Build the Config submenu entries. Model thinking level lives on the
 * session, not the bridge config; the flat thinking command was removed, so
 * this menu is its Telegram-side home on OMP (no Telegram-reachable hotkey).
 * pi has a native /thinking command that Telegram forwards and its selector
 * can already operate, so hide the entry there instead of duplicating it. */
export function buildConfigMenuOptions(
  config: TelegramConfig,
  session: CapturedAgentSession | undefined,
  host: TuiHost,
): string[] {
  const thinkingLevels = session?.getAvailableThinkingLevels() ?? [];
  return [
    `🔧 Tool: ${config.tool ?? "brief"}`,
    ...(host !== "pi" && thinkingLevels.length > 0
      ? [`🧠 Thinking level: ${session?.thinkingLevel ?? "off"}`]
      : []),
    `🔄 Retry: ${config.retryCount ?? 3}`,
    BACK_LABEL,
  ];
}

async function configMenu(ui: MenuUi, configDeps: TgConfigDeps, sessionDeps?: SessionDeps): Promise<boolean> {
  while (true) {
    const session = sessionDeps?.getSession();
    const thinkingLevels = session?.getAvailableThinkingLevels() ?? [];

    const choice = await pick(ui, CONFIG_MENU_PREFIX, buildConfigMenuOptions(configDeps.getConfig(), session, currentHostName()));
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice.startsWith("🔧 Tool:")) {
      await configToolFlow(ui, configDeps);
    } else if (choice.startsWith("🧠 Thinking level:")) {
      if (!session || thinkingLevels.length === 0) continue;
      const labels = thinkingLevels.map((l) => (l === session.thinkingLevel ? "● " : "  ") + String(l));
      const selected = await pick(ui, "Thinking level", labels);
      if (!selected) continue;
      const level = thinkingLevels[labels.indexOf(selected)];
      if (level !== undefined) {
        session.setThinkingLevel(level);
        ui.notify(`Thinking level set: ${level}`, "info");
      }
    } else if (choice.startsWith("🔄 Retry:")) {
      await configRetryFlow(ui, configDeps);
    }
  }
}

// ── Switch instance submenu ────────────────────────────────────────────────

async function switchInstanceMenu(ui: MenuUi, switchDeps: SwitchInstanceDeps, forumChatId?: number): Promise<boolean> {
  const chatId = forumChatId ?? switchDeps.getForumChatId();
  const sessions = (await switchDeps.listSessions().catch(() => [])).filter(s => s.threadId !== undefined);
  if (chatId === undefined || sessions.length === 0) {
    ui.notify("现在没有在线的 Pi 会话（或网关未运行）。", "info");
    return true;
  }
  const choices = sessions.map(s => `${basename(s.cwd) || s.cwd} · ${(s.sessionId ?? "session").slice(0, 8)}`);
  const selected = await pick(ui, "在线 Pi 会话（点击后查看话题链接）", [...choices, BACK_LABEL]);
  const target = sessions[choices.indexOf(selected ?? "")];
  if (target?.threadId) ui.notify(forumTopicLink(chatId, target.threadId) ?? `Topic ${target.threadId}`, "info");
  return true;
}
