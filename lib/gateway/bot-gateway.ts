import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { forumBotId, forumTopicKey, forumTopicName } from "../core/forum-binding.ts";
import { escapeHtml } from "../core/html.ts";
import { markdownToTelegramHtml } from "../core/markdown.ts";
import { authorizeTelegramUser, formatPairingInstructions } from "../core/pairing.ts";
import type { TelegramConfig, TelegramTransport, TelegramUpdate } from "../core/types.ts";
import { runtimeDir } from "./paths.ts";
import type { RestartJob } from "./restart-helper.ts";

/** What a session receives from the gateway when it polls. */
export type GatewayEvent =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "command"; name: "compact" | "clear" }
  | { type: "usage" }
  | { type: "restart" }
  | { type: "log"; text: string }
  /** Rich clients (Pi) get the raw update of their topic and handle it themselves. */
  | { type: "update"; update: TelegramUpdate };

/** What a waiter on an approval or a question gets back. */
export type PendingResult = { answer: string } | { cancelled: true } | { pending: true };

export type OpenRequest = {
  /** The mod's own id for this connection (new on every module load). */
  connId: string;
  cwd: string;
  /** Claude Code's session id: the one /restart resumes. */
  claudeSessionId?: string;
  /** Claude Code's process, and its tmux pane when it runs in one. */
  pid?: number;
  pane?: string;
  modDir?: string;
  /** A topic the session already knew (Pi's per-session record): adopted when the directory has none. */
  legacyThreadId?: number;
};

/** `quiet`: the directory is simply not enabled; the session stays idle without a notice. */
export type OpenResult = { ok: true; threadId?: number; notices: string[] } | { ok: false; reason: string; quiet?: true };

/** Commands shown in the group's "/" menu. */
export const MENU_COMMANDS = [
  { command: "stop", description: "中断当前回合" },
  { command: "compact", description: "压缩上下文" },
  { command: "clear", description: "清空对话" },
  { command: "usage", description: "查看用量" },
  { command: "restart", description: "重启 Claude Code（仅 tmux）" },
] as const;

export type GatewayDeps = {
  dataDir: string;
  /**
   * `thin`: the gateway reads the topic for the client (Claude Code: prompts,
   * commands, buttons). `rich`: it hands the client the raw updates of its topic
   * and the client answers Telegram itself (Pi).
   */
  mode?: "thin" | "rich";
  /** Shown in notices: "Claude Code", "Pi". */
  agentLabel?: string;
  /** Where the directory → topic map lives (default `<dataDir>/runtime/topics.json`). */
  topicsPath?: string;
  getConfig: () => TelegramConfig;
  api: <T>(method: string, body: Record<string, unknown>) => Promise<T>;
  transport: Pick<TelegramTransport, "sendText" | "sendChatAction" | "sendButtons" | "editText" | "answerCallbackQuery">;
  /** Persist pairing results (allowedUserId, cleared code) to the bot record. */
  savePairing: (config: TelegramConfig) => Promise<void>;
  /** Start the detached helper that types the resume command into the pane. */
  startRestart?: (job: Omit<RestartJob, "logPath">) => void;
  /** The old process's argv, so its flags survive a restart. */
  readArgv?: (pid: number) => string[] | undefined;
  isPidAlive?: (pid: number) => boolean;
  /** Only enabled directories get a topic (`a2t enable claude`); all when left out. */
  isEnabled?: (cwd: string) => boolean;
  now?: () => number;
  typingIntervalMs?: number;
};

/** Pi's older store may hold `threadId: null` for a create whose result was unknown: read as absent. */
type TopicStore = { version: 1; topics: Record<string, { threadId: number | null; cwd: string; updatedAt: string; state?: string }> };

type Session = OpenRequest & {
  cwd: string;
  threadId?: number;
  queue: GatewayEvent[];
  waiter?: (events: GatewayEvent[]) => void;
  lastSeenAt: number;
  typing?: ReturnType<typeof setInterval>;
  /** Rich clients report the button messages they sent, for callbacks that come without a thread. */
  messageIds: Set<number>;
};

type Pending = {
  connId: string;
  messageId: number;
  title: string;
  /** Button labels; the callback carries the index. */
  labels: string[];
  /** The label that asks for a typed answer instead of a tap. */
  textLabel?: string;
  /** Tapped `textLabel`: the next text in the topic is the answer. */
  awaitingText?: boolean;
  answer?: string;
  done?: boolean;
  waiters: Array<(result: PendingResult) => void>;
};

const TYPING_INTERVAL_MS = 4_500;
/** A session that has not polled for this long is gone (it polls every ≤ 20 s). */
export const SESSION_STALE_MS = 60_000;
const UNSUPPORTED_COMMAND_TEXT = "暂不支持这个命令。可用：/stop /compact /clear /usage /restart";
const RESTART_NEEDS_TMUX_TEXT = "只有在 tmux 里运行 ctg 时才能用 /restart。Claude Code 没有退出。";
const PRIVATE_AFTER_PAIRING_TEXT = "已配对。请在论坛群里对应目录的话题中和我对话。";

/** Same key as the Pi adapter: `telegram:<bot id>`, else a token hash. */
export const botKey = forumBotId;

function isThreadGone(error: unknown): boolean {
  return /thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(error instanceof Error ? error.message : String(error));
}

function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The only Telegram poller for one Bot. Each agent session connects, gets the
 * forum topic of its launch directory, and polls for what Telegram sent there.
 */
export class BotGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  /** Claude sessions that asked for /restart: say "restarted" when they open again. */
  private readonly restarting = new Set<string>();
  private pairingFailures = 0;

  constructor(private readonly deps: GatewayDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private get rich(): boolean { return this.deps.mode === "rich"; }
  private get label(): string { return this.deps.agentLabel ?? "Claude Code"; }
  private alive(pid: number): boolean { return (this.deps.isPidAlive ?? defaultPidAlive)(pid); }

  // ── Topics: one per launch directory, kept across restarts ──────────────

  private get topicsPath(): string { return this.deps.topicsPath ?? join(runtimeDir(this.deps.dataDir), "topics.json"); }

  private async readTopics(): Promise<TopicStore> {
    try {
      const parsed = JSON.parse(await readFile(this.topicsPath, "utf8")) as TopicStore;
      if (parsed?.version === 1 && parsed.topics && typeof parsed.topics === "object") return parsed;
    } catch { /* missing or corrupt: start empty */ }
    return { version: 1, topics: {} };
  }

  private async writeTopics(store: TopicStore): Promise<void> {
    await mkdir(join(this.topicsPath, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.topicsPath}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.topicsPath);
  }

  private topicKey(cwd: string): string | undefined {
    const config = this.deps.getConfig();
    if (!config.botToken || config.forumChatId === undefined) return undefined;
    return forumTopicKey(botKey(config.botToken), config.forumChatId, cwd);
  }

  /** Find or create the directory's topic. Needs a forum group and a paired user. */
  private async ensureTopic(session: Session): Promise<number | undefined> {
    const config = this.deps.getConfig();
    const key = this.topicKey(session.cwd);
    if (!key || config.allowedUserId === undefined) return undefined;
    const store = await this.readTopics();
    const known = store.topics[key];
    const legacy = session.legacyThreadId !== undefined && Number.isSafeInteger(session.legacyThreadId)
      && session.legacyThreadId > 0 ? session.legacyThreadId : undefined;
    const candidate = known && typeof known.threadId === "number" ? known.threadId : legacy;
    if (candidate !== undefined && await this.topicExists(config.forumChatId!, candidate)) {
      if (known?.threadId !== candidate) {
        store.topics[key] = { threadId: candidate, cwd: session.cwd, updatedAt: new Date(this.now()).toISOString() };
        await this.writeTopics(store);
      }
      return (session.threadId = candidate);
    }
    const name = forumTopicName(session.cwd);
    const created = await this.deps.api<{ message_thread_id: number }>("createForumTopic", { chat_id: config.forumChatId, name });
    store.topics[key] = { threadId: created.message_thread_id, cwd: session.cwd, updatedAt: new Date(this.now()).toISOString() };
    await this.writeTopics(store);
    this.push(session, { type: "log", text: `Telegram 话题已创建：${name}` });
    return (session.threadId = created.message_thread_id);
  }

  /**
   * Reopen the topic (a closed one opens again; an open one answers TOPIC_NOT_MODIFIED).
   * False only when Telegram says it was deleted; other errors keep the topic.
   */
  private async topicExists(chatId: number, threadId: number): Promise<boolean> {
    try {
      await this.deps.api("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/TOPIC_ID_INVALID|MESSAGE_THREAD_INVALID|thread not found|TOPIC_DELETED/i.test(text)) return false;
    }
    return true;
  }

  private async forgetTopic(session: Session): Promise<void> {
    const key = this.topicKey(session.cwd);
    session.threadId = undefined;
    if (!key) return;
    const store = await this.readTopics();
    delete store.topics[key];
    await this.writeTopics(store);
  }

  private async topicCwd(threadId: number): Promise<string | undefined> {
    const store = await this.readTopics();
    return Object.values(store.topics).find(t => t.threadId === threadId)?.cwd;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  async open(request: OpenRequest): Promise<OpenResult> {
    const cwd = resolve(request.cwd);
    if (this.deps.isEnabled && !this.deps.isEnabled(cwd)) {
      return { ok: false, quiet: true, reason: `此目录未开启 Telegram（在该目录运行 a2t enable claude）。` };
    }
    for (const other of [...this.sessions.values()]) {
      if (other.connId === request.connId || other.cwd !== cwd) continue;
      const sameClaude = !!request.claudeSessionId && other.claudeSessionId === request.claudeSessionId;
      const otherGone = other.pid !== undefined && !this.alive(other.pid);
      if (sameClaude || otherGone) { this.drop(other); continue; }
      return { ok: false, reason: `此目录已有另一个 ${this.label} 会话接入 Telegram；同一目录只接一个会话。` };
    }
    const previous = this.sessions.get(request.connId);
    const session: Session = { ...request, cwd, queue: previous?.queue ?? [], lastSeenAt: this.now(),
      messageIds: previous?.messageIds ?? new Set() };
    if (previous) this.drop(previous, false);
    this.sessions.set(request.connId, session);

    const notices: string[] = [];
    const config = this.deps.getConfig();
    if (config.allowedUserId === undefined) notices.push(formatPairingInstructions(config, this.now()));
    try {
      await this.ensureTopic(session);
    } catch (error) {
      notices.push(`Telegram 话题创建失败：${String(error)}`);
    }
    if (request.claudeSessionId && this.restarting.delete(request.claudeSessionId)) {
      await this.noticeTo(session, "Claude Code 已重启，对话已接上。").catch(() => undefined);
    }
    return { ok: true, ...(session.threadId === undefined ? {} : { threadId: session.threadId }), notices };
  }

  /**
   * Long-poll: queued events at once, else wait up to `timeoutMs`. A rich client
   * also reports the ids of button messages it sent since its last poll.
   */
  poll(connId: string, timeoutMs: number, messageIds: readonly number[] = []): Promise<{ events: GatewayEvent[] } | { unknown: true }> {
    const session = this.sessions.get(connId);
    if (!session) return Promise.resolve({ unknown: true });
    session.lastSeenAt = this.now();
    for (const id of messageIds) if (Number.isSafeInteger(id) && id > 0) session.messageIds.add(id);
    while (session.messageIds.size > 256) session.messageIds.delete(session.messageIds.values().next().value!);
    session.waiter?.([]);
    if (session.queue.length > 0) return Promise.resolve({ events: session.queue.splice(0) });
    return new Promise(done => {
      const timer = setTimeout(() => finish([]), timeoutMs);
      const finish = (events: GatewayEvent[]) => {
        clearTimeout(timer);
        if (session.waiter === finish) session.waiter = undefined;
        session.lastSeenAt = this.now();
        done({ events });
      };
      session.waiter = finish;
    });
  }

  close(connId: string): void {
    const session = this.sessions.get(connId);
    if (session) this.drop(session);
  }

  /** Drop sessions whose Claude Code is gone, or that stopped polling (killed without a goodbye). */
  reap(): void {
    for (const session of [...this.sessions.values()]) {
      const gone = session.pid !== undefined && !this.alive(session.pid);
      if (gone || (!session.waiter && this.now() - session.lastSeenAt > SESSION_STALE_MS)) this.drop(session);
    }
  }

  get sessionCount(): number { return this.sessions.size; }

  /** Online sessions with their topics (Pi's "online sessions" menu). */
  listSessions(): Array<{ cwd: string; threadId?: number; sessionId?: string; pid?: number }> {
    return [...this.sessions.values()].map(s => ({ cwd: s.cwd,
      ...(s.threadId === undefined ? {} : { threadId: s.threadId }),
      ...(s.claudeSessionId === undefined ? {} : { sessionId: s.claudeSessionId }),
      ...(s.pid === undefined ? {} : { pid: s.pid }) }));
  }

  /** A notice for every connected session's own transcript (e.g. a polling conflict). */
  broadcastLog(text: string): void {
    for (const session of this.sessions.values()) this.push(session, { type: "log", text });
  }

  private drop(session: Session, removeFromMap = true): void {
    this.stopTyping(session);
    session.waiter?.([]);
    if (!removeFromMap) return;
    if (this.sessions.get(session.connId) === session) this.sessions.delete(session.connId);
    for (const [id, entry] of this.pending) {
      if (entry.connId === session.connId) void this.resolveElsewhere(id).catch(() => undefined);
    }
  }

  private push(session: Session, event: GatewayEvent): void {
    session.queue.push(event);
    if (session.waiter) session.waiter(session.queue.splice(0));
  }

  private sessionForThread(threadId: number | undefined): Session | undefined {
    if (threadId === undefined) return undefined;
    return [...this.sessions.values()].find(s => s.threadId === threadId);
  }

  // ── Telegram → sessions ─────────────────────────────────────────────────

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (this.rich && await this.handleRichUpdate(update)) return;
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.chat?.id) return;
    const config = this.deps.getConfig();
    const userId = message.from?.id;
    const chatId = message.chat.id;

    if (message.chat.type === "private") {
      if (config.allowedUserId !== undefined) {
        if (userId === config.allowedUserId) await this.deps.transport.sendText(chatId, PRIVATE_AFTER_PAIRING_TEXT);
        return;
      }
      const decision = authorizeTelegramUser(config, userId, message.text, config.botUsername, {
        chatType: "private", now: this.now(), failures: this.pairingFailures,
      });
      this.pairingFailures = decision.failures;
      if (decision.paired || decision.invalidated) await this.deps.savePairing(decision.config);
      if (decision.paired) {
        await this.deps.transport.sendText(chatId, PRIVATE_AFTER_PAIRING_TEXT);
        for (const session of this.sessions.values()) await this.ensureTopic(session).catch(() => undefined);
      }
      return;
    }

    if (chatId !== config.forumChatId || userId === undefined || userId !== config.allowedUserId) return;
    const threadId = message.message_thread_id;
    const text = message.text?.trim();
    if (threadId === undefined || !text) return;
    const session = this.sessionForThread(threadId);
    if (!session) {
      const cwd = await this.topicCwd(threadId);
      if (cwd) await this.deps.transport.sendText(chatId, escapeHtml(`目录 ${cwd} 现在没有在线的 ${this.label} 会话，本条未处理。`), threadId);
      return;
    }
    for (const [id, entry] of this.pending) {
      if (entry.connId === session.connId && entry.awaitingText && !entry.done && !text.startsWith("/")) {
        await this.settle(id, entry, text);
        return;
      }
    }
    const command = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/)?.[1];
    if (command === "stop") this.push(session, { type: "abort" });
    else if (command === "compact" || command === "clear") this.push(session, { type: "command", name: command });
    else if (command === "usage") this.push(session, { type: "usage" });
    else if (command === "restart") {
      if (session.pane && session.pid !== undefined) this.push(session, { type: "restart" });
      else await this.deps.transport.sendText(chatId, RESTART_NEEDS_TMUX_TEXT, threadId);
    } else if (command !== undefined) await this.deps.transport.sendText(chatId, UNSUPPORTED_COMMAND_TEXT, threadId);
    else this.push(session, { type: "prompt", text });
  }

  /**
   * Rich mode: hand an authorized update from a session's topic to that session
   * untouched. Returns false for what the shared path still handles (private
   * chats, so pairing works the same for every agent).
   */
  private async handleRichUpdate(update: TelegramUpdate): Promise<boolean> {
    const query = update.callback_query;
    const message = query?.message ?? update.message;
    if (!message?.chat || message.chat.type === "private") return false;
    const config = this.deps.getConfig();
    const from = query?.from ?? update.message?.from;
    if (message.chat.id !== config.forumChatId || from?.id === undefined || from.id !== config.allowedUserId) return true;
    const threadId = message.message_thread_id;
    const session = threadId !== undefined ? this.sessionForThread(threadId)
      : query ? [...this.sessions.values()].find(s => s.messageIds.has(message.message_id)) : undefined;
    if (!session) {
      const cwd = threadId === undefined ? undefined : await this.topicCwd(threadId);
      const text = `目录 ${cwd} 现在没有在线的 ${this.label} 会话，本条未处理。`;
      if (query) await this.deps.transport.answerCallbackQuery(query.id, cwd ? text.slice(0, 180) : "已过期");
      else if (cwd) await this.deps.transport.sendText(config.forumChatId!, escapeHtml(text), threadId);
      return true;
    }
    // Telegram can omit the thread on callbacks: restore it from the session's own message.
    const routed = query && threadId === undefined
      ? { ...update, callback_query: { ...query, message: { ...message, message_thread_id: session.threadId } } }
      : update;
    this.push(session, { type: "update", update: routed });
    return true;
  }

  /** Register the "/" menu for the forum group only. */
  async registerCommands(): Promise<void> {
    const config = this.deps.getConfig();
    if (config.forumChatId === undefined) return;
    await this.deps.api("setMyCommands", { commands: MENU_COMMANDS, scope: { type: "chat", chat_id: config.forumChatId } });
  }

  // ── Sessions → Telegram ─────────────────────────────────────────────────

  private async noticeTo(session: Session, text: string): Promise<void> {
    const config = this.deps.getConfig();
    if (session.threadId === undefined || config.forumChatId === undefined) return;
    await this.deps.transport.sendText(config.forumChatId, escapeHtml(text), session.threadId);
  }

  /** Plain text to the session's topic (command results, usage). */
  async notice(connId: string, text: string): Promise<void> {
    const session = this.sessions.get(connId);
    if (session) await this.noticeTo(session, text);
  }

  turnStarted(connId: string): void {
    const session = this.sessions.get(connId);
    const config = this.deps.getConfig();
    if (!session || session.threadId === undefined || config.forumChatId === undefined || session.typing) return;
    const chatId = config.forumChatId;
    const send = () => { void this.deps.transport.sendChatAction(chatId, "typing", session.threadId); };
    send();
    session.typing = setInterval(send, this.deps.typingIntervalMs ?? TYPING_INTERVAL_MS);
    session.typing.unref?.();
  }

  private stopTyping(session: Session): void {
    if (session.typing) clearInterval(session.typing);
    session.typing = undefined;
  }

  async turnCompleted(connId: string, answer: string, isAborted: boolean): Promise<void> {
    const session = this.sessions.get(connId);
    if (!session) return;
    this.stopTyping(session);
    const config = this.deps.getConfig();
    if (session.threadId === undefined || config.forumChatId === undefined) return;
    const text = answer.trim() || (isAborted ? "（已中断）" : "（本回合没有文字回复）");
    const html = markdownToTelegramHtml(text);
    try {
      await this.deps.transport.sendText(config.forumChatId, html, session.threadId);
    } catch (error) {
      if (!isThreadGone(error)) throw error;
      // The topic was deleted in Telegram: make a new one and send there once.
      await this.forgetTopic(session);
      const threadId = await this.ensureTopic(session);
      if (threadId !== undefined) await this.deps.transport.sendText(config.forumChatId, html, threadId);
    }
  }

  /**
   * Show a question with one button per label in the session's topic. Returns
   * false when there is no topic to show it in (the terminal then answers alone).
   */
  async openPrompt(connId: string, id: string, title: string, body: string, labels: string[], textLabel?: string): Promise<boolean> {
    const session = this.sessions.get(connId);
    const config = this.deps.getConfig();
    if (!session || session.threadId === undefined || config.forumChatId === undefined || !id || this.pending.has(id)
      || labels.length === 0) return false;
    const rows = labels.map((text, index) => [{ text, value: `p:${id}:${index}` }]);
    const text = body ? `<b>${escapeHtml(title)}</b>\n<pre>${escapeHtml(body.slice(0, 1500))}</pre>` : `<b>${escapeHtml(title)}</b>`;
    const sent = await this.deps.transport.sendButtons(config.forumChatId, text, rows, session.threadId);
    this.pending.set(id, { connId, messageId: sent.message_id, title, labels, waiters: [],
      ...(textLabel && labels.includes(textLabel) ? { textLabel } : {}) });
    return true;
  }

  /** Long-poll for the Telegram answer; `{ pending }` after `timeoutMs`. */
  wait(id: string, timeoutMs: number): Promise<PendingResult> {
    const entry = this.pending.get(id);
    if (!entry) return Promise.resolve({ cancelled: true });
    if (entry.answer !== undefined) {
      this.pending.delete(id);
      return Promise.resolve({ answer: entry.answer });
    }
    return new Promise(done => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter(w => w !== deliver);
        done({ pending: true });
      }, timeoutMs);
      const deliver = (result: PendingResult) => { clearTimeout(timer); done(result); };
      entry.waiters.push(deliver);
    });
  }

  /** The terminal answered first (or the call went away): take the buttons back. */
  async resolveElsewhere(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.done = true;
    for (const waiter of entry.waiters.splice(0)) waiter({ cancelled: true });
    const config = this.deps.getConfig();
    if (config.forumChatId === undefined || entry.answer !== undefined) return;
    await this.deps.transport.editText(config.forumChatId, entry.messageId, `<b>${escapeHtml(entry.title)}</b>\n已在终端处理。`);
  }

  private async handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const config = this.deps.getConfig();
    const match = query.data?.match(/^p:([\w-]{1,40}):(\d+)$/);
    if (!match) return;
    if (query.from?.id === undefined || query.from.id !== config.allowedUserId || query.message?.chat?.id !== config.forumChatId) {
      await this.deps.transport.answerCallbackQuery(query.id);
      return;
    }
    const entry = this.pending.get(match[1]!);
    const label = entry?.labels[Number(match[2])];
    if (!entry || entry.done || entry.answer !== undefined || label === undefined) {
      await this.deps.transport.answerCallbackQuery(query.id, "已处理");
      return;
    }
    await this.deps.transport.answerCallbackQuery(query.id, label);
    if (label === entry.textLabel) {
      entry.awaitingText = true;
      await this.deps.transport.editText(config.forumChatId!, entry.messageId,
        `<b>${escapeHtml(entry.title)}</b>\n请直接在话题里发送你的回答。`);
      return;
    }
    await this.settle(match[1]!, entry, label);
  }

  private async settle(id: string, entry: Pending, answer: string): Promise<void> {
    entry.answer = answer;
    entry.awaitingText = false;
    const config = this.deps.getConfig();
    if (config.forumChatId !== undefined) {
      await this.deps.transport.editText(config.forumChatId, entry.messageId, `<b>${escapeHtml(entry.title)}</b>\n→ ${escapeHtml(answer)}`);
    }
    if (entry.waiters.length > 0) {
      this.pending.delete(id);
      for (const waiter of entry.waiters.splice(0)) waiter({ answer });
    }
  }

  // ── /restart ────────────────────────────────────────────────────────────

  /**
   * Hand the restart to a detached helper (it outlives Claude Code) and tell
   * the topic. The mod exits Claude Code only when this returns true.
   */
  async prepareRestart(connId: string, claudeSessionId: string): Promise<boolean> {
    const session = this.sessions.get(connId);
    if (!session) return false;
    if (!session.pane || session.pid === undefined || !session.modDir || !claudeSessionId || !this.deps.startRestart) {
      await this.noticeTo(session, "无法重启：不在 tmux 中，或缺少会话信息。Claude Code 没有退出。");
      return false;
    }
    const argv = this.deps.readArgv?.(session.pid);
    this.deps.startRestart({ pid: session.pid, pane: session.pane, cwd: session.cwd, modDir: session.modDir,
      sessionId: claudeSessionId, ...(argv?.length ? { argv } : {}) });
    this.restarting.add(claudeSessionId);
    await this.noticeTo(session, "正在重启 Claude Code…");
    return true;
  }
}
