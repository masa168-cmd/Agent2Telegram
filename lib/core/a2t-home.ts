import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where agent2telegram keeps everything of its own: `$AGENT2TELEGRAM_DIR` or
 * `~/.agent2telegram` (app/, bin/, bots/, pi/, claude/, codex/, cache/).
 * Read on every call so tests and sandboxes can point it elsewhere.
 */
export function a2tHome(): string {
  return process.env.AGENT2TELEGRAM_DIR ? resolve(process.env.AGENT2TELEGRAM_DIR) : join(homedir(), ".agent2telegram");
}

/** One agent's own data: Bot registry, runtime state, logs. */
export function agentDataDir(agent: "pi" | "claude" | "codex"): string {
  return join(a2tHome(), agent);
}

/** Shared cache (Telegram uploads and other re-creatable files). */
export function a2tCacheDir(): string {
  return join(a2tHome(), "cache");
}
