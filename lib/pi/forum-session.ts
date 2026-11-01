import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isForumChatId, readForumBinding, sameForumTarget, type ForumTarget } from "../core/forum-binding.ts";
import { ForumInbox, authorizedForumUpdate, type ForumDelivery, type ForumRegistration } from "../core/forum-router.ts";
import { forumTopicKey, telegramTokenHash, type ForumTopicRecord,
  type TelegramInstanceCoordinator } from "../core/instance-coordinator.ts";
import { telegramApi, TelegramApiRequestError } from "../core/telegram-api.ts";
import type { TelegramConfig } from "../core/types.ts";

/** Telegram's public numeric Bot id survives token rotation; no secret enters a binding. */
export function forumBotId(token: string): string {
  const id = token.match(/^(\d+):/)?.[1];
  return id ? `telegram:${id}` : `token-hash:${telegramTokenHash(token)}`;
}

/** The topic identity: the resolved launch directory (symlinks collapse to one topic). */
export function canonicalCwd(cwd: string | undefined): string {
  const absolute = resolve(cwd ?? process.cwd());
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Home-relative directory name, e.g. `pi-main` or `work/tmp`; `~` for home, absolute outside it. */
export function forumTopicName(cwd: string, home = homedir()): string {
  const rel = relative(home, cwd);
  const name = cwd === home ? "~" : rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : cwd;
  return name.slice(0, 128);
}
type SessionDeps = {
  pi: Pick<ExtensionAPI, "appendEntry">;
  getConfig(): TelegramConfig;
  getCoordinator(): TelegramInstanceCoordinator | undefined;
  onUpdate(delivery: ForumDelivery): Promise<void>;
  onChange(): void;
  onError(error: unknown): void;
  /** Shared only by successive reloads of this process, never a global dialog/session fallback. */
  seen?: Set<string>;
  callApi?: typeof telegramApi;
  now?: () => number;
};

/** One currently loaded Pi session. No offline launch, disk scan or background Pi. */
export class ForumSession {
  private ctx?: ExtensionContext;
  private identity?: string;
  private generation = randomUUID();
  /** Directory topic from the shared map; undefined until loaded, or after a confirmed deletion. */
  private topic?: ForumTopicRecord;
  private topicKey?: string;
  private cwdKey?: string;
  /** Pre-directory session binding, used only once to seed an empty directory map entry. */
  private legacyThread?: number;
  private inbox?: ForumInbox;
  private port = 0;
  private claimed = false;
  private publishedThread?: number | null;
  private publishedAt = 0;
  private validated = false;
  private retryAllowed = false;
  private retryAt = 0;
  private starting = false;
  private epoch = 0;
  private messageIds = new Set<number>();
  private buttonIds = new Set<number>();
  private readonly operation = new AsyncLocalStorage<ForumTarget>();
  private readonly now: () => number;
  lastError?: string;

  constructor(private readonly deps: SessionDeps) { this.now = deps.now ?? Date.now; }
  get enabled(): boolean { return this.deps.getConfig().forumChatId !== undefined; }
  get hasRemoteOperation(): boolean { return this.operation.getStore() !== undefined; }

  private configIdentity(ctx: ExtensionContext): string {
    const c = this.deps.getConfig();
    return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd, c.botToken, c.forumChatId,
      c.allowedUserId, c.apiBase, c.telegramEnabled !== false]);
  }
  private current(): boolean {
    return !!this.ctx && !!this.port && this.identity === this.configIdentity(this.ctx)
      && this.deps.getConfig().telegramEnabled !== false;
  }

  async prepare(ctx: ExtensionContext): Promise<void> {
    const identity = this.configIdentity(ctx);
    if (this.identity === identity) return;
    const closing = this.close();
    const epoch = this.epoch;
    await closing;
    if (this.epoch !== epoch) return;
    const c = this.deps.getConfig();
    this.ctx = ctx;
    this.identity = identity;
    this.generation = randomUUID();
    this.lastError = undefined;
    if (!this.enabled || c.telegramEnabled === false) return;
    if (!c.botToken || !isForumChatId(c.forumChatId) || !Number.isSafeInteger(c.allowedUserId)
      || c.allowedUserId! <= 0) {
      this.lastError = "话题模式需要固定负数群 ID、Bot 和已配对的用户；请先在本地/SSH 配置。";
      return;
    }
    this.cwdKey = canonicalCwd(ctx.cwd);
    this.topicKey = forumTopicKey(forumBotId(c.botToken), c.forumChatId, this.cwdKey);
    this.topic = undefined;
    this.legacyThread = readForumBinding(ctx.sessionManager.getEntries(), forumBotId(c.botToken),
      c.forumChatId, ctx.sessionManager.getSessionId())?.threadId ?? undefined;
    const inbox = new ForumInbox({ seen: this.deps.seen,
      authorize: async delivery => {
        const target = this.getTarget();
        const config = this.deps.getConfig();
        if (!sameForumTarget(target, delivery.target)
          || !authorizedForumUpdate(delivery.update, target!.chatId, config.allowedUserId!)
          || (delivery.update.callback_query
            && !this.buttonIds.has(delivery.update.callback_query.message!.message_id))
          || (delivery.update.callback_query?.message ?? delivery.update.message)?.message_thread_id !== target!.threadId) return false;
        const leaderValid = await this.deps.getCoordinator()?.isCurrentLeader(delivery.leader);
        return !!leaderValid && sameForumTarget(this.getTarget(), delivery.target);
      },
      onUpdate: delivery => this.operation.run(delivery.target, () => {
        if (!sameForumTarget(this.getTarget(), delivery.target)) return Promise.resolve();
        return this.deps.onUpdate(delivery);
      }),
      onError: error => this.deps.onError(error),
    });
    this.inbox = inbox;
    try {
      const port = await inbox.start();
      if (this.inbox !== inbox || this.identity !== identity) { inbox.close(); return; }
      this.port = port;
    } catch (error) {
      inbox.close();
      this.lastError = "本机会话收件接口启动失败；未开启话题遥控。";
      this.deps.onError(error);
    }
  }

  registration(): ForumRegistration | undefined {
    if (!this.current()) return;
    const c = this.deps.getConfig();
    return { botId: forumBotId(c.botToken!), chatId: c.forumChatId!,
      sessionId: this.ctx!.sessionManager.getSessionId(), threadId: this.topic?.threadId ?? null,
      generation: this.generation, cwdKey: this.cwdKey, port: this.port, capability: this.inbox!.capability,
      messageIds: [...this.buttonIds] };
  }

  /** Called only after the exact registration was accepted under the coordinator lock. */
  async reconciled(registration: ForumRegistration | undefined, conflict?: string): Promise<void> {
    if (!this.current() || !registration || registration.generation !== this.generation) return;
    this.claimed = !conflict;
    this.publishedThread = conflict ? undefined : registration.threadId;
    this.publishedAt = this.now();
    if (conflict) {
      this.lastError = `此目录、会话或话题已由在线实例 ${conflict.slice(0, 8)} 占用；同一目录只接入一个 Pi，不会强行接管。`;
      return;
    }
    if (this.starting || this.validated || this.now() < this.retryAt) return;
    const coordinator = this.deps.getCoordinator();
    if (!coordinator || !this.topicKey || !this.cwdKey) return;
    this.starting = true;
    const generation = this.generation;
    const key = this.topicKey;
    const cwd = this.cwdKey;
    const config = this.deps.getConfig();
    const api = this.deps.callApi ?? telegramApi;
    const stillCurrent = () => this.current() && this.generation === generation;
    let phase: "map" | "reopen" | "create" = "map";
    try {
      // Re-read until validated: a previous session in this directory may have just recorded a result.
      let topic = await coordinator.readForumTopic(key);
      if (!stillCurrent()) return;
      if (!topic && this.legacyThread) {
        // One-time migration of a pre-directory session binding into the directory map.
        topic = { threadId: this.legacyThread, cwd };
        await coordinator.writeForumTopic(key, topic);
        if (!stillCurrent()) return;
      }
      this.topic = topic;
      if (topic?.state === "create-unknown" && !this.retryAllowed) {
        this.lastError = "话题创建结果未确认；不会自动重试。先检查 Telegram，再在 SSH 中运行 /tg-forum retry 并确认。";
        this.retryAt = this.now() + 2000;
        return;
      }
      if (topic?.threadId) {
        phase = "reopen";
        try {
          // Reopens a closed topic; an open one answers TOPIC_NOT_MODIFIED.
          await api(config.botToken!, "reopenForumTopic", { chat_id: config.forumChatId,
            message_thread_id: topic.threadId }, AbortSignal.timeout(10_000), config.apiBase);
        } catch (error) {
          if (!(error instanceof TelegramApiRequestError)) throw error;
          if (/TOPIC_ID_INVALID|MESSAGE_THREAD_INVALID|message thread not found|TOPIC_DELETED/i.test(error.message)) {
            topic = undefined; // confirmed deleted: recreate once below
          } else if (!/TOPIC_NOT_MODIFIED/i.test(error.message)) throw error;
        }
        if (!stillCurrent()) return;
      }
      if (!topic?.threadId) {
        phase = "map";
        // Persist intent BEFORE the non-idempotent request. Never blindly retry a lost result.
        const intent: ForumTopicRecord = { threadId: null, state: "create-unknown", cwd };
        await coordinator.writeForumTopic(key, intent);
        this.topic = intent;
        this.retryAllowed = false;
        if (!stillCurrent()) return;
        phase = "create";
        const result = await api<{ message_thread_id: number }>(config.botToken!, "createForumTopic",
          { chat_id: config.forumChatId, name: forumTopicName(cwd) }, AbortSignal.timeout(10_000), config.apiBase);
        if (!Number.isSafeInteger(result?.message_thread_id) || result.message_thread_id < 1) {
          throw new Error("Invalid topic creation response");
        }
        const created: ForumTopicRecord = { threadId: result.message_thread_id, cwd };
        // The topic belongs to the directory: record it even if this session was replaced meanwhile.
        await coordinator.writeForumTopic(key, created, true);
        if (!stillCurrent()) return;
        this.topic = created;
      }
      this.validated = true;
      this.lastError = undefined;
      // Not sendable until this thread was published and accepted under the coordinator lock.
      if (this.publishedThread !== this.topic?.threadId) this.deps.onChange();
    } catch (error) {
      if (!stillCurrent()) return;
      this.lastError = phase === "map"
        ? "话题对照表无法读取或写入；未猜测话题。请通过 SSH 检查 tg-runtime 目录权限。"
        : phase === "reopen"
          ? "话题验证失败：请检查 Bot 的管理话题权限、群 ID 和网络；暂不发送会话内容。"
          : "话题创建结果未确认；不会自动重试。先检查 Telegram，再在 SSH 中运行 /tg-forum retry 并确认。";
      this.retryAt = this.now() + Math.max(2000,
        error instanceof TelegramApiRequestError ? error.retryAfterMs ?? 0 : 0);
      // Do not log a fetch URL, token, arbitrary response body or model/session contents.
      this.deps.onError(new Error(this.lastError));
    } finally {
      if (this.generation === generation) this.starting = false;
    }
  }

  getTarget(): ForumTarget | undefined {
    const thread = this.topic?.threadId;
    if (!this.current() || !this.claimed || !this.validated || !thread
      || this.publishedThread !== thread || this.now() - this.publishedAt > 10_000) return;
    const c = this.deps.getConfig();
    const target: ForumTarget = { botId: forumBotId(c.botToken!), chatId: c.forumChatId!,
      sessionId: this.ctx!.sessionManager.getSessionId(), threadId: thread, generation: this.generation };
    const operation = this.operation.getStore();
    return operation && !sameForumTarget(operation, target) ? undefined : target;
  }
  isCurrentOperation(): boolean { return !!this.getTarget(); }
  lease(): string | undefined {
    const target = this.getTarget();
    return target ? `forum:${target.generation}:${target.threadId}` : undefined;
  }
  ownsMessage(id: number): boolean { return !!this.getTarget() && this.messageIds.has(id); }
  rememberMessage(id: number, buttons = false): void {
    if (!this.getTarget() || !Number.isSafeInteger(id) || id < 1) return;
    this.messageIds.add(id);
    if (this.messageIds.size > 4096) this.messageIds.delete(this.messageIds.values().next().value!);
    if (buttons) {
      this.buttonIds.add(id);
      if (this.buttonIds.size > 256) this.buttonIds.delete(this.buttonIds.values().next().value!);
      this.deps.onChange();
    }
  }

  /** Explicitly confirmed SSH recovery only. Never replaces a valid bound topic. */
  retryTopic(): boolean {
    if (!this.current() || this.topic?.threadId || this.starting) return false;
    this.retryAllowed = true;
    this.retryAt = 0;
    this.lastError = undefined;
    this.deps.onChange();
    return true;
  }

  close(): Promise<void> {
    this.epoch++;
    const coordinator = this.deps.getCoordinator();
    const generation = this.generation;
    const hadInbox = !!this.inbox;
    this.port = 0;
    this.claimed = false;
    this.validated = false;
    this.starting = false;
    this.retryAllowed = false;
    this.retryAt = 0;
    this.publishedThread = undefined;
    this.publishedAt = 0;
    this.topic = undefined;
    this.topicKey = undefined;
    this.cwdKey = undefined;
    this.legacyThread = undefined;
    this.ctx = undefined;
    this.identity = undefined;
    this.messageIds.clear();
    this.buttonIds.clear();
    this.inbox?.close();
    this.inbox = undefined;
    return hadInbox && coordinator
      ? coordinator.releaseForumRoute(generation).catch(error => this.deps.onError(error))
      : Promise.resolve();
  }
}
