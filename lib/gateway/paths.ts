import { join, resolve } from "node:path";
import { agentDataDir } from "../core/a2t-home.ts";

/** Data directory of the Claude Code adapter: `$CLAUDE_TELEGRAM_DIR`, else `~/.agent2telegram/claude`. */
export function claudeTelegramDir(): string {
  return process.env.CLAUDE_TELEGRAM_DIR ? resolve(process.env.CLAUDE_TELEGRAM_DIR) : agentDataDir("claude");
}

export function runtimeDir(dataDir: string): string {
  return join(dataDir, "runtime");
}
