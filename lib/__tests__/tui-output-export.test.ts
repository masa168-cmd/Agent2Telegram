import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OutputCapture } from "../tui/output.ts";
import { OriginTracker } from "../tui/origin.ts";

type CaptureTransport = ConstructorParameters<typeof OutputCapture>[0];
type DocCall = {
  chatId: number;
  path: string;
  caption?: string;
  messageThreadId?: number;
  replyToMessageId?: number;
};

const dir = mkdtempSync(join(tmpdir(), "ptp-tui-export-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const docs: DocCall[] = [];
  const transport: CaptureTransport = {
    sendText: async () => [],
    editText: async () => undefined,
    sendDocument: vi.fn(async (
      chatId: number,
      path: string,
      caption?: string,
      _signal?: AbortSignal,
      messageThreadId?: number,
      replyToMessageId?: number,
    ) => {
      docs.push({ chatId, path, caption, messageThreadId, replyToMessageId });
    }),
  };
  const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
  const output = new OutputCapture(transport, origin);
  // `attach` is private; drive it directly like the gateway tests do.
  const capture = output as unknown as { attach(state: unknown): void };
  const attach = (state: unknown) => capture.attach(state);
  const bind = (label: string) => {
    const scope = origin.begin(
      { chatId: 42, messageThreadId: 7, sourceMessageId: 99 },
      label,
      `/${label}`,
      "",
    );
    output.bind(scope, { chatId: 42, messageThreadId: 7, messageId: 5, ackHtml: `<b>▶️ /${label}</b>` });
    return scope;
  };
  return { docs, origin, output, attach, bind };
}

/** A host session class: `exportToHtml` lives on the prototype, as in pi and OMP. */
function sessionClass(impl: (path?: string) => unknown, calls: { count: number }) {
  return class FakeAgentSession {
    exportToHtml(path?: string): unknown {
      calls.count += 1;
      return impl(path);
    }
  };
}

/** The wrapper sends from the export promise's continuation: draining the
 * microtask queue is the whole schedule (no wall-clock wait). */
const settle = () => Promise.resolve().then(() => undefined);

describe("OutputCapture /export file", () => {
  it("sends the exported file back inside an export scope", async () => {
    const file = join(dir, "session.html");
    writeFileSync(file, "<html>ok</html>");
    const calls = { count: 0 };
    const Ctor = sessionClass(() => Promise.resolve(file), calls);
    const { docs, output, attach, bind } = fixture();
    attach({ host: "pi", session: new Ctor() });
    bind("export");
    const session = new Ctor();
    await expect(session.exportToHtml()).resolves.toBe(file);
    await settle();
    expect(docs).toEqual([{
      chatId: 42,
      path: file,
      caption: "Session export",
      messageThreadId: 7,
      replyToMessageId: 99,
    }]);
    expect(calls.count).toBe(1);
  });

  it("sends nothing for a scope that is not /export", async () => {
    const file = join(dir, "share-tmp.html");
    writeFileSync(file, "<html>tmp</html>");
    const calls = { count: 0 };
    const Ctor = sessionClass(() => Promise.resolve(file), calls);
    const { docs, attach, bind } = fixture();
    attach({ host: "omp", session: new Ctor() });
    bind("share");
    await expect(new Ctor().exportToHtml(file)).resolves.toBe(file);
    await settle();
    expect(docs).toEqual([]);
    expect(calls.count).toBe(1);
  });

  it("sends nothing when the returned path is not a real file", async () => {
    const calls = { count: 0 };
    const missing = join(dir, "gone.html");
    const Ctor = sessionClass((path) => Promise.resolve(path ?? missing), calls);
    const { docs, attach, bind } = fixture();
    attach({ host: "pi", session: new Ctor() });
    bind("export");
    const session = new Ctor();
    await session.exportToHtml();
    await session.exportToHtml("");
    await settle();
    expect(docs).toEqual([]);
  });

  it("sends nothing when there is no Telegram binding", async () => {
    const file = join(dir, "terminal.html");
    writeFileSync(file, "<html>ok</html>");
    const calls = { count: 0 };
    const Ctor = sessionClass(() => Promise.resolve(file), calls);
    const { docs, attach } = fixture();
    attach({ host: "pi", session: new Ctor() });
    await expect(new Ctor().exportToHtml()).resolves.toBe(file);
    await settle();
    expect(docs).toEqual([]);
  });

  it("keeps a synchronous host failure with the caller", async () => {
    const calls = { count: 0 };
    const Ctor = sessionClass(() => { throw new Error("export failed"); }, calls);
    const { docs, attach, bind } = fixture();
    attach({ host: "pi", session: new Ctor() });
    bind("export");
    expect(() => new Ctor().exportToHtml()).toThrow("export failed");
    await settle();
    expect(docs).toEqual([]);
  });

  it("keeps a rejected export promise with the caller", async () => {
    const calls = { count: 0 };
    const Ctor = sessionClass(() => Promise.reject(new Error("disk full")), calls);
    const { docs, attach, bind } = fixture();
    attach({ host: "pi", session: new Ctor() });
    bind("export");
    await expect(new Ctor().exportToHtml()).rejects.toThrow("disk full");
    await settle();
    expect(docs).toEqual([]);
  });

  it("wraps the prototype once across repeated captures", async () => {
    const file = join(dir, "twice.html");
    writeFileSync(file, "<html>ok</html>");
    const calls = { count: 0 };
    const Ctor = sessionClass(() => Promise.resolve(file), calls);
    const { docs, attach, bind } = fixture();
    attach({ host: "pi", session: new Ctor() });
    attach({ host: "pi", session: new Ctor() });
    bind("export");
    await expect(new Ctor().exportToHtml()).resolves.toBe(file);
    await settle();
    expect(calls.count).toBe(1);
    expect(docs).toHaveLength(1);
  });

  it("still sends when the probe shadowed the method on the instance", async () => {
    const file = join(dir, "probed.html");
    writeFileSync(file, "<html>ok</html>");
    const calls = { count: 0 };
    const probeCalls = { count: 0 };
    const Ctor = sessionClass(() => Promise.resolve(file), calls);
    const session = new Ctor();
    // `probeCapture` (PITG_PROBE) installs its own instance wrapper before any
    // capture listener runs, which shadows a prototype wrapper.
    const inherited = session.exportToHtml.bind(session);
    session.exportToHtml = (path?: string) => {
      probeCalls.count += 1;
      return inherited(path);
    };
    const { docs, attach, bind } = fixture();
    attach({ host: "pi", session });
    bind("export");
    await expect(session.exportToHtml()).resolves.toBe(file);
    await settle();
    expect(probeCalls.count).toBe(1);
    expect(calls.count).toBe(1);
    expect(docs).toHaveLength(1);
  });
});
