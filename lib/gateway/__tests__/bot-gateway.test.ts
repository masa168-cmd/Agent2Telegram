import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelegramConfig, TelegramUpdate } from "../../core/types.ts";
import { botKey, BotGateway, SESSION_STALE_MS, type GatewayEvent } from "../bot-gateway.ts";

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
  options: { dataDir?: string; alive?: (pid: number) => boolean; isEnabled?: (cwd: string) => boolean;
    rich?: boolean; topicsPath?: string } = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "claude-gateway-"));
  if (!options.dataDir) dirs.push(dataDir);
  let config: TelegramConfig = { ...initial };
  let nextThread = 77;
  // Telegram's answer to reopenForumTopic for an existing topic: open by default.
  let reopenError: string | undefined = "Bad Request: TOPIC_NOT_MODIFIED";
  const sent: Array<{ chatId: number; text: string; threadId?: number }> = [];
  const buttons: Array<{ text: string; rows: Button[][]; threadId?: number }> = [];
  const api = vi.fn(async (method: string, _body: Record<string, unknown>) => {
    if (method === "createForumTopic") return { message_thread_id: nextThread++ };
    if (method === "setMyCommands") return true;
    if (method === "reopenForumTopic") { if (reopenError) throw new Error(reopenError); return true; }
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
  const gateway = new BotGateway({
    dataDir,
    getConfig: () => config,
    api: api as never,
    transport: { sendText: sendText as never, sendChatAction, sendButtons: sendButtons as never, editText, answerCallbackQuery },
    startRestart,
    readArgv: () => ["/usr/bin/claude", "--permission-mode", "auto"],
    isPidAlive: options.alive ?? (() => true),
    ...(options.isEnabled ? { isEnabled: options.isEnabled } : {}),
    ...(options.rich ? { mode: "rich" as const, agentLabel: "Pi" } : {}),
    ...(options.topicsPath ? { topicsPath: options.topicsPath } : {}),
    typingIntervalMs: 1_000,
  });
  return { gateway, dataDir, sent, buttons, api, sendText, sendChatAction, editText, answerCallbackQuery, startRestart,
    getConfig: () => config, setReopenError: (text: string | undefined) => { reopenError = text; } };
}

function topicMessage(text: string, threadId = 77, from = USER): TelegramUpdate {
  return { update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: "supergroup" }, from: { id: from },
    message_thread_id: threadId, text } } as TelegramUpdate;
}

function tap(data: string, from = USER): TelegramUpdate {
  return { update_id: 3, callback_query: { id: "cb1", data, from: { id: from },
    message: { message_id: 501, chat: { id: CHAT, type: "supergroup" } } } } as TelegramUpdate;
}

async function events(gateway: BotGateway, connId: string): Promise<GatewayEvent[]> {
  const reply = await gateway.poll(connId, 0);
  return "events" in reply ? reply.events.filter(e => e.type !== "log") : [];
}

describe("BotGateway sessions and topics", () => {
  it("gives each directory its own topic and keeps it across gateway restarts", async () => {
    const t = setup();
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(await t.gateway.open({ connId: "b", cwd: "/work/beta" })).toMatchObject({ ok: true, threadId: 78 });
    // The topic is named by the home-relative path (absolute outside home).
    expect(t.api).toHaveBeenCalledWith("createForumTopic", { chat_id: CHAT, name: "/work/alpha" });
    const stored = JSON.parse(readFileSync(join(t.dataDir, "runtime", "topics.json"), "utf8"));
    expect(Object.keys(stored.topics)).toContain(JSON.stringify([botKey(TOKEN), CHAT, "/work/alpha"]));

    const restarted = setup(undefined, { dataDir: t.dataDir });
    expect(await restarted.gateway.open({ connId: "a2", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(restarted.api.mock.calls.map(c => c[0])).toEqual(["reopenForumTopic"]);
  });

  it("reopens a closed topic when a session connects, and keeps it", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    t.setReopenError(undefined); // the topic was closed: reopening succeeds
    expect(await t.gateway.open({ connId: "b", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(t.api).toHaveBeenCalledWith("reopenForumTopic", { chat_id: CHAT, message_thread_id: 77 });
    expect(t.api.mock.calls.filter(c => c[0] === "createForumTopic")).toHaveLength(1);
  });

  it("makes a new topic once when the recorded one was deleted", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    t.setReopenError("Bad Request: TOPIC_ID_INVALID");
    expect(await t.gateway.open({ connId: "b", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 78 });
    t.gateway.close("b");
    t.setReopenError("Bad Request: TOPIC_NOT_MODIFIED");
    expect(await t.gateway.open({ connId: "c", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 78 });
    expect(t.api.mock.calls.filter(c => c[0] === "createForumTopic")).toHaveLength(2);
  });

  it("keeps the recorded topic when the check fails for another reason", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    t.setReopenError("fetch failed");
    expect(await t.gateway.open({ connId: "b", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(t.api.mock.calls.filter(c => c[0] === "createForumTopic")).toHaveLength(1);
  });

  it("says how to set the user ID and makes no topic while none is set", async () => {
    const t = setup({ botToken: TOKEN, forumChatId: CHAT });
    const result = await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.notices.join()).toContain("a2t setup");
    expect(t.api).not.toHaveBeenCalled();
  });

  it("answers the allowed user in a private chat with a pointer to the group, and ignores others", async () => {
    const t = setup();
    const privateMessage = (from: number, text: string) => ({ update_id: 2, message: { message_id: 1,
      chat: { id: from, type: "private" }, from: { id: from }, text } } as TelegramUpdate);
    await t.gateway.handleUpdate(privateMessage(USER, "hi"));
    await t.gateway.handleUpdate(privateMessage(999, "/pair 123456"));
    expect(t.sent).toEqual([{ chatId: USER, text: "请在论坛群里对应目录的话题中和我对话。", threadId: undefined }]);
    expect(t.getConfig().allowedUserId).toBe(USER);
  });

  it("keeps a directory that is not enabled idle, without a topic", async () => {
    const t = setup(undefined, { isEnabled: cwd => cwd === "/work/alpha" });
    expect(await t.gateway.open({ connId: "x", cwd: "/work/beta" })).toMatchObject({ ok: false, quiet: true });
    expect(await t.gateway.open({ connId: "y", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
    expect(t.api).toHaveBeenCalledTimes(1);
  });

  it("drops a session as soon as its directory is disabled, says so in the topic, and takes it back once enabled", async () => {
    let enabled = true;
    const t = setup(undefined, { isEnabled: () => enabled });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.poll("a", 0); // drain the "topic created" log
    const held = t.gateway.poll("a", 60_000);
    enabled = false; // a2t disable
    t.gateway.reap();
    expect(await held).toEqual({ events: [] }); // the held poll returns at once
    expect(await t.gateway.poll("a", 0)).toEqual({ unknown: true });
    expect(t.sent.at(-1)).toMatchObject({ threadId: 77, text: expect.stringContaining("a2t disable") });
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha" })).toMatchObject({ ok: false, quiet: true });
    enabled = true; // a2t enable
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 77 });
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

describe("BotGateway commands", () => {
  it("turns /stop, the session commands and /usage into events and answers the rest with a notice", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    for (const text of ["/stop", "/stop@demo_bot", "/compact", "/clear", "/status", "/model", "/effort", "/commands", "/usage", "/resume"]) {
      await t.gateway.handleUpdate(topicMessage(text));
    }
    expect(await events(t.gateway, "a")).toEqual([
      { type: "abort" }, { type: "abort" }, { type: "command", name: "compact" }, { type: "command", name: "clear" },
      { type: "command", name: "status" }, { type: "command", name: "model" }, { type: "command", name: "effort" },
      { type: "command", name: "commands" }, { type: "usage" }]);
    expect(t.sent.at(-1)?.text).toBe("暂不支持这个命令。可用：/stop /status /model /effort /commands /compact /clear /usage /restart");
  });

  it("registers the / menu for the forum group only", async () => {
    const t = setup();
    await t.gateway.registerCommands();
    expect(t.api).toHaveBeenCalledWith("setMyCommands", expect.objectContaining({ scope: { type: "chat", chat_id: CHAT } }));
    const commands = (t.api.mock.calls[0]![1] as { commands: Array<{ command: string }> }).commands.map(c => c.command);
    expect(commands).toEqual(["stop", "status", "model", "effort", "commands", "compact", "clear", "usage", "restart"]);
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

describe("BotGateway answers", () => {
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

describe("BotGateway buttons", () => {
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

describe("BotGateway rich mode (Pi)", () => {
  async function raw(gateway: BotGateway, connId: string): Promise<TelegramUpdate[]> {
    const reply = await gateway.poll(connId, 0);
    return "events" in reply ? reply.events.flatMap(e => e.type === "update" ? [e.update] : []) : [];
  }

  it("hands the raw update of a session's topic to that session, commands included", async () => {
    const t = setup(undefined, { rich: true });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.open({ connId: "b", cwd: "/work/beta" });
    const slash = topicMessage("/model", 77);
    await t.gateway.handleUpdate(slash);
    await t.gateway.handleUpdate(topicMessage("for beta", 78));
    await t.gateway.handleUpdate(topicMessage("not you", 77, 1));
    expect(await raw(t.gateway, "a")).toEqual([slash]);
    expect((await raw(t.gateway, "b")).map(u => u.message?.text)).toEqual(["for beta"]);
    expect(t.sent).toEqual([]);
  });

  it("routes a callback by its thread, or by a reported button message when the thread is missing", async () => {
    const t = setup(undefined, { rich: true });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.open({ connId: "b", cwd: "/work/beta" });
    await t.gateway.poll("b", 0, [501]);
    const threadless = tap("x:1");
    await t.gateway.handleUpdate(threadless);
    const [delivered] = await raw(t.gateway, "b");
    expect(delivered?.callback_query?.data).toBe("x:1");
    expect(delivered?.callback_query?.message?.message_thread_id).toBe(78);
    expect(await raw(t.gateway, "a")).toEqual([]);
  });

  it("says so in a topic whose Pi is offline, and answers a stale button", async () => {
    const t = setup(undefined, { rich: true });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    await t.gateway.handleUpdate(topicMessage("anyone?"));
    expect(t.sent.at(-1)?.text).toContain("Pi 会话");
    await t.gateway.handleUpdate(tap("x:1"));
    expect(t.answerCallbackQuery).toHaveBeenLastCalledWith("cb1", "已过期");
  });

  it("adopts the topic a session already knew instead of creating one", async () => {
    const t = setup(undefined, { rich: true });
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha", legacyThreadId: 135 })).toMatchObject({ ok: true, threadId: 135 });
    expect(t.api.mock.calls.map(c => c[0])).toEqual(["reopenForumTopic"]);
  });

  it("reads Pi's existing topic map, and treats an unknown-result create as absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-topics-"));
    dirs.push(dir);
    const topicsPath = join(dir, "tg-runtime", "abc", "topics.json");
    mkdirSync(join(dir, "tg-runtime", "abc"), { recursive: true });
    writeFileSync(topicsPath, JSON.stringify({ version: 1, topics: {
      [JSON.stringify([botKey(TOKEN), CHAT, "/work/alpha"])]: { threadId: 604, cwd: "/work/alpha", updatedAt: "x" },
      [JSON.stringify([botKey(TOKEN), CHAT, "/work/beta"])]: { threadId: null, state: "create-unknown", cwd: "/work/beta", updatedAt: "x" },
    } }));
    const t = setup(undefined, { rich: true, topicsPath });
    expect(await t.gateway.open({ connId: "a", cwd: "/work/alpha" })).toMatchObject({ ok: true, threadId: 604 });
    expect(await t.gateway.open({ connId: "b", cwd: "/work/beta" })).toMatchObject({ ok: true, threadId: 77 });
    expect(t.api.mock.calls.filter(c => c[0] === "createForumTopic")).toHaveLength(1);
  });
});
