import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FORUM_BINDING_TYPE } from "../../core/forum-binding.ts";
import type { TelegramConfig, TelegramUpdate } from "../../core/types.ts";
import type { GatewayClientDeps, GatewayOpen } from "../gateway-client.ts";
import { ForumSession, forumBotId, forumTopicName, type ForumDelivery } from "../forum-session.ts";

const TOKEN = "123456:fake";
const CHAT = -1001234567890;

type Fake = { deps: GatewayClientDeps; open?: GatewayOpen; stopped: boolean; buttons: number[] };

function setup(initial: TelegramConfig = { botToken: TOKEN, forumChatId: CHAT, allowedUserId: 7 }) {
  let config: TelegramConfig = { ...initial };
  const clients: Fake[] = [];
  const delivered: ForumDelivery[] = [];
  const onChange = vi.fn();
  const forum = new ForumSession({
    pi: { appendEntry: vi.fn() },
    getConfig: () => config,
    socketPath: () => "/tmp/a2t-test/gateway.sock",
    onChange, onError: vi.fn(),
    onUpdate: async delivery => { delivered.push(delivery); expect(forum.hasRemoteOperation).toBe(true); },
    createClient: deps => {
      const fake: Fake = { deps, stopped: false, buttons: [] };
      clients.push(fake);
      return {
        start: (open: GatewayOpen) => { fake.open = open; },
        stop: async () => { fake.stopped = true; },
        rememberButton: (id: number) => { fake.buttons.push(id); },
        listSessions: async () => [],
      };
    },
  });
  const ctx = (sessionId = "s1", entries: unknown[] = []) => ({ cwd: "/work/alpha",
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } }) as never;
  return { forum, clients, delivered, onChange, ctx, setConfig: (next: TelegramConfig) => { config = next; } };
}

const update = (text: string): TelegramUpdate => ({ update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: "supergroup" },
  from: { id: 7 }, message_thread_id: 11, text } } as TelegramUpdate);

describe("ForumSession over the agent2telegram gateway", () => {
  it("registers its directory, session and process, and is sendable only once the gateway gave it a topic", async () => {
    const t = setup();
    await t.forum.prepare(t.ctx());
    expect(t.clients).toHaveLength(1);
    expect(t.clients[0]!.deps.socketPath).toBe("/tmp/a2t-test/gateway.sock");
    expect(t.clients[0]!.open).toMatchObject({ cwd: "/work/alpha", claudeSessionId: "s1", pid: process.pid });
    expect(t.forum.getTarget()).toBeUndefined();
    t.clients[0]!.deps.onState({ kind: "connected", threadId: 11 });
    expect(t.forum.getTarget()).toMatchObject({ botId: forumBotId(TOKEN), chatId: CHAT, sessionId: "s1", threadId: 11 });
    expect(t.forum.lease()).toMatch(/^forum:.+:11$/);
    expect(t.onChange).toHaveBeenCalled();
  });

  it("opens one connection when two syncs prepare at once", async () => {
    const t = setup();
    await Promise.all([t.forum.prepare(t.ctx()), t.forum.prepare(t.ctx())]);
    expect(t.clients.filter(c => !c.stopped)).toHaveLength(1);
    expect(t.clients).toHaveLength(1);
  });

  it("stops being sendable and says why when the gateway drops it", async () => {
    const t = setup();
    await t.forum.prepare(t.ctx());
    t.clients[0]!.deps.onState({ kind: "connected", threadId: 11 });
    t.clients[0]!.deps.onState({ kind: "waiting", reason: "Telegram 网关未运行（a2t status）。" });
    expect(t.forum.getTarget()).toBeUndefined();
    expect(t.forum.lastError).toContain("网关未运行");
  });

  it("hands the topic's updates to Pi under its target, and ignores an older connection's", async () => {
    const t = setup();
    await t.forum.prepare(t.ctx("s1"));
    t.clients[0]!.deps.onState({ kind: "connected", threadId: 11 });
    await t.clients[0]!.deps.onUpdate(update("hello"));
    expect(t.delivered.map(d => [d.target.threadId, d.update.message?.text])).toEqual([[11, "hello"]]);
    await t.forum.prepare(t.ctx("s2")); // /new: a new session, a new connection
    expect(t.clients[0]!.stopped).toBe(true);
    t.clients[1]!.deps.onState({ kind: "connected", threadId: 11 });
    await t.clients[0]!.deps.onUpdate(update("stale"));
    expect(t.delivered).toHaveLength(1);
  });

  it("reports its button messages to the gateway and owns what it sent", async () => {
    const t = setup();
    await t.forum.prepare(t.ctx());
    t.clients[0]!.deps.onState({ kind: "connected", threadId: 11 });
    t.forum.rememberMessage(40);
    t.forum.rememberMessage(41, true);
    expect(t.clients[0]!.buttons).toEqual([41]);
    expect(t.forum.ownsMessage(40)).toBe(true);
    expect(t.forum.ownsMessage(99)).toBe(false);
  });

  it("seeds the gateway with the topic a pre-gateway session recorded", async () => {
    const t = setup();
    const entries = [{ type: "custom", customType: FORUM_BINDING_TYPE,
      data: { version: 1, botId: forumBotId(TOKEN), chatId: CHAT, sessionId: "s1", threadId: 135 } }];
    await t.forum.prepare(t.ctx("s1", entries));
    expect(t.clients[0]!.open?.legacyThreadId).toBe(135);
  });

  it("reconnects when the Bot or group changes, but not when a user gets paired", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT });
    await t.forum.prepare(t.ctx());
    t.setConfig({ botToken: TOKEN, forumChatId: CHAT, allowedUserId: 7 });
    await t.forum.prepare(t.ctx());
    expect(t.clients).toHaveLength(1);
    t.setConfig({ botToken: TOKEN, forumChatId: -1009999999999, allowedUserId: 7 });
    await t.forum.prepare(t.ctx());
    expect(t.clients).toHaveLength(2);
    expect(t.clients[0]!.stopped).toBe(true);
  });

  it("does not connect without a forum group, when disabled, or without a Bot", async () => {
    const plain = setup({ botToken: TOKEN });
    await plain.forum.prepare(plain.ctx());
    expect(plain.clients).toHaveLength(0);
    const off = setup({ botToken: TOKEN, forumChatId: CHAT, telegramEnabled: false });
    await off.forum.prepare(off.ctx());
    expect(off.clients).toHaveLength(0);
    const noBot = setup({ forumChatId: CHAT });
    await noBot.forum.prepare(noBot.ctx());
    expect(noBot.clients).toHaveLength(0);
    expect(noBot.forum.lastError).toContain("a2t setup pi");
  });

  it("says goodbye on close", async () => {
    const t = setup();
    await t.forum.prepare(t.ctx());
    await t.forum.close();
    expect(t.clients[0]!.stopped).toBe(true);
    expect(t.forum.getTarget()).toBeUndefined();
  });

  it("names topics by home-relative directory", () => {
    expect(forumTopicName(join(homedir(), "pi-main"))).toBe("pi-main");
    expect(forumTopicName(join(homedir(), "work", "tmp"))).toBe(join("work", "tmp"));
    expect(forumTopicName(homedir())).toBe("~");
    expect(forumTopicName("/srv/app")).toBe("/srv/app");
  });
});
