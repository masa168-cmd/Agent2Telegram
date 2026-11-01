import { afterEach, describe, expect, it, vi } from "vitest";

const exit = vi.hoisted(() => ({ available: true, run: vi.fn(() => true) }));
const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  // Only spawn is faked (no real helper process); execFileSync stays real for the fake-tmux tests.
  return { ...real, spawn: (...args: unknown[]) => { spawned.calls.push(args); return { unref: () => {} }; } };
});
vi.mock("../session-capture.ts", () => ({
  canRequestHostShutdown: () => exit.available,
  requestHostShutdown: () => exit.available && exit.run(),
}));
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planRestart, registerLifecycleCommands } from "../commands/lifecycle.ts";
import { restartCommand, runRestart, shellQuote } from "../restart-helper.mjs";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const tmux = { TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%9" };
const sessionFile = fileURLToPath(import.meta.url); // any file that exists on disk
const ctx = (over: Record<string, unknown> = {}) => ({ cwd: "/home/u/tmp", isIdle: () => true, hasPendingMessages: () => false,
  sessionManager: { getSessionFile: () => sessionFile }, ...over }) as any;

describe("/restart planning", () => {
  it("builds a job for an idle tmux Pi with a session file", () => {
    const plan = planRestart(ctx(), tmux, () => true);
    expect(plan).toMatchObject({ job: { pid: process.pid, pane: "%9", cwd: "/home/u/tmp", sessionFile } });
  });
  it.each([
    ["outside tmux", ctx(), {}, /tmux/],
    ["a malformed pane id", ctx(), { ...tmux, TMUX_PANE: "%9; rm" }, /tmux/],
    ["--no-session", ctx({ sessionManager: { getSessionFile: () => undefined } }), tmux, /no-session/],
    ["a session not yet written to disk", ctx({ sessionManager: { getSessionFile: () => "/nonexistent/s.jsonl" } }), tmux, /尚未写入磁盘/],
    ["a running task", ctx({ isIdle: () => false }), tmux, /\/stop/],
    ["queued messages", ctx({ hasPendingMessages: () => true }), tmux, /\/stop/],
  ])("refuses %s", (_name, c, env, message) => {
    const plan = planRestart(c, env as NodeJS.ProcessEnv, () => true);
    expect("error" in plan && plan.error).toMatch(message);
  });
  it("refuses before starting the helper when Pi's real exit was not captured", () => {
    const plan = planRestart(ctx(), tmux, () => false);
    expect("error" in plan && plan.error).toMatch(/退出接口/);
  });
  it("restarts at once without a confirmation, and does not quit when refused", async () => {
    const handlers = new Map<string, any>();
    registerLifecycleCommands({ registerCommand: (name, o) => handlers.set(name, o.handler) });
    const shutdown = vi.fn(); const notify = vi.fn(); const confirm = vi.fn(async () => true);
    const agentDir = await mkdtemp(join(tmpdir(), "restart-agent-")); dirs.push(agentDir);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("TMUX", ""); vi.stubEnv("TMUX_PANE", "");
    exit.run.mockClear(); spawned.calls.length = 0;
    await handlers.get("restart")("", ctx({ ui: { notify, confirm }, shutdown }));
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/tmux/), "warning");
    expect(spawned.calls).toHaveLength(0); expect(exit.run).not.toHaveBeenCalled();
    vi.stubEnv("TMUX", tmux.TMUX); vi.stubEnv("TMUX_PANE", tmux.TMUX_PANE);
    await handlers.get("restart")("", ctx({ ui: { notify, confirm }, shutdown }));
    expect(confirm).not.toHaveBeenCalled();
    expect(spawned.calls).toHaveLength(1);
    const helperArgs = spawned.calls[0]![1] as string[];
    expect(JSON.parse(helperArgs[1]!)).toMatchObject({ pane: "%9", cwd: "/home/u/tmp", sessionFile });
    expect(exit.run).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled(); // ctx.shutdown() only notifies; the real exit is used
    vi.unstubAllEnvs();
  });
  it("never registers a Telegram /quit or /exit", () => {
    const handlers = new Map<string, any>();
    registerLifecycleCommands({ registerCommand: (name, o) => handlers.set(name, o.handler) });
    expect(handlers.has("quit")).toBe(false); expect(handlers.has("exit")).toBe(false);
    expect(handlers.has("restart")).toBe(true);
  });
});

describe("restart helper", () => {
  it("quotes paths so the prompt cannot run injected text", () => {
    expect(shellQuote("a b's")).toBe(`'a b'\\''s'`);
    expect(restartCommand("/x y", "/s/$(id).jsonl")).toBe(`cd '/x y' && pi --session '/s/$(id).jsonl'`);
    expect(restartCommand("/x y")).toBe(`cd '/x y' && pi`);
  });

  async function fakeTmux(current: string) {
    const dir = await mkdtemp(join(tmpdir(), "restart-")); dirs.push(dir);
    const bin = join(dir, "tmux"); const calls = join(dir, "calls");
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\n[ "$1" = display-message ] && echo ${current}\nexit 0\n`);
    await chmod(bin, 0o700);
    const job = { pid: 4242, pane: "%9", cwd: "/x y", sessionFile: "/s/a.jsonl", logPath: join(dir, "log"), tmux: bin,
      exitWaitMs: 400, shellWaitMs: 400 };
    return { job, calls: () => readFile(calls, "utf8").catch(() => ""), log: async () => (await readFile(job.logPath, "utf8")).trim().split("\n").map(l => JSON.parse(l)) };
  }

  it("waits for the old Pi to exit, clears the prompt and types the exact command", async () => {
    const f = await fakeTmux("bash");
    let checks = 0;
    expect(await runRestart(f.job, { isAlive: () => ++checks < 3 })).toBe(true);
    const calls = (await f.calls()).trim().split("\n");
    expect(calls).toEqual(["display-message -p -t %9 #{pane_current_command}", "send-keys -t %9 C-u",
      `send-keys -t %9 -l -- cd '/x y' && pi --session '/s/a.jsonl'`, "send-keys -t %9 Enter"]);
    expect((await f.log())[0]).toMatchObject({ status: "sent" });
  });
  it("types plain pi when the job has no session file (/tg-setup on an empty session)", async () => {
    const f = await fakeTmux("bash");
    const { sessionFile: _unused, ...job } = f.job;
    expect(await runRestart(job, { isAlive: () => false })).toBe(true);
    expect((await f.calls()).trim().split("\n")).toContain(`send-keys -t %9 -l -- cd '/x y' && pi`);
  });
  it("gives up without typing when the old Pi never exits", async () => {
    const f = await fakeTmux("bash");
    expect(await runRestart(f.job, { isAlive: () => true })).toBe(false);
    expect(await f.calls()).toBe("");
    expect((await f.log())[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/still running/) });
  });
  it("gives up without typing when the pane is not back at a shell", async () => {
    const f = await fakeTmux("vim");
    expect(await runRestart(f.job, { isAlive: () => false })).toBe(false);
    expect(await f.calls()).not.toMatch(/send-keys/);
    expect((await f.log())[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/not a shell/) });
  });
});
