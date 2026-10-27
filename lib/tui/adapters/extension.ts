/**
 * Adapters #1-#3: the three shapes the host's own dialog entry methods produce
 * (§4.6.4). They all end in the same place — the focused component's own input
 * handler — so Telegram never reimplements a decision the host already made.
 *
 * pi 1.4.0 renders all three through `Extension{Selector,Input,Editor}
 * Component`, thin wrappers: the selector keeps its options in a plain
 * `string[]`, the input delegates to a pi-tui `Input`, the editor to a pi-tui
 * `Editor`. OMP's equivalents keep their data in closures, so each adapter
 * falls back to the entry info captured at the entry point and to typing
 * through `handleInput` (§4.1.3).
 */
import type { DialogAdapter, DialogItem, DialogModel } from "../model.ts";
import { findShape, isEditorShape, isInputShape, isSelectList } from "../find-shape.ts";
import { setInputValue } from "../keys.ts";
import { descriptionOf, labelOf, plain, resolveRowKey, rowKey, selectRow } from "./utils.ts";

type HostRecord = Record<string, unknown>;
type Rows = { labels: string[]; descriptions: (string | undefined)[]; cursor: number };

const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The live rows plus the terminal cursor. `options: string[]` is the pi
 * extension selector; a `SelectList` (possibly wrapped, e.g. by
 * `ThemeSelector`) is the pi-tui control.
 */
function selectListRows(component: object): Rows | undefined {
  const record = component as HostRecord;
  const cursor = readNumber(record.selectedIndex);
  if (Array.isArray(record.options) && record.options.every((item) => typeof item === "string")) {
    const labels = record.options as string[];
    return { labels, descriptions: labels.map(() => undefined), cursor };
  }
  const list = isSelectList(component) ? component : findShape(component, isSelectList, 2);
  if (!list) return undefined;
  const filtered = Array.isArray(list.filteredItems) ? (list.filteredItems as unknown[]) : [];
  const items = filtered.length > 0 ? filtered : (Array.isArray(list.items) ? (list.items as unknown[]) : []);
  if (items.length === 0) return undefined;
  return { labels: items.map(labelOf), descriptions: items.map(descriptionOf), cursor: readNumber(list.selectedIndex) };
}

/** Rows a hand-drawn component keeps in a `filtered*` array (§4.1.4). */
function filteredRows(component: object): Rows | undefined {
  const record = component as HostRecord;
  const key = Object.keys(record).find((name) => /^filtered[A-Z]/.test(name) && Array.isArray(record[name]));
  if (!key) return undefined;
  const items = record[key] as unknown[];
  if (items.length === 0) return undefined;
  return { labels: items.map(labelOf), descriptions: items.map(descriptionOf), cursor: record["selectedIndex"] !== undefined ? readNumber(record["selectedIndex"]) : 0 };
}

const rowsOf = (component: object): Rows | undefined => selectListRows(component) ?? filteredRows(component);

function buildItems(rows: Rows): DialogItem[] {
  return rows.labels.map((label, index) => ({
    key: rowKey(index, label),
    label,
    description: rows.descriptions[index],
    focused: index === rows.cursor,
  }));
}

/** `showExtensionConfirm` keeps title and message apart; the selector joins them. */
function splitTitle(title: string): { title: string; message?: string } {
  const newline = title.indexOf("\n");
  if (newline < 0) return { title };
  return { title: title.slice(0, newline).trim(), message: title.slice(newline + 1).trim() };
}

const YES_NO = new Set(["yes", "no"]);

/**
 * Adapter #1 — anything shaped like a list of choices: the extension selector,
 * the extension confirm (which *is* a selector over Yes/No on pi), and a bare
 * pi-tui `SelectList`.
 */
export const extensionSelectAdapter: DialogAdapter = {
  id: "ext-select",

  detect(component, ctx) {
    const kind = ctx.entry?.kind;
    if (kind === "select" || kind === "confirm") return true;
    return rowsOf(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const entry = ctx.entry;
    const rows = rowsOf(component);
    const labels = rows ? rows.labels : (entry?.options ?? []);
    const rawTitle = (component as HostRecord).baseTitle;
    const title = typeof rawTitle === "string" && rawTitle.length > 0 ? plain(rawTitle) : (entry?.title ?? "Choose");

    // A two-option Yes/No list is a confirmation, whichever way it arrived:
    // pi's `showExtensionConfirm` draws it through the selector, and its title
    // carries the message after a newline.
    const looksConfirmed = entry?.kind === "confirm"
      || (labels.length === 2 && labels.every((label) => YES_NO.has(label.toLowerCase())) && title.includes("\n"));
    if (looksConfirmed) {
      const parts = splitTitle(title);
      return { kind: "confirm", title: parts.title, message: entry?.message ?? parts.message };
    }

    if (labels.length === 0) {
      // Nothing readable: say plainly that Telegram cannot handle it, so the
      // chat still keeps its escape hatch (§4.6.5 #13).
      return { kind: "unsupported", title, what: "ext-select: no readable options" };
    }

    const items: DialogItem[] = rows
      ? buildItems(rows)
      : labels.map((label, index) => ({ key: rowKey(index, label), label }));
    return { kind: "select", title, items, total: labels.length };
  },

  act(component, action, ctx) {
    // The extension's own `select` call may be racing the host dialog (§4.12):
    // the tap then answers that call directly and the host closes itself; the
    // keystroke path below is only the fallback (no handle, or already settled).
    const race = ctx.entry?.race;
    if (race && !race.settled && ctx.entry?.kind === "select") {
      if (action.type === "cancel") return race.answer(undefined);
      if (action.type === "choose") {
        const labels = ctx.entry.options ?? [];
        const index = resolveRowKey(labels, action.key);
        return index === undefined ? false : race.answer(labels[index]);
      }
    }
    // pi's `confirm` answers through its own outer call, which is the entry the
    // handle hangs on: yes/no go straight to the promise, cancel is a "no" -
    // pi's own cancel returns false anyway, and aborting closes the dialog.
    if (race && !race.settled && ctx.entry?.kind === "confirm") {
      if (action.type === "cancel") return race.answer(false);
      if (action.type === "confirm") return race.answer(action.yes);
    }
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "choose" && action.type !== "toggle" && action.type !== "confirm") return false;

    // Labels come from the component when it exposes its rows, and from the entry
    // call otherwise: OMP keeps them in closures with no readable field.
    const rows = rowsOf(component);
    const labels = rows?.labels ?? ctx.entry?.options ?? (ctx.entry?.kind === "confirm" ? ["Yes", "No"] : []);
    if (labels.length === 0) return false;

    let target: number | undefined;
    if (action.type === "confirm") {
      // Confirm maps to the Yes/No rows the host actually rendered; a dialog
      // whose labels changed underneath us resolves to nothing.
      const lowered = labels.map((label) => label.toLowerCase());
      target = lowered.includes("yes") || lowered.includes("no")
        ? (action.yes ? lowered.indexOf("yes") : lowered.indexOf("no"))
        : (action.yes ? 0 : 1);
      if (target !== undefined && target < 0) return false;
    } else {
      target = resolveRowKey(labels, action.key);
    }
    if (target === undefined) return false;

    // Move with arrow keys instead of writing `selectedIndex`: that is the only path that
    // makes the component redraw its own cursor (§4.1.3). A component whose rows live in
    // private fields no longer has its cursor read out of the drawn frame: those dialogs
    // are answered through their race handle or their semantic description, so this
    // fallback refuses rather than guessing where the cursor sits.
    if (!rows) return false;
    return selectRow(ctx.sendKey, rows.cursor, target);
  },
};

/**
 * Adapter #2 — one-line text input (`ui.input`, `ui.inputSecret`,
 * `showExtensionInput`, OMP's `showHookInput`).
 */
export const extensionInputAdapter: DialogAdapter = {
  id: "ext-input",

  detect(component, ctx) {
    // The entry call is the authority: `ui.input` / `showExtensionInput` promises a
    // one-line answer. pi wraps its `Input` in a container and other hosts build the
    // field later, so requiring the shape lost dialogs that are perfectly answerable -
    // `read` and `act` already fall back to the component itself.
    return ctx.entry?.kind === "input";
  },

  read(component, ctx): DialogModel {
    const record = component as HostRecord;
    const input = isInputShape(component) ? record : findShape(component, isInputShape, 2);
    const getValue = input ? (input as HostRecord).getValue : undefined;
    const prefill = typeof getValue === "function" ? String((getValue as () => string).call(input) ?? "") : "";
    const title = typeof record.baseTitle === "string" && record.baseTitle.length > 0
      ? plain(record.baseTitle)
      : (ctx.entry?.title ?? "Input");
    return {
      kind: "input",
      title,
      placeholder: ctx.entry?.placeholder,
      secret: ctx.entry?.secret === true,
      prefill: prefill.length > 0 ? prefill : undefined,
    };
  },

  act(component, action, ctx) {
    // The extension's own `input` call may be racing the host dialog (§4.12):
    // the reply answers that call directly; typing + Enter below is the fallback.
    const race = ctx.entry?.race;
    if (race && !race.settled && ctx.entry?.kind === "input") {
      if (action.type === "cancel") return race.answer(undefined);
      if (action.type === "submit") return race.answer(action.text ?? "");
    }
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "submit") return false;
    const text = action.text ?? "";
    const input = isInputShape(component) ? component : findShape(component, isInputShape, 2);
    // Clearing and typing into the component's own input keeps cursor and
    // undo state coherent; Enter then runs the host's submit handler.
    if (!setInputValue(input ?? component, text)) return false;
    return ctx.sendKey("enter");
  },
};

/**
 * Adapter #3 — multi-line editor (`ui.editor`, `showExtensionEditor`, OMP's
 * `showCollabAwareEditor`). Terminal-only by design (§4.8.3): Telegram mirrors
 * it and accepts a whole reply; editing keeps happening locally.
 */
export const extensionEditorAdapter: DialogAdapter = {
  id: "ext-editor",

  detect(component, ctx) {
    if (ctx.entry?.kind !== "editor") return false;
    return isEditorShape(component) || findShape(component, isEditorShape, 2) !== undefined;
  },

  read(component, ctx): DialogModel {
    const record = component as HostRecord;
    const editor = isEditorShape(component) ? record : findShape(component, isEditorShape, 2);
    const getText = editor ? (editor as HostRecord).getText : undefined;
    const prefill = typeof getText === "function" ? String((getText as () => string).call(editor) ?? "") : "";
    return {
      kind: "editor",
      title: typeof record.baseTitle === "string" && record.baseTitle.length > 0
        ? plain(record.baseTitle)
        : (ctx.entry?.title ?? "Editor"),
      prefill: prefill.length > 0 ? prefill : (ctx.entry?.prefill ?? undefined),
    };
  },

  act(component, action, ctx) {
    // OMP's raced editor: the extension's own `editor` call takes the answer
    // directly, and its signal closes the dialog (~2 ms, S25) - no keys.
    const race = ctx.entry?.kind === "editor" ? ctx.entry.race : undefined;
    if (race && !race.settled) {
      if (action.type === "cancel") return race.answer(undefined), true;
      if (action.type === "submit") return race.answer(action.text ?? ""), true;
    }
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "submit") return false;
    const text = action.text ?? "";
    const editor = isEditorShape(component) ? component : findShape(component, isEditorShape, 2);
    const setText = editor ? (editor as HostRecord).setText : undefined;
    if (typeof setText === "function") {
      // The editor advertises a setter, so using it is allowed (§4.1.3).
      try {
        (setText as (value: string) => void).call(editor, text);
      } catch {
        return false;
      }
      return ctx.sendKey("enter");
    }
    if (!setInputValue(component, text)) return false;
    return ctx.sendKey("enter");
  },
};
