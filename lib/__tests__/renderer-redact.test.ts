import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerTelegramRenderer } from "../renderer.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "../turn-context.ts";
import { SecretStore } from "../tui/secrets.ts";
import type { TelegramTransport, TelegramTurn } from "../types.ts";

const SECRET = "sk-a&b<c>d-12345";
const CHAT = 111;

function createHarness(options: { tool?: "hidden" | "brief" | "full"; secrets?: SecretStore } = {}) {
  const handlers = new Map<string, Array<(event: unknown) => Promise<void>>>();
  const sent: Array<{ chatId: number; text: string; richMarkdown?: string }> = [];
  const transport: TelegramTransport = {
    removeInlineKeyboard: async () => undefined,
    sendText: async (chatId, text, _messageThreadId, _replyToMessageId, richMarkdown) => {
      sent.push({ chatId, text, richMarkdown });
      return [{ message_id: sent.length }];
    },
    sendButtons: async () => ({ message_id: 1 }),
    editText: async (chatId, _messageId, text, richMarkdown) => {
      sent.push({ chatId, text, richMarkdown });
    },
    editButtons: async () => undefined,
    answerCallbackQuery: async () => undefined,
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
  const pi = {
    on: (event: string, handler: (event: unknown) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  // Only `on` is exercised; the rest of the extension API is irrelevant here.
  registerTelegramRenderer(pi as unknown as ExtensionAPI, {
    getConfig: () => ({ botToken: "token", activeChatId: CHAT, tool: options.tool ?? "brief", thinking: "brief" }),
    transport,
    getActiveTurn: () => getCurrentTelegramTurn(),
    hasActiveTurns: () => true,
    secrets: options.secrets,
  });

  const emit = async (event: string, payload: unknown) => {
    await Promise.all((handlers.get(event) ?? []).map((handler) => handler(payload)));
  };

  return { emit, sent };
}

function storeWithSecret(): SecretStore {
  const store = new SecretStore();
  store.remember(`${CHAT}:main`, "flow-1", SECRET);
  return store;
}

describe("assistant replies redact secrets (§4.7.4)", () => {
  it("redacts the final answer in both the HTML and the Rich Markdown payload", async () => {
    const { emit, sent } = createHarness({ secrets: storeWithSecret() });
    const turn: TelegramTurn = { chatId: CHAT, queuedAttachments: [] };
    const body = `The key is ${SECRET}\n\n| Name | Value |\n| --- | --- |\n| key | ${SECRET} |`;

    await runWithTelegramTurn(turn, () => emit("message_end", { message: { role: "assistant", content: body } }));

    expect(sent).toHaveLength(1);
    expect(sent[0].richMarkdown).toBeDefined();
    expect(sent[0].text).not.toContain(SECRET);
    expect(sent[0].richMarkdown).not.toContain(SECRET);
    expect(sent[0].richMarkdown).toContain("***");
  });

  it("redacts the inline tool-call hint before it is escaped", async () => {
    const { emit, sent } = createHarness({ tool: "brief", secrets: storeWithSecret() });
    const turn: TelegramTurn = { chatId: CHAT, queuedAttachments: [] };

    await runWithTelegramTurn(turn, () => emit("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com` },
    }));

    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) {
      expect(message.text).not.toContain(SECRET);
      expect(message.text).not.toMatch(/&(amp|lt|gt)[^;]/);
    }
    expect(sent.some((message) => message.text.includes("***"))).toBe(true);
  });

  it("redacts full tool output before it becomes HTML", async () => {
    const { emit, sent } = createHarness({ tool: "full", secrets: storeWithSecret() });
    const turn: TelegramTurn = { chatId: CHAT, queuedAttachments: [] };

    await runWithTelegramTurn(turn, () => emit("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: `export OPENAI_API_KEY=${SECRET}` }] },
    }));

    expect(sent.length).toBeGreaterThan(0);
    // Substitution, not escaping, is what hides it: the escaped form already
    // lacks the raw `&<>` value.
    expect(sent.some((message) => message.text.includes("***"))).toBe(true);
    for (const message of sent) expect(message.text).not.toContain(SECRET);
  });

  it("leaves short values alone, because they are never tracked", async () => {
    const short = "sk-&<>b";
    const secrets = storeWithSecret();
    secrets.remember(`${CHAT}:main`, "flow-2", short);
    const { emit, sent } = createHarness({ secrets });
    const turn: TelegramTurn = { chatId: CHAT, queuedAttachments: [] };

    await runWithTelegramTurn(turn, () => emit("message_end", {
      message: { role: "assistant", content: `short value ${short} stays as is` },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("sk-&amp;&lt;&gt;b");
    expect(sent[0].text).not.toContain("***");
  });

  it("renders normally when no secret store is wired in", async () => {
    const { emit, sent } = createHarness();
    const turn: TelegramTurn = { chatId: CHAT, queuedAttachments: [] };

    await runWithTelegramTurn(turn, () => emit("message_end", {
      message: { role: "assistant", content: `The key is ${SECRET}` },
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("sk-a&amp;b&lt;c&gt;d-12345");
  });
});
