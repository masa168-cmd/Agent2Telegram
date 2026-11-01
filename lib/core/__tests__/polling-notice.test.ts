import { describe, expect, it } from "vitest";
import {
  OUTAGE_NOTICE_DELAY_MS,
  POLLING_NOTICE_COOLDOWN_MS,
  PollingNoticeGate,
  classifyPollingError,
} from "../polling-notice.ts";

describe("classifyPollingError", () => {
  it("classifies transport failures", () => {
    expect(classifyPollingError(new Error("Telegram API request failed: ECONNRESET: socket closed")).kind).toBe("network");
    expect(classifyPollingError(new Error("getaddrinfo ENOTFOUND api.telegram.org")).kind).toBe("network");
    expect(classifyPollingError(new Error("Conflict: terminated by other getUpdates request")).kind).toBe("conflict");
    expect(classifyPollingError(new Error("Unauthorized: invalid token specified")).kind).toBe("auth");
    expect(classifyPollingError(new Error("Too Many Requests: retry after 8")).kind).toBe("flood");
    expect(classifyPollingError(new Error("Bad Gateway")).kind).toBe("server");
    expect(classifyPollingError(new Error("something odd")).kind).toBe("unknown");
  });

  it("processing context wins over message text", () => {
    // A handler that throws a network-looking message is still a processing
    // failure, not an outage.
    expect(classifyPollingError(new Error("fetch failed"), true).kind).toBe("processing");
  });
});

describe("PollingNoticeGate", () => {
  it("ignores a blip shorter than the debounce", () => {
    const gate = new PollingNoticeGate();
    expect(gate.failure("network", 0)).toBe(false);
    expect(gate.failure("network", 5_000)).toBe(false);
    expect(gate.success()).toBe(false);
  });

  it("announces a sustained outage once, then recovery once", () => {
    const gate = new PollingNoticeGate();
    expect(gate.failure("network", 0)).toBe(false);
    expect(gate.failure("network", OUTAGE_NOTICE_DELAY_MS)).toBe(true);
    // Same class inside the cooldown stays quiet.
    expect(gate.failure("network", OUTAGE_NOTICE_DELAY_MS + 30_000)).toBe(false);
    // Cooldown expiry allows one reminder.
    expect(gate.failure("network", OUTAGE_NOTICE_DELAY_MS + POLLING_NOTICE_COOLDOWN_MS)).toBe(true);
    expect(gate.success()).toBe(true);
    // Recovery is announced only once.
    expect(gate.success()).toBe(false);
  });

  it("re-notifies when the failure class changes", () => {
    const gate = new PollingNoticeGate();
    expect(gate.failure("network", 0)).toBe(false);
    expect(gate.failure("network", OUTAGE_NOTICE_DELAY_MS)).toBe(true);
    expect(gate.failure("auth", OUTAGE_NOTICE_DELAY_MS + 1_000)).toBe(true);
    expect(gate.failure("auth", OUTAGE_NOTICE_DELAY_MS + 2_000)).toBe(false);
  });

  it("treats processing failures separately from outages", () => {
    const gate = new PollingNoticeGate();
    expect(gate.failure("processing", 0)).toBe(true);
    expect(gate.failure("processing", 1_000)).toBe(false);
    expect(gate.success()).toBe(false); // no outage was announced
    expect(gate.failure("processing", POLLING_NOTICE_COOLDOWN_MS)).toBe(true);
  });

  it("suppresses processing failures while an outage is active", () => {
    const gate = new PollingNoticeGate();
    expect(gate.failure("network", 0)).toBe(false);
    expect(gate.failure("network", OUTAGE_NOTICE_DELAY_MS)).toBe(true);
    expect(gate.failure("processing", OUTAGE_NOTICE_DELAY_MS + 1_000)).toBe(false);
    expect(gate.success()).toBe(true);
  });
});
