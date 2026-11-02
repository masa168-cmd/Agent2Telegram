import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restartArgv, restartCommand, runRestart, type RestartJob } from "../restart-helper.ts";

describe("Claude /restart helper", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function job(overrides: Partial<RestartJob> = {}): RestartJob {
    const dir = mkdtempSync(join(tmpdir(), "claude-restart-"));
    dirs.push(dir);
    return { pid: 4242, pane: "%5", cwd: "/work/it's here", modDir: "/repo/lib/claude/mod", sessionId: "abc-123",
      logPath: join(dir, "restart.jsonl"), exitWaitMs: 1_000, shellWaitMs: 1_000, ...overrides };
  }
  const noSleep = async () => undefined;

  it("quotes the resume command for the shell", () => {
    expect(restartCommand({ cwd: "/work/it's here", modDir: "/m", sessionId: "s1" }))
      .toBe(`cd '/work/it'\\''s here' && 'claude' '--plugin-dir' '/m' '--resume' 's1'`);
  });

  it("keeps the old flags and swaps the session for this one", () => {
    expect(restartArgv({ modDir: "/m", sessionId: "new",
      argv: ["/home/u/.local/bin/claude", "--resume", "old", "--permission-mode", "auto"] }))
      .toEqual(["/home/u/.local/bin/claude", "--plugin-dir", "/m", "--permission-mode", "auto", "--resume", "new"]);
    expect(restartArgv({ modDir: "/m", sessionId: "new",
      argv: ["claude", "--plugin-dir", "/m", "-c", "--model", "haiku", "--resume=old"] }))
      .toEqual(["claude", "--plugin-dir", "/m", "--model", "haiku", "--resume", "new"]);
    expect(restartArgv({ modDir: "/m", sessionId: "new" })).toEqual(["claude", "--plugin-dir", "/m", "--resume", "new"]);
  });

  it("waits for the old process, then types the command into the pane", async () => {
    let checks = 0;
    const calls: string[][] = [];
    const ok = await runRestart(job(), {
      isAlive: () => ++checks < 3, sleep: noSleep,
      tmux: args => { calls.push(args); return args[0] === "display-message" ? "bash" : ""; },
    });
    expect(ok).toBe(true);
    expect(calls.map(c => c.slice(0, 3).join(" "))).toEqual([
      "display-message -p -t", "send-keys -t %5", "send-keys -t %5", "send-keys -t %5"]);
    expect(calls[2]).toContain(restartCommand(job()));
    expect(calls[3]).toEqual(["send-keys", "-t", "%5", "Enter"]);
  });

  it("gives up and logs when Claude Code does not exit", async () => {
    const j = job();
    const ok = await runRestart(j, { isAlive: () => true, sleep: noSleep, tmux: () => "bash" });
    expect(ok).toBe(false);
    expect(readFileSync(j.logPath, "utf8")).toContain("still running");
  });

  it("does not type into a pane that is not at a shell", async () => {
    const j = job();
    const sent: string[][] = [];
    const ok = await runRestart(j, { isAlive: () => false, sleep: noSleep,
      tmux: args => { if (args[0] === "send-keys") sent.push(args); return "vim"; } });
    expect(ok).toBe(false);
    expect(sent).toEqual([]);
    expect(readFileSync(j.logPath, "utf8")).toContain("not a shell");
  });
});
