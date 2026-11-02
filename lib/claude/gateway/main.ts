// The Claude Code Telegram gateway: one long-lived process (a systemd --user
// service) that alone polls the Bot and serves every Claude Code session on
// this machine over a Unix socket. Sessions connect from the mod; see gateway.ts.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readBotRegistry, setTelegramDataDir, updateBot } from "../../core/config.ts";
import { ensureTelegramPairingCode } from "../../core/pairing.ts";
import { createTelegramTransport, getTelegramUpdates, telegramApi } from "../../core/telegram-api.ts";
import { telegramTokenHash } from "../../core/instance-coordinator.ts";
import type { BotRecord, TelegramConfig } from "../../core/types.ts";
import { ClaudeGateway } from "./gateway.ts";
import { claimBot } from "./ownership.ts";
import { isClaudeProjectEnabled } from "./projects.ts";
import { claudeTelegramDir, runtimeDir } from "./paths.ts";

const POLL_HOLD_MS = 20_000;
// A brief conflict is normal while an old poller hands over; a lasting one is another program.
const CONFLICT_FIRST_RETRY_MS = 5_000;
const CONFLICT_RETRY_MS = 60_000;

function log(text: string): void {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
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

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const parsed = raw ? JSON.parse(raw) as unknown : {};
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);

async function main(): Promise<void> {
  const dataDir = claudeTelegramDir();
  setTelegramDataDir(dataDir);
  mkdirSync(runtimeDir(dataDir), { recursive: true, mode: 0o700 });
  const socketPath = join(dataDir, "gateway.sock");

  // Not ready (no Bot, no forum group, Bot owned elsewhere): keep serving the
  // socket so sessions can say why, and wait for `systemctl --user restart`.
  let disabled: string | undefined;
  const registry = await readBotRegistry();
  const bot = registry.bots.find(b => b.id === registry.defaultBotId) ?? registry.bots[0];
  if (!bot) disabled = `Telegram 未配置：写好 ${join(dataDir, "tg.json")} 后运行 systemctl --user restart claude-telegram-gateway`;
  else if (bot.forumChatId === undefined) disabled = "Telegram Bot 未设置论坛群 ID（forumChatId）。改好后重启网关。";
  else {
    const claim = claimBot(bot.token, "claude");
    if (!claim.ok) disabled = claim.reason;
  }

  let config: TelegramConfig = bot ? toConfig(bot) : {};
  const cursorPath = bot ? join(runtimeDir(dataDir), `${telegramTokenHash(bot.token)}.cursor.json`) : "";
  if (bot) {
    try {
      const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { updateId?: number };
      if (Number.isSafeInteger(cursor.updateId)) config.lastUpdateId = cursor.updateId;
    } catch { /* first run */ }
  }

  const savePairing = async (next: TelegramConfig) => {
    config = { ...config, ...next };
    if (next.pairingCode === undefined) { delete config.pairingCode; delete config.pairingCodeExpiresAt; }
    await updateBot(bot!.id, {
      allowedUserId: config.allowedUserId,
      pairingCode: config.pairingCode,
      pairingCodeExpiresAt: config.pairingCodeExpiresAt,
    });
  };
  if (bot && !disabled && config.allowedUserId === undefined) {
    const withCode = ensureTelegramPairingCode(config);
    if (withCode.pairingCode !== config.pairingCode) await savePairing(withCode);
  }

  const abort = new AbortController();
  const helper = join(dirname(fileURLToPath(import.meta.url)), "restart-helper.js");
  const gateway = new ClaudeGateway({
    dataDir, savePairing,
    getConfig: () => config,
    api: (method, body) => telegramApi(config.botToken!, method, body, abort.signal, config.apiBase),
    transport: createTelegramTransport(() => config, { getAbortSignal: () => abort.signal }),
    // The gateway is not in Claude Code's process tree, so the helper outlives it.
    startRestart: job => {
      spawn(process.execPath, [helper, JSON.stringify({ ...job, logPath: join(runtimeDir(dataDir), "restart.jsonl") })],
        { detached: true, stdio: "ignore" }).unref();
    },
    isEnabled: cwd => isClaudeProjectEnabled(dataDir, cwd),
    readArgv: pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { return undefined; }
    },
  });

  rmSync(socketPath, { force: true });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const connId = str(body.connId);
        let reply: unknown = {};
        if (req.url === "/health") reply = { ok: !disabled, sessions: gateway.sessionCount, ...(disabled ? { reason: disabled } : {}) };
        else if (disabled) reply = { ok: false, reason: disabled };
        else if (req.url === "/open") {
          reply = await gateway.open({ connId, cwd: str(body.cwd), claudeSessionId: str(body.claudeSessionId) || undefined,
            pid: num(body.pid), pane: str(body.pane) || undefined, modDir: str(body.modDir) || undefined });
        } else if (req.url === "/poll") reply = await gateway.poll(connId, POLL_HOLD_MS);
        else if (req.url === "/close") gateway.close(connId);
        else if (req.url === "/turn-start") gateway.turnStarted(connId);
        else if (req.url === "/turn-complete") await gateway.turnCompleted(connId, str(body.answer), body.isAborted === true);
        else if (req.url === "/notice") await gateway.notice(connId, str(body.text));
        else if (req.url === "/prompt") {
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === "string") : [];
          reply = { shown: await gateway.openPrompt(connId, str(body.id), str(body.title), str(body.body), labels,
            str(body.textLabel) || undefined) };
        } else if (req.url === "/wait") reply = await gateway.wait(str(body.id), POLL_HOLD_MS);
        else if (req.url === "/resolve") await gateway.resolveElsewhere(str(body.id));
        else if (req.url === "/restart-prepare") reply = { ok: await gateway.prepareRestart(connId, str(body.sessionId)) };
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
      } catch (error) {
        log(`request ${req.url} failed: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });
  server.requestTimeout = 0;
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socketPath, done); });
  chmodSync(socketPath, 0o600);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    server.close();
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  setInterval(() => gateway.reap(), 10_000).unref();

  if (disabled) {
    log(`disabled: ${disabled}`);
    return;
  }
  await gateway.registerCommands().catch(error => log(`setMyCommands failed: ${String(error)}`));
  log(`polling for ${bot!.name}`);
  let conflicts = 0;
  while (!stopping) {
    try {
      const updates = await getTelegramUpdates(config, abort.signal);
      conflicts = 0;
      for (const update of updates) {
        await gateway.handleUpdate(update).catch(error => log(`update ${update.update_id} failed: ${String(error)}`));
        config.lastUpdateId = update.update_id;
        writeFileSync(cursorPath, JSON.stringify({ updateId: update.update_id }) + "\n", { mode: 0o600 });
      }
    } catch (error) {
      if (stopping) break;
      const text = error instanceof Error ? error.message : String(error);
      // The gateway is this Bot's only poller here, so a conflict is another program.
      if (/Conflict|terminated by other|409/i.test(text)) {
        conflicts += 1;
        log(`conflict ${conflicts}: ${text}`);
        if (conflicts === 2) {
          gateway.broadcastLog(`Telegram：这个 Bot 正被其他程序使用，网关暂停接收，每分钟重试一次。（${text}）`);
        }
        await new Promise(done => setTimeout(done, conflicts === 1 ? CONFLICT_FIRST_RETRY_MS : CONFLICT_RETRY_MS));
      } else {
        await new Promise(done => setTimeout(done, 3_000));
      }
    }
  }
}

main().catch(error => {
  log(`gateway failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
