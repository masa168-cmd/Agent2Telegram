/**
 * Adapter P1: pi's built-in list selectors (§4.1.4).
 *
 * Half of this file drives same-named fakes through `read`/`act` with a
 * recording `sendKey`; the last block drives the real pi 1.4.0 components so a
 * host upgrade that renames a field or re-points a key fails here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as host from "@earendil-works/pi-coding-agent";
import { TrustSelectorComponent as RealTrustSelectorComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/trust-selector.js";
import { pickAdapter } from "../tui/adapters/index.ts";
import { piListAdapter } from "../tui/adapters/pi-lists.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

/** Fake components with pi's field names; the adapter keys on the class name. */
class ModelSelectorComponent {
  filteredModels = [
    { provider: "anthropic", id: "claude-opus", model: {} },
    { provider: "openai", id: "gpt-5", model: {} },
    { provider: "google", id: "gemini", model: {} },
    { provider: "local", id: "qwen", model: {} },
  ];
  currentModel: { provider: string; id: string } | null = { provider: "openai", id: "gpt-5" };
  selectedIndex = 1;
}

class ScopedModelsSelectorComponent {
  filteredItems = [
    { fullId: "anthropic/claude-opus", model: {}, enabled: true },
    { fullId: "openai/gpt-5", model: {}, enabled: false },
    { fullId: "local/qwen", model: {}, enabled: true },
  ];
  selectedIndex = 0;
}

class OAuthSelectorComponent {
  mode = "login";
  filteredProviders = [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ];
  selectedIndex = 0;
}

class TrustSelectorComponent {
  trustOptions = [
    { label: "Trust", trusted: true, savedPath: "/repo" },
    { label: "Do not trust", trusted: false, savedPath: "/repo" },
  ];
  savedDecision: { path: string; decision: boolean } | null = { path: "/repo", decision: false };
  selectedIndex = 1;
}

class UserMessageList {
  messages = [
    { id: "e1", text: "first\nmessage" },
    { id: "e2", text: "x".repeat(70) },
    { id: "e3", text: "short" },
  ];
  selectedIndex = 2;
}

class SomeUnknownSelector {
  filteredRows = [{ label: "a" }];
  selectedIndex = 0;
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

describe("piListAdapter detect", () => {
  it("claims the known pi selectors on the pi host only", () => {
    const { ctx } = harness();
    expect(piListAdapter.detect(new ModelSelectorComponent(), ctx)).toBe(true);
    expect(piListAdapter.detect(new ScopedModelsSelectorComponent(), ctx)).toBe(true);
    expect(piListAdapter.detect(new OAuthSelectorComponent(), ctx)).toBe(true);
    expect(piListAdapter.detect(new TrustSelectorComponent(), ctx)).toBe(true);
    expect(piListAdapter.detect(new UserMessageList(), ctx)).toBe(true);
    expect(piListAdapter.detect(new ModelSelectorComponent(), harness("omp").ctx)).toBe(false);
    expect(piListAdapter.detect(new SomeUnknownSelector(), ctx)).toBe(false);
  });

  it("is picked before the generic filteredRows adapter", () => {
    const { ctx } = harness();
    expect(pickAdapter(new ModelSelectorComponent(), ctx)).toBe(piListAdapter);
    expect(pickAdapter(new UserMessageList(), ctx)).toBe(piListAdapter);
  });
});

describe("read", () => {
  it("models the model selector from filteredModels and currentModel", () => {
    const { ctx } = harness();
    const model = expectSelect(piListAdapter.read(new ModelSelectorComponent(), ctx));
    expect(model.title).toBe("Select model");
    expect(model.total).toBe(4);
    expect(model.multi).toBeUndefined();
    expect(model.items.map((item) => item.label)).toEqual([
      "anthropic/claude-opus",
      "openai/gpt-5",
      "google/gemini",
      "local/qwen",
    ]);
    expect(model.items.map((item) => item.key)).toEqual([
      "0:anthropic/claude-opus",
      "1:openai/gpt-5",
      "2:google/gemini",
      "3:local/qwen",
    ]);
    expect(model.items.map((item) => item.current)).toEqual([false, true, false, false]);
    expect(model.items.map((item) => item.focused)).toEqual([false, true, false, false]);
    expect(model.items.every((item) => item.checked === undefined)).toBe(true);
  });

  it("models scoped models as a multi-select with enabled checkboxes", () => {
    const { ctx } = harness();
    const model = expectSelect(piListAdapter.read(new ScopedModelsSelectorComponent(), ctx));
    expect(model.title).toBe("Model Configuration");
    expect(model.multi).toBe(true);
    expect(model.items.map((item) => item.label)).toEqual(["anthropic/claude-opus", "openai/gpt-5", "local/qwen"]);
    expect(model.items.map((item) => item.checked)).toEqual([true, false, true]);
    expect(model.items[0].focused).toBe(true);
    expect(model.items.every((item) => item.current === undefined)).toBe(true);
  });

  it("titles the OAuth selector by its mode", () => {
    const { ctx } = harness();
    const login = new OAuthSelectorComponent();
    expect(expectSelect(piListAdapter.read(login, ctx)).title).toBe("Select provider to configure");
    login.mode = "logout";
    const logout = expectSelect(piListAdapter.read(login, ctx));
    expect(logout.title).toBe("Select provider to logout");
    expect(logout.items.map((item) => item.label)).toEqual(["Anthropic", "OpenAI"]);
  });

  it("marks the trust row that matches the saved decision", () => {
    const { ctx } = harness();
    const model = expectSelect(piListAdapter.read(new TrustSelectorComponent(), ctx));
    expect(model.title).toBe("Project trust");
    expect(model.items.map((item) => item.label)).toEqual(["Trust", "Do not trust"]);
    expect(model.items.map((item) => item.current)).toEqual([false, true]);
    expect(model.items[1].focused).toBe(true);
  });

  it("flattens fork messages to one truncated line each", () => {
    const { ctx } = harness();
    const model = expectSelect(piListAdapter.read(new UserMessageList(), ctx));
    expect(model.title).toBe("Select message");
    expect(model.items.map((item) => item.label)).toEqual(["first message", `${"x".repeat(60)}…`, "short"]);
    expect(model.items[2].focused).toBe(true);
  });
});

describe("act", () => {
  it("walks the cursor down and presses enter to choose", () => {
    const { ctx, sent } = harness();
    const component = new ModelSelectorComponent(); // selectedIndex 1
    expect(piListAdapter.act(component, { type: "choose", key: "3:local/qwen" }, ctx)).toBe(true);
    expect(sent).toEqual(["down", "down", "enter"]);
  });

  it("toggles a scoped row with movement plus enter", () => {
    const { ctx, sent } = harness();
    const component = new ScopedModelsSelectorComponent(); // selectedIndex 0
    expect(piListAdapter.act(component, { type: "toggle", key: "2:local/qwen" }, ctx)).toBe(true);
    expect(sent).toEqual(["down", "down", "enter"]);
  });

  it("saves scoped models with ctrl+s, then closes with esc", () => {
    const { ctx, sent } = harness();
    expect(piListAdapter.act(new ScopedModelsSelectorComponent(), { type: "submit" }, ctx)).toBe(true);
    expect(sent).toEqual(["ctrl-s", "esc"]);
  });

  it("cancels with esc", () => {
    const { ctx, sent } = harness();
    expect(piListAdapter.act(new ModelSelectorComponent(), { type: "cancel" }, ctx)).toBe(true);
    expect(sent).toEqual(["esc"]);
  });

  it("refuses a row that is gone, a mismatched action, and unmapped actions", () => {
    const { ctx, sent } = harness();
    expect(piListAdapter.act(new ModelSelectorComponent(), { type: "choose", key: "9:gone" }, ctx)).toBe(false);
    expect(piListAdapter.act(new ModelSelectorComponent(), { type: "toggle", key: "1:openai/gpt-5" }, ctx)).toBe(false);
    expect(piListAdapter.act(new ScopedModelsSelectorComponent(), { type: "choose", key: "0:anthropic/claude-opus" }, ctx)).toBe(false);
    expect(piListAdapter.act(new ModelSelectorComponent(), { type: "submit" }, ctx)).toBe(false);
    expect(piListAdapter.act(new ModelSelectorComponent(), { type: "submenu", key: "1:openai/gpt-5" }, ctx)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("contract: real pi 1.4.0 components", () => {
  beforeAll(() => {
    host.initTheme("dark");
  });

  /** Keys go through the component's own handleInput, like the Broker. */
  function realCtx(component: object): AdapterContext {
    return { host: "pi", sendKey: (name) => sendKeyTo(component, name), requestRender: () => {} };
  }

  it("fork: labels match the message fields and choose answers onSelect", () => {
    const picked: string[] = [];
    const selector = new host.UserMessageSelectorComponent(
      [
        { id: "a", text: "alpha one" },
        { id: "b", text: "beta\ntwo" },
        { id: "c", text: "gamma three" },
      ],
      (entryId) => picked.push(entryId),
      () => {},
    );
    const list = selector.getMessageList();
    const ctx = realCtx(list);
    expect(piListAdapter.detect(list, ctx)).toBe(true);
    const model = expectSelect(piListAdapter.read(list, ctx));
    // pi's `private` is compile-time only; these instance fields exist at runtime.
    const listFields = list as unknown as Record<string, unknown>;
    const messages = listFields.messages as { id: string; text: string }[];
    expect(model.items.map((item) => item.label)).toEqual(messages.map((m) => m.text.replace(/\n/g, " ").trim()));
    // With no initial id the terminal cursor starts on the newest message.
    expect(model.items[2].focused).toBe(true);
    expect(piListAdapter.act(list, { type: "choose", key: "0:alpha one" }, ctx)).toBe(true);
    expect(picked).toEqual(["a"]);
  });

  it("trust: labels come from trustOptions and choose answers onSelect", () => {
    const selections: { trusted: boolean }[] = [];
    const trust = new RealTrustSelectorComponent({
      cwd: process.cwd(),
      savedDecision: null,
      projectTrusted: false,
      onSelect: (selection) => selections.push(selection),
      onCancel: () => {},
    });
    const ctx = realCtx(trust);
    expect(piListAdapter.detect(trust, ctx)).toBe(true);
    const model = expectSelect(piListAdapter.read(trust, ctx));
    // Same compile-time-only privacy as above.
    const trustFields = trust as unknown as Record<string, unknown>;
    const options = trustFields.trustOptions as { label: string }[];
    expect(model.title).toBe("Project trust");
    expect(model.items.map((item) => item.label)).toEqual(options.map((option) => option.label));
    expect(model.items.every((item) => item.current === false)).toBe(true);
    const target = model.items.findIndex((item) => item.label === "Do not trust");
    expect(target).toBeGreaterThan(-1);
    expect(piListAdapter.act(trust, { type: "choose", key: model.items[target].key }, ctx)).toBe(true);
    expect(selections).toHaveLength(1);
    expect(selections[0].trusted).toBe(false);
  });
});
