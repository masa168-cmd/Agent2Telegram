/**
 * Polling-failure classification and notification gating.
 *
 * The polling loop retries with exponential backoff (1s → 30s) and reports
 * every failure to `onError`. Sending one chat message per failure turns a
 * 15-minute network outage into dozens of identical "Telegram polling failed"
 * messages — and each notice send itself retries, so a flaky connection can
 * also duplicate them. The gate below collapses an outage into one notice,
 * re-notifies only when the failure class changes or a long cooldown expires,
 * and emits a single "restored" notice when polling recovers.
 *
 * `processing` failures (an update handler or the cursor persist threw) are
 * not connectivity outages: they get their own cooldown and never produce a
 * "restored" message.
 */

export type PollingFailureKind =
  | "network"
  | "auth"
  | "conflict"
  | "flood"
  | "server"
  | "processing"
  | "unknown";

/** Do not announce an outage shorter than this: the 1s/2s/4s backoff retries
 *  usually recover from a single blip without user-visible noise. */
export const OUTAGE_NOTICE_DELAY_MS = 30_000;

/** Re-notify about the same failure class at most this often. */
export const POLLING_NOTICE_COOLDOWN_MS = 30 * 60_000;

export type ClassifiedPollingError = {
  kind: PollingFailureKind;
  /** Short, user-facing phrase for the failure class. */
  label: string;
};

const NETWORK_PATTERN = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|EPIPE|socket|fetch failed|Unable to connect|network error/i;
const AUTH_PATTERN = /Unauthorized|invalid token|401/i;
const CONFLICT_PATTERN = /Conflict|terminated by other|409/i;
const FLOOD_PATTERN = /Too Many Requests|429|retry after/i;
const SERVER_PATTERN = /Bad Gateway|Internal Server Error|Service Unavailable|Gateway Timeout|50[234]/i;

/**
 * Classify an error reported by the polling loop. `processing` comes from the
 * update-batch context, not from the message text, so a handler that throws
 * "fetch failed" is not misreported as a connectivity outage.
 */
export function classifyPollingError(error: unknown, processing = false): ClassifiedPollingError {
  if (processing) return { kind: "processing", label: "update processing failed" };
  const message = error instanceof Error ? error.message : String(error);
  if (CONFLICT_PATTERN.test(message)) return { kind: "conflict", label: "polling conflict (another instance is polling this bot)" };
  if (AUTH_PATTERN.test(message)) return { kind: "auth", label: "authentication failed" };
  if (FLOOD_PATTERN.test(message)) return { kind: "flood", label: "Telegram rate limit" };
  if (NETWORK_PATTERN.test(message)) return { kind: "network", label: "network unreachable" };
  if (SERVER_PATTERN.test(message)) return { kind: "server", label: "Telegram server error" };
  return { kind: "unknown", label: "polling failed" };
}

/**
 * Stateful gate: decides whether a failure should be announced in the chat.
 * Pure apart from the caller-supplied `now`, so it is trivially testable.
 */
export class PollingNoticeGate {
  private offlineSince: number | undefined;
  private offlineNotified = false;
  private offlineKind: PollingFailureKind | undefined;
  private offlineNotifiedAt = 0;
  private processingKind: PollingFailureKind | undefined;
  private processingNotifiedAt = 0;

  constructor(
    private readonly outageDelayMs = OUTAGE_NOTICE_DELAY_MS,
    private readonly cooldownMs = POLLING_NOTICE_COOLDOWN_MS,
  ) {}

  /**
   * Record a failure. Returns true when the caller should send a notice.
   * Processing failures during an active outage are suppressed: connectivity
   * is the dominating problem and the recovery notice covers the episode.
   */
  failure(kind: PollingFailureKind, now: number): boolean {
    if (kind === "processing") {
      if (this.offlineSince !== undefined) return false;
      if (this.processingKind === kind && now - this.processingNotifiedAt < this.cooldownMs) return false;
      this.processingKind = kind;
      this.processingNotifiedAt = now;
      return true;
    }

    if (this.offlineSince === undefined) this.offlineSince = now;
    if (now - this.offlineSince < this.outageDelayMs) return false;

    const first = !this.offlineNotified;
    const changedKind = this.offlineKind !== kind;
    const cooledDown = now - this.offlineNotifiedAt >= this.cooldownMs;
    if (!first && !changedKind && !cooledDown) return false;

    this.offlineNotified = true;
    this.offlineKind = kind;
    this.offlineNotifiedAt = now;
    return true;
  }

  /**
   * Record a successful poll. Returns true when the caller should announce
   * recovery — only if this episode was long enough to have been announced.
   */
  success(): boolean {
    const announce = this.offlineNotified;
    this.offlineSince = undefined;
    this.offlineNotified = false;
    this.offlineKind = undefined;
    this.offlineNotifiedAt = 0;
    return announce;
  }
}
