import { randomInt } from "node:crypto";
import type { TelegramConfig } from "./types.ts";

/** A pairing code is valid for 10 minutes after it is created. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Wrong `/pair` attempts allowed before the current code is invalidated. */
export const PAIRING_MAX_FAILURES = 5;

export type TelegramAuthorizationDecision = {
  authorized: boolean;
  paired: boolean;
  config: TelegramConfig;
  /** Wrong attempts counted against the current code after this decision. */
  failures: number;
  /** The current code was dropped (expired or too many wrong attempts). */
  invalidated: boolean;
};

export type TelegramAuthorizationContext = {
  /** Telegram `chat.type` of the message; `/pair` is accepted only in "private". */
  chatType?: string;
  now?: number;
  /** Wrong attempts already counted against the current code. */
  failures?: number;
};

export function createTelegramPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function pairingCodeExpiry(now = Date.now()): number {
  return now + PAIRING_CODE_TTL_MS;
}

/** Codes without an expiry (created before expiry existed) count as expired. */
export function isPairingCodeExpired(config: TelegramConfig, now = Date.now()): boolean {
  return typeof config.pairingCodeExpiresAt !== "number" || now >= config.pairingCodeExpiresAt;
}

function withoutPairingCode(config: TelegramConfig): TelegramConfig {
  const { pairingCode: _code, pairingCodeExpiresAt: _expiresAt, ...rest } = config;
  return rest;
}

export function ensureTelegramPairingCode(config: TelegramConfig, now = Date.now()): TelegramConfig {
  if (config.allowedUserId !== undefined) {
    return config.pairingCode === undefined && config.pairingCodeExpiresAt === undefined
      ? config : withoutPairingCode(config);
  }
  if (config.pairingCode && !isPairingCodeExpired(config, now)) return config;
  return { ...config, pairingCode: createTelegramPairingCode(), pairingCodeExpiresAt: pairingCodeExpiry(now) };
}

export function extractTelegramPairingCode(text: string | undefined, botUsername?: string): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^\/pair(?:@([A-Za-z0-9_]+))?\s+([A-Za-z0-9_-]+)$/i);
  if (!match) return undefined;
  const addressedBot = match[1];
  if (addressedBot && botUsername && addressedBot.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return match[2];
}

export function authorizeTelegramUser(
  config: TelegramConfig,
  userId: number | undefined,
  text?: string,
  botUsername?: string,
  context: TelegramAuthorizationContext = {},
): TelegramAuthorizationDecision {
  const failures = context.failures ?? 0;
  const reject = (next = config, count = failures, invalidated = false): TelegramAuthorizationDecision =>
    ({ authorized: false, paired: false, config: next, failures: count, invalidated });
  if (userId === undefined) return reject();
  if (config.allowedUserId !== undefined) {
    return { authorized: config.allowedUserId === userId, paired: false, config, failures, invalidated: false };
  }
  const pairingCode = extractTelegramPairingCode(text, botUsername);
  if (pairingCode === undefined || context.chatType !== "private" || !config.pairingCode) return reject();
  if (isPairingCodeExpired(config, context.now ?? Date.now())) return reject(withoutPairingCode(config), 0, true);
  if (pairingCode === config.pairingCode) {
    return { authorized: true, paired: true, config: { ...withoutPairingCode(config), allowedUserId: userId }, failures: 0, invalidated: false };
  }
  const count = failures + 1;
  return count >= PAIRING_MAX_FAILURES ? reject(withoutPairingCode(config), 0, true) : reject(config, count);
}

export function formatPairingInstructions(config: TelegramConfig, now = Date.now()): string {
  if (config.allowedUserId !== undefined) return "Telegram user is already paired.";
  if (!config.pairingCode) return "Telegram pairing is required, but no pairing code is available. Generate one via /tg → Bots.";
  if (isPairingCodeExpired(config, now)) return "Telegram pairing code has expired. Generate a new one via /tg → Bots.";
  const minutes = Math.max(1, Math.ceil((config.pairingCodeExpiresAt! - now) / 60_000));
  return `Telegram pairing required. Send this message to the bot in a private chat from your Telegram account (valid for ${minutes} min, ${PAIRING_MAX_FAILURES} wrong attempts cancel it):\n/pair ${config.pairingCode}`;
}
