import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode, initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, TuiAltScreen, TuiMainScreen, stripTerminalSequences, visibleWidth,
  type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { selectBudgetItem } from "../context-budget/picker.ts";
import { pickAdapter } from "../tui/adapters/index.ts";
import { sendKeyTo } from "../tui/keys.ts";
import { DialogBroker, type BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

beforeAll(() => initTheme("dark"));
const keys = Array.from({ length: 1000 }, (_, i) => `fake/m${String(i).padStart(4, "0")}`);
const syntheticTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` };
type Picker = Component & Record<string, unknown> & { baseTitle: string; list: SelectList; handleInput(data: string): void; dispose(): void };
function mount(options: string[] = keys, onDone: () => void = () => {}, realTui?: TUI) {
  const size = { rows: 24 };
  const tui = realTui ?? { terminal: size, requestRender: vi.fn() };
  let component!: Picker;
  const done = vi.fn();
  const ui = { custom: vi.fn((factory: any, opts: any) => new Promise<string | undefined>(resolve => {
    expect(opts).toBeUndefined();
    component = factory(tui, syntheticTheme, {}, (value: string | undefined) => {
      done(value); onDone(); component.dispose(); resolve(value);
    });
  })) };
  const promise = selectBudgetItem(ui as Pick<ExtensionUIContext, "custom">, "上下文预算：选择模型", options);
  return { component, size, tui, ui, done, promise };
}
function visible(component: Picker, width: number, rows: number, expected: string) {
  const lines = component.render(width);
  expect(lines.length).toBeLessThanOrEqual(Math.min(14, Math.max(1, Math.floor(rows * 0.8))));
  expect(lines.map(stripTerminalSequences).some(line => line.startsWith("→ ") && line.includes(expected))).toBe(true);
  expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("budget picker with the real SDK SelectList (no real terminal)", () => {
  it("keeps every selected row visible through a thousand moves in both directions on a short terminal", async () => {
    const f = mount(); f.size.rows = 12;
    for (let i = 0; i < keys.length; i++) {
      visible(f.component, 40, f.size.rows, keys[i]!);
      f.component.handleInput("\x1b[B");
    }
    visible(f.component, 40, 12, keys[0]!); // Native SelectList wraps at the boundary.
    f.component.handleInput("\x1b[A");
    for (let i = keys.length - 1; i >= 0; i--) {
      visible(f.component, 40, 12, keys[i]!);
      f.component.handleInput("\x1b[A");
    }
    visible(f.component, 40, 12, keys[999]!);
    f.component.handleInput("\r"); expect(await f.promise).toBe(keys[999]);
  }, 15000);
  it("preserves the selected model across shrink/grow, including one-row viewports", async () => {
    const f = mount(); f.component.list.setSelectedIndex(777);
    for (const rows of [36, 12, 7, 4, 2, 1, 24]) {
      f.size.rows = rows; f.component.invalidate(); visible(f.component, 24, rows, keys[777]!);
      expect(f.component.list.getSelectedItem()?.value).toBe(keys[777]);
    }
    f.component.handleInput("\x1b[B"); visible(f.component, 24, 24, keys[778]!);
    f.component.dispose(); expect(await f.promise).toBeUndefined();
  });
  it("fits wide characters/long names into narrow columns without truncating the returned ID", async () => {
    const id = `供应商/中文模型🙂e\u0301/${"long-".repeat(80)}`;
    const f = mount([id]); f.size.rows = 8;
    for (const width of [80, 32, 12, 4, 1]) {
      const lines = f.component.render(width);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(6);
    }
    expect(f.component.list.getSelectedItem()?.value).toBe(id);
    f.component.handleInput("\r"); expect(await f.promise).toBe(id);
  });
  it.each(["\x1b", "\x03", "dispose", "\r"])("completes at most once after %j, including host disposal reentry", async action => {
    const f = mount(["fake/one"]);
    if (action === "dispose") f.component.dispose(); else f.component.handleInput(action);
    f.component.handleInput("\r"); f.component.dispose();
    f.component.list.onSelect?.({ value: "fake/late", label: "fake/late" });
    expect(await f.promise).toBe(action === "\r" ? "fake/one" : undefined);
    expect(f.done).toHaveBeenCalledTimes(1); expect(f.component.render(80)).toEqual([]);
  });
  it("does not create an empty dialog", async () => {
    const ui = { custom: vi.fn() };
    expect(await selectBudgetItem(ui as any, "empty", [])).toBeUndefined(); expect(ui.custom).not.toHaveBeenCalled();
  });
  it("exposes all rows and the live cursor to the existing adapter, not only the visible slice", async () => {
    const f = mount(); f.size.rows = 8; f.component.list.setSelectedIndex(500); f.component.render(32);
    const ctx: AdapterContext = { host: "pi", root: f.component, entry: { kind: "custom", source: "pi" },
      sendKey: name => sendKeyTo(f.component, name), requestRender() {} };
    const adapter = pickAdapter(f.component, ctx)!; expect(adapter.id).toBe("ext-select");
    const model = adapter.read(f.component, ctx);
    if (model.kind !== "select") throw new Error("expected structured select, never a screenshot/unsupported fallback");
    expect(model.title).toBe(f.component.baseTitle); expect(model.items).toHaveLength(1000);
    expect(model.items[500]?.focused).toBe(true);
    expect(adapter.act(f.component, { type: "choose", key: model.items[999]!.key }, ctx)).toBe(true);
    expect(await f.promise).toBe(keys[999]);
  });
});

/** Only synthetic strings ever enter this terminal; it never uses process.stdin/stdout. */
function fakeTerminal() {
  let input: (data: string) => void = () => {};
  let resize: () => void = () => {};
  const terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start: (onInput: (data: string) => void, onResize: () => void) => { input = onInput; resize = onResize; },
    stop() {}, drainInput: async () => {}, write: vi.fn(), moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  } satisfies Terminal;
  return { terminal, input: (data: string) => input(data), resize: () => resize() };
}
describe("real SDK regular/fullscreen layout with a synthetic terminal", () => {
  it.each(["regular", "fullscreen"])("keeps focus and selected row onscreen in %s mode across resize", async mode => {
    const terminal = fakeTerminal();
    const tui = mode === "regular" ? new TuiMainScreen(terminal.terminal) : new TuiAltScreen(terminal.terminal);
    const f = mount(keys, () => {}, tui);
    try {
      tui.addChild(new Text("synthetic background\n".repeat(100), 0, 0)); tui.start();
      tui.addChild(f.component);
      tui.setFocus(f.component);
      for (let i = 0; i < 37; i++) terminal.input("\x1b[B");
      for (const [cols, rows] of [[80, 24], [32, 10], [24, 6], [100, 36]]) {
        terminal.terminal.columns = cols!; terminal.terminal.rows = rows!;
        terminal.resize(); tui.renderNow(true);
        const lines = tui instanceof TuiAltScreen ? tui.getScreenLines() : tui.captureRenderState().previousLines.slice(-rows!);
        expect(lines.map(stripTerminalSequences).some(line => line.includes(`→ ${keys[37]}`))).toBe(true);
      }
      terminal.input("\r"); expect(await f.promise).toBe(keys[37]);
    } finally { f.component.dispose(); tui.stop(); }
  });
});

function brokerFixture() {
  const entry: EntryInfo = { kind: "custom", source: "pi" }; // No select race handle: exercise the native key path.
  const editor = { handleInput() {} };
  let info: FocusInfo = { kind: "editor", component: editor, source: "event" };
  const listeners = new Set<(info: FocusInfo) => void>();
  const emit = (next: FocusInfo) => { info = next; for (const listener of listeners) listener(info); };
  const f = mount(keys, () => emit({ kind: "editor", component: editor, source: "event" }));
  const transport = {
    sendButtons: vi.fn(async () => ({ message_id: 101 })), editButtons: vi.fn(async () => {}),
    sendText: vi.fn(async () => [{ message_id: 102 }]), removeInlineKeyboard: vi.fn(async () => {}), deleteMessage: vi.fn(async () => {}),
  };
  const broker = new DialogBroker({ transport: transport as unknown as BrokerDeps["transport"],
    focus: { current: () => info, entryFor: () => entry,
      onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    origin: { active: () => undefined } as any, activeChatId: () => -100123, activeTurns: () => [],
    localOrigin: () => ({ chatId: -100123, messageThreadId: 11 }), writeText: () => false, enabled: () => true,
  });
  broker.start(); emit({ kind: "dialog", component: f.component, source: "event" });
  return { ...f, broker, transport };
}
describe("budget picker through the unchanged DialogBroker and simulated Telegram", () => {
  it.each(["telegram", "terminal"])("allows %s to answer first and rejects the late answer", async first => {
    vi.useFakeTimers(); const f = brokerFixture();
    try {
      await settle(); const session = f.broker.current()!;
      expect(session.adapter?.id).toBe("ext-select"); expect(f.transport.sendButtons).toHaveBeenCalledTimes(1);
      const page = { sessionId: session.id, generation: session.generation, op: "p", arg: "99" };
      expect(f.broker.handleCallback(-100123, 11, page)).toEqual({ handled: true });
      await vi.advanceTimersByTimeAsync(1001); await settle();
      const live = f.broker.current()!;
      const callback = { sessionId: live.id, generation: live.generation, op: "c", arg: "99.9" };
      expect(live.keyMap.get(live.generation)?.get("99.9")).toBe(`999:${keys[999]}`);
      expect(f.broker.handleCallback(-100123, 22, callback).toast).toContain("expired");
      expect(f.broker.handleCallback(-999, 11, callback).toast).toContain("expired");
      expect(f.done).not.toHaveBeenCalled();
      if (first === "telegram") f.broker.handleCallback(-100123, 11, callback);
      else { f.component.list.setSelectedIndex(1); f.component.handleInput("\r"); }
      expect(await f.promise).toBe(keys[first === "telegram" ? 999 : 1]); await settle();
      expect(f.broker.handleCallback(-100123, 11, callback).clear).toBe(true);
      f.component.handleInput("\r"); expect(f.done).toHaveBeenCalledTimes(1);
      expect(f.broker.current()).toBeUndefined(); expect(f.transport.removeInlineKeyboard).toHaveBeenCalled();
    } finally { f.component.dispose(); f.broker.stop(); vi.useRealTimers(); }
  });
  it("cancels from Telegram without returning a model", async () => {
    const f = brokerFixture();
    try {
      await settle(); const session = f.broker.current()!;
      f.broker.handleCallback(-100123, 11, { sessionId: session.id, generation: session.generation, op: "x" });
      expect(await f.promise).toBeUndefined(); expect(f.done).toHaveBeenCalledTimes(1);
    } finally { f.component.dispose(); f.broker.stop(); }
  });
});

describe("budget picker mounts in the host editor slot (UI5 regression)", () => {
  it("uses the bottom input dock, not a centered overlay, and restores the draft on close", async () => {
    const terminal = fakeTerminal();
    const tui = new TuiMainScreen(terminal.terminal);
    const editor = Object.assign(new Text("EDITOR-DRAFT", 0, 0), { getText: () => "draft", setText(_text: string) {} });
    const host: Record<string, any> = {
      editor, extensionDialogs: [], editorContainer: new (Container as any)(), ui: tui,
      programStatus: { setBlocked() {} }, activeSelectorDispose: undefined,
    };
    host.editorContainer.addChild(editor);
    for (const name of ["showExtensionCustom", "pushExtensionDialog", "removeExtensionDialog", "showTopExtensionDialog", "disposeActiveSelector"]) {
      host[name] = (InteractiveMode.prototype as any)[name];
    }
    const ui = { custom: (factory: any, opts: any) => host.showExtensionCustom(factory, opts) };
    tui.addChild(new Text("transcript line\n".repeat(30), 0, 0));
    tui.addChild(host.editorContainer);
    tui.start();
    try {
      const promise = selectBudgetItem(ui as any, "上下文预算：选择模型", keys.slice(0, 40));
      await settle();
      tui.renderNow(true);
      expect(tui.hasOverlay()).toBe(false);
      expect(host.extensionDialogs).toHaveLength(1);
      const dialog = host.extensionDialogs[0].component as Picker;
      const screen = tui.captureRenderState().previousLines.map(stripTerminalSequences).join("\n");
      expect(screen).toContain("上下文预算：选择模型");
      expect(screen).toContain(`→ ${keys[0]}`);
      dialog.handleInput("\r");
      expect(await promise).toBe(keys[0]);
      expect(host.extensionDialogs).toHaveLength(0);
      expect(host.editorContainer.children).toContain(editor);
    } finally { tui.stop(); }
  });
});
