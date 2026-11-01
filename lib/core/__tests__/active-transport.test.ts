import { describe, expect, it, vi } from "vitest";
import { createActiveTelegramTransport } from "../active-transport.ts";
import type { TelegramTransport } from "../types.ts";

function createTransport(sent: string[]): TelegramTransport {
    return {
        removeInlineKeyboard: async () => undefined,
        sendText: vi.fn(async (_chatId, text) => {
            sent.push(text);
            return [{ message_id: sent.length }];
        }),
        sendButtons: async () => ({ message_id: 1 }),
        editText: async () => undefined,
        editButtons: async () => undefined,
        answerCallbackQuery: async () => undefined,
        deleteMessage: async () => undefined,
        sendDocument: async () => undefined,
        sendPhoto: async () => undefined,
        sendChatAction: async () => undefined,
    };
}

describe("createActiveTelegramTransport", () => {
    it("suppresses outbound sends from a standby instance", async () => {
        const sent: string[] = [];
        const base = createTransport(sent);
        const transport = createActiveTelegramTransport(base, { isActive: () => false });

        expect(await transport.sendText(42, "hidden")).toEqual([]);
        await transport.sendChatAction(42, "typing");

        expect(sent).toEqual([]);
        expect(base.sendText).not.toHaveBeenCalled();
    });

    it("waits for replay readiness and preserves send order", async () => {
        const sent: string[] = [];
        let release: () => void = () => undefined;
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transport = createActiveTelegramTransport(createTransport(sent), {
            isActive: () => true,
            waitUntilReady: () => ready,
        });

        const first = transport.sendText(42, "first");
        const second = transport.sendText(42, "second");
        await Promise.resolve();
        expect(sent).toEqual([]);

        release();
        await Promise.all([first, second]);
        expect(sent).toEqual(["first", "second"]);
    });

    it("drops queued output when the active generation changes during replay", async () => {
        const sent: string[] = [];
        let generation = 1;
        let release: () => void = () => undefined;
        const ready = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transport = createActiveTelegramTransport(createTransport(sent), {
            isActive: () => true,
            getLease: () => generation,
            waitUntilReady: () => ready,
        });

        const pending = transport.sendText(42, "stale output");
        generation = 2;
        release();

        expect(await pending).toEqual([]);
        expect(sent).toEqual([]);
    });

    it("forwards the optional Rich Message payload for sends and edits", async () => {
        const sendText = vi.fn(async () => [{ message_id: 1 }]);
        const editText = vi.fn(async () => undefined);
        const base = { ...createTransport([]), sendText, editText } as TelegramTransport;
        const transport = createActiveTelegramTransport(base, { isActive: () => true });

        await transport.sendText(42, "<b>table</b>", 7, 9, "| a |\n| --- |\n| 1 |");
        await transport.editText(42, 5, "<b>table</b>", "| a |\n| --- |\n| 1 |");

        expect(sendText).toHaveBeenCalledWith(42, "<b>table</b>", 7, 9, "| a |\n| --- |\n| 1 |");
        expect(editText).toHaveBeenCalledWith(42, 5, "<b>table</b>", "| a |\n| --- |\n| 1 |");
    });
});
