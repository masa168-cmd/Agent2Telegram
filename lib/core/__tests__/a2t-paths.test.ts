import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { a2tCacheDir, a2tHome, agentDataDir } from "../a2t-home.ts";
import { getProjectBindingPath, readProjectBinding, writeProjectBinding } from "../config.ts";
import { getAgentDir, setTelegramDataDir } from "../data-dir.ts";

const ENV = ["AGENT2TELEGRAM_DIR", "PI_CODING_AGENT_DIR", "HOME"] as const;

describe("agent2telegram data locations", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "a2t-paths-"));
    for (const key of ENV) saved[key] = process.env[key];
    delete process.env.AGENT2TELEGRAM_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = join(root, "home");
    setTelegramDataDir(undefined);
  });
  afterEach(() => {
    for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps everything under ~/.agent2telegram by default", () => {
    expect(a2tHome()).toBe(join(root, "home", ".agent2telegram"));
    expect(getAgentDir()).toBe(join(root, "home", ".agent2telegram", "pi"));
    expect(agentDataDir("claude")).toBe(join(root, "home", ".agent2telegram", "claude"));
    expect(a2tCacheDir()).toBe(join(root, "home", ".agent2telegram", "cache"));
  });

  it("keeps using ~/.pi/agent until its tg.json has been migrated", () => {
    const legacy = join(root, "home", ".pi", "agent");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "tg.json"), "{}");
    expect(getAgentDir()).toBe(legacy);
    mkdirSync(join(root, "home", ".agent2telegram", "pi"), { recursive: true });
    writeFileSync(join(root, "home", ".agent2telegram", "pi", "tg.json"), "{}");
    expect(getAgentDir()).toBe(join(root, "home", ".agent2telegram", "pi"));
  });

  it("puts Pi's data under $AGENT2TELEGRAM_DIR/pi unless PI_CODING_AGENT_DIR is set explicitly", () => {
    process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
    expect(getAgentDir()).toBe(join(root, "a2t", "pi"));
    process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
    expect(getAgentDir()).toBe(join(root, "pi-agent"));
  });

  it("stores a directory's binding centrally, never in the project, and subdirectories inherit it", async () => {
    process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
    const project = join(root, "work", "proj");
    mkdirSync(join(project, "sub", "deeper"), { recursive: true });
    await writeProjectBinding(project, { botId: "b1", enabled: true });
    expect(existsSync(join(project, ".pi"))).toBe(false);
    const stored = JSON.parse(readFileSync(getProjectBindingPath(project), "utf8"));
    expect(stored).toEqual({ dir: project, botId: "b1", enabled: true });
    expect(dirname(getProjectBindingPath(project))).toBe(join(root, "a2t", "pi", "projects"));
    expect(await readProjectBinding(join(project, "sub", "deeper"))).toEqual({ path: project, binding: { botId: "b1", enabled: true } });
    expect(await readProjectBinding(join(root, "work"))).toBeUndefined();
  });

  it("still reads a directory's old .pi/telegram.json until it is migrated, and writes only centrally", async () => {
    process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
    const project = join(root, "work", "old");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "telegram.json"), JSON.stringify({ botId: "legacy" }));
    expect(await readProjectBinding(project)).toEqual({ path: project, binding: { botId: "legacy" } });
    await writeProjectBinding(project, { botId: "new" });
    expect(await readProjectBinding(project)).toEqual({ path: project, binding: { botId: "new" } });
    expect(JSON.parse(readFileSync(join(project, ".pi", "telegram.json"), "utf8"))).toEqual({ botId: "legacy" });
  });

  it("ignores a stored binding that names another directory", async () => {
    process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
    const project = join(root, "work", "proj");
    mkdirSync(dirname(getProjectBindingPath(project)), { recursive: true });
    writeFileSync(getProjectBindingPath(project), JSON.stringify({ dir: "/somewhere/else", botId: "b1" }));
    expect(await readProjectBinding(project)).toBeUndefined();
  });
});
