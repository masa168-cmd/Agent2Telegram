import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActiveTelegramTransport } from "./lib/core/active-transport.ts";
import { a2tCacheDir } from "./lib/core/a2t-home.ts";
import { registerTelegramAttachmentTool } from "./lib/pi/attachments.ts";
import { enableConfiguredTelegramOnStartup, readResolvedTelegramConfig, persistProjectRuntimeState, getAgentDir } from "./lib/core/config.ts";
import { createTelegramController, type TelegramCommandHandler } from "./lib/pi/controller.ts";
import { escapeHtml } from "./lib/core/html.ts";
import { createHeartbeat } from "./lib/core/heartbeat.ts";
import { mainOnlyEvents } from "./lib/pi/main-only-pi.ts";
import { registerTelegramRenderer } from "./lib/pi/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/pi/session-capture.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramBotUsername, getTelegramFile } from "./lib/core/telegram-api.ts";
import { createTelegramUiRuntime } from "./lib/pi/telegram-ui.ts";
import { formatTelegramStatusLine, clearTelegramStatus, TELEGRAM_STATUS_KEY } from "./lib/core/status.ts";
import { installTelegramStatusAlignment } from "./lib/pi/status-footer.ts";
import { ForumSession } from "./lib/pi/forum-session.ts";
import { createForumTelegramTransport } from "./lib/pi/forum-transport.ts";
import { forumTopicLink, sameForumTarget } from "./lib/core/forum-binding.ts";
import { deliverPendingNotices } from "./lib/core/pending-notices.ts";
import { initLogger, log, type LogLevel } from "./lib/core/logger.ts";
import { getCurrentTelegramTurn } from "./lib/core/turn-context.ts";

import { registerAllCommands } from "./lib/pi/commands/register.ts";
import { registerTgMenuCommand } from "./lib/pi/commands/tg-menu.ts";
import { registerContextBudgetCommand } from "./lib/pi/commands/context-budget.ts";
import { ContextBudgetRuntime } from "./lib/pi/context-budget/runtime.ts";
import { syncTelegramCommands, scheduleTelegramCommandRefresh, cancelTelegramCommandRefreshes, getTelegramCommandKeyboard } from "./lib/pi/menu-commands.ts";
import { installTuiBridge, tuiBridge, getTuiCommands } from "./lib/pi/tui-bridge.ts";
import { SecretStore } from "./lib/pi/tui/secrets.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTurn } from "./lib/core/types.ts";

const indexLog = log.child("index");

type TelegramPlusRuntimeState = {
  /** The live runtime's teardown, so a reload or a new session replaces it. */
  dispose?: () => void;
};

const TELEGRAM_PLUS_RUNTIME_STATE = Symbol.for("pi-telegram-plus-ex.runtime-state");

function getTelegramPlusRuntimeState(): TelegramPlusRuntimeState {
  const g = globalThis as typeof globalThis & Record<symbol, TelegramPlusRuntimeState | undefined>;
  g[TELEGRAM_PLUS_RUNTIME_STATE] ??= {};
  return g[TELEGRAM_PLUS_RUNTIME_STATE];
}

export default function piTelegramPlusEx(rawPi: ExtensionAPI): void {
  // OMP sub-agent sessions re-run this factory and register their own event
  // handlers; the wrapper keeps those handlers from running inside sub-agents.
  const pi = mainOnlyEvents(rawPi, () => disposeInertRuntime());
  installAgentSessionCapture();
  installTelegramStatusAlignment();
  // Patch the TUI initializer before the host creates InteractiveMode. This is
  // best-effort and never blocks startup; session_start awaits readiness.
  void installTuiBridge();
  // Initialize file logging first, before any subsystem can emit. Log directory
  // lives under the pi agent cache dir alongside tg.json; level is overridable
  // via PI_TELEGRAM_PLUS_LOG_LEVEL (debug/info/warn/error). See lib/core/logger.ts.
  const envLevel = process.env.PI_TELEGRAM_PLUS_LOG_LEVEL?.toLowerCase();
  const level: LogLevel = (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error")
    ? envLevel
    : "info";
  initLogger({ dir: join(getAgentDir(), "logs"), level });
  const runtimeState = getTelegramPlusRuntimeState();

  let config: TelegramConfig = {};
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let sessionContext: ExtensionContext | undefined;
  let announcedForumLease: string | undefined;
  /** Re-connect the forum session after a config or session change (set once the runtime is built). */
  let requestForumSync: () => void = () => undefined;
  const activeTurnKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  // Per chat/thread active turns: prevents interleaving in one Telegram target
  // while allowing different topics in the same supergroup to stay isolated.
  const activeTurns = new Map<string, TelegramTurn>();
  let lastStatusError: string | undefined;
  // Collapses a retry storm into one outage notice + one recovery notice.

  const setConfig = (nextConfig: TelegramConfig) => {
    const routingChanged = config.botToken !== nextConfig.botToken
      || config.telegramEnabled !== nextConfig.telegramEnabled
      || config.forumChatId !== nextConfig.forumChatId
      || config.apiBase !== nextConfig.apiBase;
    config = nextConfig;
    if (resolvedConfig) resolvedConfig.config = nextConfig;
    refreshStatus();
    if (routingChanged) {
      void forum.close().then(() => requestForumSync());
    }
  };

  const currentSessionCwd = (): string => {
    const session = getActiveSession();
    return session?.extensionRunner?.createCommandContext?.().cwd ?? process.cwd();
  };

  const sanitizeIncomingFileName = (value: string): string => {
    const trimmed = value.trim().replace(/\.[^./\\]+$/, "");
    const sanitized = trimmed
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_");
    const compact = sanitized.replace(/^\.+/, "").replace(/\.+$/, "");
    return compact.slice(0, 120) || "attachment";
  };

  const inferIncomingExtension = (fileName: string | undefined, filePath: string | undefined): string => {
    const source = filePath || fileName;
    if (!source) return ".bin";
    const extension = extname(source).toLowerCase();
    return extension || ".bin";
  };

  const buildIncomingAttachmentPath = (fileId: string, fileName: string | undefined, filePath: string, dir: string): string => {
    const ext = inferIncomingExtension(fileName, filePath);
    const base = fileName
      ? sanitizeIncomingFileName(fileName)
      : sanitizeIncomingFileName(filePath || "telegram-file");
    const safeFileId = fileId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return resolve(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFileId.slice(0, 18)}-${base}${ext}`);
  };

  /** Uploads live in one cache directory instead of the project: ~/.agent2telegram/cache/uploads/<launch dir name>/. */
  const incomingUploadDir = (cwd: string): string => join(a2tCacheDir(),
    "uploads", sanitizeIncomingFileName(basename(resolve(cwd)) || "root"));

  const persistCurrentConfig = async (nextConfig = config): Promise<void> => {
    if (!resolvedConfig) resolvedConfig = await readResolvedTelegramConfig(currentSessionCwd());
    resolvedConfig = await persistProjectRuntimeState(resolvedConfig, nextConfig, currentSessionCwd());
    config = resolvedConfig.config;
  };

  const switchResolvedConfig = (next: ResolvedTelegramConfig) => {
    const routingChanged = config.botToken !== next.config.botToken
      || config.telegramEnabled !== next.config.telegramEnabled
      || config.forumChatId !== next.config.forumChatId
      || config.apiBase !== next.config.apiBase;
    resolvedConfig = next;
    config = next.config;
    refreshStatus();
    if (routingChanged) {
      void forum.close().then(() => requestForumSync());
    }
  };

  const isTelegramEnabled = (): boolean => {
    if (config.telegramEnabled !== undefined) return config.telegramEnabled;
    // Default: if a bot resolves, telegram is enabled.
    return !!config.botToken;
  };

  const forum = new ForumSession({
    pi, getConfig: () => config,
    // The agent2telegram gateway polls the Bot and hands this session its topic's updates.
    socketPath: () => join(getAgentDir(), "gateway.sock"),
    onChange: () => onForumChange(),
    onNotice: text => getActiveSession()?.extensionRunner.getUIContext().notify(text, "info"),
    onError: error => { indexLog.warn("Forum session unavailable", { error }); refreshStatus(); },
    onUpdate: async ({ update }) => {
      if (disposed || !forum.isCurrentOperation()) return;
      try {
        if (update.callback_query) await controller.handleCallbackQuery(update.callback_query);
        if (update.message) await controller.handleMessage(update.message);
      } catch (error) {
        lastStatusError = "会话消息处理发生错误，请检查状态，不要自动重复提交。";
        refreshStatus();
        const target = forum.getTarget();
        if (target) await transport.sendText(target.chatId, lastStatusError, target.threadId)
          .catch(indexLog.swallow("warn", "send forum processing-failure notice failed"));
        throw error;
      }
    },
  });
  const getOperationSession = () => disposed || !forum.isCurrentOperation() ? undefined : getActiveSession();
  // One destination: this directory's topic.
  const getOutputConfig = (): TelegramConfig => ({ ...config, activeChatId: forum.getTarget()?.chatId });
  const getSendLease = () => disposed ? undefined : forum.lease();
  const canSend = () => getSendLease() !== undefined;
  const activeBaseTransport = createTelegramTransport(() => config, {
    getSendLease,
    shouldSend: (lease) => lease !== undefined && lease === getSendLease(),
  });
  const transport = createActiveTelegramTransport(createForumTelegramTransport(activeBaseTransport, forum), {
    isActive: canSend,
    getLease: getSendLease,
  });
  // One store for the whole instance: the Broker and the plugin UI runtime
  // remember what this chat typed, the renderer needs the same view to redact
  // assistant replies.
  const secretStore = new SecretStore();
  const ui = createTelegramUiRuntime({
    getSession: getActiveSession,
    transport,
    secrets: secretStore,
    allowSecretInputs: () => false, // a forum group is readable by its members
    isCurrent: () => !disposed && forum.isCurrentOperation(),
  });

  const getCurrentActiveTurn = (): TelegramTurn | undefined => getCurrentTelegramTurn();

  const heartbeat = createHeartbeat({
    getConfig: () => config,
    getActiveTurns: () => [...activeTurns.values()],
    sendChatAction: (chatId, action, messageThreadId) => transport.sendChatAction(chatId, action, messageThreadId),
  });

  const telegramCommands = new Map<string, TelegramCommandHandler>();
  const sessionDeps = { getSession: () => forum.hasRemoteOperation ? getOperationSession() : getActiveSession() };
  const contextBudget = new ContextBudgetRuntime(pi, {
    getSession: getActiveSession,
    supported: () => tuiBridge.isAvailable() && tuiBridge.getHost() === "pi" && !tuiBridge.getUnsupportedReason(),
    captureOperation: () => {
      const remote = getCurrentTelegramTurn();
      const lease = remote ? getSendLease() : undefined;
      const token = config.botToken;
      const user = config.allowedUserId;
      const apiBase = config.apiBase;
      return () => !disposed && (!remote || (lease !== undefined && lease === getSendLease()
        && token === config.botToken && user === config.allowedUserId && apiBase === config.apiBase
        && (!forum.hasRemoteOperation || forum.isCurrentOperation())));
    },
  });
  registerContextBudgetCommand(pi, contextBudget);
  const tgConfigDeps = {
    ...sessionDeps,
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
  };

  // Plugin commands that also appear in the host TUI slash menu. Telegram bot
  // management is deliberately NOT registered in the TUI: bot tokens and
  // local-cwd bindings must not surface as terminal slash commands; the /tg
  // menu owns these flows, reachable only from Telegram chats.
  // /import is excluded too: it is now a built-in pi command; Telegram handler
  // registration only.
  const TUI_VISIBLE_COMMANDS = new Set([
    "tg",
    "cwd", "cd", "status", "stop", "debug", "restart",
  ]);

  registerAllCommands({
    registerCommand: (name: string, options: { description?: string; handler: TelegramCommandHandler }) => {
      telegramCommands.set(name, options.handler);
      if (TUI_VISIBLE_COMMANDS.has(name) && options.description) {
        pi.registerCommand(name, { description: options.description, handler: options.handler });
      }
    },
  }, sessionDeps, {
    getTransport: () => transport,
    getActiveChatId: () => getOutputConfig().activeChatId,
    getActiveTurn: getCurrentActiveTurn,
  });

  // /tg menu: Pi's own items (Commands / Config / Online sessions / Debug info).
  // Bots, pairing and per-folder connect/disconnect are managed by `a2t`.
  let runCommandFromMenu: ((name: string, args: string) => Promise<void>) | undefined;
  registerTgMenuCommand({
    registerCommand: (name: string, options: { description?: string; handler: TelegramCommandHandler }) => {
      telegramCommands.set(name, options.handler);
      if (TUI_VISIBLE_COMMANDS.has(name) && options.description) {
        pi.registerCommand(name, { description: options.description, handler: options.handler });
      }
    },
  }, {
    getConfig: () => config,
  }, tgConfigDeps, {
    listSessions: () => forum.listSessions(),
    getForumChatId: () => config.forumChatId,
  }, {
    getCommands: async () => {
      const seen = new Set<string>();
      const commands: Array<{ name: string; description?: string }> = [];
      const add = (name: string, description?: string) => {
        const clean = name.replace(/^\//, "");
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        commands.push({ name: clean, ...(description ? { description } : {}) });
      };
      for (const command of pi.getCommands()) add(command.name, command.description);
      for (const command of await getTuiCommands().catch(() => [])) add(command.name, command.description);
      // Hosts that do not surface extension commands through getCommands()
      // (OMP) would otherwise hide /status, /tg, and friends from this menu.
      for (const name of telegramCommands.keys()) add(name);
      return commands;
    },
    runCommand: async (name, args) => {
      if (!runCommandFromMenu) return;
      await runCommandFromMenu(name, args);
    },
  }, sessionDeps);

  pi.registerCommand("tg-forum", {
    description: "仅 SSH：查看本目录话题的连接状态",
    handler: async (_args, ctx) => {
      const target = forum.getTarget();
      ctx.ui.notify(target
        ? `话题在线：${forumTopicLink(target.chatId, target.threadId) ?? target.threadId}`
        : forum.lastError ?? "正在连接 agent2telegram 网关…", "info");
    },
  });

  registerTelegramAttachmentTool(pi, {
    getActiveTurn: getCurrentActiveTurn,
    getDefaultChatId: () => forum.getTarget()?.chatId,
    isActive: canSend,
    transport,
  });

  registerTelegramRenderer(pi, {
    getConfig: getOutputConfig,
    transport,
    getActiveTurn: (chatId?: number, messageThreadId?: number) => {
      if (chatId !== undefined) return activeTurns.get(activeTurnKey(chatId, messageThreadId));
      return getCurrentActiveTurn();
    },
    // A forum runtime has exactly one destination, even if host events lose async-local context.
    hasActiveTurns: () => false,
    getSendLease,
    getSession: getActiveSession,
    secrets: secretStore,
  });

  // Only the user set by `a2t setup` may operate this session.
  const authorizeUser = async (userId: number | undefined): Promise<boolean> =>
    userId !== undefined && userId === config.allowedUserId;

  const controller = createTelegramController({
    getSession: getOperationSession,
    isCurrent: () => !disposed && forum.isCurrentOperation(),
    getLocalDialogOrigin: () => {
      const target = forum.getTarget();
      return target ? { chatId: target.chatId, messageThreadId: target.threadId } : undefined;
    },
    transport,
    secrets: secretStore,
    ui,
    authorizeUser,
    telegramCommands,
    saveIncomingTelegramAttachment: async (fileId, fileName, kind) => {
      const token = config.botToken;
      if (!token) {
        throw new Error("Telegram bot token is not configured");
      }
      const target = forum.getTarget();
      const cwd = currentSessionCwd();
      const apiBase = config.apiBase;
      const ensureCurrent = () => {
        if (disposed || config.botToken !== token || !sameForumTarget(target, forum.getTarget())) {
          throw new Error("Attachment belongs to an obsolete session; not saved or submitted");
        }
      };
      ensureCurrent();
      const fileInfo = await getTelegramFile(token, fileId, undefined, apiBase);
      ensureCurrent();
      const data = await downloadTelegramFile(token, fileInfo.file_path, undefined, apiBase);
      ensureCurrent();
      const uploadDir = incomingUploadDir(cwd);
      await mkdir(uploadDir, { recursive: true, mode: 0o700 });
      ensureCurrent();
      const outputPath = buildIncomingAttachmentPath(fileId, fileName || kind, fileInfo.file_path, uploadDir);
      await writeFile(outputPath, data, { flag: "wx", mode: 0o600 });
      return outputPath;
    },
    getActiveTurn: (chatId: number, messageThreadId?: number) => activeTurns.get(activeTurnKey(chatId, messageThreadId)),
    getActiveTurns: () => [...activeTurns.values()],
    beginTelegramTurn: (chatId, replaceMessageId, messageThreadId, sourceMessageId) => {
      const target = forum.getTarget();
      if (!target || chatId !== target.chatId || messageThreadId !== target.threadId) return undefined;
      const key = activeTurnKey(chatId, messageThreadId);
      if (activeTurns.has(key)) return undefined; // reject if this chat/thread is busy
      const turn: TelegramTurn = { chatId, messageThreadId, sourceMessageId, replaceMessageId, queuedAttachments: [] };
      activeTurns.set(key, turn);
      refreshStatus();
      return turn;
    },
    endTelegramTurn: (chatId, turn) => {
      const key = activeTurnKey(chatId, turn.messageThreadId);
      if (activeTurns.get(key) === turn) activeTurns.delete(key);
      refreshStatus();
    },
    setActiveChatId: async (chatId) => {
      if (config.activeChatId === chatId) return;
      config = { ...config, activeChatId: chatId };
      await persistCurrentConfig(config);
      refreshStatus();
    },
    getBotUsername: () => config.botUsername,
    getConfig: () => config,
    tuiBridge,
    isTelegramActive: () => isTelegramEnabled() && canSend(),
  });

  runCommandFromMenu = async (name, args) => {
    const turn = getCurrentTelegramTurn();
    const chatId = turn?.chatId ?? getOutputConfig().activeChatId;
    if (chatId === undefined) return;
    await controller.runCommand(name, args, chatId, turn?.messageThreadId ?? forum.getTarget()?.threadId, turn?.sourceMessageId);
  };

  // Announce each new connection of this session in its topic, with the command keyboard.
  const onForumChange = (): void => {
    refreshStatus();
    const forumLease = forum.lease();
    if (!forumLease || announcedForumLease === forumLease) return;
    announcedForumLease = forumLease;
    const target = forum.getTarget()!;
    const token = config.botToken;
    const apiBase = config.apiBase;
    // The keyboard lists the synced menu, so wait for the host catalog and the menu sync.
    void (async () => {
      await tuiBridge.ready();
      await syncTelegramCommands(token, pi, apiBase);
      if (disposed || config.botToken !== token || forum.lease() !== forumLease) return;
      const keyboard = getTelegramCommandKeyboard(token, apiBase);
      await transport.sendText(target.chatId,
        `<b>— 会话 ${escapeHtml(target.sessionId.slice(0, 8))} 已接入 —</b>\n本话题对应此目录；/new、恢复会话后仍在本话题，以上为之前会话的内容。`, target.threadId,
        undefined, undefined, keyboard.length > 0 ? { replyKeyboard: keyboard } : undefined);
      // Notices a superseded runtime queued (/new and /reload results).
      deliverPendingNotices(transport);
    })().catch(indexLog.swallow("warn", "send forum online notice failed"));
  };

  requestForumSync = () => {
    if (disposed || !sessionContext) return;
    if (!config.botToken || !isTelegramEnabled()) { void forum.close().then(() => refreshStatus()); return; }
    void forum.prepare(sessionContext).then(() => refreshStatus(), error => {
      indexLog.warn("connect to the agent2telegram gateway failed", { error });
      refreshStatus();
    });
  };


  function buildStatusState(error?: string): Parameters<typeof formatTelegramStatusLine>[1] {
    const enabled = !!config.botToken && isTelegramEnabled();
    return {
      hasBotToken: !!config.botToken,
      pollingActive: enabled && !!forum.getTarget(),
      paired: config.allowedUserId !== undefined,
      connected: enabled && !!forum.getTarget(),
      current: enabled && !!forum.getTarget(),
      processing: activeTurns.size > 0,
      error: error ?? forum.lastError,
      botUsername: config.botUsername,
      unsupported: tuiBridge.getUnsupportedReason(),
    };
  }

  function refreshStatus(error = lastStatusError): void {
    const state = buildStatusState(error);
    const session = getActiveSession();
    try {
      const ctx = session?.extensionRunner?.createCommandContext?.();
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus(TELEGRAM_STATUS_KEY, formatTelegramStatusLine(ctx.ui.theme, state));
      }
    } catch (err) {
      // /new, /fork, /reload and session switches replace the extension
      // runner. A status tick can still hold the previous session for one
      // turn; using its ctx now would throw and (on pi) kill the process.
      indexLog.debug("status refresh skipped: session context replaced", { err });
    }
    heartbeat.refreshStatus(state);
  }

  function clearStatus(): void {
    heartbeat.stopTypingOnly();
    const session = getActiveSession();
    try {
      const ctx = session?.extensionRunner?.createCommandContext?.();
      if (ctx?.ui?.setStatus) clearTelegramStatus(ctx);
    } catch (err) {
      indexLog.debug("status clear skipped: session context replaced", { err });
    }
  }

  // Sub-agent instances re-run this factory, so they start the same timers and
  // controller. Only the parts that touch instance-local state are torn down here;
  // disposeRuntime is not used because it clears the shared status line, cancels
  // process-wide menu refreshes and releases the coordinator lease.
  function disposeInertRuntime(): void {
    void forum.close();
    requestForumSync = () => undefined;
    heartbeat.dispose();
    controller.dispose();
    activeTurns.clear();
    ui.dispose();
  }

  let disposed = false;
  function disposeRuntime(): void {
    if (disposed) return;
    disposed = true;
    try { contextBudget.dispose(); }
    catch { sessionContext?.ui.notify("上下文预算退出回退未确认；请通过 SSH 检查实际窗口与阈值。", "error"); }
    void forum.close();
    requestForumSync = () => undefined;
    cancelTelegramCommandRefreshes();
    heartbeat.dispose();
    controller.dispose();
    activeTurns.clear();
    ui.dispose();
    clearStatus();
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    // Only the main session reaches this handler (sub-agents are filtered by
    // mainOnlyEvents), so it takes over the process runtime from any earlier one.
    if (runtimeState.dispose && runtimeState.dispose !== disposeRuntime) runtimeState.dispose();
    runtimeState.dispose = disposeRuntime;
    // A new session (/new, session switch) must not carry the previous
    // session's remembered secrets into this one.
    secretStore.clearAll();
    try {
      switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd()));
    } catch (error) {
      // A transient read failure (e.g. racing a concurrent instance's
      // config write) must not nuke the runtime config: keep the previous
      // resolved config so the bot keeps polling, and surface the REAL
      // error instead of the misleading "not v2" wording.
      indexLog.error("readBotRegistry failed on session_start; keeping previous config", { err: error });
      if (!resolvedConfig) {
        switchResolvedConfig({ registry: { version: 3, bots: [] }, hasProjectBinding: false, config: {} });
        getActiveSession()?.extensionRunner.getUIContext().notify(
          `Telegram config could not be loaded. Use /tg → Bots → Add bot to create a bot. ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } else {
        getActiveSession()?.extensionRunner.getUIContext().notify(
          `Telegram config could not be refreshed; keeping the previous configuration. ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    const startupConfig = enableConfiguredTelegramOnStartup(config);
    if (startupConfig !== config) {
      config = startupConfig;
      await persistCurrentConfig(config);
    }
    if (config.botToken && !config.botUsername) {
      try {
        const botUsername = await getTelegramBotUsername(config.botToken, config.apiBase);
        if (botUsername) {
          config = { ...config, botUsername };
          await persistCurrentConfig(config);
        }
      } catch (err) { indexLog.debug("resolve botUsername on startup failed (non-critical)", { err }); }
    }
    requestForumSync();
    // Let the TUI bridge capture InteractiveMode before building the dynamic
    // command menu; `ready()` is bounded and never blocks startup indefinitely.
    await tuiBridge.ready();
    try { contextBudget.start(ctx); }
    catch (error) { ctx.ui.notify(`上下文预算未应用：${error instanceof Error ? error.message : "请检查配置及兼容桥接。"}`, "error"); }
    try { await syncTelegramCommands(config.botToken, pi, config.apiBase); } catch (err) { indexLog.debug("syncTelegramCommands on startup failed (non-critical)", { err }); }
    // Bridge may capture host TUI after initial sync; refresh menu with dynamic host commands.
    scheduleTelegramCommandRefresh(config.botToken, pi, config.apiBase, 300);
    scheduleTelegramCommandRefresh(config.botToken, pi, config.apiBase, 1000);
    lastStatusError = tuiBridge.isAvailable() ? undefined : `TUI bridge unavailable: ${tuiBridge.getHost()}`;
    heartbeat.startStatusHeartbeat(refreshStatus);
    refreshStatus();
  });

  pi.on("model_select", (_event, ctx) => {
    try { contextBudget.modelSelected(ctx); }
    catch (error) { ctx.ui.notify(`上下文预算模型切换未确认：${error instanceof Error ? error.message : "请检查并重载。"}`, "error"); }
  });

  pi.on("session_shutdown", () => {
    disposeRuntime();
    if (runtimeState.dispose === disposeRuntime) runtimeState.dispose = undefined;
  });
}