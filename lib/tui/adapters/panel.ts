/**
 * Adapters #12/#13 — everything that is not a dialog (§4.6.4).
 *
 * A *panel* is read-only: it renders text and owns focus, so nothing can be
 * typed while it is up (a loader, a history view, a debug view). It gets an
 * info model: the text plus one way out.
 *
 * *Unsupported* is the last resort for anything interactive we cannot parse:
 * the Telegram message says plainly that the dialog needs the terminal, and
 * Escape is the only key that ever goes in. We never mirror the screen —
 * arrow keys over an unparsed frame guess at what the dialog meant (§4.6.5 #13,
 * decision 47).
 */
import type { DialogAdapter, DialogModel } from "../model.ts";
import { isReadOnlyPanel } from "../find-shape.ts";
import { constructorName, renderText } from "./utils.ts";

/**
 * Whether Escape does more than close the view. pi's `BorderedLoader` keeps no
 * stop method: it carries the host's own `cancellable` flag plus an AbortSignal
 * that Escape aborts through, so both shapes count.
 */
const cancellable = (component: object): boolean => {
  const record = component as Record<string, unknown>;
  if (["cancel", "stop", "abort"].some((name) => typeof record[name] === "function")) return true;
  return record.cancellable === true && "signal" in record;
};

export const infoPanelAdapter: DialogAdapter = {
  id: "info-panel",

  detect(component, ctx) {
    if (ctx.entry?.kind === "panel") return true;
    return isReadOnlyPanel(component);
  },

  read(component, ctx): DialogModel {
    const text = renderText(component).trim();
    if (cancellable(component)) return { kind: "progress", text, cancellable: true };
    return { kind: "info", title: ctx.entry?.title, text, closable: true };
  },

  act(_component, action, ctx) {
    // Read-only means read-only: Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};

export const unsupportedAdapter: DialogAdapter = {
  id: "unsupported",
  detect() {
    // Last in the registry: it matches anything, so it must be asked last.
    return true;
  },

  read(component, ctx): DialogModel {
    // No frame is read: there is nothing to mirror, only something to name.
    const what = ctx.entry?.method ?? (constructorName(component) || "unknown");
    return { kind: "unsupported", title: ctx.entry?.title, what };
  },

  act(_component, action, ctx) {
    // Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};
