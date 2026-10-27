#!/usr/bin/env node
/**
 * Parity audit: for every advertised command, record what the host TUI shows
 * and what Telegram gets, so interaction gaps are measured instead of guessed.
 *
 * Runs the same isolated stack as the acceptance (real pi/OMP in tmux, mock Bot
 * API + mock provider) and writes one JSONL row per command:
 *   { host, command, telegram: { kind, title, options, hasInputHint },
 *     pane: { dialog: bool, boxedTitle }, gapHints: [...] }
 *
 * Usage: node scripts/e2e/audit-parity.mjs [--host pi|omp|both] [--out file]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");
const ROOT = process.env.PITG_PARITY_ROOT ?? "/tmp/pitg-parity";
const TG_PORT = Number(process.env.PITG_PARITY_TG_PORT ?? 9600);
const PROVIDER_PORT = Number(process.env.PITG_PARITY_PROVIDER_PORT ?? 9601);
const OMP_CLI = process.env.OMP_CLI || "omp";
const PI_CLI = resolve(REPO, "node_modules/.bin/pi");
const HOST_ARG = (process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] : "both");

// Commands that reach an external service or upload the test session (share links,
// collaboration sessions, self-update). The audit never runs them.
const NETWORK_COMMANDS = new Set(["/share", "/collab", "/join", "/leave", "/update", "/upgrade"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const hasTui = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:tui:"));
const hasUi = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:ui:"));
// The DialogBroker answers a dialog with `tgplus:dlg:` buttons; item rows carry
// a `c`/`t`/`m` op, so "has item buttons" is what makes a keyboard a real
// selector rather than a wall of raw keys.
const DIALOG_PICK = /^tgplus:dlg:[^:]+:\d+:[ctm](?::|$)/;
const hasDialog = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:dlg:"));
const isPickData = (data) => /^tgplus:tui:pick:/.test(data) || DIALOG_PICK.test(data);

async function control(path, init) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, { ...init, headers: { connection: "close", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const controlGet = () => control("/_control/log");
const controlPost = (path, body) => control(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
}

function seed(host, runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (host === "pi") {
    // clearDialog() sends Escape twice; with an empty editor pi would open the Session Tree.
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { mock: { baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }] } },
    }, null, 2) + "\n");
  } else {
    writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock", "    api: openai-completions", "    models:",
      "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768", "        maxTokens: 4096", "",
    ].join("\n"));
  }
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{ id: `${host}-bot`, name: host, token: `${host === "pi" ? "333333" : "444444"}:PARITY_TOKEN`, allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}` }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`, enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function startHost(host, projectDir, agentDir, session) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = host === "omp"
    ? [OMP_CLI, "-e", PLUGIN, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"]
    : [PI_CLI, "--no-skills", "--no-extensions", "-e", PLUGIN, "--provider", "mock", "--model", "mock-model"];
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  return tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
}

const paneText = (session) => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");

function classify(call) {
  const text = String(call?.body?.text ?? "");
  const buttons = buttonsOf(call);
  const pickCount = buttons.filter((b) => /^tgplus:tui:pick:/.test(String(b.callback_data ?? ""))).length;
  const dialogPickCount = buttons.filter((b) => DIALOG_PICK.test(String(b.callback_data ?? ""))).length;
  const kind = pickCount > 0 ? "tui-selector"
    : dialogPickCount > 0 ? "dialog"
    : hasTui(call) ? "tui-mirror"
    : hasUi(call) ? "native-ui"
    : hasDialog(call) ? "dialog"
    : buttons.length > 0 ? "menu"
    : "text";
  const title = (text.match(/^\s*<b>([\s\S]*?)<\/b>/) ?? [])[1]?.replace(/<[^>]+>/g, "") ?? "";
  return {
    kind,
    title: title.slice(0, 80),
    options: pickCount || dialogPickCount || buttons.length,
    buttons: buttons.map((b) => String(b.text ?? "").slice(0, 20)).slice(0, 12),
    hasInputHint: /typed input/i.test(text),
    chars: text.length,
  };
}

function paneDialog(session) {
  const pane = paneText(session);
  const boxed = pane.split("\n").find((line) => /[╭┌]/.test(line));
  return { dialog: Boolean(boxed), boxedTitle: boxed ? boxed.replace(/[╭─╮]/g, "").trim().slice(0, 40) : "" };
}

async function bootHost(host, tag) {
  const session = `pitg-parity-${host}-${tag}`;
  const runDir = join(ROOT, `run-${host}-${tag}`);
  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");
  const { agentDir, projectDir } = seed(host, runDir);
  const start = startHost(host, projectDir, agentDir, session);
  if (start.status !== 0) throw new Error(`start ${host}: ${start.stderr}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await controlGet();
    if (state.calls.some((c) => c.method === "getMe" && c.token?.includes("PARITY"))) return { session, runDir };
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${host} auth`);
}

let updateId = 7000;
let messageId = 12000;
const injectCallback = (data, targetMessageId) => controlPost("/_control/inject", {
  updates: [{
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`, from: { id: 42, is_bot: false, first_name: "E2E" },
      message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
      chat_instance: "parity", data,
    },
  }],
});

const injectMessage = (text) => controlPost("/_control/inject", {
  updates: [{
    update_id: updateId++,
    message: {
      message_id: messageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" }, text,
    },
  }],
});

/**
 * Each command runs against a freshly booted host so an earlier dialog can
 * never leak into the next measurement (that was the main source of bogus
 * rows). Slower, but a parity matrix must be deterministic.
 */
async function auditCommand(host, command, outFile) {
  const tag = command.replace(/[^a-zA-Z0-9]/g, "");
  const { session } = await bootHost(host, tag);
  const prompt = process.env.PITG_PARITY_PROMPT;
  try {
    const cursor = (await controlGet()).calls.length;
    await injectMessage(prompt ?? command);
    // Wait for the ack, then until the call log is quiet: the mirror lands a
    // few seconds after dispatch while the bridge waits for the host screen.
    const ackDeadline = Date.now() + 15_000;
    let call;
    while (Date.now() < ackDeadline) {
      const state = await controlGet();
      call = state.calls.slice(cursor).find((entry) => ["sendMessage", "editMessageText", "sendPhoto", "sendDocument"].includes(entry.method));
      if (call) break;
      await sleep(300);
    }
    const settleDeadline = Date.now() + 20_000;
    let lastCount = (await controlGet()).calls.length;
    let stableSince = Date.now();
    while (Date.now() < settleDeadline) {
      await sleep(400);
      const nowCount = (await controlGet()).calls.length;
      if (nowCount !== lastCount) { lastCount = nowCount; stableSince = Date.now(); continue; }
      if (Date.now() - stableSince >= 2500) break;
    }
    // Only tap when the variable is a real non-empty value: Number("") is 0,
    // which used to auto-tap the first option on every audit run.
    const tapRaw = String(process.env.PITG_PARITY_TAP ?? "").trim();
    const tapIndex = tapRaw === "" ? NaN : Number(tapRaw);
    if (Number.isInteger(tapIndex) && tapIndex >= 0) {
      const stateBefore = await controlGet();
      const kb = stateBefore.calls.slice(cursor).filter((entry) => Array.isArray(rowsOf(entry))).at(-1);
      const flat = (rowsOf(kb) ?? []).flat();
      const picks = flat.filter((b) => isPickData(String(b.callback_data ?? "")));
      const target = picks[tapIndex];
      if (target) {
        await injectCallback(String(target.callback_data), kb?.body?.message_id ?? kb?.message_id);
        await sleep(2500);
      }
    }
    const after = (await controlGet()).calls.slice(cursor);
    const lastCall = after.filter((entry) => ["sendMessage", "editMessageText", "sendPhoto", "sendDocument"].includes(entry.method)).at(-1) ?? call;
    const lastKeyboard = after.filter((entry) => Array.isArray(rowsOf(entry))).at(-1) ?? call;
    const telegram = lastCall ? classify(lastCall) : { kind: "none", title: "", options: 0, buttons: [], hasInputHint: false, chars: 0 };
    telegram.keyboard = lastKeyboard !== lastCall && lastKeyboard ? classify(lastKeyboard).kind : undefined;
    const pane = paneDialog(session);
    pane.raw = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "").split("\n").slice(-45).join("\n");
    const row = {
      host, command, telegram, pane,
      messageId: lastKeyboard?.body?.message_id ?? lastKeyboard?.message_id,
      text: String(lastCall?.body?.text ?? "").slice(0, 2000),
      buttons: (rowsOf(lastKeyboard) ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data })),
    };
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    console.log(`${host} ${command.padEnd(20)} telegram=${telegram.kind.padEnd(12)} title="${telegram.title.slice(0, 30)}" pane="${pane.boxedTitle.slice(0, 24)}" dialog=${pane.dialog ? "y" : "n"}`);
    return row;
  } finally {
    killSession(session);
  }
}

async function runHost(host, outFile) {
  const only = (process.env.PITG_PARITY_COMMANDS ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  let advertised = [];
  if (only.length === 0) {
    const catalog = await bootHost(host, "catalog");
    advertised = ((await controlGet()).calls.findLast((c) => c.method === "setMyCommands")?.body?.commands ?? [])
      .map((c) => `/${c.command}`);
    killSession(catalog.session);
  }
  const skip = new Set(["/quit", "/exit"]);
  const order = only.length > 0 ? only : advertised.filter((c) => !skip.has(c) && !NETWORK_COMMANDS.has(c));
  const skippedNetwork = only.length === 0 ? advertised.filter((c) => NETWORK_COMMANDS.has(c)) : [];
  if (skippedNetwork.length > 0) console.log(`# ${host}: skipping ${skippedNetwork.join(", ")} (network commands, not run in tests)`);
  console.log(`# ${host}: auditing ${order.length} commands (fresh host per command)`);
  for (const command of order) {
    try {
      await auditCommand(host, command, outFile);
    } catch (error) {
      console.log(`${host} ${command.padEnd(20)} ERROR ${String(error.message).slice(0, 160)}`);
    }
  }
}

function reportGaps(outFile) {
  const rows = readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const hard = [];
  const soft = [];
  for (const row of rows) {
    const kind = row.telegram.kind;
    if (row.pane.dialog && !["tui-mirror", "tui-selector", "dialog", "native-ui"].includes(kind)) {
      hard.push(`${row.command}: host dialog but Telegram got ${kind} ("${row.telegram.title}")`);
    }
    if (kind === "tui-selector" || kind === "dialog") {
      const picks = (row.buttons ?? []).filter((b) => isPickData(String(b.data ?? "")));
      const junky = picks.filter((b) => /[│…]$/.test(String(b.text ?? "").trim()));
      if (junky.length > 0) soft.push(`${row.command}: ${junky.length} suspicious option label(s)`);
    }
  }
  console.log("\n── parity summary ──");
  for (const line of hard) console.log(`GAP  ${line}`);
  for (const line of soft) console.log(`WARN ${line}`);
  if (hard.length === 0) console.log(`OK   no hard interaction gaps in ${rows.length} commands`);
  return hard.length;
}

async function main() {
  const outIndex = process.argv.indexOf("--out");
  const outFile = outIndex === -1 ? join(ROOT, "parity.jsonl") : process.argv[outIndex + 1];
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(outFile, "");

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: "ignore" }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: "ignore" }),
  ];
  await sleep(1500);
  const hosts = HOST_ARG === "both" ? ["pi", "omp"] : [HOST_ARG];
  try {
    for (const host of hosts) await runHost(host, outFile);
  } finally {
    for (const mock of mocks) mock.kill();
  }
  console.log(`WROTE ${outFile}`);
  const gaps = reportGaps(outFile);
  process.exitCode = gaps === 0 ? 0 : 1;
}

await main();
