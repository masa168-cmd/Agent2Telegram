import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBudgetRuntime } from "../context-budget/runtime.ts";
import { saveBudget } from "../context-budget/config.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const rule = { contextWindow: 1050000, compactAtTokens: 800000 };
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "budget-runtime-")); roots.push(cwd);
  const m: any = { provider: "fake", id: "m", name: "Synthetic", api: "openai-responses", contextWindow: 272000,
    maxTokens: 128000, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const other = { ...m, id: "other" }; const image = { provider: "fake", id: "m", type: "image" };
  const classifier = { provider: "fake", id: "m", type: "classifier", contextWindow: 64000 };
  const catalog = [m, other]; const all = [m, other, image, classifier];
  const base: any = { id: "fake", name: "Fake", getModels: () => catalog, getAllModels: () => all,
    auth: { resolve: vi.fn() }, stream: vi.fn(), streamSimple: vi.fn(), refreshModels: vi.fn(),
    images: { synthetic: vi.fn() }, classifiers: { synthetic: vi.fn() }, filterModels: vi.fn() };
  const bases = new Map<string, any>([["fake", base]]); const registered = new Map<string, any>();
  const legacy = new Map<string, any>();
  const registry: any = { getProvider: (id: string) => registered.get(id) ?? bases.get(id),
    getRegisteredNativeProvider: (id: string) => registered.get(id), getRegisteredProviderConfig: (id: string) => legacy.get(id),
    getAll: vi.fn(() => [...bases.keys()].flatMap(id => registry.getProvider(id).getModels())),
    getAvailable: vi.fn(() => [...bases.keys()].flatMap(id => registry.getProvider(id).getModels())),
    find: (p: string, id: string) => registry.getProvider(p)?.getModels().find((x: any) => x.id === id && x.provider === p) };
  const settings = SettingsManager.inMemory({ compaction: { keepRecentTokens: 12345, modelOverrides: { "fake/other": { keepRecentTokens: 555 } } } });
  const state = { trusted: true, supported: true, remote: true, idle: true, pending: false, id: "synthetic-session",
    cwd, selected: "m", staleModel: false };
  const sessionManager = { getSessionId: () => state.id };
  const ctx: any = { cwd, sessionManager, modelRegistry: registry, hasUI: true,
    ui: { notify: vi.fn() }, isProjectTrusted: () => state.trusted, isIdle: () => state.idle,
    hasPendingMessages: () => state.pending, get model() { return session.model; } };
  const session: any = { settingsManager: settings, sessionManager, isStreaming: false, isCompacting: false,
    get model() { return state.staleModel ? m : registry.find("fake", state.selected); },
    extensionRunner: { createCommandContext: () => ({ ...ctx, cwd: state.cwd }) } };
  let active: any = session;
  const pi: any = { registerProvider: vi.fn((p: any) => registered.set(p.id, p)), unregisterProvider: vi.fn((id: string) => registered.delete(id)) };
  const runtime = new ContextBudgetRuntime(pi, { getSession: () => active,
    supported: () => state.supported, captureOperation: () => () => state.remote });
  return { cwd, m, other, image, classifier, all, catalog, base, bases, registered, legacy, registry, settings, state,
    ctx, session, pi, runtime, lease: () => runtime.capture(ctx), replaceSession: () => { active = { ...session }; } };
}

describe("budget runtime uses real SDK in-memory settings with synthetic providers", () => {
  it("lists only the cached authenticated chat snapshot, not the entire catalog", () => {
    const f = fixture(); const second = { ...f.m, provider: "second", id: "path/m", type: "chat" };
    f.registry.getAvailable.mockReturnValue([f.m, second, f.image, f.classifier]);
    expect(f.runtime.list(f.lease())).toEqual([f.m, second]);
    expect(f.registry.getAll).not.toHaveBeenCalled();
    expect(f.base.auth.resolve).not.toHaveBeenCalled(); expect(f.base.refreshModels).not.toHaveBeenCalled();
  });
  it("does not fall back to the full catalog when the available snapshot is empty", () => {
    const f = fixture(); f.registry.getAvailable.mockReturnValue([]);
    expect(f.runtime.list(f.lease())).toEqual([]); expect(f.registry.getAll).not.toHaveBeenCalled();
  });
  it("uses the real SDK synchronous facade without its asynchronous auth/refresh paths", () => {
    const f = fixture(); const snapshot = vi.fn(() => [f.m]);
    const forbidden = vi.fn(() => { throw new Error("auth/refresh must not run"); });
    f.ctx.modelRegistry = new ModelRegistry({ getAvailableSnapshot: snapshot, getModels: () => [f.m, f.other],
      getAvailable: forbidden, refresh: forbidden, getAuth: forbidden } as any);
    expect(f.runtime.list(f.lease())).toEqual([f.m]);
    expect(snapshot).toHaveBeenCalledTimes(1); expect(forbidden).not.toHaveBeenCalled();
  });
  it("derives strict 800k trigger, reports exact values, leaves other compaction fields intact", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    const settings = f.settings.getCompactionSettings(f.session.model);
    expect(shouldCompact(800000, f.session.model.contextWindow, settings)).toBe(false);
    expect(shouldCompact(800001, f.session.model.contextWindow, settings)).toBe(true);
    expect(settings).toEqual({ enabled: true, reserveTokens: 250000, keepRecentTokens: 12345 });
    expect(f.runtime.describe(f.lease(), "fake/m")).toMatchObject({ baseWindow: 272000, baseReserve: 16384,
      window: 1050000, reserve: 250000, trigger: 800000, enabled: true });
    expect(f.settings.getGlobalSettings().compaction?.modelOverrides?.["fake/m"]).toBeUndefined();
    expect(f.settings.getProjectSettings()).toEqual({});
  });
  it("preserves full Provider behavior, non-target models and non-chat models with the same ID", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    const p = f.registered.get("fake");
    for (const key of ["auth", "stream", "streamSimple", "refreshModels", "images", "classifiers", "filterModels"]) expect(p[key]).toBe(f.base[key]);
    expect(p.getModels()[1]).toBe(f.other); expect(p.getAllModels().slice(2)).toEqual([f.image, f.classifier]);
    expect(p.getAllModels()[2]).toBe(f.image); expect(p.getAllModels()[3]).toBe(f.classifier);
    expect(p.getModels()[0]).toEqual({ ...f.m, contextWindow: 1050000 }); expect(f.m.contextWindow).toBe(272000);
    const future = { ...f.m, id: "future" }; f.catalog.push(future); expect(p.getModels().at(-1)).toBe(future);
    expect(f.base.auth.resolve).not.toHaveBeenCalled(); expect(f.base.refreshModels).not.toHaveBeenCalled();
    expect(f.base.stream).not.toHaveBeenCalled();
  });
  it("supports explicit chat models and providers without getAllModels", () => {
    const f = fixture(); f.m.type = "chat"; delete f.base.getAllModels;
    f.runtime.install({ "fake/m": rule }, f.lease()); expect(f.registered.get("fake").getAllModels()).toHaveLength(2);
  });
  it("switches models without changing unconfigured defaults or calling setModel", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease()); f.state.selected = "other";
    expect(f.settings.getCompactionSettings(f.session.model)).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 555 });
    expect(f.session.model.contextWindow).toBe(272000); f.state.selected = "m";
    expect(f.settings.getCompactionSettings(f.session.model).reserveTokens).toBe(250000);
  });
  it("must retain the approved threshold after the real SDK model-selection setting save", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    // Real Pi setModel calls this public setter. In-memory storage only; no host files.
    f.settings.setDefaultModelAndProvider("fake", "other");
    f.settings.setDefaultModelAndProvider("fake", "m");
    const actual = f.runtime.describe(f.lease(), "fake/m");
    expect({ window: actual.window, reserve: actual.reserve, trigger: actual.trigger })
      .toEqual({ window: 1050000, reserve: 250000, trigger: 800000 });
  });
  it("must retain the approved threshold after an unrelated real SDK setting save", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    f.settings.setTheme("synthetic-night"); // Unrelated field; in-memory storage only.
    const actual = f.runtime.describe(f.lease(), "fake/m");
    expect({ window: actual.window, reserve: actual.reserve, trigger: actual.trigger })
      .toEqual({ window: 1050000, reserve: 250000, trigger: 800000 });
  });
  it("supports multiple configured models and providers, exact slash IDs", () => {
    const f = fixture(); f.bases.set("second", { ...f.base, id: "second", getModels: () => [{ ...f.m, provider: "second", id: "path/m" }] });
    f.runtime.install({ "fake/m": rule, "fake/other": { contextWindow: 500000, compactAtTokens: 400000 }, "second/path/m": rule }, f.lease());
    expect(f.runtime.describe(f.lease(), "second/path/m").trigger).toBe(800000);
    expect(f.runtime.describe(f.lease(), "fake/other").trigger).toBe(400000);
    f.runtime.dispose(); expect(f.registered.size).toBe(0);
  });
  it("does not enable disabled auto-compaction", () => {
    const f = fixture(); f.settings.applyOverrides({ compaction: { enabled: false } });
    f.runtime.install({ "fake/m": rule }, f.lease());
    expect(shouldCompact(800001, 1050000, f.settings.getCompactionSettings(f.session.model))).toBe(false);
  });
  it("updates an owned wrapper without nesting it and can undo the whole update", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease()); const first = f.registered.get("fake");
    const undo = f.runtime.install({ "fake/m": { contextWindow: 900000, compactAtTokens: 600000 } }, f.lease());
    expect(f.runtime.describe(f.lease(), "fake/m").baseWindow).toBe(272000); undo();
    expect(f.registered.get("fake")).toBe(first); expect(f.runtime.describe(f.lease(), "fake/m").trigger).toBe(800000);
  });
  it.each(["native", "legacy"])("refuses existing %s provider overrides without touching settings", kind => {
    const f = fixture(); (kind === "native" ? f.registered : f.legacy).set("fake", f.base);
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("已有扩展覆盖");
    expect(f.pi.registerProvider).not.toHaveBeenCalled(); expect(f.settings.getCompactionSettings(f.m).reserveTokens).toBe(16384);
  });
  it.each(["supported", "trusted", "remote"])("refuses a missing %s fence", field => {
    const f = fixture(); (f.state as any)[field] = false;
    expect(() => f.runtime.capture(f.ctx)).toThrow(); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("refuses missing capture and public settings capability", () => {
    const f = fixture(); const runtime = new ContextBudgetRuntime(f.pi, { getSession: () => undefined, supported: () => true, captureOperation: () => () => true });
    expect(() => runtime.capture(f.ctx)).toThrow("桥接");
    f.session.settingsManager = {}; expect(() => f.runtime.capture(f.ctx)).toThrow("桥接");
  });
  it.each(["session", "cwd", "id", "remote", "epoch", "busy", "compacting", "pending"])("rejects %s changes during a menu", change => {
    const f = fixture(); const lease = f.lease();
    if (change === "session") f.replaceSession(); if (change === "cwd") f.state.cwd += "/other";
    if (change === "id") f.state.id = "other"; if (change === "remote") f.state.remote = false;
    if (change === "epoch") f.runtime.dispose(); if (change === "busy") f.state.idle = false;
    if (change === "compacting") f.session.isCompacting = true; if (change === "pending") f.state.pending = true;
    expect(() => f.runtime.install({ "fake/m": rule }, lease)).toThrow(); expect(f.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("rejects missing models and invalid window/output relationship", () => {
    const f = fixture(); expect(() => f.runtime.install({ "fake/missing": rule }, f.lease())).toThrow("不可用");
    expect(() => f.runtime.install({ "fake/m": { contextWindow: 100000, compactAtTokens: 80000 } }, f.lease())).toThrow("输出上限");
  });
  it("keeps plugin priority while preserving new native defaults underneath for unload", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    f.settings.applyOverrides({ compaction: { modelOverrides: { "fake/m": { reserveTokens: 12345 } } } });
    expect(f.runtime.describe(f.lease(), "fake/m").reserve).toBe(250000);
    f.runtime.dispose(); expect(f.settings.getCompactionSettings(f.m).reserveTokens).toBe(12345);
  });
  it("rolls back even a registration throwing after it installed the wrapper", () => {
    const f = fixture(); f.pi.registerProvider.mockImplementationOnce((p: any) => { f.registered.set(p.id, p); throw new Error("synthetic register failure"); });
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("register failure");
    expect(f.registered.size).toBe(0); expect(f.settings.getCompactionSettings(f.m).reserveTokens).toBe(16384);
  });
  it("requires current-model readback, not only registry metadata", () => {
    const f = fixture(); f.state.staleModel = true;
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("回读不一致");
    expect(f.registered.size).toBe(0); expect(f.settings.getCompactionSettings(f.m).reserveTokens).toBe(16384);
  });
  it("shutdown invalidates menus and restores paired numeric defaults idempotently", () => {
    const f = fixture(); const lease = f.lease(); f.runtime.install({ "fake/m": rule }, lease);
    f.runtime.dispose(); f.runtime.dispose(); expect(() => f.runtime.assertCurrent(lease)).toThrow();
    expect(f.session.model.contextWindow).toBe(272000);
    expect(f.settings.getCompactionSettings(f.m).reserveTokens).toBe(16384);
    expect(f.pi.unregisterProvider).toHaveBeenCalledTimes(1);
  });
  it("does not unregister a provider another extension took over", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease()); f.registered.set("fake", f.base);
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("其它扩展");
    f.runtime.dispose(); expect(f.pi.unregisterProvider).not.toHaveBeenCalled(); expect(f.registered.get("fake")).toBe(f.base);
  });
  it("loads configured rules at startup; absent/untrusted workspaces do nothing", () => {
    const f = fixture(); f.runtime.start(f.ctx); expect(f.pi.registerProvider).not.toHaveBeenCalled();
    saveBudget(f.cwd, null, { version: 1, models: { "fake/m": rule } }, () => () => {});
    f.state.trusted = false; f.runtime.start(f.ctx); expect(f.pi.registerProvider).not.toHaveBeenCalled();
    f.state.trusted = true; f.runtime.start(f.ctx); expect(f.session.model.contextWindow).toBe(1050000);
    f.runtime.dispose(); f.runtime.start(f.ctx); expect(f.session.model.contextWindow).toBe(1050000);
  });
  it.each(["theme", "thinking", "compaction", "project", "reload"])("survives real SDK %s saving/reload without overriding its changes", async operation => {
    const f = fixture(); const raw = f.settings.getSettings();
    f.runtime.install({ "fake/m": rule }, f.lease());
    expect(f.settings.getSettings()).toEqual(raw); // No derived modelOverrides hidden in settings snapshots.
    if (operation === "theme") f.settings.setTheme("synthetic-night");
    if (operation === "thinking") f.settings.setDefaultThinkingLevel("high");
    if (operation === "compaction") f.settings.setCompactionEnabled(false);
    if (operation === "project") f.settings.setProjectThemePaths(["synthetic-theme"]);
    if (operation === "reload") await f.settings.reload();
    expect(f.runtime.describe(f.lease(), "fake/m").trigger).toBe(800000);
    expect(f.settings.getCompactionSettings(f.session.model).enabled).toBe(operation !== "compaction");
    f.runtime.dispose(); expect(f.settings.getCompactionReserveTokens(f.m)).toBe(16384);
    expect(Object.hasOwn(f.settings, "getCompactionReserveTokens")).toBe(false);
  });
  it("is instance-only, restores exact inherited function and deactivates retained old wrappers", () => {
    const f = fixture(); const native = f.settings.getCompactionReserveTokens;
    const other = SettingsManager.inMemory();
    f.runtime.install({ "fake/m": rule }, f.lease()); const old = f.settings.getCompactionReserveTokens;
    expect(Object.getPrototypeOf(f.settings).getCompactionReserveTokens).toBe(native);
    expect(other.getCompactionReserveTokens(f.m)).toBe(16384);
    expect(old.call(other, f.m)).toBe(16384);
    expect(f.settings.getCompactionReserveTokens()).toBe(16384);
    f.runtime.dispose(); expect(f.settings.getCompactionReserveTokens).toBe(native);
    expect(old.call(f.settings, f.m)).toBe(16384);
  });
  it("refuses an existing instance method override and a frozen manager", () => {
    const f = fixture(); f.settings.getCompactionReserveTokens = () => 500;
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("已有实例覆盖");
    expect(f.pi.registerProvider).not.toHaveBeenCalled();
    const g = fixture(); Object.preventExtensions(g.settings);
    expect(() => g.runtime.install({ "fake/m": rule }, g.lease())).toThrow("不支持");
    expect(g.pi.registerProvider).not.toHaveBeenCalled();
  });
  it("does not overwrite another extension's getter, including a wrapper retaining ours", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    const ours = f.settings.getCompactionReserveTokens;
    const theirs = (m: any) => ours.call(f.settings, m) + 1;
    f.settings.getCompactionReserveTokens = theirs;
    expect(() => f.runtime.install({ "fake/m": rule }, f.lease())).toThrow("其它扩展");
    f.runtime.dispose(); expect(f.settings.getCompactionReserveTokens).toBe(theirs);
    expect(theirs(f.m)).toBe(16385); // Our retained wrapper is now inactive.
  });
  it("preserves native validation and refuses a mismatched model/provider window", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    expect(() => f.settings.getCompactionSettings(f.m)).toThrow("模型对象过期");
    expect(f.settings.getCompactionReserveTokens(f.classifier as any)).toBe(16384);
    f.settings.applyOverrides({ compaction: { reserveTokens: -1 } });
    expect(() => f.settings.getCompactionSettings(f.session.model)).toThrow("non-negative");
    f.runtime.dispose();
    const g = fixture(); g.runtime.install({ "fake/m": rule }, g.lease()); g.registered.set("fake", g.base);
    expect(() => g.settings.getCompactionSettings(g.session.model)).toThrow("覆盖已失效");
  });
  it("refuses active project budgets after public SDK trust revocation", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    f.settings.setProjectTrusted(false);
    expect(() => f.settings.getCompactionSettings(f.session.model)).toThrow("项目不再受信任");
    f.runtime.dispose(); expect(f.session.model.contextWindow).toBe(272000);
    expect(f.settings.getCompactionReserveTokens(f.m)).toBe(16384);
  });
  it("refreshes a stale scoped-model selection through public registration, not a model switch", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease()); f.state.staleModel = true;
    f.pi.registerProvider.mockImplementation((p: any) => { f.registered.set(p.id, p); f.state.staleModel = false; });
    f.runtime.modelSelected(f.ctx); expect(f.runtime.describe(f.lease(), "fake/m").trigger).toBe(800000);
    expect(f.session.model.contextWindow).toBe(1050000);
  });
  it("does not install any wrapper for empty rules and isolates applied rules from caller mutation", () => {
    const f = fixture(); f.runtime.install({}, f.lease()); expect(Object.hasOwn(f.settings, "getCompactionReserveTokens")).toBe(false);
    const candidate = { ...rule }; f.runtime.install({ "fake/m": candidate }, f.lease()); candidate.compactAtTokens = 1;
    expect(f.runtime.describe(f.lease(), "fake/m").trigger).toBe(800000);
  });
  it("applies shared-cwd data only on each instance's explicit load, not by broadcasting", () => {
    const a = fixture(), b = fixture(); b.ctx.cwd = a.cwd; b.state.cwd = a.cwd;
    const saved = saveBudget(a.cwd, null, { version: 1, models: { "fake/m": rule } }, () => () => {});
    a.runtime.start(a.ctx); b.runtime.start(b.ctx);
    const next = { "fake/m": { contextWindow: 900000, compactAtTokens: 600000 } };
    saveBudget(a.cwd, saved.revision, { version: 1, models: next }, () => a.runtime.install(next, a.lease()));
    expect(a.runtime.describe(a.lease(), "fake/m").trigger).toBe(600000);
    expect(b.runtime.describe(b.lease(), "fake/m").trigger).toBe(800000);
    b.runtime.dispose(); b.runtime.start(b.ctx); expect(b.runtime.describe(b.lease(), "fake/m").trigger).toBe(600000);
    a.runtime.dispose(); b.runtime.dispose();
  });
  it("rolls back every newly registered provider on a later registration failure", () => {
    const f = fixture(); f.bases.set("second", { ...f.base, id: "second", getModels: () => [{ ...f.m, provider: "second" }] });
    const native = f.settings.getCompactionReserveTokens;
    f.pi.registerProvider.mockImplementation((p: any) => {
      f.registered.set(p.id, p); if (p.id === "second") throw new Error("synthetic second-provider failure");
    });
    expect(() => f.runtime.install({ "fake/m": rule, "second/m": rule }, f.lease())).toThrow("second-provider");
    expect(f.registered.size).toBe(0); expect(f.settings.getCompactionReserveTokens).toBe(native);
    expect(f.settings.getSettings().compaction?.modelOverrides?.["fake/m"]).toBeUndefined();
  });
  it("does not silently reset active rules deleted from disk while another rule is edited", () => {
    const f = fixture(); f.runtime.install({ "fake/m": rule }, f.lease());
    f.runtime.install({ "fake/other": rule }, f.lease());
    expect(f.runtime.describe(f.lease(), "fake/m").trigger).toBe(800000);
  });
});
