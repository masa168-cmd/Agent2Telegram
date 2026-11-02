import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../core/types.ts";
import { BotGateway } from "../bot-gateway.ts";
import { CODEX_COMMANDS, CodexBridge, connectCodex, turnAnswer, type CodexRpc } from "../codex.ts";

const CHAT = -1001234567890;
const USER = 4242;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

type Thread = { id: string; cwd: string; parentThreadId?: string | null; ephemeral?: boolean; onDisk?: boolean };

/** A fake app-server: answers requests, lets the test push notifications. */
function fakeCodex(threads: Thread[]) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let notify: (method: string, params: Record<string, unknown>) => void = () => undefined;
  let turnSeq = 0;
  const turns: Record<string, unknown[]> = {};
  const rpc: CodexRpc = {
    call: async <T>(method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      const thread = threads.find(t => t.id === p.threadId);
      if (method === "thread/loaded/list") return { data: threads.map(t => t.id) } as T;
      if (method === "thread/read") return { thread: { ...thread, turns: turns[thread!.id] ?? [] } } as T;
      if (method === "thread/resume") { if (!thread?.onDisk) throw new Error(`no rollout found for thread id ${thread?.id}`); return {} as T; }
      if (method === "turn/start") return { turn: { id: `turn${++turnSeq}` } } as T;
      if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: null }, secondary: null } } as T;
      return {} as T;
    },
    onNotification: handler => { notify = handler; },
    closed: new Promise(() => undefined),
    close: () => undefined,
  };
  return { rpc, calls, turns, emit: (method: string, params: Record<string, unknown>) => notify(method, params),
    methods: () => calls.map(c => c.method) };
}

function setup(threads: Thread[], enabled = new Set(["/work/a"])) {
  const dataDir = mkdtempSync(join(tmpdir(), "codex-gateway-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let nextThread = 900;
  const sent: Array<{ text: string; threadId?: number }> = [];
  const gateway = new BotGateway({
    dataDir, mode: "thin", agentLabel: "Codex", commands: CODEX_COMMANDS,
    isEnabled: cwd => enabled.has(cwd),
    getConfig: () => ({ botToken: "123456:abc", forumChatId: CHAT, allowedUserId: USER }),
    api: (async (method: string) => {
      if (method === "createForumTopic") return { message_thread_id: nextThread++ };
      if (method === "reopenForumTopic") throw new Error("Bad Request: TOPIC_NOT_MODIFIED");
      return true;
    }) as never,
    transport: {
      sendText: (async (_chat: number, text: string, threadId?: number) => { sent.push({ text, threadId }); return [{ message_id: 1 }]; }) as never,
      sendChatAction: vi.fn(async () => undefined), sendButtons: vi.fn() as never, editText: vi.fn(), answerCallbackQuery: vi.fn(),
    },
  });
  const codex = fakeCodex(threads);
  const bridge = new CodexBridge({ gateway, connect: async () => codex.rpc, log: () => undefined, pollMs: 20 });
  (bridge as unknown as { rpc: CodexRpc }).rpc = codex.rpc;
  cleanups.push(() => { for (const t of threads) gateway.close(`codex:${t.id}`); });
  const say = (text: string, threadId = 900) => gateway.handleUpdate({ update_id: 1, message: { message_id: 5,
    chat: { id: CHAT, type: "supergroup" }, from: { id: USER }, message_thread_id: threadId, text } } as TelegramUpdate);
  return { gateway, bridge, codex, sent, say, enabled, texts: () => sent.map(s => s.text) };
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 5));
  }
}

describe("CodexBridge", () => {
  it("opens a topic only for enabled directories and skips helper threads", async () => {
    const t = setup([{ id: "t1", cwd: "/work/a", onDisk: true }, { id: "t2", cwd: "/work/a", parentThreadId: "t1" },
      { id: "t3", cwd: "/work/b", onDisk: true }]);
    await t.bridge.scan();
    expect(t.gateway.listSessions()).toEqual([{ cwd: "/work/a", threadId: 900 }]);
    expect(t.texts()).toEqual(["Codex 会话已接入。本话题对应目录 /work/a"]);
    expect(t.codex.calls.filter(c => c.method === "thread/resume").map(c => c.params.threadId)).toEqual(["t1"]);
    await t.bridge.scan();
    // The helper is read once, then remembered.
    expect(t.codex.calls.filter(c => c.method === "thread/read" && c.params.threadId === "t2")).toHaveLength(1);
  });

  it("sends a topic message as a turn and posts the final answer, steering while busy", async () => {
    const t = setup([{ id: "t1", cwd: "/work/a", onDisk: true }]);
    await t.bridge.scan();
    await t.say("修一下测试");
    await until(() => t.codex.methods().includes("turn/start"));
    expect(t.codex.calls.find(c => c.method === "turn/start")!.params).toEqual({ threadId: "t1",
      input: [{ type: "text", text: "修一下测试", text_elements: [] }] });
    await t.bridge.onNotification("turn/started", { threadId: "t1", turn: { id: "turn1" } });
    await t.say("顺便看看日志");
    await until(() => t.codex.methods().includes("turn/steer"));
    expect(t.codex.calls.find(c => c.method === "turn/steer")!.params.expectedTurnId).toBe("turn1");
    await t.bridge.onNotification("item/completed", { threadId: "t1", item: { type: "agentMessage", text: "先看看", phase: "commentary" } });
    await t.bridge.onNotification("item/completed", { threadId: "t1", item: { type: "agentMessage", text: "**已修复**", phase: "final_answer" } });
    await t.bridge.onNotification("turn/completed", { threadId: "t1", turn: { id: "turn1", status: "completed", items: [] } });
    expect(t.texts().at(-1)).toBe("<b>已修复</b>");
  });

  it("maps /stop, /compact and /usage, and refuses commands Codex lacks", async () => {
    const t = setup([{ id: "t1", cwd: "/work/a", onDisk: true }]);
    await t.bridge.scan();
    await t.say("/stop");
    await until(() => t.texts().includes("当前没有进行中的回合。"));
    await t.bridge.onNotification("turn/started", { threadId: "t1", turn: { id: "turn7" } });
    await t.say("/stop");
    await until(() => t.codex.methods().includes("turn/interrupt"));
    expect(t.codex.calls.find(c => c.method === "turn/interrupt")!.params).toEqual({ threadId: "t1", turnId: "turn7" });
    await t.bridge.onNotification("turn/completed", { threadId: "t1", turn: { id: "turn7", status: "interrupted", items: [] } });
    expect(t.texts().at(-1)).toBe("（已中断）");
    await t.say("/compact");
    await until(() => t.texts().includes("已开始压缩上下文。"));
    expect(t.codex.methods()).toContain("thread/compact/start");
    await t.say("/usage");
    await until(() => t.texts().some(s => s.startsWith("Codex 用量")));
    expect(t.texts().find(s => s.startsWith("Codex 用量"))).toContain("5 小时：已用 12%");
    await t.say("/clear");
    expect(t.texts().at(-1)).toBe("暂不支持这个命令。可用：/stop /compact /usage");
  });

  it("a brand-new thread (not on disk) still runs; the answer is read when it goes idle", async () => {
    const thread: Thread = { id: "t1", cwd: "/work/a", onDisk: false };
    const t = setup([thread]);
    await t.bridge.scan();
    await t.say("只回复 OK");
    await until(() => t.codex.methods().includes("turn/start"));
    t.codex.turns.t1 = [{ id: "turn1", status: "completed", items: [{ type: "agentMessage", text: "OK", phase: null }] }];
    thread.onDisk = true;
    await t.bridge.onNotification("thread/status/changed", { threadId: "t1", status: { type: "idle" } });
    expect(t.texts().at(-1)).toBe("OK");
    expect(t.codex.calls.filter(c => c.method === "thread/resume")).toHaveLength(2);
  });

  it("closes the session when the thread unloads, and follows a2t disable / enable", async () => {
    const threads: Thread[] = [{ id: "t1", cwd: "/work/a", onDisk: true }];
    const t = setup(threads);
    await t.bridge.scan();
    t.enabled.delete("/work/a");
    t.gateway.reap();
    expect(t.gateway.sessionCount).toBe(0);
    await t.bridge.scan();
    expect(t.gateway.sessionCount).toBe(0);
    t.enabled.add("/work/a");
    await t.bridge.scan();
    expect(t.gateway.sessionCount).toBe(1);
    threads.splice(0);
    await t.bridge.scan();
    expect(t.gateway.sessionCount).toBe(0);
    await t.say("还在吗");
    expect(t.texts().at(-1)).toContain("现在没有在线的 Codex 会话");
  });

  it("picks the final answer, else the last message", () => {
    expect(turnAnswer([{ type: "agentMessage", text: "a", phase: "final_answer" }, { type: "agentMessage", text: "b", phase: "commentary" }])).toBe("a");
    expect(turnAnswer([{ type: "agentMessage", text: "a", phase: null }, { type: "reasoning" }, { type: "agentMessage", text: "b", phase: null }])).toBe("b");
    expect(turnAnswer([])).toBe("");
  });
});

describe("connectCodex", () => {
  it("speaks JSON-RPC over a WebSocket on a Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-ws-"));
    const sock = join(dir, "s.sock");
    const { WebSocketServer } = createRequire(import.meta.url)("ws") as { WebSocketServer: new (o: object) => {
      on(e: "connection", cb: (ws: { on(e: "message", cb: (d: Buffer) => void): void; send(d: string): void }) => void): void; close(): void } };
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const seen: string[] = [];
    wss.on("connection", ws => ws.on("message", raw => {
      const m = JSON.parse(raw.toString()) as { id?: number; method: string };
      seen.push(m.method);
      if (m.method === "initialize") ws.send(JSON.stringify({ id: m.id, result: { userAgent: "x" } }));
      if (m.method === "thread/loaded/list") {
        ws.send(JSON.stringify({ method: "thread/closed", params: { threadId: "z" } }));
        ws.send(JSON.stringify({ id: m.id, result: { data: ["t1"] } }));
      }
      if (m.method === "bad") ws.send(JSON.stringify({ id: m.id, error: { code: -1, message: "nope" } }));
    }));
    await new Promise<void>(r => server.listen(sock, r));
    cleanups.push(() => { wss.close(); server.close(); rmSync(dir, { recursive: true, force: true }); });
    const rpc = await connectCodex(sock);
    const notes: string[] = [];
    rpc.onNotification(method => notes.push(method));
    expect(await rpc.call("thread/loaded/list", {})).toEqual({ data: ["t1"] });
    await expect(rpc.call("bad", {})).rejects.toThrow("nope");
    expect(seen.slice(0, 2)).toEqual(["initialize", "initialized"]);
    expect(notes).toEqual(["thread/closed"]);
    rpc.close();
    await rpc.closed;
  });

  it("fails fast when nothing listens", async () => {
    await expect(connectCodex(join(tmpdir(), "no-such-codex.sock"), 2_000)).rejects.toThrow("无法连接");
  });
});
