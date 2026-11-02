import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "../../core/types.ts";
import { GatewayClient, type GatewayState } from "../gateway-client.ts";

type Reply = Record<string, unknown> | undefined;

/** A scripted gateway: each request takes the next reply for its path; the loop ends when a script runs dry. */
function setup(script: Record<string, Reply[]>) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const states: GatewayState[] = [];
  const notices: string[] = [];
  const updates: TelegramUpdate[] = [];
  let client!: GatewayClient;
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  client = new GatewayClient({
    socketPath: "/x.sock", connId: "c1",
    onUpdate: async update => { updates.push(update); },
    onState: state => states.push(state),
    onNotice: text => notices.push(text),
    sleep: async () => undefined,
    post: async (path, body) => {
      requests.push({ path, body });
      const queue = script[path] ?? [];
      if (queue.length === 0) { void client.stop(); finished(); return path === "/close" ? {} : undefined; }
      return queue.shift();
    },
  });
  return { client, requests, states, notices, updates, done };
}

const update = (text: string) => ({ update_id: 1, message: { message_id: 1, chat: { id: -1, type: "supergroup" }, text } }) as TelegramUpdate;

describe("Pi's gateway client", () => {
  it("connects, hands over raw updates, and reports its button messages with the next poll", async () => {
    const t = setup({ "/open": [{ ok: true, threadId: 11, notices: [] }],
      "/poll": [{ events: [{ type: "update", update: update("hi") }] }, { events: [] }] });
    t.client.start({ cwd: "/w", pid: 1 });
    t.client.rememberButton(55);
    await t.done;
    expect(t.states).toContainEqual({ kind: "connected", threadId: 11 });
    expect(t.updates.map(u => u.message?.text)).toEqual(["hi"]);
    const polls = t.requests.filter(r => r.path === "/poll");
    expect(polls[0]!.body).toMatchObject({ connId: "c1", messageIds: [55] });
    expect(polls[1]!.body).toMatchObject({ messageIds: [] });
  });

  it("registers again when the gateway restarted and no longer knows it", async () => {
    const t = setup({ "/open": [{ ok: true, threadId: 11 }, { ok: true, threadId: 11 }], "/poll": [{ unknown: true }] });
    t.client.start({ cwd: "/w", pid: 1 });
    await t.done;
    expect(t.requests.filter(r => r.path === "/open")).toHaveLength(2);
  });

  it("says the gateway is not running, once, and keeps trying", async () => {
    const t = setup({ "/open": [undefined, undefined, { ok: false, reason: "此目录已有另一个 Pi 会话接入 Telegram" }] });
    t.client.start({ cwd: "/w", pid: 1 });
    await t.done;
    const waiting = t.states.filter(s => s.kind === "waiting");
    expect(waiting.map(s => s.kind === "waiting" && s.reason)).toEqual(["Telegram 网关未运行（a2t status）。", "此目录已有另一个 Pi 会话接入 Telegram"]);
  });

  it("shows the pairing instructions while the Bot is not paired", async () => {
    const t = setup({ "/open": [{ ok: true, notices: ["Telegram pairing required … /pair 123456"] }] });
    t.client.start({ cwd: "/w", pid: 1 });
    await t.done;
    expect(t.notices).toEqual(["Telegram pairing required … /pair 123456"]);
  });

  it("says goodbye on stop", async () => {
    const t = setup({ "/open": [{ ok: true, threadId: 11 }], "/poll": [] });
    t.client.start({ cwd: "/w", pid: 1 });
    await t.done;
    await vi.waitFor(() => expect(t.requests.some(r => r.path === "/close")).toBe(true));
  });
});
