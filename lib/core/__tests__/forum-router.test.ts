import { afterEach, describe, expect, it, vi } from "vitest";
import { ForumInbox, authorizedForumUpdate, deliverForumUpdate, findForumRoute,
  type ForumDelivery, type ForumRegistration } from "../forum-router.ts";
import { sameForumTarget } from "../forum-binding.ts";
import type { TelegramInstanceMetadata } from "../instance-coordinator.ts";
import type { TelegramUpdate } from "../types.ts";

const target = { botId: "telegram:123", chatId: -100123, sessionId: "a", threadId: 11, generation: "a1" };
const route: ForumRegistration = { ...target, port: 1234, capability: "fake-local-capability-for-tests-only", messageIds: [81] };
const update = (id = 1): TelegramUpdate => ({ update_id: id,
  message: { message_id: id, chat: { id: target.chatId, type: "supergroup" }, message_thread_id: 11,
    from: { id: 7 }, text: "hello" } });
const delivery = (id = 1): ForumDelivery => ({ target, leader: { instanceId: "leader", generation: 1 }, update: update(id) });
const peer = (forum: ForumRegistration, id = "a"): TelegramInstanceMetadata => ({ id, forum,
  pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), cwd: "/fake" });
const inboxes: ForumInbox[] = [];
afterEach(() => { for (const inbox of inboxes.splice(0)) inbox.close(); });

async function start(onUpdate: (d: ForumDelivery) => Promise<void>, authorize?: (d: ForumDelivery) => Promise<boolean>) {
  const inbox = new ForumInbox({ onUpdate, authorize: authorize ?? (async d => sameForumTarget(target, d.target)
    && authorizedForumUpdate(d.update, target.chatId, 7)), onError: () => {} });
  inboxes.push(inbox);
  return { ...route, port: await inbox.start(), capability: inbox.capability };
}

describe("forum routing", () => {
  it("requires both the fixed group and the paired human, including callbacks", () => {
    expect(authorizedForumUpdate(update(), target.chatId, 7)).toBe(true);
    expect(authorizedForumUpdate(update(), -999, 7)).toBe(false);
    expect(authorizedForumUpdate(update(), target.chatId, 8)).toBe(false);
    expect(authorizedForumUpdate({ ...update(), message: { ...update().message!, from: { id: 7, is_bot: true } } }, target.chatId, 7)).toBe(false);
    expect(authorizedForumUpdate({ ...update(), message: { ...update().message!, from: undefined } }, target.chatId, 7)).toBe(false);
  });
  it("selects only one matching topic and never falls back to General or the active instance", () => {
    const peers = [peer(route), peer({ ...route, sessionId: "b", threadId: 22, generation: "b1" }, "b")];
    expect(findForumRoute(update(), peers, target.botId, target.chatId, 7)?.target).toEqual(target);
    expect(findForumRoute({ ...update(), message: { ...update().message!, message_thread_id: 22 } }, peers,
      target.botId, target.chatId, 7)?.instance.id).toBe("b");
    for (const thread of [undefined, 1, 33]) {
      expect(findForumRoute({ ...update(), message: { ...update().message!, message_thread_id: thread } }, peers,
        target.botId, target.chatId, 7)).toBeUndefined();
    }
    expect(findForumRoute(update(), [...peers, peer(route, "duplicate")], target.botId, target.chatId, 7)).toBeUndefined();
  });
  it("restores missing callback threads only from recorded bot message ownership", () => {
    const callback: TelegramUpdate = { update_id: 3, callback_query: { id: "cb", from: { id: 7 }, data: "pick",
      message: { message_id: 81, chat: { id: target.chatId } } } };
    const result = findForumRoute(callback, [peer(route)], target.botId, target.chatId, 7);
    expect(result?.update.callback_query?.message?.message_thread_id).toBe(11);
    expect(callback.callback_query?.message?.message_thread_id).toBeUndefined();
    expect(findForumRoute(callback, [peer({ ...route, messageIds: [] })], target.botId, target.chatId, 7)).toBeUndefined();
    expect(findForumRoute(callback, [peer(route), peer({ ...route, threadId: 22 }, "b")], target.botId, target.chatId, 7)).toBeUndefined();
  });
});

describe("loopback forum inbox", () => {
  it("delivers the unchanged raw message exactly once and ACKs duplicate update ids", async () => {
    const handled = vi.fn(async (_: ForumDelivery) => {});
    const endpoint = await start(handled);
    expect(await deliverForumUpdate(endpoint, delivery())).toEqual({ accepted: true });
    expect(await deliverForumUpdate(endpoint, delivery())).toEqual({ accepted: true, duplicate: true });
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(delivery());
  });
  it("does not block subsequent dialog answers while the first command awaits a picker", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const handled: number[] = [];
    const endpoint = await start(async d => { handled.push(d.update.update_id); if (d.update.update_id === 1) await pending; });
    try {
      expect((await deliverForumUpdate(endpoint, delivery(1))).accepted).toBe(true);
      expect((await deliverForumUpdate(endpoint, delivery(2))).accepted).toBe(true);
      expect(handled).toEqual([1, 2]);
    } finally { release(); }
  });
  it("rejects stale targets, changed leaders, wrong users and wrong capabilities before dispatch", async () => {
    const handled = vi.fn(async (_: ForumDelivery) => {});
    let leaderGeneration = 1;
    const endpoint = await start(handled, async d => sameForumTarget(target, d.target)
      && d.leader.generation === leaderGeneration && authorizedForumUpdate(d.update, target.chatId, 7));
    expect((await deliverForumUpdate(endpoint, { ...delivery(), target: { ...target, generation: "old" } })).accepted).toBe(false);
    leaderGeneration = 2;
    expect((await deliverForumUpdate(endpoint, delivery())).accepted).toBe(false);
    expect((await deliverForumUpdate({ ...endpoint, capability: route.capability }, delivery())).accepted).toBe(false);
    expect(handled).not.toHaveBeenCalled();
  });
  it("handles malformed bodies without dispatch and reports unavailable delivery as unknown without retry", async () => {
    const handled = vi.fn(async (_: ForumDelivery) => {});
    const endpoint = await start(handled);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/update`, { method: "POST",
      headers: { authorization: `Bearer ${endpoint.capability}` }, body: "{broken" });
    expect(response.status).toBe(400);
    expect(handled).not.toHaveBeenCalled();
    inboxes.at(-1)!.close();
    await expect(deliverForumUpdate(endpoint, delivery())).rejects.toThrow(/result unknown/);
  });
});
