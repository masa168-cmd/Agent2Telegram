// Which agent a Bot belongs to. Telegram lets one program receive a Bot's
// updates at a time; two agents on one Bot would steal each other's messages.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { telegramTokenHash } from "../../core/instance-coordinator.ts";

export type AgentName = "pi" | "claude" | "codex";
export type OwnershipResult = { ok: true } | { ok: false; reason: string };

/** Shared by every agent: `$AGENT2TELEGRAM_DIR` or `~/.agent2telegram`. */
export function ownershipDir(): string {
  return process.env.AGENT2TELEGRAM_DIR ? resolve(process.env.AGENT2TELEGRAM_DIR) : join(homedir(), ".agent2telegram");
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A live Pi instance registered for this token in Pi's own runtime directory. */
function piUsesToken(tokenHash: string, isAlive: (pid: number) => boolean): boolean {
  const dir = join(piAgentDir(), "tg-runtime", tokenHash, "instances");
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some(name => {
    try {
      const pid = (JSON.parse(readFileSync(join(dir, name), "utf8")) as { pid?: unknown }).pid;
      return typeof pid === "number" && isAlive(pid);
    } catch { return false; }
  });
}

/**
 * Claim the Bot for `agent`, unless another agent claimed it or a live Pi is
 * using it now. The claim is a file per Bot, keyed by the token hash.
 */
export function claimBot(token: string, agent: AgentName, isAlive: (pid: number) => boolean = alive): OwnershipResult {
  const tokenHash = telegramTokenHash(token);
  const path = join(ownershipDir(), "bots", `${tokenHash}.json`);
  try {
    const owner = (JSON.parse(readFileSync(path, "utf8")) as { agent?: unknown }).agent;
    if (typeof owner === "string" && owner !== agent) {
      return { ok: false, reason: `这个 Bot 已登记给 ${owner} 使用（${path}）。每个 Agent 用自己的 Bot。` };
    }
  } catch { /* not claimed yet */ }
  if (agent !== "pi" && piUsesToken(tokenHash, isAlive)) {
    return { ok: false, reason: "这个 Bot 正被 Pi 使用。每个 Agent 用自己的 Bot。" };
  }
  mkdirSync(join(ownershipDir(), "bots"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ agent, claimedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  return { ok: true };
}
