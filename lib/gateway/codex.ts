// Codex: the gateway is itself the client. Codex TUIs (in tmux) run their
// threads in the shared app-server daemon; the gateway connects to it, finds
// the loaded threads of enabled directories, and drives each one through the
// thin-mode BotGateway like a Claude Code session. Nothing is installed into
// Codex. Protocol: JSON-RPC over a WebSocket on the daemon's Unix socket.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotGateway, GatewayEvent, MenuCommand } from "./bot-gateway.ts";

/** Codex's "/" menu: what maps onto app-server requests. */
export const CODEX_COMMANDS: readonly MenuCommand[] = [
  { command: "menu", description: "在输入框下方显示快捷按钮" },
  { command: "stop", description: "中断当前回合" },
  { command: "compact", description: "压缩上下文" },
  { command: "usage", description: "查看用量" },
];

export function codexSocketPath(): string {
  return process.env.CODEX_APP_SERVER_SOCK ?? join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

/** One JSON-RPC connection to the app-server. */
export type CodexRpc = {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
  /** Resolves when the connection ends. */
  closed: Promise<void>;
  close(): void;
};

type WsLike = {
  on(event: "open" | "close", cb: () => void): void;
  on(event: "message", cb: (data: { toString(): string }) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
};

/** Connect and finish the handshake (`initialize`, then `initialized`). */
export async function connectCodex(socketPath = codexSocketPath(), timeoutMs = 10_000): Promise<CodexRpc> {
  const WebSocket = createRequire(import.meta.url)("ws") as new (url: string) => WsLike;
  const ws = new WebSocket(`ws+unix://${socketPath}:/`);
  let nextId = 0;
  const waits = new Map<number, { done: (v: unknown) => void; fail: (e: Error) => void }>();
  const handlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
  let markClosed!: () => void;
  const closed = new Promise<void>(done => (markClosed = done));
  const failAll = (error: Error) => { for (const w of waits.values()) w.fail(error); waits.clear(); };
  ws.on("message", raw => {
    let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.method === undefined && m.id !== undefined) {
      const w = waits.get(m.id);
      waits.delete(m.id);
      if (m.error) w?.fail(new Error(m.error.message ?? JSON.stringify(m.error)));
      else w?.done(m.result);
    } else if (m.method !== undefined && m.id === undefined) {
      for (const h of handlers) h(m.method, m.params ?? {});
    }
    // Server requests (approvals): the terminal answers them; we stay out.
  });
  ws.on("close", () => { failAll(new Error("Codex app-server 连接已断开")); markClosed(); });
  ws.on("error", () => { /* "close" follows */ });
  const rpc: CodexRpc = {
    call: <T>(method: string, params: unknown) => new Promise<T>((done, fail) => {
      const id = ++nextId;
      waits.set(id, { done: done as (v: unknown) => void, fail });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    onNotification: handler => { handlers.push(handler); },
    closed,
    close: () => ws.close(),
  };
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => { fail(new Error("连接 Codex app-server 超时")); ws.close(); }, timeoutMs);
    ws.on("open", () => { clearTimeout(timer); done(); });
    void closed.then(() => { clearTimeout(timer); fail(new Error(`无法连接 Codex app-server（${socketPath}）`)); });
  });
  await rpc.call("initialize", { clientInfo: { name: "agent2telegram", title: "Agent2Telegram", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: false } });
  ws.send(JSON.stringify({ method: "initialized" }));
  return rpc;
}

type CodexThread = { id: string; cwd: string; ephemeral?: boolean; parentThreadId?: string | null };
type ThreadItem = { type: string; text?: string; phase?: string | null };
type Turn = { id: string; status: string; items?: ThreadItem[]; error?: { message?: string } | null };

type Tracked = {
  connId: string;
  cwd: string;
  /** thread/resume worked: events arrive. A thread not yet written to disk cannot be resumed. */
  subscribed: boolean;
  activeTurnId?: string;
  /** Unsubscribed and we started a turn: read the answer when the thread goes idle. */
  awaitingRead?: boolean;
  /** Agent messages of the running turn, as they complete. */
  items: ThreadItem[];
  stopped?: boolean;
};

export type CodexBridgeDeps = {
  gateway: Pick<BotGateway, "open" | "poll" | "close" | "turnStarted" | "turnCompleted" | "notice">;
  connect: () => Promise<CodexRpc>;
  log: (text: string) => void;
  scanMs?: number;
  retryMs?: number;
  pollMs?: number;
};

/** The last agent text of a turn: the final answer when marked, else the last message. */
export function turnAnswer(items: readonly ThreadItem[] = []): string {
  const texts = items.filter(i => i.type === "agentMessage" && typeof i.text === "string");
  return (texts.filter(i => i.phase === "final_answer").at(-1) ?? texts.at(-1))?.text ?? "";
}

export class CodexBridge {
  private readonly threads = new Map<string, Tracked>();
  /** Threads that are not ours to show (helpers, subagents), so they are read once. */
  private readonly ignored = new Set<string>();
  private rpc?: CodexRpc;

  constructor(private readonly deps: CodexBridgeDeps) {}

  /** Connect, keep reconnecting, and scan for threads until `stopping()`. */
  async run(stopping: () => boolean): Promise<void> {
    let lastError = "";
    while (!stopping()) {
      try {
        const rpc = await this.deps.connect();
        this.rpc = rpc;
        lastError = "";
        this.deps.log("[codex] connected to app-server");
        rpc.onNotification((method, params) => { void this.onNotification(method, params).catch(e => this.deps.log(`[codex] ${method}: ${String(e)}`)); });
        let open = true;
        void rpc.closed.then(() => { open = false; });
        while (open && !stopping()) {
          await this.scan().catch(e => this.deps.log(`[codex] scan failed: ${String(e)}`));
          await Promise.race([rpc.closed, sleep(this.deps.scanMs ?? 5_000)]);
        }
        rpc.close();
        this.deps.log("[codex] app-server connection ended");
      } catch (error) {
        const text = String(error);
        if (text !== lastError) this.deps.log(`[codex] ${text}`);
        lastError = text;
      }
      this.rpc = undefined;
      for (const id of [...this.threads.keys()]) this.forget(id);
      this.ignored.clear();
      if (!stopping()) await sleep(this.deps.retryMs ?? 5_000);
    }
  }

  /** Match loaded threads to sessions: new ones open (if enabled), gone ones close. */
  async scan(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    const loaded = new Set((await rpc.call<{ data: string[] }>("thread/loaded/list", {})).data);
    for (const id of [...this.threads.keys()]) if (!loaded.has(id)) this.forget(id);
    for (const id of [...this.ignored]) if (!loaded.has(id)) this.ignored.delete(id);
    for (const id of loaded) {
      if (this.ignored.has(id)) continue;
      const known = this.threads.get(id);
      if (known && !known.stopped) {
        if (!known.subscribed && !known.activeTurnId) await this.subscribe(id, known);
        continue;
      }
      const thread = known ? undefined : (await rpc.call<{ thread: CodexThread }>("thread/read", { threadId: id, includeTurns: false })).thread;
      if (thread && (thread.ephemeral || thread.parentThreadId)) { this.ignored.add(id); continue; }
      await this.attach(id, known?.cwd ?? thread!.cwd);
    }
  }

  private async attach(id: string, cwd: string): Promise<void> {
    const connId = `codex:${id}`;
    const opened = await this.deps.gateway.open({ connId, cwd });
    if (!opened.ok) {
      // Not enabled, or the directory already has a session: try again next scan.
      this.threads.set(id, { connId, cwd, subscribed: false, items: [], stopped: true });
      return;
    }
    for (const text of opened.notices) this.deps.log(`[codex] ${cwd}: ${text}`);
    const tracked: Tracked = { connId, cwd, subscribed: false, items: [] };
    this.threads.set(id, tracked);
    await this.subscribe(id, tracked);
    const home = homedir();
    const shown = cwd === home || cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
    await this.deps.gateway.notice(connId, `Codex 会话已接入。本话题对应目录 ${shown}`).catch(() => undefined);
    void this.pump(id, tracked);
  }

  private async subscribe(id: string, tracked: Tracked): Promise<void> {
    try {
      await this.rpc?.call("thread/resume", { threadId: id, excludeTurns: true });
      tracked.subscribed = true;
    } catch { /* not on disk yet: retried by the next scan */ }
  }

  private forget(id: string): void {
    const tracked = this.threads.get(id);
    if (!tracked) return;
    this.threads.delete(id);
    if (!tracked.stopped) { tracked.stopped = true; this.deps.gateway.close(tracked.connId); }
  }

  /** Telegram → Codex, until the gateway drops the session (exit, `a2t disable`). */
  private async pump(id: string, tracked: Tracked): Promise<void> {
    while (!tracked.stopped) {
      const got = await this.deps.gateway.poll(tracked.connId, this.deps.pollMs ?? 20_000);
      if ("unknown" in got) { tracked.stopped = true; break; }
      for (const event of got.events) await this.handle(id, tracked, event).catch(async error => {
        await this.deps.gateway.notice(tracked.connId, `Codex 请求失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async handle(id: string, tracked: Tracked, event: GatewayEvent): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) throw new Error("Codex app-server 未连接");
    const notice = (text: string) => this.deps.gateway.notice(tracked.connId, text);
    if (event.type === "prompt") {
      const input = [{ type: "text", text: event.text, text_elements: [] }];
      if (tracked.activeTurnId) {
        // Busy: add it to the running turn, as typing in the terminal does.
        await rpc.call("turn/steer", { threadId: id, input, expectedTurnId: tracked.activeTurnId });
        return;
      }
      const started = await rpc.call<{ turn?: { id?: string } }>("turn/start", { threadId: id, input });
      if (!tracked.subscribed) {
        tracked.activeTurnId = started.turn?.id;
        tracked.awaitingRead = true;
        this.deps.gateway.turnStarted(tracked.connId);
      }
    } else if (event.type === "abort") {
      if (tracked.activeTurnId) await rpc.call("turn/interrupt", { threadId: id, turnId: tracked.activeTurnId });
      else await notice("当前没有进行中的回合。");
    } else if (event.type === "command" && event.name === "compact") {
      await rpc.call("thread/compact/start", { threadId: id });
      await notice("已开始压缩上下文。");
    } else if (event.type === "usage") {
      await notice(await this.usage(rpc));
    }
  }

  private async usage(rpc: CodexRpc): Promise<string> {
    try {
      const r = await rpc.call<{ rateLimits?: { primary?: Window | null; secondary?: Window | null } }>("account/rateLimits/read", {});
      const lines = [r.rateLimits?.primary, r.rateLimits?.secondary].filter((w): w is Window => !!w).map(windowText);
      return lines.length ? `Codex 用量\n${lines.join("\n")}` : "Codex 没有返回用量额度（API key 登录时没有额度窗口）。";
    } catch (error) {
      return `Codex 用量不可用：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Codex → Telegram: turns of tracked threads, whoever started them. */
  async onNotification(method: string, params: Record<string, unknown>): Promise<void> {
    const id = typeof params.threadId === "string" ? params.threadId : undefined;
    const tracked = id === undefined ? undefined : this.threads.get(id);
    if (!id || !tracked || tracked.stopped) return;
    if (method === "turn/started") {
      tracked.activeTurnId = (params.turn as Turn | undefined)?.id;
      tracked.items = [];
      this.deps.gateway.turnStarted(tracked.connId);
    } else if (method === "item/completed") {
      const item = params.item as ThreadItem | undefined;
      if (item?.type === "agentMessage") tracked.items.push(item);
    } else if (method === "turn/completed") {
      const turn = params.turn as Turn;
      tracked.activeTurnId = undefined;
      tracked.awaitingRead = false;
      await this.finish(tracked, turn, turnAnswer(tracked.items.length ? tracked.items : turn.items));
      tracked.items = [];
    } else if (method === "thread/status/changed" && tracked.awaitingRead
      && (params.status as { type?: string } | undefined)?.type === "idle") {
      // The turn ran unsubscribed (a brand-new thread): read its result.
      tracked.awaitingRead = false;
      tracked.activeTurnId = undefined;
      const read = await this.rpc?.call<{ thread: { turns: Turn[] } }>("thread/read", { threadId: id, includeTurns: true });
      const turn = read?.thread.turns.at(-1);
      if (turn) await this.finish(tracked, turn, turnAnswer(turn.items));
      await this.subscribe(id, tracked);
    } else if (method === "thread/closed") {
      this.forget(id);
    }
  }

  private async finish(tracked: Tracked, turn: Turn, answer: string): Promise<void> {
    const failed = turn.status === "failed" ? `Codex 回合失败：${turn.error?.message ?? "未知错误"}` : "";
    await this.deps.gateway.turnCompleted(tracked.connId, [answer, failed].filter(Boolean).join("\n\n"), turn.status === "interrupted");
  }
}

type Window = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };

function windowText(w: Window): string {
  const span = w.windowDurationMins ? (w.windowDurationMins >= 1440 ? `${Math.round(w.windowDurationMins / 1440)} 天` : `${Math.round(w.windowDurationMins / 60)} 小时`) : "窗口";
  const reset = w.resetsAt ? `，${new Date(w.resetsAt * 1000).toLocaleString("zh-CN", { hour12: false })} 重置` : "";
  return `${span}：已用 ${Math.round(w.usedPercent)}%${reset}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms).unref?.());
}
