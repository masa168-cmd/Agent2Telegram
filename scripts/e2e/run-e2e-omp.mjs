#!/usr/bin/env node
/**
 * Isolated end-to-end acceptance for pi-telegram-plus under OMP
 * (`@oh-my-pi/pi-coding-agent`).
 *
 * Runs a real OMP TUI inside tmux against the same mock Bot API and mock
 * OpenAI-compatible provider the pi matrix uses. The assertions cover the
 * whole remote-control path plus the OMP-specific UI routing fixed in this
 * change:
 *
 *   1. plugin authenticates against the mock Bot API (getMe)
 *   2. polling loop engages
 *   3. an injected Telegram message reaches the agent
 *   4. the turn reaches the mock provider
 *   5. the reply is sent back to Telegram
 *   6. `/new` confirmation renders as Telegram inline buttons (not the OMP TUI)
 *   7. confirming starts a new session and a fresh turn still works
 *   8. a foreign lastUpdateId is rewound and the backlog is delivered once
 *
 * Usage:
 *   node scripts/e2e/run-e2e-omp.mjs [--keep] [--timeout 90]
 *     [--tg-port 9980] [--provider-port 9981] [--omp /path/to/omp]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ENTRY = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const KEEP = process.argv.includes("--keep");
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "90")) * 1000;
const TG_PORT = Number(argValue("--tg-port", "9980"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9981"));
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const BOT_TOKEN = "222222:OMP_E2E_MOCK_TOKEN";
const CHAT_ID = 778;
const USER_ID = 778;
const POISONED_CURSOR = 636583913;
const REWIND_UPDATE_ID = 541383987;
const TOKEN_HASH = createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 24);
const ROOT = process.env.PITG_E2E_OMP_ROOT || "/tmp/pitg-e2e-omp";
const SESSION = "pitg-omp";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function tmux(...args) {
  return sh("tmux", args);
}

function removeQuietly(path, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
    }
  }
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  tmux("kill-session", "-t", session);
  tmux("kill-session", "-t", session);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}

async function controlRequest(path, init, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, {
        ...init,
        headers: { connection: "close", ...(init?.headers ?? {}) },
      });
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`control request ${path} failed after ${attempts} attempts: ${lastError}`);
}

const controlPost = (path, body) =>
  controlRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const controlGet = (path) => controlRequest(path, { method: "GET" });

async function waitFor(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet("/_control/log");
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}\nlast state: ${JSON.stringify(last, null, 2).slice(0, 3000)}`);
}

function providerLog() {
  const path = join(ROOT, "provider.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function startServer(name, script, args) {
  const out = spawn("node", [join(E2E, script), ...args], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  out.stdout.on("data", (d) => { buf += d.toString(); });
  out.stderr.on("data", (d) => { buf += d.toString(); });
  return { proc: out, getOutput: () => buf };
}

function seedEnvironment(runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  const sessionDir = join(runDir, "sessions");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  // setupVersion skips the first-run wizard; startup.setupWizard suppresses the
  // reintroduction overlay. Without these, OMP paints a blocking provider picker
  // before the plugin's polling loop starts.
  writeFileSync(
    join(agentDir, "config.yml"),
    "setupVersion: 2\nstartup:\n  setupWizard: false\n",
  );

  // OMP reads custom providers from models.yml (pi uses models.json).
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  mock:",
      `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock",
      "    api: openai-completions",
      "    models:",
      "      - id: mock-model",
      "        name: Mock Model",
      "        contextWindow: 32768",
      "        maxTokens: 4096",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(agentDir, "tg.json"),
    JSON.stringify(
      {
        version: 3,
        bots: [{
          id: "e2e-bot",
          name: "e2e",
          token: BOT_TOKEN,
          allowedUserId: USER_ID,
          apiBase: `http://127.0.0.1:${TG_PORT}`,
        }],
        defaultBotId: "e2e-bot",
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(projectDir, ".pi", "telegram.json"),
    JSON.stringify({ botId: "e2e-bot", enabled: true, activeChatId: CHAT_ID }, null, 2) + "\n",
  );

  return { agentDir, projectDir, sessionDir };
}

async function runAcceptance() {
  const runDir = join(ROOT, "run-omp");
  const tgLog = join(ROOT, "telegram.jsonl");
  const provLog = join(ROOT, "provider.jsonl");
  const paneLog = join(runDir, "pane.log");
  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  removeQuietly(runDir);
  mkdirSync(runDir, { recursive: true });

  const versionResult = sh(OMP_CLI, ["--version"], { timeout: 30_000 });
  const versionText = `${versionResult.stdout ?? ""}${versionResult.stderr ?? ""}`.trim();
  record("resolve OMP CLI", versionResult.status === 0, versionText || OMP_CLI);
  if (versionResult.status !== 0) return { steps, ok: false };

  const { agentDir, projectDir, sessionDir } = seedEnvironment(runDir);
  await controlPost("/_control/reset");
  writeFileSync(provLog, "");

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
  const envArgs = Object.entries(env).map(([k, v]) => ["-e", `${k}=${v}`]).flat();

  const startPlugin = (pane) => {
    const result = tmux(
      "new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "-c", projectDir,
      ...envArgs,
      OMP_CLI,
      "-e", PLUGIN_ENTRY,
      "--model", "mock/mock-model",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--approval-mode", "yolo",
      "--no-title",
      "--session-dir", sessionDir,
    );
    if (result.status === 0) tmux("pipe-pane", "-t", SESSION, `cat > ${pane}`);
    return result;
  };

  const start = startPlugin(paneLog);
  if (start.status !== 0) {
    record("start OMP in tmux", false, start.stderr?.trim());
    return { steps, ok: false };
  }
  record("start OMP in tmux", true, SESSION);

  let updateId = 6001;
  const injectMessage = (text, messageId) => controlPost("/_control/inject", {
    updates: [{
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private" },
        from: { id: USER_ID, is_bot: false, first_name: "E2E" },
        text,
      },
    }],
  });

  // ── 1. Authenticate ───────────────────────────────────────────────────
  try {
    await waitFor("getMe", (s) => s.calls.some((c) => c.method === "getMe"));
    record("plugin authenticates via getMe", true);
  } catch (error) {
    record("plugin authenticates via getMe", false, String(error.message).slice(0, 500));
  }

  // ── 2. Polling ────────────────────────────────────────────────────────
  try {
    const state = await waitFor("getUpdates polling loop", (s) => (s.getUpdatesPolls ?? 0) > 0);
    record("polling loop reaches mock", true, `${state.getUpdatesPolls} getUpdate(s)`);
  } catch (error) {
    record("polling loop reaches mock", false, String(error.message).slice(0, 500));
  }

  // ── 3–5. Telegram -> OMP -> provider -> Telegram ──────────────────────
  const promptText = "reply with MOCK_OK";
  try {
    await injectMessage(promptText, 9101);
    await waitFor(
      "injected message delivered",
      (s) => s.calls.some((c) => c.method === "getUpdates" && c.texts?.includes(promptText)),
    );
    record("injected Telegram message picked up", true);

    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let seen;
    while (Date.now() < deadline) {
      seen = providerLog().find((e) => (e.prompt?.includes(promptText) || e.userText?.includes(promptText)));
      if (seen) break;
      await sleep(500);
    }
    if (!seen) throw new Error("no provider request carried the Telegram text");
    record("OMP turn reached mock provider", true, `model=${seen.model}`);

    await waitFor(
      "provider reply sent to Telegram",
      (s) => s.calls.some(
        (c) => (c.method === "sendMessage" || c.method === "editMessageText")
          && String(c.body?.text ?? "").includes("MOCK_OK"),
      ),
    );
    record("reply delivered to Telegram", true, "MOCK_OK round-trip");
  } catch (error) {
    record("Telegram → OMP → provider round-trip", false, String(error.message).slice(0, 500));
  }

  // ── 6. /new confirmation must reach Telegram, not the OMP TUI ─────────
  let confirmMessageId;
  let confirmCallback;
  try {
    await injectMessage("/new", 9102);
    const state = await waitFor(
      "/new confirmation buttons",
      (s) => s.calls.some(
        (c) => (c.method === "sendMessage" || c.method === "editMessageText")
          && String(c.body?.text ?? "").includes("New session")
          && Array.isArray(c.body?.reply_markup?.inline_keyboard)
          && c.body.reply_markup.inline_keyboard.length > 0,
      ),
    );
    const call = state.calls.filter(
      (c) => (c.method === "sendMessage" || c.method === "editMessageText")
        && String(c.body?.text ?? "").includes("New session")
        && Array.isArray(c.body?.reply_markup?.inline_keyboard),
    ).at(-1);
    const rows = call.body.reply_markup.inline_keyboard;
    confirmMessageId = call.message_id;
    confirmCallback = rows[0]?.[0]?.callback_data;
    if (typeof confirmMessageId !== "number") throw new Error("mock did not log the prompt message_id");
    if (typeof confirmCallback !== "string" || confirmCallback.length === 0) {
      throw new Error("confirmation button carried no callback_data");
    }
    record(
      "/new confirmation rendered as Telegram buttons",
      true,
      rows[0].map((button) => button.text).join(", "),
    );
  } catch (error) {
    record("/new confirmation rendered as Telegram buttons", false, String(error.message).slice(0, 500));
  }

  try {
    if (confirmMessageId === undefined || confirmCallback === undefined) {
      throw new Error("no confirmation prompt to answer");
    }
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: "cb-new-confirm",
          from: { id: USER_ID, is_bot: false, first_name: "E2E" },
          message: {
            message_id: confirmMessageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: CHAT_ID, type: "private" },
          },
          chat_instance: "e2e",
          data: confirmCallback,
        },
      }],
    });
    await waitFor(
      "new session notification",
      (s) => s.calls.some(
        (c) => (c.method === "sendMessage" || c.method === "editMessageText")
          && String(c.body?.text ?? "").includes("New session started"),
      ),
    );
    record("confirmation callback started a new session", true);
  } catch (error) {
    record("confirmation callback started a new session", false, String(error.message).slice(0, 500));
  }

  // ── 7. Session capture still works after /new ─────────────────────────
  try {
    const before = providerLog().filter((entry) => (entry.prompt?.includes(promptText) || entry.userText?.includes(promptText))).length;
    await injectMessage(promptText, 9103);
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let after = before;
    while (Date.now() < deadline) {
      after = providerLog().filter((entry) => (entry.prompt?.includes(promptText) || entry.userText?.includes(promptText))).length;
      if (after > before) break;
      await sleep(500);
    }
    if (after <= before) throw new Error("OMP did not run a turn after /new");
    await waitFor(
      "reply after /new",
      (s) => s.calls.filter(
        (c) => (c.method === "sendMessage" || c.method === "editMessageText")
          && String(c.body?.text ?? "").includes("MOCK_OK"),
      ).length >= 2,
    );
    record("turn still works after /new", true, "session capture reattached");
  } catch (error) {
    record("turn still works after /new", false, String(error.message).slice(0, 500));
  }

  // ── 8. Foreign cursor rewind ──────────────────────────────────────────
  killSession(SESSION);
  await controlPost("/_control/reset");
  writeFileSync(provLog, "");
  const rewindPrompt = "reply with MOCK_OK";
  await controlPost("/_control/inject", {
    updates: [{
      update_id: REWIND_UPDATE_ID,
      message: {
        message_id: 9104,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: "private" },
        from: { id: USER_ID, is_bot: false, first_name: "E2E" },
        text: rewindPrompt,
      },
    }],
  });
  const bindingPath = join(projectDir, ".pi", "telegram.json");
  const cursorPath = join(agentDir, "tg-runtime", TOKEN_HASH, "cursor.json");
  writeFileSync(
    bindingPath,
    JSON.stringify({ ...JSON.parse(readFileSync(bindingPath, "utf8")), lastUpdateId: POISONED_CURSOR }, null, 2) + "\n",
  );
  const restart = startPlugin(join(runDir, "pane-rewind.log"));
  record("restart with a foreign lastUpdateId", restart.status === 0, `lastUpdateId=${POISONED_CURSOR}`);

  try {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let binding;
    let cursor;
    let turns = [];
    while (Date.now() < deadline) {
      try {
        binding = JSON.parse(readFileSync(bindingPath, "utf8")).lastUpdateId;
      } catch {
        binding = undefined;
      }
      if (existsSync(cursorPath)) cursor = JSON.parse(readFileSync(cursorPath, "utf8")).updateId;
      turns = providerLog().filter((entry) => (entry.prompt?.includes(rewindPrompt) || entry.userText?.includes(rewindPrompt)));
      if (binding === REWIND_UPDATE_ID && cursor === REWIND_UPDATE_ID && turns.length === 1) break;
      await sleep(500);
    }
    record("backlog below the foreign cursor was delivered exactly once", turns.length === 1, `agent turns=${turns.length}`);
    record(
      "both cursors rewound to the delivered update",
      binding === REWIND_UPDATE_ID && cursor === REWIND_UPDATE_ID,
      `binding=${binding} cursor=${cursor}`,
    );
  } catch (error) {
    record("foreign cursor rewind", false, String(error.message).slice(0, 500));
  }

  try {
    const logsDir = join(agentDir, "logs");
    const logFile = existsSync(logsDir)
      ? readdirSync(logsDir).filter((name) => name.startsWith("pi-telegram-plus-")).sort().pop()
      : undefined;
    const text = logFile ? readFileSync(join(logsDir, logFile), "utf8") : "";
    record(
      "rewind is reported in the plugin log",
      text.includes("poll cursor is ahead of the update stream"),
      logFile ?? "no log file",
    );
  } catch (error) {
    record("rewind is reported in the plugin log", false, String(error.message).slice(0, 500));
  }

  killSession(SESSION);

  const failed = steps.filter((s) => !s.ok);
  if (failed.length > 0 && existsSync(paneLog)) {
    console.log(`\n--- tmux pane (last 40 lines) ---`);
    console.log(readFileSync(paneLog, "utf8").split("\n").slice(-40).join("\n"));
  }

  const ok = failed.length === 0;
  if (!KEEP) removeQuietly(runDir);
  return { steps, ok, paneLog, tgLog };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "provider.jsonl"), "");
  writeFileSync(join(ROOT, "telegram.jsonl"), "");

  // A leftover run holding these ports would silently steal the injected updates: this
  // suite would then read another host's chat. Fail with a name.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive - kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }

  console.log("pi-telegram-plus OMP E2E acceptance");
  console.log(`  repo:    ${REPO}`);
  console.log(`  root:    ${ROOT}`);
  console.log(`  omp:     ${OMP_CLI}`);
  console.log(`  plugin:  ${PLUGIN_ENTRY}\n`);

  const tg = startServer("mock-telegram", "mock-telegram.mjs", [
    "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl"),
  ]);
  const prov = startServer("mock-provider", "mock-provider.mjs", [
    "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"),
  ]);
  await sleep(1200);
  if (!tg.getOutput().includes("MOCK_TELEGRAM_READY")) throw new Error(`mock telegram failed:\n${tg.getOutput()}`);
  if (!prov.getOutput().includes("MOCK_PROVIDER_READY")) throw new Error(`mock provider failed:\n${prov.getOutput()}`);
  console.log("mocks ready: telegram + provider\n");

  let result;
  try {
    console.log(`=== OMP ===`);
    result = await runAcceptance();
  } finally {
    tg.proc.kill();
    prov.proc.kill();
    killSession(SESSION);
  }

  writeFileSync(join(ROOT, "e2e-report.json"), JSON.stringify(result, null, 2) + "\n");
  console.log("=== E2E summary ===");
  console.log(`${result.ok ? "✓" : "✗"} OMP`);
  if (!result.ok) {
    const failed = result.steps.filter((step) => !step.ok);
    console.log(`\n${failed.length}/${result.steps.length} checks FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nE2E_EXIT=0 (${result.steps.length}/${result.steps.length} checks passed)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
