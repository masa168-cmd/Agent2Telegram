import { describe, expect, it } from "vitest";
import { FORUM_BINDING_TYPE, appendForumBinding, forumTopicLink, parseForumBinding,
  readForumBinding, sameForumTarget, type ForumBinding } from "../forum-binding.ts";

const binding: ForumBinding = { version: 1, botId: "telegram:123", chatId: -100123,
  sessionId: "session-a", threadId: 11 };
const entry = (data: unknown) => ({ type: "custom", customType: FORUM_BINDING_TYPE, data });

describe("session-wide forum bindings", () => {
  it("resumes only the exact Bot/group/session and ignores copied fork/clone entries", () => {
    const entries = [entry(binding)];
    expect(readForumBinding(entries, binding.botId, binding.chatId, "session-a")).toEqual(binding);
    for (const id of ["new", "fork", "clone"]) {
      expect(readForumBinding(entries, binding.botId, binding.chatId, id)).toBeUndefined();
    }
    expect(readForumBinding(entries, "other-bot", binding.chatId, "session-a")).toBeUndefined();
    expect(readForumBinding(entries, binding.botId, -999, "session-a")).toBeUndefined();
  });
  it("uses the newest matching entry, including disconnect and unknown-create tombstones", () => {
    const stopped = { ...binding, threadId: null, state: "create-unknown" };
    expect(readForumBinding([entry(binding), entry(stopped)], binding.botId, binding.chatId, "session-a"))
      .toEqual(stopped);
    expect(readForumBinding([entry(binding), entry({ ...binding, sessionId: "other" })],
      binding.botId, binding.chatId, "session-a")).toEqual(binding);
  });
  it("rejects malformed, non-forum and partial bindings", () => {
    for (const value of [null, {}, { ...binding, version: 2 }, { ...binding, chatId: 1 },
      { ...binding, threadId: 0 }, { ...binding, threadId: 1.5 }, { ...binding, sessionId: "" },
      { ...binding, threadId: 11, state: "disconnected" }, { ...binding, threadId: null, state: "other" }]) {
      expect(parseForumBinding(value)).toBeUndefined();
    }
  });
  it("appends only via public custom entries and verifies in-memory retention, not disk durability", () => {
    const entries: unknown[] = [];
    const pi = { appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) };
    const ctx = { sessionManager: { getSessionId: () => "session-a", getEntries: () => entries } };
    appendForumBinding(pi as any, ctx as any, binding);
    expect(entries).toEqual([entry(binding)]);
    expect(() => appendForumBinding(pi as any, ctx as any, { ...binding, sessionId: "obsolete" })).toThrow(/obsolete/);
    expect(() => appendForumBinding({ appendEntry: () => {} } as any,
      { sessionManager: { getSessionId: () => "session-a", getEntries: () => [] } } as any, binding)).toThrow(/retained/);
  });
  it("fences reloads by generation and creates only group-internal topic links", () => {
    const target = { ...binding, threadId: 11, generation: "runtime-a" };
    expect(sameForumTarget(target, { ...target })).toBe(true);
    expect(sameForumTarget(target, { ...target, generation: "runtime-b" })).toBe(false);
    expect(sameForumTarget(target, { ...target, sessionId: "other" })).toBe(false);
    expect(sameForumTarget(undefined, undefined)).toBe(false);
    expect(forumTopicLink(-100123, 11)).toBe("https://t.me/c/123/11");
    expect(forumTopicLink(-123, 11)).toBeUndefined();
  });
});
