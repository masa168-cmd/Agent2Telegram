import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentDataDir } from "./a2t-home.ts";

let dataDirOverride: string | undefined;

/**
 * Set the directory holding tg.json, tg-runtime/ and logs/. Pi leaves this
 * unset and keeps the default below; other agent adapters pass their own.
 */
export function setTelegramDataDir(dir: string | undefined): void {
  dataDirOverride = dir === undefined ? undefined : resolve(dir);
}

/**
 * Pi's Telegram data (tg.json, tg-runtime/, logs/, projects/), read on every call:
 * an explicitly set `$PI_CODING_AGENT_DIR` (a relocated or sandboxed Pi, and the
 * test suites); else `$AGENT2TELEGRAM_DIR/pi` when that is set;
 * else `~/.agent2telegram/pi` — unless only the pre-agent2telegram `~/.pi/agent/tg.json`
 * exists (not migrated yet), so an upgrade never disconnects a running setup.
 * Pi's own sessions stay where Pi keeps them.
 */
export function getAgentDir(): string {
  if (dataDirOverride !== undefined) return dataDirOverride;
  if (process.env.PI_CODING_AGENT_DIR) return resolve(process.env.PI_CODING_AGENT_DIR);
  if (process.env.AGENT2TELEGRAM_DIR) return agentDataDir("pi");
  const current = agentDataDir("pi");
  const legacy = legacyPiDataDir();
  return !existsSync(join(current, "tg.json")) && existsSync(join(legacy, "tg.json")) ? legacy : current;
}

/** Where Pi's Telegram data lived before agent2telegram. */
export function legacyPiDataDir(): string {
  return join(homedir(), ".pi", "agent");
}
