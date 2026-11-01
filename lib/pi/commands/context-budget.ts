import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBudget, saveBudget, validateBudget } from "../context-budget/config.ts";
import { ContextBudgetRuntime } from "../context-budget/runtime.ts";
import { selectBudgetItem } from "../context-budget/picker.ts";

const EDIT = "修改窗口 / 压缩阈值";
const RESET = "恢复默认（重载后生效）";
const CLOSE = "关闭";
const MANAGE = "管理未列出的已保存规则";
function integer(text: string): number {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error("请输入完整十进制安全整数，不支持 k/M、小数、指数或负数。");
  }
  return Number(trimmed);
}

export function registerContextBudgetCommand(pi: Pick<ExtensionAPI, "registerCommand">, runtime: ContextBudgetRuntime): void {
  let editing = false;
  pi.registerCommand("context-budget", {
    description: "查看/设置当前目录的模型窗口和压缩阈值（本地与 Telegram 共用）",
    handler: async (args, ctx) => {
      const ui = ctx.ui; // Never reuse a replacement session's UI.
      if (editing) { ui.notify("已有预算菜单正在操作，请先完成或取消。", "warning"); return; }
      if (args.trim() && args.trim() !== "status") {
        ui.notify("用法：/context-budget 打开菜单；/context-budget status 查看当前实际值。", "warning"); return;
      }
      editing = true;
      try {
        const lease = runtime.capture(ctx);
        const snapshot = readBudget(lease.cwd);
        const currentKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const status = args.trim() === "status";
        if (status && !currentKey) throw new Error("尚未选择当前模型；可打开预算菜单配置已授权/登录的聊天模型。");
        if (!ctx.hasUI) throw new Error("此命令需要交互界面；未修改配置。");
        let key = currentKey;
        let managing = false;
        if (!status) {
          const keys = [...new Set(runtime.list(lease).map(m => `${m.provider}/${m.id}`))].sort();
          const keySet = new Set(keys);
          const unlisted = Object.keys(snapshot.config.models).filter(k => !keySet.has(k)).sort();
          if (currentKey && keySet.has(currentKey)) keys.splice(0, 0, ...keys.splice(keys.indexOf(currentKey), 1));
          if (!keys.length) {
            const message = "当前没有 Pi 识别的已授权/登录聊天模型。";
            if (!unlisted.length) throw new Error(message);
            ui.notify(`${message}已保存的规则保留，可单独管理。`, "warning");
          }
          key = await selectBudgetItem(ui, "上下文预算：已授权/登录模型（仅当前目录）",
            [...keys, ...(unlisted.length ? [MANAGE] : [])]);
          runtime.assertCurrent(lease);
          if (!key) return;
          if (key === MANAGE && unlisted.length) {
            managing = true;
            key = await selectBudgetItem(ui, "未列出的已保存规则（仅查看/删除）", unlisted);
            runtime.assertCurrent(lease);
            if (!key) return;
            if (!unlisted.includes(key)) throw new Error("规则选择已失效，请重新打开菜单。");
          } else if (!keySet.has(key)) throw new Error("模型选择已失效，请重新打开菜单。");
        }
        runtime.assertCurrent(lease);
        if (!key) return;
        const requireAvailable = () => {
          if (!runtime.list(lease).some(m => `${m.provider}/${m.id}` === key)) {
            throw new Error("该模型已不在 Pi 当前已授权/登录的可用列表中；未保存，请重新打开菜单。");
          }
        };
        if (!status && !managing) requireAvailable();
        const configured = snapshot.config.models[key];
        // Status is a runtime read, independent of authentication filtering. Unlisted rules are removal-only.
        const details = managing ? undefined : runtime.describe(lease, key);
        const report = [key,
          details ? `加载前有效值：window=${details.baseWindow}, reserve=${details.baseReserve}, trigger>${details.baseWindow - details.baseReserve}` : "未列入 Pi 当前认证可用列表；仅查看或删除已保存规则，不允许编辑。",
          configured ? `已保存：window=${configured.contextWindow}, trigger>${configured.compactAtTokens}` : "已保存：无覆盖规则",
          details ? `实际：window=${details.window}, reserve=${details.reserve}, trigger>${details.trigger}, auto=${details.enabled ? "on" : "off"}` : "实际：未查询（规则管理不改变运行值）",
          details?.applied && !configured ? "已删除规则但当前预算仍在运行；需原生 /reload 或正常重启恢复。" : "",
          "作用域：当前目录；其他在线实例不会被即时改值。",
        ].filter(Boolean).join("\n");
        if (status) { ui.notify(report, "info"); return; }
        const action = await ui.select(report, [...(!managing ? [EDIT] : []), ...(configured ? [RESET] : []), CLOSE]);
        runtime.assertCurrent(lease);
        if (!action || action === CLOSE) return;
        runtime.assertCurrent(lease, true);
        if (action === RESET) {
          const yes = await ui.confirm("删除此模型的预算规则？", `${key}\n仅保存删除规则；当前运行值保留到原生 /reload 或正常重启。\n恢复的是宿主已有设置，不删除原生 settings，也不会自动重载。`);
          runtime.assertCurrent(lease, true);
          if (!yes) return;
          const models = { ...snapshot.config.models };
          delete models[key];
          const saved = saveBudget(lease.cwd, snapshot.revision, { version: 1, models }, () => {
            runtime.assertCurrent(lease, true);
            return () => {};
          });
          ui.notify("已保存：此模型不再有预算规则。当前运行值尚未重置；需原生 /reload 或正常重启后查询实际值。", "warning");
          if (saved.cleanupWarning) ui.notify(saved.cleanupWarning, "warning");
          return;
        }
        if (action !== EDIT || !details) return;
        requireAvailable();
        const windowInput = await ui.input("上下文窗口 tokens（本地声明，不增加服务端容量）", String(configured?.contextWindow ?? details.window));
        runtime.assertCurrent(lease, true);
        if (windowInput === undefined) return;
        requireAvailable();
        const triggerInput = await ui.input("自动压缩触发阈值 tokens（超过此值触发）", String(configured?.compactAtTokens ?? details.trigger));
        runtime.assertCurrent(lease, true);
        if (triggerInput === undefined) return;
        requireAvailable();
        const budget = validateBudget({ contextWindow: integer(windowInput), compactAtTokens: integer(triggerInput) });
        if (budget.contextWindow <= details.model.maxTokens) throw new Error("窗口必须大于该模型输出上限；未修改配置。");
        const usage = ctx.getContextUsage()?.tokens;
        const yes = await ui.confirm("确认保存并应用上下文预算？", [key,
          `window：${details.window} → ${budget.contextWindow}`,
          `trigger>：${details.trigger} → ${budget.compactAtTokens}`,
          `reserve：${details.reserve} → ${budget.contextWindow - budget.compactAtTokens}`,
          `auto=${details.enabled ? "on" : "off"}（不修改自动压缩开关）`,
          currentKey === key && usage != null && usage > budget.compactAtTokens
            ? `警告：当前估算 ${usage} 已超过新阈值，后续原生检查可能立即压缩。` : "",
          "本地窗口声明不等于服务端/订阅容量；增大上下文可能增加用量和延迟。",
          "仅应用到本在线会话；同目录其他实例需各自重载。本命令不发模型请求、不主动压缩。",
        ].filter(Boolean).join("\n"));
        runtime.assertCurrent(lease, true);
        if (!yes) return;
        requireAvailable();
        const saved = saveBudget(lease.cwd, snapshot.revision,
          { version: 1, models: { ...snapshot.config.models, [key]: budget } },
          () => {
            requireAvailable();
            return runtime.install({ ...snapshot.config.models, [key]: budget }, lease);
          });
        const actual = runtime.describe(lease, key);
        ui.notify(`已保存并回读：${key}\nwindow=${actual.window}, reserve=${actual.reserve}, trigger>${actual.trigger}, auto=${actual.enabled ? "on" : "off"}\n未发起压缩或模型请求。`, "info");
        if (saved.cleanupWarning) ui.notify(saved.cleanupWarning, "warning");
      } catch (error) {
        ui.notify(`上下文预算：${error instanceof Error ? error.message : "操作失败，未确认生效。"}`, "error");
      } finally { editing = false; }
    },
  });
}
