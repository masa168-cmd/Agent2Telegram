#!/usr/bin/env node
// Detached helper for /restart and /tg-setup. Pi spawns it, then exits normally. It
// waits for the old Pi process to end, checks the tmux pane is back at a shell prompt
// and types `cd <cwd> && pi --session <file>` into it (plain `pi` when the job has no
// session file, e.g. /tg-setup in a session that has no messages yet). Any failure is logged once and the
// helper gives up: it never retries and never kills anything.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHELLS = new Set(["bash", "zsh", "sh", "dash", "fish", "ksh"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** POSIX single-quote a value for the shell prompt. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function restartCommand(cwd, sessionFile) {
  const pi = sessionFile ? `pi --session ${shellQuote(sessionFile)}` : "pi";
  return `cd ${shellQuote(cwd)} && ${pi}`;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function runRestart(job, io = {}) {
  const tmux = (args) => execFileSync(job.tmux ?? "tmux", args, { encoding: "utf8", timeout: 5000 }).trim();
  const log = (status, detail) => {
    try {
      appendFileSync(job.logPath, JSON.stringify({ at: new Date().toISOString(), status, detail,
        pane: job.pane, cwd: job.cwd, sessionFile: job.sessionFile }) + "\n", { mode: 0o600 });
    } catch { /* nothing else can report it */ }
  };
  const isAlive = io.isAlive ?? alive;
  const exitWaitMs = job.exitWaitMs ?? 30_000;
  const shellWaitMs = job.shellWaitMs ?? 5_000;
  try {
    let waited = 0;
    while (isAlive(job.pid)) {
      if (waited >= exitWaitMs) return log("failed", `old Pi ${job.pid} still running after ${exitWaitMs} ms`), false;
      await sleep(200); waited += 200;
    }
    waited = 0;
    let current = "";
    for (;;) {
      current = tmux(["display-message", "-p", "-t", job.pane, "#{pane_current_command}"]);
      if (SHELLS.has(current)) break;
      if (waited >= shellWaitMs) return log("failed", `pane runs "${current}", not a shell`), false;
      await sleep(200); waited += 200;
    }
    // C-u clears any type-ahead on the prompt so it cannot merge with the command.
    tmux(["send-keys", "-t", job.pane, "C-u"]);
    tmux(["send-keys", "-t", job.pane, "-l", "--", restartCommand(job.cwd, job.sessionFile)]);
    tmux(["send-keys", "-t", job.pane, "Enter"]);
    log("sent", "restart command typed into the pane");
    return true;
  } catch (error) {
    log("failed", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const job = JSON.parse(process.argv[2] ?? "{}");
  runRestart(job).then(ok => process.exit(ok ? 0 : 1));
}
