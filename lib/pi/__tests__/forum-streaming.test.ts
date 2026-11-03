import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramRenderer } from "../renderer.ts";
import { createActiveTelegramTransport } from "../../core/active-transport.ts";
import { createForumTelegramTransport } from "../forum-transport.ts";
import type { ForumTarget } from "../../core/forum-binding.ts";
import type { TelegramTransport, TelegramTurn } from "../../core/types.ts";
import { SecretStore } from "../tui/secrets.ts";

const STREAM_EDIT_MS = 1000; // the old preview throttle; tests keep the same timeline

afterEach(() => { vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture(remote = false, config: Record<string, unknown> = {}) {
  let target: ForumTarget | undefined = { botId: "b", chatId: -100123, sessionId: "a", threadId: 11, generation: "a1" };
  let now = 1000; vi.spyOn(Date, "now").mockImplementation(() => now);
  const handlers = new Map<string, Array<(event: any) => unknown>>();
  const calls: Array<{ kind: string; chat: number; thread?: number; text?: string; id?: number }> = [];
  const owned = new Set<number>(); let serial = 0;
  const base = { sendText: vi.fn(async (chat: number, text: string, thread?: number) => {
    const id = ++serial; calls.push({ kind: "send", chat, thread, text, id }); return [{ message_id: id }];
  }), editText: vi.fn(async (chat: number, id: number, text: string) => { calls.push({ kind: "edit", chat, id, text }); }),
    deleteMessage: vi.fn(async (chat: number, id: number) => { calls.push({ kind: "delete", chat, id }); }) };
  const forum = { enabled: true, getTarget: () => target, ownsMessage: (id: number) => owned.has(id),
    rememberMessage: (id: number) => { owned.add(id); } };
  const lease = () => target?.generation;
  const transport = createActiveTelegramTransport(createForumTelegramTransport(base as unknown as TelegramTransport, forum),
    { isActive: () => !!target, getLease: lease });
  const turn: TelegramTurn | undefined = remote ? { chatId: -100123, messageThreadId: 11, sourceMessageId: 51, queuedAttachments: [] } : undefined;
  const secrets = new SecretStore();
  registerTelegramRenderer({ on: (name: string, fn: (event: any) => unknown) => {
    const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list);
  } } as any, { getConfig: () => ({ botToken: "fake", activeChatId: target?.chatId, ...config }), transport,
    getActiveTurn: () => turn, hasActiveTurns: () => false, getSendLease: lease, secrets });
  const emit = async (name: string, text: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ message: { role: "assistant", content: [{ type: "text", text }] } });
  };
  const emitEvent = async (name: string, event: unknown) => {
    for (const handler of handlers.get(name) ?? []) await handler(event);
  };
  return { calls, base, emit, emitEvent, secrets, advance: () => { now += STREAM_EDIT_MS; },
    setTarget: (value: ForumTarget | undefined) => { target = value; } };
}

describe("assistant replies in the bound forum (streaming preview disabled)", () => {
  it("sends no preview while text streams, then the complete final answer once into the bound topic", async () => {
    const f = fixture();
    await f.emit("message_start", ""); await f.emit("message_update", "a"); await flush();
    f.advance(); await f.emit("message_update", "abc"); await flush();
    expect(f.calls).toEqual([]);
    await f.emit("message_end", "**complete final answer**");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ kind: "send", chat: -100123, thread: 11, text: expect.stringContaining("complete final answer") });
    expect(f.calls[0].text).not.toContain("正在输出");
  });
  it("sends a long final answer whole without a temporary preview to delete", async () => {
    const f = fixture(); const text = "<&😀".repeat(2500);
    await f.emit("message_update", text); await flush();
    expect(f.calls).toEqual([]);
    await f.emit("message_end", text);
    expect(f.calls.filter(c => c.kind === "send")).toHaveLength(1);
    expect(f.calls[0].text!.length).toBeGreaterThan(3500);
    expect(f.calls.some(c => c.kind === "delete" || c.kind === "edit")).toBe(false);
  });
  it("never moves a partially emitted old message into a new generation/topic", async () => {
    const f = fixture(); await f.emit("message_update", "old generation"); await flush();
    f.setTarget({ botId: "b", chatId: -100123, sessionId: "new", threadId: 22, generation: "new" }); f.advance();
    await f.emit("message_update", "old continuation must not migrate"); await f.emit("message_end", "old final must not migrate");
    expect(f.calls).toEqual([]);
    await f.emit("message_start", ""); await f.emit("message_update", "new task"); await f.emit("message_end", "new task");
    expect(f.calls.at(-1)).toMatchObject({ kind: "send", thread: 22, text: expect.stringContaining("new task") });
  });
  it("redacts tracked secrets in the final reply and keeps its topic identity", async () => {
    const f = fixture(true); f.secrets.remember("-100123:11", "f", "fake-secret-value");
    await f.emit("message_update", "key fake-secret-value <done>"); await flush();
    expect(f.calls).toEqual([]);
    await f.emit("message_end", "key fake-secret-value is hidden");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].text).not.toContain("fake-secret-value"); expect(f.calls[0].text).toContain("***");
    expect(f.calls[0].thread).toBe(11);
  });
});

describe("process steps and tool events (no merged process message)", () => {
  const toolReply = { message: { role: "assistant", content: [
    { type: "thinking", thinking: "plan the read" },
    { type: "text", text: "Let me read the file." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
  ] } };
  it("sends nothing for a reply that also calls tools", async () => {
    for (const level of ["brief", "full"]) {
      const f = fixture(false, { tool: level, thinking: level });
      await f.emit("message_start", ""); await f.emit("message_update", "Let me read"); await flush();
      await f.emitEvent("message_end", toolReply); await flush();
      expect(f.calls).toEqual([]);
    }
  });
  it("sends nothing when a tool starts or reports progress", async () => {
    for (const level of ["brief", "full"]) {
      const f = fixture(false, { tool: level });
      await f.emitEvent("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "README.md" } });
      f.advance(); f.advance();
      await f.emitEvent("tool_execution_update", { toolCallId: "c1", toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
      await flush();
      expect(f.calls).toEqual([]);
    }
  });
  it("still sends a failed tool as its own message in brief mode, and nothing for a success", async () => {
    const f = fixture(false, { tool: "brief" });
    await f.emitEvent("tool_execution_start", { toolCallId: "ok", toolName: "read", args: { path: "a.md" } });
    await f.emitEvent("tool_execution_end", { toolCallId: "ok", toolName: "read", result: { content: [{ type: "text", text: "fine" }] }, isError: false });
    expect(f.calls).toEqual([]);
    await f.emitEvent("tool_execution_start", { toolCallId: "bad", toolName: "read", args: { path: "missing.md" } });
    await f.emitEvent("tool_execution_end", { toolCallId: "bad", toolName: "read", result: { content: [{ type: "text", text: "ENOENT: no such file" }] }, isError: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ kind: "send", thread: 11, text: expect.stringContaining("read") });
    expect(f.calls[0].text).toContain("ENOENT");
  });
  it("sends the tool result as its own message in full mode", async () => {
    const f = fixture(false, { tool: "full" });
    await f.emitEvent("tool_execution_end", { toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "file body" }] }, isError: false });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ kind: "send", thread: 11, text: expect.stringContaining("file body") });
  });
});
