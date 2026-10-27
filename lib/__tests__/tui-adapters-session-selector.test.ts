/**
 * Adapter P3: pi's `/resume` session picker (§4.1.4).
 *
 * Same-named fakes drive `read`/`act` with a recording `sendKey`; the last
 * block drives the real pi 1.4.0 component so a host upgrade that renames
 * `sessionList`, re-points Tab, or reshapes `SessionInfo` fails here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as host from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { SessionSelectorComponent as RealSessionSelectorComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { piSessionAdapter } from "../tui/adapters/pi-lists.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

/** Built from local parts so the expected `YYYY-MM-DD HH:mm` is TZ-independent. */
const MODIFIED = new Date(2026, 9, 20, 9, 5);

/** Fake with pi's field names; the adapter keys on the class name. */
class SessionSelectorComponent {
  sessionList = {
    filteredSessions: [
      {
        session: {
          path: "/s/a.jsonl", id: "a", cwd: "/repo", name: "Refactor task",
          created: MODIFIED, modified: MODIFIED, messageCount: 12, firstMessage: "Ignored first message",
        },
        depth: 0,
      },
      {
        session: {
          path: "/s/b.jsonl", id: "b", cwd: "/repo",
          created: MODIFIED, modified: MODIFIED, messageCount: 3, firstMessage: "Fix\nlogin issue",
        },
        depth: 0,
      },
      {
        session: {
          path: "/s/c.jsonl", id: "c", cwd: "/repo",
          created: MODIFIED, modified: MODIFIED, messageCount: 100, firstMessage: "x".repeat(60),
        },
        depth: 1,
      },
    ],
    selectedIndex: 1,
    currentSessionCanonicalPath: "/s/b.jsonl",
  };
  scope: "current" | "all" = "current";
  mode = "list";
}

class RenamingSessionSelector extends SessionSelectorComponent {
  override mode = "rename";
}

class BrokenSessionSelector {
  sessionList = { filteredSessions: "gone" };
  scope = "current";
  mode = "list";
}

/** Recording context: `sendKey` appends the key name, like a user's keystrokes. */
function harness(hostName: "pi" | "omp" = "pi") {
  const sent: string[] = [];
  const ctx: AdapterContext = {
    host: hostName,
    sendKey: (name) => {
      sent.push(name);
      return true;
    },
    requestRender: () => {},
  };
  return { ctx, sent };
}

function expectSelect(model: DialogModel) {
  if (model.kind !== "select") throw new Error(`expected a select model, got ${model.kind}`);
  return model;
}

describe("piSessionAdapter detect", () => {
  it("claims the session selector on the pi host only, outside rename mode", () => {
    const { ctx } = harness();
    expect(piSessionAdapter.detect(new SessionSelectorComponent(), ctx)).toBe(true);
    expect(piSessionAdapter.detect(new SessionSelectorComponent(), harness("omp").ctx)).toBe(false);
    expect(piSessionAdapter.detect(new RenamingSessionSelector(), ctx)).toBe(false);
    expect(piSessionAdapter.detect(new BrokenSessionSelector(), ctx)).toBe(false);
  });

  it("is picked before the generic extension-select adapter", () => {
    const { ctx } = harness();
    expect(pickAdapter(new SessionSelectorComponent(), ctx)).toBe(piSessionAdapter);
  });
});

describe("read", () => {
  it("models the current-folder scope: labels, times, current row, cursor, tab action", () => {
    const { ctx } = harness();
    const model = expectSelect(piSessionAdapter.read(new SessionSelectorComponent(), ctx));
    expect(model.title).toBe("Resume session (this folder)");
    expect(model.items.map((item) => item.label)).toEqual([
      "Refactor task · 12 msgs",
      "Fix login issue · 3 msgs",
      `${"x".repeat(50)}… · 100 msgs`,
    ]);
    expect(model.items.map((item) => item.description)).toEqual([
      "2026-10-20 09:05",
      "2026-10-20 09:05",
      "2026-10-20 09:05",
    ]);
    expect(model.items.map((item) => item.current)).toEqual([false, true, false]);
    expect(model.items.map((item) => item.focused)).toEqual([false, true, false]);
    expect(model.items.map((item) => item.key)).toEqual([
      "0:Refactor task · 12 msgs",
      "1:Fix login issue · 3 msgs",
      `2:${"x".repeat(50)}… · 100 msgs`,
    ]);
    expect(model.total).toBe(3);
    expect(model.extraActions).toEqual([{ label: "Show all", key: "tab" }]);
  });

  it("switches title and tab label when the scope is all", () => {
    const { ctx } = harness();
    const component = new SessionSelectorComponent();
    component.scope = "all";
    const model = expectSelect(piSessionAdapter.read(component, ctx));
    expect(model.title).toBe("Resume session (all)");
    expect(model.extraActions).toEqual([{ label: "This folder only", key: "tab" }]);
  });
});

describe("act", () => {
  it("choose walks the terminal cursor to the row and presses enter", () => {
    const { ctx, sent } = harness();
    const component = new SessionSelectorComponent();
    expect(piSessionAdapter.act(component, { type: "choose", key: "2:" + `${"x".repeat(50)}… · 100 msgs` }, ctx)).toBe(true);
    expect(sent).toEqual(["down", "enter"]);
    sent.length = 0;
    expect(piSessionAdapter.act(component, { type: "choose", key: "0:Refactor task · 12 msgs" }, ctx)).toBe(true);
    expect(sent).toEqual(["up", "enter"]);
  });

  it("refuses rows that are gone and actions it never advertised", () => {
    const { ctx, sent } = harness();
    const component = new SessionSelectorComponent();
    expect(piSessionAdapter.act(component, { type: "choose", key: "9:gone" }, ctx)).toBe(false);
    expect(piSessionAdapter.act(component, { type: "key", name: "enter" }, ctx)).toBe(false);
    expect(piSessionAdapter.act(component, { type: "submit" }, ctx)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("tab switches the scope and cancel closes the dialog", () => {
    const { ctx, sent } = harness();
    const component = new SessionSelectorComponent();
    expect(piSessionAdapter.act(component, { type: "key", name: "tab" }, ctx)).toBe(true);
    expect(piSessionAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(sent).toEqual(["tab", "esc"]);
  });
});

describe("contract: real pi 1.4.0 session selector", () => {
  beforeAll(() => {
    host.initTheme("dark");
  });

  /** Keys go through the component's own handleInput, like the Broker. */
  function realCtx(component: object): AdapterContext {
    return { host: "pi", sendKey: (name) => sendKeyTo(component, name), requestRender: () => {} };
  }


  // canonicalizePath is realpathSync with an as-is fallback, so a non-existent
  // file under the realpath'd tmp dir is already canonical.
  const TMP = realpathSync(tmpdir());
  const ALPHA = `${TMP}/pi-session-alpha.jsonl`;
  const BETA = `${TMP}/pi-session-beta.jsonl`;

  function makeSelector(handlers: {
    onSelect: (path: string) => void;
    onCancel: () => void;
  }): { selector: RealSessionSelectorComponent; landed: Promise<void> } {
    const sessions: SessionInfo[] = [
      {
        path: ALPHA, id: "alpha", cwd: TMP,
        created: MODIFIED, modified: MODIFIED, messageCount: 4,
        firstMessage: "alpha first\nline", allMessagesText: "alpha first line",
      },
      {
        path: BETA, id: "beta", cwd: TMP, name: "Named session",
        created: MODIFIED, modified: MODIFIED, messageCount: 9,
        firstMessage: "beta", allMessagesText: "beta",
      },
    ];
    const load = async () => sessions;
    const selector = new RealSessionSelectorComponent(load, load, handlers.onSelect, handlers.onCancel, () => {}, () => {}, undefined, BETA);
    // The constructor kicks off an async load whose promise never surfaces;
    // the component's own `setSessions` is the real "rows landed" event.
    // pi's `private` is compile-time only; sessionList exists at runtime.
    const selectorFields = selector as unknown as Record<string, unknown>;
    const list = selectorFields.sessionList as { setSessions: (rows: unknown[], showCwd: boolean) => void };
    const { promise, resolve } = Promise.withResolvers<void>();
    const original = list.setSessions.bind(list);
    list.setSessions = (rows, showCwd) => {
      original(rows, showCwd);
      resolve();
    };
    return { selector, landed: promise };
  }

  it("reads real rows, marks the current session and answers choose with its path", async () => {
    const picked: string[] = [];
    const { selector, landed } = makeSelector({ onSelect: (path) => picked.push(path), onCancel: () => {} });
    await landed;
    const ctx = realCtx(selector);
    expect(piSessionAdapter.detect(selector, ctx)).toBe(true);
    const model = expectSelect(piSessionAdapter.read(selector, ctx));
    expect(model.title).toBe("Resume session (this folder)");
    expect(model.items.map((item) => item.label)).toEqual(["alpha first line · 4 msgs", "Named session · 9 msgs"]);
    expect(model.items[1].current).toBe(true);
    expect(model.items[0].focused).toBe(true);
    expect(model.extraActions).toEqual([{ label: "Show all", key: "tab" }]);
    expect(piSessionAdapter.act(selector, { type: "choose", key: model.items[1].key }, ctx)).toBe(true);
    expect(picked).toEqual([BETA]);
  });

  it("tab flips the real scope to all, esc cancels", async () => {
    let cancelled = 0;
    const { selector, landed } = makeSelector({ onSelect: () => {}, onCancel: () => { cancelled += 1; } });
    await landed;
    const ctx = realCtx(selector);
    expect(piSessionAdapter.act(selector, { type: "key", name: "tab" }, ctx)).toBe(true);
    expect(expectSelect(piSessionAdapter.read(selector, ctx)).title).toBe("Resume session (all)");
    expect(piSessionAdapter.act(selector, { type: "cancel" }, ctx)).toBe(true);
    expect(cancelled).toBe(1);
  });
});
