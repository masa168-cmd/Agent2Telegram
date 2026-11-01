/**
 * Upstream pi host: `bindExtensions()` is the capture point, and the patched
 * prototype still replaces the runner's shutdown handler.
 */
import { AgentSession as AgentSessionExport } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  shutdownHandler: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSession: class AgentSession {
    extensionRunner = {
      getUIContext: () => ({ notify: mocks.notify }),
      shutdownHandler: mocks.shutdownHandler,
    };

    async bindExtensions(): Promise<void> {}
  },
}));

const { getActiveSession, installAgentSessionCapture, canRequestHostShutdown, requestHostShutdown } = await import("../session-capture.ts");

/** The mock keeps upstream's constructor signature; these tests build bare sessions. */
const FakeAgentSession = AgentSessionExport as unknown as new () => {
  extensionRunner: { shutdownHandler: () => void };
  bindExtensions(bindings: unknown): Promise<void>;
};

describe("session capture on upstream pi", () => {
  it("captures the session bound by the mode", async () => {
    expect(installAgentSessionCapture()).toBe(true);

    const session = new FakeAgentSession();
    await session.bindExtensions({});

    expect(getActiveSession()).toBe(session);
  });

  it("replaces the shutdown handler so a Telegram command cannot exit the TUI", async () => {
    const session = new FakeAgentSession();
    await session.bindExtensions({});

    session.extensionRunner.shutdownHandler();

    expect(mocks.notify).toHaveBeenCalledWith(
      "⚠️ Shutdown requested. Use Ctrl+C in terminal to stop pi.",
      "info",
    );
    expect(mocks.shutdownHandler).not.toHaveBeenCalled();
  });

  it("keeps the host's real exit for /restart, bound to the active session only", async () => {
    mocks.shutdownHandler.mockClear();
    const session = new FakeAgentSession();
    await session.bindExtensions({});
    expect(canRequestHostShutdown()).toBe(true);
    expect(requestHostShutdown()).toBe(true);
    expect(mocks.shutdownHandler).toHaveBeenCalledTimes(1);

    // Rebinding the same runner must not save our notify-only replacement as the exit.
    await session.bindExtensions({});
    mocks.shutdownHandler.mockClear();
    expect(requestHostShutdown()).toBe(true);
    expect(mocks.shutdownHandler).toHaveBeenCalledTimes(1);

    // A replacement session whose runner has no handler yields no exit at all.
    const other = new FakeAgentSession();
    (other.extensionRunner as { shutdownHandler?: unknown }).shutdownHandler = undefined;
    await other.bindExtensions({});
    expect(canRequestHostShutdown()).toBe(false);
    expect(requestHostShutdown()).toBe(false);
  });
});
