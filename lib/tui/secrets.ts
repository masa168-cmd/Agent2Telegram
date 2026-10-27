/**
 * Secrets never land in logs or Telegram history (§4.7.4). Values typed into a
 * secret input are remembered per chat while the flow that asked for them is
 * open, and every outgoing text is redacted *before* it is converted to HTML —
 * the transport layer never substitutes.
 *
 * Two deliberate limits: strings shorter than 8 characters are not tracked (a
 * global `b` → `***` would wreck normal prose), and entries expire after 24
 * hours or when the chat starts a new session.
 */

const MAX_PER_CHAT = 16;
const MIN_LENGTH = 8;
const TTL_MS = 24 * 60 * 60 * 1000;

type Entry = { value: string; at: number };

export class SecretStore {
  /** chatKey (`chatId` or `chatId:threadId`) -> flowId -> value. */
  private readonly byChat = new Map<string, Map<string, Entry>>();

  remember(chatKey: string, flowId: string, value: string): void {
    if (!chatKey || !flowId || !value) return;
    if (value.length < MIN_LENGTH) return;
    let bucket = this.byChat.get(chatKey);
    if (!bucket) {
      bucket = new Map();
      this.byChat.set(chatKey, bucket);
    }
    if (!bucket.has(flowId) && bucket.size >= MAX_PER_CHAT) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }
    bucket.set(flowId, { value, at: Date.now() });
  }

  /** One-shot: after `take` the value stops being tracked. */
  take(chatKey: string, flowId: string): string | undefined {
    const entry = this.byChat.get(chatKey)?.get(flowId);
    if (entry === undefined) return undefined;
    this.byChat.get(chatKey)?.delete(flowId);
    return entry.value;
  }

  forget(chatKey: string, flowId: string): void {
    this.byChat.get(chatKey)?.delete(flowId);
  }

  /** `/new` and chat teardown drop everything tracked for that chat. */
  clearChat(chatKey: string): void {
    this.byChat.delete(chatKey);
  }

  /** A new session (/new, session switch) forgets every chat's secrets. */
  clearAll(): void {
    this.byChat.clear();
  }

  /** Replace every tracked secret with `***` (longest first, so prefixes lose). */
  redact(chatKey: string, text: string): string {
    if (!text) return text;
    const bucket = this.byChat.get(chatKey);
    if (!bucket || bucket.size === 0) return text;
    const now = Date.now();
    const values: string[] = [];
    for (const [flowId, entry] of bucket) {
      if (now - entry.at > TTL_MS) {
        bucket.delete(flowId);
        continue;
      }
      values.push(entry.value);
    }
    let out = text;
    for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join("***");
    }
    return out;
  }
}
