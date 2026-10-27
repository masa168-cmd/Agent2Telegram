import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000); timer.unref();
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function peer(root: string, id: string, thread: number) {
  let serial = 0; let stderr = "";
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const child = fork(new URL("./fixtures/forum-peer.mjs", import.meta.url), [], {
    execArgv: ["--loader", fileURLToPath(new URL("./fixtures/typescript-loader.mjs", import.meta.url)), "--no-warnings"],
    env: { ...process.env, FORUM_TEST_ROOT: root, FORUM_TEST_ID: id, FORUM_TEST_THREAD: String(thread) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Offline fixture startup timed out: ${stderr}`)), 8000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.on("message", (message: any) => {
      if (message.ready) { clearTimeout(timeout); resolve(); }
      if (message.reply) {
        const request = pending.get(message.reply); pending.delete(message.reply);
        if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout); const error = new Error(`Offline fixture exited (${code ?? signal}): ${stderr}`);
      reject(error); for (const request of pending.values()) request.reject(error); pending.clear();
    });
  });
  const request = (action: string, update?: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (!child.connected) { reject(new Error("Offline fixture is closed")); return; }
    const n = ++serial;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Offline fixture ${action} timed out`)); }, 6000);
    pending.set(n, { resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    child.send({ request: n, action, update });
  });
  return { child, request };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "forum-two-processes-")); roots.push(root);
  const a = await peer(root, "a", 11); const b = await peer(root, "b", 22);
  await a.request("reconcile"); await b.request("reconcile");
  return { a, b };
}
const message = (update_id: number, thread: number, text: string, user = 7, chat = -100123) => ({ update_id,
  message: { message_id: 10_000 + update_id, message_thread_id: thread,
    chat: { id: chat, type: "supergroup" }, from: { id: user }, text } });

describe("two independent offline Node peers (no Pi process, Bot or model)", () => {
  it("isolates prompts, controls, files, streamed edits and threadless callbacks under one receiver", async () => {
    const { a, b } = await setup();
    expect((await a.request("state")).active).toBe(true); expect((await b.request("state")).active).toBe(false);
    expect((await a.request("dispatch", message(1, 11, "alpha"))).accepted).toBe(true);
    expect((await a.request("dispatch", message(2, 22, "beta"))).accepted).toBe(true);
    await vi.waitFor(async () => {
      expect((await a.request("state")).prompts).toEqual(["alpha"]);
      const s = await b.request("state"); expect(s.prompts).toEqual(["beta"]);
      expect(s.outputs.some((o: any) => o.kind === "edit" && o.text.includes("reply-b:beta"))).toBe(true);
    });
    expect((await a.request("dispatch", message(2, 22, "beta"))).duplicate).toBe(true);
    expect((await a.request("dispatch", message(3, 22, "wrong-user", 8))).accepted).toBe(false);
    expect((await a.request("dispatch", message(4, 22, "wrong-group", 7, -100999))).accepted).toBe(false);
    await a.request("dispatch", message(5, 22, "/model fake-b-model"));
    await a.request("dispatch", message(6, 11, "/thinking high"));
    await a.request("dispatch", message(7, 22, "/compact"));
    await a.request("dispatch", message(8, 11, "/attachment"));
    await a.request("dispatch", message(9, 22, "/attachment"));
    await vi.waitFor(async () => {
      const sa = await a.request("state"); const sb = await b.request("state");
      expect(sa.thinking).toBe("high"); expect(sb.thinking).toBe("medium");
      expect(sb.model).toBe("fake-b-model"); expect(sa.model).toBe("fake-initial");
      expect(sb.compactions).toBe(1); expect(sa.compactions).toBe(0);
      expect(sa.outputs.some((o: any) => o.kind === "document")).toBe(true);
      expect(sb.outputs.some((o: any) => o.kind === "document")).toBe(true);
    });
    await a.request("dispatch", message(10, 22, "/ask"));
    let button: any;
    await vi.waitFor(async () => { button = (await b.request("state")).outputs.find((o: any) => o.kind === "buttons"); expect(button).toBeDefined(); });
    await b.request("reconcile"); await a.request("reconcile");
    const blue = button.rows.flat().find((v: any) => v.text === "blue").value;
    const callback = { update_id: 11, callback_query: { id: "blue-callback", from: { id: 7 }, data: blue,
      message: { message_id: button.message_id, chat: { id: -100123 } } } };
    expect((await a.request("dispatch", callback)).accepted).toBe(true);
    await vi.waitFor(async () => expect((await b.request("state")).lastAnswer).toBe("blue"));
    expect((await a.request("state")).lastAnswer).toBeUndefined();
    const cross = { ...callback, update_id: 12, callback_query: { ...callback.callback_query, id: "wrong-topic",
      message: { ...callback.callback_query.message, message_thread_id: 11 } } };
    expect((await a.request("dispatch", cross)).accepted).toBe(false);
    await b.request("reload"); await a.request("reconcile");
    expect((await a.request("dispatch", { ...callback, update_id: 13, callback_query: { ...callback.callback_query,
      id: "expired", message: { ...callback.callback_query.message, message_thread_id: 22 } } })).accepted).toBe(false);
    await a.request("dispatch", message(14, 22, "wait"));
    await vi.waitFor(async () => expect((await b.request("state")).streaming).toBe(true));
    await a.request("dispatch", message(15, 22, "/stop"));
    await vi.waitFor(async () => expect((await b.request("state")).aborts).toBe(1));
    expect((await a.request("state")).aborts).toBe(0);
    for (const [peer, thread] of [[a, 11], [b, 22]] as const) {
      const state = await peer.request("state");
      expect(state.outputs.length).toBeGreaterThan(0);
      expect(state.outputs.every((o: any) => o.chat === -100123 && o.thread === thread)).toBe(true);
    }
  }, 25_000);

  it("re-elects the remaining receiver after a fixture crash, leaves the old topic offline and never starts a new Pi", async () => {
    const { a, b } = await setup(); const first = (await a.request("state")).leader;
    await new Promise<void>(resolve => { a.child.once("exit", () => resolve()); a.child.kill("SIGKILL"); });
    await vi.waitFor(async () => expect((await b.request("reconcile")).active).toBe(true));
    const second = (await b.request("state")).leader;
    expect(second.instanceId).toBe("b"); expect(second.generation).toBeGreaterThan(first.generation);
    expect((await b.request("dispatch", message(20, 11, "offline topic must not start"))).accepted).toBe(false);
    expect((await b.request("dispatch", message(21, 22, "still-online"))).accepted).toBe(true);
    await vi.waitFor(async () => expect((await b.request("state")).prompts).toEqual(["still-online"]));
    expect(children).toHaveLength(2);
  }, 20_000);
});
