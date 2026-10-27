import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { TelegramInstanceMetadata } from "./instance-coordinator.ts";
import type { ForumTarget } from "./forum-binding.ts";
import { isForumChatId } from "./forum-binding.ts";
import type { TelegramUpdate } from "./types.ts";

/** Published only in the coordinator's private (0700/0600) local heartbeat files. */
export type ForumRegistration = {
  botId: string;
  chatId: number;
  sessionId: string;
  threadId: number | null;
  generation: string;
  port: number;
  capability: string;
  /** Only button messages need missing-thread callback recovery. */
  messageIds?: number[];
};
export type ForumDelivery = {
  target: ForumTarget;
  leader: { instanceId: string; generation: number };
  update: TelegramUpdate;
};
export type ForumAdmission = { accepted: boolean; duplicate?: boolean; reason?: string };
const MAX_BODY = 256 * 1024;

export function validForumRegistration(value: unknown): value is ForumRegistration {
  if (!value || typeof value !== "object") return false;
  const r = value as ForumRegistration;
  return typeof r.botId === "string" && !!r.botId && isForumChatId(r.chatId)
    && typeof r.sessionId === "string" && !!r.sessionId
    && (r.threadId === null || (Number.isSafeInteger(r.threadId) && r.threadId > 0))
    && typeof r.generation === "string" && !!r.generation
    && Number.isSafeInteger(r.port) && r.port > 0 && r.port <= 65535
    && typeof r.capability === "string" && /^[\w-]{32,128}$/.test(r.capability)
    && (r.messageIds === undefined || (Array.isArray(r.messageIds) && r.messageIds.length <= 256
      && r.messageIds.every(id => Number.isSafeInteger(id) && id > 0)));
}

export function authorizedForumUpdate(update: TelegramUpdate, chatId: number, userId: number): boolean {
  const q = update?.callback_query;
  const m = q?.message ?? update?.message;
  const from = (q?.from ?? m?.from) as { id?: number; is_bot?: boolean } | undefined;
  return Number.isSafeInteger(update?.update_id) && update.update_id >= 0
    && m?.chat?.id === chatId && from?.id === userId && !from?.is_bot
    && Number.isSafeInteger(m?.message_id) && m!.message_id > 0
    && (!q || (typeof q.id === "string" && !!q.id && q.id.length <= 256));
}

/** Never resolve an old message using whichever session became active later. */
export function findForumRoute(
  update: TelegramUpdate, instances: readonly TelegramInstanceMetadata[],
  botId: string, chatId: number, userId: number,
): { instance: TelegramInstanceMetadata; target: ForumTarget; update: TelegramUpdate } | undefined {
  if (!authorizedForumUpdate(update, chatId, userId)) return;
  const q = update.callback_query;
  const m = q?.message ?? update.message!;
  const routes = instances.filter(i => validForumRegistration(i.forum)
    && i.forum.botId === botId && i.forum.chatId === chatId && i.forum.threadId !== null);
  const candidates = routes.filter(i => m!.message_thread_id !== undefined
    ? i.forum!.threadId === m!.message_thread_id
    : !!q && i.forum!.messageIds?.includes(m!.message_id));
  if (candidates.length !== 1) return; // no route or conflicting claims: fail closed
  const instance = candidates[0];
  const r = instance.forum!;
  const target: ForumTarget = { botId, chatId, sessionId: r.sessionId,
    threadId: r.threadId!, generation: r.generation };
  // Telegram can omit the thread on callbacks; only a recorded bot message restores it.
  const routed = q && m!.message_thread_id === undefined
    ? { ...update, callback_query: { ...q, message: { ...m!, message_thread_id: target.threadId } } }
    : update;
  return { instance, target, update: routed };
}

function parseDelivery(value: unknown): ForumDelivery | undefined {
  if (!value || typeof value !== "object") return;
  const d = value as ForumDelivery;
  const t = d.target;
  if (!t || !isForumChatId(t.chatId) || !Number.isSafeInteger(t.threadId) || t.threadId < 1
    || typeof t.botId !== "string" || !t.botId || typeof t.sessionId !== "string" || !t.sessionId
    || typeof t.generation !== "string" || !t.generation || !d.leader
    || typeof d.leader.instanceId !== "string" || !d.leader.instanceId
    || !Number.isSafeInteger(d.leader.generation) || d.leader.generation < 1
    || !Number.isSafeInteger(d.update?.update_id) || d.update.update_id < 0) return;
  return d;
}

/** A small in-process, loopback-only inbox, not a separate daemon or a Bot poller. */
export class ForumInbox {
  readonly capability = randomBytes(32).toString("base64url");
  private server?: Server;
  private closed = false;
  private inFlight = 0;
  private readonly seen: Set<string>;
  constructor(private readonly deps: {
    authorize(delivery: ForumDelivery): Promise<boolean>;
    onUpdate(delivery: ForumDelivery): Promise<void>;
    onError(error: unknown): void;
    seen?: Set<string>;
  }) { this.seen = deps.seen ?? new Set(); }

  async start(): Promise<number> {
    if (this.server || this.closed) throw new Error("Forum inbox already started or closed");
    const server = createServer((req, res) => {
      const reply = (status: number, result: ForumAdmission) => {
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify(result));
      };
      const provided = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this.capability}`);
      if (req.method !== "POST" || req.url !== "/update" || provided.length !== expected.length
        || !timingSafeEqual(provided, expected)) {
        req.resume(); reply(403, { accepted: false, reason: "Forbidden" }); return;
      }
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY) { reply(413, { accepted: false, reason: "Update too large" }); return; }
          chunks.push(Buffer.from(chunk));
        }
        const delivery = parseDelivery(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!delivery || this.closed || !await this.deps.authorize(delivery) || this.closed) {
          reply(409, { accepted: false, reason: "Obsolete or unauthorized forum target" }); return;
        }
        const key = `${delivery.target.botId}:${delivery.update.update_id}`;
        if (this.seen.has(key)) { reply(200, { accepted: true, duplicate: true }); return; }
        if (this.inFlight >= 128) { reply(429, { accepted: false, reason: "Forum inbox busy" }); return; }
        this.seen.add(key);
        if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
        this.inFlight++;
        // A picker can wait for a later update. ACK admission, not dialog completion.
        void Promise.resolve().then(() => this.deps.onUpdate(delivery))
          .catch(error => this.deps.onError(error)).finally(() => { this.inFlight--; });
        reply(200, { accepted: true });
      })().catch(error => {
        this.deps.onError(error);
        if (!res.headersSent) reply(400, { accepted: false, reason: "Malformed forum update" });
        else res.destroy();
      });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 3000;
    server.maxConnections = 16;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.on("error", error => this.deps.onError(error));
    server.unref();
    return (server.address() as { port: number }).port;
  }

  close(): void {
    this.closed = true;
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }
}

/** No automatic retry: a lost ACK cannot prove that a command did not execute. */
export async function deliverForumUpdate(
  route: ForumRegistration, delivery: ForumDelivery,
): Promise<ForumAdmission> {
  if (!validForumRegistration(route)) throw new Error("Invalid local forum endpoint");
  const body = JSON.stringify(delivery);
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error("Forum update too large");
  return await new Promise<ForumAdmission>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: route.port, method: "POST", path: "/update",
      headers: { authorization: `Bearer ${route.capability}`, "content-type": "application/json",
        "content-length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) res.destroy(new Error("Invalid forum admission response"));
        else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("Forum delivery result unknown; do not resend automatically")));
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ForumAdmission;
          if (typeof result.accepted !== "boolean") throw new Error("Invalid admission");
          resolve(result);
        } catch { reject(new Error("Forum delivery result unknown; do not resend automatically")); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("Forum delivery timed out")));
    req.on("error", () => reject(new Error("Forum delivery result unknown; do not resend automatically")));
    req.end(body);
  });
}
