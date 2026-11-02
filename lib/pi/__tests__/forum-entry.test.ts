import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readBudget } from "../context-budget/config.ts";
import { readBotRegistry, writeBotRegistry, writeProjectBinding } from "../../core/config.ts";
import { processTelegramUpdatesBatch } from "../../core/polling.ts";
import { TelegramInstanceCoordinator } from "../../core/instance-coordinator.ts";
import extension from "../../../index.ts";

const mock = vi.hoisted(() => ({ session: undefined as any, polling: undefined as any }));
vi.mock("../session-capture.ts", () => ({ getActiveSession: () => mock.session,
  installAgentSessionCapture: async () => {}, isOmpHost: () => false }));
vi.mock("../status-footer.ts", () => ({ installTelegramStatusAlignment: () => {} }));
vi.mock("../tui-bridge.ts", async importOriginal => ({ ...await importOriginal<typeof import("../tui-bridge.ts")>(),
  installTuiBridge: async () => {}, getTuiCommands: () => [], tuiBridge: {
    ready: async () => {}, isAvailable: () => true, getHost: () => "pi", getUnsupportedReason: () => undefined, getCommands: async () => [],
    submit: () => false, key: () => false, write: () => false, snapshot: () => undefined,
    isEditorFocused: () => true, isInteractiveFocus: () => false, onLocalSubmit: () => () => {} } }));
vi.mock("../../core/polling.ts", async importOriginal => ({ ...await importOriginal<typeof import("../../core/polling.ts")>(),
  createTelegramPollingRuntime: (deps: any) => { mock.polling = deps;
    return { start: () => {}, stop: () => {}, isActive: () => false };  } }));

let sequence = 0; let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); mock.session = undefined; });
async function setup(options: { unpaired?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "forum-entry-")); const cwd = join(root, "work");
  await mkdir(cwd); const oldAgentDir = process.env.PI_CODING_AGENT_DIR; const oldCache = process.env.AGENT2TELEGRAM_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.AGENT2TELEGRAM_DIR = join(root, "a2t"); const uploads = join(root, "a2t", "cache", "uploads", "work");
  const token = `${50000 + ++sequence}:fake-offline`; const botId = "test";
  const bot = { id: botId, name: "Offline only", token, ...(options.unpaired ? {} : { allowedUserId: 7 }),
    forumChatId: -100123, botUsername: "offline_bot", apiBase: "http://127.0.0.1:1" };
  await writeBotRegistry({ version: 3, bots: [bot], defaultBotId: botId });
  await writeProjectBinding(cwd, { botId, enabled: true, activeChatId: 99, retryCount: 0 });
  const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const commands = new Map(); const tools = new Map(); const calls: Array<{ method: string; body: any }> = [];
  let messageId = 100; let stopped = false; let releaseFile: (() => void) | undefined;
  let blockFile = false; let fileStarted = false;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url)); expect(parsed.hostname).toBe("127.0.0.1");
    if (parsed.pathname.includes("/file/bot")) {
      fileStarted = true;
      if (blockFile) await new Promise<void>(resolve => { releaseFile = resolve; });
      return new Response("synthetic incoming contents");
    }
    const method = parsed.pathname.split("/").at(-1)!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, body });
    const result = method === "createForumTopic" ? { message_thread_id: 11, name: "offline-topic" }
      : method === "getFile" ? { file_path: "documents/input.txt" }
      : method === "sendMessage" || method === "sendPhoto" || method === "sendDocument" ? { message_id: ++messageId }
      : method === "getMe" ? { username: "offline_bot" } : true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const prompts: string[] = []; let runnerUi: any;
  const hostUi = { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_color: string, text: string) => text },
    custom: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn() };
  runnerUi = hostUi;
  const budgetModel = { provider: "fake", id: "offline", type: "chat", contextWindow: 272000, maxTokens: 8192 };
  const budgetProvider = { id: "fake", getModels: () => [budgetModel] }; let registeredProvider: any;
  const modelRegistry = { getProvider: () => registeredProvider ?? budgetProvider,
    getRegisteredNativeProvider: () => registeredProvider, getRegisteredProviderConfig: () => undefined,
    getAll: () => (registeredProvider ?? budgetProvider).getModels(),
    getAvailable: () => (registeredProvider ?? budgetProvider).getModels(),
    find: () => (registeredProvider ?? budgetProvider).getModels()[0] };
  const settingsManager = SettingsManager.inMemory();
  const ctx: any = { cwd, sessionManager, ui: hostUi, hasUI: true, modelRegistry,
    isProjectTrusted: () => true, isIdle: () => !session.isStreaming, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 1000 }), get model() { return modelRegistry.find(); } };
  const emit = async (name: string, event: any) => {
    for (const handler of [...handlers.get(name) ?? []]) await handler(event, ctx);
  };
  const session: any = { cwd, sessionManager, settingsManager, isStreaming: false, get model() { return modelRegistry.find(); },
    prompt: async (text: string) => {
      prompts.push(text); session.isStreaming = true;
      try {
        sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
        await emit("message_start", { message: { role: "assistant", content: [] } });
        await emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: "partial response" }] } });
        await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `final:${text}` }] } });
      } finally { session.isStreaming = false; }
    }, abort: vi.fn(), extensionRunner: { getUIContext: () => runnerUi, setUIContext: (ui: any) => { runnerUi = ui; },
      createCommandContext: () => ({ ...ctx, ui: runnerUi, isIdle: () => !session.isStreaming }), getCommand: (name: string) => commands.get(name) } };
  mock.session = session;
  const pi: any = { on: (name: string, fn: any) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list);
    return () => handlers.set(name, (handlers.get(name) ?? []).filter(f => f !== fn)); },
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    registerCommand: (name: string, value: any) => commands.set(name, value), registerTool: (tool: any) => tools.set(tool.name, tool),
    registerProvider: (provider: any) => { registeredProvider = provider; }, unregisterProvider: () => { registeredProvider = undefined; },
    getCommands: () => [...commands].map(([name, value]) => ({ name, description: value.description })),
    getSessionName: () => sessionManager.getSessionName() };
  cleanup = async () => {
    releaseFile?.();
    if (!stopped) { stopped = true; await emit("session_shutdown", { type: "session_shutdown" }); }
    await new Promise(resolve => setTimeout(resolve, 30));
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldCache === undefined) delete process.env.AGENT2TELEGRAM_DIR; else process.env.AGENT2TELEGRAM_DIR = oldCache;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  extension(pi);
  await emit("session_start", { type: "session_start", reason: "startup" });
  if (!options.unpaired) {
    await vi.waitFor(() => expect(calls.some(c => c.method === "sendMessage" && c.body.text.includes("本话题对应此目录"))).toBe(true), { timeout: 4000 });
  }
  return { root, cwd, uploads, token, bot, sessionManager, settingsManager, session, commands, hostUi, calls, prompts, emit, fetchMock,
    dispatch: (update: any) => processTelegramUpdatesBatch([update], mock.polling),
    blockFile: () => { blockFile = true; }, fileStarted: () => fileStarted, releaseFile: () => releaseFile?.(),
    shutdown: async () => { stopped = true; await emit("session_shutdown", { type: "session_shutdown" }); } };
}
const incoming = (update_id: number, text?: string, thread = 11, user = 7) => ({ update_id,
  message: { message_id: 1000 + update_id, from: { id: user }, chat: { id: -100123, type: "supergroup" },
    message_thread_id: thread, ...(text === undefined ? { document: { file_id: "fake-input", file_name: "../../input.txt" } } : { text }) } });

describe("unpaired forum Bot accepts /pair only in a private chat (offline)", () => {
  it("ignores /pair in the forum group, pairs from a private chat, and stores the user on the Bot", async () => {
    const f = await setup({ unpaired: true });
    const code = await vi.waitFor(async () => {
      const bot = (await readBotRegistry()).bots.find(b => b.id === "test");
      expect(bot?.pairingCode).toBeTruthy();
      return bot!.pairingCode!;
    });
    // Correct code but sent in the forum group: ignored, nothing paired.
    await f.dispatch({ update_id: 1, message: { message_id: 2001, from: { id: 7 },
      chat: { id: -100123, type: "supergroup" }, message_thread_id: 11, text: `/pair ${code}` } });
    expect(f.calls.some(c => c.method === "sendMessage" && String(c.body.text).includes("paired"))).toBe(false);
    let next = 2;
    await vi.waitFor(async () => {
      await f.dispatch({ update_id: next, message: { message_id: 2000 + next, from: { id: 7 },
        chat: { id: 7, type: "private" }, text: `/pair ${code}` } });
      next += 1;
      expect(f.calls.some(c => c.method === "sendMessage" && c.body.chat_id === 7
        && String(c.body.text).includes("paired"))).toBe(true);
    }, { timeout: 4000 });
    const bot = (await readBotRegistry()).bots.find(b => b.id === "test");
    expect(bot?.allowedUserId).toBe(7);
    expect(bot?.pairingCode).toBeUndefined();
    expect(f.prompts).toEqual([]);
  });
});

describe("real extension entry wired to fake Pi and Telegram (offline)", () => {
  it("checkpoints real update context, routes one prompt, formats a streamed final edit, rejects unauthorized and offline topics", async () => {
    const f = await setup(); const cursor = vi.spyOn(TelegramInstanceCoordinator.prototype, "persistCursor");
    await f.dispatch(incoming(1, "hello entry"));
    await vi.waitFor(() => expect(f.prompts).toEqual(["hello entry"]));
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "sendMessage" && c.body.text.includes("final:hello entry"))).toBe(true));
    expect(f.calls.some(c => c.method === "editMessageText" && c.body.text.includes("hello entry"))).toBe(false);
    expect(cursor).toHaveBeenCalledWith(1);
    await f.dispatch(incoming(2, "wrong user", 11, 8)); await f.dispatch(incoming(3, "offline", 999));
    expect(f.prompts).toHaveLength(1);
    const messages = f.calls.filter(c => c.method === "sendMessage");
    expect(messages.every(c => c.body.chat_id === -100123 && [11, 999].includes(c.body.message_thread_id))).toBe(true);
    expect(messages.some(c => c.body.message_thread_id === 999 && c.body.text.includes("不会自动启动"))).toBe(true);
    // The topic now belongs to the directory map, not to the Pi session file.
    expect(f.sessionManager.getEntries().some(e => e.type === "custom" && e.customType.includes("forum-binding"))).toBe(false);
  });
  it("exposes the budget command via the existing directory and accepts only the paired user's correct topic", async () => {
    const f = await setup(); expect(f.commands.has("context-budget")).toBe(true);
    f.hostUi.custom.mockResolvedValueOnce("fake/offline");
    f.hostUi.select.mockResolvedValueOnce("修改窗口 / 压缩阈值");
    f.hostUi.input.mockResolvedValueOnce("1050000").mockResolvedValueOnce("800000");
    f.hostUi.confirm.mockResolvedValue(true);
    await f.dispatch(incoming(1, "/context_budget", 11, 8));
    await f.dispatch(incoming(2, "/context_budget", 999));
    expect(f.hostUi.custom).not.toHaveBeenCalled(); expect(f.hostUi.select).not.toHaveBeenCalled();
    expect(readBudget(f.cwd).revision).toBeNull();
    await f.dispatch(incoming(3, "/context_budget"));
    await vi.waitFor(() => expect(readBudget(f.cwd).config.models["fake/offline"]?.compactAtTokens).toBe(800000));
    expect(f.session.model.contextWindow).toBe(1050000);
    expect(f.settingsManager.getCompactionSettings(f.session.model).reserveTokens).toBe(250000);
    f.settingsManager.setTheme("synthetic-night");
    expect(f.settingsManager.getCompactionSettings(f.session.model).reserveTokens).toBe(250000);
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "sendMessage" && c.body.message_thread_id === 11
      && c.body.text.includes("trigger&gt;800000"))).toBe(true));
    expect(f.prompts).toEqual([]);
  });
  it("invalidates a delayed budget confirmation when its forum session shuts down", async () => {
    const f = await setup(); let answer!: (value: boolean) => void;
    f.hostUi.custom.mockResolvedValueOnce("fake/offline");
    f.hostUi.select.mockResolvedValueOnce("修改窗口 / 压缩阈值");
    f.hostUi.input.mockResolvedValueOnce("1050000").mockResolvedValueOnce("800000");
    f.hostUi.confirm.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await f.dispatch(incoming(1, "/context_budget"));
    await vi.waitFor(() => expect(f.hostUi.confirm).toHaveBeenCalledTimes(1));
    await f.shutdown(); answer(true);
    await vi.waitFor(() => expect(f.hostUi.notify.mock.calls.some(c => String(c[0]).includes("已失效"))).toBe(true));
    expect(readBudget(f.cwd).revision).toBeNull(); expect(f.session.model.contextWindow).toBe(272000);
    expect(f.prompts).toEqual([]);
  });
  it("invalidates a delayed custom model choice after its forum session shuts down", async () => {
    const f = await setup(); let answer!: (value: string) => void;
    f.hostUi.custom.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    await f.dispatch(incoming(1, "/context_budget"));
    await vi.waitFor(() => expect(f.hostUi.custom).toHaveBeenCalledTimes(1));
    await f.shutdown(); answer("fake/offline");
    await vi.waitFor(() => expect(f.hostUi.notify.mock.calls.some(c => String(c[0]).includes("已失效"))).toBe(true));
    expect(readBudget(f.cwd).revision).toBeNull(); expect(f.hostUi.select).not.toHaveBeenCalled();
    expect(f.prompts).toEqual([]);
  });
  it("never forwards when cursor persistence fails and explicitly tells the requesting topic that nothing ran", async () => {
    const f = await setup(); vi.spyOn(TelegramInstanceCoordinator.prototype, "persistCursor").mockRejectedValue(new Error("synthetic disk failure"));
    await f.dispatch(incoming(1, "must not execute"));
    await new Promise(resolve => setTimeout(resolve, 30)); expect(f.prompts).toEqual([]);
    expect(f.calls.some(c => c.method === "sendMessage" && c.body.message_thread_id === 11 && c.body.text.includes("本条指令未执行"))).toBe(true);
  });
  it("downloads only synthetic data to the upload cache with a sanitized randomized name and submits it to that session", async () => {
    const f = await setup(); await f.dispatch(incoming(1));
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    // Nothing is written into the project directory any more.
    expect((await readdir(f.cwd)).filter(name => name.endsWith(".txt"))).toEqual([]);
    const files = (await readdir(f.uploads)).filter(name => name.endsWith(".txt")); expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[\\/]/); expect(await readFile(join(f.uploads, files[0]!), "utf8")).toBe("synthetic incoming contents");
    expect(f.prompts[0]).toContain(join(f.uploads, files[0]!));
  });
  it("a delayed download completing after shutdown cannot save or submit into a replacement session", async () => {
    const f = await setup(); f.blockFile(); await f.dispatch(incoming(1));
    await vi.waitFor(() => expect(f.fileStarted()).toBe(true));
    await f.shutdown(); f.releaseFile(); await new Promise(resolve => setTimeout(resolve, 80));
    expect(f.prompts).toEqual([]); expect((await readdir(f.cwd)).filter(name => name.endsWith(".txt"))).toEqual([]);
    expect(await readdir(f.uploads).catch(() => [])).toEqual([]);
  });
  it("keeps the forum sender live after another online coordinator becomes the sole receiver", async () => {
    const f = await setup();
    const other = new TelegramInstanceCoordinator({ token: f.token, instanceId: "other", startedAt: new Date().toISOString() });
    await other.reconcile({ cwd: f.cwd, sessionId: "other-session" });
    const active = other.getActive()!; await other.switchTo("other", undefined, active);
    await vi.waitFor(() => expect(mock.polling.shouldPoll()).toBe(false), { timeout: 4500, interval: 80 });
    await f.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "local follower output" }] } });
    await vi.waitFor(() => expect(f.calls.some(c => c.method === "sendMessage" && c.body.text.includes("local follower output")
      && c.body.message_thread_id === 11)).toBe(true));
    await other.releaseActive();
  }, 10_000);
});
