import { getCurrentTelegramTurn } from "../../core/turn-context.ts";
import { queuePendingNotice } from "../../core/pending-notices.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CommandRegistry } from "./register.ts";
import { checkpointCurrentUpdateCursor } from "../../core/polling.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../core/config.ts";
import { canRequestHostShutdown, requestHostShutdown } from "../session-capture.ts";

export type RestartJob = { pid: number; pane: string; cwd: string; sessionFile: string; logPath: string };

/** Why /restart cannot run here, or the job for the detached helper. */
export function planRestart(ctx: Pick<ExtensionCommandContext, "cwd" | "isIdle" | "hasPendingMessages" | "sessionManager">,
  env: NodeJS.ProcessEnv = process.env, canExit: () => boolean = canRequestHostShutdown): { error: string } | { job: RestartJob } {
  const pane = env.TMUX_PANE;
  if (!env.TMUX || !pane || !/^%\d+$/.test(pane)) return { error: "此 Pi 不在 tmux 窗格里运行，无法自动重启。请在 SSH 中手动重启。" };
  if (!canExit()) return { error: "未拿到 Pi 的退出接口（需 Pi 1.4.0 且进程启动时已加载本插件），无法自动重启。请在 SSH 中手动重启。" };
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return { error: "当前会话没有保存文件（--no-session），重启后无法恢复。" };
  // Pi 1.4.0 writes a new session file only after the first real message.
  if (!existsSync(sessionFile)) return { error: "当前会话还没有消息，尚未写入磁盘，重启后无法恢复。先发一条消息再 /restart。" };
  if (!ctx.isIdle() || ctx.hasPendingMessages()) return { error: "Pi 正在执行任务或有排队消息。请先 /stop 或等待完成后再 /restart。" };
  return { job: { pid: process.pid, pane, cwd: ctx.cwd, sessionFile,
    logPath: join(getAgentDir(), "tg-runtime", "restart.jsonl") } };
}

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerLifecycleCommands(registry: CommandRegistry): void {

  // ── /reload ────────────────────────────────────────────────────────────
  registry.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify("Reloading…", "info");
      // ctx.reload() re-activates the plugin in-process, so this runtime is no
      // longer the active one by the time the reload lands: its transport drops
      // anything queued after the lease changes. Queue the completion notice for
      // the replacement runtime instead. Only Telegram-originated reloads have a
      // turn scope; a terminal /reload has nothing to notify.
      const turn = getCurrentTelegramTurn();
      if (turn) {
        queuePendingNotice({
          chatId: turn.chatId,
          messageThreadId: turn.messageThreadId,
          replyTo: turn.sourceMessageId,
          html: "✅ Reloaded.",
          createdAt: Date.now(),
        });
      }
      // /reload re-activates the plugin in-process; commit this update first so
      // the replacement runtime does not re-fetch and re-run the unconfirmed
      // /reload (which would call ctx.reload() again).
      await checkpointCurrentUpdateCursor();
      await ctx.reload();
      return;
    },
  });

  // ── /stop ─────────────────────────────────────────────────────────────
  registry.registerCommand("stop", {
    description: "Stop the current agent turn",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ctx.abort();
      ui.notify("⏹ Stopped.", "info");
    },
  });

  // ── /quit, /exit ───────────────────────────────────────────────────────
  // Not offered from Telegram (the controller answers them with a notice). Quitting
  // stays a terminal action through Pi's own /quit.

  // ── /restart ─────────────────────────────────────────────────────────────────────
  // Only an online Pi in a tmux pane can restart itself: a detached helper waits for
  // this process to exit, then types `pi --session <this file>` into the same pane.
  registry.registerCommand("restart", {
    description: "重启 Pi 并恢复当前会话（需 tmux）",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;
      // No confirmation by request; the refusals in planRestart (not tmux, unsaved
      // session, busy or queued) still apply, so a running task is never cut off.
      const plan = planRestart(ctx);
      if ("error" in plan) { ui.notify(plan.error, "warning"); return; }
      try {
        mkdirSync(join(getAgentDir(), "tg-runtime"), { recursive: true, mode: 0o700 });
        const helper = fileURLToPath(new URL("../restart-helper.mjs", import.meta.url));
        const child = spawn(process.execPath, [helper, JSON.stringify(plan.job)], { detached: true, stdio: "ignore" });
        child.unref();
      } catch {
        ui.notify("重启助手启动失败，Pi 未退出。", "error");
        return;
      }
      ui.notify("正在重启 Pi…", "info");
      // Commit this update so the restarted Pi does not fetch and run /restart again.
      await checkpointCurrentUpdateCursor();
      // ctx.shutdown() only notifies (session-capture replaces it); use the mode's real exit.
      if (!requestHostShutdown()) ui.notify("未能调用 Pi 的退出接口，Pi 未退出；重启助手会在 30 秒后放弃。", "error");
    },
  });

}