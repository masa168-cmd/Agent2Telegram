import { afterEach, describe, expect, it, vi } from "vitest";
import { registerLifecycleCommands } from "../commands/lifecycle.ts";
import type { CommandRegistry } from "../commands/register.ts";
import { runWithTelegramTurn } from "../turn-context.ts";
import { takePendingNotices, type PendingNotice } from "../pending-notices.ts";

type HandlerEntry = {
  name: string;
  description?: string;
  handler: (args: string, ctx: {
    ui: { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
    shutdown: ReturnType<typeof vi.fn>;
  }) => Promise<void>;
};

function makeRegistry(): { registry: CommandRegistry; handlers: Map<string, HandlerEntry> } {
  const handlers = new Map<string, HandlerEntry>();
  return {
    handlers,
    registry: {
      registerCommand: (name, options) => {
        handlers.set(name, {
          name,
          description: options.description,
          handler: options.handler as HandlerEntry["handler"],
        });
      },
    },
  };
}

describe("registerLifecycleCommands /quit and /exit", () => {
  it("does not register Telegram /quit or /exit (quitting is terminal-only; use /restart)", () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);

    expect(handlers.has("quit")).toBe(false);
    expect(handlers.has("exit")).toBe(false);
  });
});

describe("registerLifecycleCommands /reload", () => {
  const telegramTurn = { chatId: 42, messageThreadId: 7, sourceMessageId: 99, queuedAttachments: [] };

  function makeReloadCtx() {
    const queuedAtReload: PendingNotice[][] = [];
    const ctx = {
      ui: { notify: vi.fn(), confirm: vi.fn() },
      shutdown: vi.fn(),
      reload: vi.fn(async () => {
        // Whatever has to reach the chat must already be queued when the host
        // reloads: after ctx.reload() this runtime can no longer send.
        queuedAtReload.push(takePendingNotices());
      }),
    };
    return { ctx, queuedAtReload };
  }

  afterEach(() => {
    takePendingNotices();
  });

  it("queues the completion notice for the replacement runtime before reloading", async () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();

    await runWithTelegramTurn(telegramTurn, () => handlers.get("reload")!.handler("", ctx));

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(queuedAtReload[0]).toEqual([expect.objectContaining({
      chatId: 42,
      messageThreadId: 7,
      replyTo: 99,
      html: "✅ Reloaded.",
    })]);
  });

  it("queues nothing for a /reload typed in the terminal", async () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);
    const { ctx, queuedAtReload } = makeReloadCtx();

    await handlers.get("reload")!.handler("", ctx);

    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(queuedAtReload[0]).toEqual([]);
  });
});
