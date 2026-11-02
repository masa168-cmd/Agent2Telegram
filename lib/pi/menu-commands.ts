import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTelegramMyCommands } from "../core/telegram-api.ts";
import { log } from "../core/logger.ts";
import { loadRecentCommands } from "../core/command-usage.ts";
import { getTuiCommands, type TuiCommand } from "./tui-bridge.ts";

const menuLog = log.child("menu-commands");

const TELEGRAM_MENU_COMMANDS: Array<{ command: string; description: string }> = [
  // Keep the built-in pi commands in the same order as the TUI slash menu.
  { command: "login", description: "Configure provider authentication" },
  { command: "logout", description: "Remove stored credentials" },
  { command: "model", description: "Show or change the current model" },
  { command: "scoped-models", description: "Enable/disable models for cycling" },
  { command: "settings", description: "Open settings menu" },
  { command: "resume", description: "Resume a previous session" },
  { command: "new", description: "Start a new session" },
  { command: "name", description: "Set or show session name" },
  { command: "session", description: "Show session statistics" },
  { command: "tree", description: "Navigate session tree" },
  { command: "trust", description: "Save project trust decision" },
  { command: "fork", description: "Fork from a previous message" },
  { command: "clone", description: "Clone at a previous message" },
  { command: "compact", description: "Compact session context" },
  { command: "copy", description: "Copy last assistant message" },
  { command: "export", description: "Export session" },
  { command: "share", description: "Share session as gist" },
  { command: "reload", description: "Reload pi resources" },
  { command: "hotkeys", description: "Show keyboard shortcuts" },
  { command: "changelog", description: "Show changelog" },
  { command: "restart", description: "Restart pi with this session (tmux only)" },

  // Additional pi-telegram-plus commands.
  { command: "cwd", description: "Show current working directory" },
  { command: "cd", description: "Switch pi working directory" },
  { command: "import", description: "Import a session" },
  { command: "stop", description: "Stop the current agent turn" },
  { command: "status", description: "Show runtime snapshot (workspace, model, context, messages)" },
  // Consolidated Telegram management menu — replaces all flat /tg-* commands.
  { command: "tg", description: "Open the Telegram management menu" },
];

/**
 * Host commands that should stay near the top of the 100-entry BotMenu. These
 * are the common interactive entry points, not an attempt to mirror the full
 * (unbounded) TUI catalog.
 */
const CORE_COMMAND_PRIORITY = [
  "tools", "mcp", "agents", "permissions", "hooks", "skills", "plugins", "marketplace",
  "plan", "goal", "review", "theme", "trust", "init", "help", "commands",
  "clear", "cost", "context", "diff", "undo", "redo",
];

// Commands the plugin itself dispatches from Telegram (handlers in
// telegramCommands, or the /tg hub), valid on every host regardless of the
// captured catalog.
const TELEGRAM_SERVED_COMMANDS = new Set([
  "tg", "cwd", "cd", "status", "stop", "restart",
]);

/** Never offered from Telegram: quitting is a terminal action; use /restart instead. */
export const TELEGRAM_BLOCKED_COMMANDS = new Set(["quit", "exit"]);

/** Commands kept out of the BotMenu: SSH-only ones (still answered with the SSH notice) and
 *  terminal-bound ones such as scoped-models, which only affects the Ctrl+P cycle. */
const TELEGRAM_MENU_HIDDEN = new Set(["login", "logout", "tg_setup", "scoped_models"]);

/**
 * Chinese BotMenu wording for the plugin's own and Pi 1.4.0's built-in commands.
 * It wins over the host's English description; commands of other extensions
 * keep their own description.
 */
const ZH_DESCRIPTIONS: Record<string, string> = {
  login: "配置模型服务商登录",
  logout: "删除已保存的登录凭据",
  model: "查看或切换当前模型",
  settings: "打开设置菜单",
  thinking: "设置思考档位",
  resume: "恢复另一个会话",
  new: "新建会话",
  name: "设置或查看会话名称",
  session: "查看会话信息和统计",
  tree: "浏览会话树（切换分支）",
  trust: "保存项目信任设置",
  fork: "从之前的消息分叉出新会话",
  clone: "在当前位置复制会话",
  compact: "手动压缩会话上下文",
  copy: "复制最后一条回复",
  export: "导出会话",
  import: "从 JSONL 文件导入并恢复会话",
  share: "分享会话（会上传内容）",
  bug: "向 Pi 开发者报告问题",
  reload: "重新加载扩展、技能、提示词和主题",
  hotkeys: "查看快捷键",
  changelog: "查看更新日志",
  restart: "重启 Pi 并恢复当前会话（需 tmux）",
  cwd: "查看当前工作目录",
  cd: "切换 Pi 工作目录",
  stop: "停止当前任务",
  status: "查看运行状态（目录、模型、上下文、消息）",
  tg: "打开 Telegram 管理菜单",
  more: "更多命令",
};

const toTelegramCommandName = (name: string): string | undefined => {
  // Telegram bot menu commands allow only [A-Za-z0-9_] and max 32 chars.
  const telegramName = name.replace(/-/g, "_").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(telegramName)) return undefined;
  return telegramName;
};

export type MenuCommandOptions = {
  /** Recently used commands, newest first. */
  recent?: readonly string[];
  /** Host builtin/autocomplete catalog captured by the TUI bridge. */
  tuiCommands?: readonly TuiCommand[];
};

export type TelegramMenuBuildResult = {
  /** The list sent to setMyCommands: at most 100 entries; the last is `more` when there is an overflow. */
  commands: Array<{ command: string; description: string }>;
  /** Commands that fit no more in the 100-entry menu; served by the /more inline keyboard. */
  overflow: Array<{ command: string; description: string }>;
};

export function buildTelegramMenuCommandsFull(
  pi: Pick<ExtensionAPI, "getCommands">,
  options: MenuCommandOptions = {},
): TelegramMenuBuildResult {
  const commands = new Map<string, string>();
  const addCommand = (name: string, description?: string) => {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName || commands.has(telegramName) || TELEGRAM_BLOCKED_COMMANDS.has(telegramName)
      || TELEGRAM_MENU_HIDDEN.has(telegramName)) return;
    commands.set(telegramName, (ZH_DESCRIPTIONS[telegramName] ?? (description?.trim() || `运行 /${telegramName}`)).slice(0, 256));
  };

  // When the TUI bridge has captured the host catalog, a static entry the host
  // does not actually serve would reach no handler and fall through to the
  // model as prompt text (e.g. `clone` on OMP, or `thinking` where the host has
  // no native command). Filter static entries against the live catalog; keep
  // plugin-served commands. With no captured catalog, keep the curated list.
  const catalogNames = new Set<string>();
  const catalogDescriptions = new Map<string, string>();
  const noteCatalog = (name: string, description?: string) => {
    const n = toTelegramCommandName(name);
    if (!n) return;
    catalogNames.add(n);
    const trimmed = description?.trim();
    if (trimmed && !catalogDescriptions.has(n)) catalogDescriptions.set(n, trimmed);
  };
  for (const command of options.tuiCommands ?? []) noteCatalog(command.name, command.description);
  for (const command of pi.getCommands()) noteCatalog(command.name, command.description);
  const catalogAvailable = (options.tuiCommands?.length ?? 0) > 0;
  for (const command of TELEGRAM_MENU_COMMANDS) {
    const n = toTelegramCommandName(command.command);
    if (catalogAvailable && n && !catalogNames.has(n) && !TELEGRAM_SERVED_COMMANDS.has(n)) continue;
    // The static copy is a fallback wording; the live host description wins so
    // the BotMenu never shows text the host itself stopped using.
    addCommand(command.command, (n ? catalogDescriptions.get(n) : undefined) ?? command.description);
  }

  const recentPriority = new Map<string, number>();
  for (const [index, name] of (options.recent ?? []).entries()) {
    const telegramName = toTelegramCommandName(name);
    if (!telegramName) continue;
    if (!recentPriority.has(telegramName)) recentPriority.set(telegramName, index);
  }

  // Priority queue for dynamic commands (host + extensions + recent)
  const dynamic: Array<{ name: string; desc?: string }> = [];
  const seenDynamic = new Set<string>();
  for (const command of options.tuiCommands ?? []) {
    const n = toTelegramCommandName(command.name);
    if (!n) continue;
    if (commands.has(n)) continue;
    if (seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name: command.name, desc: command.description });
  }
  for (const cmd of pi.getCommands()) {
    const n = toTelegramCommandName(cmd.name);
    if (!n) continue;
    if (commands.has(n)) continue;
    if (seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name: cmd.name, desc: cmd.description });
  }
  for (const name of options.recent ?? []) {
    const n = toTelegramCommandName(name);
    if (!n) continue;
    if (commands.has(n) || seenDynamic.has(n)) continue;
    seenDynamic.add(n);
    dynamic.push({ name, desc: undefined });
  }

  // Core host commands stay first. Recent usage then boosts non-core dynamic
  // commands without displacing the curated Telegram entry points.
  const pri = new Map(CORE_COMMAND_PRIORITY.map((c, i) => [c.replace(/-/g, "_").toLowerCase(), i]));
  dynamic.sort((a, b) => {
    const an = toTelegramCommandName(a.name) ?? a.name.replace(/-/g, "_").toLowerCase();
    const bn = toTelegramCommandName(b.name) ?? b.name.replace(/-/g, "_").toLowerCase();
    const pa = pri.get(an) ?? Number.MAX_SAFE_INTEGER;
    const pb = pri.get(bn) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    const ra = recentPriority.get(an) ?? Number.MAX_SAFE_INTEGER;
    const rb = recentPriority.get(bn) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return an.localeCompare(bn);
  });

  for (const d of dynamic) addCommand(d.name, d.desc);

  const all = Array.from(commands, ([command, description]) => ({ command, description }));
  if (all.length <= 100) return { commands: all, overflow: [] };
  // Reserve the last menu slot for /more, which opens an inline keyboard over
  // the overflow; each button dispatches its command like a typed message.
  const kept = all.slice(0, 99);
  const overflow = all.slice(99);
  // A host that defines its own /more already occupies a kept slot; do not
  // send setMyCommands a duplicate command name.
  if (!kept.some((entry) => entry.command === "more")) kept.push({ command: "more", description: ZH_DESCRIPTIONS.more! });
  return { commands: kept, overflow };
}

export function buildTelegramMenuCommands(
  pi: Pick<ExtensionAPI, "getCommands">,
  options: MenuCommandOptions = {},
): Array<{ command: string; description: string }> {
  return buildTelegramMenuCommandsFull(pi, options).commands;
}

const menuSyncInFlight = new Map<string, Promise<void>>();
const menuSyncScheduled = new Map<string, ReturnType<typeof setTimeout>>();

function syncKey(botToken: string, apiBase?: string): string {
  return `${apiBase ?? "https://api.telegram.org"}\u0000${botToken}`;
}

const menuOverflowByBot = new Map<string, Array<{ command: string; description: string }>>();
const menuAllByBot = new Map<string, Array<{ command: string; description: string }>>();

/** Text of the former single input-area button; still recognised so a stale keyboard never prompts the model. */
export const COMMAND_MENU_BUTTON = "📋 命令";

/** Buttons per row and the button cap of the input-area command keyboard. */
const KEYBOARD_ROW_SIZE = 3;
const KEYBOARD_MAX_BUTTONS = 99;

/**
 * Persistent reply-keyboard rows for the phone input area: every synced menu command as `/name`,
 * in menu order. Tapping one sends that command as a normal message. Empty until the first sync.
 */
export function getTelegramCommandKeyboard(botToken: string | undefined, apiBase?: string): string[][] {
  const names = getTelegramMenuAll(botToken, apiBase).slice(0, KEYBOARD_MAX_BUTTONS).map(entry => `/${entry.command}`);
  const rows: string[][] = [];
  for (let i = 0; i < names.length; i += KEYBOARD_ROW_SIZE) rows.push(names.slice(i, i + KEYBOARD_ROW_SIZE));
  return rows;
}

/** Every command of the last menu sync (BotMenu entries without /more, then the overflow). */
export function getTelegramMenuAll(botToken: string | undefined, apiBase?: string): Array<{ command: string; description: string }> {
  if (!botToken) return [];
  return menuAllByBot.get(syncKey(botToken, apiBase)) ?? [];
}

/** Overflow commands from the last menu sync for this bot, newest menu first. */
export function getTelegramMenuOverflow(botToken: string | undefined, apiBase?: string): Array<{ command: string; description: string }> {
  if (!botToken) return [];
  return menuOverflowByBot.get(syncKey(botToken, apiBase)) ?? [];
}

async function doSyncTelegramCommands(botToken: string, pi: ExtensionAPI, apiBase?: string): Promise<void> {
  const [recent, tuiCommands] = await Promise.all([
    loadRecentCommands().catch(() => []),
    getTuiCommands().catch(() => []),
  ]);
  const { commands, overflow } = buildTelegramMenuCommandsFull(pi, { recent, tuiCommands });
  await setTelegramMyCommands(botToken, commands, apiBase);
  menuOverflowByBot.set(syncKey(botToken, apiBase), overflow);
  const all = overflow.length > 0 ? commands.filter(entry => entry.command !== "more") : commands;
  menuAllByBot.set(syncKey(botToken, apiBase), [...all, ...overflow]);
}

export async function syncTelegramCommands(botToken: string | undefined, pi: ExtensionAPI, apiBase?: string): Promise<void> {
  if (!botToken) return;
  const key = syncKey(botToken, apiBase);
  const existing = menuSyncInFlight.get(key);
  if (existing) {
    try {
      await existing;
    } catch (err) {
      menuLog.warn("syncTelegramCommands failed", { err });
    }
    return;
  }

  const sync = doSyncTelegramCommands(botToken, pi, apiBase);
  menuSyncInFlight.set(key, sync);
  try {
    await sync;
  } catch (err) {
    menuLog.warn("syncTelegramCommands failed", { err });
  } finally {
    if (menuSyncInFlight.get(key) === sync) menuSyncInFlight.delete(key);
  }
}

export function scheduleTelegramCommandRefresh(botToken: string | undefined, pi: ExtensionAPI, apiBase?: string, delayMs = 250): void {
  if (!botToken) return;
  const key = `${syncKey(botToken, apiBase)}\u0000${delayMs}`;
  const existing = menuSyncScheduled.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    menuSyncScheduled.delete(key);
    void syncTelegramCommands(botToken, pi, apiBase);
  }, delayMs);
  timer.unref?.();
  menuSyncScheduled.set(key, timer);
}

/**
 * Drop pending command refreshes; call from extension dispose. The scheduled
 * sync captured this instance's `pi` context, which the host invalidates on
 * reload — firing afterwards only logs "extension ctx is stale".
 */
export function cancelTelegramCommandRefreshes(): void {
  for (const timer of menuSyncScheduled.values()) clearTimeout(timer);
  menuSyncScheduled.clear();
}
