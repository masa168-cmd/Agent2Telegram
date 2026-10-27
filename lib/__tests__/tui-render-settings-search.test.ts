import { describe, expect, it } from "vitest";
import { renderDialog, type RenderContext } from "../tui/render-telegram.ts";
import type { DialogModel } from "../tui/model.ts";

const CTX: RenderContext = { sessionId: "s1", generation: 1 };

function settingsModel(search?: { query: string }): DialogModel {
  return {
    kind: "settings",
    title: "Settings",
    items: [{ key: "think", label: "Thinking", value: "On", values: ["On", "Off"] }],
    ...(search ? { search } : {}),
  };
}

describe("settings subtitle carries the search state", () => {
  it("names the active query", () => {
    expect(renderDialog(settingsModel({ query: "abc" }), CTX).text).toContain("🔍 abc");
  });

  it("prompts for a term while the box is empty", () => {
    expect(renderDialog(settingsModel({ query: "" }), CTX).text).toContain("🔍 Type to search");
  });

  it("stays silent when the page has no search box", () => {
    expect(renderDialog(settingsModel(), CTX).text).not.toContain("🔍");
  });
});
