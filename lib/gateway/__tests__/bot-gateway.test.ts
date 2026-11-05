import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    rich?: boolean; topicsPath?: string; saveFile?: (cwd: string, fileId: string, fileName?: string) => Promise<string> } = {}) {
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
    ...(options.saveFile ? { saveFile: options.saveFile } : {}),
    typingIntervalMs: 1_000,
  });
  return { gateway, dataDir, sent, buttons, api, sendText, sendChatAction, editText, answerCallbackQuery, startRestart,
    getConfig: () => config, setReopenError: (text: string | undefined) => { reopenError = text; } };
}

function topicMessage(text: string, threadId = 77, from = USER): TelegramUpdate {
  return { update_id: 1, message: { message_id: 5, chat: { id: CHAT, type: "supergroup" }, from: { id: from },
    message_thread_id: threadId, text } } as TelegramUpdate;
}

function mediaMessage(fields: Record<string, unknown>, threadId = 77): TelegramUpdate {
  return { update_id: 2, message: { message_id: 6, chat: { id: CHAT, type: "supergroup" }, from: { id: USER },
    message_thread_id: threadId, ...fields } } as TelegramUpdate;
}

const PHOTO = { photo: [{ file_id: "small", file_size: 100 }, { file_id: "large", file_size: 900 }, { file_id: "mid", file_size: 400 }] };

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

  it("announces a new Claude session in its topic once; reconnects of the same session stay quiet", async () => {
    const t = setup();
    const announced = () => t.sent.filter(m => m.text.includes("会话已接入"));
    await t.gateway.open({ connId: "a", cwd: "/work/alpha", pid: 100, claudeSessionId: "s1" });
    expect(announced()).toEqual([{ chatId: CHAT, text: "Claude Code 会话已接入。本话题对应目录 /work/alpha", threadId: 77 }]);
    // The same session reconnecting (poll timeout, module reload) says nothing more.
    await t.gateway.open({ connId: "a", cwd: "/work/alpha", pid: 100, claudeSessionId: "s1" });
    await t.gateway.open({ connId: "a2", cwd: "/work/alpha", pid: 100, claudeSessionId: "s1" });
    expect(announced()).toHaveLength(1);
    // A new session in the directory (exit and start again) is announced.
    t.gateway.close("a2");
    await t.gateway.open({ connId: "b", cwd: "/work/alpha", pid: 200, claudeSessionId: "s2" });
    expect(announced()).toHaveLength(2);
    // Directories under home read as ~/…
    await t.gateway.open({ connId: "c", cwd: join(homedir(), "proj"), pid: 300, claudeSessionId: "s3" });
    expect(announced().at(-1)?.text).toBe("Claude Code 会话已接入。本话题对应目录 ~/proj");
  });

  it("does not announce Pi (rich) or sessions without a Claude session id (Codex)", async () => {
    const pi = setup(undefined, { rich: true });
    await pi.gateway.open({ connId: "p", cwd: "/work/alpha", pid: 100, claudeSessionId: "s1" });
    expect(pi.sent.filter(m => m.text.includes("会话已接入"))).toEqual([]);
    const codex = setup();
    await codex.gateway.open({ connId: "codex:t1", cwd: "/work/alpha" });
    expect(codex.sent.filter(m => m.text.includes("会话已接入"))).toEqual([]);
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

describe("BotGateway media (thin)", () => {
  it("saves the largest photo and prompts with the caption and its path", async () => {
    const saveFile = vi.fn(async (_cwd: string, fileId: string) => `/cache/uploads/alpha/${fileId}.jpg`);
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ ...PHOTO, caption: " what is this? " }));
    expect(saveFile).toHaveBeenCalledWith("/work/alpha", "large", undefined);
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "what is this?\n[Telegram 图片] /cache/uploads/alpha/large.jpg" }]);
    expect(t.sent).toEqual([]);
  });

  it("prompts with the path alone for a photo without a caption", async () => {
    const t = setup(undefined, { saveFile: async () => "/cache/p.jpg" });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage(PHOTO));
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "[Telegram 图片] /cache/p.jpg" }]);
  });

  it("says so in the topic when the download fails, and sends no prompt", async () => {
    const t = setup(undefined, { saveFile: async () => { throw new Error("404"); } });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ ...PHOTO, caption: "look" }));
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ threadId: 77 });
    expect(t.sent.at(-1)?.text).toContain("图片下载失败");
    expect(t.sent.at(-1)?.text).toContain("404");
  });

  it("answers other media with a notice and drops the caption", async () => {
    const saveFile = vi.fn(async () => "/cache/p.jpg");
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ video: { file_id: "m" }, caption: "watch this" }));
    await t.gateway.handleUpdate(mediaMessage({ voice: { file_id: "v" } }));
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(saveFile).not.toHaveBeenCalled();
    expect(t.sent.map(m => m.text)).toEqual([expect.stringContaining("暂不支持视频"), expect.stringContaining("暂不支持语音")]);
  });

  it("saves a file under its own name and prompts with the caption, its name and its path", async () => {
    const saveFile = vi.fn(async (_cwd: string, _id: string, name?: string) => `/cache/123-${name}`);
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ document: { file_id: "d1", file_name: "报告.pdf", file_size: 2048 }, caption: "summarize" }));
    expect(saveFile).toHaveBeenCalledWith("/work/alpha", "d1", "报告.pdf");
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "summarize\n[Telegram 文件] 报告.pdf → /cache/123-报告.pdf" }]);
    expect(t.sent).toEqual([]);
  });

  it("says a file over 20 MB is too big without downloading it", async () => {
    const saveFile = vi.fn(async () => "/cache/x");
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ document: { file_id: "big", file_name: "big.zip", file_size: 25 * 1024 * 1024 } }));
    expect(saveFile).not.toHaveBeenCalled();
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.at(-1)?.text).toContain("文件下载失败，本条未处理：文件太大（25.0 MB）");
  });

  it("answers a file with a notice when the agent cannot take files (Codex)", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ document: { file_id: "d", file_name: "a.txt" } }));
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.at(-1)?.text).toContain("暂不支持文件，本条未处理");
  });

  it("answers a photo with a notice when the agent cannot take photos (Codex)", async () => {
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ ...PHOTO, caption: "look" }));
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.at(-1)?.text).toContain("暂不支持图片");
  });

  it("says so for a photo in a topic whose session is offline", async () => {
    const saveFile = vi.fn(async () => "/cache/p.jpg");
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    t.gateway.close("a");
    await t.gateway.handleUpdate(mediaMessage(PHOTO));
    expect(saveFile).not.toHaveBeenCalled();
    expect(t.sent.at(-1)?.text).toContain("/work/alpha");
  });
});

describe("BotGateway albums (thin)", () => {
  const albumPhoto = (group: string, id: string, extra: Record<string, unknown> = {}) =>
    mediaMessage({ media_group_id: group, photo: [{ file_id: id, file_size: 1 }], ...extra });
  const savePath = async (_cwd: string, fileId: string) => `/cache/${fileId}.jpg`;

  it("waits 5 s after each item, then prompts once with the caption and every path in order", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: savePath });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(albumPhoto("g1", "p1", { caption: "compare these" }));
    await vi.advanceTimersByTimeAsync(4_000);
    await t.gateway.handleUpdate(albumPhoto("g1", "p2"));
    await vi.advanceTimersByTimeAsync(4_000);
    await t.gateway.handleUpdate(albumPhoto("g1", "p3"));
    await vi.advanceTimersByTimeAsync(4_900);
    expect(await events(t.gateway, "a")).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: [
      "compare these", "[Telegram 图片 1/3] /cache/p1.jpg", "[Telegram 图片 2/3] /cache/p2.jpg", "[Telegram 图片 3/3] /cache/p3.jpg",
    ].join("\n") }]);
    expect(t.sent).toEqual([]);
  });

  it("keeps two albums apart", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: savePath });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(albumPhoto("g1", "a1"));
    await t.gateway.handleUpdate(albumPhoto("g2", "b1"));
    await t.gateway.handleUpdate(albumPhoto("g1", "a2"));
    await vi.advanceTimersByTimeAsync(5_000);
    const texts = (await events(t.gateway, "a")).map(e => e.type === "prompt" ? e.text : "");
    // g2's last item came first, so it is handed over first.
    expect(texts).toEqual(["[Telegram 图片] /cache/b1.jpg", "[Telegram 图片 1/2] /cache/a1.jpg\n[Telegram 图片 2/2] /cache/a2.jpg"]);
  });

  it("handles an album at once when it reaches Telegram's 10-item limit", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: savePath });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    for (let i = 1; i <= 10; i++) await t.gateway.handleUpdate(albumPhoto("g1", `p${i}`));
    const got = await events(t.gateway, "a");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "prompt", text: expect.stringContaining("[Telegram 图片 10/10] /cache/p10.jpg") });
  });

  it("sends the photos that saved and names the one that failed", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: async (cwd, id) => { if (id === "p2") throw new Error("timeout"); return savePath(cwd, id); } });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    for (const id of ["p1", "p2", "p3"]) await t.gateway.handleUpdate(albumPhoto("g1", id));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt",
      text: "[Telegram 图片 1/3] /cache/p1.jpg\n[Telegram 图片 3/3] /cache/p3.jpg" }]);
    expect(t.sent.map(m => m.text)).toEqual([expect.stringContaining("第 2/3 张图片下载失败：timeout")]);
  });

  it("skips a video in an album with a notice and sends the photos", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: savePath });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(albumPhoto("g1", "p1"));
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g1", video: { file_id: "v1" } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "[Telegram 图片] /cache/p1.jpg" }]);
    expect(t.sent.map(m => m.text)).toEqual([expect.stringContaining("暂不支持视频，已跳过")]);
  });

  it("merges a group of files, and photos with files, into one prompt", async () => {
    vi.useFakeTimers();
    const saveFile = async (_cwd: string, id: string, name?: string) => `/cache/${name ?? `${id}.jpg`}`;
    const t = setup(undefined, { saveFile });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g1", document: { file_id: "d1", file_name: "a.txt" }, caption: "compare" }));
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g1", document: { file_id: "d2", file_name: "b.txt" } }));
    await t.gateway.handleUpdate(albumPhoto("g2", "p1"));
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g2", document: { file_id: "d3", file_name: "c.md" } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await events(t.gateway, "a")).map(e => e.type === "prompt" ? e.text : "")).toEqual([
      "compare\n[Telegram 文件 1/2] a.txt → /cache/a.txt\n[Telegram 文件 2/2] b.txt → /cache/b.txt",
      "[Telegram 图片 1/2] /cache/p1.jpg\n[Telegram 文件 2/2] c.md → /cache/c.md",
    ]);
  });

  it("names the file of a group that failed", async () => {
    vi.useFakeTimers();
    const t = setup(undefined, { saveFile: async (_cwd, id, name) => { if (id === "d2") throw new Error("gone"); return `/cache/${name}`; } });
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g1", document: { file_id: "d1", file_name: "a.txt" } }));
    await t.gateway.handleUpdate(mediaMessage({ media_group_id: "g1", document: { file_id: "d2", file_name: "b.txt" } }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await events(t.gateway, "a")).toEqual([{ type: "prompt", text: "[Telegram 文件 1/2] a.txt → /cache/a.txt" }]);
    expect(t.sent.map(m => m.text)).toEqual([expect.stringContaining("第 2/2 个文件下载失败：gone")]);
  });

  it("answers a whole album once when the agent cannot take photos (Codex)", async () => {
    vi.useFakeTimers();
    const t = setup();
    await t.gateway.open({ connId: "a", cwd: "/work/alpha" });
    for (const id of ["p1", "p2", "p3"]) await t.gateway.handleUpdate(albumPhoto("g1", id));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await events(t.gateway, "a")).toEqual([]);
    expect(t.sent.map(m => m.text)).toEqual([expect.stringContaining("暂不支持图片，本条未处理")]);
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
    // Only the first open of s9 was announced; the restart says "restarted" instead.
    expect(t.sent.filter(m => m.text.includes("会话已接入"))).toHaveLength(1);
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
