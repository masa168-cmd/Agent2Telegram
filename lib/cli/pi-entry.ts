// Pi loads extensions only from `<project>/.pi/extensions/`, so enabling a
// directory for Pi writes one line there that points at the installed app.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PI_ENTRY_FILE = "agent2telegram.ts";
/** Entries written before agent2telegram (by /tg-setup). */
export const LEGACY_PI_ENTRY_FILES = ["pi-telegram-plus-ex.ts"];

export function piEntryPath(dir: string): string {
  return join(resolve(dir), ".pi", "extensions", PI_ENTRY_FILE);
}

export function piEntrySource(appDir: string): string {
  return `// agent2telegram: Telegram for Pi in this directory (a2t disable pi removes it).\nexport { default } from ${JSON.stringify(join(appDir, "index.ts"))};\n`;
}

function ensureRealDir(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${path} 不是普通目录，未写入。`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
}

export type EnableResult = "created" | "updated" | "unchanged";

/**
 * Write (or repoint) the directory's entry. Old /tg-setup entries are removed,
 * so Pi never loads the plugin twice.
 */
export function enablePi(dir: string, appDir: string): { result: EnableResult; path: string; removedLegacy: string[] } {
  const root = resolve(dir);
  ensureRealDir(join(root, ".pi"));
  ensureRealDir(join(root, ".pi", "extensions"));
  const path = piEntryPath(root);
  const source = piEntrySource(appDir);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (before !== source) writeFileSync(path, source, { mode: 0o600 });
  const removedLegacy: string[] = [];
  for (const name of LEGACY_PI_ENTRY_FILES) {
    const legacy = join(root, ".pi", "extensions", name);
    if (existsSync(legacy)) { rmSync(legacy); removedLegacy.push(legacy); }
  }
  return { result: before === undefined ? "created" : before === source ? "unchanged" : "updated", path, removedLegacy };
}

export function disablePi(dir: string): boolean {
  const path = piEntryPath(dir);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export function isPiEnabled(dir: string): boolean {
  return existsSync(piEntryPath(dir));
}
