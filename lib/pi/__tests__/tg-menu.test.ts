import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock telegram-api to avoid real network calls.
const mocks = vi.hoisted(() => ({
  getTelegramBotUsername: vi.fn(),
}));

vi.mock("../../core/telegram-api.ts", () => ({
  getTelegramBotUsername: mocks.getTelegramBotUsername,
}));

// Deterministic pairing codes for the regenerate/unpair assertions.
const pairingMocks = vi.hoisted(() => ({ createTelegramPairingCode: vi.fn() }));
vi.mock("../../core/pairing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof pairingModule>();
  return { ...actual, createTelegramPairingCode: pairingMocks.createTelegramPairingCode };
});

import { buildConfigMenuOptions, registerTgMenuCommand, type SwitchInstanceDeps } from "../commands/tg-menu.ts";
import type { TelegramCommandDeps, TelegramConnectionState } from "../commands/telegram-commands.ts";
import type { TgConfigDeps } from "../commands/register.ts";
import { readBotRegistry, readProjectBinding, addBot, writeProjectBinding, clearDefaultBot } from "../../core/config.ts";
import type { CapturedAgentSession } from "../captured-session.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig } from "../../core/types.ts";
import type * as pairingModule from "../../core/pairing.ts";
import { runWithTelegramTurn } from "../../core/turn-context.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
    ...(overrides.allowedUserId === undefined ? {} : { allowedUserId: overrides.allowedUserId }),
    ...(overrides.pairingCode === undefined ? {} : {
      pairingCode: overrides.pairingCode,
      pairingCodeExpiresAt: overrides.pairingCodeExpiresAt ?? Date.now() + 10 * 60_000,
    }),
  };
}

/** Choice label for bot-list / picker menus (matches formatBotLabel in tg-menu.ts). */
function botChoiceFull(bot: BotRecord, isDefault: boolean): string {
  const marker = isDefault ? " ⭐ default" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
  const paired = bot.allowedUserId !== undefined ? "paired" : "not paired";
  return `${bot.name}${marker} · ${username} · ${paired}`;
}

/** Scripted mock UI: returns values from the script in order, one per call. */
function makeScriptedUi(script: {
  select?: string[];
  input?: string[];
  inputSecret?: string[];
  confirm?: boolean[];
}) {
  let selectIdx = 0;
  let inputIdx = 0;
  let inputSecretIdx = 0;
  let confirmIdx = 0;
  const notifyCalls: { message: string; level: string }[] = [];

  const ui = {
    notify: vi.fn((message: string, level = "info") => { notifyCalls.push({ message, level }); }),
    select: vi.fn(async (_title: string, _options: string[]) => {
      return script.select?.[selectIdx++] ?? undefined;
    }),
    input: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.input?.[inputIdx++] ?? undefined;
    }),
    inputSecret: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.inputSecret?.[inputSecretIdx++] ?? undefined;
    }),
    confirm: vi.fn(async (_title: string, _message?: string) => {
      return script.confirm?.[confirmIdx++] ?? false;
    }),
  };
  return { ui, notifyCalls };
}

describe("/tg multi-level menu", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;
  let connectionStateValue: TelegramConnectionState;
  let awaitReconcileCalls: number;
  let menuSession: CapturedAgentSession | undefined;
  let switchDeps: SwitchInstanceDeps;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-menu-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-menu-proj-"));

    commands = new Map();
    config = {};
    resolvedConfig = undefined;
    pollingActive = false;
    mocks.getTelegramBotUsername.mockReset();
    mocks.getTelegramBotUsername.mockResolvedValue("testbot");
    pairingMocks.createTelegramPairingCode.mockReset().mockReturnValue("654321");

    connectionStateValue = "disconnected";
    awaitReconcileCalls = 0;
    menuSession = undefined;

    const deps: TelegramCommandDeps = {
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
      getResolvedConfig: () => resolvedConfig,
      switchResolvedConfig: (next) => {
        resolvedConfig = next;
        config = next.config;
      },
      isTelegramEnabled: () => config.telegramEnabled === true,
      transport: {} as any,
      getConnection: () => ({
        start: () => { pollingActive = true; },
        stop: async () => { pollingActive = false; },
        isActive: () => pollingActive,
      }),
      refreshStatus: () => undefined,
      syncTelegramCommands: async () => undefined,
      startStatusHeartbeat: () => undefined,
      clearStatusError: () => undefined,
      connectionState: () => connectionStateValue,
      awaitReconcile: async () => { awaitReconcileCalls += 1; },
    };

    const configDeps: TgConfigDeps = {
      getSession: () => undefined,
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
    };

    switchDeps = {
      listSessions: async () => [],
      getForumChatId: () => config.forumChatId,
    };

    registerTgMenuCommand(
      {
        registerCommand: (name, options) => {
          commands.set(name, options.handler);
        },
      },
      deps,
      configDeps,
      switchDeps,
      undefined,
      { getSession: () => menuSession },
    );
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  const makeCtx = (ui: any, cwd?: string) => ({
    cwd: cwd ?? projectDir,
    ui,
  });

  it("registers /tg command", () => {
    expect([...commands.keys()]).toContain("tg");
  });

  it("hides global Bot/project maintenance and offers online topics in forum mode for Telegram", async () => {
    config = { forumChatId: -100123 };
    const { ui, notifyCalls } = makeScriptedUi({ select: [] });
    await runWithTelegramTurn({ chatId: -100123, messageThreadId: 11, sourceMessageId: 51, queuedAttachments: [] },
      () => commands.get("tg")!("", makeCtx(ui)));
    const options = ui.select.mock.calls[0][1];
    expect(options).not.toContain("🤖 Bots"); expect(options).not.toContain("📁 Project");
    expect(options).toContain("🧵 Online sessions");
    expect(notifyCalls).toEqual([]);
    expect(ui.inputSecret).not.toHaveBeenCalled();
  });

  it("shows Bot/project maintenance in SSH even when forum mode is enabled", async () => {
    config = { forumChatId: -100123 };
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[0][1];
    expect(options).toContain("🤖 Bots");
    expect(options).toContain("📁 Project");
    expect(options).toContain("🧵 Online sessions");
  });

  it("lists the online sessions from the gateway and shows the chosen topic's link", async () => {
    config = { forumChatId: -100123 };
    switchDeps.listSessions = async () => [{ cwd: "/fake/other", sessionId: "session-b", threadId: 22 }];
    let calls = 0;
    const notify = vi.fn();
    const ui = { notify, select: vi.fn(async (_title: string, options: string[]) => {
      calls++; return calls === 1 ? "🧵 Online sessions" : calls === 2 ? options[0] : "❌ Close";
    }) };
    await commands.get("tg")!("", makeCtx(ui));
    expect(notify).toHaveBeenCalledWith("https://t.me/c/123/22", "info");
  });

  it("Close exits the menu immediately", async () => {
    const { ui } = makeScriptedUi({ select: ["❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("select=undefined exits the menu", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot list → shows bots as selectable options", async () => {
    const bot = makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const botListCall = ui.select.mock.calls[2]; // 3rd select = Bot list (after main + Bots submenu)
    expect(botListCall[1]).toContain(botChoiceFull(bot, true));
  });

  it("Bots → Add bot → adds bot to registry", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "➕ Add bot", "⬅️ Back", "❌ Close"],
      input: ["my-menu-bot"],
      inputSecret: ["token-from-menu"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].name).toBe("my-menu-bot");
    expect(registry.bots[0].token).toBe("token-from-menu");
    expect(notifyCalls.some((c) => c.message.includes("Bot added"))).toBe(true);
  });

  it("navigates with ui.menu when available and closes the menu on exit", async () => {
    const { ui } = makeScriptedUi({});
    const picks = ["🤖 Bots", "⬅️ Back", "⚙️ Config", "⬅️ Back", "❌ Close"];
    let i = 0;
    const menu = vi.fn(async (_title: string, _options: string[]) => picks[i++]);
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, menu, closeMenu }));
    expect(menu.mock.calls.map((c) => c[0])).toEqual([
      "Telegram Management", "🤖 Bots", "Telegram Management", "⚙️ Telegram Config", "Telegram Management",
    ]);
    expect(ui.select).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot list → bot → Remove → confirms and removes", async () => {
    const bot = makeBot({ name: "toremove" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Remove", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(notifyCalls.some((c) => c.message.includes("Bot removed"))).toBe(true);
  });

  it("Bots → Bot list → bot → Remove → cancel confirm does not remove and stays on the bot", async () => {
    const bot = makeBot({ name: "keep" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Remove", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(ui.select.mock.calls[4][0]).toBe("🤖 keep"); // re-rendered bot detail (no default marker), not the list
  });

  it("Bots → Bot list → bot → Update → updates allowedUserId", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoice, "Update", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      input: ["allowedUserId", "99999"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(99999);
  });

  it("Bots → Bot list → bot detail offers Update/Pairing/Remove only (no default toggle)", async () => {
    const bot = makeBot({ name: "zeta", token: "t-z" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const detailCall = ui.select.mock.calls[3]; // 4th select = bot detail (main + Bots + Bot list + detail)
    expect(detailCall[1]).toEqual(["Update", "Pairing", "Remove", "⬅️ Back"]);
  });

  it("Bots submenu offers Add only while the agent has no Bot", async () => {
    const empty = makeScriptedUi({ select: ["🤖 Bots", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(empty.ui));
    expect(empty.ui.select.mock.calls[1][1]).toEqual(["➕ Add bot", "Bot list", "⬅️ Back"]);

    await addBot(makeBot({ name: "alpha", token: "t-a" }));
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[1][1]).toEqual(["Bot list", "⬅️ Back"]);
  });

  it("Project → shows the effective bot in the Bot label", async () => {
    const bot = makeBot({ name: "proj-bot", token: "t-p" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const projectCall = ui.select.mock.calls[1]; // 2nd select = Project submenu (after main)
    expect(projectCall[1]).toContain("Bot: proj-bot");
  });

  it("Project → second item reflects connectionState", async () => {
    const bot = makeBot({ name: "state-bot", token: "t-s" });
    await addBot(bot);
    const expected: Record<TelegramConnectionState, string> = {
      "connected": "🟢 Connected → Disconnect",
      "connecting": "🔄 Connecting → Disconnect",
      "disconnected": "⚪ Disconnected → Connect",
    };
    for (const state of Object.keys(expected) as TelegramConnectionState[]) {
      connectionStateValue = state;
      const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
      await commands.get("tg")!("", makeCtx(ui));
      const options = ui.select.mock.calls[1][1] as string[];
      expect(options).toContain(expected[state]);
    }
  });

  it("Project → no usable bot → only the Bot item (no connection row)", async () => {
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[1][1] as string[];
    expect(options).toEqual(["Bot: not set", "⬅️ Back"]);
  });

  it("Project → the Bot row only explains: each agent has one Bot", async () => {
    const bot = makeBot({ name: "only-bot", token: "t-only" });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({ select: ["📁 Project", "Bot: only-bot", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("a2t setup pi"))).toBe(true);
    expect(ui.select.mock.calls.some((call: unknown[]) => call[0] === "Bind project to bot")).toBe(false);
  });

  it("Project → ⚪ Disconnected → Connect re-enables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: false });
    connectionStateValue = "disconnected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "⚪ Disconnected → Connect", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("Telegram connected for this folder"))).toBe(true);
  });

  it("Project → 🟢 Connected → Disconnect confirms, disables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "🟢 Connected → Disconnect", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.confirm).toHaveBeenCalledWith(
      "Disconnect Telegram for this folder?",
      "Telegram will stop responding. Reconnect only from the terminal with /tg.",
    );
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("Telegram disconnected for this folder"))).toBe(true);
  });

  it("Project → Disconnect confirm cancel does not disable", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "🟢 Connected → Disconnect", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true); // unchanged
    expect(awaitReconcileCalls).toBe(0);
  });

  it("Config → Tool → sets tool level", async () => {
    // Config menu → select "🔧 Tool: brief" → pickRenderLevel shows ["  hidden", "● brief", "  full"]
    // We pick "  full" (non-current = two-space prefix)
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔧 Tool: brief", "  full", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.tool).toBe("full");
    expect(notifyCalls.some((c) => c.message.includes("Tool") && c.message.includes("full"))).toBe(true);
  });

  it("Config → Retry → sets retry count", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔄 Retry: 3", "⬅️ Back", "❌ Close"],
      input: ["7"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.retryCount).toBe(7);
    expect(notifyCalls.some((c) => c.message.includes("Retry") && c.message.includes("7"))).toBe(true);
  });

  it("Back navigation: Bots → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Project → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Config → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["⚙️ Config", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Bots → Bot list with no bots shows info message", async () => {
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Bots → Bot list → no bots → info", async () => {
    // With no bots, Bot list shows the info message instead of a picker.
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot list", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(4);
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Online sessions with nobody online says so", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🧵 Online sessions", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("没有在线的 Pi 会话"))).toBe(true);
  });

  it("Pairing page (unpaired): shows pairing instructions, New pairing code swaps the code", async () => {
    const bot = makeBot({ name: "pairbot", pairingCode: "123456" });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "New pairing code", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4]; // 5th select = pairing page
    expect(pairingCall[0]).toBe("🔑 Pairing · pairbot");
    expect(pairingCall[1]).toEqual(["New pairing code", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("/pair 123456"))).toBe(true);
    const after = (await readBotRegistry()).bots[0];
    expect(after.pairingCode).toBe("654321");
    expect(notifyCalls.some((c) => c.message.includes("/pair 654321"))).toBe(true);
  });

  it("Pairing page (paired): shows Paired user, Unpair confirms then clears allowedUserId with a new code", async () => {
    const bot = makeBot({ name: "pairbot", allowedUserId: 777 });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "Unpair", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4];
    expect(pairingCall[0]).toBe("🔑 Pairing · pairbot");
    expect(pairingCall[1]).toEqual(["Unpair", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("Paired user: 777"))).toBe(true);
    expect(ui.confirm).toHaveBeenCalledWith("Unpair?", expect.stringContaining("This chat will stop working"));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBeUndefined();
    expect(after.pairingCode).toBe("654321");
  });

  it("Pairing page: Unpair cancel keeps allowedUserId and the pairing code untouched", async () => {
    const bot = makeBot({ name: "keeppair", allowedUserId: 777, pairingCode: "111111" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot list", botChoiceFull(bot, true), "Pairing", "Unpair", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBe(777);
    expect(after.pairingCode).toBe("111111");
  });

  it("main menu lists 🛠 Debug info just before ❌ Close", async () => {
    const { ui } = makeScriptedUi({ select: ["❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options).toContain("🛠 Debug info");
    expect(options.indexOf("🛠 Debug info")).toBeLessThan(options.indexOf("❌ Close"));
  });

  it("Debug info reports the live session and returns to the main menu", async () => {
    menuSession = {
      sessionManager: { getEntries: () => [{}, {}, {}] },
      model: { provider: "anthropic", id: "claude-x" },
      thinkingLevel: "low",
      isStreaming: false,
      isCompacting: false,
    } as unknown as CapturedAgentSession;
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🛠 Debug info", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui, "/work/proj"));
    const report = notifyCalls.find((c) => c.message.startsWith("Plugin debug info"));
    expect(report).toBeDefined();
    expect(report?.message).toContain("model: anthropic/claude-x");
    expect(report?.message).toContain("entries: 3");
    // After the report the menu returns to the main list, then Close exits.
    expect(ui.select).toHaveBeenCalledTimes(2);
  });

  it("Debug info with no active session notifies an error and stays in the menu", async () => {
    menuSession = undefined;
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🛠 Debug info", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message === "No active session" && c.level === "error")).toBe(true);
    expect(notifyCalls.some((c) => c.message.startsWith("Plugin debug info"))).toBe(false);
    expect(ui.select).toHaveBeenCalledTimes(2);
  });
});

describe("buildConfigMenuOptions", () => {
  const thinkingSession = {
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    thinkingLevel: "low",
  } as unknown as CapturedAgentSession;

  it("hides the 🧠 thinking-level entry on pi (native /thinking already covers it)", () => {
    const options = buildConfigMenuOptions({}, thinkingSession, "pi");
    expect(options.some((o) => o.startsWith("🧠 Thinking level:"))).toBe(false);
    // The rest of the Config menu is unchanged on pi.
    expect(options).toContain("🔧 Tool: brief");
    expect(options.some((o) => o.startsWith("💭 Thinking:") || o.startsWith("🐚 Shell confirm:"))).toBe(false);
    expect(options.at(-1)).toBe("⬅️ Back");
  });

  it("keeps the 🧠 thinking-level entry on omp", () => {
    const options = buildConfigMenuOptions({}, thinkingSession, "omp");
    expect(options).toContain("🧠 Thinking level: low");
  });
});