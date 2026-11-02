import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalCwd, forumBotId, isForumChatId, readForumBinding, sameForumTarget, type ForumTarget } from "../core/forum-binding.ts";
import type { TelegramConfig, TelegramUpdate } from "../core/types.ts";
import { GatewayClient, type GatewayClientDeps, type GatewaySession, type GatewayState } from "./gateway-client.ts";

export { canonicalCwd, forumBotId, forumTopicName } from "../core/forum-binding.ts";

/** What the gateway hands this session: an update of its topic, under the target it was routed for. */
export type ForumDelivery = { target: ForumTarget; update: TelegramUpdate };

type Client = Pick<GatewayClient, "start" | "stop" | "rememberButton" | "listSessions">;

type SessionDeps = {
  pi: Pick<ExtensionAPI, "appendEntry">;
  getConfig(): TelegramConfig;
  onUpdate(delivery: ForumDelivery): Promise<void>;
  onChange(): void;
  onError(error: unknown): void;
  /** A gateway notice for the terminal (pairing instructions, a conflict). */
  onNotice?(text: string): void;
  /** `<Pi data dir>/gateway.sock`. */
  socketPath(): string;
  /** Injectable for tests. */
  createClient?(deps: GatewayClientDeps): Client;
};

/**
 * One currently loaded Pi session and its directory's forum topic. The
 * agent2telegram gateway polls the Bot, owns the directory → topic map and
 * hands this session the raw updates of its topic; Pi answers Telegram itself.
 */
export class ForumSession {
  private ctx?: ExtensionContext;
  private identity?: string;
  private generation = randomUUID();
  private threadId?: number;
  private client?: Client;
  private messageIds = new Set<number>();
  private readonly operation = new AsyncLocalStorage<ForumTarget>();
  lastError?: string;

  constructor(private readonly deps: SessionDeps) {}
  get enabled(): boolean { return this.deps.getConfig().forumChatId !== undefined; }
  get hasRemoteOperation(): boolean { return this.operation.getStore() !== undefined; }

  private configIdentity(ctx: ExtensionContext): string {
    const c = this.deps.getConfig();
    // Not the paired user: the gateway checks who may write, and pairing must not drop the topic.
    return JSON.stringify([ctx.sessionManager.getSessionId(), ctx.cwd, c.botToken, c.forumChatId,
      c.apiBase, c.telegramEnabled !== false]);
  }
  private current(): boolean {
    return !!this.ctx && this.identity === this.configIdentity(this.ctx) && this.deps.getConfig().telegramEnabled !== false;
  }

  /** Connect this session to the gateway (again, when its identity changed). */
  async prepare(ctx: ExtensionContext): Promise<void> {
    const identity = this.configIdentity(ctx);
    if (this.identity === identity) return;
    await this.close();
    // Another prepare connected while we waited: check again rather than open a second connection.
    if (this.identity !== undefined) return this.prepare(ctx);
    const c = this.deps.getConfig();
    this.ctx = ctx;
    this.identity = identity;
    this.generation = randomUUID();
    this.lastError = undefined;
    if (!this.enabled || c.telegramEnabled === false) return;
    if (!c.botToken || !isForumChatId(c.forumChatId)) {
      this.lastError = "话题模式需要 Bot 和固定负数群 ID；请用 a2t setup pi 配置。";
      return;
    }
    const sessionId = ctx.sessionManager.getSessionId();
    const legacy = readForumBinding(ctx.sessionManager.getEntries(), forumBotId(c.botToken), c.forumChatId, sessionId)?.threadId;
    const generation = this.generation;
    const clientDeps: GatewayClientDeps = {
      socketPath: this.deps.socketPath(),
      connId: generation,
      onState: state => { if (this.generation === generation) this.applyState(state); },
      onNotice: text => this.deps.onNotice?.(text),
      onUpdate: update => {
        const target = this.getTarget();
        if (!target || this.generation !== generation) return Promise.resolve();
        return this.operation.run(target, () => this.deps.onUpdate({ target, update }));
      },
    };
    const client = this.deps.createClient?.(clientDeps) ?? new GatewayClient(clientDeps);
    this.client = client;
    client.start({ cwd: canonicalCwd(ctx.cwd), claudeSessionId: sessionId, pid: process.pid,
      ...(process.env.TMUX_PANE ? { pane: process.env.TMUX_PANE } : {}),
      ...(legacy ? { legacyThreadId: legacy } : {}) });
  }

  private applyState(state: GatewayState): void {
    if (state.kind === "connecting") return;
    const before = this.threadId;
    if (state.kind === "connected") {
      this.threadId = state.threadId;
      this.lastError = undefined;
    } else {
      this.threadId = undefined;
      this.lastError = state.reason;
    }
    if (before !== this.threadId || state.kind === "waiting") this.deps.onChange();
  }

  getTarget(): ForumTarget | undefined {
    const thread = this.threadId;
    if (!this.current() || !thread) return;
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
    if (buttons) this.client?.rememberButton(id);
  }

  /** The online sessions of this Bot, from the gateway. */
  listSessions(): Promise<GatewaySession[]> {
    return this.client?.listSessions() ?? Promise.resolve([]);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.threadId = undefined;
    this.ctx = undefined;
    this.identity = undefined;
    this.messageIds.clear();
    await client?.stop().catch(error => this.deps.onError(error));
  }
}
