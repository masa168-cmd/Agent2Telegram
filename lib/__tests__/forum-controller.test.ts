import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import { createTelegramUiRuntime } from "../telegram-ui.ts";
import { CommandGateway } from "../tui/gateway.ts";
import { forumCommandPolicy, isCredentialDialog } from "../forum-policy.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";
import type { TelegramButton, TelegramTransport } from "../types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });
function fixture() {
  let current = true;
  let localSubmit: (text: string) => void = () => {};
  const frames: Array<{ id: number; text: string; rows?: TelegramButton[][] }> = [];
  const sendText = vi.fn(async (_chat: number, text: string) => {
    const id = 100 + frames.length; frames.push({ id, text }); return [{ message_id: id }];
  });
  const transport: TelegramTransport = { sendText,
    sendButtons: async (_chat, text, rows) => { const id = 100 + frames.length; frames.push({ id, text, rows }); return { message_id: id }; },
    editText: async () => {}, editButtons: async () => {}, removeInlineKeyboard: async () => {},
    deleteMessage: async () => {}, answerCallbackQuery: async () => {}, sendDocument: async () => {},
    sendPhoto: async () => {}, sendChatAction: async () => {} };
  const session = { prompt: vi.fn(async () => {}), isStreaming: false,
    extensionRunner: { getUIContext: () => ({}), setUIContext: () => {}, getCommand: () => undefined,
      createCommandContext: () => ({}) } } as any;
  const ui = createTelegramUiRuntime({ getSession: () => session, transport,
    allowSecretInputs: () => false, isCurrent: () => current });
  const bridge: TuiBridgeAdapter = { ready: async () => {}, isAvailable: () => true, getHost: () => "pi",
    getCommands: async () => ["login", "logout", "share", "quit", "model", "settings", "compact", "resume", "fork", "clone", "tree"]
      .map(name => ({ name, source: "builtin" as const })), submit: vi.fn(() => true),
    snapshot: vi.fn(() => ({ text: "fake credential MUST NEVER BE SCRAPED", interactive: true, host: "pi" as const, width: 100 })),
    key: () => true, write: vi.fn(() => true), isEditorFocused: () => true, isInteractiveFocus: () => false,
    onLocalSubmit: fn => { localSubmit = fn; return () => {}; } };
  const controller = createTelegramController({ getSession: () => session, transport, ui,
    getConfig: () => ({ forumChatId: -100123, activeChatId: -100123 }), isCurrent: () => current,
    getLocalDialogOrigin: () => ({ chatId: -100123, messageThreadId: 11 }),
    authorizeUser: async () => true, setActiveChatId: async () => {}, getBotUsername: () => "fake_bot",
    telegramCommands: new Map(), getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId, _, messageThreadId) => ({ chatId, messageThreadId, queuedAttachments: [] }),
    endTelegramTurn: () => {}, tuiBridge: bridge });
  cleanups.push(() => { controller.dispose(); ui.dispose(); });
  const send = (text: string, type: string | null = "supergroup") => controller.handleMessage({
    message_id: 51, message_thread_id: 11, chat: { id: -100123, ...(type ? { type } : {}) }, from: { id: 7 }, text });
  return { controller, ui, bridge, session, frames, send, sendText,
    local: (text: string) => localSubmit(text), expire: () => { current = false; } };
}

describe("forum phone command policy", () => {
  it.each(["/login", "/logout", "/auth", "/tg_forum retry"])("keeps %s in SSH instead of forwarding credentials", async command => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const f = fixture(); await f.send(command);
    expect(run).not.toHaveBeenCalled(); expect(f.session.prompt).not.toHaveBeenCalled();
    expect(f.frames.some(frame => frame.text.includes("SSH"))).toBe(true);
  });
  it.each(["share", "quit"])("requires explicit confirmation for /%s, without blocking later callback updates", async name => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const f = fixture(); await f.send(`/${name}`);
    await vi.waitFor(() => expect(f.ui.hasPendingInput(-100123, 11)).toBe(true));
    expect(run).not.toHaveBeenCalled();
    const frame = f.frames.find(frame => frame.rows)!;
    const value = frame.rows!.flat().find(button => button.text === "Yes")!.value;
    await f.controller.handleCallbackQuery({ id: "cb", from: { id: 7 }, data: value,
      message: { message_id: frame.id, chat: { id: -100123 }, message_thread_id: 11 } });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name, origin: expect.objectContaining({ messageThreadId: 11 }) }));
  });
  it("does not execute a confirmation whose route became obsolete while waiting", async () => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const f = fixture(); await f.send("/share");
    await vi.waitFor(() => expect(f.ui.hasPendingInput(-100123, 11)).toBe(true));
    const frame = f.frames.find(frame => frame.rows)!;
    f.expire(); f.ui.resolveInput(-100123, "f:1:yes", frame.id, true, 11);
    await Promise.resolve(); await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["model", "settings", "compact", "resume", "fork", "clone", "tree"])("preserves /%s through the host gateway", async name => {
    const run = vi.spyOn(CommandGateway.prototype, "run").mockResolvedValue(true);
    const f = fixture(); await f.send(`/${name}`);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name }));
  });
  it("rejects group !/!! even when a malformed update omits chat.type, without restricting normal model tools", async () => {
    const f = fixture(); const run = vi.spyOn(CommandGateway.prototype, "runText").mockResolvedValue(true);
    await f.send("!pwd"); await f.send("!!pwd", null);
    expect(run).not.toHaveBeenCalled(); expect(f.bridge.write).not.toHaveBeenCalled();
    await f.send("Use the bash tool to inspect this project");
    await vi.waitFor(() => expect(f.session.prompt).toHaveBeenCalledTimes(1));
  });
  it("mirrors only non-sensitive local command names, never arguments or raw terminal frames", async () => {
    const f = fixture(); f.local("/login"); f.local("!export KEY=fake-only");
    expect(f.frames).toHaveLength(0);
    f.local("/model fake-argument-never-sent");
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0].text).toContain("/model"); expect(f.frames[0].text).not.toContain("fake-argument");
    expect(f.bridge.snapshot).not.toHaveBeenCalled();
  });
  it("denies native secret prompts and credential-titled inputs without publishing their contents", async () => {
    const f = fixture(); const ui = f.ui.create(-100123, 11);
    expect(await ui.inputSecret!("fake secret title")).toBeUndefined();
    expect(await ui.input("API key", "fake-prefill-never-sent")).toBeUndefined();
    expect(await ui.editor("OAuth login", "fake-code-never-sent")).toBeUndefined();
    expect(f.ui.hasPendingInput(-100123, 11)).toBe(false);
    expect(f.frames.every(frame => !frame.text.includes("fake-"))).toBe(true);
  });
  it("classifies host auth components and nested secret settings without banning ordinary approvals", () => {
    class LoginDialogComponent {}
    expect(isCredentialDialog({ kind: "info", text: "opaque", closable: true }, new LoginDialogComponent())).toBe(true);
    expect(isCredentialDialog({ kind: "settings", title: "Settings", items: [], submenu: { itemKey: "a",
      model: { kind: "input", title: "Value", secret: true, prefill: "fake" } } }, {})).toBe(true);
    expect(isCredentialDialog({ kind: "confirm", title: "Run this tool?" }, {})).toBe(false);
    expect(forumCommandPolicy("tg_forum")).toBe("ssh");
  });
});
