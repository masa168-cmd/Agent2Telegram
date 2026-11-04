// The agent2telegram gateway: one long-lived process (systemd --user service
// agent2telegram-gateway) that alone polls each agent's Bot and serves every
// session on this machine over a Unix socket per agent:
//   Pi          → <pi data>/gateway.sock      (rich: raw updates of its topic)
//   Claude Code → <claude data>/gateway.sock  (thin: the gateway reads the topic)
//   Codex       → no client of its own: the gateway drives Codex's app-server (codex.ts)
// See bot-gateway.ts for the session protocol.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../core/data-dir.ts";
import { createTelegramTransport, downloadTelegramFile, getTelegramFile, getTelegramUpdates, telegramApi } from "../core/telegram-api.ts";
import { telegramTokenHash } from "../core/forum-binding.ts";
import type { BotRecord, TelegramConfig } from "../core/types.ts";
import { BotGateway, type MenuCommand } from "./bot-gateway.ts";
import { CODEX_COMMANDS, CodexBridge, connectCodex } from "./codex.ts";
import { a2tCacheDir, agentDataDir } from "../core/a2t-home.ts";
import { isClaudeProjectEnabled } from "./claude-projects.ts";
import { claimBot, type AgentName } from "./ownership.ts";
import { claudeTelegramDir, runtimeDir } from "./paths.ts";
import { defaultBot, readRegistryFile } from "./registry.ts";
import { isPiEnabled } from "../cli/pi-entry.ts";

const POLL_HOLD_MS = 20_000;
// A brief conflict is normal while an old poller hands over; a lasting one is another program.
const CONFLICT_FIRST_RETRY_MS = 5_000;
const CONFLICT_RETRY_MS = 60_000;

function log(text: string): void {
  process.stdout.write(`${new Date().toISOString()} ${text}\n`);
}

/** A name without its extension, kept to ASCII letters, digits and `._-` (as Pi names uploads). */
function safeName(value: string, fallback: string): string {
  return value.trim().replace(/\.[^./\\]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_")
    .replace(/^\.+/, "").replace(/\.+$/, "").slice(0, 120) || fallback;
}

/**
 * A Telegram photo or file for Claude Code, saved where Pi keeps uploads:
 * ~/.agent2telegram/cache/uploads/<launch dir name>/. A file keeps a cleaned
 * form of its name and its extension.
 */
async function saveTelegramFile(config: TelegramConfig, cwd: string, fileId: string, fileName: string | undefined,
  signal: AbortSignal): Promise<string> {
  const token = config.botToken;
  if (!token) throw new Error("Bot 未配置");
  const info = await getTelegramFile(token, fileId, signal, config.apiBase);
  const data = await downloadTelegramFile(token, info.file_path, signal, config.apiBase);
  const dir = join(a2tCacheDir(), "uploads", safeName(basename(resolve(cwd)), "root"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ext = extname(fileName || info.file_path).toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : fileName ? "" : ".jpg";
  const base = fileName ? safeName(fileName, "file") : "photo";
  const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${safeExt}`);
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
  return path;
}

function toConfig(bot: BotRecord): TelegramConfig {
  return {
    botToken: bot.token,
    ...(bot.forumChatId === undefined ? {} : { forumChatId: bot.forumChatId }),
    ...(bot.botUsername === undefined ? {} : { botUsername: bot.botUsername }),
    ...(bot.allowedUserId === undefined ? {} : { allowedUserId: bot.allowedUserId }),
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

type AgentSpec = {
  agent: AgentName;
  label: string;
  mode: "thin" | "rich";
  dataDir: string;
  /** The directory → topic map, per Bot token. */
  topicsPath(token: string): string;
  /** The update offset, per Bot token. */
  cursorPath(token: string): string;
  isEnabled?(cwd: string): boolean;
  /** Thin clients get the gateway's own "/" menu and /restart helper. */
  thin: boolean;
  commands?: readonly MenuCommand[];
};

/** `a2t enable pi` wrote an entry in `cwd` or one of its parents. */
function isPiEnabledHere(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (isPiEnabled(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

function agentSpecs(): AgentSpec[] {
  const piDir = getAgentDir();
  const claudeDir = claudeTelegramDir();
  const codexDir = agentDataDir("codex");
  return [
    { agent: "pi", label: "Pi", mode: "rich", dataDir: piDir, thin: false,
      // Pi's existing store and cursor, so topics and the offset carry over.
      topicsPath: token => join(piDir, "tg-runtime", telegramTokenHash(token), "topics.json"),
      cursorPath: token => join(piDir, "tg-runtime", telegramTokenHash(token), "cursor.json"),
      isEnabled: cwd => isPiEnabledHere(cwd) },
    { agent: "claude", label: "Claude Code", mode: "thin", dataDir: claudeDir, thin: true,
      topicsPath: () => join(runtimeDir(claudeDir), "topics.json"),
      cursorPath: token => join(runtimeDir(claudeDir), `${telegramTokenHash(token)}.cursor.json`),
      isEnabled: cwd => isClaudeProjectEnabled(claudeDir, cwd) },
    { agent: "codex", label: "Codex", mode: "thin", dataDir: codexDir, thin: true, commands: CODEX_COMMANDS,
      topicsPath: () => join(runtimeDir(codexDir), "topics.json"),
      cursorPath: token => join(runtimeDir(codexDir), `${telegramTokenHash(token)}.cursor.json`),
      isEnabled: cwd => isClaudeProjectEnabled(codexDir, cwd) },
  ];
}

/** One agent: its Bot, its socket, its polling loop. Never throws; a broken agent only disables itself. */
async function serveAgent(spec: AgentSpec, stopping: () => boolean, onStop: Array<() => void>): Promise<void> {
  const tag = `[${spec.agent}]`;
  const socketPath = join(spec.dataDir, "gateway.sock");
  const registryPath = join(spec.dataDir, "tg.json");
  const setupHint = `a2t setup ${spec.agent}，然后 a2t gateway restart`;

  // Not ready (no Bot, no forum group, owned elsewhere): keep the socket up so
  // sessions can say why, and wait for a restart.
  let disabled: string | undefined;
  let bot: BotRecord | undefined;
  try {
    bot = defaultBot(await readRegistryFile(registryPath));
    if (!bot) disabled = `${spec.label} 的 Telegram 未配置：${setupHint}。`;
    else if (bot.forumChatId === undefined) disabled = `${spec.label} 的 Bot 未设置论坛群 ID（forumChatId）：${setupHint}。`;
    else if (bot.allowedUserId === undefined) disabled = `${spec.label} 的 Bot 未设置你的 Telegram 用户 ID：${setupHint}。`;
    else {
      const claim = claimBot(bot.token, spec.agent);
      if (!claim.ok) disabled = claim.reason;
    }
  } catch (error) {
    disabled = `${spec.label} 的配置无法读取：${error instanceof Error ? error.message : String(error)}`;
  }

  let config: TelegramConfig = bot ? toConfig(bot) : {};
  const cursorPath = bot ? spec.cursorPath(bot.token) : "";
  if (bot) {
    try {
      const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as { updateId?: number };
      if (Number.isSafeInteger(cursor.updateId)) config.lastUpdateId = cursor.updateId;
    } catch { /* first run */ }
  }

  const abort = new AbortController();
  onStop.push(() => abort.abort());
  const helper = join(dirname(fileURLToPath(import.meta.url)), "restart-helper.js");
  const gateway = new BotGateway({
    dataDir: spec.dataDir, mode: spec.mode, agentLabel: spec.label,
    ...(bot ? { topicsPath: spec.topicsPath(bot.token) } : {}),
    ...(spec.isEnabled ? { isEnabled: spec.isEnabled } : {}),
    ...(spec.commands ? { commands: spec.commands } : {}),
    getConfig: () => config,
    api: (method, body) => telegramApi(config.botToken!, method, body, abort.signal, config.apiBase),
    transport: createTelegramTransport(() => config, { getAbortSignal: () => abort.signal }),
    // The gateway is not in the agent's process tree, so the helper outlives it.
    ...(spec.agent === "claude" ? {
      saveFile: (cwd: string, fileId: string, fileName?: string) => saveTelegramFile(config, cwd, fileId, fileName, abort.signal),
      startRestart: (job: object) => {
        spawn(process.execPath, [helper, JSON.stringify({ ...job, logPath: join(runtimeDir(spec.dataDir), "restart.jsonl") })],
          { detached: true, stdio: "ignore" }).unref();
      },
      readArgv: (pid: number) => {
        try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { return undefined; }
      },
    } : {}),
  });

  mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const connId = str(body.connId);
        let reply: unknown = {};
        if (req.url === "/health") reply = { ok: !disabled, agent: spec.agent, sessions: gateway.sessionCount, ...(disabled ? { reason: disabled } : {}) };
        else if (disabled) reply = { ok: false, reason: disabled };
        else if (req.url === "/open") {
          reply = await gateway.open({ connId, cwd: str(body.cwd), claudeSessionId: str(body.claudeSessionId) || undefined,
            pid: num(body.pid), pane: str(body.pane) || undefined, modDir: str(body.modDir) || undefined,
            legacyThreadId: num(body.legacyThreadId) });
        } else if (req.url === "/poll") {
          const ids = Array.isArray(body.messageIds) ? body.messageIds.filter((id): id is number => typeof id === "number") : [];
          reply = await gateway.poll(connId, POLL_HOLD_MS, ids);
        } else if (req.url === "/close") gateway.close(connId);
        else if (req.url === "/sessions") reply = { sessions: gateway.listSessions() };
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
        log(`${tag} request ${req.url} failed: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    })();
  });
  server.requestTimeout = 0;
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socketPath, done); });
  chmodSync(socketPath, 0o600);
  onStop.push(() => { server.close(); rmSync(socketPath, { force: true }); });
  setInterval(() => gateway.reap(), 10_000).unref();

  if (disabled) { log(`${tag} disabled: ${disabled}`); return; }
  if (spec.thin) await gateway.registerCommands().catch(error => log(`${tag} setMyCommands failed: ${String(error)}`));
  log(`${tag} polling for ${bot!.name}`);
  if (spec.agent === "codex") {
    void new CodexBridge({ gateway, connect: () => connectCodex(), log }).run(stopping)
      .catch(error => log(`${tag} bridge failed: ${String(error)}`));
  }
  let conflicts = 0;
  while (!stopping()) {
    try {
      const updates = await getTelegramUpdates(config, abort.signal);
      conflicts = 0;
      for (const update of updates) {
        await gateway.handleUpdate(update).catch(error => log(`${tag} update ${update.update_id} failed: ${String(error)}`));
        config.lastUpdateId = update.update_id;
        mkdirSync(dirname(cursorPath), { recursive: true, mode: 0o700 });
        writeFileSync(cursorPath, JSON.stringify({ updateId: update.update_id, updatedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
      }
    } catch (error) {
      if (stopping()) break;
      const text = error instanceof Error ? error.message : String(error);
      // The gateway is this Bot's only poller here, so a lasting conflict is another program.
      if (/Conflict|terminated by other|409/i.test(text)) {
        conflicts += 1;
        log(`${tag} conflict ${conflicts}: ${text}`);
        if (conflicts === 2) gateway.broadcastLog(`Telegram：这个 Bot 正被其他程序使用，网关暂停接收，每分钟重试一次。（${text}）`);
        await new Promise(done => setTimeout(done, conflicts === 1 ? CONFLICT_FIRST_RETRY_MS : CONFLICT_RETRY_MS));
      } else {
        await new Promise(done => setTimeout(done, 3_000));
      }
    }
  }
}

async function main(): Promise<void> {
  let stopping = false;
  const onStop: Array<() => void> = [];
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const stop of onStop) { try { stop(); } catch { /* best effort */ } }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Every agent runs on its own; one failing never stops the others.
  await Promise.all(agentSpecs().map(spec => serveAgent(spec, () => stopping, onStop)
    .catch(error => log(`[${spec.agent}] failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))));
  // Keep the process (and the disabled agents' sockets) alive until stopped.
  await new Promise(() => undefined);
}

main().catch(error => {
  log(`gateway failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
