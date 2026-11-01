import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendForumBinding, readForumBinding, type ForumBinding } from "../../core/forum-binding.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forum-public-session-api-")); roots.push(root);
  const manager = SessionManager.create(root, join(root, "sessions"));
  return { root, manager };
}
function bind(manager: SessionManager): ForumBinding {
  const binding: ForumBinding = { version: 1, botId: "telegram:123", chatId: -100123,
    sessionId: manager.getSessionId(), threadId: 11 };
  appendForumBinding({ appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data) } as any,
    { sessionManager: manager } as any, binding);
  return binding;
}
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });

describe("Pi 1.4.0 public SessionManager persistence contract (synthetic data only)", () => {
  it("does not claim setup/custom-only disk persistence, then flushes the binding with the first user message", async () => {
    const { manager } = await fixture();
    manager.appendModelChange("fake", "offline-model"); manager.appendThinkingLevelChange("medium");
    const binding = bind(manager);
    const file = manager.getSessionFile()!;
    expect(existsSync(file)).toBe(false);
    expect(readForumBinding(manager.getEntries(), binding.botId, binding.chatId, binding.sessionId)).toEqual(binding);
    manager.appendMessage(user("synthetic first prompt; no model is invoked"));
    expect(existsSync(file)).toBe(true);
    const reopened = SessionManager.open(file);
    expect(readForumBinding(reopened.getEntries(), binding.botId, binding.chatId, reopened.getSessionId())).toEqual(binding);
    const contents = await readFile(file, "utf8");
    expect(contents).toContain("pi-telegram-plus-ex.forum-binding");
    expect(contents).not.toContain("botToken");
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(binding.botId);
  });
  it("keeps a session-wide binding through tree navigation, compaction and reopen even off the selected branch", async () => {
    const { manager } = await fixture();
    const first = manager.appendMessage(user("first branch"));
    const binding = bind(manager); manager.appendMessage(user("later branch"));
    manager.branch(first); manager.appendMessage(user("another branch"));
    manager.appendCompaction("synthetic summary, not a model request", first, 50);
    expect(readForumBinding(manager.getEntries(), binding.botId, binding.chatId, manager.getSessionId())).toEqual(binding);
    const reopened = SessionManager.open(manager.getSessionFile()!);
    expect(readForumBinding(reopened.getEntries(), binding.botId, binding.chatId, reopened.getSessionId())).toEqual(binding);
    expect(reopened.getSessionId()).toBe(binding.sessionId);
  });
  it("rejects inherited bindings after public fork/branched-clone and new-session operations", async () => {
    const { manager, root } = await fixture(); manager.appendMessage(user("synthetic source"));
    const binding = bind(manager); const originalFile = manager.getSessionFile()!;
    const fork = SessionManager.forkFrom(originalFile, root, join(root, "fork"));
    expect(fork.getSessionId()).not.toBe(binding.sessionId);
    expect(readForumBinding(fork.getEntries(), binding.botId, binding.chatId, fork.getSessionId())).toBeUndefined();
    const cloneFile = manager.createBranchedSession(manager.getLeafId()!);
    expect(cloneFile).not.toBe(originalFile); expect(manager.getSessionId()).not.toBe(binding.sessionId);
    expect(readForumBinding(manager.getEntries(), binding.botId, binding.chatId, manager.getSessionId())).toBeUndefined();
    const original = SessionManager.open(originalFile);
    expect(readForumBinding(original.getEntries(), binding.botId, binding.chatId, original.getSessionId())).toEqual(binding);
    manager.newSession();
    expect(readForumBinding(manager.getEntries(), binding.botId, binding.chatId, manager.getSessionId())).toBeUndefined();
  });
  it("retains a --no-session style in-memory binding but never invents a persisted session file", () => {
    const manager = SessionManager.inMemory("/fake/no-session"); const binding = bind(manager);
    manager.appendMessage(user("synthetic in-memory prompt"));
    expect(manager.getSessionFile()).toBeUndefined();
    expect(manager.isPersisted()).toBe(false);
    expect(readForumBinding(manager.getEntries(), binding.botId, binding.chatId, manager.getSessionId())).toEqual(binding);
    expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(binding.botId);
  });
});
