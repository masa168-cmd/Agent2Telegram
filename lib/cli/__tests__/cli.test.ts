import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableClaudeProject, enableClaudeProject, isClaudeProjectEnabled } from "../../gateway/claude-projects.ts";
import { getProjectBindingPath } from "../../core/config.ts";
import { appDir } from "../main.ts";
import { planMigration, runMigrate } from "../migrate.ts";
import { disablePi, enablePi, isPiEnabled, piEntryPath } from "../pi-entry.ts";
import { gatewayUnit, installGatewayService, serviceDir } from "../service.ts";

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "a2t-cli-"));
  for (const key of ["AGENT2TELEGRAM_DIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"]) saved[key] = process.env[key];
  process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = join(root, "config");
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe("a2t enable / disable", () => {
  it("writes a one-line Pi entry to the app, replaces an old /tg-setup entry, and removes it again", () => {
    const dir = join(root, "proj");
    mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
    writeFileSync(join(dir, ".pi", "extensions", "pi-telegram-plus-ex.ts"), "old");
    const done = enablePi(dir, "/opt/a2t/app");
    expect(done.result).toBe("created");
    expect(done.removedLegacy).toHaveLength(1);
    expect(readFileSync(piEntryPath(dir), "utf8")).toContain('from "/opt/a2t/app/index.ts"');
    expect(enablePi(dir, "/opt/a2t/app").result).toBe("unchanged");
    expect(enablePi(dir, "/new/app").result).toBe("updated");
    expect(disablePi(dir)).toBe(true);
    expect(isPiEnabled(dir)).toBe(false);
  });

  it("enables Claude per directory, subdirectories included", () => {
    const data = join(root, "a2t", "claude");
    expect(enableClaudeProject(data, join(root, "proj"))).toBe(true);
    expect(enableClaudeProject(data, join(root, "proj"))).toBe(false);
    expect(isClaudeProjectEnabled(data, join(root, "proj", "sub"))).toBe(true);
    expect(isClaudeProjectEnabled(data, join(root, "other"))).toBe(false);
    expect(disableClaudeProject(data, join(root, "proj"))).toBe(true);
    expect(isClaudeProjectEnabled(data, join(root, "proj"))).toBe(false);
  });
});

describe("gateway service", () => {
  it("generates a unit for the installed app and installs it idempotently", () => {
    const unit = gatewayUnit({ node: "/usr/bin/node", appDir: "/a/app", a2tHome: "/a" });
    expect(unit).toContain("ExecStart=/usr/bin/node /a/app/dist/lib/gateway/main.js");
    expect(unit).toContain("Environment=AGENT2TELEGRAM_DIR=/a");
    const calls: string[][] = [];
    const exec = (command: string, args: string[]) => { calls.push([command, ...args]); return ""; };
    expect(installGatewayService(unit, exec)[0]).toContain("写入");
    expect(installGatewayService(unit, exec).some(line => line.includes("写入"))).toBe(false);
    expect(existsSync(join(serviceDir(), "agent2telegram-gateway.service"))).toBe(true);
    expect(calls.filter(c => c.includes("restart"))).toHaveLength(2);
  });
});

describe("a2t migrate", () => {
  function legacy(home: string) {
    mkdirSync(join(home, ".pi", "agent", "tg-runtime", "b", "instances"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "tg.json"), "{}");
    writeFileSync(join(home, ".pi", "agent", "auth.json"), "{}");
    writeFileSync(join(home, ".pi", "agent", "tg-runtime", "b", "instances", "i.json"), JSON.stringify({ pid: 4242 }));
    const work = join(root, "w");
    mkdirSync(join(work, ".pi"), { recursive: true });
    writeFileSync(join(work, ".pi", "telegram.json"), JSON.stringify({ botId: "x" }));
    writeFileSync(join(home, ".pi", "agent", "tg-runtime", "b", "topics.json"), JSON.stringify({ topics: { k: { cwd: work } } }));
    return work;
  }

  it("plans without touching anything, and never touches Pi's own files", () => {
    const home = join(root, "home");
    legacy(home);
    const steps = planMigration({ apply: false, appDir: "/app", home });
    expect(steps.map(s => s.kind)).toEqual(["move", "move", "binding"]);
    expect(JSON.stringify(steps)).not.toContain("auth.json");
    expect(existsSync(join(home, ".pi", "agent", "tg.json"))).toBe(true);
  });

  it("refuses to apply while a Pi is running, then moves and backs up once it is not", async () => {
    const home = join(root, "home");
    const work = legacy(home);
    const lines: string[] = [];
    const common = { apply: true, appDir: "/app", home, isServiceActive: () => false, log: (l: string) => lines.push(l) };
    expect(await runMigrate({ ...common, isPidAlive: () => true })).toBe(1);
    expect(existsSync(join(home, ".pi", "agent", "tg.json"))).toBe(true);
    expect(await runMigrate({ ...common, isPidAlive: () => false })).toBe(0);
    expect(existsSync(join(root, "a2t", "pi", "tg.json"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "auth.json"))).toBe(true);
    expect(JSON.parse(readFileSync(getProjectBindingPath(work), "utf8"))).toEqual({ dir: work, botId: "x" });
    expect(existsSync(join(work, ".pi", "telegram.json"))).toBe(false);
    expect(lines.join("\n")).toContain("已备份到");
  });
});

describe("a2t app location", () => {
  it("finds the app by its package.json", () => {
    expect(JSON.parse(readFileSync(join(appDir(), "package.json"), "utf8")).name).toBe("agent2telegram");
  });
});
