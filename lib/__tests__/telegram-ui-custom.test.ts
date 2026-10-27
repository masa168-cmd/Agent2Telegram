import { describe, expect, it, vi } from "vitest";
import { createTelegramUiRuntime, type TelegramUiContext } from "../telegram-ui.ts";

function makeTransport() {
  return {
    removeInlineKeyboard: vi.fn(async () => undefined),
    sendText: async () => [{ message_id: 1 }],
    sendButtons: vi.fn(async () => ({ message_id: 1 })),
    editText: async () => undefined,
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  } as any;
}

describe("createTelegramUiRuntime — setWidget/editor ops", () => {
  it("setWidget('goal', factory, opts) calls base.setWidget with the same args", () => {
    const baseSetWidget = vi.fn();
    const baseSetStatus = vi.fn();
    const baseTheme = { fg: (s: string) => s, bg: (s: string) => s, bold: (s: string) => s };

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          setWidget: baseSetWidget,
          setStatus: baseSetStatus,
          theme: baseTheme,
        }),
      },
    } as any;

    const transport = makeTransport();
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(123);

    const widgetFactory = ((_tui: unknown, _theme: unknown) => ({})) as any;
    const opts = { placement: "aboveEditor" as const };
    ui.setWidget("goal", widgetFactory, opts);

    expect(baseSetWidget).toHaveBeenCalledTimes(1);
    expect(baseSetWidget).toHaveBeenCalledWith("goal", widgetFactory, opts);
  });

  it("setWidget('goal', undefined) calls base.setWidget with undefined content", () => {
    const baseSetWidget = vi.fn();

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          setWidget: baseSetWidget,
          theme: { fg: (s: string) => s },
        }),
      },
    } as any;

    const transport = makeTransport();
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(456);

    ui.setWidget("goal", undefined);

    expect(baseSetWidget).toHaveBeenCalledWith("goal", undefined, undefined);
  });

  it("editor ops are no-ops (getEditorText returns '', setEditorText does nothing)", () => {
    const session = {
      extensionRunner: {
        getUIContext: () => ({
          theme: { fg: (s: string) => s },
          setWidget: () => {},
        }),
      },
    } as any;

    const transport = makeTransport();
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    const ui = runtime.create(789);

    expect(ui.getEditorText()).toBe("");
    expect(ui.getEditorComponent()).toBeUndefined();
    // These should not throw
    ui.setEditorText("hello");
    ui.pasteToEditor("hello");
    ui.setEditorComponent(undefined);
    ui.addAutocompleteProvider(() => ({} as any));
    const unsub = ui.onTerminalInput(() => undefined);
    expect(typeof unsub).toBe("function");
  });
});

// ---- telegram-ui: stateful UI forwarding to base (plan §6.3) ----

describe("createTelegramUiRuntime — stateful UI methods forward to base", () => {
  // Helper to build a runtime with a spied base UI context.
  function makeRuntimeWithSpiedBase() {
    const spies = {
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      setToolsExpanded: vi.fn(),
      getToolsExpanded: vi.fn(() => true),
      setTheme: vi.fn(() => ({ success: true })),
      getTheme: vi.fn(() => "dark"),
      getAllThemes: vi.fn(() => ["dark", "light"]),
    };

    const session = {
      extensionRunner: {
        getUIContext: () => ({
          ...spies,
          theme: { fg: (s: string) => s },
        }),
      },
    } as any;

    const transport = makeTransport();
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    return { ui: runtime.create(100), spies };
  }

  it("forwards setStatus to base with same args", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setStatus("goal", "goal: running");
    expect(spies.setStatus).toHaveBeenCalledWith("goal", "goal: running");
    ui.setStatus("goal", undefined);
    expect(spies.setStatus).toHaveBeenCalledWith("goal", undefined);
  });

  it("forwards setWorkingMessage to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setWorkingMessage("Thinking...");
    expect(spies.setWorkingMessage).toHaveBeenCalledWith("Thinking...");
    ui.setWorkingMessage(undefined);
    expect(spies.setWorkingMessage).toHaveBeenCalledWith(undefined);
  });

  it("forwards setTitle to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setTitle("My Title");
    expect(spies.setTitle).toHaveBeenCalledWith("My Title");
  });

  it("forwards setFooter and setHeader to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    const footerFactory = (() => []) as any;
    ui.setFooter(footerFactory);
    expect(spies.setFooter).toHaveBeenCalledWith(footerFactory);
    const headerFactory = (() => []) as any;
    ui.setHeader(headerFactory);
    expect(spies.setHeader).toHaveBeenCalledWith(headerFactory);
  });

  it("forwards setToolsExpanded and getToolsExpanded to base", () => {
    const { ui, spies } = makeRuntimeWithSpiedBase();
    ui.setToolsExpanded(true);
    expect(spies.setToolsExpanded).toHaveBeenCalledWith(true);
    expect(ui.getToolsExpanded()).toBe(true);
    expect(spies.getToolsExpanded).toHaveBeenCalledTimes(1);
  });

  it("forwards getAllThemes and getTheme to base", () => {
    const { ui } = makeRuntimeWithSpiedBase();
    expect(ui.getAllThemes()).toEqual(["dark", "light"]);
    expect(ui.getTheme("dark")).toBe("dark");
  });
});

// ---- createTelegramUiRuntime: modals stay Telegram-only; custom() belongs to the host ----

describe("createTelegramUiRuntime — interactive modals stay Telegram-only without a live broker", () => {
  function makeBaseRuntime(base: any) {
    const transport = makeTransport();
    const theme = base.theme ?? { fg: (s: string) => s };
    const session = { extensionRunner: { getUIContext: () => ({ ...base, theme }) } } as any;
    const runtime = createTelegramUiRuntime({ getSession: () => session, transport });
    return { runtime, transport, chatId: 1 };
  }

  it("confirm: Telegram-only — base.confirm is NOT called; result comes from Telegram callback", async () => {
    const baseConfirm = vi.fn(() => new Promise<boolean>(() => {}));
    const { runtime, transport, chatId } = makeBaseRuntime({ confirm: baseConfirm });
    const ui = runtime.create(chatId);
    const resultP = ui.confirm("Save?", "Overwrite file?");
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    // base.confirm must not be invoked — modals are Telegram-only during a Telegram turn.
    expect(baseConfirm).not.toHaveBeenCalled();
    // Telegram user taps "Yes" (callback_data form: f:<flowId>:<value>).
    runtime.resolveInput(chatId, "f:1:yes", 1, true);
    expect(await resultP).toBe(true);
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("select: Telegram-only — base.select is NOT called; result comes from Telegram callback", async () => {
    const baseSelect = vi.fn(() => new Promise<string | undefined>(() => {}));
    const { runtime, transport, chatId } = makeBaseRuntime({ select: baseSelect });
    const ui = runtime.create(chatId);
    const resultP = ui.select("Pick", ["A", "B", "C"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    expect(baseSelect).not.toHaveBeenCalled();
    // Telegram user taps option B (index 1).
    runtime.resolveInput(chatId, "f:1:s:1", 1, true);
    expect(await resultP).toBe("B");
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("custom: forwards to base.custom (the host draws it; the DialogBroker mirrors it)", async () => {
    type CustomArgs = Parameters<TelegramUiContext["custom"]>;
    type CustomResult = { questions: unknown[]; answers: unknown[]; cancelled: boolean };
    const factory = (_tui: unknown, _theme: unknown, _kb: unknown, _done: (r: unknown) => void) => ({
      render: () => [""],
      invalidate: () => {},
    });
    const baseCustom = vi.fn(async (..._callArgs: unknown[]) => ({ questions: [], answers: [], cancelled: false }));
    const { runtime, transport, chatId } = makeBaseRuntime({ custom: baseCustom });
    const ui = runtime.create(chatId);
    const options = { overlay: true };
    const raw = await ui.custom(
      factory as unknown as CustomArgs[0],
      options as unknown as CustomArgs[1],
    );
    // The stub base.custom resolves with the questionnaire-shaped result.
    const result = raw as CustomResult;
    expect(baseCustom).toHaveBeenCalledTimes(1);
    expect(baseCustom.mock.lastCall?.[0]).toBe(factory);
    expect(baseCustom.mock.lastCall?.[1]).toBe(options);
    expect(result.cancelled).toBe(false);
    // The plugin sends no Telegram prompt of its own for custom().
    expect(transport.sendButtons).not.toHaveBeenCalled();
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });

  it("confirm with no base.confirm → falls back to Telegram-only (no crash); cancel resolves false", async () => {
    const { runtime, transport, chatId } = makeBaseRuntime({});
    const ui = runtime.create(chatId);
    const resultP = ui.confirm("Save?", "Overwrite?");
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    expect(runtime.hasPendingInput(chatId)).toBe(true);
    // Cancel via /stop semantics (latest flow, raw undefined).
    runtime.resolveInput(chatId, undefined);
    expect(await resultP).toBe(false);
    expect(runtime.hasPendingInput(chatId)).toBe(false);
  });
});
