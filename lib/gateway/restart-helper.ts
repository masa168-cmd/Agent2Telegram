// Detached helper for Telegram /restart (tmux only), same steps as the Pi helper
// (lib/pi/restart-helper.mjs): wait for the old Claude Code to exit, check the
// tmux pane is back at a shell prompt, then type
// `cd <cwd> && claude … --plugin-dir <mod> --resume <session>` (the old flags kept).
// Any failure is logged once; it never retries and never kills anything.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export type RestartJob = {
  /** The Claude Code process to wait for. */
  pid: number;
  /** tmux pane id (`%5`), from the session's TMUX_PANE. */
  pane: string;
  cwd: string;
  modDir: string;
  sessionId: string;
  /** The old process's own argv (from /proc), so its flags survive the restart. */
  argv?: string[];
  logPath: string;
  exitWaitMs?: number;
  shellWaitMs?: number;
};

export type RestartIo = {
  isAlive?: (pid: number) => boolean;
  tmux?: (args: string[]) => string;
  sleep?: (ms: number) => Promise<void>;
};

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh"]);

/** POSIX single-quote a value for the shell prompt. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line to start again with: the old argv with its flags kept, any
 * session choice (`--resume`/`-r <id>`, `--continue`/`-c`, `--session-id <id>`)
 * replaced by `--resume <this session>`, and `--plugin-dir <mod>` added when missing.
 */
export function restartArgv(job: Pick<RestartJob, "modDir" | "sessionId" | "argv">): string[] {
  const [program, ...rest] = job.argv?.length ? job.argv : ["claude"];
  const kept: string[] = [];
  let hasPluginDir = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--resume" || arg === "-r" || arg === "--session-id") {
      if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (arg === "--continue" || arg === "-c" || arg.startsWith("--resume=") || arg.startsWith("--session-id=")) continue;
    if (arg === "--plugin-dir" && rest[i + 1] === job.modDir) hasPluginDir = true;
    kept.push(arg);
  }
  return [program!, ...(hasPluginDir ? [] : ["--plugin-dir", job.modDir]), ...kept, "--resume", job.sessionId];
}

export function restartCommand(job: Pick<RestartJob, "cwd" | "modDir" | "sessionId" | "argv">): string {
  return `cd ${shellQuote(job.cwd)} && ${restartArgv(job).map(shellQuote).join(" ")}`;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function runRestart(job: RestartJob, io: RestartIo = {}): Promise<boolean> {
  const tmux = io.tmux ?? ((args: string[]) => execFileSync("tmux", args, { encoding: "utf8", timeout: 5_000 }).trim());
  const isAlive = io.isAlive ?? alive;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  const log = (status: string, detail: string) => {
    try {
      appendFileSync(job.logPath, JSON.stringify({ at: new Date().toISOString(), status, detail, pane: job.pane, cwd: job.cwd,
        sessionId: job.sessionId }) + "\n", { mode: 0o600 });
    } catch { /* nothing else can report it */ }
  };
  const exitWaitMs = job.exitWaitMs ?? 30_000;
  const shellWaitMs = job.shellWaitMs ?? 5_000;
  try {
    let waited = 0;
    while (isAlive(job.pid)) {
      if (waited >= exitWaitMs) { log("failed", `Claude Code ${job.pid} still running after ${exitWaitMs} ms`); return false; }
      await sleep(200); waited += 200;
    }
    waited = 0;
    for (;;) {
      const current = tmux(["display-message", "-p", "-t", job.pane, "#{pane_current_command}"]);
      if (SHELLS.has(current)) break;
      if (waited >= shellWaitMs) { log("failed", `pane runs "${current}", not a shell`); return false; }
      await sleep(200); waited += 200;
    }
    // C-u clears any type-ahead on the prompt so it cannot merge with the command.
    tmux(["send-keys", "-t", job.pane, "C-u"]);
    tmux(["send-keys", "-t", job.pane, "-l", "--", restartCommand(job)]);
    tmux(["send-keys", "-t", job.pane, "Enter"]);
    log("sent", "restart command typed into the pane");
    return true;
  } catch (error) {
    log("failed", (error instanceof Error ? error.message : String(error)).slice(0, 300));
    return false;
  }
}

// Run as a program: `node restart-helper.js '<job json>'`.
if (process.argv[1]?.endsWith("restart-helper.js") && process.argv[2]) {
  void runRestart(JSON.parse(process.argv[2]) as RestartJob);
}
