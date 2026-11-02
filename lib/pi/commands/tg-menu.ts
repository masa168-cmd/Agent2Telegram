import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { forumTopicLink } from "../../core/forum-binding.ts";
import { basename } from "node:path";
import type { MenuUi, TelegramCommandDeps } from "./telegram-commands.ts";
import type { TgConfigDeps, SessionDeps } from "./register.ts";
import type { TelegramConfig } from "../../core/types.ts";
import type { CapturedAgentSession } from "../captured-session.ts";
import { currentHostName } from "../tui/host.ts";
import type { TuiHost } from "../tui-bridge.ts";
import { configToolFlow, configRetryFlow } from "./tg-config.ts";
import { formatDebugReport } from "./info.ts";

// ── Menu option labels ─────────────────────────────────────────────────────

const MAIN_MENU_OPTIONS = [
  "⌨️ Commands",
  "⚙️ Config",
  "🧵 Online sessions",
  "🛠 Debug info",
  "❌ Close",
] as const;

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";

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
): Promise<void> {
  try {
    await mainMenu(ui, deps, configDeps, switchDeps, commandDeps, sessionDeps, cwd);
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
): Promise<void> {
  const options: string[] = MAIN_MENU_OPTIONS
    .filter(option => commandDeps || option !== "⌨️ Commands");
  while (true) {
    const choice = await pick(ui, "Telegram Management", options);
    if (!choice || choice === "❌ Close") return;

    if (choice === "⌨️ Commands") {
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
