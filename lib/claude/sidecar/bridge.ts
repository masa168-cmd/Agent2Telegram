import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { forumTopicKey, telegramTokenHash } from "../../core/instance-coordinator.ts";
import { escapeHtml } from "../../core/html.ts";
import { markdownToTelegramHtml } from "../../core/markdown.ts";
import { authorizeTelegramUser } from "../../core/pairing.ts";
import type { TelegramConfig, TelegramTransport, TelegramUpdate } from "../../core/types.ts";
import { runtimeDir } from "./paths.ts";

/** What the sidecar hands to the mod, one JSON line on stdout each. */
export type BridgeEvent =
  | { type: "prompt"; text: string }
  | { type: "abort" }
  | { type: "command"; name: "compact" | "clear" }
  | { type: "usage" }
  | { type: "restart" }
  | { type: "log"; text: string };

/** What a waiter on an approval or a question gets back. */
export type PendingResult = { answer: string } | { cancelled: true } | { pending: true };

/** Commands shown in the group's "/" menu. */
export const MENU_COMMANDS = [
  { command: "stop", description: "中断当前回合" },
  { command: "compact", description: "压缩上下文" },
  { command: "clear", description: "清空对话" },
  { command: "usage", description: "查看用量" },
  { command: "restart", description: "重启 Claude Code（仅 tmux）" },
] as const;

export type BridgeDeps = {
  cwd: string;
  dataDir: string;
  getConfig: () => TelegramConfig;
  api: <T>(method: string, body: Record<string, unknown>) => Promise<T>;
  transport: Pick<TelegramTransport, "sendText" | "sendChatAction" | "sendButtons" | "editText" | "answerCallbackQuery">;
  emit: (event: BridgeEvent) => void;
  /** Persist pairing results (allowedUserId, cleared code) to the bot record. */
  savePairing: (config: TelegramConfig) => Promise<void>;
  now?: () => number;
  typingIntervalMs?: number;
  /** True when Claude Code runs in a tmux pane, the one place /restart can work. */
  canRestart?: () => boolean;
};

type TopicStore = { version: 1; topics: Record<string, { threadId: number; cwd: string; updatedAt: string }> };

type Pending = {
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
const UNSUPPORTED_COMMAND_TEXT = "暂不支持这个命令。可用：/stop /compact /clear /usage /restart";
const RESTART_NEEDS_TMUX_TEXT = "只有在 tmux 里运行 ctg 时才能用 /restart。Claude Code 没有退出。";
const PRIVATE_AFTER_PAIRING_TEXT = "已配对。请在论坛群里本目录对应的话题中和我对话。";

/** Same key shape as the Pi adapter: `telegram:<bot id>`, else a token hash. */
export function botKey(token: string): string {
  const id = token.match(/^(\d+):/)?.[1];
  return id ? `telegram:${id}` : `token-hash:${telegramTokenHash(token)}`;
}

function isThreadGone(error: unknown): boolean {
  return /thread not found|TOPIC_DELETED|TOPIC_CLOSED/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * One Claude Code session ↔ one forum topic (the session's launch directory).
 * Telegram text from the paired user in that topic becomes a prompt; the
 * session's final answers go back to the topic.
 */
export class ClaudeTelegramBridge {
  threadId: number | undefined;
  private pairingFailures = 0;
  private typing: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly cwd: string;

  constructor(private readonly deps: BridgeDeps) {
    this.cwd = resolve(deps.cwd);
  }

  private get topicsPath(): string {
    return join(runtimeDir(this.deps.dataDir), "topics.json");
  }

  private async readTopics(): Promise<TopicStore> {
    try {
      const parsed = JSON.parse(await readFile(this.topicsPath, "utf8")) as TopicStore;
      if (parsed?.version === 1 && parsed.topics && typeof parsed.topics === "object") return parsed;
    } catch { /* missing or corrupt: start empty */ }
    return { version: 1, topics: {} };
  }

  private async writeTopics(store: TopicStore): Promise<void> {
    await mkdir(runtimeDir(this.deps.dataDir), { recursive: true, mode: 0o700 });
    const tmp = `${this.topicsPath}.tmp`;
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.topicsPath);
  }

  private topicKey(config: TelegramConfig): string | undefined {
    if (!config.botToken || config.forumChatId === undefined) return undefined;
    return forumTopicKey(botKey(config.botToken), config.forumChatId, this.cwd);
  }

  /** Find or create this directory's topic. Needs a forum group and a paired user. */
  async ensureTopic(): Promise<number | undefined> {
    const config = this.deps.getConfig();
    const key = this.topicKey(config);
    if (!key || config.allowedUserId === undefined) return undefined;
    const store = await this.readTopics();
    const known = store.topics[key];
    if (known) return (this.threadId = known.threadId);
    const created = await this.deps.api<{ message_thread_id: number }>("createForumTopic", {
      chat_id: config.forumChatId,
      name: basename(this.cwd) || this.cwd,
    });
    store.topics[key] = { threadId: created.message_thread_id, cwd: this.cwd, updatedAt: new Date(this.now()).toISOString() };
    await this.writeTopics(store);
    this.deps.emit({ type: "log", text: `Telegram 话题已创建：${basename(this.cwd) || this.cwd}` });
    return (this.threadId = created.message_thread_id);
  }

  private async forgetTopic(): Promise<void> {
    const key = this.topicKey(this.deps.getConfig());
    this.threadId = undefined;
    if (!key) return;
    const store = await this.readTopics();
    delete store.topics[key];
    await this.writeTopics(store);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
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
        await this.ensureTopic();
      }
      return;
    }

    if (chatId !== config.forumChatId || userId === undefined || userId !== config.allowedUserId) return;
    if (this.threadId === undefined || message.message_thread_id !== this.threadId) return;
    const text = message.text?.trim();
    if (!text) return;
    for (const [id, entry] of this.pending) {
      if (entry.awaitingText && !entry.done && !text.startsWith("/")) {
        await this.settle(id, entry, text);
        return;
      }
    }
    const command = text.match(/^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s|$)/)?.[1];
    if (command === "stop") {
      this.deps.emit({ type: "abort" });
      return;
    }
    if (command === "compact" || command === "clear") {
      this.deps.emit({ type: "command", name: command });
      return;
    }
    if (command === "usage") {
      this.deps.emit({ type: "usage" });
      return;
    }
    if (command === "restart") {
      if (this.deps.canRestart?.()) this.deps.emit({ type: "restart" });
      else await this.deps.transport.sendText(chatId, RESTART_NEEDS_TMUX_TEXT, this.threadId);
      return;
    }
    if (command !== undefined) {
      await this.deps.transport.sendText(chatId, UNSUPPORTED_COMMAND_TEXT, this.threadId);
      return;
    }
    this.deps.emit({ type: "prompt", text });
  }

  /** Register the "/" menu for the forum group only. */
  async registerCommands(): Promise<void> {
    const config = this.deps.getConfig();
    if (config.forumChatId === undefined) return;
    await this.deps.api("setMyCommands", { commands: MENU_COMMANDS, scope: { type: "chat", chat_id: config.forumChatId } });
  }

  /** Plain text to the topic (command results, usage). */
  async notice(text: string): Promise<void> {
    const config = this.deps.getConfig();
    if (this.threadId === undefined || config.forumChatId === undefined) return;
    await this.deps.transport.sendText(config.forumChatId, escapeHtml(text), this.threadId);
  }

  /**
   * Show a question with one button per label in the topic. Returns false when
   * there is no topic to show it in (the terminal then answers alone).
   */
  async openPrompt(id: string, title: string, body: string, labels: string[], textLabel?: string): Promise<boolean> {
    const config = this.deps.getConfig();
    if (this.threadId === undefined || config.forumChatId === undefined || this.pending.has(id) || labels.length === 0) return false;
    const rows = labels.map((text, index) => [{ text, value: `p:${id}:${index}` }]);
    const text = body ? `<b>${escapeHtml(title)}</b>\n<pre>${escapeHtml(body.slice(0, 1500))}</pre>` : `<b>${escapeHtml(title)}</b>`;
    const sent = await this.deps.transport.sendButtons(config.forumChatId, text, rows, this.threadId);
    this.pending.set(id, { messageId: sent.message_id, title, labels, waiters: [],
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
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        entry.waiters = entry.waiters.filter(w => w !== deliver);
        resolve({ pending: true });
      }, timeoutMs);
      const deliver = (result: PendingResult) => { clearTimeout(timer); resolve(result); };
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
      if (config.forumChatId !== undefined) {
        await this.deps.transport.editText(config.forumChatId, entry.messageId,
          `<b>${escapeHtml(entry.title)}</b>\n请直接在话题里发送你的回答。`);
      }
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

  turnStarted(): void {
    const config = this.deps.getConfig();
    if (this.threadId === undefined || config.forumChatId === undefined || this.typing) return;
    const chatId = config.forumChatId;
    const send = () => { void this.deps.transport.sendChatAction(chatId, "typing", this.threadId); };
    send();
    this.typing = setInterval(send, this.deps.typingIntervalMs ?? TYPING_INTERVAL_MS);
    this.typing.unref?.();
  }

  stopTyping(): void {
    if (this.typing) clearInterval(this.typing);
    this.typing = undefined;
  }

  async turnCompleted(answer: string, isAborted: boolean): Promise<void> {
    this.stopTyping();
    const config = this.deps.getConfig();
    if (this.threadId === undefined || config.forumChatId === undefined) return;
    const text = answer.trim() || (isAborted ? "（已中断）" : "（本回合没有文字回复）");
    const html = markdownToTelegramHtml(text);
    try {
      await this.deps.transport.sendText(config.forumChatId, html, this.threadId);
    } catch (error) {
      if (!isThreadGone(error)) throw error;
      // The topic was deleted in Telegram: make a new one and send there once.
      await this.forgetTopic();
      const threadId = await this.ensureTopic();
      if (threadId !== undefined) await this.deps.transport.sendText(config.forumChatId, html, threadId);
    }
  }
}
