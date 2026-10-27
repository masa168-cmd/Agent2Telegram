import { sameForumTarget, type ForumTarget } from "./forum-binding.ts";
import type { ForumSession } from "./forum-session.ts";
import { TelegramSendSuppressedError } from "./telegram-api.ts";
import type { TelegramTransport } from "./types.ts";

type Scope = Pick<ForumSession, "enabled" | "getTarget" | "ownsMessage" | "rememberMessage">;

/** Apply below the existing lease/queue wrapper so an obsolete target is suppressed. */
export function createForumTelegramTransport(base: TelegramTransport, forum: Scope): TelegramTransport {
  const target = (chatId?: number, threadId?: number, messageId?: number): ForumTarget | undefined => {
    if (!forum.enabled) return;
    const t = forum.getTarget();
    if (!t || (chatId !== undefined && t.chatId !== chatId)
      || (threadId !== undefined && threadId !== t.threadId)
      || (messageId !== undefined && !forum.ownsMessage(messageId))) throw new TelegramSendSuppressedError();
    return t;
  };
  const remember = (t: ForumTarget | undefined, id: number, buttons = false) => {
    if (t && sameForumTarget(t, forum.getTarget())) forum.rememberMessage(id, buttons);
  };
  return {
    sendText: async (chat, text, thread, reply, rich, delivery) => {
      const t = target(chat, thread);
      const messages = await base.sendText(chat, text, t?.threadId ?? thread, reply, rich, delivery);
      for (const message of messages) remember(t, message.message_id);
      return messages;
    },
    sendButtons: async (chat, text, rows, thread, reply) => {
      const t = target(chat, thread);
      const message = await base.sendButtons(chat, text, rows, t?.threadId ?? thread, reply);
      remember(t, message.message_id, true);
      return message;
    },
    editText: async (chat, id, text, rich) => {
      target(chat, undefined, id);
      await base.editText(chat, id, text, rich);
    },
    editButtons: async (chat, id, text, rows) => {
      const t = target(chat, undefined, id);
      await base.editButtons(chat, id, text, rows);
      remember(t, id, true);
    },
    removeInlineKeyboard: async (chat, id) => {
      target(chat, undefined, id);
      await base.removeInlineKeyboard(chat, id);
    },
    deleteMessage: async (chat, id) => {
      target(chat, undefined, id);
      await base.deleteMessage(chat, id);
    },
    answerCallbackQuery: async (id, text) => {
      target();
      await base.answerCallbackQuery(id, text);
    },
    sendDocument: async (chat, path, caption, signal, thread, reply) => {
      const t = target(chat, thread);
      await base.sendDocument(chat, path, caption, signal, t?.threadId ?? thread, reply);
    },
    sendPhoto: async (chat, data, caption, isPath, signal, thread, reply) => {
      const t = target(chat, thread);
      await base.sendPhoto(chat, data, caption, isPath, signal, t?.threadId ?? thread, reply);
    },
    sendChatAction: async (chat, action, thread) => {
      const t = target(chat, thread);
      await base.sendChatAction(chat, action, t?.threadId ?? thread);
    },
  };
}
