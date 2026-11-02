// Pi's side of the agent2telegram gateway (rich client). The gateway alone polls
// the Bot and hands this session the raw updates of its directory's topic; Pi
// answers Telegram itself, as before. One instance per loaded Pi session.
import { request } from "node:http";
import type { TelegramUpdate } from "../core/types.ts";

export type GatewayOpen = {
  cwd: string;
  /** Pi's session id: shown in the gateway's online list. */
  claudeSessionId?: string;
  pid: number;
  pane?: string;
  /** The topic this session recorded before the gateway (seeds an empty directory). */
  legacyThreadId?: number;
};

export type GatewayState =
  | { kind: "connecting" }
  | { kind: "connected"; threadId: number }
  | { kind: "waiting"; reason: string };

type Event = { type: "update"; update: TelegramUpdate } | { type: "log"; text: string } | { type: string };
type Reply = { ok?: boolean; threadId?: number; reason?: string; notices?: string[]; events?: Event[]; unknown?: boolean;
  sessions?: GatewaySession[] };
export type GatewaySession = { cwd: string; threadId?: number; sessionId?: string; pid?: number };

export type GatewayClientDeps = {
  socketPath: string;
  connId: string;
  onUpdate(update: TelegramUpdate): Promise<void>;
  onState(state: GatewayState): void;
  onNotice?(text: string): void;
  /** Injectable for tests. */
  post?(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply | undefined>;
  sleep?(ms: number): Promise<void>;
};

const POLL_TIMEOUT_MS = 30_000;
const RETRY_DOWN_MS = 3_000;
const RETRY_REFUSED_MS = 30_000;
/** Registered but no topic yet (no user ID, or the topic could not be made): check again soon. */
const RETRY_UNPAIRED_MS = 5_000;

export function postUnix(socketPath: string, path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Reply | undefined> {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json",
      "content-length": Buffer.byteLength(payload) } }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(undefined);
        try { resolve(raw ? JSON.parse(raw) as Reply : {}); } catch { resolve(undefined); }
      });
      res.on("error", () => resolve(undefined));
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end(payload);
  });
}

export class GatewayClient {
  private stopped = false;
  private connected = false;
  private open?: GatewayOpen;
  private buttons: number[] = [];
  private lastReason?: string;
  private retryMs?: number;

  constructor(private readonly deps: GatewayClientDeps) {}

  private post(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply | undefined> {
    const send = this.deps.post ?? ((p, b, t) => postUnix(this.deps.socketPath, p, b, t));
    return send(path, { connId: this.deps.connId, ...body }, timeoutMs);
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? (t => new Promise<void>(done => { const timer = setTimeout(done, t); timer.unref?.(); })))(ms);
  }

  /** A button message Pi sent: callbacks on it may arrive without a thread. */
  rememberButton(messageId: number): void {
    if (Number.isSafeInteger(messageId) && messageId > 0) this.buttons.push(messageId);
  }

  start(open: GatewayOpen): void {
    this.open = open;
    void this.run();
  }

  private refuse(reason: string): void {
    this.connected = false;
    if (reason !== this.lastReason) this.deps.onState({ kind: "waiting", reason });
    this.lastReason = reason;
  }

  private async connect(): Promise<boolean> {
    this.deps.onState({ kind: "connecting" });
    const reply = await this.post("/open", { ...this.open });
    if (this.stopped) return false;
    if (reply === undefined) { this.refuse("Telegram 网关未运行（a2t status）。"); return false; }
    if (!reply.ok) { this.refuse(reply.reason ?? "Telegram 话题尚未就绪。"); return false; }
    if (!reply.threadId) {
      // The gateway took us but has no topic yet. Say why, once.
      const reason = reply.notices?.join("\n") || "Telegram 话题尚未就绪。";
      if (reason !== this.lastReason) this.deps.onNotice?.(reason);
      this.refuse(reason);
      this.retryMs = RETRY_UNPAIRED_MS;
      return false;
    }
    this.connected = true;
    this.lastReason = undefined;
    for (const notice of reply.notices ?? []) this.deps.onNotice?.(notice);
    this.deps.onState({ kind: "connected", threadId: reply.threadId });
    return true;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      if (!this.connected && !(await this.connect())) {
        const wait = this.retryMs ?? (this.lastReason?.includes("网关未运行") ? RETRY_DOWN_MS : RETRY_REFUSED_MS);
        this.retryMs = undefined;
        await this.sleep(wait);
        continue;
      }
      const messageIds = this.buttons.splice(0);
      const reply = await this.post("/poll", { messageIds }, POLL_TIMEOUT_MS);
      if (this.stopped) return;
      if (reply === undefined) {
        this.buttons.unshift(...messageIds);
        this.refuse("Telegram 网关未运行（a2t status）。");
        await this.sleep(RETRY_DOWN_MS);
        continue;
      }
      if (reply.unknown) { this.buttons.unshift(...messageIds); this.connected = false; continue; } // gateway restarted
      for (const event of reply.events ?? []) {
        // Never wait for the handling: a picker opened by one update waits for a later one.
        if (event.type === "update" && "update" in event) void this.deps.onUpdate(event.update).catch(() => undefined);
        else if (event.type === "log" && "text" in event) this.deps.onNotice?.(event.text);
      }
    }
  }

  async listSessions(): Promise<GatewaySession[]> {
    return (await this.post("/sessions", {}))?.sessions ?? [];
  }

  /** Say goodbye; the gateway drops the session at once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.connected) await this.post("/close", {}, 2_000);
    this.connected = false;
  }
}
