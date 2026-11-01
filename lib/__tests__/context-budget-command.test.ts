import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerContextBudgetCommand } from "../commands/context-budget.ts";
import { ContextBudgetRuntime } from "../context-budget/runtime.ts";
import { budgetPath, readBudget, saveBudget } from "../context-budget/config.ts";
import { extensionSelectAdapter } from "../tui/adapters/extension.ts";
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const EDIT = "修改窗口 / 压缩阈值", RESET = "恢复默认（重载后生效）";
const MANAGE = "管理未列出的已保存规则";
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "budget-command-")); roots.push(cwd);
  const model = { provider: "fake", id: "m", type: "chat", contextWindow: 272000, maxTokens: 128000 };
  const catalog = [model, { ...model, id: "other" }];
  const base = { id: "fake", getModels: () => catalog }; let provider: any;
  const registry = { getProvider: () => provider ?? base, getRegisteredNativeProvider: () => provider,
    getRegisteredProviderConfig: () => undefined, getAll: () => (provider ?? base).getModels(),
    getAvailable: vi.fn(() => (provider ?? base).getModels()),
    find: (p = "fake", id = "m") => (provider ?? base).getModels().find((m: any) => m.provider === p && m.id === id) };
  const state = { valid: true, idle: true, usage: 10000 as number | null, supported: true };
  const sessionManager = { getSessionId: () => "synthetic" };
  const settings = SettingsManager.inMemory();
  const choices: Array<string | undefined> = ["fake/m", EDIT];
  const inputs: Array<string | undefined> = ["1050000", "800000"];
  const pickerFrames: string[][] = [];
  const ui = { custom: vi.fn(async (factory: any) => {
    const component = await factory({ terminal: { rows: 24 }, requestRender() {} },
      { fg: (_color: string, text: string) => text }, {}, () => {});
    const model = extensionSelectAdapter.read(component, { host: "pi", root: component,
      sendKey: () => false, requestRender() {} });
    if (model.kind !== "select") throw new Error("Budget picker was not recognized by the existing adapter");
    pickerFrames.push(model.items.map(item => item.label)); component.dispose();
    return choices.shift();
  }), select: vi.fn(async () => choices.shift()), input: vi.fn(async () => inputs.shift()),
    confirm: vi.fn(async () => true), notify: vi.fn() };
  const ctx: any = { cwd, sessionManager, modelRegistry: registry, isProjectTrusted: () => true, ui, hasUI: true,
    get model() { return registry.find(); }, isIdle: () => state.idle, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: state.usage }) };
  const session: any = { settingsManager: settings, sessionManager, get model() { return registry.find(); },
    extensionRunner: { createCommandContext: () => ctx } };
  const pi: any = { registerCommand: vi.fn(), registerProvider: vi.fn((p: any) => { provider = p; }), unregisterProvider: vi.fn(() => { provider = undefined; }) };
  const runtime = new ContextBudgetRuntime(pi, { getSession: () => session, supported: () => state.supported,
    captureOperation: () => () => state.valid });
  registerContextBudgetCommand(pi, runtime);
  const handler = pi.registerCommand.mock.calls[0]![1].handler;
  return { cwd, model, catalog, registry, settings, state, ui, ctx, session, pi, runtime, choices, inputs, pickerFrames, run: (args = "") => handler(args, ctx),
    notices: () => ui.notify.mock.calls.map((c: any[]) => c[0]).join("\n") };
}

describe("shared context-budget command, synthetic local/remote UI", () => {
  it("uses a bounded custom model picker instead of the unbounded native select", async () => {
    const f = fixture(); await f.run();
    expect(f.ui.custom).toHaveBeenCalledTimes(1); expect(f.ui.select).toHaveBeenCalledTimes(1);
  });
  it("cannot save an unauthenticated model when the available snapshot is empty", async () => {
    const f = fixture(); f.registry.getAvailable.mockReturnValue([]); await f.run();
    expect(f.notices()).toContain("已授权/登录"); expect(existsSync(budgetPath(f.cwd))).toBe(false);
    expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("registers the one public command and uses the picker plus standard actions/input/confirm", async () => {
    const f = fixture(); expect(f.pi.registerCommand.mock.calls[0]![0]).toBe("context-budget");
    await f.run();
    expect(readBudget(f.cwd).config.models["fake/m"]).toEqual({ contextWindow: 1050000, compactAtTokens: 800000 });
    expect(f.ui.custom).toHaveBeenCalledTimes(1); expect(f.ui.select).toHaveBeenCalledTimes(1);
    expect(f.ui.input).toHaveBeenCalledTimes(2); expect(f.ui.confirm).toHaveBeenCalledTimes(1);
    expect(f.notices()).toContain("已保存并回读"); expect(f.notices()).toContain("trigger>800000");
    expect(f.settings.getCompactionSettings(f.session.model).reserveTokens).toBe(250000);
    expect(readdirSync(join(f.cwd, ".pi"))).toEqual(["context-budget.json"]);
  });
  it("configures several catalog models without selecting them as the current model", async () => {
    const f = fixture(); f.choices[0] = "fake/other"; f.inputs[0] = "262144"; f.inputs[1] = "200000";
    await f.run(); expect(f.session.model.id).toBe("m"); expect(f.session.model.contextWindow).toBe(272000);
    expect(f.settings.getCompactionSettings(f.session.model).reserveTokens).toBe(16384);
    f.choices.push("fake/m", EDIT); f.inputs.push("1050000", "800000"); await f.run();
    expect(readBudget(f.cwd).config.models).toEqual({
      "fake/other": { contextWindow: 262144, compactAtTokens: 200000 },
      "fake/m": { contextWindow: 1050000, compactAtTokens: 800000 },
    });
    expect(f.session.model.id).toBe("m");
    expect(f.pickerFrames[0]).toEqual(["fake/m", "fake/other"]);
  });
  it("can remove an obsolete configured model without trying to register it", async () => {
    const f = fixture(); saveBudget(f.cwd, null, { version: 1, models: { "fake/obsolete": { contextWindow: 1050000, compactAtTokens: 800000 } } }, () => () => {});
    f.choices.splice(0, 2, MANAGE, "fake/obsolete", RESET); await f.run();
    expect(f.pickerFrames).toEqual([["fake/m", "fake/other", MANAGE], ["fake/obsolete"]]);
    expect((f.ui.select.mock.calls[0] as any)[1]).toEqual([RESET, "关闭"]);
    expect(readBudget(f.cwd).config.models).toEqual({}); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("status reports exact host/configured/effective values without files or prompts", async () => {
    const f = fixture(); await f.run("status"); expect(f.notices()).toContain("trigger>255616");
    expect(f.ui.input).not.toHaveBeenCalled(); expect(f.ui.select).not.toHaveBeenCalled(); expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(existsSync(join(f.cwd, ".pi"))).toBe(false); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it.each(["model", "action", "window", "threshold", "confirm"])("cancellation at %s never saves/applies", async stage => {
    const f = fixture();
    if (stage === "model") f.choices[0] = undefined; if (stage === "action") f.choices[1] = undefined;
    if (stage === "window") f.inputs[0] = undefined; if (stage === "threshold") f.inputs[1] = undefined;
    if (stage === "confirm") f.ui.confirm.mockResolvedValue(false);
    await f.run(); expect(existsSync(budgetPath(f.cwd))).toBe(false); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it.each(["800k", "1e6", "800000.1", "-1", "", "9007199254740992"])("invalid input %s is rejected without saving", async input => {
    const f = fixture(); f.inputs[1] = input; await f.run();
    expect(f.notices()).toContain("安全整数"); expect(existsSync(budgetPath(f.cwd))).toBe(false);
  });
  it("requires a valid window and preserves disabled auto-compaction", async () => {
    const f = fixture(); f.settings.applyOverrides({ compaction: { enabled: false } }); await f.run();
    expect(f.notices()).toContain("auto=off");
    const g = fixture(); g.inputs[0] = "100000"; g.inputs[1] = "50000"; await g.run();
    expect(g.notices()).toContain("输出上限"); expect(existsSync(budgetPath(g.cwd))).toBe(false);
  });
  it("warns before lowering the threshold below current usage", async () => {
    const f = fixture(); f.state.usage = 850000; await f.run();
    expect((f.ui.confirm.mock.calls[0] as any)[1]).toContain("当前估算 850000 已超过新阈值");
    expect((f.ui.confirm.mock.calls[0] as any)[1]).toContain("不等于服务端/订阅容量");
  });
  it("does not invent context usage when it is unknown", async () => {
    const f = fixture(); f.state.usage = null; await f.run();
    expect((f.ui.confirm.mock.calls[0] as any)[1]).not.toContain("当前估算");
  });
  it.each(["custom", "select", "input", "confirm"])("remote lease expiry after %s refuses save/apply", async stage => {
    const f = fixture();
    if (stage === "custom") f.ui.custom.mockImplementationOnce(async () => { f.state.valid = false; return "fake/m"; });
    if (stage === "select") f.ui.select.mockImplementationOnce(async () => { f.state.valid = false; return EDIT; });
    if (stage === "input") f.ui.input.mockImplementationOnce(async () => { f.state.valid = false; return "1050000"; });
    if (stage === "confirm") f.ui.confirm.mockImplementationOnce(async () => { f.state.valid = false; return true; });
    await f.run(); expect(f.notices()).toContain("已失效"); expect(existsSync(budgetPath(f.cwd))).toBe(false);
  });
  it("refuses to commit if a run started while confirmation was open", async () => {
    const f = fixture(); f.ui.confirm.mockImplementationOnce(async () => { f.state.idle = false; return true; });
    await f.run(); expect(f.notices()).toContain("Pi 正忙"); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("rejects concurrent disk edits without applying the candidate", async () => {
    const f = fixture(); f.ui.confirm.mockImplementationOnce(async () => {
      saveBudget(f.cwd, null, { version: 1, models: {} }, () => () => {}); return true;
    });
    await f.run(); expect(f.notices()).toContain("另一操作"); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("leaves disk/runtime unchanged on lock failure", async () => {
    const f = fixture(); mkdirSync(join(f.cwd, ".pi")); mkdirSync(`${budgetPath(f.cwd)}.lock`);
    await f.run(); expect(f.notices()).toContain("锁"); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("will not overlap two menus from local and remote callers", async () => {
    const f = fixture(); let answer!: (value: undefined) => void;
    f.ui.custom.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = f.run(); await f.run(); expect(f.notices()).toContain("已有预算菜单");
    answer(undefined); await pending; expect(f.ui.custom).toHaveBeenCalledTimes(1);
  });
  it("restores default by removing disk rule but honestly retaining current runtime until reload", async () => {
    const f = fixture(); await f.run(); const reserve = f.settings.getCompactionSettings(f.session.model).reserveTokens;
    f.choices.push("fake/m", RESET); await f.run();
    expect(readBudget(f.cwd).config.models).toEqual({}); expect(f.notices()).toContain("当前运行值尚未重置");
    expect(f.settings.getCompactionSettings(f.session.model).reserveTokens).toBe(reserve);
    await f.run("status"); expect(f.notices()).toContain("当前预算仍在运行");
    f.runtime.dispose(); await f.settings.reload(); f.runtime.start(f.ctx);
    expect(f.settings.getCompactionSettings(f.session.model).reserveTokens).toBe(16384);
    expect(f.session.model.contextWindow).toBe(272000);
  });
  it("reports an unselected current model instead of a silent status response", async () => {
    const f = fixture(); Object.defineProperty(f.ctx, "model", { value: undefined });
    await f.run("status"); expect(f.notices()).toContain("尚未选择当前模型");
    expect(f.ui.select).not.toHaveBeenCalled(); expect(existsSync(budgetPath(f.cwd))).toBe(false);
  });
  it("sorts and deduplicates only available chat models, moving the eligible current one first", async () => {
    const f = fixture(); const second = { ...f.model, provider: "aaa", id: "path/m" };
    f.registry.getAvailable.mockReturnValue([second, f.catalog[1], f.model, second, { ...second, type: "image", id: "image" }]);
    f.choices[0] = undefined; await f.run();
    expect(f.pickerFrames[0]).toEqual(["fake/m", "aaa/path/m", "fake/other"]);
    expect(existsSync(budgetPath(f.cwd))).toBe(false);
  });
  it("does not force an unauthenticated current model into the picker and still reports its real status", async () => {
    const f = fixture(); f.registry.getAvailable.mockReturnValue([f.catalog[1]]);
    f.choices[0] = undefined; await f.run(); expect(f.pickerFrames[0]).toEqual(["fake/other"]);
    f.registry.getAvailable.mockImplementation(() => { throw new Error("status must not enumerate availability"); });
    await f.run("status"); expect(f.notices()).toContain("实际：window=272000, reserve=16384, trigger>255616");
    expect(existsSync(budgetPath(f.cwd))).toBe(false);
  });
  it("keeps unlisted stored rules out of the main model list without deleting any data", async () => {
    const f = fixture(); const saved = saveBudget(f.cwd, null, { version: 1, models: {
      "fake/m": { contextWindow: 1050000, compactAtTokens: 800000 },
      "missing/path/model": { contextWindow: 500000, compactAtTokens: 400000 },
    } }, () => () => {});
    f.registry.getAvailable.mockReturnValue([f.catalog[1]]); f.choices[0] = undefined; await f.run();
    expect(f.pickerFrames[0]).toEqual(["fake/other", MANAGE]);
    expect(readBudget(f.cwd)).toEqual(saved); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it.each(["close", "cancel-rule", "cancel-confirm", "delete", "forged-edit"])("manages saved rules with no authenticated models: %s", async mode => {
    const f = fixture(); const saved = saveBudget(f.cwd, null, { version: 1, models: {
      "fake/m": { contextWindow: 1050000, compactAtTokens: 800000 },
    } }, () => () => {});
    f.registry.getAvailable.mockReturnValue([]);
    f.choices.splice(0, 2, MANAGE, mode === "cancel-rule" ? undefined : "fake/m",
      mode === "close" ? "关闭" : mode === "forged-edit" ? EDIT : RESET);
    if (mode === "cancel-confirm") f.ui.confirm.mockResolvedValue(false);
    await f.run(); expect(f.pickerFrames[0]).toEqual([MANAGE]);
    expect(f.notices()).toContain("已保存的规则保留");
    if (mode === "delete") expect(readBudget(f.cwd).config.models).toEqual({});
    else expect(readBudget(f.cwd)).toEqual(saved);
    expect(f.ui.input).not.toHaveBeenCalled(); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("preserves a hidden saved rule while editing a different available model", async () => {
    const f = fixture(); const savedRule = { contextWindow: 1050000, compactAtTokens: 800000 };
    saveBudget(f.cwd, null, { version: 1, models: { "fake/m": savedRule } }, () => () => {});
    f.registry.getAvailable.mockImplementation(() => [f.registry.find("fake", "other")]);
    f.choices[0] = "fake/other"; f.inputs.splice(0, 2, "500000", "400000"); await f.run();
    expect(readBudget(f.cwd).config.models).toEqual({ "fake/m": savedRule,
      "fake/other": { contextWindow: 500000, compactAtTokens: 400000 } });
    expect(f.pickerFrames[0]).toEqual(["fake/other", MANAGE]); expect(f.session.model.id).toBe("m");
  });
  it("revalidates the remote lease after the unlisted-rule picker", async () => {
    const f = fixture(); saveBudget(f.cwd, null, { version: 1, models: {
      "missing/m": { contextWindow: 500000, compactAtTokens: 400000 },
    } }, () => () => {});
    f.ui.custom.mockResolvedValueOnce(MANAGE).mockImplementationOnce(async () => { f.state.valid = false; return "missing/m"; });
    const before = readBudget(f.cwd); await f.run();
    expect(f.notices()).toContain("已失效"); expect(readBudget(f.cwd)).toEqual(before);
    expect(f.ui.confirm).not.toHaveBeenCalled();
  });
  it.each(["custom", "select", "window", "threshold", "confirm"])("refuses an edit if availability changes after %s", async stage => {
    const f = fixture(); const revoke = () => f.registry.getAvailable.mockReturnValue([]);
    if (stage === "custom") f.ui.custom.mockImplementationOnce(async () => { revoke(); return "fake/m"; });
    if (stage === "select") f.ui.select.mockImplementationOnce(async () => { revoke(); return EDIT; });
    if (stage === "window") f.ui.input.mockImplementationOnce(async () => { revoke(); return "1050000"; });
    if (stage === "threshold") f.ui.input.mockResolvedValueOnce("1050000").mockImplementationOnce(async () => { revoke(); return "800000"; });
    if (stage === "confirm") f.ui.confirm.mockImplementationOnce(async () => { revoke(); return true; });
    await f.run(); expect(f.notices()).toContain("已不在 Pi 当前已授权/登录");
    expect(existsSync(join(f.cwd, ".pi"))).toBe(false); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("rejects a forged picker result outside the opening snapshot", async () => {
    const f = fixture(); f.registry.getAvailable.mockReturnValue([f.catalog[1]]);
    await f.run(); expect(f.notices()).toContain("模型选择已失效"); expect(f.ui.input).not.toHaveBeenCalled();
  });
  it("reads the latest snapshot when reopened, rather than caching or refreshing it itself", async () => {
    const f = fixture(); f.choices.splice(0, 2, undefined, undefined);
    f.registry.getAvailable.mockReturnValue([f.catalog[1]]); await f.run();
    f.registry.getAvailable.mockReturnValue([f.model]); await f.run();
    expect(f.pickerFrames).toEqual([["fake/other"], ["fake/m"]]);
  });
  it("retains the whole-rule validation rather than silently dropping missing saved models", async () => {
    const f = fixture(); const before = saveBudget(f.cwd, null, { version: 1, models: {
      "missing/m": { contextWindow: 500000, compactAtTokens: 400000 },
    } }, () => () => {});
    await f.run(); expect(f.notices()).toContain("整组预算未应用");
    expect(readBudget(f.cwd)).toEqual(before); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("does not save or prompt on an unavailable compatibility bridge", async () => {
    const f = fixture(); f.state.supported = false; await f.run();
    expect(f.notices()).toContain("桥接"); expect(f.ui.select).not.toHaveBeenCalled();
  });
  it("rejects unknown arguments instead of forwarding them as a model prompt", async () => {
    const f = fixture(); await f.run("set fake/m 1 2"); expect(f.notices()).toContain("用法");
    expect(f.ui.select).not.toHaveBeenCalled(); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
});
