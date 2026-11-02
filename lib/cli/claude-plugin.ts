// The Claude Code plugin is installed from the app folder itself (a local
// marketplace), so an upgrade of the app is picked up by /reload-plugins.
import type { Run } from "./service.ts";
import { run } from "./service.ts";

export const MARKETPLACE = "agent2telegram";
export const PLUGIN = "agent2telegram";

function has(exec: Run, args: string[], needle: string): boolean {
  try { return exec("claude", args).includes(needle); } catch { return false; }
}

export function claudeAvailable(exec: Run = run): boolean {
  try { exec("claude", ["--version"]); return true; } catch { return false; }
}

export function installClaudePlugin(appDir: string, exec: Run = run): string[] {
  const done: string[] = [];
  if (!has(exec, ["plugin", "marketplace", "list"], MARKETPLACE)) {
    exec("claude", ["plugin", "marketplace", "add", appDir]);
    done.push(`已登记本地插件市场 ${appDir}`);
  }
  if (!has(exec, ["plugin", "list"], PLUGIN)) {
    exec("claude", ["plugin", "install", `${PLUGIN}@${MARKETPLACE}`, "--scope", "user"]);
    done.push(`已安装 Claude Code 插件 ${PLUGIN}`);
  }
  return done;
}

export function removeClaudePlugin(exec: Run = run): string[] {
  const done: string[] = [];
  try { exec("claude", ["plugin", "uninstall", `${PLUGIN}@${MARKETPLACE}`]); done.push(`已卸载插件 ${PLUGIN}`); } catch { /* not installed */ }
  try { exec("claude", ["plugin", "marketplace", "remove", MARKETPLACE]); done.push(`已移除插件市场 ${MARKETPLACE}`); } catch { /* not added */ }
  return done;
}
