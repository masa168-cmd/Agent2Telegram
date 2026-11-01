import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetPath, emptyBudgetConfig, parseBudgetConfig, readBudget, saveBudget, validateBudget } from "../context-budget/config.ts";
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const roots: string[] = [];
const config = { version: 1 as const, models: { "fake/model/with/slash": { contextWindow: 1050000, compactAtTokens: 800000 } } };
const noApply = () => () => {};
const root = () => { const r = fs.mkdtempSync(join(tmpdir(), "budget-config-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("context budget data, exact cwd and atomic persistence (synthetic only)", () => {
  it("absent file is inert and does not create .pi; never searches ancestors", () => {
    const cwd = root(); expect(readBudget(cwd)).toEqual({ config: emptyBudgetConfig(), revision: null });
    expect(fs.existsSync(join(cwd, ".pi"))).toBe(false);
    saveBudget(cwd, null, config, noApply);
    const child = join(cwd, "child"); fs.mkdirSync(child);
    expect(readBudget(child).revision).toBeNull();
  });
  it("roundtrips one strict data file, private modes, no derived reserve or native settings writes", () => {
    const cwd = root(); fs.mkdirSync(join(cwd, ".pi"));
    const original = '{"compaction":{"keepRecentTokens":12345}}\n';
    fs.writeFileSync(join(cwd, ".pi/settings.json"), original);
    const result = saveBudget(cwd, null, config, noApply);
    expect(readBudget(cwd)).toEqual(result);
    expect(fs.statSync(budgetPath(cwd)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(budgetPath(cwd), "utf8")).not.toContain("reserveTokens");
    expect(fs.readFileSync(join(cwd, ".pi/settings.json"), "utf8")).toBe(original);
    expect(fs.readdirSync(join(cwd, ".pi")).sort()).toEqual(["context-budget.json", "settings.json"]);
  });
  it.each([0, -1, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "800000"])("rejects invalid threshold %s", value => {
    expect(() => validateBudget({ contextWindow: 1050000, compactAtTokens: value })).toThrow();
  });
  it.each([800000, 700000, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1050000"])("rejects invalid window %s", value => {
    expect(() => validateBudget({ contextWindow: value, compactAtTokens: 800000 })).toThrow();
  });
  it.each([null, [], { version: 2, models: {} }, { version: 1, models: {}, surprise: true },
    { version: 1, models: { "fake/m": { contextWindow: 100, compactAtTokens: 50, reserveTokens: 50 } } },
    { version: 1, models: { "bad key/model": { contextWindow: 100, compactAtTokens: 50 } } },
    JSON.parse('{"version":1,"models":{"__proto__":null}}'),
    JSON.parse('{"version":1,"models":{"__proto__":{"contextWindow":100,"compactAtTokens":50}}}')])("rejects malformed/unknown schema %#", data => {
    expect(() => parseBudgetConfig(data)).toThrow();
  });
  it("accepts exact case-sensitive IDs and model IDs containing slashes", () => {
    expect(parseBudgetConfig(config)).toEqual(config);
    expect(validateBudget({ contextWindow: Number.MAX_SAFE_INTEGER, compactAtTokens: 1 }).compactAtTokens).toBe(1);
  });
  it("does not overwrite malformed JSON, oversized files or directory destinations", () => {
    const cwd = root(); fs.mkdirSync(join(cwd, ".pi"));
    fs.writeFileSync(budgetPath(cwd), "not json");
    expect(() => readBudget(cwd)).toThrow("JSON");
    expect(() => saveBudget(cwd, null, config, noApply)).toThrow("JSON");
    fs.writeFileSync(budgetPath(cwd), " ".repeat(65537)); expect(() => readBudget(cwd)).toThrow("64 KiB");
    fs.unlinkSync(budgetPath(cwd)); fs.mkdirSync(budgetPath(cwd)); expect(() => readBudget(cwd)).toThrow("普通文件");
  });
  it("refuses .pi and data-file symlinks without touching their target", () => {
    const a = root(), b = root(); fs.mkdirSync(join(b, ".pi"));
    fs.symlinkSync(join(b, ".pi"), join(a, ".pi"));
    expect(() => readBudget(a)).toThrow("符号链接"); expect(() => saveBudget(a, null, config, noApply)).toThrow();
    fs.unlinkSync(join(a, ".pi")); fs.mkdirSync(join(a, ".pi"));
    fs.writeFileSync(join(b, "data"), JSON.stringify(config)); fs.symlinkSync(join(b, "data"), budgetPath(a));
    expect(() => readBudget(a)).toThrow("安全读取"); expect(() => saveBudget(a, null, config, noApply)).toThrow();
    expect(fs.readFileSync(join(b, "data"), "utf8")).toBe(JSON.stringify(config));
  });
  it("rejects concurrent revision changes before runtime application", () => {
    const cwd = root(); const first = saveBudget(cwd, null, config, noApply);
    const second = saveBudget(cwd, first.revision, emptyBudgetConfig(), noApply);
    const apply = vi.fn(noApply);
    expect(() => saveBudget(cwd, first.revision, config, apply)).toThrow("另一操作");
    expect(apply).not.toHaveBeenCalled(); expect(readBudget(cwd)).toEqual(second);
  });
  it("never removes an existing lock or guesses it is stale", () => {
    const cwd = root(); fs.mkdirSync(join(cwd, ".pi")); fs.mkdirSync(`${budgetPath(cwd)}.lock`);
    const apply = vi.fn(noApply); expect(() => saveBudget(cwd, null, config, apply)).toThrow("锁");
    expect(fs.existsSync(`${budgetPath(cwd)}.lock`)).toBe(true); expect(apply).not.toHaveBeenCalled();
  });
  it("keeps old file and cleans own temporary/lock files when runtime refuses", () => {
    const cwd = root(); const old = saveBudget(cwd, null, emptyBudgetConfig(), noApply);
    expect(() => saveBudget(cwd, old.revision, config, () => { throw new Error("synthetic runtime refusal"); })).toThrow("refusal");
    expect(readBudget(cwd)).toEqual(old); expect(fs.readdirSync(join(cwd, ".pi"))).toEqual(["context-budget.json"]);
  });
  it("undoes runtime when atomic rename fails", () => {
    const cwd = root(); const undo = vi.fn();
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("synthetic rename failure"); });
    expect(() => saveBudget(cwd, null, config, () => undo)).toThrow("rename failure");
    expect(undo).toHaveBeenCalledTimes(1); expect(readBudget(cwd).revision).toBeNull();
    expect(fs.readdirSync(join(cwd, ".pi"))).toEqual([]);
  });
  it("explicitly reports unverified rollback instead of success", () => {
    const cwd = root(); vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("rename failure"); });
    expect(() => saveBudget(cwd, null, config, () => () => { throw new Error("undo failure"); })).toThrow("回退未确认");
  });
});
