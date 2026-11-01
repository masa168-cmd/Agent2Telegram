import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILURES,
  authorizeTelegramUser,
  ensureTelegramPairingCode,
  extractTelegramPairingCode,
  formatPairingInstructions,
} from "../pairing.ts";

const NOW = 1_800_000_000_000;
const live = { botToken: "token", pairingCode: "123456", pairingCodeExpiresAt: NOW + PAIRING_CODE_TTL_MS };
const priv = { chatType: "private", now: NOW };

describe("Telegram pairing", () => {
  it("does not auto-authorize the first user when no allowedUserId is configured", () => {
    const decision = authorizeTelegramUser(live, 42, "hello", "mybot", priv);

    expect(decision.authorized).toBe(false);
    expect(decision.paired).toBe(false);
    expect(decision.config).toBe(live);
    expect(decision.config).not.toHaveProperty("allowedUserId");
  });

  it("authorizes a user with the one-time pairing code in a private chat and removes the code", () => {
    const decision = authorizeTelegramUser(live, 42, "/pair 123456", "mybot", priv);

    expect(decision.authorized).toBe(true);
    expect(decision.paired).toBe(true);
    expect(decision.config.allowedUserId).toBe(42);
    expect(decision.config.pairingCode).toBeUndefined();
    expect(decision.config.pairingCodeExpiresAt).toBeUndefined();
  });

  it("rejects the correct code outside a private chat without counting a failure", () => {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      const decision = authorizeTelegramUser(live, 42, "/pair 123456", "mybot", { chatType, now: NOW });
      expect(decision.authorized).toBe(false);
      expect(decision.failures).toBe(0);
      expect(decision.config).toBe(live);
    }
  });

  it("rejects and drops an expired code", () => {
    const decision = authorizeTelegramUser(live, 42, "/pair 123456", "mybot",
      { chatType: "private", now: NOW + PAIRING_CODE_TTL_MS });

    expect(decision.authorized).toBe(false);
    expect(decision.invalidated).toBe(true);
    expect(decision.config.pairingCode).toBeUndefined();
  });

  it("treats a stored code without expiry (older config) as expired", () => {
    const decision = authorizeTelegramUser({ botToken: "token", pairingCode: "123456" }, 42, "/pair 123456", "mybot", priv);

    expect(decision.authorized).toBe(false);
    expect(decision.invalidated).toBe(true);
  });

  it("drops the code after the maximum number of wrong attempts", () => {
    let failures = 0;
    for (let i = 1; i < PAIRING_MAX_FAILURES; i++) {
      const d = authorizeTelegramUser(live, 42, "/pair 000000", "mybot", { ...priv, failures });
      expect(d.authorized).toBe(false);
      expect(d.invalidated).toBe(false);
      expect(d.failures).toBe(i);
      failures = d.failures;
    }
    const last = authorizeTelegramUser(live, 42, "/pair 000000", "mybot", { ...priv, failures });
    expect(last.invalidated).toBe(true);
    expect(last.config.pairingCode).toBeUndefined();
    // Even the right code no longer works once dropped.
    expect(authorizeTelegramUser(last.config, 42, "/pair 123456", "mybot", priv).authorized).toBe(false);
  });

  it("does not count ordinary messages as wrong attempts", () => {
    expect(authorizeTelegramUser(live, 42, "hello", "mybot", { ...priv, failures: 2 }).failures).toBe(2);
  });

  it("keeps rejecting other users after pairing", () => {
    const config = { botToken: "token", allowedUserId: 42 };

    expect(authorizeTelegramUser(config, 42, "hello", "mybot").authorized).toBe(true);
    expect(authorizeTelegramUser(config, 99, "/pair 123456", "mybot", priv).authorized).toBe(false);
  });

  it("supports bot-addressed pair commands but ignores other bot usernames", () => {
    expect(extractTelegramPairingCode("/pair@MyBot 123456", "mybot")).toBe("123456");
    expect(extractTelegramPairingCode("/pair@OtherBot 123456", "mybot")).toBeUndefined();
  });

  it("generates a code with expiry only when no user is paired, and replaces an expired one", () => {
    const withCode = ensureTelegramPairingCode({ botToken: "token" }, NOW);
    expect(withCode.pairingCode).toMatch(/^\d{6}$/);
    expect(withCode.pairingCodeExpiresAt).toBe(NOW + PAIRING_CODE_TTL_MS);

    expect(ensureTelegramPairingCode(live, NOW)).toBe(live);
    const renewed = ensureTelegramPairingCode(live, NOW + PAIRING_CODE_TTL_MS + 1);
    expect(renewed.pairingCodeExpiresAt).toBe(NOW + 2 * PAIRING_CODE_TTL_MS + 1);

    const paired = ensureTelegramPairingCode({ botToken: "token", allowedUserId: 42, pairingCode: "123456", pairingCodeExpiresAt: NOW });
    expect(paired).toEqual({ botToken: "token", allowedUserId: 42 });
  });

  it("mentions private chat and remaining minutes, or says the code expired", () => {
    expect(formatPairingInstructions(live, NOW)).toContain("/pair 123456");
    expect(formatPairingInstructions(live, NOW)).toContain("private chat");
    expect(formatPairingInstructions(live, NOW)).toContain("10 min");
    expect(formatPairingInstructions(live, NOW + PAIRING_CODE_TTL_MS)).toContain("expired");
  });
});
