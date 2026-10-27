/**
 * OMP host: its `AgentSession` has no `bindExtensions()`, so capture resolves the
 * live top-level session through the process-global `AgentRegistry` instead.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const refs = new Map<string, { id: string; kind: string; session: unknown }>();
  const globalRegistry = {
    get: (id: string) => refs.get(id),
    list: () => [...refs.values()],
  };
  // OMP exports `AgentRegistry` as a class, not an instance.
  class AgentRegistry {
    static global() {
      return globalRegistry;
    }
  }
  return { refs, AgentRegistry };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  // OMP-shaped: exported class without the upstream prototype hook.
  AgentSession: class AgentSession {},
  AgentRegistry: mocks.AgentRegistry,
  MAIN_AGENT_ID: "Main",
}));

const { getActiveSession, installAgentSessionCapture } = await import("../session-capture.ts");

const mainSession = { kind: "session", prompt: () => undefined };
const subSession = { kind: "session", prompt: () => undefined };

describe("session capture on OMP", () => {
  it("reports installed without patching a missing bindExtensions", () => {
    expect(installAgentSessionCapture()).toBe(true);
    expect(getActiveSession()).toBeUndefined();
  });

  it("resolves the live main session from the agent registry", () => {
    mocks.refs.set("Main", { id: "Main", kind: "main", session: mainSession });

    expect(getActiveSession()).toBe(mainSession);
  });

  it("ignores a parked Main ref and never returns a subagent session", () => {
    mocks.refs.set("Main", { id: "Main", kind: "main", session: null });
    mocks.refs.set("0-Explore", { id: "0-Explore", kind: "sub", session: subSession });

    expect(getActiveSession()).toBeUndefined();
  });

  it("falls back to the main-kind ref when the host registers a custom agent id", () => {
    mocks.refs.clear();
    mocks.refs.set("my-root", { id: "my-root", kind: "main", session: mainSession });

    expect(getActiveSession()).toBe(mainSession);
  });

  it("tracks session replacement: the newest attached session wins", () => {
    const replacement = { kind: "session", prompt: () => undefined };
    mocks.refs.set("Main", { id: "Main", kind: "main", session: replacement });

    expect(getActiveSession()).toBe(replacement);
  });
});
