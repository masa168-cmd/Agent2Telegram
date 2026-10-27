/**
 * Adapter #10 - OMP's tool-approval dialog (§4.6.4).
 *
 * With a race handle on the entry (§4.12) the dialog is the built-in tool
 * approval behind a raced `ui.approve` call: the answers are the fixed
 * once/session/deny set the method resolves with, so the adapter never looks
 * at the screen.
 *
 * Without a handle the adapter declines. The keys such a dialog answers to are
 * whatever its own legend advertises, and those differ between hosts and
 * versions - reading them out of the drawn frame is gone (§4.6.6 exception 2).
 * A button that presses a key nobody listens for is worse than no button at all,
 * so the snapshot adapter takes over instead, which still leaves the terminal's
 * own keys and the escape hatch.
 */
import type { DialogAdapter, DialogModel } from "../model.ts";

type Option = { key: string; label: string };

/** The longest prompt the entry carried, which is the question being asked. */
function detailOf(entry: { approval?: { full?: string; compact?: string; session?: string } }): string | undefined {
  const values = [entry.approval?.full, entry.approval?.compact, entry.approval?.session].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return values.length > 0 ? values.sort((a, b) => b.length - a.length).join("\n") : undefined;
}

/** The answers a raced `ui.approve` resolves with; the session row only when the prompt carries one. */
function raceOptions(entry: { approval?: { session?: string } }): Option[] {
  return [
    { key: "once", label: "Allow once" },
    ...(entry.approval?.session ? [{ key: "session", label: entry.approval.session }] : []),
    { key: "deny", label: "Deny" },
  ];
}

export const approvalAdapter: DialogAdapter = {
  id: "omp-approval",

  detect(component, ctx) {
    // Only a raced approve is claimable: without the handle nothing says which
    // keys the dialog actually listens for.
    return ctx.entry?.kind === "approval" && ctx.entry.race !== undefined;
  },

  read(component, ctx): DialogModel {
    const entry = ctx.entry;
    return {
      kind: "approval",
      title: entry?.title ?? "Tool approval",
      detail: entry ? detailOf(entry) : undefined,
      options: entry ? raceOptions(entry) : [],
    };
  },

  act(component, action, ctx) {
    const race = ctx.entry?.race;
    if (!race || race.settled) return false;
    if (action.type === "cancel") {
      race.answer("deny");
      return true;
    }
    if (action.type === "approve" && (action.key === "once" || action.key === "session" || action.key === "deny")) {
      race.answer(action.key);
      return true;
    }
    return false;
  },
};
