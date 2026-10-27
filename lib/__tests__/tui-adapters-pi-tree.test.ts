/**
 * Adapter P4: pi's `/tree` session-tree selector (§4.1.4).
 *
 * Same-named fakes drive `read`/`act` with a recording `sendKey`. Row text
 * comes from the host's own `getEntryDisplayText`, so the fake renders colored
 * text like the terminal and throws on one row like the failure path.
 */
import { describe, expect, it } from "vitest";
import { pickAdapter } from "../tui/adapters/index.ts";
import { piTreeAdapter } from "../tui/adapters/pi-lists.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

/** Fake with pi's field names; the adapter keys on the class name. */
class TreeSelectorComponent {
  labelInput: { text: string } | null = null;
  treeList = {
    filteredNodes: [
      { node: { entry: { id: "root", type: "message" } }, indent: 0 },
      { node: { entry: { id: "leaf", type: "message" } }, indent: 2 },
      { node: { entry: { id: "deep", type: "message" } }, indent: 9 },
      { node: { entry: { id: "long", type: "message" } }, indent: 0 },
      { node: { entry: { id: "boom", type: "compaction" } }, indent: 1 },
    ],
    selectedIndex: 2,
    currentLeafId: "leaf",
    getEntryDisplayText(node: { entry: { id: string } }, selected: boolean): string {
      if (node.entry.id === "boom") throw new Error("host display text gone");
      const body = node.entry.id === "long" ? "L".repeat(70) : node.entry.id;
      return `\x1b[32m${body}\x1b[0m${selected ? " <" : ""}`;
    },
  };
}

class LabelingTreeSelector extends TreeSelectorComponent {
  override labelInput = { text: "new label" };
}

class BrokenTreeSelector {
  treeList = { filteredNodes: "gone" };
  labelInput = null;
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

describe("piTreeAdapter detect", () => {
  it("claims the tree selector on the pi host only, outside label mode", () => {
    const { ctx } = harness();
    expect(piTreeAdapter.detect(new TreeSelectorComponent(), ctx)).toBe(true);
    expect(piTreeAdapter.detect(new TreeSelectorComponent(), harness("omp").ctx)).toBe(false);
    expect(piTreeAdapter.detect(new LabelingTreeSelector(), ctx)).toBe(false);
    expect(piTreeAdapter.detect(new BrokenTreeSelector(), ctx)).toBe(false);
  });

  it("is picked before the generic extension-select adapter", () => {
    const { ctx } = harness();
    expect(pickAdapter(new TreeSelectorComponent(), ctx)).toBe(piTreeAdapter);
  });
});

describe("read", () => {
  it("models the tree: indent prefixes, stripped colors, truncation, fallback text", () => {
    const { ctx } = harness();
    const model = expectSelect(piTreeAdapter.read(new TreeSelectorComponent(), ctx));
    expect(model.title).toBe("Session tree");
    expect(model.total).toBe(5);
    expect(model.items.map((item) => item.label)).toEqual([
      "root",
      "· · leaf",
      `${"· ".repeat(6)}deep`, // indent 9 capped at 6
      `${"L".repeat(60)}…`, // 70 chars truncated
      "· compaction", // getEntryDisplayText threw: entry.type fallback
    ]);
  });

  it("marks the current leaf and the terminal cursor", () => {
    const { ctx } = harness();
    const model = expectSelect(piTreeAdapter.read(new TreeSelectorComponent(), ctx));
    expect(model.items.map((item) => item.current)).toEqual([false, true, false, false, false]);
    expect(model.items.map((item) => item.focused)).toEqual([false, false, true, false, false]);
    expect(model.items[1].key).toBe("1:· · leaf");
  });

  it("returns unsupported once the list shape is gone", () => {
    const { ctx } = harness();
    expect(piTreeAdapter.read(new BrokenTreeSelector(), ctx).kind).toBe("unsupported");
  });
});

describe("act", () => {
  it("chooses by walking the cursor and pressing enter", () => {
    const { ctx, sent } = harness();
    const component = new TreeSelectorComponent(); // selectedIndex 2
    expect(piTreeAdapter.act(component, { type: "choose", key: "0:root" }, ctx)).toBe(true);
    expect(sent).toEqual(["up", "up", "enter"]);
    sent.length = 0;
    expect(piTreeAdapter.act(component, { type: "choose", key: "4:· compaction" }, ctx)).toBe(true);
    expect(sent).toEqual(["down", "down", "enter"]);
  });

  it("cancels with esc and refuses everything else", () => {
    const { ctx, sent } = harness();
    const component = new TreeSelectorComponent();
    expect(piTreeAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(sent).toEqual(["esc"]);
    expect(piTreeAdapter.act(component, { type: "submit" }, ctx)).toBe(false);
    expect(piTreeAdapter.act(component, { type: "toggle", key: "0:root" }, ctx)).toBe(false);
  });

  it("refuses a key whose label no longer matches the live rows", () => {
    const { ctx, sent } = harness();
    const component = new TreeSelectorComponent();
    component.treeList.filteredNodes[0] = {
      node: { entry: { id: "root", type: "message" } },
      indent: 1,
    };
    expect(piTreeAdapter.act(component, { type: "choose", key: "0:root" }, ctx)).toBe(false);
    expect(sent).toEqual([]);
  });
});
