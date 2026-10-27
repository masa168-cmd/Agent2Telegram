#!/usr/bin/env node
/**
 * State-equivalence suite (plan §7.2): prove that operating from Telegram and
 * operating in the terminal drive the host to the SAME state, not merely that
 * Telegram got a reply.
 *
 * Each case runs twice against a freshly seeded, isolated host (`pi` or
 * `omp`, chosen per case):
 *   A - driven with tmux keystrokes (what a terminal user types),
 *   B - driven through the mock Bot API (injected messages + button taps).
 * The runs are sequential (never two hosts against one mock Telegram). After
 * each side, the host state is read back from disk (session .jsonl,
 * settings.json / config.yml) and the two snapshots are deep-compared.
 *
 * Usage: node scripts/e2e/run-e2e-state.mjs [--host pi|omp|both] [--keep] [--self-test]
 *   --host both  default; every case declares its host, so `both` runs all of
 *                them, `pi` runs only the pi cases, `omp` only the omp ones
 *   --keep       leave the run directories under ROOT in place
 *   --self-test  run B of the settings-toggle cases WITHOUT tapping the
 *                toggle button; those cases MUST then be judged ✗ (proves the
 *                comparison actually detects divergence).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");
const ROOT = process.env.PITG_E2E_STATE_ROOT ?? "/tmp/pitg-e2e-state";
const TG_PORT = Number(process.env.PITG_E2E_STATE_TG_PORT ?? 9700);
const PROVIDER_PORT = Number(process.env.PITG_E2E_STATE_PROVIDER_PORT ?? 9701);
const PI_CLI = resolve(REPO, "node_modules/.bin/pi");
const OMP_CLI = process.env.OMP_CLI || "omp";
const KEEP = process.argv.includes("--keep");
const SELF_TEST = process.argv.includes("--self-test");
const HOST_ARG = process.argv.includes("--host") ? process.argv[process.argv.indexOf("--host") + 1] ?? "" : "both";
if (!["pi", "omp", "both"].includes(HOST_ARG)) {
  console.error(`bad --host "${HOST_ARG}" (want pi|omp|both)`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();

async function control(path, init) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, { ...init, headers: { connection: "close", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const controlGet = () => control("/_control/log");
const controlPost = (path, body) => control(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function waitFor(label, predicate, { timeoutMs = 25_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate(await controlGet());
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
}

/** Fresh agent dir for `host`: mock provider with TWO models (so /model has a
 * target), mock bot, isolated project. Same stack as audit-parity.mjs. */
function seed(host, runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (host === "pi") {
    // clearDialog() sends Escape twice; with an empty editor pi would open the Session Tree.
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: { mock: { baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }, { id: "mock-model-2" }] } },
    }, null, 2) + "\n");
  } else {
    writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock", "    api: openai-completions", "    models:",
      "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768", "        maxTokens: 4096",
      "      - id: mock-model-2", "        name: Mock Model 2", "        contextWindow: 32768", "        maxTokens: 4096", "",
    ].join("\n"));
  }
  const token = `${host === "pi" ? "333333" : "444444"}:STATE_TOKEN`;
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{ id: `${host}-bot`, name: host, token, allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}` }],
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

async function bootHost(host, tag) {
  const session = `pitg-state-${tag}`;
  const runDir = join(ROOT, `run-${tag}`);
  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");
  const { agentDir, projectDir } = seed(host, runDir);
  const start = startHost(host, projectDir, agentDir, session);
  if (start.status !== 0) throw new Error(`start ${host}: ${start.stderr}`);
  const deadline = Date.now() + (host === "omp" ? 90_000 : 60_000);
  while (Date.now() < deadline) {
    const state = await controlGet();
    if (state.calls.some((c) => c.method === "getMe" && c.token?.includes("STATE"))) return { session, runDir, agentDir, host };
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${host} auth; pane tail: ${paneText(session).split("\n").filter((l) => l.trim()).slice(-4).join(" | ").slice(0, 300)}`);
}

// ── host state read back from disk ───────────────────────────────────────

function listJsonl(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listJsonl(path, out);
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function latestSessionFile(agentDir) {
  const files = listJsonl(join(agentDir, "sessions"));
  if (files.length === 0) return undefined;
  return files.reduce((best, path) => (statSync(path).mtimeMs >= statSync(best).mtimeMs ? path : best));
}

function sessionEntries(agentDir) {
  const file = latestSessionFile(agentDir);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return {}; } });
}

/** Auto-compact persists as `compaction.enabled` in settings.json (default true). */
function readAutoCompact(agentDir) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return settings.compaction?.enabled ?? true;
  } catch {
    return true;
  }
}

/** Flatten omp `config.yml` (2-level nested or dotted keys) into a dotted
 * key -> scalar map, e.g. `modelRoles.smol` -> "mock/mock-model-2". Values
 * keep string form; "true"/"false" become booleans. Lists are ignored. */
function readConfigYamlFlat(agentDir) {
  const out = {};
  try {
    let top = "";
    for (const rawLine of readFileSync(join(agentDir, "config.yml"), "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith("- ")) continue;
      const match = line.match(/^([^:]+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      const indent = rawLine.length - rawLine.trimStart().length;
      if (indent === 0) {
        top = key.includes(".") ? "" : key;
        if (value) out[key] = value === "true" ? true : value === "false" ? false : value;
      } else if (top && value) {
        out[`${top}.${key}`] = value === "true" ? true : value === "false" ? false : value;
      }
    }
  } catch {
    /* missing file -> empty map */
  }
  return out;
}

async function pollSessionEntries(agentDir, label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = sessionEntries(agentDir);
    const hit = predicate(entries);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; last entries: ${entries.slice(-3).map((e) => e.type).join(",") || "(none)"}`);
    }
    await sleep(300);
  }
}

async function pollUntil(label, read, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(read())) return true;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (value=${JSON.stringify(read())})`);
    await sleep(300);
  }
}

async function waitPane(session, label, regex, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = paneText(session);
    if (regex.test(pane)) return pane;
    if (Date.now() > deadline) {
      const tail = pane.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-─━\s|]+$/.test(l)).slice(-12).join(" | ").slice(0, 400);
      throw new Error(`timeout waiting for ${label}; pane tail: ${tail}`);
    }
    await sleep(250);
  }
}

// ── side contexts ────────────────────────────────────────────────────────

function terminalCtx(session, agentDir) {
  const type = (text) => {
    const res = tmux("send-keys", "-t", session, "-l", text);
    if (res.status !== 0) throw new Error(`send-keys failed: ${res.stderr}`);
  };
  const key = (name) => tmux("send-keys", "-t", session, name);
  return {
    agentDir,
    session,
    type,
    key,
    pane: () => paneText(session),
    waitPane: (label, regex, timeoutMs) => waitPane(session, label, regex, timeoutMs),
    pollEntries: (label, predicate, timeoutMs) => pollSessionEntries(agentDir, label, predicate, timeoutMs),
    poll: (label, read, predicate, timeoutMs) => pollUntil(label, read, predicate, timeoutMs),
    warmup: async () => {
      type("warmup");
      key("Enter");
      await waitPane(session, "warmup reply", /MOCK_OK/, 60_000);
    },
  };
}

let updateId = 50000;
let telegramMessageId = 60000;

const injectMessage = (text) => controlPost("/_control/inject", {
  updates: [{
    update_id: updateId++,
    message: {
      message_id: telegramMessageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" }, text,
    },
  }],
});

function telegramCtx(host, agentDir) {
  const cursor = async () => (await controlGet()).calls.length;
  const keyboardWith = async (label, regex, since, timeoutMs = 25_000) => waitFor(`keyboard: ${label}`, (state) =>
    state.calls.slice(since).findLast((entry) =>
      Array.isArray(rowsOf(entry)) && buttonsOf(entry).some((b) => regex.test(String(b.text ?? "")))) ?? false,
  { timeoutMs });
  const click = async (keyboardCall, regex) => {
    const button = buttonsOf(keyboardCall).find((b) => regex.test(String(b.text ?? "")));
    if (!button) throw new Error(`no button matching ${regex} in [${buttonsOf(keyboardCall).map((b) => b.text).join(" | ")}]`);
    const targetMessageId = keyboardCall.message_id ?? keyboardCall.body?.message_id;
    const callbackId = `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const since = await cursor();
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId,
          from: { id: 42, is_bot: false, first_name: "E2E" },
          message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
          chat_instance: "state",
          data: String(button.callback_data),
        },
      }],
    });
    const answered = await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId),
    { timeoutMs: 15_000 }).then(() => true).catch(() => false);
    // The follow-up for this click: an edit of the same message, or a fresh send.
    await waitFor(`follow-up after ${button.text}`, (state) =>
      state.calls.slice(since).findLast((entry) =>
        (entry.method === "sendMessage" || entry.method === "editMessageText")
        && (entry.body?.message_id === targetMessageId || entry.method === "sendMessage")) ?? false,
    { timeoutMs: answered ? 20_000 : 3_000 }).catch(() => undefined);
    if (!answered) throw new Error(`callback not answered: ${button.text}`);
  };
  return {
    host,
    agentDir,
    selfTest: SELF_TEST,
    cursor,
    send: (text) => injectMessage(text),
    warmup: async () => {
      const since = await cursor();
      await injectMessage("warmup");
      await waitFor("warmup reply", (state) =>
        state.calls.slice(since).find((entry) =>
          ["sendMessage", "editMessageText"].includes(entry.method)
          && /MOCK_OK/.test(String(entry.body?.text ?? ""))) ?? false,
      { timeoutMs: 60_000 });
    },
    keyboardWith,
    click,
    buttons: buttonsOf,
    pollEntries: (label, predicate, timeoutMs) => pollSessionEntries(agentDir, label, predicate, timeoutMs),
    poll: (label, read, predicate, timeoutMs) => pollUntil(label, read, predicate, timeoutMs),
  };
}

// ── cases ────────────────────────────────────────────────────────────────

const lastEntry = (entries, type) => entries.findLast((entry) => entry.type === type);

/** Model-row labels of a model keyboard, with cursor/current markers (▸, ✓)
 * stripped; non-model buttons (Cancel, pages) are dropped. */
const modelLabels = (call) => buttonsOf(call)
  .map((b) => String(b.text ?? "").replace(/^[▸✓\s]+/, "").trim())
  .filter((text) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+$/i.test(text));

/** Plan §7.2 step 4: the Telegram option set must match the host config. */
function assertOptionSet(label, got, { exact, include }) {
  const set = new Set(got);
  const missing = (exact ?? include).filter((x) => !set.has(x));
  const extra = exact ? got.filter((x) => !new Set(exact).has(x)) : [];
  if (missing.length || extra.length) {
    const diff = `missing=[${missing.join(", ")}] extra=[${extra.join(", ")}] got=[${got.join(", ")}]`;
    console.log(`  option-set ${label}: ${diff}`);
    throw new Error(`option set mismatch (${label})`);
  }
}

/** pi persists scoped models as `enabledModels` (absent = all enabled). */
function readEnabledModels(agentDir) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return Array.isArray(settings.enabledModels) ? settings.enabledModels : null;
  } catch {
    return null;
  }
}

const CASES = [
  {
    name: "/name state-probe",
    slug: "name",
    host: "pi",
    async terminal(t) {
      await t.warmup();
      t.type("/name state-probe");
      t.key("Enter");
      await t.pollEntries("session_info name", (entries) =>
        lastEntry(entries, "session_info")?.name === "state-probe" ? true : false);
    },
    async telegram(g) {
      await g.warmup();
      await g.send("/name state-probe");
      await g.pollEntries("session_info name", (entries) =>
        lastEntry(entries, "session_info")?.name === "state-probe" ? true : false);
    },
    snapshot: (agentDir) => ({ sessionName: lastEntry(sessionEntries(agentDir), "session_info")?.name ?? null }),
  },
  {
    name: "/model -> mock-model-2",
    slug: "model",
    host: "pi",
    async terminal(t) {
      await t.warmup();
      t.type("/model");
      t.key("Enter");
      // The selector lists rows as `mock-model-2 [mock]`; type-ahead filters, Enter takes the first hit.
      await t.waitPane("model selector", /mock-model-2 \[mock\]/, 20_000);
      t.type("mock-model-2");
      await sleep(600);
      t.key("Enter");
      await t.pollEntries("model_change mock/mock-model-2", (entries) => {
        const entry = lastEntry(entries, "model_change");
        return entry && entry.provider === "mock" && entry.modelId === "mock-model-2" ? true : false;
      });
    },
    async telegram(g) {
      await g.warmup();
      const since = await g.cursor();
      await g.send("/model");
      const keyboard = await g.keyboardWith("Select model", /mock\/mock-model-2/, since);
      assertOptionSet("pi /model", modelLabels(keyboard), { exact: ["mock/mock-model", "mock/mock-model-2"] });
      await g.click(keyboard, /mock\/mock-model-2/);
      await g.pollEntries("model_change mock/mock-model-2", (entries) => {
        const entry = lastEntry(entries, "model_change");
        return entry && entry.provider === "mock" && entry.modelId === "mock-model-2" ? true : false;
      });
    },
    snapshot: (agentDir) => {
      const entry = lastEntry(sessionEntries(agentDir), "model_change");
      return { model: entry ? `${entry.provider}/${entry.modelId}` : null };
    },
  },
  {
    name: "/settings Auto-compact toggle",
    slug: "settings",
    host: "pi",
    selfTestToggle: true,
    async terminal(t) {
      await t.warmup();
      t.type("/settings");
      t.key("Enter");
      await t.waitPane("settings dialog", /Auto-compact/, 20_000);
      // Cursor starts on row 1 (Auto-compact); Enter cycles its value once.
      t.key("Enter");
      await t.poll("compaction.enabled=false persisted", () => readAutoCompact(t.agentDir), (value) => value === false, 10_000);
      t.key("Escape");
    },
    async telegram(g) {
      await g.warmup();
      const since = await g.cursor();
      await g.send("/settings");
      const keyboard = await g.keyboardWith("Settings dialog", /Auto-compact/, since);
      if (!g.selfTest) {
        await g.click(keyboard, /○\s*Auto-compact:\s*false/);
      }
      const updated = await g.keyboardWith("Cancel button", /Cancel/, since);
      await g.click(updated, /Cancel/);
      await sleep(1000);
    },
    snapshot: (agentDir) => ({ autoCompact: readAutoCompact(agentDir) }),
  },
  {
    name: "/scoped-models scope to mock-model-2",
    slug: "scoped-models",
    host: "pi",
    async terminal(t) {
      t.type("/scoped-models");
      t.key("Enter");
      await t.waitPane("scoped models dialog", /✓ mock-model-2 \[mock\]/, 20_000);
      // Rows render `✓ <id> [provider]` with the cursor as `→`; both models
      // are enabled by default, so uncheck mock-model and save: the persisted
      // set pins mock-model-2 as the only scoped model.
      t.key("Enter");
      await t.waitPane("1/2 enabled (unsaved)", /1\/2 enabled \(unsaved\)/, 10_000);
      t.key("C-s");
      await t.poll("enabledModels persisted", () => readEnabledModels(t.agentDir), (value) => value?.includes("mock/mock-model-2") && !value.includes("mock/mock-model"), 10_000);
      t.key("Escape");
    },
    async telegram(g) {
      const since = await g.cursor();
      await g.send("/scoped-models");
      const kb = await g.keyboardWith("Model Configuration", /☑▸?\s*mock\/mock-model(?![0-9-])/, since, 30_000);
      await g.click(kb, /^☑▸?\s*mock\/mock-model$/);
      const kb2 = await g.keyboardWith("unchecked row", /☐▸?\s*mock\/mock-model$/, since, 30_000);
      await g.click(kb2, /Submit/);
      await g.poll("enabledModels persisted", () => readEnabledModels(g.agentDir), (value) => value?.includes("mock/mock-model-2") && !value.includes("mock/mock-model"), 10_000);
    },
    snapshot: (agentDir) => ({ enabledModels: readEnabledModels(agentDir) }),
  },
  {
    name: "omp /model assign smol -> mock/mock-model-2",
    slug: "omp-model",
    host: "omp",
    async terminal(t) {
      t.type("/model");
      t.key("Enter");
      await t.waitPane("model panel", /mock-model/, 20_000);
      t.type("mock-model-2");
      await t.waitPane("filtered preview", /Mock Model 2 ·/, 10_000);
      // Enter opens the role bar with the cursor on [ default ]; one Right
      // lands on smol, Enter assigns, Esc closes the panel.
      t.key("Enter");
      await t.waitPane("role bar", /mock-model-2 → \[ default \]/, 10_000);
      t.key("Right");
      await t.waitPane("cursor on smol", /\[ smol \]/, 10_000);
      t.key("Enter");
      await t.poll("modelRoles.smol persisted", () => readConfigYamlFlat(t.agentDir)["modelRoles.smol"], (value) => value === "mock/mock-model-2", 10_000);
      t.key("Escape");
      await sleep(300);
      t.key("Escape");
    },
    async telegram(g) {
      const since = await g.cursor();
      await g.send("/model");
      let kb = await g.keyboardWith("Models panel", /mock\/mock-model/, since, 30_000);
      const seen = new Set();
      const collect = (call) => { for (const label of modelLabels(call)) seen.add(label); };
      collect(kb);
      // The panel pages through every built-in provider; mock-model-2 may sit
      // on a later page.
      for (let page = 0; page < 6 && !seen.has("mock/mock-model-2"); page += 1) {
        if (!g.buttons(kb).some((b) => /Next/.test(String(b.text ?? "")))) break;
        await g.click(kb, /Next/);
        kb = await g.keyboardWith(`models page ${page + 2}`, /\/\d|Next|Prev/, since, 20_000);
        collect(kb);
      }
      assertOptionSet("omp /model", [...seen], { include: ["mock/mock-model", "mock/mock-model-2"] });
      await g.click(kb, /mock\/mock-model-2/);
      // The Assign dialog inherits the panel's page state, so smol may sit
      // behind ◀ Prev.
      let assign = await g.keyboardWith("Assign dialog", /Cancel/, since, 30_000);
      for (let page = 0; page < 4; page += 1) {
        if (g.buttons(assign).some((b) => /^\s*(✓\s*)?smol\s*$/.test(String(b.text ?? "")))) break;
        if (!g.buttons(assign).some((b) => /Prev/.test(String(b.text ?? "")))) break;
        await g.click(assign, /◀ Prev/);
        assign = await g.keyboardWith(`assign page ${page + 1}`, /Cancel/, since, 20_000);
      }
      await g.click(assign, /^\s*(✓\s*)?smol\s*$/);
      const closed = await g.keyboardWith("assign Cancel", /Cancel/, since, 15_000);
      await g.click(closed, /Cancel/);
      await g.poll("modelRoles.smol persisted", () => readConfigYamlFlat(g.agentDir)["modelRoles.smol"], (value) => value === "mock/mock-model-2", 10_000);
    },
    snapshot: (agentDir) => ({ smolRole: readConfigYamlFlat(agentDir)["modelRoles.smol"] ?? null }),
  },
  {
    name: "omp /settings toggle Hide Thinking Blocks",
    slug: "omp-settings",
    host: "omp",
    skipReason: "omp 18.12.5 flips the dialog value on both sides (Telegram `○ Hide Thinking Blocks: On`, terminal Enter) but persists nothing to config.yml or agent.db in the mock env — no disk state to compare; the terminal search cursor also starts on an arbitrary row",
    async terminal(t) {
      t.type("/settings");
      t.key("Enter");
      await t.waitPane("settings dialog", /matches|Model/, 20_000);
      t.type("hide thinking");
      await t.waitPane("search matches", /matches/, 10_000);
      t.key("Enter");
      await sleep(1500);
      t.key("Escape");
      await sleep(300);
      t.key("Escape");
    },
    async telegram(g) {
      const since = await g.cursor();
      await g.send("/settings");
      let kb = await g.keyboardWith("omp settings", /📄/, since, 30_000);
      await g.click(kb, /📄 Model/);
      kb = await g.keyboardWith("Model page", /📄 Appearance|◉|○/, since, 30_000);
      for (let page = 0; page < 4; page += 1) {
        if (g.buttons(kb).some((b) => /Hide Thinking Blocks/.test(String(b.text ?? "")))) break;
        if (!g.buttons(kb).some((b) => /Next/.test(String(b.text ?? "")))) break;
        await g.click(kb, /Next/);
        kb = await g.keyboardWith("settings page", /\/\d|Next|Prev/, since, 20_000);
      }
      await g.click(kb, /○ Hide Thinking Blocks: On/);
      const closed = await g.keyboardWith("settings Cancel", /Cancel/, since, 15_000);
      await g.click(closed, /Cancel/);
      await sleep(1000);
    },
    snapshot: (agentDir) => {
      const flat = readConfigYamlFlat(agentDir);
      const key = Object.keys(flat).find((name) => /thinking/i.test(name));
      return { thinkingToggle: key ? flat[key] : null };
    },
  },
];

// ── runner ───────────────────────────────────────────────────────────────

async function runSide(caseDef, side) {
  const tag = `${caseDef.slug}-${side}`;
  let session;
  try {
    const booted = await bootHost(caseDef.host, tag);
    session = booted.session;
    if (side === "A") await caseDef.terminal(terminalCtx(booted.session, booted.agentDir));
    else await caseDef.telegram(telegramCtx(caseDef.host, booted.agentDir));
    await sleep(500);
    return { snapshot: caseDef.snapshot(booted.agentDir) };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    if (session) killSession(session);
  }
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: "ignore" }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: "ignore" }),
  ];
  await sleep(1500);

  const results = [];
  const selected = CASES.filter((caseDef) => HOST_ARG === "both" || caseDef.host === HOST_ARG);
  try {
    for (const caseDef of selected) {
      if (caseDef.skipReason) {
        console.log(`○ skipped — ${caseDef.name}: ${caseDef.skipReason}`);
        continue;
      }
      const a = await runSide(caseDef, "A");
      const b = await runSide(caseDef, "B");
      const skipped = [a, b].find((side) => side.error?.startsWith("SKIP:"));
      if (skipped) {
        console.log(`○ skipped — ${caseDef.name}: ${skipped.error.slice(5).trim()}`);
        continue;
      }
      const render = (side) => (side.error ? `ERR ${side.error}` : JSON.stringify(side.snapshot));
      const ok = !a.error && !b.error && JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot);
      results.push({ slug: caseDef.slug, ok, selfTestToggle: Boolean(caseDef.selfTestToggle) });
      console.log(`${ok ? "✓" : "✗"} ${caseDef.name} — A=${render(a)} B=${render(b)}`);
    }
  } finally {
    for (const mock of mocks) mock.kill();
    if (!KEEP) {
      await sleep(300);
      rmSync(ROOT, { recursive: true, force: true });
    }
  }

  const failures = results.filter((r) => !r.ok).length;
  console.log(`STATE_ACCEPTANCE=${failures}`);
  if (SELF_TEST) {
    const expected = results.filter((r) => r.selfTestToggle);
    const others = results.filter((r) => !r.selfTestToggle);
    const pass = expected.length > 0 && expected.every((r) => !r.ok) && others.every((r) => r.ok);
    console.log(`SELF_TEST=${pass ? "PASS" : "FAIL"} (toggle cases must be the only ✗)`);
    process.exitCode = pass ? 0 : 1;
  } else {
    process.exitCode = failures > 0 ? 1 : 0;
  }
}

await main();
