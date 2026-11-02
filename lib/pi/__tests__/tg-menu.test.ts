import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildConfigMenuOptions, registerTgMenuCommand, type SwitchInstanceDeps } from "../commands/tg-menu.ts";
import type { TelegramCommandDeps } from "../commands/telegram-commands.ts";
import type { TgConfigDeps } from "../commands/register.ts";
import type { CapturedAgentSession } from "../captured-session.ts";
import type { TelegramConfig } from "../../core/types.ts";
import { runWithTelegramTurn } from "../../core/turn-context.ts";

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
  let menuSession: CapturedAgentSession | undefined;
  let switchDeps: SwitchInstanceDeps;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-menu-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-menu-proj-"));

    commands = new Map();
    config = {};
    menuSession = undefined;

    const deps: TelegramCommandDeps = { getConfig: () => config };

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

  it("has no Bots or Project items (a2t manages them) and offers online topics from Telegram", async () => {
    config = { forumChatId: -100123 };
    const { ui, notifyCalls } = makeScriptedUi({ select: [] });
    await runWithTelegramTurn({ chatId: -100123, messageThreadId: 11, sourceMessageId: 51, queuedAttachments: [] },
      () => commands.get("tg")!("", makeCtx(ui)));
    const options = ui.select.mock.calls[0][1];
    expect(options).not.toContain("🤖 Bots"); expect(options).not.toContain("📁 Project");
    expect(options).toContain("🧵 Online sessions");
    expect(options).toEqual(["⚙️ Config", "🧵 Online sessions", "🛠 Debug info", "❌ Close"]);
    expect(notifyCalls).toEqual([]);
  });

  it("shows the same items in SSH", async () => {
    config = { forumChatId: -100123 };
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[0][1]).toEqual(["⚙️ Config", "🧵 Online sessions", "🛠 Debug info", "❌ Close"]);
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

  it("navigates with ui.menu when available and closes the menu on exit", async () => {
    const { ui } = makeScriptedUi({});
    const picks = ["⚙️ Config", "⬅️ Back", "⚙️ Config", "⬅️ Back", "❌ Close"];
    let i = 0;
    const menu = vi.fn(async (_title: string, _options: string[]) => picks[i++]);
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, menu, closeMenu }));
    expect(menu.mock.calls.map((c) => c[0])).toEqual([
      "Telegram Management", "⚙️ Telegram Config", "Telegram Management", "⚙️ Telegram Config", "Telegram Management",
    ]);
    expect(ui.select).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
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

  it("Back navigation: Config → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["⚙️ Config", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Online sessions with nobody online says so", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🧵 Online sessions", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("没有在线的 Pi 会话"))).toBe(true);
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