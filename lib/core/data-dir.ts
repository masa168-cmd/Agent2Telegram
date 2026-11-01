import { homedir } from "node:os";
import { join, resolve } from "node:path";

let dataDirOverride: string | undefined;

/**
 * Set the directory holding tg.json, tg-runtime/ and logs/. Pi leaves this
 * unset and keeps the default below; other agent adapters pass their own.
 */
export function setTelegramDataDir(dir: string | undefined): void {
  dataDirOverride = dir === undefined ? undefined : resolve(dir);
}

/** Default: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, read on every call. */
export function getAgentDir(): string {
  if (dataDirOverride !== undefined) return dataDirOverride;
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}
