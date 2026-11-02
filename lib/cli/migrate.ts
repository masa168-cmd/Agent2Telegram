// `a2t migrate [--apply]`: move pre-agent2telegram data into ~/.agent2telegram.
// Without --apply it only prints the plan. With it: refuse while Pi or the
// gateway is running, back everything up, then move. Never overwrites.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { a2tHome, agentDataDir } from "../core/a2t-home.ts";
import { getProjectBindingPath, legacyProjectBindingPath, writeProjectBinding } from "../core/config.ts";
import { setTelegramDataDir } from "../core/data-dir.ts";
import type { ProjectTelegramBinding } from "../core/types.ts";
import { enableClaudeProject, isClaudeProjectEnabled } from "../gateway/claude-projects.ts";
import { LEGACY_PI_ENTRY_FILES, enablePi } from "./pi-entry.ts";
import { GATEWAY_SERVICE, LEGACY_GATEWAY_SERVICES } from "./service.ts";

export type MigrateStep =
  | { kind: "move"; from: string; to: string }
  | { kind: "binding"; dir: string; from: string }
  | { kind: "pi-entry"; dir: string }
  | { kind: "claude-enable"; dir: string }
  | { kind: "remove"; path: string; why: string }
  | { kind: "skip"; path: string; why: string }
  | { kind: "ask"; path: string; why: string };

export type MigrateOptions = {
  apply: boolean;
  appDir: string;
  home?: string;
  /** Extra project directories to check besides the ones the topic maps name. */
  dirs?: string[];
  isPidAlive?: (pid: number) => boolean;
  isServiceActive?: (name: string) => boolean;
  log?: (line: string) => void;
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function serviceActive(name: string): boolean {
  try {
    return execFileSync("systemctl", ["--user", "is-active", `${name}.service`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "active";
  } catch { return false; }
}

function topicDirs(topicsFile: string): string[] {
  try {
    const store = JSON.parse(readFileSync(topicsFile, "utf8")) as { topics?: Record<string, { cwd?: string }> };
    return Object.values(store.topics ?? {}).map(t => t.cwd).filter((d): d is string => typeof d === "string");
  } catch { return []; }
}

function list(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Live Pi instances registered in Pi's old runtime directory. */
function livePis(runtime: string, isAlive: (pid: number) => boolean): number[] {
  const pids: number[] = [];
  for (const bot of list(runtime)) {
    for (const name of list(join(runtime, bot, "instances"))) {
      try {
        const pid = (JSON.parse(readFileSync(join(runtime, bot, "instances", name), "utf8")) as { pid?: unknown }).pid;
        if (typeof pid === "number" && isAlive(pid)) pids.push(pid);
      } catch { /* unreadable */ }
    }
  }
  return pids;
}

export function planMigration(options: MigrateOptions): MigrateStep[] {
  const home = options.home ?? homedir();
  const a2t = a2tHome();
  const steps: MigrateStep[] = [];
  const move = (from: string, to: string) => {
    if (!existsSync(from)) return;
    if (existsSync(to)) steps.push({ kind: "skip", path: from, why: `目标已存在：${to}` });
    else steps.push({ kind: "move", from, to });
  };

  // Pi's Telegram data in ~/.pi/agent (Pi's own files there are not touched).
  const oldPi = join(home, ".pi", "agent");
  const newPi = agentDataDir("pi");
  for (const name of ["tg.json", "tg-runtime", "tg-command-usage.json"]) move(join(oldPi, name), join(newPi, name));
  for (const name of list(join(oldPi, "logs")).filter(n => n.startsWith("pi-telegram-plus-"))) {
    move(join(oldPi, "logs", name), join(newPi, "logs", name));
  }
  for (const name of list(oldPi).filter(n => n.startsWith("tg-poll-") || n === "tg.json.lock")) {
    steps.push({ kind: "remove", path: join(oldPi, name), why: "过期的锁" });
  }
  const tgSetup = join(oldPi, "extensions", "tg-setup");
  if (existsSync(tgSetup)) steps.push({ kind: "remove", path: tgSetup, why: "/tg-setup 已由 a2t enable pi 取代" });

  // Claude's data in ~/.claude-telegram.
  const oldClaude = join(home, ".claude-telegram");
  const newClaude = agentDataDir("claude");
  for (const name of ["tg.json", "runtime"]) move(join(oldClaude, name), join(newClaude, name));

  // Cache.
  const oldCache = join(home, ".cache", "pi-telegram");
  for (const name of ["uploads", "scratch"]) move(join(oldCache, name), join(a2t, "cache", name));

  // Project directories: the topic maps name every directory that had a topic.
  const piDirs = [...list(join(oldPi, "tg-runtime")).flatMap(bot => topicDirs(join(oldPi, "tg-runtime", bot, "topics.json")))];
  const claudeDirs = topicDirs(join(oldClaude, "runtime", "topics.json"));
  const dirs = [...new Set([...piDirs, ...claudeDirs, ...(options.dirs ?? [])])].sort();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    if (dir === home) {
      for (const name of LEGACY_PI_ENTRY_FILES) {
        const path = join(home, ".pi", "extensions", name);
        if (existsSync(path)) steps.push({ kind: "ask", path, why: "主目录的旧 Pi 入口（之前计划删除），单独确认后处理" });
      }
      continue;
    }
    const legacyBinding = legacyProjectBindingPath(dir);
    if (existsSync(legacyBinding)) {
      if (existsSync(getProjectBindingPath(dir))) steps.push({ kind: "skip", path: legacyBinding, why: "新位置已有该目录的绑定" });
      else steps.push({ kind: "binding", dir, from: legacyBinding });
    }
    if (LEGACY_PI_ENTRY_FILES.some(name => existsSync(join(dir, ".pi", "extensions", name)))) steps.push({ kind: "pi-entry", dir });
  }
  for (const dir of claudeDirs) {
    if (existsSync(dir) && !isClaudeProjectEnabled(newClaude, dir)) steps.push({ kind: "claude-enable", dir });
  }
  for (const name of [join(home, ".pi", "context-budget.json")]) {
    if (existsSync(name)) steps.push({ kind: "ask", path: name, why: "主目录的 context-budget 配置（不属于 Telegram），单独确认后处理" });
  }
  return steps;
}

function describe(step: MigrateStep): string {
  switch (step.kind) {
    case "move": return `移动  ${step.from} → ${step.to}`;
    case "binding": return `绑定  ${step.from} → 集中存放（${step.dir}）`;
    case "pi-entry": return `入口  ${step.dir}/.pi/extensions/ 旧入口 → agent2telegram.ts`;
    case "claude-enable": return `开启  Claude：${step.dir}`;
    case "remove": return `删除  ${step.path}（${step.why}）`;
    case "skip": return `跳过  ${step.path}（${step.why}）`;
    case "ask": return `待定  ${step.path}（${step.why}）`;
  }
}

export async function runMigrate(options: MigrateOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const steps = planMigration(options);
  const actions = steps.filter(s => s.kind !== "skip" && s.kind !== "ask");
  if (steps.length === 0) { log("没有需要迁移的旧数据。"); return 0; }
  log(`${options.apply ? "迁移" : "迁移清单（只列出，加 --apply 执行）"}：`);
  for (const step of steps) log(`  ${describe(step)}`);
  if (!options.apply || actions.length === 0) return 0;

  const home = options.home ?? homedir();
  const pis = livePis(join(home, ".pi", "agent", "tg-runtime"), options.isPidAlive ?? alive);
  const active = [GATEWAY_SERVICE, ...LEGACY_GATEWAY_SERVICES].filter(options.isServiceActive ?? serviceActive);
  if (pis.length > 0 || active.length > 0) {
    log(`未执行：请先停止正在运行的${pis.length ? ` Pi（进程 ${pis.join(", ")}）` : ""}${active.length ? ` 网关服务（${active.join(", ")}）` : ""}，再运行 a2t migrate --apply。`);
    return 1;
  }

  // Back up everything that will change, relative to the home directory.
  const touched = [...new Set(actions.flatMap(s => s.kind === "move" ? [s.from] : s.kind === "binding" ? [s.from]
    : s.kind === "remove" ? [s.path] : s.kind === "pi-entry" ? LEGACY_PI_ENTRY_FILES.map(n => join(s.dir, ".pi", "extensions", n)).filter(existsSync) : []))];
  const backupDir = join(a2tHome(), "backup");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = join(backupDir, `migrate-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  if (touched.length > 0) {
    execFileSync("tar", ["-czf", backup, "-C", "/", ...touched.map(p => relative("/", p))]);
    log(`已备份到 ${backup}`);
  }

  setTelegramDataDir(agentDataDir("pi"));
  try {
    for (const step of actions) {
      if (step.kind === "move") {
        mkdirSync(join(step.to, ".."), { recursive: true, mode: 0o700 });
        cpSync(step.from, step.to, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
        rmSync(step.from, { recursive: true, force: true });
      } else if (step.kind === "binding") {
        const binding = JSON.parse(readFileSync(step.from, "utf8")) as ProjectTelegramBinding;
        await writeProjectBinding(step.dir, binding);
        rmSync(step.from);
      } else if (step.kind === "pi-entry") enablePi(step.dir, options.appDir);
      else if (step.kind === "claude-enable") enableClaudeProject(agentDataDir("claude"), step.dir);
      else if (step.kind === "remove") rmSync(step.path, { recursive: true, force: true });
    }
  } finally {
    setTelegramDataDir(undefined);
  }
  // Leftovers that only held what moved.
  for (const dir of [join(home, ".claude-telegram"), join(home, ".cache", "pi-telegram")]) {
    const rest = list(dir).filter(n => !["run", "gateway.sock"].includes(n));
    if (existsSync(dir) && rest.length === 0) rmSync(dir, { recursive: true, force: true });
  }
  log(`完成。备份保留在 ${backup}，确认一切正常后可以删除。`);
  return 0;
}


