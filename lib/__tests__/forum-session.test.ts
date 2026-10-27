import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForumSession, forumBotId } from "../forum-session.ts";
import { FORUM_BINDING_TYPE, type ForumBinding } from "../forum-binding.ts";
import { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import { deliverForumUpdate, type ForumDelivery } from "../forum-router.ts";
import { TelegramApiRequestError } from "../telegram-api.ts";
import type { TelegramConfig } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const botId = forumBotId("123:fake-token-only");
const bound = (sessionId = "session-a", threadId = 11): ForumBinding => ({ version: 1,
  botId, chatId: -100123, sessionId, threadId });
const custom = (data: ForumBinding) => ({ type: "custom", customType: FORUM_BINDING_TYPE, data });

async function fixture(options: { entries?: unknown[]; sessionId?: string; api?: any; rootDir?: string; id?: string } = {}) {
  const rootDir = options.rootDir ?? await mkdtemp(join(tmpdir(), "forum-session-"));
  let sessionId = options.sessionId ?? "session-a";
  let config: TelegramConfig = { botToken: "123:fake-token-only", forumChatId: -100123, allowedUserId: 7 };
  let now = Date.now();
  const entries = options.entries ?? [];
  const coordinator = new TelegramInstanceCoordinator({ rootDir, token: config.botToken!,
    instanceId: options.id ?? "a", startedAt: new Date(now).toISOString(), isPidAlive: () => true });
  const ctx = { sessionManager: { getSessionId: () => sessionId, getEntries: () => entries,
    getSessionName: () => "Offline test" } } as any;
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
  return { session, coordinator, ctx, api, entries, config, rootDir, reconcile, onUpdate,
    advance: (ms: number) => { now += ms; }, setSessionId: (id: string) => { sessionId = id; },
    setConfig: (value: TelegramConfig) => { config = value; } };
}

describe("forum session lifecycle without a model or Telegram", () => {
  it("creates once, records intent first and becomes sendable only after publishing the new thread", async () => {
    const f = await fixture();
    await f.session.prepare(f.ctx);
    expect(f.session.getTarget()).toBeUndefined();
    await f.reconcile();
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.entries).toEqual([custom({ ...bound(), threadId: null, state: "create-unknown" }), custom(bound())]);
    expect(f.session.getTarget()).toBeUndefined();
    await f.reconcile();
    expect(f.session.getTarget()?.threadId).toBe(11);
    await f.reconcile();
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it("resumes, reloads, tree-navigates and compacts without creating another topic", async () => {
    const f = await fixture({ entries: [custom(bound())] });
    await f.session.prepare(f.ctx);
    await f.reconcile();
    const first = f.session.getTarget()!;
    expect(first.threadId).toBe(11);
    await f.session.prepare(f.ctx); // tree/compact/repeated context do not change session identity
    await f.reconcile();
    expect(f.session.getTarget()).toEqual(first);
    expect(f.api.mock.calls.map((c: any[]) => c[1])).toEqual(["reopenForumTopic"]);
    await f.session.close();
    await f.session.prepare(f.ctx);
    await f.reconcile();
    expect(f.session.getTarget()?.threadId).toBe(11);
    expect(f.session.getTarget()?.generation).not.toBe(first.generation);
    expect(f.api.mock.calls.map((c: any[]) => c[1])).toEqual(["reopenForumTopic", "reopenForumTopic"]);
  });
  it.each(["new", "fork", "clone"])("%s ignores inherited bindings and creates a distinct session topic", async reason => {
    const api = vi.fn(async (_token: string, method: string) => method === "createForumTopic" ? { message_thread_id: 22 } : true);
    const f = await fixture({ entries: [custom(bound())], sessionId: reason, api });
    await f.session.prepare(f.ctx);
    await f.reconcile(); await f.reconcile();
    expect(f.session.getTarget()).toMatchObject({ sessionId: reason, threadId: 22 });
    expect(api.mock.calls.map(c => c[1])).toEqual(["createForumTopic"]);
    expect(f.entries[0]).toEqual(custom(bound()));
  });
  it("never automatically recreates deleted topics or retries an unknown create result", async () => {
    const api = vi.fn(async () => { throw new TelegramApiRequestError("Bad Request: message thread not found"); });
    const f = await fixture({ entries: [custom(bound())], api });
    await f.session.prepare(f.ctx);
    await f.reconcile(); await f.reconcile();
    expect(api).toHaveBeenCalledTimes(1);
    expect(f.entries.at(-1)).toEqual(custom({ ...bound(), threadId: null, state: "topic-missing" }));
    expect(f.session.getTarget()).toBeUndefined();
    expect(f.session.lastError).toMatch(/删除/);
    const unknown = await fixture({ api: vi.fn(async () => { throw new Error("simulated lost HTTP response"); }) });
    await unknown.session.prepare(unknown.ctx);
    await unknown.reconcile(); unknown.advance(30_000); await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(1);
    expect(unknown.entries.at(-1)).toEqual(custom({ ...bound(), threadId: null, state: "create-unknown" }));
    await unknown.session.close(); await unknown.session.prepare(unknown.ctx); await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(1);
    expect(unknown.session.retryTopic()).toBe(true); // UI confirmation belongs to the local-only caller
    await unknown.reconcile();
    expect(unknown.api).toHaveBeenCalledTimes(2);
  });
  it("does not bind a late create response to the replacement Pi session", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise(r => { resolve = r; });
    const f = await fixture({ api: vi.fn(() => pending) });
    await f.session.prepare(f.ctx);
    const creating = f.reconcile();
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledTimes(1));
    f.setSessionId("replacement");
    await f.session.prepare(f.ctx);
    resolve({ message_thread_id: 99 }); await creating;
    expect(f.entries).toHaveLength(1); // original intent only; no new-session binding from the late result
    expect(f.session.registration()?.sessionId).toBe("replacement");
    expect(f.session.getTarget()).toBeUndefined();
  });
  it("rejects duplicate live session ownership before any create request", async () => {
    const f = await fixture({ entries: [custom(bound())] });
    await f.session.prepare(f.ctx); await f.reconcile();
    const other = await fixture({ rootDir: f.rootDir, id: "b", entries: [custom(bound())] });
    await other.session.prepare(other.ctx);
    expect((await other.reconcile()).forumConflict).toBe("a");
    expect(other.api).not.toHaveBeenCalled();
    expect(other.session.getTarget()).toBeUndefined();
  });
  it("fences output on stale heartbeats, wrong users, old callbacks and a changed config", async () => {
    const f = await fixture({ entries: [custom(bound())] });
    await f.session.prepare(f.ctx); const snapshot = await f.reconcile();
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
    await f.session.prepare(f.ctx); await f.reconcile();
    expect(f.session.getTarget()?.threadId).toBe(11);
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
