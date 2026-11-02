#!/usr/bin/env node
// a2t — the agent2telegram command line. Everything lives in ~/.agent2telegram.
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { a2tHome, agentDataDir } from "../core/a2t-home.ts";
import { disableClaudeProject, enableClaudeProject, readClaudeProjects } from "../gateway/claude-projects.ts";
import { claudeAvailable, installClaudePlugin, removeClaudePlugin } from "./claude-plugin.ts";
import { disablePi, enablePi, isPiEnabled } from "./pi-entry.ts";
import { GATEWAY_SERVICE, LEGACY_GATEWAY_SERVICES, gatewayStatus, gatewayUnit, installGatewayService, lingerEnabled,
  removeGatewayService, run } from "./service.ts";
import { runSetup } from "./setup.ts";
import { postUnix } from "../pi/gateway-client.ts";

/** The app root: the nearest folder above this file whose package.json is agent2telegram. */
export function appDir(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  while (true) {
    try {
      if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name === "agent2telegram") return dir;
    } catch { /* keep looking */ }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("找不到 agent2telegram 程序目录（package.json）。");
    dir = parent;
  }
}

const USAGE = `用法：a2t <命令>
  status                      查看安装、网关和已开启的目录
  setup <pi|claude>           配置 Bot（Token 只在这里输入）
  enable <pi|claude> [目录]   在目录（默认当前目录）开启 Telegram
  disable <pi|claude> [目录]  关闭
  gateway <restart|status|logs>  网关服务（Pi 与 Claude Code 共用）
  migrate [--apply]           把旧位置的数据迁到 ~/.agent2telegram（默认只列清单）
  uninstall [--purge]         卸载入口、插件和服务；--purge 连数据一起删除
  upgrade                     从 GitHub 重新安装最新版本`;

function agentArg(value: string | undefined): "pi" | "claude" {
  if (value === "pi" || value === "claude") return value;
  throw new Error(`请指定 pi 或 claude。\n\n${USAGE}`);
}

function version(): string {
  try { return (JSON.parse(readFileSync(join(appDir(), "package.json"), "utf8")) as { version?: string }).version ?? "?"; } catch { return "?"; }
}

/** What the gateway says about one agent: online sessions, or why it is not ready. */
async function agentHealth(agent: "pi" | "claude"): Promise<string> {
  const reply = await postUnix(join(agentDataDir(agent), "gateway.sock"), "/health", {}, 2_000);
  if (!reply) return "网关未连接";
  return reply.ok ? `在线会话 ${(reply as { sessions?: number }).sessions ?? 0}` : `未就绪：${reply.reason ?? "?"}`;
}

async function status(): Promise<void> {
  const home = a2tHome();
  console.log(`agent2telegram ${version()}  程序：${appDir()}  数据：${home}`);
  console.log(`网关 ${GATEWAY_SERVICE}：${gatewayStatus()}；linger ${lingerEnabled(userInfo().username) ? "已开启" : "未开启"}`);
  const piBots = existsSync(join(agentDataDir("pi"), "tg.json")) ? "已配置" : "未配置";
  const claudeBots = existsSync(join(agentDataDir("claude"), "tg.json")) ? "已配置" : "未配置";
  console.log(`Pi：Bot ${piBots}；${await agentHealth("pi")}；当前目录 ${isPiEnabled(process.cwd()) ? "已开启" : "未开启"}`);
  console.log(`Claude Code：Bot ${claudeBots}；${await agentHealth("claude")}`);
  const dirs = readClaudeProjects(agentDataDir("claude")).dirs;
  console.log(`Claude 已开启目录：${dirs.length ? `\n  ${dirs.join("\n  ")}` : "无"}`);
}

/** Called by install.sh after the app is in place: entries for the chosen agents. */
function postInstall(agents: string[]): void {
  const app = appDir();
  if (agents.includes("claude")) {
    if (!claudeAvailable()) console.log("未找到 claude 命令，跳过 Claude Code 插件。装好 Claude Code 后重新运行安装。");
    else for (const line of installClaudePlugin(app)) console.log(line);
  }
  // Pi and Claude Code both reach Telegram through the gateway.
  if (agents.length > 0) {
    if (process.env.A2T_SKIP_SYSTEMD === "1") console.log("已跳过 systemd 服务（A2T_SKIP_SYSTEMD=1）。");
    else {
      for (const name of LEGACY_GATEWAY_SERVICES) if (removeGatewayService(name)) console.log(`已移除旧服务 ${name}`);
      for (const line of installGatewayService(gatewayUnit({ node: process.execPath, appDir: app, a2tHome: a2tHome() }))) console.log(line);
      if (!lingerEnabled(userInfo().username)) {
        console.log(`提示：linger 未开启，SSH 全部断开后网关会停止。需要常驻请运行：loginctl enable-linger ${userInfo().username}`);
      }
    }
  }
  console.log("安装完成。下一步：a2t setup pi / a2t setup claude，然后在项目目录 a2t enable pi / a2t enable claude。");
}

function uninstall(purge: boolean): void {
  for (const line of removeClaudePlugin()) console.log(line);
  // systemd --user is per user, not per HOME: a sandbox must say so explicitly.
  if (process.env.A2T_SKIP_SYSTEMD === "1") console.log("已跳过 systemd 服务（A2T_SKIP_SYSTEMD=1）。");
  else for (const name of [GATEWAY_SERVICE, ...LEGACY_GATEWAY_SERVICES]) if (removeGatewayService(name)) console.log(`已移除服务 ${name}`);
  console.log("各目录的 Pi 入口请用 a2t disable pi <目录> 移除（a2t 不扫描你的磁盘）。");
  console.log(purge ? `请手动删除 ${a2tHome()}（含配置与数据），a2t 不会自动删除。` : `配置与数据保留在 ${a2tHome()}。`);
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "status": await status(); return 0;
    case "setup": return runSetup(agentArg(rest[0]), agentDataDir(agentArg(rest[0])));
    case "enable": {
      const agent = agentArg(rest[0]);
      const dir = resolve(rest[1] ?? process.cwd());
      if (agent === "pi") {
        const done = enablePi(dir, appDir());
        console.log(done.result === "unchanged" ? `Pi 已在 ${dir} 开启。` : `已在 ${dir} 开启 Pi（${done.path}）。新启动的 pi 会加载它；关闭前就在运行的 pi 约 30 秒内自动接回。`);
        for (const legacy of done.removedLegacy) console.log(`已移除旧入口 ${legacy}`);
      } else {
        console.log(enableClaudeProject(agentDataDir("claude"), dir)
          ? `已在 ${dir} 开启 Claude Code；该目录的会话约 30 秒内自动接入。` : `Claude Code 已在 ${dir} 开启。`);
      }
      return 0;
    }
    case "disable": {
      const agent = agentArg(rest[0]);
      const dir = resolve(rest[1] ?? process.cwd());
      const changed = agent === "pi" ? disablePi(dir) : disableClaudeProject(agentDataDir("claude"), dir);
      console.log(changed ? `已在 ${dir} 关闭 ${agent}；正在运行的会话约 10 秒内断开。` : `${agent} 本来就没有在 ${dir} 开启。`);
      return 0;
    }
    case "gateway": {
      const action = rest[0] ?? "status";
      if (action === "status") { console.log(gatewayStatus()); return 0; }
      if (action === "restart") { run("systemctl", ["--user", "restart", `${GATEWAY_SERVICE}.service`]); console.log("网关已重启。"); return 0; }
      if (action === "logs") { console.log(run("journalctl", ["--user", "-u", `${GATEWAY_SERVICE}.service`, "-n", "50", "--no-pager", "-o", "cat"])); return 0; }
      throw new Error("用法：a2t gateway <restart|status|logs>");
    }
    case "post-install": postInstall(rest); return 0;
    case "migrate": {
      const { runMigrate } = await import("./migrate.ts");
      return runMigrate({ apply: rest.includes("--apply"), appDir: appDir() });
    }
    case "uninstall": uninstall(rest.includes("--purge")); return 0;
    case "upgrade":
      console.log("运行：curl -fsSL https://raw.githubusercontent.com/masa168-cmd/Agent2Telegram/main/install.sh | bash");
      return 0;
    case undefined: case "help": case "--help": case "-h": console.log(USAGE); return 0;
    default: console.log(`未知命令：${command}\n\n${USAGE}`); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
