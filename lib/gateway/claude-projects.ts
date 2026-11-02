// Directories where Claude Code or Codex sessions connect to Telegram
// (`a2t enable claude|codex`; one projects.json per agent data dir). Only these get a forum topic.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type ClaudeProjects = { version: 1; dirs: string[] };

export function claudeProjectsPath(dataDir: string): string {
  return join(dataDir, "projects.json");
}

export function readClaudeProjects(dataDir: string): ClaudeProjects {
  try {
    const parsed = JSON.parse(readFileSync(claudeProjectsPath(dataDir), "utf8")) as ClaudeProjects;
    if (parsed?.version === 1 && Array.isArray(parsed.dirs)) return { version: 1, dirs: parsed.dirs.filter(d => typeof d === "string") };
  } catch { /* none yet */ }
  return { version: 1, dirs: [] };
}

function write(dataDir: string, projects: ClaudeProjects): void {
  const path = claudeProjectsPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(projects, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** True when `cwd` or one of its parents is enabled. */
export function isClaudeProjectEnabled(dataDir: string, cwd: string): boolean {
  const dirs = new Set(readClaudeProjects(dataDir).dirs);
  let dir = resolve(cwd);
  while (true) {
    if (dirs.has(dir)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Returns false when it was already enabled. */
export function enableClaudeProject(dataDir: string, cwd: string): boolean {
  const projects = readClaudeProjects(dataDir);
  const dir = resolve(cwd);
  if (projects.dirs.includes(dir)) return false;
  write(dataDir, { version: 1, dirs: [...projects.dirs, dir].sort() });
  return true;
}

/** Returns false when it was not enabled. */
export function disableClaudeProject(dataDir: string, cwd: string): boolean {
  const projects = readClaudeProjects(dataDir);
  const dir = resolve(cwd);
  if (!projects.dirs.includes(dir)) return false;
  write(dataDir, { version: 1, dirs: projects.dirs.filter(d => d !== dir) });
  return true;
}
