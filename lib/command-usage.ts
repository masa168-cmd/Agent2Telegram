import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";
import { log } from "./logger.ts";

const usageLog = log.child("command-usage");
const MAX_RECENT = 30;

let recent: string[] = [];
let loaded = false;
let loadPromise: Promise<void> | undefined;
let writeTimer: NodeJS.Timeout | undefined;

function usagePath(): string {
  return join(getAgentDir(), "tg-command-usage.json");
}

function normalize(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

export async function loadRecentCommands(): Promise<string[]> {
  if (loaded) return [...recent];
  if (!loadPromise) {
    loadPromise = (async () => {
      const path = usagePath();
      if (!existsSync(path)) {
        loaded = true;
        return;
      }
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as { commands?: unknown };
        if (Array.isArray(raw.commands)) {
          recent = raw.commands.filter((name): name is string => typeof name === "string").map(normalize).slice(0, MAX_RECENT);
        }
      } catch (err) {
        usageLog.debug("failed to read command usage", { err, path });
      } finally {
        loaded = true;
      }
    })();
  }
  await loadPromise;
  return [...recent];
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    void (async () => {
      const path = usagePath();
      await mkdir(getAgentDir(), { recursive: true });
      const temp = `${path}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, commands: recent }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, path);
    })().catch((err: unknown) => usageLog.debug("failed to persist command usage", { err }));
  }, 250);
  writeTimer.unref?.();
}

/** Record a successfully dispatched slash command for BotMenu prioritization. */
export function recordCommandUsage(name: string): void {
  const clean = normalize(name);
  if (!clean) return;
  recent = [clean, ...recent.filter((existing) => existing !== clean)].slice(0, MAX_RECENT);
  scheduleWrite();
}

/** Test-only reset. */
export function resetCommandUsageForTests(): void {
  recent = [];
  loaded = false;
  loadPromise = undefined;
  clearTimeout(writeTimer);
  writeTimer = undefined;
}
