import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramConfig, TelegramUpdate } from "../../core/types.ts";
import { botKey, ClaudeGateway, SESSION_STALE_MS, type GatewayEvent } from "../gateway/gateway.ts";

const CHAT = -1001234567890;
const USER = 4242;
const TOKEN = "123456:abc";
type Button = { text: string; value: string };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function setup(initial: TelegramConfig = { botToken: TOKEN, forumChatId: CHAT, allowedUserId: USER },
  options: { dataDir?: string; alive?: (pid: number) => boolean } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "claude-gateway-"));
  if (!options.dataDir) dirs.push(dataDir);
  let config: TelegramConfig = { ...initial };
  let nextThread = 77;
  const sent: Array<{ chatId: number; text: string; threadId?: number }> = [];
  const buttons: Array<{ text: string; rows: Button[][]; threadId?: number }> = [];
  const api = vi.fn(async (method: string, _body: Record<string, unknown>) => {
    if (method === "createForumTopic") return { message_thread_id: nextThread++ };
    if (method === "setMyCommands") return true;
    throw new Error(`unexpected ${method}`);
  });
  const sendText = vi.fn(async (chatId: number, text: string, threadId?: number) => {
    sent.push({ chatId, text, threadId });
    return [{ message_id: sent.length }];
  });
  const sendChatAction = vi.fn(async () => undefined);
  const sendButtons = vi.fn(async (_chatId: number, text: string, rows: Button[][], threadId?: number) => {
    buttons.push({ text, rows, threadId });
    return { message_id: 500 + buttons.length };
  });
  const editText = vi.fn(async (_chatId: number, _messageId: number, _text: string) => undefined);
  const answerCallbackQuery = vi.fn(async (_id: string, _text?: string) => undefined);
  const startRestart = vi.fn();
  const gateway = new ClaudeGateway({
    dataDir,
    getConfig: () => config,
    api: api as never,
    transport: { sendText: sendText as never, sendChatAction, sendButtons: sendButtons as never, editText, answerCallbackQuery },
    savePairing: async next => { config = next; },
    startRestart,
    readArgv: () => ["/usr/bin/claude", "--permission-mode", "auto"],
    isPidAlive: options.alive ?? (() => true),
    typingIntervalMs: 1_000,
  });
  return { gateway, dataDir, sent, buttons, api, sendText, sendChatAction, editText, answerCallbackQuery, startRestart,
    getConfig: () => config };
}

function topicMessage(text: string, threadId = 77, from = USER): TelegramUpdate {
  return { update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: "supergroup" }, from: { id: from },
    message_thread_id: threadId, text } } as TelegramUpdate;
}

function tap(data: string, from = USER): TelegramUpdate {
  return { update_id: 3, callback_query: { id: "cb1", data, from: { id: from },
    message: { message_id: 501, chat: { id: CHAT, type: "supergroup" } } } } as TelegramUpdate;
}

async function events(gateway: ClaudeGateway, connId: string): Promise<GatewayEvent[]> {
  const reply = await gateway.poll(connId, 0);
  return "events" in reply ? reply.events.filter(e => e.type !== "log") : [];
}

describe("ClaudeGateway sessions and topics", () => {
  it("gives each directory its own topic and keeps it across gateway restarts", async () => {
    const t = setup();
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(await t.gateway.open({ connId: "b", cwd: "/work/beta" })).toMatchObject({ ok: true, threadId: 78 });
    expect(t.api).toHaveBeenCalledWith("createForumTopic", { chat_id: CHAT, name: "alpha" });
    const stored = JSON.parse(readFileSync(join(t.dataDir, "runtime", "topics.json"), "utf8"));
    expect(Object.keys(stored.topics)).toContain(JSON.stringify([botKey(TOKEN), CHAT, "/work/alpha"]));

    const restarted = setup(undefined, { dataDir: t.dataDir });
    expect(await restarted.gateway.open({ connId: "a2", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(restarted.api).not.toHaveBeenCalled();
  });

  it("asks for pairing and makes no topic before a user is paired", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT, pairingCode: "123456", pairingCodeExpiresAt: Date.now() + 60_000 });
    const result = await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.notices.join()).toContain("/pair 123456");
    expect(t.api).not.toHaveBeenCalled();
  });

  it("pairs in a private chat with the code, then gives the open sessions their topics", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT, pairingCode: "123456", pairingCodeExpiresAt: Date.now() + 60_000 });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate({ update_id: 2, message: { message_id: 1, chat: { id: USER, type: "private" },
      from: { id: USER }, text: "/pair 123456" } } as TelegramUpdate);
    expect(t.getConfig().allowedUserId).toBe(USER);
    await t.gateway.handleUpdate(topicMessage("hello"));
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "hello" }]);
  });

  it("refuses /pair in a group", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT, pairingCode: "123456", pairingCodeExpiresAt: Date.now() + 60_000 });
    await t.gateway.handleUpdate(topicMessage("/pair 123456"));
    expect(t.getConfig().allowedUserId).toBeUndefined();
  });

  it("allows one live session per directory", async () => {
    const live = new Set([100, 200]);
    const t = setup(undefined, { alive: pid => live.has(pid) });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha", pid: 100, claudeSessionId: "s1" });
    expect(await t.gateway.open({ connId: "b", cwd: "/work/alpha", pid: 200, claudeSessionId: "s2" }))
      .toMatchObject({ ok: false });
    // The same Claude session (a module reload or /restart) takes over its own topic.
    expect(await t.gateway.open({ connId: "a2", cwd: "/work/alpha", pid: 300, claudeSessionId: "s1" })).toMatchObject({ ok: true });
    expect(await t.gateway.poll("a", 0)).toEqual({ unknown: true });
    // A session whose process died is replaced.
    live.delete(300);
    expect(await t.gateway.open({ connId: "b", cwd: "/work/alpha", pid: 200, claudeSessionId: "s2" })).toMatchObject({ ok: true });
  });

  it("routes each topic's text to its own session", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.open({ connId: "b", cwd: "/work/beta" });
    await t.gateway.handleUpdate(topicMessage("for alpha", 77));
    await t.gateway.handleUpdate(topicMessage("for beta", 78));
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "for alpha" }]);
    expect(await events(t.gateway, "b")).toEqual([{ type: "prompt", text: "for beta" }]);
  });

  it("says so when a known topic has no session online", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    await t.gateway.handleUpdate(topicMessage("anyone?"));
    expect(t.sent.at(-1)?.text).toContain("/work/alpha");
    expect(t.sent.at(-1)?.threadId).toBe(77);
  });

  it("ignores other users and other chats", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(topicMessage("hi", 77, 1));
    await t.gateway.handleUpdate({ ...topicMessage("hi"), message: { ...topicMessage("hi").message!, chat: { id: -100999, type: "supergroup" } } });
    expect(await events(t.gateway, "a")).toEqual([]);
  });

  it("hands queued events to a waiting poll at once", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.poll("a", 0); // the "topic created" notice
    const waiting = t.gateway.poll("a", 10_000);
    await t.gateway.handleUpdate(topicMessage("now"));
    expect(await waiting).toEqual({ events: [{ type: "prompt", text: "now" }] });
  });

  it("drops a session whose Claude Code process is gone", async () => {
    const live = new Set([100]);
    const t = setup(undefined, { alive: pid => live.has(pid) });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha", pid: 100 });
    t.gateway.reap();
    expect(t.gateway.sessionCount).toBe(1);
    live.delete(100);
    t.gateway.reap();
    expect(t.gateway.sessionCount).toBe(0);
  });

  it("drops a session that stopped polling", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    vi.advanceTimersByTime(SESSION_STALE_MS + 1);
    t.gateway.reap();
    expect(t.gateway.sessionCount).toBe(0);
    expect(await t.gateway.poll("a", 0)).toEqual({ unknown: true });
  });
});

describe("ClaudeGateway commands", () => {
  it("turns /stop /compact /clear /usage into events and answers the rest with a notice", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    for (const text of ["/stop", "/stop@demo_bot", "/compact", "/clear", "/usage", "/model"]) await t.gateway.handleUpdate(topicMessage(text));
    expect(await events(t.gateway, "a")).toEqual([
      { type: "abort" }, { type: "abort" }, { type: "command", name: "compact" }, { type: "command", name: "clear" }, { type: "usage" }]);
    expect(t.sent.at(-1)?.text).toContain("/restart");
  });

  it("registers the / menu for the forum group only", async () => {
    const t = setup();
    await t.gateway.registerCommands();
    expect(t.api).toHaveBeenCalledWith("setMyCommands", expect.objectContaining({ scope: { type: "chat", chat_id: CHAT } }));
    const commands = (t.api.mock.calls[0]![1] as { commands: Array<{ command: string }> }).commands.map(c => c.command);
    expect(commands).toEqual(["stop", "compact", "clear", "usage", "restart"]);
  });

  it("/restart only for a session in tmux; the helper keeps the old flags; reopening says restarted", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha", pid: 100 });
    await t.gateway.handleUpdate(topicMessage("/restart"));
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.at(-1)?.text).toContain("tmux");

    await t.gateway.open({ connId: "b", cwd: "/work/beta", pid: 200, pane: "%3", modDir: "/m", claudeSessionId: "s9" });
    await t.gateway.handleUpdate(topicMessage("/restart", 78));
    expect(await events(t.gateway, "b")).toEqual([{ type: "restart" }]);
    expect(await t.gateway.prepareRestart("b", "s9")).toBe(true);
    expect(t.startRestart).toHaveBeenCalledWith({ pid: 200, pane: "%3", cwd: "/work/beta", modDir: "/m", sessionId: "s9",
      argv: ["/usr/bin/claude", "--permission-mode", "auto"] });
    expect(t.sent.at(-1)?.text).toContain("正在重启");
    await t.gateway.open({ connId: "b2", cwd: "/work/beta", pid: 201, pane: "%3", modDir: "/m", claudeSessionId: "s9" });
    expect(t.sent.at(-1)?.text).toContain("已重启");
  });
});

describe("ClaudeGateway answers", () => {
  it("sends the final answer as HTML to the session's topic and stops typing", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.turnStarted("a");
    vi.advanceTimersByTime(2_500);
    expect(t.sendChatAction).toHaveBeenCalledTimes(3);
    await t.gateway.turnCompleted("a", "**done**", false);
    vi.advanceTimersByTime(5_000);
    expect(t.sendChatAction).toHaveBeenCalledTimes(3);
    expect(t.sent).toEqual([{ chatId: CHAT, text: "<b>done</b>", threadId: 77 }]);
  });

  it("says so when an aborted turn has no text", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.turnCompleted("a", "", true);
    expect(t.sent[0]?.text).toBe("（已中断）");
  });

  it("recreates a deleted topic and resends there once", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.sendText.mockRejectedValueOnce(new Error("Bad Request: message thread not found"));
    await t.gateway.turnCompleted("a", "hello", false);
    expect(t.sent).toEqual([{ chatId: CHAT, text: "hello", threadId: 78 }]);
    await t.gateway.handleUpdate(topicMessage("again", 78));
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "again" }]);
  });
});

describe("ClaudeGateway buttons", () => {
  async function withPrompt(labels = ["✅ 允许", "❌ 拒绝"], textLabel?: string) {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    expect(await t.gateway.openPrompt("a", "p1", "Claude 请求使用 Bash", "rm -rf <build>", labels, textLabel)).toBe(true);
    return t;
  }

  it("shows escaped buttons in the session's topic, and a tap answers a waiting call", async () => {
    const t = await withPrompt();
    expect(t.buttons[0]).toMatchObject({ threadId: 77, rows: [[{ text: "✅ 允许", value: "p:p1:0" }], [{ text: "❌ 拒绝", value: "p:p1:1" }]] });
    expect(t.buttons[0]!.text).toContain("&lt;build&gt;");
    const waiting = t.gateway.wait("p1", 10_000);
    await t.gateway.handleUpdate(tap("p:p1:1"));
    expect(await waiting).toEqual({ answer: "❌ 拒绝" });
    expect(t.editText.mock.calls[0]![2]).toContain("→ ❌ 拒绝");
  });

  it("keeps a tap that arrives between two waits", async () => {
    const t = await withPrompt(["Tea", "Coffee"]);
    await t.gateway.handleUpdate(tap("p:p1:0"));
    expect(await t.gateway.wait("p1", 10_000)).toEqual({ answer: "Tea" });
  });

  it("ignores taps from other users and second taps", async () => {
    const t = await withPrompt(["Yes", "No"]);
    await t.gateway.handleUpdate(tap("p:p1:0", 999));
    await t.gateway.handleUpdate(tap("p:p1:1"));
    await t.gateway.handleUpdate(tap("p:p1:0"));
    expect(await t.gateway.wait("p1", 10_000)).toEqual({ answer: "No" });
  });

  it("takes the buttons back when the terminal answers first", async () => {
    const t = await withPrompt();
    const waiting = t.gateway.wait("p1", 10_000);
    await t.gateway.resolveElsewhere("p1");
    expect(await waiting).toEqual({ cancelled: true });
    expect(t.editText.mock.calls[0]![2]).toContain("已在终端处理");
    await t.gateway.handleUpdate(tap("p:p1:0"));
    expect(t.answerCallbackQuery).toHaveBeenLastCalledWith("cb1", "已处理");
  });

  it("takes a session's buttons back when it goes away", async () => {
    const t = await withPrompt();
    t.gateway.close("a");
    await vi.waitFor(() => expect(t.editText).toHaveBeenCalled());
    expect(t.editText.mock.calls[0]![2]).toContain("已在终端处理");
  });

  it("returns pending when nobody answers in time", async () => {
    vi.useFakeTimers();
    const t = await withPrompt();
    const waiting = t.gateway.wait("p1", 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await waiting).toEqual({ pending: true });
  });

  it("takes the next topic text as the answer after the custom-input button; commands still work", async () => {
    const t = await withPrompt(["是", "否", "✏️ 自定义输入"], "✏️ 自定义输入");
    const waiting = t.gateway.wait("p1", 10_000);
    await t.gateway.handleUpdate(tap("p:p1:2"));
    expect(t.editText.mock.calls[0]![2]).toContain("请直接在话题里发送你的回答");
    await t.gateway.handleUpdate(topicMessage("/usage"));
    await t.gateway.handleUpdate(topicMessage("看情况再说"));
    expect(await waiting).toEqual({ answer: "看情况再说" });
    await t.gateway.handleUpdate(topicMessage("next task"));
    expect(await events(t.gateway, "a")).toEqual([{ type: "usage" }, { type: "prompt", text: "next task" }]);
  });

  it("does not show buttons without a topic or for an unknown session", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    expect(await t.gateway.openPrompt("a", "p1", "Q", "", ["Yes", "No"])).toBe(false);
    expect(await t.gateway.openPrompt("zzz", "p2", "Q", "", ["Yes", "No"])).toBe(false);
    expect(t.buttons).toEqual([]);
  });
});
