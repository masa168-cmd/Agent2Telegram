import { describe, expect, it, vi } from "vitest";
import { checkpointCurrentUpdateCursor, processTelegramUpdatesBatch } from "../polling.ts";
import type { TelegramConfig, TelegramUpdate } from "../types.ts";

const update = (id: number): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: 123 }, from: { id: 456 }, text: `message ${id}` },
});

describe("processTelegramUpdatesBatch", () => {
  it("stops at a failed update and does not advance offset past it", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    const handled: number[] = [];
    const persisted: number[] = [];
    const errors: { error: unknown; context?: string }[] = [];

    const processed = await processTelegramUpdatesBatch([update(10), update(11), update(12)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async (item) => {
        handled.push(item.update_id);
        if (item.update_id === 11) throw new Error("boom 11");
      }),
      onError: (error, context) => { errors.push({ error, context }); },
    });

    expect(processed).toBe(false);
    expect(handled).toEqual([10, 11]);
    expect(persisted).toEqual([10]);
    expect(config.lastUpdateId).toBe(10);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBeInstanceOf(Error);
    expect(errors[0].context).toBe("processing");
  });

  it("stops before the next update when the instance loses its active lease", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 30 };
    let active = true;
    const handled: number[] = [];

    const processed = await processTelegramUpdatesBatch([update(31), update(32)], {
      getConfig: () => config,
      setConfig: (next) => {
        config = next;
        active = false;
      },
      persistConfig: vi.fn(async () => undefined),
      shouldProcess: () => active,
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: vi.fn(),
    });

    expect(processed).toBe(true); // losing the lease is not a retryable failure
    expect(handled).toEqual([31]);
    expect(config.lastUpdateId).toBe(31);
  });

  it("stops when persisting an update fails so later updates cannot skip it", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 20 };
    const handled: number[] = [];
    const persisted: number[] = [];
    const errors: { error: unknown; context?: string }[] = [];

    const processed = await processTelegramUpdatesBatch([update(21), update(22)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => {
        persisted.push(next.lastUpdateId!);
        if (next.lastUpdateId === 21) throw new Error("persist failed");
      }),
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: (error, context) => { errors.push({ error, context }); },
    });

    expect(processed).toBe(false);
    expect(errors[0].context).toBe("processing");
    expect(handled).toEqual([21]);
    expect(persisted).toEqual([21]);
    expect(config.lastUpdateId).toBe(20);
    expect(errors).toHaveLength(1);
  });

  it("skips re-delivered updates the cursor already processed", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 10 };
    const handled: number[] = [];
    const persisted: number[] = [];

    const processed = await processTelegramUpdatesBatch([update(10), update(11)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async (item) => { handled.push(item.update_id); }),
      onError: vi.fn(),
    });

    expect(processed).toBe(true);
    expect(handled).toEqual([11]);
    expect(persisted).toEqual([11]);
    expect(config.lastUpdateId).toBe(11);
  });
});

describe("checkpointCurrentUpdateCursor", () => {
  it("commits the cursor before a destructive handler when it checkpoints", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    const persisted: number[] = [];
    let cursorAtDestructiveCall: number | undefined;

    const processed = await processTelegramUpdatesBatch([update(10)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async (next) => { persisted.push(next.lastUpdateId!); }),
      handleUpdate: vi.fn(async () => {
        // A session-replacement handler checkpoints the cursor, then reads it
        // the way the replacement runtime would after re-activation.
        await checkpointCurrentUpdateCursor();
        cursorAtDestructiveCall = config.lastUpdateId;
      }),
      onError: () => {},
    });

    expect(processed).toBe(true);
    // The checkpoint advanced the cursor to this update before the destructive
    // call, so a replacement runtime re-reading the cursor will not re-fetch it.
    expect(cursorAtDestructiveCall).toBe(10);
    // The normal post-handler persist is idempotent (same id).
    expect(persisted).toEqual([10, 10]);
  });

  it("routes the checkpoint through persistUpdate so the coordinator cursor stays consistent", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    const persistedVia: string[] = [];

    await processTelegramUpdatesBatch([update(10)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistUpdate: vi.fn(async (_next, item) => { persistedVia.push(`update:${item.update_id}`); }),
      persistConfig: vi.fn(async () => { persistedVia.push("config"); }),
      handleUpdate: vi.fn(async () => { await checkpointCurrentUpdateCursor(); }),
      onError: () => {},
    });

    // The replacement runtime reads the coordinator cursor, so the checkpoint
    // must use persistUpdate (not the project-only persistConfig).
    expect(persistedVia).toEqual(["update:10", "update:10"]);
  });

  it("leaves the cursor behind the update when a handler does not checkpoint", async () => {
    let config: TelegramConfig = { botToken: "token", lastUpdateId: 9 };
    let cursorDuringHandler: number | undefined;

    await processTelegramUpdatesBatch([update(10)], {
      getConfig: () => config,
      setConfig: (next) => { config = next; },
      persistConfig: vi.fn(async () => {}),
      handleUpdate: vi.fn(async () => { cursorDuringHandler = config.lastUpdateId; }),
      onError: () => {},
    });

    // Without a checkpoint the cursor is still the previous one while the
    // handler runs — a replacement runtime would re-fetch this update.
    expect(cursorDuringHandler).toBe(9);
  });

  it("is a no-op outside an update context", async () => {
    expect(await checkpointCurrentUpdateCursor()).toBe(false);
  });
});
