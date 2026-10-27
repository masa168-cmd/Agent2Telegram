import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Session-wide extension metadata, never model context or a Telegram token. */
export const FORUM_BINDING_TYPE = "pi-telegram-plus-ex.forum-binding";
export type ForumBinding = {
  version: 1;
  botId: string;
  chatId: number;
  sessionId: string;
  threadId: number | null;
  state?: "disconnected" | "topic-missing" | "create-unknown";
};
export type ForumTarget = {
  botId: string;
  chatId: number;
  sessionId: string;
  threadId: number;
  /** A fresh nonce for every runtime/navigation; never inherited by a fork. */
  generation: string;
};

export function isForumChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

export function parseForumBinding(value: unknown): ForumBinding | undefined {
  if (!value || typeof value !== "object") return;
  const b = value as Partial<ForumBinding>;
  if (b.version !== 1 || typeof b.botId !== "string" || !b.botId.trim()
    || typeof b.sessionId !== "string" || !b.sessionId.trim() || !isForumChatId(b.chatId)
    || !(b.threadId === null || (Number.isSafeInteger(b.threadId) && b.threadId! > 0))) return;
  if (b.state !== undefined && (b.threadId !== null
    || !["disconnected", "topic-missing", "create-unknown"].includes(b.state))) return;
  return { version: 1, botId: b.botId, chatId: b.chatId, sessionId: b.sessionId,
    threadId: b.threadId!, ...(b.state === undefined ? {} : { state: b.state }) };
}

/** Binding is session-wide, not branch-sensitive. Copied fork/clone entries do not match. */
export function readForumBinding(
  entries: readonly unknown[], botId: string, chatId: number, sessionId: string,
): ForumBinding | undefined {
  let result: ForumBinding | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: string; customType?: string; data?: unknown };
    if (e.type !== "custom" || e.customType !== FORUM_BINDING_TYPE) continue;
    const b = parseForumBinding(e.data);
    if (b?.botId === botId && b.chatId === chatId && b.sessionId === sessionId) result = b;
  }
  return result;
}

/** Pi flushes a blank session's custom entries with its first conversation message. */
export function appendForumBinding(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  binding: ForumBinding,
): void {
  const b = parseForumBinding(binding);
  if (!b || b.sessionId !== ctx.sessionManager.getSessionId()) throw new Error("Invalid or obsolete forum binding");
  pi.appendEntry(FORUM_BINDING_TYPE, b);
  const saved = readForumBinding(ctx.sessionManager.getEntries(), b.botId, b.chatId, b.sessionId);
  if (JSON.stringify(saved) !== JSON.stringify(b)) throw new Error("Forum binding was not retained by Pi");
}

export function sameForumTarget(a: ForumTarget | undefined, b: ForumTarget | undefined): boolean {
  return !!a && !!b && a.botId === b.botId && a.chatId === b.chatId && a.sessionId === b.sessionId
    && a.threadId === b.threadId && a.generation === b.generation;
}

export function forumTopicLink(chatId: number, threadId: number): string | undefined {
  const id = String(chatId);
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${threadId}` : undefined;
}
