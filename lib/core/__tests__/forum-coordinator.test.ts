import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import type { ForumRegistration } from "../forum-router.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const route = (sessionId: string, threadId: number | null, generation = sessionId): ForumRegistration => ({
  botId: "telegram:123", chatId: -100123, sessionId, threadId, generation,
  port: 1234, capability: "fake-local-capability-for-tests-only",
});
async function setup() {
  const rootDir = await mkdtemp(join(tmpdir(), "forum-coordinator-"));
  roots.push(rootDir);
  let now = Date.now();
  const create = (instanceId: string) => new TelegramInstanceCoordinator({ rootDir, instanceId,
    token: "123:fake-test-token", startedAt: new Date(now).toISOString(), now: () => now, isPidAlive: () => true });
  return { a: create("a"), b: create("b"), advance: (ms: number) => { now += ms; } };
}

describe("atomic forum route claims", () => {
  it("allows two online sessions while preserving a single elected Bot receiver", async () => {
    const { a, b } = await setup();
    const first = await a.reconcile({ cwd: "/fake/a", forum: route("session-a", 11) });
    const second = await b.reconcile({ cwd: "/fake/b", forum: route("session-b", 22) });
    expect(second.forumConflict).toBeUndefined();
    expect(second.instances.filter(i => i.forum)).toHaveLength(2);
    expect(a.isActive()).toBe(true);
    expect(b.isActive()).toBe(false);
    expect(await b.isCurrentLeader(first.active)).toBe(true);
    const next = await a.switchTo("b", undefined, first.active);
    expect(await b.isCurrentLeader(first.active)).toBe(false);
    expect(await b.isCurrentLeader(next)).toBe(true);
  });
  it.each([
    ["same session", route("session-a", 22)],
    ["same topic", route("session-b", 11)],
    ["unbound same session", route("session-a", null)],
  ])("rejects %s without publishing a competing route", async (_label, rejected) => {
    const { a, b } = await setup();
    await a.reconcile({ cwd: "/fake/a", forum: route("session-a", 11) });
    const snapshot = await b.reconcile({ cwd: "/fake/b", forum: rejected as ForumRegistration });
    expect(snapshot.forumConflict).toBe("a");
    expect(snapshot.instances.find(i => i.id === "b")?.forum).toBeUndefined();
    expect((await a.reconcile({ cwd: "/fake/a", forum: route("session-a", 11) })).forumConflict).toBeUndefined();
  });
  it("serializes concurrent initial claims, including blank sessions before topic creation", async () => {
    const { a, b } = await setup();
    const results = await Promise.all([
      a.reconcile({ cwd: "/fake/a", forum: route("same-blank", null, "a1") }),
      b.reconcile({ cwd: "/fake/b", forum: route("same-blank", null, "b1") }),
    ]);
    expect(results.filter(r => r.forumConflict)).toHaveLength(1);
    expect((await a.listInstances()).filter(i => i.forum)).toHaveLength(1);
  });
  it("permits takeover after expiry and rejects a previous leader or late generation withdrawal", async () => {
    const { a, b, advance } = await setup();
    const previous = await a.reconcile({ cwd: "/fake/a", forum: route("session-a", 11, "old") });
    advance(20_000);
    const next = await b.reconcile({ cwd: "/fake/b", forum: route("session-a", 11, "new") });
    expect(next.forumConflict).toBeUndefined();
    expect(next.active.instanceId).toBe("b");
    expect(await b.isCurrentLeader(previous.active)).toBe(false);
    await b.releaseForumRoute("old");
    expect((await b.listInstances()).find(i => i.id === "b")?.forum?.generation).toBe("new");
    await b.releaseForumRoute("new");
    expect((await b.listInstances()).find(i => i.id === "b")?.forum).toBeUndefined();
  });
});
