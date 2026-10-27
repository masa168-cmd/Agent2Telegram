#!/usr/bin/env node
/**
 * Real Bot API smoke: prove the payloads the plugin sends are accepted by
 * api.telegram.org, not just by the mock.
 *
 * Sends one temporary message (HTML mirror shape + inline keyboard), edits it
 * the way a mirror refresh does, then deletes it. Also checks the negative
 * control: an unsupported tag must be rejected with 400, otherwise the test
 * would not be able to detect contract violations at all.
 *
 * Token/chat: PITG_REAL_TOKEN / PITG_REAL_CHAT, else the pi agent config
 * (botToken + allowedUserId).
 *
 * Usage: node scripts/e2e/real-telegram-smoke.mjs
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const API = "https://api.telegram.org";
const RESULTS = [];
const record = (name, ok, detail = "") => {
  RESULTS.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function loadCredentials() {
  if (process.env.PITG_REAL_TOKEN && process.env.PITG_REAL_CHAT) {
    return { token: process.env.PITG_REAL_TOKEN, chatId: Number(process.env.PITG_REAL_CHAT) };
  }
  const candidates = [
    process.env.PITG_REAL_CONFIG,
    `${homedir()}/.omp/agent/telegram.json`,
    `${homedir()}/.pi/agent/telegram.json`,
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const config = JSON.parse(readFileSync(path, "utf8"));
      if (config.botToken && config.allowedUserId) {
        return { token: config.botToken, chatId: Number(config.allowedUserId) };
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

async function call(token, method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function main() {
  const credentials = loadCredentials();
  if (!credentials) {
    console.log("SKIP real Bot API smoke: no botToken/allowedUserId found");
    return;
  }
  const { token, chatId } = credentials;

  const me = await call(token, "getMe", {});
  record("real getMe", me.ok === true, me.ok ? `@${me.result.username}` : `${me.status} ${me.description ?? ""}`.trim());
  if (!me.ok) return;

  // Same shape the mirror sends: <b> title, escaped <pre> body, tg callbacks.
  const mirror = [
    "<b>pi-telegram-plus contract check</b>",
    `<pre>${escapeHtml("Login to OpenRouter\nhttps://openrouter.ai/auth?x=1&y=2\n> code")}</pre>`,
    "<i>temporary message, deleted right away</i>",
  ].join("\n");
  const keyboard = {
    inline_keyboard: [
      [{ text: "↑", callback_data: "tgplus:tui:key:up" }, { text: "⏎ Enter", callback_data: "tgplus:tui:key:enter" }],
      [{ text: "Open", url: "https://core.telegram.org/bots/api" }],
      [{ text: "Close", callback_data: "tgplus:tui:close" }],
    ],
  };

  const sent = await call(token, "sendMessage", {
    chat_id: chatId, text: mirror, parse_mode: "HTML", reply_markup: keyboard, disable_web_page_preview: true,
  });
  record(
    "real sendMessage (HTML + inline keyboard)",
    sent.ok === true,
    sent.ok ? `message_id ${sent.result.message_id}` : `${sent.status} ${sent.description ?? ""}`.trim(),
  );
  if (!sent.ok) return;

  const messageId = sent.result.message_id;
  try {
    const edited = await call(token, "editMessageText", {
      chat_id: chatId, message_id: messageId, text: `${mirror}\n<i>edited</i>`, parse_mode: "HTML", reply_markup: keyboard,
    });
    record("real editMessageText", edited.ok === true, edited.ok ? "ok" : `${edited.status} ${edited.description ?? ""}`.trim());

    // Negative control: the mock accepts this, the real API must reject it.
    const rejected = await call(token, "sendMessage", {
      chat_id: chatId, text: "<foo>unsupported</foo>", parse_mode: "HTML",
    });
    record("real API rejects unsupported tag", rejected.ok === false && rejected.status === 400,
      `${rejected.status} ${rejected.description ?? ""}`.trim());

    // And our strict validator must flag the same payload.
    const { validateTelegramCall } = await import("./telegram-contract.mjs");
    const violations = validateTelegramCall({
      method: "sendMessage",
      body: { text: "<foo>unsupported</foo>", parse_mode: "HTML" },
    });
    record("validator matches the real rejection", violations.length > 0, violations.join(" | ").slice(0, 160));
  } finally {
    const deleted = await call(token, "deleteMessage", { chat_id: chatId, message_id: messageId });
    record("real deleteMessage (cleanup)", deleted.ok === true, deleted.ok ? "ok" : `${deleted.status} ${deleted.description ?? ""}`.trim());
  }

  const failed = RESULTS.filter((result) => !result.ok);
  console.log(failed.length === 0 ? "REAL_API_EXIT=0" : `REAL_API_EXIT=1 (${failed.length} failed)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
