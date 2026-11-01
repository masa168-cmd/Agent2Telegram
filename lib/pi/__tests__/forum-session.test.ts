import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForumSession, canonicalCwd, forumBotId, forumTopicName } from "../forum-session.ts";
import { FORUM_BINDING_TYPE, type ForumBinding } from "../../core/forum-binding.ts";
import { TelegramInstanceCoordinator, forumTopicKey, telegramTokenHash } from "../../core/instance-coordinator.ts";
import { deliverForumUpdate, type ForumDelivery } from "../../core/forum-router.ts";
import { TelegramApiRequestError } from "../../core/telegram-api.ts";
import type { TelegramConfig } from "../../core/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const botId = forumBotId("123:fake-token-only");
const bound = (sessionId = "session-a", threadId = 11): ForumBinding => ({ version: 1,
  botId, chatId: -100123, sessionId, threadId });
const custom = (data: ForumBinding) => ({ type: "custom", customType: FORUM_BINDING_TYPE, data });

async function fixture(options: { entries?: unknown[]; sessionId?: string; api?: any; rootDir?: string; id?: string; cwd?: string } = {}) {
  const rootDir = options.rootDir ?? await mkdtemp(join(tmpdir(), "forum-session-"));
  let sessionId = options.sessionId ?? "session-a";
  let config: TelegramConfig = { botToken: "123:fake-token-only", forumChatId: -100123, allowedUserId: 7 };
  let now = Date.now();
  const entries = options.entries ?? [];
  const coordinator = new TelegramInstanceCoordinator({ rootDir, token: config.botToken!,
    instanceId: options.id ?? "a", startedAt: new Date(now).toISOString(), isPidAlive: () => true });
  const cwd = options.cwd ?? "/fake/a";
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries,
    getSessionName: () => "Offline test" } } as any;
  const topicKey = forumTopicKey(botId, -100123, canonicalCwd(cwd));
  const mapped = () => coordinator.readForumTopic(topicKey);
  const methods = () => api.mock.calls.map((c: any[]) => c[1]);
  const onUpdate = vi.fn(async (_d: ForumDelivery) => {});
  const api = options.api ?? vi.fn(async (_token: string, method: string) =>
    method === "createForumTopic" ? { message_thread_id: 11 } : true);
  const session = new ForumSession({ pi: { appendEntry: (customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  } } as any, getConfig: () => config, getCoordinator: () => coordinator, onUpdate,
    onChange: () => {}, onError: () => {}, callApi: api, now: () => now });
  cleanups.push(async () => { await session.close(); if (!options.rootDir) await rm(rootDir, { recursive: true, force: true }); });
  const reconcile = async () => {
    const registration = session.registration();
    const snapshot = await coordinator.reconcile({ cwd: "/fake", ...(registration ? { forum: registration } : {}) });
    await session.reconciled(registration, snapshot.forumConflict);
    return snapshot;
  };
  return { session, coordinator, ctx, api, entries, config, rootDir, reconcile, onUpdate, mapped, methods,
    advance: (ms: number) => { now += ms; }, setSessionId: (id: string) => { sessionId = id; },
    setConfig: (value: TelegramConfig) => { config = value; } };
}

describe("forum session lifecycle without a model or Telegram", () => {
  it("creates one directory topic, records intent first and is sendable only after publishing it", async () => {
    const f = await fixture();
    await f.session.prepare(f.ctx);
    expect(f.session.getTarget()).toBeUndefined();
    await f.reconcile();
    expect(f.methods()).toEqual(["createForumTopic"]);
    expect(await f.mapped()).toEqual({ threadId: 11, cwd: "/fake/a" });
    expect(f.entries).toEqual([]); // nothing is written into the Pi session any more
    expect(f.session.getTarget()).toBeUndefined();
    await f.reconcile();
    expect(f.session.getTarget()).toMatchObject({ sessionId: "session-a", threadId: 11 });
    await f.reconcile();
    expect(f.methods()).toEqual(["createForumTopic"]);
  });
  it("names topics by home-relative directory", async () => {
    expect(forumTopicName("/home/u/pi-main", "/home/u")).toBe("pi-main");
    expect(forumTopicName("/home/u/work/tmp", "/home/u")).toBe("work/tmp");
    expect(forumTopicName("/home/u", "/home/u")).toBe("~");
    expect(forumTopicName("/home/user2", "/home/u")).toBe("/home/user2");
    expect(forumTopicName("/srv/x", "/home/u")).toBe("/srv/x");
    const f = await fixture();
    await f.session.prepare(f.ctx); await f.reconcile();
    expect(f.api.mock.calls[0][2]).toMatchObject({ name: "/fake/a" });
  });
  it.each(["new", "fork", "resume"])("%s in the same directory reuses the topic instead of creating one", async next => {
    const f = await fixture();
    await f.session.prepare(f.ctx); await f.reconcile(); await f.reconcile();
    const first = f.session.getTarget()!;
    f.setSessionId(next);
    await f.session.prepare(f.ctx); await f.reconcile(); await f.reconcile();
    expect(f.session.getTarget()).toMatchObject({ sessionId: next, threadId: 11 });
    expect(f.session.getTarget()!.generation).not.toBe(first.generation);
    expect(f.methods()).toEqual(["createForumTopic", "reopenForumTopic"]);
  });
  it("a later Pi process in the same directory reuses the topic; another directory gets its own", async () => {
    const f = await fixture();
    await f.session.prepare(f.ctx); await f.reconcile();
    await f.session.close();
    const again = await fixture({ rootDir: f.rootDir, id: "b", sessionId: "session-b" });
    await again.session.prepare(again.ctx); await again.reconcile(); await again.reconcile();
    expect(again.session.getTarget()).toMatchObject({ sessionId: "session-b", threadId: 11 });
    expect(again.methods()).toEqual(["reopenForumTopic"]);
    const api = vi.fn(async (_token: string, method: string) => method === "createForumTopic" ? { message_thread_id: 22 } : true);
    const other = await fixture({ rootDir: f.rootDir, id: "c", sessionId: "session-c", cwd: "/fake/c", api });
    await other.session.prepare(other.ctx); await other.reconcile(); await other.reconcile();
    expect(other.session.getTarget()).toMatchObject({ threadId: 22 });
    expect(api.mock.calls.map(c => c[1])).toEqual(["createForumTopic"]);
  });
  it("seeds the directory map once from a pre-directory session binding", async () => {
    const f = await fixture({ entries: [custom(bound())] });
    await f.session.prepare(f.ctx); await f.reconcile(); await f.reconcile();
    expect(f.session.getTarget()?.threadId).toBe(11);
    expect(f.methods()).toEqual(["reopenForumTopic"]);
    expect(await f.mapped()).toEqual({ threadId: 11, cwd: "/fake/a" });
  });
  it("recreates a confirmed deleted topic once, but never retries an unknown create result", async () => {
    const api = vi.fn(async (_token: string, method: string) => {
      if (method === "reopenForumTopic") throw new TelegramApiRequestError("Bad Request: message thread not found");
      return { message_thread_id: 12 };
    });
    const f = await fixture({ entries: [custom(bound())], api });
    await f.session.prepare(f.ctx); await f.reconcile(); await f.reconcile();
    expect(f.methods()).toEqual(["reopenForumTopic", "createForumTopic"]);
    expect(f.session.getTarget()?.threadId).toBe(12);
    expect(await f.mapped()).toEqual({ threadId: 12, cwd: "/fake/a" });

    const unknown = await fixture({ api: vi.fn(async () => { throw new Error("simulated lost HTTP response"); }) });
    await unknown.session.prepare(unknown.ctx);
    await unknown.reconcile(); unknown.advance(30_000); await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(1);
    expect(await unknown.mapped()).toEqual({ threadId: null, state: "create-unknown", cwd: "/fake/a" });
    expect(unknown.session.lastError).toMatch(/retry/);
    await unknown.session.close(); await unknown.session.prepare(unknown.ctx); await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(1);
    expect(unknown.session.retryTopic()).toBe(true); // UI confirmation belongs to the local-only caller
    await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(2);
  });
  it("records a late create result for the directory without binding it to the replaced session", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(r => { resolve = r; });
    const f = await fixture({ api: vi.fn(() => pending) });
    await f.session.prepare(f.ctx);
    const creating = f.reconcile();
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledTimes(1));
    f.setSessionId("replacement");
    await f.session.prepare(f.ctx);
    await f.reconcile(); // the unknown intent blocks a duplicate create from the replacement
    expect(f.api).toHaveBeenCalledTimes(1);
    resolve({ message_thread_id: 99 }); await creating;
    expect(f.session.getTarget()).toBeUndefined();
    expect(await f.mapped()).toEqual({ threadId: 99, cwd: "/fake/a" });
    f.advance(3000); await f.reconcile(); await f.reconcile();
    expect(f.session.getTarget()).toMatchObject({ sessionId: "replacement", threadId: 99 });
  });
  it("lets only one online Pi per directory claim the topic", async () => {
    const f = await fixture();
    await f.session.prepare(f.ctx); await f.reconcile();
    const other = await fixture({ rootDir: f.rootDir, id: "b", sessionId: "session-b" });
    await other.session.prepare(other.ctx);
    expect((await other.reconcile()).forumConflict).toBe("a");
    expect(other.api).not.toHaveBeenCalled();
    expect(other.session.getTarget()).toBeUndefined();
    expect(other.session.lastError).toMatch(/目录/);
  });
  it("fails closed without any Telegram request when the directory map is unreadable", async () => {
    const f = await fixture();
    const dir = join(f.rootDir, "tg-runtime", telegramTokenHash("123:fake-token-only"));
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, "topics.json"), "{broken");
    await f.session.prepare(f.ctx); await f.reconcile();
    expect(f.api).not.toHaveBeenCalled();
    expect(f.session.getTarget()).toBeUndefined();
    expect(f.session.lastError).toMatch(/对照表/);
  });
  it("fences output on stale heartbeats, wrong users, old callbacks and a changed config", async () => {
    const f = await fixture({ entries: [custom(bound())] });
    // First round loads the directory topic; the second publishes it (production: onChange reconciles).
    await f.session.prepare(f.ctx); await f.reconcile(); const snapshot = await f.reconcile();
    const target = f.session.getTarget()!;
    const route = f.session.registration()!;
    const update = { update_id: 1, message: { message_id: 51, message_thread_id: 11,
      from: { id: 7 }, chat: { id: -100123, type: "supergroup" }, text: "hi" } };
    expect((await deliverForumUpdate(route, { target, leader: snapshot.active, update })).accepted).toBe(true);
    const query = { update_id: 2, callback_query: { id: "callback", from: { id: 7 }, data: "pick",
      message: { message_id: 81, message_thread_id: 11, chat: { id: -100123 } } } };
    expect((await deliverForumUpdate(route, { target, leader: snapshot.active, update: query })).accepted).toBe(false);
    f.session.rememberMessage(81, true);
    expect((await deliverForumUpdate(route, { target, leader: snapshot.active, update: query })).accepted).toBe(true);
    f.advance(10_001);
    expect(f.session.lease()).toBeUndefined();
    expect((await deliverForumUpdate(route, { target, leader: snapshot.active, update: { ...update, update_id: 3 } })).accepted).toBe(false);
    await f.reconcile(); expect(f.session.lease()).toBeTruthy();
    f.setConfig({ ...f.config, forumChatId: -100999 });
    expect(f.session.lease()).toBeUndefined();
  });
  it("handles an already open resumed topic without duplicating it", async () => {
    const f = await fixture({ entries: [custom(bound())], api: vi.fn(async () => { throw new TelegramApiRequestError("TOPIC_NOT_MODIFIED"); }) });
    await f.session.prepare(f.ctx); await f.reconcile(); await f.reconcile();
    expect(f.session.getTarget()?.threadId).toBe(11);
    expect(f.methods()).toEqual(["reopenForumTopic"]);
    expect(f.entries).toHaveLength(1);
    expect(f.session.retryTopic()).toBe(false);
  });
  it("keeps malformed setup and missing pairing fail-closed instead of using activeChatId", async () => {
    const f = await fixture();
    f.setConfig({ ...f.config, forumChatId: 1, activeChatId: 99 });
    await f.session.prepare(f.ctx);
    expect(f.session.enabled).toBe(true);
    expect(f.session.registration()).toBeUndefined();
    expect(f.session.lastError).toMatch(/群 ID/);
    f.setConfig({ ...f.config, allowedUserId: undefined });
    await f.session.prepare(f.ctx);
    expect(f.session.registration()).toBeUndefined();
    expect(f.api).not.toHaveBeenCalled();
  });
});
