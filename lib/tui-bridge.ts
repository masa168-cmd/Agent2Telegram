import { stripAnsi } from "./ansi.ts";
import { log } from "./logger.ts";
import { probeCapture } from "./tui/probe.ts";
import { SUPPORTED_OMP_VERSIONS } from "./tui/adapters/utils.ts";

const bridgeLog = log.child("tui-bridge");

/** The only host versions this plugin supports (§0.1): anything else refuses to start. */
export const SUPPORTED_PI_VERSION = "1.4.0";

export type TuiHost = "pi" | "omp" | "unknown";

export type TuiCommand = {
  name: string;
  description?: string;
  aliases?: string[];
  source: "builtin" | "autocomplete";
};

export type TuiSnapshot = {
  /** ANSI-free rendered terminal text. */
  text: string;
  /** True when a selector/overlay owns focus instead of the editor. */
  interactive: boolean;
  host: TuiHost;
  width: number;
};

type HostObject = Record<string, unknown>;
type HostCallable = ((this: unknown, ...args: unknown[]) => unknown) & {
  __ptpBridgePatched?: boolean;
  __ptpBridgeSubmit?: boolean;
};

export type TuiBridgeAdapter = {
  ready(): Promise<void>;
  isAvailable(): boolean;
  getHost(): TuiHost;
  /** Why the host version gate refused the bridge (§0.1); undefined when the host version is supported. */
  getUnsupportedReason?(): string | undefined;
  getCommands(): Promise<TuiCommand[]>;
  submit(text: string): boolean;
  submitResult?(text: string): { ok: boolean; result?: unknown };
  readEditorText?(): string;
  writeEditorText?(text: string): boolean;
  snapshot(width: number): TuiSnapshot | undefined;
  key(name: string): boolean;
  write(text: string): boolean;
  isEditorFocused(): boolean;
  isInteractiveFocus(): boolean;
  onLocalSubmit(listener: (text: string) => void): () => void;
};

export type TuiHostState = {
  host: TuiHost;
  mode?: HostObject;
  ui?: HostObject;
  editor?: HostObject;
  defaultEditor?: HostObject;
  session?: HostObject;
  chat?: HostObject;
};

type BridgeState = TuiHostState & {
  hostCommands: TuiCommand[];
  suppressLocalSubmit: boolean;
  localSubscribers: Set<(text: string) => void>;
  captureSubscribers: Set<(state: TuiHostState) => void>;
  /** Set when the host version is unsupported: the bridge installs no patches and stays unavailable (§0.1). */
  unsupportedReason?: string;
};

// A host can load this package twice in one process (OMP resolves it under two
// specifiers), and only the copy whose prototype patch landed first is ever told
// about a captured mode. Without sharing, the copy that serves Telegram reports the
// bridge as unavailable, answers dialogs itself and never lets the host draw them -
// so the captured state lives behind a process-wide key every copy can reach.
const SHARED_STATE_KEY = "__piTelegramPlusTuiBridgeState";
const sharedGlobal = globalThis as typeof globalThis & { [SHARED_STATE_KEY]?: BridgeState };
const state: BridgeState = sharedGlobal[SHARED_STATE_KEY] ??= {
  host: "unknown",
  hostCommands: [],
  suppressLocalSubmit: false,
  localSubscribers: new Set(),
  captureSubscribers: new Set(),
};

const editorWrappers = new WeakMap<HostObject, { original: HostCallable; wrapped: HostCallable }>();

let installPromise: Promise<void> | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asHostObject(value: unknown): HostObject | undefined {
  return value && typeof value === "object" ? (value as HostObject) : undefined;
}

function asHostConstructor(value: unknown): HostObject | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const prototype = (value as { prototype?: unknown }).prototype;
  return asHostObject(prototype);
}

function asCallable(value: unknown): HostCallable | undefined {
  return typeof value === "function" ? (value as HostCallable) : undefined;
}

async function loadOmpMode(): Promise<HostObject | undefined> {
  try {
    const mod: unknown = await import("@oh-my-pi/pi-coding-agent/modes/interactive-mode");
    return asHostObject(mod);
  } catch {
    return undefined;
  }
}

/** Read a module's VERSION export, which hosts expose as a string or getter. */
function versionFromModule(mod: HostObject | undefined): string | undefined {
  const version = mod?.VERSION;
  if (typeof version === "string") return version;
  if (typeof version === "function") {
    const value = (version as () => unknown)();
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

async function loadOmpVersion(): Promise<string | undefined> {
  try {
    // @oh-my-pi/pi-utils only exists when running under OMP: a static import
    // would break the pi-only install (§4.6.6 exception 2 version gate).
    const mod: unknown = await import("@oh-my-pi/pi-utils");
    return versionFromModule(asHostObject(mod));
  } catch {
    return undefined;
  }
}

async function loadPiMode(): Promise<HostObject | undefined> {
  try {
    const mod: unknown = await import("@earendil-works/pi-coding-agent");
    return asHostObject(mod);
  } catch {
    return undefined;
  }
}

async function loadOmpCommands(): Promise<TuiCommand[]> {
  try {
    const mod: unknown = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
    const moduleObject = asHostObject(mod);
    return commandList(moduleObject?.BUILTIN_SLASH_COMMAND_DEFS, "builtin");
  } catch {
    return [];
  }
}

/**
 * Startup version gate (§0.1): one supported host version, no fallbacks. Under
 * OMP the pi specifier is redirected to OMP modules, so a readable OMP version
 * decides the host; otherwise the pi version must match exactly.
 */
function unsupportedVersionReason(ompVersion: string | undefined, piVersion: string | undefined): string | undefined {
  if (ompVersion !== undefined) {
    return SUPPORTED_OMP_VERSIONS.test(ompVersion)
      ? undefined
      : `Unsupported OMP version ${ompVersion}; requires 18.12.x`;
  }
  return piVersion === SUPPORTED_PI_VERSION
    ? undefined
    : `Unsupported pi version ${piVersion ?? "unknown"}; requires ${SUPPORTED_PI_VERSION}`;
}

function patchMethod(prototype: HostObject, name: string, host: TuiHost): boolean {
  const original = asCallable(prototype[name]);
  if (!original || original.__ptpBridgePatched) return false;
  const wrapped: HostCallable = function patched(this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    captureMode(this, host);
    return result;
  };
  wrapped.__ptpBridgePatched = true;
  prototype[name] = wrapped;
  return true;
}

function captureMode(mode: unknown, host: TuiHost): void {
  const modeObject = asHostObject(mode);
  if (!modeObject) return;
  let editor = asHostObject(modeObject.editor ?? modeObject.defaultEditor ?? modeObject.input);
  const ui = asHostObject(modeObject.ui ?? modeObject.uiContext ?? modeObject.tui ?? modeObject.app);
  if (!editor && ui) {
    const getEditor = asCallable(ui.getEditor);
    if (getEditor) {
      try {
        editor = asHostObject(getEditor.call(ui));
      } catch {
        // Host may expose getEditor before initialization completes.
      }
    }
    editor ??= asHostObject(modeObject.editor ?? ui.editor ?? ui.input);
  }
  if (!editor && !ui) return;

  state.mode = modeObject;
  state.host = host;
  state.ui = ui;
  state.editor = editor;
  state.defaultEditor = asHostObject(modeObject.defaultEditor);
  state.session = asHostObject(modeObject.session);
  state.chat = asHostObject(modeObject.chatContainer ?? modeObject.chat);
  ensureWrappedEditor();
  probeCapture(modeObject, host);
  for (const listener of state.captureSubscribers) {
    try {
      listener({
        host: state.host,
        mode: state.mode,
        ui: state.ui,
        editor: state.editor,
        defaultEditor: state.defaultEditor,
        session: state.session,
        chat: state.chat,
      });
    } catch (err) {
      bridgeLog.debug("capture listener failed", { err });
    }
  }
  bridgeLog.debug("captured TUI mode", { host, hasEditor: !!state.editor, hasUi: !!state.ui });
}

/** Latest captured host objects. The bridge owns capture; new TUI modules read this view. */
export function getTuiHostState(): TuiHostState {
  return {
    host: state.host,
    mode: state.mode,
    ui: state.ui,
    editor: state.editor,
    defaultEditor: state.defaultEditor,
    session: state.session,
    chat: state.chat,
  };
}

export function onTuiCaptured(listener: (state: TuiHostState) => void): () => void {
  state.captureSubscribers.add(listener);
  const current = getTuiHostState();
  if (current.mode) {
    try { listener(current); } catch (err) { bridgeLog.debug("capture listener failed", { err }); }
  }
  return () => { state.captureSubscribers.delete(listener); };
}

export function readEditorText(): string {
  const editor = state.editor ?? state.defaultEditor;
  if (!editor) return "";
  const getText = asCallable(editor.getText);
  if (getText) {
    try {
      const value = getText.call(editor);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  const value = editor.text ?? editor.value;
  return typeof value === "string" ? value : "";
}

export function writeEditorText(text: string): boolean {
  const editor = state.editor ?? state.defaultEditor;
  if (!editor) return false;
  const setText = asCallable(editor.setText);
  if (!setText) return false;
  try {
    setText.call(editor, text);
    return true;
  } catch {
    return false;
  }
}

export function installTuiBridge(): Promise<void> {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    const [omp, ompCommands, pi, ompVersion] = await Promise.all([
      loadOmpMode(),
      loadOmpCommands(),
      loadPiMode(),
      loadOmpVersion(),
    ]);
    state.hostCommands = ompCommands;
    // The pi version comes off the module loadPiMode already imported; a second
    // concurrent import of the same specifier is what the mock host resolves
    // inconsistently in tests, and buys nothing in production.
    const piVersion = versionFromModule(pi);
    const reason = unsupportedVersionReason(ompVersion, piVersion);
    if (reason !== undefined) {
      // No patches at all: without a patched host entry point the bridge can
      // never capture a mode, so isAvailable() stays false by construction.
      state.unsupportedReason = reason;
      bridgeLog.error(reason);
      return;
    }
    const ompProto = asHostConstructor(omp?.InteractiveMode);
    if (ompProto) {
      patchMethod(ompProto, "initHooksAndCustomTools", "omp");
      patchMethod(ompProto, "render", "omp");
    }
    const piProto = asHostConstructor(pi?.InteractiveMode);
    if (piProto) {
      patchMethod(piProto, "setupEditorSubmitHandler", "pi");
      patchMethod(piProto, "init", "pi");
      patchMethod(piProto, "run", "pi");
    }
    if (!ompProto && !piProto) bridgeLog.debug("TUI bridge unavailable: no InteractiveMode export");
  })();
  return installPromise;
}

function ensureWrappedEditor(): void {
  const editor = state.editor;
  if (!editor) return;
  const current = asCallable(editor.onSubmit);
  if (!current) return;

  const existing = editorWrappers.get(editor);
  if (existing?.wrapped === current) return;

  // If the host replaced onSubmit after we wrapped it, wrap the replacement.
  // Wrapper state is per editor so a new session never calls the previous
  // session's submit closure.
  const original = current;
  const wrapped: HostCallable = function patchedSubmit(this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : "";
    if (!state.suppressLocalSubmit) {
      for (const listener of state.localSubscribers) {
        try {
          listener(text);
        } catch (err) {
          bridgeLog.debug("local submit listener failed", { err });
        }
      }
    }
    return original.apply(this, args);
  };
  wrapped.__ptpBridgeSubmit = true;
  editorWrappers.set(editor, { original, wrapped });
  editor.onSubmit = wrapped;
}

function focusedComponent(): HostObject | undefined {
  const ui = state.ui;
  if (!ui) return undefined;
  for (const name of ["getFocus", "getFocused"]) {
    const getter = asCallable(ui[name]);
    if (!getter) continue;
    try {
      const focused = asHostObject(getter.call(ui));
      if (focused) return focused;
    } catch {
      // A host can expose the getter before its focus tree is initialized.
    }
  }
  return asHostObject(ui.focusedComponent ?? ui.focused);
}

function isEditorFocused(): boolean {
  const focused = focusedComponent();
  if (!focused) return true;
  const editor = state.editor;
  if (!editor) return false;
  return focused === editor || focused === asHostObject(editor.editor);
}

function isInteractiveFocus(): boolean {
  const focused = focusedComponent();
  if (focused) return !isEditorFocused();

  // pi exposes extension overlays as mode fields. OMP exposes focus through
  // ui.getFocused(), handled above. No screen-text heuristics: normal output
  // can contain words such as "settings" or brackets.
  const mode = state.mode;
  if (!mode) return false;
  // OMP mounts full-screen panels (/settings) on the TUI overlay stack; they
  // hold focus and take keys, so the mirror must keep its controls.
  const uiObject = state.ui as unknown as Record<string, unknown> | undefined;
  if (uiObject && visibleOverlays(uiObject).length > 0) return true;
  return [
    "extensionSelector",
    "extensionInput",
    "extensionEditor",
    "settingsSelector",
    "selector",
    "overlay",
  ].some((name) => asHostObject(mode[name]) !== undefined);
}
function overlayWidth(options: Record<string, unknown> | undefined, termWidth: number): number {
  const width = options?.width;
  if (typeof width === "number") return Math.max(1, Math.min(termWidth, width));
  if (typeof width === "string" && width.endsWith("%")) {
    const percent = Number.parseFloat(width);
    if (Number.isFinite(percent)) return Math.max(1, Math.min(termWidth, Math.floor((termWidth * percent) / 100)));
  }
  return termWidth;
}

function visibleOverlays(uiObject: Record<string, unknown>): Array<Record<string, unknown>> {
  const stack = uiObject.overlayStack;
  if (!Array.isArray(stack)) return [];
  return stack.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.hidden === true || entry.released === true) return false;
    return typeof entry.component === "object" && entry.component !== null;
  });
}

// Overlays (e.g. /settings) are composited by the host's frame renderer, which
// render(width) does not include. Render the top overlay ourselves so the
// mirror shows what the terminal shows.
function overlayLines(entry: Record<string, unknown>, width: number): string[] | undefined {
  const component = entry.component as Record<string, unknown>;
  const render = asCallable(component.render);
  if (!render) return undefined;
  const options = (entry.options ?? {}) as Record<string, unknown>;
  let lines: unknown;
  try {
    lines = render.call(component, overlayWidth(options, width));
  } catch (err) {
    bridgeLog.debug("TUI overlay render failed", { err });
    return undefined;
  }
  if (!Array.isArray(lines)) return undefined;
  const rendered = lines.map((line) => stripAnsi(String(line)));
  // Percentage caps need the terminal height; the viewport slice in
  // renderScreen already applies it.
  const maxHeight = options.maxHeight;
  return typeof maxHeight === "number" && maxHeight > 0 ? rendered.slice(0, maxHeight) : rendered;
}

function compositeOverlay(base: string[], overlay: string[], anchor: unknown): string[] {
  const lines = [...base];
  while (lines.length < overlay.length) lines.push("");
  const start = anchor === "top" || anchor === "top-left" || anchor === "top-center" || anchor === "top-right"
    ? 0
    : anchor === "center" || anchor === "left-center" || anchor === "right-center"
      ? Math.max(0, Math.floor((lines.length - overlay.length) / 2))
      : lines.length - overlay.length;
  lines.splice(start, overlay.length, ...overlay);
  return lines;
}

function renderScreen(width: number): string | undefined {
  const ui = state.ui;
  if (!ui) return undefined;
  const render = asCallable(ui.render);
  if (!render) return undefined;
  let lines: unknown;
  try {
    lines = render.call(ui, width);
  } catch (err) {
    bridgeLog.debug("TUI render failed", { err });
    return undefined;
  }
  if (!Array.isArray(lines)) return undefined;
  let screen = lines.map((line) => stripAnsi(String(line)));

  const uiObject = ui as unknown as Record<string, unknown>;
  const overlays = visibleOverlays(uiObject);
  const top = overlays[overlays.length - 1];
  if (top) {
    const overlay = overlayLines(top, width);
    if (overlay) {
      const options = (top.options ?? {}) as Record<string, unknown>;
      screen = options.fullscreen === true ? overlay : compositeOverlay(screen, overlay, options.anchor);
    }
  }
  const rows = Number((uiObject.terminal as { rows?: number } | undefined)?.rows ?? 0);
  if (rows > 0 && screen.length > rows) screen = screen.slice(screen.length - rows);
  return screen.join("\n");
}

function commandList(value: unknown, source: TuiCommand["source"]): TuiCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: TuiCommand[] = [];
  for (const item of value) {
    const command = asHostObject(item);
    if (!command) continue;
    const nameValue = command.name ?? command.value;
    if (typeof nameValue !== "string" || !nameValue.trim()) continue;
    const description = typeof command.description === "string" ? command.description : undefined;
    const aliases = Array.isArray(command.aliases)
      ? command.aliases.filter((alias): alias is string => typeof alias === "string")
      : undefined;
    commands.push({
      name: nameValue.trim(),
      description,
      source,
      ...(aliases?.length ? { aliases } : {}),
    });
  }
  return commands;
}

async function buildCommandCatalog(): Promise<TuiCommand[]> {
  await installTuiBridge();
  const commands: TuiCommand[] = [];
  const seen = new Set<string>();
  const add = (command: TuiCommand): void => {
    const name = command.name.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    commands.push({ ...command, name });
  };

  if (state.host === "omp") {
    for (const command of state.hostCommands) add(command);
  }

  const mode = state.mode;
  const editor = state.editor;
  const providers = [
    asHostObject(mode?.autocompleteProvider),
    asHostObject(editor?.autocompleteProvider),
  ];
  for (const provider of providers) {
    for (const command of commandList(provider?.commands, "autocomplete")) add(command);
  }

  bridgeLog.debug("command catalog built", { host: state.host, builtin: state.hostCommands.length, total: commands.length });
  return commands;
}

export async function getTuiCommands(): Promise<TuiCommand[]> {
  return buildCommandCatalog();
}

const KEY_SEQUENCES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  space: " ",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  // The host's own key legends advertise ⌃C to leave a dialog; without it the
  // mirror had no way to cancel a prompt that only exits on interrupt.
  "ctrl-c": "\x03",
};

function injectInput(sequence: string): boolean {
  ensureWrappedEditor();
  const ui = state.ui;
  if (!ui) return false;

  // These are host input-pipeline methods. terminal.write() is deliberately
  // excluded: it writes bytes to stdout and does not deliver keyboard input.
  for (const name of ["injectDebugInput", "handleInput", "input", "dispatchKey", "sendKey"]) {
    const input = asCallable(ui[name]);
    if (!input) continue;
    try {
      input.call(ui, sequence);
      return true;
    } catch {
      // Try the next host-specific input route.
    }
  }

  const focused = focusedComponent();
  const handleFocusedInput = focused ? asCallable(focused.handleInput) : undefined;
  if (handleFocusedInput) {
    try {
      handleFocusedInput.call(focused, sequence);
      const requestRender = asCallable(ui.requestRender);
      requestRender?.call(ui);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function injectKey(name: string): boolean {
  const key = name.toLowerCase();
  const sequence = KEY_SEQUENCES[key] ?? (/^ctrl-[a-z]$/.test(key) ? String.fromCharCode(key.charCodeAt(5) - 96) : undefined);
  return sequence !== undefined && injectInput(sequence);
}

function submitToHostResult(text: string): { ok: boolean; result?: unknown } {
  // OMP assigns `editor.onSubmit` after the mode is captured; the tick hook
  // installs it when it appears, so make sure that has run before submitting.
  ensureWrappedEditor();
  const editor = state.editor ?? state.defaultEditor;
  if (!editor) return { ok: false };
  const setText = asCallable(editor.setText);
  if (setText) {
    try {
      setText.call(editor, text);
    } catch (err) {
      bridgeLog.debug("TUI setText failed", { err });
      return { ok: false };
    }
  }
  const submit = asCallable(editor.onSubmit);
  if (!submit) return { ok: false };
  state.suppressLocalSubmit = true;
  try {
    return { ok: true, result: submit.call(editor, text) };
  } catch (err) {
    bridgeLog.debug("TUI submit failed", { err });
    return { ok: false };
  } finally {
    state.suppressLocalSubmit = false;
  }
}

function submitToHost(text: string): boolean {
  return submitToHostResult(text).ok;
}

export const tuiBridge: TuiBridgeAdapter & { getUnsupportedReason(): string | undefined } = {
  async ready(): Promise<void> {
    await installTuiBridge();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      ensureWrappedEditor();
      if (state.mode && state.editor && state.ui) return;
      await sleep(25);
    }
  },
  isAvailable: () => state.mode !== undefined && state.editor !== undefined && state.ui !== undefined,
  getHost: () => state.host,
  getUnsupportedReason: () => state.unsupportedReason,
  getCommands: () => getTuiCommands(),
  submit: (text: string) => submitToHost(text),
  submitResult: (text: string) => submitToHostResult(text),
  readEditorText,
  writeEditorText,
  snapshot(width: number): TuiSnapshot | undefined {
    ensureWrappedEditor();
    const text = renderScreen(width);
    if (text === undefined) return undefined;
    return { text, interactive: isInteractiveFocus(), host: state.host, width };
  },
  key: (name: string) => injectKey(name),
  write: (text: string) => text.length > 0 && injectInput(text),
  isEditorFocused,
  isInteractiveFocus,
  onLocalSubmit(listener: (text: string) => void): () => void {
    state.localSubscribers.add(listener);
    ensureWrappedEditor();
    return () => { state.localSubscribers.delete(listener); };
  },
};

/**
 * Whether the host's own components may serve prompts raised by Telegram work
 * (§4.9). Handing a prompt to the host only helps where the DialogBroker can read
 * the component afterwards: otherwise Telegram keeps a screen of arrow keys and no
 * way to answer. Both hosts qualify: a focused component the host asked a question
 * about is a dialog whatever it is shaped like (§4.1.3), and a dialog that keeps
 * its rows private is read from the frame it draws and answered with the keystrokes
 * its own legend advertises (§4.6.5).
 */
export function hostOwnsPrompts(bridge: TuiBridgeAdapter): boolean {
  return bridge.isAvailable();
}