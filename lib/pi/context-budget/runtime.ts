import type { AnyModel, Api, Model, Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CapturedAgentSession } from "../captured-session.ts";
import { readBudget, validateBudget, type ModelBudget } from "./config.ts";

const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const splitKey = (key: string) => [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)] as const;
const RESERVE_METHOD = "getCompactionReserveTokens";
export type BudgetLease = {
  ctx: ExtensionContext; session: CapturedAgentSession; cwd: string; id: string;
  epoch: number; currentOperation: () => boolean;
};
type Registration = { base: Provider; wrapped: Provider };
type Original = { model: Model<Api>; reserve: number };
type ReserveGetter = SettingsManager[typeof RESERVE_METHOD];
type Adapter = {
  manager: SettingsManager; original: ReserveGetter; wrapped: ReserveGetter;
  active: boolean;
};
export type BudgetRuntimeDeps = {
  getSession(): CapturedAgentSession | undefined;
  supported(): boolean;
  captureOperation(): () => boolean;
};

/** Pi 1.4.0 instance-only compatibility adapter, NOT an official extension override hook. */
export class ContextBudgetRuntime {
  private epoch = 0;
  private owner?: BudgetLease;
  private adapter?: Adapter;
  private registrations = new Map<string, Registration>();
  private originals = new Map<string, Original>();
  private applied: Record<string, ModelBudget> = {};

  constructor(private readonly pi: Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">,
    private readonly deps: BudgetRuntimeDeps) {}

  capture(ctx: ExtensionContext): BudgetLease {
    const session = this.deps.getSession();
    if (!session?.settingsManager || typeof session.settingsManager.getCompactionSettings !== "function"
      || typeof session.settingsManager.getCompactionReserveTokens !== "function"
      || !this.deps.supported()) throw new Error("预算需要 Pi 1.4.0 的有效会话桥接；未应用，请通过 SSH 检查加载状态。");
    const lease = { ctx, session, cwd: ctx.cwd, id: ctx.sessionManager.getSessionId(), epoch: this.epoch,
      currentOperation: this.deps.captureOperation() };
    this.assertCurrent(lease);
    return lease;
  }

  assertCurrent(lease: BudgetLease, idle = false): void {
    const { ctx, session } = lease;
    const live = session.extensionRunner?.createCommandContext();
    if (lease.epoch !== this.epoch || this.deps.getSession() !== session || !this.deps.supported()
      || !lease.currentOperation() || ctx.cwd !== lease.cwd || live?.cwd !== lease.cwd
      || ctx.sessionManager.getSessionId() !== lease.id || session.sessionManager.getSessionId() !== lease.id
      || !ctx.isProjectTrusted() || !live.isProjectTrusted()) {
      throw new Error("会话、目录、信任或遥控授权已变化；本次预算操作已失效。");
    }
    if (idle && (!ctx.isIdle() || session.isStreaming || session.isCompacting || ctx.hasPendingMessages())) {
      throw new Error("Pi 正忙、正在压缩或有排队消息；未保存，请空闲后重试。");
    }
    if (this.owner && (this.owner.session !== session || this.owner.id !== lease.id || this.owner.cwd !== lease.cwd)) {
      throw new Error("预算仍属于上一会话；拒绝跨会话应用，请重载。");
    }
  }

  private assertOwnership(lease: BudgetLease): void {
    if (this.adapter && (this.adapter.manager !== lease.session.settingsManager
      || Object.getOwnPropertyDescriptor(this.adapter.manager, RESERVE_METHOD)?.value !== this.adapter.wrapped)) {
      throw new Error("压缩读取方法已被其它扩展替换；拒绝覆盖，请通过 SSH 检查。");
    }
    for (const [provider, entry] of this.registrations) {
      if (lease.ctx.modelRegistry.getRegisteredNativeProvider(provider) !== entry.wrapped
        || lease.ctx.modelRegistry.getRegisteredProviderConfig(provider)) {
        throw new Error("模型提供者已被其它扩展替换；拒绝覆盖，请通过 SSH 检查。");
      }
    }
  }

  start(ctx: ExtensionContext): void {
    // Project data is executable policy too: do not bypass Pi project trust.
    if (!ctx.isProjectTrusted?.()) return;
    const snapshot = readBudget(ctx.cwd);
    if (Object.keys(snapshot.config.models).length === 0) return;
    this.install(snapshot.config.models, this.capture(ctx));
  }

  list(lease: BudgetLease): Model<Api>[] {
    this.assertCurrent(lease);
    // Extension facade: synchronous cached availability, NOT ModelRuntime's async auth refresh.
    return lease.ctx.modelRegistry.getAvailable().filter(m => m.type === undefined || m.type === "chat");
  }

  describe(lease: BudgetLease, key: string) {
    this.assertCurrent(lease);
    this.assertOwnership(lease);
    const model = lease.ctx.modelRegistry.find(...splitKey(key));
    if (!model) throw new Error("模型不在当前目录中；未改配置。");
    const settings = lease.session.settingsManager.getCompactionSettings(model);
    const original = this.originals.get(key);
    const current = lease.session.model;
    if (current && keyOf(current) === key && current.contextWindow !== model.contextWindow) {
      throw new Error("当前模型窗口与目录不一致；未确认生效，请重新选择模型或重载。");
    }
    return { key, model, baseWindow: original?.model.contextWindow ?? model.contextWindow,
      baseReserve: original?.reserve ?? settings.reserveTokens,
      window: model.contextWindow, reserve: settings.reserveTokens,
      trigger: model.contextWindow - settings.reserveTokens, enabled: settings.enabled,
      applied: this.applied[key] };
  }

  /** Scoped model cycling can hold old model objects. Public re-registration refreshes the selected model. */
  modelSelected(ctx: ExtensionContext): void {
    if (!this.owner) return;
    const lease = this.capture(ctx);
    this.assertOwnership(lease);
    const current = lease.session.model;
    const registration = current && this.registrations.get(current.provider);
    if (!registration) return;
    this.pi.registerProvider(registration.wrapped);
    if (current && this.applied[keyOf(current)]) this.describe(lease, keyOf(current));
  }

  /** Synchronous paired update, undoable before atomic data-file publication. No native settings mutation. */
  install(rules: Record<string, ModelBudget>, lease: BudgetLease): () => void {
    this.assertCurrent(lease, true);
    this.assertOwnership(lease);
    const registry = lease.ctx.modelRegistry;
    const settings = lease.session.settingsManager;
    const previous = { registrations: this.registrations, originals: this.originals, applied: this.applied,
      owner: this.owner, adapter: this.adapter };
    const previousDescriptor = Object.getOwnPropertyDescriptor(settings, RESERVE_METHOD);
    // A new instance adapter must shadow an ordinary inherited public method, not another extension's patch.
    const original = this.adapter?.original ?? settings.getCompactionReserveTokens;
    if (!this.adapter && (previousDescriptor || !Object.isExtensible(settings)
      || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(settings), RESERVE_METHOD)?.value !== original)) {
      throw new Error("压缩读取方法已有实例覆盖或不支持可撤销适配；未应用。");
    }
    // Clone validated values: callers cannot mutate an active policy through a retained object reference.
    const nextRules = Object.fromEntries(Object.entries({ ...this.applied, ...rules })
      .map(([key, rule]) => [key, validateBudget(rule)]));
    if (Object.keys(nextRules).length === 0) return () => {};
    const nextOriginals = new Map(this.originals);
    const nextRegistrations = new Map<string, Registration>();
    const previousReserves = new Map<string, number>();
    for (const [key, rule] of Object.entries(nextRules)) {
      const [provider, id] = splitKey(key);
      const model = registry.find(provider, id);
      if (!model || (model.type !== undefined && model.type !== "chat")) throw new Error("配置中的聊天模型不可用；整组预算未应用。");
      if (rule.contextWindow <= model.maxTokens) throw new Error("上下文窗口必须大于该模型输出上限；不修改输出上限。");
      const reserve = settings.getCompactionSettings(model).reserveTokens;
      previousReserves.set(key, reserve);
      if (!nextOriginals.has(key)) nextOriginals.set(key, { model, reserve });
      if (nextRegistrations.has(provider)) continue;
      const owned = this.registrations.get(provider);
      if (!owned && (registry.getRegisteredNativeProvider(provider) || registry.getRegisteredProviderConfig(provider))) {
        throw new Error("该提供者已有扩展覆盖（可能是旧 long-context）；未叠加，请先安排成对迁移。");
      }
      const base = owned?.base ?? registry.getProvider(provider);
      if (!base) throw new Error("模型提供者不可用；未应用。");
      const patch = <T extends AnyModel>(m: T): T => {
        const budget = nextRules[keyOf(m)];
        return budget && (m.type === undefined || m.type === "chat") ? { ...m, contextWindow: budget.contextWindow } : m;
      };
      const wrapped: Provider = { ...base, getModels: () => base.getModels().map(patch),
        getAllModels: () => (base.getAllModels ? base.getAllModels() : base.getModels()).map(patch) };
      nextRegistrations.set(provider, { base, wrapped });
    }
    const adapter: Adapter = { manager: settings, original, active: true,
      wrapped: function (this: SettingsManager, model) {
        // Preserve validation and fallback behavior, including invalid native compaction settings.
        const native = original.call(this, model);
        if (!adapter.active || this !== settings || !model) return native;
        if ("type" in model && model.type !== undefined && model.type !== "chat") return native;
        const rule = nextRules[keyOf(model)];
        if (!rule) return native;
        if (!settings.isProjectTrusted()) throw new Error("项目不再受信任；拒绝继续使用项目预算，请检查并重载。");
        if (registry.getRegisteredNativeProvider(model.provider) !== nextRegistrations.get(model.provider)?.wrapped
          || registry.getRegisteredProviderConfig(model.provider)
          || registry.find(model.provider, model.id)?.contextWindow !== rule.contextWindow
          || ("contextWindow" in model && model.contextWindow !== rule.contextWindow)) {
          throw new Error("预算窗口覆盖已失效或模型对象过期；拒绝使用不成对的压缩阈值，请检查并重载。");
        }
        return rule.contextWindow - rule.compactAtTokens;
      },
    };
    let getterTouched = false;
    const attempted = new Set<string>();
    const undo = () => {
      if (getterTouched && Object.getOwnPropertyDescriptor(settings, RESERVE_METHOD)?.value !== adapter.wrapped) {
        adapter.active = false;
        throw new Error("压缩读取方法归属变化，无法安全回退预算。");
      }
      for (const provider of attempted) {
        const current = registry.getRegisteredNativeProvider(provider);
        const old = previous.registrations.get(provider);
        if (current !== nextRegistrations.get(provider)!.wrapped && current !== old?.wrapped) {
          adapter.active = false;
          throw new Error("提供者所有权变化，无法安全回退预算。");
        }
      }
      adapter.active = false;
      if (getterTouched) {
        if (previousDescriptor) Object.defineProperty(settings, RESERVE_METHOD, previousDescriptor);
        else Reflect.deleteProperty(settings, RESERVE_METHOD);
      }
      if (previous.adapter) previous.adapter.active = true;
      for (const provider of attempted) {
        const old = previous.registrations.get(provider);
        if (old) this.pi.registerProvider(old.wrapped);
        else if (registry.getRegisteredNativeProvider(provider) === nextRegistrations.get(provider)!.wrapped) this.pi.unregisterProvider(provider);
      }
      for (const [key, reserve] of previousReserves) {
        const model = registry.find(...splitKey(key));
        const oldWindow = previous.applied[key]?.contextWindow ?? nextOriginals.get(key)!.model.contextWindow;
        if (!model || model.contextWindow !== oldWindow || settings.getCompactionSettings(model).reserveTokens !== reserve) {
          throw new Error("运行预算回退读回不一致，请停止并重载。");
        }
      }
      this.registrations = previous.registrations;
      this.originals = previous.originals;
      this.applied = previous.applied;
      this.owner = previous.owner;
      this.adapter = previous.adapter;
    };
    try {
      for (const [provider, entry] of nextRegistrations) {
        attempted.add(provider);
        this.pi.registerProvider(entry.wrapped);
      }
      Object.defineProperty(settings, RESERVE_METHOD, { value: adapter.wrapped, configurable: true, writable: true, enumerable: false });
      getterTouched = true;
      for (const [key, rule] of Object.entries(nextRules)) {
        const model = registry.find(...splitKey(key));
        const current = lease.session.model;
        if (!model || model.contextWindow !== rule.contextWindow
          || settings.getCompactionSettings(model).reserveTokens !== rule.contextWindow - rule.compactAtTokens
          || (current && keyOf(current) === key && current.contextWindow !== rule.contextWindow)) {
          throw new Error("实际窗口/预留量回读不一致，可能有 models.json 覆盖；未保存。");
        }
      }
    } catch (error) {
      try { undo(); }
      catch { throw new Error("预算应用失败且回退未确认；停止使用新预算，请通过 SSH 检查并重载。", { cause: error }); }
      throw error;
    }
    if (previous.adapter) previous.adapter.active = false;
    this.registrations = nextRegistrations;
    this.originals = nextOriginals;
    this.applied = nextRules;
    this.owner = lease;
    this.adapter = adapter;
    return undo;
  }

  dispose(): void {
    this.epoch++;
    const owner = this.owner;
    const adapter = this.adapter;
    if (!owner) return;
    // Deactivate even when another extension has wrapped ours: retained references delegate to native.
    if (adapter) adapter.active = false;
    let failure: unknown;
    if (adapter && Object.getOwnPropertyDescriptor(adapter.manager, RESERVE_METHOD)?.value === adapter.wrapped) {
      if (!Reflect.deleteProperty(adapter.manager, RESERVE_METHOD)) failure = new Error("无法移除预算实例适配，请重载。");
    }
    for (const [provider, entry] of this.registrations) {
      try {
        if (owner.ctx.modelRegistry.getRegisteredNativeProvider(provider) === entry.wrapped) this.pi.unregisterProvider(provider);
      } catch (error) { failure ??= error; }
    }
    this.registrations.clear(); this.originals.clear(); this.applied = {}; this.owner = undefined; this.adapter = undefined;
    if (failure) throw failure;
  }
}
