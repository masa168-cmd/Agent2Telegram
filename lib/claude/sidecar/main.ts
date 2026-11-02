// Sidecar of the Claude Code mod: started by the mod at session start, one per
// session, ends with the session. Talks to Telegram; hands prompts to the mod
// as JSON lines on stdout; takes turn events from the mod over a Unix socket.
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBotRegistry, setTelegramDataDir, updateBot } from "../../core/config.ts";
import { ensureTelegramPairingCode, formatPairingInstructions } from "../../core/pairing.ts";
import { createTelegramTransport, getTelegramUpdates, telegramApi } from "../../core/telegram-api.ts";
import { telegramTokenHash } from "../../core/instance-coordinator.ts";
import type { BotRecord, TelegramConfig } from "../../core/types.ts";
import { ClaudeTelegramBridge, type BridgeEvent } from "./bridge.ts";
import { claudeTelegramDir, runtimeDir } from "./paths.ts";
import { shellQuote, type RestartJob } from "./restart-helper.ts";

function emit(event: BridgeEvent): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** One sidecar per bot on this machine (prototype; multi-session comes with the coordinator). */
function acquireLock(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    const holder = Number(readFileSync(path, "utf8").trim());
    if (Number.isSafeInteger(holder) && holder > 0 && holder !== process.pid && isPidAlive(holder)) return false;
    rmSync(path, { force: true });
    return acquireLock(path);
  }
}

function toConfig(bot: BotRecord): TelegramConfig {
  return {
    botToken: bot.token,
    ...(bot.forumChatId === undefined ? {} : { forumChatId: bot.forumChatId }),
    ...(bot.botUsername === undefined ? {} : { botUsername: bot.botUsername }),
    ...(bot.allowedUserId === undefined ? {} : { allowedUserId: bot.allowedUserId }),
    ...(bot.pairingCode === undefined ? {} : { pairingCode: bot.pairingCode }),
    ...(bot.pairingCodeExpiresAt === undefined ? {} : { pairingCodeExpiresAt: bot.pairingCodeExpiresAt }),
    ...(bot.apiBase === undefined ? {} : { apiBase: bot.apiBase }),
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function main(): Promise<void> {
  const cwd = arg("cwd") ?? process.cwd();
  const socketPath = arg("socket");
  if (!socketPath) { emit({ type: "log", text: "sidecar: --socket missing" }); return; }
  // Unix socket paths are cut at ~107 bytes; a longer one would bind somewhere else.
  if (Buffer.byteLength(socketPath) > 100) {
    emit({ type: "log", text: `Telegram 未接入：socket 路径过长（${socketPath}），请把 CLAUDE_TELEGRAM_DIR 设到更短的目录。` });
    return;
  }

  const dataDir = claudeTelegramDir();
  setTelegramDataDir(dataDir);
  mkdirSync(runtimeDir(dataDir), { recursive: true, mode: 0o700 });

  const registry = await readBotRegistry();
  const bot = registry.bots.find(b => b.id === registry.defaultBotId) ?? registry.bots[0];
  if (!bot) {
    emit({ type: "log", text: `Telegram 未配置：在 SSH 中运行 node ${join("dist", "lib", "claude", "sidecar", "setup.js")}` });
    return;
  }
  if (bot.forumChatId === undefined) {
    emit({ type: "log", text: "Telegram Bot 未设置论坛群 ID（forumChatId），请重新运行配置命令。" });
    return;
  }

  const lockPath = join(runtimeDir(dataDir), `${telegramTokenHash(bot.token)}.lock`);
  if (!acquireLock(lockPath)) {
    emit({ type: "log", text: "Telegram：另一个 Claude Code 会话正在使用这个 Bot，本会话不接入。" });
    return;
  }

  let config = toConfig(bot);
  const cursorPath = join(runtimeDir(dataDir), `${telegramTokenHash(bot.token)}.cursor.json`);
  try {
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { updateId?: number };
    if (Number.isSafeInteger(cursor.updateId)) config.lastUpdateId = cursor.updateId;
  } catch { /* first run */ }

  const savePairing = async (next: TelegramConfig) => {
    config = { ...config, ...next };
    if (next.pairingCode === undefined) { delete config.pairingCode; delete config.pairingCodeExpiresAt; }
    await updateBot(bot.id, {
      allowedUserId: config.allowedUserId,
      pairingCode: config.pairingCode,
      pairingCodeExpiresAt: config.pairingCodeExpiresAt,
    });
  };

  if (config.allowedUserId === undefined) {
    const withCode = ensureTelegramPairingCode(config);
    if (withCode.pairingCode !== config.pairingCode) await savePairing(withCode);
    emit({ type: "log", text: formatPairingInstructions(config) });
  }

  const abort = new AbortController();
  const transport = createTelegramTransport(() => config, { getAbortSignal: () => abort.signal });
  const bridge = new ClaudeTelegramBridge({
    cwd, dataDir, emit, savePairing, transport,
    getConfig: () => config,
    canRestart: () => !!process.env.TMUX_PANE,
    api: (method, body) => telegramApi(config.botToken!, method, body, abort.signal, config.apiBase),
  });
  await bridge.ensureTopic().catch(error => emit({ type: "log", text: `Telegram 话题创建失败：${String(error)}` }));
  await bridge.registerCommands().catch(error => emit({ type: "log", text: `Telegram 命令菜单注册失败：${String(error)}` }));

  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req) as Record<string, unknown>;
        let reply: unknown = {};
        if (req.url === "/turn-start") bridge.turnStarted();
        else if (req.url === "/turn-complete") await bridge.turnCompleted(str(body.answer), body.isAborted === true);
        else if (req.url === "/notice") await bridge.notice(str(body.text));
        else if (req.url === "/prompt") {
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
          reply = { shown: await bridge.openPrompt(str(body.id), str(body.title), str(body.body), labels, str(body.textLabel) || undefined) };
        } else if (req.url === "/wait") reply = await bridge.wait(str(body.id), 20_000);
        else if (req.url === "/resolve") await bridge.resolveElsewhere(str(body.id));
        else if (req.url === "/restart-prepare") reply = { ok: await prepareRestart(str(body.sessionId), str(body.modDir)) };
        else if (req.url !== "/health") { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      } catch (error) {
        emit({ type: "log", text: `Telegram 发送失败：${String(error)}` });
        res.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socketPath, done); });
  chmodSync(socketPath, 0o600);

  // /restart: a detached helper outlives this Claude Code, waits for it to exit
  // and types the resume command into the same tmux pane.
  async function prepareRestart(sessionId: string, modDir: string): Promise<boolean> {
    const pane = process.env.TMUX_PANE;
    if (!pane || !sessionId || !modDir) {
      await bridge.notice("无法重启：不在 tmux 中，或缺少会话信息。Claude Code 没有退出。");
      return false;
    }
    let argv: string[] | undefined;
    try {
      argv = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch { /* not Linux: start with the default command line */ }
    const job: RestartJob = { pid: process.ppid, pane, cwd, modDir, sessionId, ...(argv?.length ? { argv } : {}),
      logPath: join(runtimeDir(dataDir), "restart.jsonl") };
    const helper = join(dirname(fileURLToPath(import.meta.url)), "restart-helper.js");
    // Claude Code ends every process it started when it exits, detached or not,
    // so the tmux server starts the helper. Its own errors go beside restart.jsonl.
    const errPath = join(runtimeDir(dataDir), "restart-helper.err");
    const command = `${shellQuote(process.execPath)} ${shellQuote(helper)} ${shellQuote(JSON.stringify(job))} >> ${shellQuote(errPath)} 2>&1`;
    try {
      execFileSync("tmux", ["run-shell", "-b", command], { timeout: 5_000 });
    } catch (error) {
      await bridge.notice(`无法重启：tmux 启动辅助程序失败（${String(error).slice(0, 200)}）。Claude Code 没有退出。`);
      return false;
    }
    await bridge.notice("正在重启 Claude Code…");
    return true;
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    bridge.stopTyping();
    server.close();
    rmSync(socketPath, { force: true });
    rmSync(lockPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  // Claude Code kills the child when the session ends; if Claude Code itself
  // dies first, the child is re-parented, so exit then too.
  const parentPid = process.ppid;
  setInterval(() => { if (process.ppid !== parentPid) shutdown(); }, 5_000).unref();

  emit({ type: "log", text: "Telegram 已接入。" });
  if (process.env.CTG_RESTARTED === "1") await bridge.notice("Claude Code 已重启，对话已接上。").catch(() => undefined);
  while (!stopping) {
    try {
      const updates = await getTelegramUpdates(config, abort.signal);
      for (const update of updates) {
        await bridge.handleUpdate(update).catch(error => emit({ type: "log", text: `Telegram 消息处理失败：${String(error)}` }));
        config.lastUpdateId = update.update_id;
        writeFileSync(cursorPath, JSON.stringify({ updateId: update.update_id }) + "\n", { mode: 0o600 });
      }
    } catch (error) {
      if (stopping) break;
      const text = error instanceof Error ? error.message : String(error);
      if (/Conflict|terminated by other|409/i.test(text)) {
        emit({ type: "log", text: `Telegram：这个 Bot 正被其他程序使用，已停止接收消息。（${text}）` });
        shutdown();
        return;
      }
      await new Promise(done => setTimeout(done, 3_000));
    }
  }
}

main().catch(error => {
  emit({ type: "log", text: `sidecar 异常退出：${error instanceof Error ? error.message : String(error)}` });
  process.exit(1);
});
