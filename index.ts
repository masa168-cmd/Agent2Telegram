import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActiveTelegramTransport } from "./lib/active-transport.ts";
import { registerTelegramAttachmentTool } from "./lib/attachments.ts";
import { enableConfiguredTelegramOnStartup, readResolvedTelegramConfig, persistProjectRuntimeState, resetProjectBindingCursor, updateBot, getAgentDir } from "./lib/config.ts";
import { createTelegramController, type TelegramCommandHandler } from "./lib/controller.ts";
import { escapeHtml } from "./lib/html.ts";
import { createHeartbeat } from "./lib/heartbeat.ts";
import { replayTelegramHistory, type TelegramHistoryEntry } from "./lib/history-replay.ts";
import { TelegramInstanceCoordinator, failoverHasOtherLiveInstances, telegramTokenHash, type TelegramActiveInstance, type TelegramInstanceMetadata } from "./lib/instance-coordinator.ts";
import { mainOnlyEvents } from "./lib/main-only-pi.ts";
import { registerTelegramRenderer } from "./lib/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/session-capture.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramBotUsername, getTelegramFile } from "./lib/telegram-api.ts";
import { createTelegramUiRuntime } from "./lib/telegram-ui.ts";
import { formatTelegramStatusLine, clearTelegramStatus, TELEGRAM_STATUS_KEY } from "./lib/status.ts";
import { installTelegramStatusAlignment } from "./lib/status-footer.ts";
import { createTelegramPollingRuntime, checkpointCurrentUpdateCursor } from "./lib/polling.ts";
import { ForumSession, forumBotId } from "./lib/forum-session.ts";
import { createForumTelegramTransport } from "./lib/forum-transport.ts";
import { authorizedForumUpdate, deliverForumUpdate, findForumRoute } from "./lib/forum-router.ts";
import { forumTopicLink, sameForumTarget } from "./lib/forum-binding.ts";
import { PollingNoticeGate, classifyPollingError } from "./lib/polling-notice.ts";
import { deliverPendingNotices } from "./lib/pending-notices.ts";
import { initLogger, log, type LogLevel } from "./lib/logger.ts";
import { authorizeTelegramUser, ensureTelegramPairingCode, formatPairingInstructions } from "./lib/pairing.ts";
import { getCurrentTelegramTurn } from "./lib/turn-context.ts";

import { registerAllCommands } from "./lib/commands/register.ts";
import { registerTgMenuCommand } from "./lib/commands/tg-menu.ts";
import { registerContextBudgetCommand } from "./lib/commands/context-budget.ts";
import { ContextBudgetRuntime } from "./lib/context-budget/runtime.ts";
import type { TelegramConnectionState } from "./lib/commands/telegram-commands.ts";
import { syncTelegramCommands, scheduleTelegramCommandRefresh, cancelTelegramCommandRefreshes, getTelegramCommandKeyboard } from "./lib/menu-commands.ts";
import { installTuiBridge, tuiBridge, getTuiCommands } from "./lib/tui-bridge.ts";
import { SecretStore } from "./lib/tui/secrets.ts";
import type { ResolvedTelegramConfig, TelegramConfig, TelegramTurn } from "./lib/types.ts";

const indexLog = log.child("index");

type TelegramPlusRuntimeState = {
  dispose?: () => void;
  instanceId?: string;
  startedAt?: string;
  handledReplayByToken?: Record<string, number>;
  notifiedFailoverByToken?: Record<string, number>;
  seenForumUpdates?: Set<string>;
};

const TELEGRAM_PLUS_RUNTIME_STATE = Symbol.for("pi-telegram-plus-ex.runtime-state");

function getTelegramPlusRuntimeState(): TelegramPlusRuntimeState {
  const g = globalThis as typeof globalThis & Record<symbol, TelegramPlusRuntimeState | undefined>;
  g[TELEGRAM_PLUS_RUNTIME_STATE] ??= {};
  const state = g[TELEGRAM_PLUS_RUNTIME_STATE];
  state.instanceId ??= randomUUID();
  state.startedAt ??= new Date().toISOString();
  state.handledReplayByToken ??= {};
  state.notifiedFailoverByToken ??= {};
  state.seenForumUpdates ??= new Set();
  return state;
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
  // via PI_TELEGRAM_PLUS_LOG_LEVEL (debug/info/warn/error). See lib/logger.ts.
  const envLevel = process.env.PI_TELEGRAM_PLUS_LOG_LEVEL?.toLowerCase();
  const level: LogLevel = (envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error")
    ? envLevel
    : "info";
  initLogger({ dir: join(getAgentDir(), "logs"), level });
  const runtimeState = getTelegramPlusRuntimeState();

  let config: TelegramConfig = {};
  let pairingFailures: { code?: string; count: number } = { count: 0 };
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let coordinator: TelegramInstanceCoordinator | undefined;
  let sessionContext: ExtensionContext | undefined;
  let announcedForumLease: string | undefined;
  let coordinatorTimer: ReturnType<typeof setInterval> | undefined;
  let replayAbortController: AbortController | undefined;
  const pendingHandoffs = new Set<string>();
  let requestCoordinatorReconcile: () => void = () => undefined;
  let replayReady: Promise<void> = Promise.resolve();
  let releaseReplayGate: (() => void) | undefined;
  const activeTurnKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  // Per chat/thread active turns: prevents interleaving in one Telegram target
  // while allowing different topics in the same supergroup to stay isolated.
  const activeTurns = new Map<string, TelegramTurn>();
  let lastStatusError: string | undefined;
  let lastForumCursorNoticeAt = -Infinity;
  // Collapses a retry storm into one outage notice + one recovery notice.
  const pollingNotices = new PollingNoticeGate();

  const setConfig = (nextConfig: TelegramConfig) => {
    const routingChanged = config.botToken !== nextConfig.botToken
      || config.telegramEnabled !== nextConfig.telegramEnabled
      || config.forumChatId !== nextConfig.forumChatId || config.allowedUserId !== nextConfig.allowedUserId
      || config.apiBase !== nextConfig.apiBase;
    config = nextConfig;
    if (resolvedConfig) resolvedConfig.config = nextConfig;
    refreshStatus();
    if (routingChanged) {
      void forum.close();
      replayAbortController?.abort();
      requestCoordinatorReconcile();
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

  /** Uploads live in one cache directory instead of the project: <XDG cache>/pi-telegram/uploads/<launch dir name>/. */
  const incomingUploadDir = (cwd: string): string => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "pi-telegram", "uploads", sanitizeIncomingFileName(basename(resolve(cwd)) || "root"));

  const persistCurrentConfig = async (nextConfig = config): Promise<void> => {
    if (!resolvedConfig) resolvedConfig = await readResolvedTelegramConfig(currentSessionCwd());
    resolvedConfig = await persistProjectRuntimeState(resolvedConfig, nextConfig, currentSessionCwd());
    config = resolvedConfig.config;
  };

  const switchResolvedConfig = (next: ResolvedTelegramConfig) => {
    const routingChanged = config.botToken !== next.config.botToken
      || config.telegramEnabled !== next.config.telegramEnabled
      || config.forumChatId !== next.config.forumChatId || config.allowedUserId !== next.config.allowedUserId
      || config.apiBase !== next.config.apiBase;
    resolvedConfig = next;
    config = next.config;
    refreshStatus();
    if (routingChanged) {
      void forum.close();
      replayAbortController?.abort();
      requestCoordinatorReconcile();
    }
  };

  const isTelegramEnabled = (): boolean => {
    if (config.telegramEnabled !== undefined) return config.telegramEnabled;
    // Default: if a bot resolves, telegram is enabled.
    return !!config.botToken;
  };

  const forum = new ForumSession({
    pi, getConfig: () => config, getCoordinator: () => coordinator,
    seen: runtimeState.seenForumUpdates,
    onChange: () => requestCoordinatorReconcile(),
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
  const getOperationSession = () => disposed || (forum.enabled && !forum.isCurrentOperation())
    ? undefined : getActiveSession();
  const getOutputConfig = (): TelegramConfig => forum.enabled
    ? { ...config, activeChatId: forum.getTarget()?.chatId } : config;
  const rawTransport = createTelegramTransport(() => config);
  const getActiveSendLease = (): string | undefined => {
    const token = config.botToken;
    const active = coordinator?.getActive();
    if (!token
      || !coordinator
      || coordinator.tokenHash !== telegramTokenHash(token)
      || !coordinator.isActive()
      || pendingHandoffs.size > 0
      || !active
      || active.replay) {
      return undefined;
    }
    return `${coordinator.tokenHash}:${active.generation}`;
  };
  const isActiveInstance = () => getActiveSendLease() !== undefined; // Bot receiver only
  const getSendLease = () => disposed ? undefined : forum.enabled ? forum.lease() : getActiveSendLease();
  const canSend = () => getSendLease() !== undefined;
  const activeBaseTransport = createTelegramTransport(() => config, {
    getSendLease,
    shouldSend: (lease) => lease !== undefined && lease === getSendLease(),
  });
  const transport = createActiveTelegramTransport(createForumTelegramTransport(activeBaseTransport, forum), {
    isActive: canSend,
    getLease: getSendLease,
    waitUntilReady: () => replayReady,
  });
  // One store for the whole instance: the Broker and the plugin UI runtime
  // remember what this chat typed, the renderer needs the same view to redact
  // assistant replies.
  const secretStore = new SecretStore();
  const ui = createTelegramUiRuntime({
    getSession: getActiveSession,
    transport,
    secrets: secretStore,
    allowSecretInputs: () => !forum.enabled,
    isCurrent: () => !disposed && (!forum.enabled || forum.isCurrentOperation()),
  });

  const getCurrentActiveTurn = (): TelegramTurn | undefined => getCurrentTelegramTurn();

  const heartbeat = createHeartbeat({
    getConfig: () => config,
    getActiveTurns: () => [...activeTurns.values()],
    sendChatAction: (chatId, action, messageThreadId) => transport.sendChatAction(chatId, action, messageThreadId),
    ensurePollingStarted: () => {
      if (config.botToken && isTelegramEnabled() && isActiveInstance() && !polling.isActive()) polling.start();
    },
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

  // /tg multi-level menu — the single entry point for bot / project /
  // instance management (Bots / Project / Commands / Config / Switch instance).
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
    setConfig,
    persistConfig: persistCurrentConfig,
    getResolvedConfig: () => resolvedConfig,
    switchResolvedConfig,
    isTelegramEnabled,
    transport,
    getPolling: () => polling,
    refreshStatus,
    syncTelegramCommands: () => syncTelegramCommands(config.botToken, pi),
    startStatusHeartbeat: () => heartbeat.startStatusHeartbeat(refreshStatus),
    clearStatusError: () => { lastStatusError = undefined; },
    connectionState,
    awaitReconcile,
  }, tgConfigDeps, {
    getCoordinator: () => coordinator,
    getCurrentChatId: () => config.activeChatId,
    stopPolling: () => polling.stop(),
    startPolling: () => polling.start(),
    requestReconcile: () => requestCoordinatorReconcile(),
    pendingHandoffs,
    getCurrentTurn: () => {
      const turn = getCurrentTelegramTurn();
      return turn ? { chatId: turn.chatId, messageThreadId: turn.messageThreadId, sourceMessageId: turn.sourceMessageId } : undefined;
    },
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
    description: "仅 SSH：查看话题状态；retry 在创建结果未知时确认后重试一次",
    handler: async (args, ctx) => {
      if (args.trim() !== "retry") {
        const target = forum.getTarget();
        ctx.ui.notify(forum.lastError ?? (target
          ? `Forum online: ${forumTopicLink(target.chatId, target.threadId) ?? target.threadId}`
          : "Forum is not ready; configure forumChatId in this Bot's local tg.json record."), "info");
        return;
      }
      if (await ctx.ui.confirm("重新创建话题？", "先检查 Telegram 中是否已创建话题。确认后可能留下之前请求创建的孤立话题；不会删除任何历史。")) {
        ctx.ui.notify(forum.retryTopic() ? "已请求恢复，等待话题创建与占用检查。" : "已有有效话题、尚在创建或配置无效；未重建。", "info");
      }
    },
  });

  registerTelegramAttachmentTool(pi, {
    getActiveTurn: getCurrentActiveTurn,
    getDefaultChatId: () => forum.enabled ? forum.getTarget()?.chatId
      : activeTurns.size === 0 ? getOutputConfig().activeChatId : undefined,
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
    hasActiveTurns: () => !forum.enabled && activeTurns.size > 0,
    getSendLease,
    getSession: getActiveSession,
    secrets: secretStore,
  });

  // Shared by the controller (private-chat mode) and the forum receiver (an
  // unpaired forum Bot accepts /pair only in a private chat).
  const authorizeUser = async (userId: number | undefined, text?: string, chatType?: string): Promise<boolean | "paired"> => {
    // Wrong /pair attempts are counted per code in memory; a new code starts at 0.
    const failures = pairingFailures.code === config.pairingCode ? pairingFailures.count : 0;
    const decision = authorizeTelegramUser(config, userId, text, config.botUsername, { chatType, failures });
    pairingFailures = { code: decision.config.pairingCode, count: decision.failures };
    if (decision.invalidated) {
      config = decision.config;
      if (resolvedConfig?.bot) {
        await updateBot(resolvedConfig.bot.id, { pairingCode: undefined, pairingCodeExpiresAt: undefined })
          .catch(indexLog.swallow("warn", "persist invalidated pairing code failed"));
      }
      getActiveSession()?.extensionRunner.getUIContext().notify(
        "Telegram pairing code was cancelled (expired or too many wrong attempts). Generate a new one via /tg → Bots.", "warning");
      refreshStatus();
      return false;
    }
    if (!decision.authorized) return false;
    if (decision.config !== config) {
      config = decision.config;
      await persistCurrentConfig(config);
      // v3: allowedUserId is bot identity (registry), not a project-binding
      // field. persistCurrentConfig writes only the project binding, so on a
      // successful /pair we must also write allowedUserId to the bot record
      // or the pairing is lost on restart.
      if (decision.paired && resolvedConfig?.bot && decision.config.allowedUserId !== undefined) {
        await updateBot(resolvedConfig.bot.id, { allowedUserId: decision.config.allowedUserId, pairingCode: undefined, pairingCodeExpiresAt: undefined })
          .catch(indexLog.swallow("warn", "persist paired allowedUserId to bot registry failed"));
        switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd()));
      }
      refreshStatus();
    }
    return decision.paired ? "paired" : true;
  };

  const controller = createTelegramController({
    getSession: getOperationSession,
    isCurrent: () => !disposed && (!forum.enabled || forum.isCurrentOperation()),
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
        if (disposed || config.botToken !== token || (forum.enabled && !sameForumTarget(target, forum.getTarget()))) {
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
      if (forum.enabled && (!target || chatId !== target.chatId || messageThreadId !== target.threadId)) return undefined;
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

  const maxConfiguredUpdateId = (token: string): number | undefined => {
    // In v3, the coordinator cursor is authoritative. The project binding's
    // lastUpdateId is only a cold-start seed. We return the current config's
    // lastUpdateId (if the token matches) as the fallback for syncCursor.
    if (config.botToken === token && typeof config.lastUpdateId === "number") {
      return config.lastUpdateId;
    }
    return undefined;
  };

  const refreshSharedCursor = async (candidate = coordinator): Promise<void> => {
    const token = config.botToken;
    if (!candidate || !token || candidate.tokenHash !== telegramTokenHash(token)) return;
    const cursor = await candidate.syncCursor(maxConfiguredUpdateId(token));
    if (cursor !== undefined && cursor !== config.lastUpdateId) {
      config = { ...config, lastUpdateId: cursor };
      if (resolvedConfig) resolvedConfig.config = config;
    }
  };

  const polling = createTelegramPollingRuntime({
    getConfig: () => config,
    setConfig,
    persistConfig: persistCurrentConfig,
    persistUpdate: async (nextConfig, update) => {
      await persistCurrentConfig(nextConfig);
      const currentCoordinator = coordinator;
      if (currentCoordinator && nextConfig.botToken && currentCoordinator.tokenHash === telegramTokenHash(nextConfig.botToken)) {
        await currentCoordinator.persistCursor(update.update_id);
      }
    },
    // Both durable cursors (coordinator + project binding) are monotonic maxes, so
    // a cursor ahead of the bot's stream has to be rewound in both places at once;
    // correcting only one would be re-raised by the other on the next persist.
    resetCursor: async (updateId) => {
      config = { ...config, lastUpdateId: updateId };
      if (resolvedConfig) resolvedConfig.config = config;
      const currentCoordinator = coordinator;
      if (currentCoordinator && config.botToken && currentCoordinator.tokenHash === telegramTokenHash(config.botToken)) {
        await currentCoordinator.resetCursor(updateId);
      }
      if (resolvedConfig?.projectPath) {
        await resetProjectBindingCursor(resolvedConfig.projectPath, updateId);
      }
    },
    reloadConfig: async () => {
      switchResolvedConfig(await readResolvedTelegramConfig(currentSessionCwd()));
      await refreshSharedCursor();
    },
    shouldPoll: isActiveInstance,
    shouldProcess: isActiveInstance,
    handleUpdate: async (update) => {
      refreshStatus();
      if (forum.enabled) {
        // Unpaired forum Bot: the only accepted input is /pair in a private chat.
        if (config.allowedUserId === undefined) {
          const m = update.message;
          if (!m || m.chat?.type !== "private" || typeof m.chat.id !== "number" || !isActiveInstance()) return;
          const result = await authorizeUser(m.from?.id, m.text ?? "", "private");
          if (result === "paired") {
            await rawTransport.sendText(m.chat.id, "✅ Telegram user paired.", undefined, m.message_id, undefined, { maxAttempts: 1 });
          }
          return;
        }
        if (!authorizedForumUpdate(update, config.forumChatId!, config.allowedUserId!)) return;
        const receiver = coordinator;
        const requestConfig = { ...config };
        const leader = receiver?.getActive();
        if (!receiver || !leader || !isActiveInstance()) return;
        const route = findForumRoute(update, await receiver.listInstances(),
          forumBotId(requestConfig.botToken!), requestConfig.forumChatId!, requestConfig.allowedUserId!);
        const stillReceiver = () => receiver === coordinator && isActiveInstance()
          && config.botToken === requestConfig.botToken && config.forumChatId === requestConfig.forumChatId
          && config.allowedUserId === requestConfig.allowedUserId && receiver.getActive()?.generation === leader.generation;
        if (!stillReceiver()) return;
        let notice = "此话题没有在线 Pi 会话，或按钮已过期。不会自动启动历史会话；请进入对应的在线话题。";
        if (route) {
          // Commit BEFORE handing off: a reload/new can replace the polling process.
          if (!await checkpointCurrentUpdateCursor()) {
            if (stillReceiver() && Date.now() - lastForumCursorNoticeAt >= 5000) {
              lastForumCursorNoticeAt = Date.now();
              const text = "更新游标无法保存，本条指令未执行。请先通过 SSH 检查配置目录权限，再明确重新提交；不会自动补执行。";
              if (update.callback_query) await rawTransport.answerCallbackQuery(update.callback_query.id, text);
              else await rawTransport.sendText(requestConfig.forumChatId!, escapeHtml(text),
                update.message?.message_thread_id, update.message?.message_id, undefined, { maxAttempts: 1 });
            }
            throw new Error("Forum update cursor could not be committed; command was NOT forwarded");
          }
          if (!stillReceiver()) return;
          try {
            const result = await deliverForumUpdate(route.instance.forum!, { target: route.target, leader, update: route.update });
            if (result.accepted) { lastStatusError = undefined; refreshStatus(); return; }
            notice = "会话绑定已经变化或话题尚未就绪；本条未执行，请检查在线话题后再操作。";
          } catch {
            notice = "本机转发结果未确认。请先检查该话题内的状态，不要自动重复提交。";
          }
        }
        if (!stillReceiver()) return;
        if (update.callback_query) await rawTransport.answerCallbackQuery(update.callback_query.id, notice.slice(0, 180));
        else await rawTransport.sendText(requestConfig.forumChatId!, escapeHtml(notice), update.message?.message_thread_id,
          update.message?.message_id, undefined, { maxAttempts: 1 });
      } else {
        if (update.callback_query) await controller.handleCallbackQuery(update.callback_query);
        if (update.message) await controller.handleMessage(update.message);
      }
      lastStatusError = undefined;
      refreshStatus();
    },
    onSuccess: () => {
      if (lastStatusError !== undefined) { lastStatusError = undefined; refreshStatus(); }
      if (!pollingNotices.success()) return;
      const turn = getCurrentActiveTurn();
      const chatId = turn?.chatId ?? getOutputConfig().activeChatId;
      if (chatId !== undefined && config.botToken) {
        // One recovery message per announced outage; never retried, so a
        // flapping link cannot duplicate it.
        transport.sendText(chatId, `<b>ok</b>\nTelegram polling restored`, turn?.messageThreadId, undefined, undefined, { maxAttempts: 1 })
          .catch(log.child("polling").swallow("warn", "sendText polling-recovery notice failed", { chatId, messageThreadId: turn?.messageThreadId }));
      } else {
        getActiveSession()?.extensionRunner.getUIContext().notify("Telegram polling restored", "info");
      }
    },
    onError: (error, context) => {
      const message = error instanceof Error ? error.message : String(error);
      lastStatusError = message;
      refreshStatus(message);
      if (message.startsWith("Telegram polling skipped:")) {
        getActiveSession()?.extensionRunner.getUIContext().notify(message, "warning");
        return;
      }
      // One notice per outage (after the debounce), not one per retry. The
      // cause is included because "polling failed" alone is not actionable.
      const { kind, label } = classifyPollingError(error, context === "processing");
      if (!pollingNotices.failure(kind, Date.now())) return;

      const heading = kind === "processing"
        ? "Telegram update processing failed"
        : `Telegram polling failed (${label})`;
      const detail = message.length > 300 ? `${message.slice(0, 299)}…` : message;
      const turn = getCurrentActiveTurn();
      const chatId = turn?.chatId ?? getOutputConfig().activeChatId;
      if (chatId !== undefined && config.botToken) {
        transport.sendText(
          chatId,
          `<b>error</b>\n${escapeHtml(heading)}\n${escapeHtml(detail)}`,
          turn?.messageThreadId,
          turn?.sourceMessageId,
          undefined,
          { maxAttempts: 1 },
        ).catch(log.child("polling").swallow("warn", "sendText polling-failure notice failed", { chatId, messageThreadId: turn?.messageThreadId }));
      } else {
        getActiveSession()?.extensionRunner.getUIContext().notify(`${heading}: ${detail}`, "error");
      }
    },
  });

  let replayInFlight: { tokenHash: string; generation: number } | undefined;
  let reconcileTail: Promise<void> = Promise.resolve();

  const openReplayGate = (): (() => void) => {
    releaseReplayGate?.();
    let resolveGate: () => void = () => undefined;
    let released = false;
    replayReady = new Promise<void>((resolveGatePromise) => {
      resolveGate = resolveGatePromise;
    });
    const close = () => {
      if (released) return;
      released = true;
      resolveGate();
      if (releaseReplayGate === close) releaseReplayGate = undefined;
    };
    releaseReplayGate = close;
    return close;
  };

  const buildInstanceHeartbeat = (): Omit<TelegramInstanceMetadata, "id" | "pid" | "startedAt" | "heartbeatAt"> => {
    const session = getActiveSession();
    const model = session?.model;
    return {
      cwd: currentSessionCwd(),
      sessionId: session?.sessionId,
      sessionName: session?.sessionName,
      model: model ? `${model.provider}/${model.id}` : undefined,
      busy: session ? !session.isIdle : false,
      ...(forum.registration() ? { forum: forum.registration() } : {}),
    };
  };

  const startHistoryReplay = (
    active: TelegramActiveInstance,
    replayCoordinator: TelegramInstanceCoordinator,
    metadata: ReturnType<typeof buildInstanceHeartbeat>,
  ): void => {
    if (!active.replay || replayInFlight) return;
    const handledByToken = runtimeState.handledReplayByToken!;
    if ((handledByToken[replayCoordinator.tokenHash] ?? 0) >= active.generation) return;
    replayInFlight = { tokenHash: replayCoordinator.tokenHash, generation: active.generation };
    const closeReplayGate = openReplayGate();
    const replayController = new AbortController();
    replayAbortController = replayController;
    const replayConfig = { ...config };
    const session = getActiveSession();
    const entries = (session?.sessionManager.getBranch() ?? []) as TelegramHistoryEntry[];
    const replayTarget = active.replay;
    const canContinue = () => coordinator === replayCoordinator
      && config.botToken === replayConfig.botToken
      && !!config.botToken
      && replayCoordinator.tokenHash === telegramTokenHash(config.botToken)
      && isTelegramEnabled()
      && replayCoordinator.isActive()
      && replayCoordinator.getActive()?.generation === active.generation;
    const replayLease = `${replayCoordinator.tokenHash}:${active.generation}`;
    const replayTransport = createTelegramTransport(() => replayConfig, {
      getAbortSignal: () => replayController.signal,
      getSendLease: () => replayLease,
      shouldSend: (lease) => lease === replayLease && canContinue(),
    });

    void (async () => {
      let shouldCompleteReplay = false;
      try {
        const result = await replayTelegramHistory({
          entries,
          config: replayConfig,
          transport: replayTransport,
          target: replayTarget,
          instance: {
            cwd: metadata.cwd,
            sessionId: metadata.sessionId,
            sessionName: metadata.sessionName,
            model: metadata.model,
            instanceId: replayCoordinator.instanceId,
          },
          canContinue,
        });
        if (!result.aborted) {
          handledByToken[replayCoordinator.tokenHash] = active.generation;
          shouldCompleteReplay = true;
        }
      } catch (error) {
        if ((error instanceof Error && error.name === "TelegramSendSuppressedError") || !canContinue()) {
          indexLog.debug("Telegram history replay interrupted by instance switch or reload", { generation: active.generation });
        } else {
          handledByToken[replayCoordinator.tokenHash] = active.generation;
          shouldCompleteReplay = true;
          indexLog.warn("Telegram history replay failed", { generation: active.generation, error });
          await replayTransport.sendText(
            replayTarget.chatId,
            `⚠️ <b>History replay failed.</b>\n${escapeHtml(error instanceof Error ? error.message : String(error))}`,
            replayTarget.messageThreadId,
          ).catch(indexLog.swallow("warn", "send history replay failure notice failed", { chatId: replayTarget.chatId }));
        }
      } finally {
        if (shouldCompleteReplay) {
          await replayCoordinator.completeReplay(active.generation).catch(indexLog.swallow("warn", "complete history replay state failed", { generation: active.generation }));
        }
        if (replayInFlight?.tokenHash === replayCoordinator.tokenHash
          && replayInFlight.generation === active.generation) {
          replayInFlight = undefined;
        }
        if (replayAbortController === replayController) replayAbortController = undefined;
        closeReplayGate();
        if (shouldCompleteReplay && coordinator === replayCoordinator && replayCoordinator.isActive() && isTelegramEnabled()) {
          polling.start();
        } else if (!shouldCompleteReplay && coordinator === replayCoordinator) {
          requestCoordinatorReconcile();
        }
      }
    })();
  };

  const reconcileCoordinator = async (): Promise<void> => {
    if (disposed) return;
    if (sessionContext) await forum.prepare(sessionContext);
    if (disposed) return;
    const token = config.botToken;
    if (!token || !isTelegramEnabled()) {
      replayAbortController?.abort();
      // Hand the active-instance role over right away so another pi instance
      // serving the same Bot takes over on its next reconcile instead of
      // waiting for our heartbeat to expire. Best-effort: never fail here.
      await coordinator?.releaseActive().catch((error) => {
        indexLog.warn("release Telegram active instance on disconnect failed", { error });
      });
      coordinator = undefined;
      await polling.stop();
      refreshStatus();
      return;
    }

    const tokenHash = telegramTokenHash(token);
    if (!coordinator || coordinator.tokenHash !== tokenHash) {
      replayAbortController?.abort();
      coordinator = new TelegramInstanceCoordinator({
        token,
        instanceId: runtimeState.instanceId!,
        startedAt: runtimeState.startedAt!,
      });
    }
    const currentCoordinator = coordinator;
    await refreshSharedCursor(currentCoordinator);
    const metadata = buildInstanceHeartbeat();
    const snapshot = await currentCoordinator.reconcile(metadata);
    if (disposed || coordinator !== currentCoordinator || config.botToken !== token || !isTelegramEnabled()) return;
    await forum.reconciled(metadata.forum, snapshot.forumConflict);
    if (disposed) return;
    const forumLease = forum.lease();
    if (forumLease && announcedForumLease !== forumLease) {
      announcedForumLease = forumLease;
      const target = forum.getTarget()!;
      const apiBase = config.apiBase;
      // The keyboard lists the synced menu, so wait for the host catalog and the menu sync
      // (shared with the startup sync when one is in flight) before posting the notice.
      void (async () => {
        await tuiBridge.ready();
        await syncTelegramCommands(token, pi, apiBase);
        if (disposed || config.botToken !== token || forum.lease() !== forumLease) return;
        const keyboard = getTelegramCommandKeyboard(token, apiBase);
        await transport.sendText(target.chatId,
          `<b>— 会话 ${escapeHtml(target.sessionId.slice(0, 8))} 已接入 —</b>\n本话题对应此目录；/new、恢复会话后仍在本话题，以上为之前会话的内容。`, target.threadId,
          undefined, undefined, keyboard.length > 0 ? { replyKeyboard: keyboard } : undefined);
      })().catch(indexLog.swallow("warn", "send forum online notice failed"));
    }
    if (pendingHandoffs.size > 0) {
      await polling.stop();
      refreshStatus();
      return;
    }

    if (!currentCoordinator.isActive()) {
      replayAbortController?.abort();
      await polling.stop();
      refreshStatus();
      return;
    }

    if (!forum.enabled && snapshot.active.reason === "failover") {
      const notifiedByToken = runtimeState.notifiedFailoverByToken!;
      // Only announce a failover when another live instance is registered besides
      // self — a genuine multi-instance handoff. A single-instance restart (self
      // alone) must not spam a "failover" notice on every pi start.
      if (failoverHasOtherLiveInstances(snapshot, currentCoordinator.instanceId)
        && (notifiedByToken[tokenHash] ?? 0) < snapshot.active.generation
        && config.activeChatId !== undefined) {
        const chatId = config.activeChatId;
        const previousGeneration = notifiedByToken[tokenHash] ?? 0;
        notifiedByToken[tokenHash] = snapshot.active.generation;
        void transport.sendText(
          chatId,
          `⚠️ <b>Telegram instance failover</b>\nThe previous active pi instance went offline. This instance is now active.`,
        ).then((sent) => {
          if (sent.length === 0 && notifiedByToken[tokenHash] === snapshot.active.generation) {
            notifiedByToken[tokenHash] = previousGeneration;
          }
        }).catch((error) => {
          if (notifiedByToken[tokenHash] === snapshot.active.generation) {
            notifiedByToken[tokenHash] = previousGeneration;
          }
          indexLog.warn("send instance failover notice failed", { chatId, error });
        });
      }
    }

    if (forum.enabled && snapshot.active.replay) await currentCoordinator.completeReplay(snapshot.active.generation);
    if (!forum.enabled && snapshot.active.replay) {
      const handled = runtimeState.handledReplayByToken![tokenHash] ?? 0;
      if (handled < snapshot.active.generation) {
        startHistoryReplay(snapshot.active, currentCoordinator, metadata);
        refreshStatus();
        return;
      }
      if (replayInFlight?.tokenHash === tokenHash && replayInFlight.generation === snapshot.active.generation) {
        refreshStatus();
        return;
      }
      await currentCoordinator.completeReplay(snapshot.active.generation);
    }

    if (!polling.isActive()) polling.start();
    // Deliver notices a superseded runtime queued (/new and /reload results): its
    // own transport drops them once the lease changes, so this active runtime
    // sends them with its own transport. The take inside drains the queue, so a
    // later reconcile never repeats a delivery.
    deliverPendingNotices(transport);
    refreshStatus();
  };

  requestCoordinatorReconcile = () => {
    reconcileTail = reconcileTail
      .then(reconcileCoordinator)
      .catch((error) => {
        lastStatusError = error instanceof Error ? error.message : String(error);
        indexLog.warn("Telegram instance reconciliation failed", { error });
        refreshStatus(lastStatusError);
      });
  };

  /** The runtime's real Telegram connection state - same signal the status
   *  bar uses; the /tg Project menu renders this instead of config fields. */
  function connectionState(): TelegramConnectionState {
    if (!config.botToken || !isTelegramEnabled()) return "disconnected";
    if (forum.enabled) return forum.getTarget() ? "connected" : "connecting";
    if (coordinator?.isActive() && polling.isActive()) return "connected";
    const active = coordinator?.getActive();
    if (active && active.instanceId !== coordinator?.instanceId) return "other-instance";
    return "connecting";
  }

  /** Queue a reconcile and wait for it to settle: after an enable/disable the
   *  Project menu re-renders immediately and must see the post-toggle state. */
  function awaitReconcile(): Promise<void> {
    requestCoordinatorReconcile();
    return reconcileTail;
  }

  coordinatorTimer = setInterval(requestCoordinatorReconcile, 2_000);

  function buildStatusState(error?: string): Parameters<typeof formatTelegramStatusLine>[1] {
    const enabled = !!config.botToken && isTelegramEnabled();
    return {
      hasBotToken: !!config.botToken,
      pollingActive: polling.isActive(),
      paired: config.allowedUserId !== undefined,
      connected: enabled && coordinator?.getActive() !== undefined,
      current: enabled && (forum.enabled ? !!forum.getTarget() : coordinator?.isActive() ?? false),
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
    if (coordinatorTimer) clearInterval(coordinatorTimer);
    coordinatorTimer = undefined;
    requestCoordinatorReconcile = () => undefined;
    pendingHandoffs.clear();
    replayAbortController?.abort();
    void polling.stop();
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
    const currentCoordinator = coordinator;
    if (coordinatorTimer) clearInterval(coordinatorTimer);
    coordinatorTimer = undefined;
    requestCoordinatorReconcile = () => undefined;
    pendingHandoffs.clear();
    // If we are the active instance and no other live instance remains, clear the
    // active record so the next start is "initial" instead of a spurious
    // "failover" notice. Synchronous and best-effort: session_shutdown may be
    // followed immediately by process exit, so async cleanup is not reliable.
    currentCoordinator?.clearActiveIfAloneSync();
    coordinator = undefined;
    replayAbortController?.abort();
    replayAbortController = undefined;
    releaseReplayGate?.();
    cancelTelegramCommandRefreshes();
    void polling.stop();
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
    if (config.botToken) {
      const pairedConfig = ensureTelegramPairingCode(config);
      if (pairedConfig !== config) {
        // The code lives on the bot record; persistCurrentConfig only writes the
        // project binding and re-reads the registry, so store a fresh code there first.
        if (resolvedConfig?.bot && pairedConfig.pairingCode !== config.pairingCode) {
          await updateBot(resolvedConfig.bot.id, {
            pairingCode: pairedConfig.pairingCode, pairingCodeExpiresAt: pairedConfig.pairingCodeExpiresAt,
          }).catch(indexLog.swallow("warn", "persist fresh pairing code failed"));
        }
        config = pairedConfig;
        await persistCurrentConfig(config);
      }
      if (config.allowedUserId === undefined) {
        getActiveSession()?.extensionRunner.getUIContext().notify(formatPairingInstructions(config), "warning");
      }
    }
    requestCoordinatorReconcile();
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