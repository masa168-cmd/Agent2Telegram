import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Data directory of the Claude Code adapter: `$CLAUDE_TELEGRAM_DIR` or `~/.claude-telegram`. */
export function claudeTelegramDir(): string {
  return process.env.CLAUDE_TELEGRAM_DIR
    ? resolve(process.env.CLAUDE_TELEGRAM_DIR)
    : join(homedir(), ".claude-telegram");
}

export function runtimeDir(dataDir: string): string {
  return join(dataDir, "runtime");
}
