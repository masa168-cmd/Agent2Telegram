import { describe, expect, it, vi } from "vitest";
import { createActiveTelegramTransport } from "../../core/active-transport.ts";
import { createForumTelegramTransport } from "../forum-transport.ts";
import type { ForumTarget } from "../../core/forum-binding.ts";
import type { TelegramTransport } from "../../core/types.ts";

function fixture() {
  let target: ForumTarget | undefined = { botId: "b", sessionId: "a", chatId: -100123, threadId: 11, generation: "a1" };
  const owned = new Set<number>();
  const buttons = new Set<number>();
  const base = {
    sendText: vi.fn(async () => [{ message_id: 80 }]), sendButtons: vi.fn(async () => ({ message_id: 81 })),
    editText: vi.fn(async () => {}), editButtons: vi.fn(async () => {}), removeInlineKeyboard: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}), answerCallbackQuery: vi.fn(async () => {}),
    sendDocument: vi.fn(async () => {}), sendPhoto: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}),
  };
  const forum = { enabled: true, getTarget: () => target, ownsMessage: (id: number) => owned.has(id),
    rememberMessage: (id: number, isButton?: boolean) => { owned.add(id); if (isButton) buttons.add(id); } };
  const lease = () => target?.generation;
  const transport = createActiveTelegramTransport(createForumTelegramTransport(base as TelegramTransport, forum),
    { isActive: () => !!target, getLease: lease });
  return { base, forum, transport, owned, buttons, setTarget: (t: ForumTarget | undefined) => { target = t; } };
}

describe("complete forum-scoped output pipeline", () => {
  it("fills the bound thread for local text, buttons, files, photos and typing, not General", async () => {
    const f = fixture();
    await f.transport.sendText(-100123, "local answer");
    await f.transport.sendButtons(-100123, "approval", [[{ text: "yes", value: "yes" }]]);
    await f.transport.sendDocument(-100123, "/fake/report.txt", "report");
    await f.transport.sendPhoto(-100123, "fake-base64", "image", false);
    await f.transport.sendChatAction(-100123, "typing");
    expect(f.base.sendText).toHaveBeenCalledWith(-100123, "local answer", 11, undefined, undefined, undefined);
    expect(f.base.sendButtons).toHaveBeenCalledWith(-100123, "approval", expect.any(Array), 11, undefined);
    expect(f.base.sendDocument).toHaveBeenCalledWith(-100123, "/fake/report.txt", "report", undefined, 11, undefined);
    expect(f.base.sendPhoto).toHaveBeenCalledWith(-100123, "fake-base64", "image", false, undefined, 11, undefined);
    expect(f.base.sendChatAction).toHaveBeenCalledWith(-100123, "typing", 11);
    expect([...f.owned]).toEqual([80, 81]); expect([...f.buttons]).toEqual([81]);
  });
  it("refuses explicit wrong groups/threads and all edits/deletions of unowned messages", async () => {
    const f = fixture();
    expect(await f.transport.sendText(-999, "wrong group")).toEqual([]);
    expect(await f.transport.sendText(-100123, "wrong thread", 22)).toEqual([]);
    await f.transport.editText(-100123, 99, "must not edit");
    await f.transport.editButtons(-100123, 99, "must not edit", []);
    await f.transport.deleteMessage(-100123, 99);
    await f.transport.removeInlineKeyboard(-100123, 99);
    for (const method of ["sendText", "editText", "editButtons", "deleteMessage", "removeInlineKeyboard"] as const) {
      expect(f.base[method]).not.toHaveBeenCalled();
    }
    await f.transport.sendText(-100123, "owned");
    await f.transport.editText(-100123, 80, "updated");
    expect(f.base.editText).toHaveBeenCalledWith(-100123, 80, "updated", undefined);
  });
  it("drops queued old-generation output and never registers a late response in a replacement route", async () => {
    const f = fixture();
    let resolve!: (value: { message_id: number }[]) => void;
    f.base.sendText.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const first = f.transport.sendText(-100123, "already in flight");
    const queued = f.transport.sendText(-100123, "not sent yet");
    await vi.waitFor(() => expect(f.base.sendText).toHaveBeenCalledTimes(1));
    f.setTarget({ botId: "b", sessionId: "new", chatId: -100123, threadId: 22, generation: "new" });
    resolve([{ message_id: 90 }]); await first;
    expect(await queued).toEqual([]);
    expect(f.owned.has(90)).toBe(false);
    expect(f.base.sendText).toHaveBeenCalledTimes(1);
  });
  it("retains upstream private-chat transport semantics when forum mode is absent", async () => {
    const f = fixture(); f.forum.enabled = false;
    await f.transport.sendText(42, "private");
    await f.transport.editText(42, 999, "legacy edit");
    expect(f.base.sendText).toHaveBeenCalledWith(42, "private", undefined, undefined, undefined, undefined);
    expect(f.base.editText).toHaveBeenCalledWith(42, 999, "legacy edit", undefined);
  });
  it("never quotes the user's message in private or forum mode", async () => {
    const f = fixture(); f.forum.enabled = false;
    await f.transport.sendText(42, "private reply", undefined, 555);
    await f.transport.sendButtons(42, "private buttons", [], undefined, 556);
    await f.transport.sendDocument(42, "/tmp/x", "doc", undefined, undefined, 557);
    await f.transport.sendPhoto(42, "data", "img", false, undefined, undefined, 558);
    expect(f.base.sendText).toHaveBeenCalledWith(42, "private reply", undefined, undefined, undefined, undefined);
    expect(f.base.sendButtons).toHaveBeenCalledWith(42, "private buttons", [], undefined, undefined);
    expect(f.base.sendDocument).toHaveBeenCalledWith(42, "/tmp/x", "doc", undefined, undefined, undefined);
    expect(f.base.sendPhoto).toHaveBeenCalledWith(42, "data", "img", false, undefined, undefined, undefined);

    const g = fixture();
    await g.transport.sendText(-100123, "forum reply", 11, 777);
    await g.transport.sendButtons(-100123, "forum buttons", [], 11, 778);
    await g.transport.sendDocument(-100123, "/tmp/x", "doc", undefined, 11, 779);
    await g.transport.sendPhoto(-100123, "data", "img", false, undefined, 11, 780);
    expect(g.base.sendText).toHaveBeenCalledWith(-100123, "forum reply", 11, undefined, undefined, undefined);
    expect(g.base.sendButtons).toHaveBeenCalledWith(-100123, "forum buttons", [], 11, undefined);
    expect(g.base.sendDocument).toHaveBeenCalledWith(-100123, "/tmp/x", "doc", undefined, 11, undefined);
    expect(g.base.sendPhoto).toHaveBeenCalledWith(-100123, "data", "img", false, undefined, 11, undefined);
  });
});
