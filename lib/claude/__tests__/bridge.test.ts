import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramConfig, TelegramUpdate } from "../../core/types.ts";
import { botKey, ClaudeTelegramBridge, type BridgeEvent } from "../sidecar/bridge.ts";

const CHAT = -1001234567890;
const USER = 4242;
const TOKEN = "123456:abc";

function setup(initial: TelegramConfig = { botToken: TOKEN, forumChatId: CHAT, allowedUserId: USER }, canRestart = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "claude-bridge-"));
  let config: TelegramConfig = { ...initial };
  const events: BridgeEvent[] = [];
  const sent: Array<{ chatId: number; text: string; threadId?: number }> = [];
  const api = vi.fn(async (method: string, _body: Record<string, unknown>) => {
    if (method === "createForumTopic") return { message_thread_id: 77 };
    throw new Error(`unexpected ${method}`);
  });
  const sendText = vi.fn(async (chatId: number, text: string, threadId?: number) => {
    sent.push({ chatId, text, threadId });
    return [{ message_id: sent.length }];
  });
  const sendChatAction = vi.fn(async () => undefined);
  const buttons: Array<{ chatId: number; text: string; rows: Array<Array<{ text: string; value: string }>>; threadId?: number }> = [];
  const sendButtons = vi.fn(async (chatId: number, text: string, rows: Array<Array<{ text: string; value: string }>>, threadId?: number) => {
    buttons.push({ chatId, text, rows, threadId });
    return { message_id: 500 + buttons.length };
  });
  const editText = vi.fn(async (_chatId: number, _messageId: number, _text: string) => undefined);
  const answerCallbackQuery = vi.fn(async (_id: string, _text?: string) => undefined);
  const savePairing = vi.fn(async (next: TelegramConfig) => { config = next; });
  const bridge = new ClaudeTelegramBridge({
    cwd: "/work/demo", dataDir,
    getConfig: () => config,
    api: api as never,
    transport: { sendText: sendText as never, sendChatAction, sendButtons: sendButtons as never, editText, answerCallbackQuery },
    emit: event => events.push(event),
    savePairing,
    typingIntervalMs: 1_000,
    canRestart: () => canRestart,
  });
  return { bridge, dataDir, events, sent, api, sendText, sendChatAction, savePairing, buttons, editText, answerCallbackQuery,
    getConfig: () => config };
}

function topicMessage(text: string, overrides: Partial<NonNullable<TelegramUpdate["message"]>> = {}): TelegramUpdate {
  return { update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: "supergroup" }, from: { id: USER },
    message_thread_id: 77, text, ...overrides } as TelegramUpdate["message"] };
}

describe("ClaudeTelegramBridge", () => {
  let dirs: string[] = [];
  beforeEach(() => { dirs = []; });
  afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

  it("creates the directory's topic once and reuses it", async () => {
    const t = setup(); dirs.push(t.dataDir);
    expect(await t.bridge.ensureTopic()).toBe(77);
    expect(t.api).toHaveBeenCalledWith("createForumTopic", { chat_id: CHAT, name: "demo" });
    const stored = JSON.parse(readFileSync(join(t.dataDir, "runtime", "topics.json"), "utf8"));
    expect(Object.keys(stored.topics)).toEqual([JSON.stringify([botKey(TOKEN), CHAT, "/work/demo"])]);

    const again = setup(); dirs.push(again.dataDir);
    // Same data dir → no second createForumTopic.
    const reuse = new ClaudeTelegramBridge({
      cwd: "/work/demo", dataDir: t.dataDir, getConfig: t.getConfig, api: again.api as never,
      transport: { sendText: again.sendText as never, sendChatAction: again.sendChatAction, sendButtons: vi.fn() as never,
        editText: vi.fn(), answerCallbackQuery: vi.fn() },
      emit: () => undefined, savePairing: again.savePairing });
    expect(await reuse.ensureTopic()).toBe(77);
    expect(again.api).not.toHaveBeenCalled();
  });

  it("does not create a topic before a user is paired", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT }); dirs.push(t.dataDir);
    expect(await t.bridge.ensureTopic()).toBeUndefined();
    expect(t.api).not.toHaveBeenCalled();
  });

  it("turns topic text into a prompt and /stop into an abort", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.handleUpdate(topicMessage("  fix the tests  "));
    await t.bridge.handleUpdate(topicMessage("/stop"));
    await t.bridge.handleUpdate(topicMessage("/stop@demo_bot"));
    expect(t.events.filter(e => e.type !== "log")).toEqual([{ type: "prompt", text: "fix the tests" }, { type: "abort" }, { type: "abort" }]);
  });

  it("ignores other users, other topics and other chats", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.handleUpdate(topicMessage("hi", { from: { id: 1 } }));
    await t.bridge.handleUpdate(topicMessage("hi", { message_thread_id: 78 }));
    await t.bridge.handleUpdate(topicMessage("hi", { chat: { id: -100999, type: "supergroup" } }));
    expect(t.events.filter(e => e.type !== "log")).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("answers other commands with a notice instead of forwarding them", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.handleUpdate(topicMessage("/model"));
    expect(t.sent[0]?.text).toContain("/usage");
    expect(t.events.filter(e => e.type !== "log")).toEqual([]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ chatId: CHAT, threadId: 77 });
  });

  it("pairs in a private chat with the code, then creates the topic", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT, pairingCode: "123456", pairingCodeExpiresAt: Date.now() + 60_000 });
    dirs.push(t.dataDir);
    await t.bridge.handleUpdate({ update_id: 2, message: { message_id: 1, chat: { id: USER, type: "private" }, from: { id: USER }, text: "/pair 123456" } as TelegramUpdate["message"] });
    expect(t.getConfig().allowedUserId).toBe(USER);
    expect(t.getConfig().pairingCode).toBeUndefined();
    expect(t.bridge.threadId).toBe(77);
  });

  it("refuses /pair in a group", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT, pairingCode: "123456", pairingCodeExpiresAt: Date.now() + 60_000 });
    dirs.push(t.dataDir);
    await t.bridge.handleUpdate(topicMessage("/pair 123456"));
    expect(t.getConfig().allowedUserId).toBeUndefined();
  });

  it("sends the final answer as HTML to the topic and stops typing", async () => {
    vi.useFakeTimers();
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    t.bridge.turnStarted();
    expect(t.sendChatAction).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_500);
    expect(t.sendChatAction).toHaveBeenCalledTimes(3);
    await t.bridge.turnCompleted("**done**", false);
    vi.advanceTimersByTime(5_000);
    expect(t.sendChatAction).toHaveBeenCalledTimes(3);
    expect(t.sent).toEqual([{ chatId: CHAT, text: "<b>done</b>", threadId: 77 }]);
  });

  it("says so when an aborted turn has no text", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.turnCompleted("", true);
    expect(t.sent[0]?.text).toBe("（已中断）");
  });

  it("recreates a deleted topic and resends there once", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    t.sendText.mockRejectedValueOnce(new Error("Bad Request: message thread not found"));
    t.api.mockImplementationOnce(async () => ({ message_thread_id: 90 }));
    await t.bridge.turnCompleted("hello", false);
    expect(t.bridge.threadId).toBe(90);
    expect(t.sent).toEqual([{ chatId: CHAT, text: "hello", threadId: 90 }]);
  });

  it("forwards /compact, /clear and /usage to the mod", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    for (const text of ["/compact", "/clear", "/usage"]) await t.bridge.handleUpdate(topicMessage(text));
    expect(t.events.filter(e => e.type !== "log")).toEqual([
      { type: "command", name: "compact" }, { type: "command", name: "clear" }, { type: "usage" }]);
  });

  it("registers the / menu for the forum group only", async () => {
    const t = setup(); dirs.push(t.dataDir);
    t.api.mockImplementationOnce(async () => true as never);
    await t.bridge.registerCommands();
    expect(t.api).toHaveBeenCalledWith("setMyCommands", expect.objectContaining({ scope: { type: "chat", chat_id: CHAT } }));
    const commands = (t.api.mock.calls[0]![1] as { commands: Array<{ command: string }> }).commands.map(c => c.command);
    expect(commands).toEqual(["stop", "compact", "clear", "usage", "restart"]);
  });

  function tap(data: string, from = USER): TelegramUpdate {
    return { update_id: 3, callback_query: { id: "cb1", data, from: { id: from },
      message: { message_id: 501, chat: { id: CHAT, type: "supergroup" } } } } as TelegramUpdate;
  }

  it("shows buttons, and a tap answers a waiting call", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    expect(await t.bridge.openPrompt("a1", "Claude 请求使用 Bash", "rm -rf <build>", ["✅ 允许", "❌ 拒绝"])).toBe(true);
    expect(t.buttons[0]).toMatchObject({ chatId: CHAT, threadId: 77,
      rows: [[{ text: "✅ 允许", value: "p:a1:0" }], [{ text: "❌ 拒绝", value: "p:a1:1" }]] });
    expect(t.buttons[0]!.text).toContain("&lt;build&gt;");
    const waiting = t.bridge.wait("a1", 10_000);
    await t.bridge.handleUpdate(tap("p:a1:1"));
    expect(await waiting).toEqual({ answer: "❌ 拒绝" });
    expect(t.editText.mock.calls[0]![2]).toContain("→ ❌ 拒绝");
  });

  it("keeps a tap that arrives between two waits", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.openPrompt("a2", "Q", "", ["Tea", "Coffee"]);
    await t.bridge.handleUpdate(tap("p:a2:0"));
    expect(await t.bridge.wait("a2", 10_000)).toEqual({ answer: "Tea" });
  });

  it("ignores taps from other users and second taps", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.openPrompt("a3", "Q", "", ["Yes", "No"]);
    await t.bridge.handleUpdate(tap("p:a3:0", 999));
    await t.bridge.handleUpdate(tap("p:a3:1"));
    await t.bridge.handleUpdate(tap("p:a3:0"));
    expect(await t.bridge.wait("a3", 10_000)).toEqual({ answer: "No" });
  });

  it("takes the buttons back when the terminal answers first", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.openPrompt("a4", "Claude 请求使用 Bash", "ls", ["✅ 允许", "❌ 拒绝"]);
    const waiting = t.bridge.wait("a4", 10_000);
    await t.bridge.resolveElsewhere("a4");
    expect(await waiting).toEqual({ cancelled: true });
    expect(t.editText.mock.calls[0]![2]).toContain("已在终端处理");
    await t.bridge.handleUpdate(tap("p:a4:0"));
    expect(t.answerCallbackQuery).toHaveBeenLastCalledWith("cb1", "已处理");
  });

  it("returns pending when nobody answers in time", async () => {
    vi.useFakeTimers();
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.openPrompt("a5", "Q", "", ["Yes", "No"]);
    const waiting = t.bridge.wait("a5", 1_000);
    vi.advanceTimersByTime(1_000);
    expect(await waiting).toEqual({ pending: true });
  });

  it("does not show buttons without a topic", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT }); dirs.push(t.dataDir);
    expect(await t.bridge.openPrompt("a6", "Q", "", ["Yes", "No"])).toBe(false);
    expect(t.buttons).toEqual([]);
  });

  it("takes the next topic text as the answer after the custom-input button", async () => {
    const t = setup(); dirs.push(t.dataDir);
    await t.bridge.ensureTopic();
    await t.bridge.openPrompt("c1", "Q", "", ["是", "否", "✏️ 自定义输入"], "✏️ 自定义输入");
    const waiting = t.bridge.wait("c1", 10_000);
    await t.bridge.handleUpdate(tap("p:c1:2"));
    expect(t.editText.mock.calls[0]![2]).toContain("请直接在话题里发送你的回答");
    await t.bridge.handleUpdate(topicMessage("/usage"));
    await t.bridge.handleUpdate(topicMessage("看情况再说"));
    expect(await waiting).toEqual({ answer: "看情况再说" });
    expect(t.events.filter(e => e.type !== "log")).toEqual([{ type: "usage" }]);
    await t.bridge.handleUpdate(topicMessage("next task"));
    expect(t.events.filter(e => e.type !== "log")).toEqual([{ type: "usage" }, { type: "prompt", text: "next task" }]);
  });

  it("/restart asks the mod to restart only inside tmux", async () => {
    const outside = setup(); dirs.push(outside.dataDir);
    await outside.bridge.ensureTopic();
    await outside.bridge.handleUpdate(topicMessage("/restart"));
    expect(outside.events.filter(e => e.type !== "log")).toEqual([]);
    expect(outside.sent[0]?.text).toContain("tmux");

    const inside = setup(undefined, true); dirs.push(inside.dataDir);
    await inside.bridge.ensureTopic();
    await inside.bridge.handleUpdate(topicMessage("/restart"));
    expect(inside.events.filter(e => e.type !== "log")).toEqual([{ type: "restart" }]);
  });
});
