/**
 * Notices that must survive an extension-runtime replacement (`/new` on pi,
 * `/reload` on both hosts): the queue lives on globalThis, the old runtime only
 * queues, the replacement runtime delivers from its reconcile loop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverPendingNotices, queuePendingNotice, takePendingNotices, type PendingNotice } from "../pending-notices.ts";
import type { TelegramTransport } from "../types.ts";

const notice = (over: Partial<PendingNotice> = {}): PendingNotice => ({
  chatId: 42,
  html: "✅ Done",
  createdAt: Date.now(),
  ...over,
});

function fakeTransport() {
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const sends: Array<{ chatId: number; text: string; messageThreadId?: number; replyToMessageId?: number }> = [];
  const transport: Pick<TelegramTransport, "sendText" | "editText"> = {
    editText: vi.fn(async (chatId: number, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
    }),
    sendText: vi.fn(async (chatId: number, text: string, messageThreadId?: number, replyToMessageId?: number) => {
      sends.push({ chatId, text, messageThreadId, replyToMessageId });
      return [{ message_id: 1 }];
    }),
  };
  return { transport, edits, sends };
}

afterEach(() => {
  // The queue is process-global: drain whatever a test left behind.
  takePendingNotices();
});

describe("pending notice queue", () => {
  it("queues a notice and empties the queue once taken", () => {
    queuePendingNotice(notice());
    expect(takePendingNotices().map((n) => n.html)).toEqual(["✅ Done"]);
    expect(takePendingNotices()).toEqual([]);
  });

  it("drops notices older than two minutes", () => {
    queuePendingNotice(notice({ html: "fresh", createdAt: Date.now() - 119_000 }));
    queuePendingNotice(notice({ html: "stale", createdAt: Date.now() - 121_000 }));
    expect(takePendingNotices().map((n) => n.html)).toEqual(["fresh"]);
  });

  it("keeps at most 20 notices and drops the oldest", () => {
    for (let i = 0; i < 25; i++) queuePendingNotice(notice({ html: `n${i}` }));
    const taken = takePendingNotices();
    expect(taken.map((n) => n.html)).toEqual(
      Array.from({ length: 20 }, (_, i) => `n${i + 5}`),
    );
  });
});

describe("deliverPendingNotices (what the replacement runtime's reconcile does)", () => {
  it("edits the ack when the notice carries a message id, sends otherwise", () => {
    queuePendingNotice(notice({ editMessageId: 7, html: "<b>▶️ /new</b>\n\n✅ New session started" }));
    queuePendingNotice(notice({ messageThreadId: 3, replyTo: 9, html: "✅ Reloaded." }));

    const { transport, edits, sends } = fakeTransport();
    deliverPendingNotices(transport);

    expect(edits).toEqual([{ chatId: 42, messageId: 7, text: "<b>▶️ /new</b>\n\n✅ New session started" }]);
    expect(sends).toEqual([{ chatId: 42, text: "✅ Reloaded.", messageThreadId: 3, replyToMessageId: 9 }]);
  });

  it("a second reconcile re-sends nothing", () => {
    queuePendingNotice(notice());
    const { transport, sends } = fakeTransport();

    deliverPendingNotices(transport);
    deliverPendingNotices(transport);

    expect(sends).toHaveLength(1);
  });

  it("never re-delivers a notice that expired before the reconcile", () => {
    queuePendingNotice(notice({ createdAt: Date.now() - 121_000 }));
    const { transport, sends } = fakeTransport();

    deliverPendingNotices(transport);

    expect(sends).toEqual([]);
  });

  it("swallows a failed delivery", async () => {
    queuePendingNotice(notice());
    const { transport, sends } = fakeTransport();
    vi.mocked(transport.sendText).mockRejectedValueOnce(new Error("403 Forbidden"));

    expect(() => deliverPendingNotices(transport)).not.toThrow();
    // Let the rejection handler run so an unhandled rejection would surface here.
    await Promise.resolve();
    await Promise.resolve();
    expect(sends).toEqual([]);
  });
});
