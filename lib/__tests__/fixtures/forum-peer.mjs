/** Disposable offline peer: real local routing/controller/UI/renderer, fake Pi and Telegram. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ForumSession, forumBotId } from "../../forum-session.ts";
import { TelegramInstanceCoordinator } from "../../instance-coordinator.ts";
import { authorizedForumUpdate, deliverForumUpdate, findForumRoute } from "../../forum-router.ts";
import { createForumTelegramTransport } from "../../forum-transport.ts";
import { createActiveTelegramTransport } from "../../active-transport.ts";
import { createTelegramController } from "../../controller.ts";
import { createTelegramUiRuntime } from "../../telegram-ui.ts";
import { registerTelegramRenderer } from "../../renderer.ts";
import { registerTelegramAttachmentTool } from "../../attachments.ts";
import { getCurrentTelegramTurn } from "../../turn-context.ts";
import { initLogger } from "../../logger.ts";

initLogger({ enabled: false });
const root = process.env.FORUM_TEST_ROOT;
const id = process.env.FORUM_TEST_ID;
const thread = Number(process.env.FORUM_TEST_THREAD);
if (!root || !id || !Number.isSafeInteger(thread)) throw new Error("Missing disposable fixture configuration");
const cwd = join(root, id); await mkdir(cwd, { recursive: true });
const file = join(cwd, `${id}-attachment.txt`); await writeFile(file, `synthetic file from ${id}`);
const config = { botToken: "123:fake-offline-token", forumChatId: -100123, allowedUserId: 7,
  activeChatId: -100123, tool: "full", thinking: "brief" };
const entries = [{ type: "custom", customType: "pi-telegram-plus-ex.forum-binding", data: {
  version: 1, botId: forumBotId(config.botToken), chatId: config.forumChatId, sessionId: `session-${id}`, threadId: thread } }];
const coordinator = new TelegramInstanceCoordinator({ token: config.botToken, rootDir: root,
  instanceId: id, startedAt: new Date().toISOString(), heartbeatStaleMs: 2000 });
const state = { prompts: [], commands: [], outputs: [], aborts: 0, model: "fake-initial", thinking: "medium", compactions: 0 };
const ledger = new Map(); let nextMessage = thread * 100;
const outgoing = (kind, chat, messageThread, extra = {}) => {
  state.outputs.push({ kind, chat, thread: messageThread, ...extra });
};
const base = {
  sendText: async (chat, text, messageThread) => { const message_id = ++nextMessage; ledger.set(message_id, messageThread);
    outgoing("text", chat, messageThread, { text, message_id }); return [{ message_id }]; },
  sendButtons: async (chat, text, rows, messageThread) => { const message_id = ++nextMessage; ledger.set(message_id, messageThread);
    outgoing("buttons", chat, messageThread, { text, rows, message_id }); return { message_id }; },
  editText: async (chat, message_id, text) => outgoing("edit", chat, ledger.get(message_id), { text, message_id }),
  editButtons: async (chat, message_id, text, rows) => outgoing("edit-buttons", chat, ledger.get(message_id), { text, rows, message_id }),
  removeInlineKeyboard: async (chat, message_id) => outgoing("remove", chat, ledger.get(message_id)),
  deleteMessage: async (chat, message_id) => outgoing("delete", chat, ledger.get(message_id)),
  answerCallbackQuery: async () => {},
  sendDocument: async (chat, path, caption, _signal, messageThread) => outgoing("document", chat, messageThread, { path, caption }),
  sendPhoto: async (chat, _data, _caption, _isPath, _signal, messageThread) => outgoing("photo", chat, messageThread),
  sendChatAction: async (chat, action, messageThread) => outgoing("action", chat, messageThread, { action }),
};
let closed = false; let controller; let ui; let attachment; let releasePrompt;
const handlers = new Map();
const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event); };
const hostUi = { notify: () => {},
  select: (title, options) => ui.create(config.forumChatId, thread).select(title, options) };
let currentUi = hostUi;
const commandHandlers = new Map([
  ["model", async (args, ctx) => { state.model = args; state.commands.push("model"); ctx.ui.notify(`model-${id}:${args}`); }],
  ["thinking", async (args, ctx) => { state.thinking = args; state.commands.push("thinking"); ctx.ui.notify(`thinking-${id}:${args}`); }],
  ["compact", async (_args, ctx) => { state.compactions++; ctx.ui.notify(`compacted-${id}`); }],
  ["attachment", async () => { await attachment.execute("offline-file", { paths: [file] }); }],
  ["ask", async (_args, ctx) => { state.lastAnswer = await ctx.ui.select("Choose an offline color", ["red", "blue"]); }],
]);
const agent = { isStreaming: false,
  prompt: async text => {
    state.prompts.push(text); agent.isStreaming = true;
    try {
      await emit("message_update", { message: { role: "assistant", content: [{ type: "text", text: `partial-${id}:${text}` }] } });
      if (text === "wait") await new Promise(resolve => { releasePrompt = resolve; });
      await emit("message_end", { message: { role: "assistant", content: `reply-${id}:${text}` } });
    } finally { agent.isStreaming = false; }
  }, abort: async () => { state.aborts++; releasePrompt?.(); },
  extensionRunner: { getUIContext: () => currentUi, setUIContext: value => { currentUi = value; },
    createCommandContext: () => ({ cwd, ui: currentUi, isIdle: () => !agent.isStreaming }),
    getCommand: name => commandHandlers.has(name) ? { handler: commandHandlers.get(name) } : undefined },
};
const context = { sessionManager: { getSessionId: () => `session-${id}`, getSessionName: () => `offline-${id}`, getEntries: () => entries } };
const forum = new ForumSession({ pi: { appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) },
  getConfig: () => config, getCoordinator: () => coordinator,
  callApi: async (_token, method) => method === "createForumTopic" ? { message_thread_id: thread } : true,
  onUpdate: async ({ update }) => {
    if (update.callback_query) await controller.handleCallbackQuery(update.callback_query);
    if (update.message) await controller.handleMessage(update.message);
  }, onChange: () => { void heartbeat(); }, onError: () => {} });
const transport = createActiveTelegramTransport(createForumTelegramTransport(base, forum), {
  isActive: () => !closed && !!forum.lease(), getLease: () => forum.lease() });
ui = createTelegramUiRuntime({ transport, getSession: () => agent, allowSecretInputs: () => false,
  isCurrent: () => !closed && forum.isCurrentOperation() });
const turns = new Map();
controller = createTelegramController({ transport, ui, getConfig: () => config,
  getSession: () => !closed && forum.isCurrentOperation() ? agent : undefined,
  isCurrent: () => !closed && forum.isCurrentOperation(),
  getLocalDialogOrigin: () => ({ chatId: config.forumChatId, messageThreadId: thread }),
  authorizeUser: async userId => userId === 7, setActiveChatId: async () => {}, getBotUsername: () => "fake_bot",
  telegramCommands: new Map(), getActiveTurn: () => turns.get(thread), getActiveTurns: () => [...turns.values()],
  beginTelegramTurn: (chatId, replaceMessageId, messageThreadId, sourceMessageId) => {
    if (turns.has(thread)) return;
    const turn = { chatId, replaceMessageId, messageThreadId, sourceMessageId, queuedAttachments: [] }; turns.set(thread, turn); return turn;
  }, endTelegramTurn: () => turns.delete(thread),
  tuiBridge: { ready: async () => {}, isAvailable: () => true, getHost: () => "pi", getCommands: async () => [],
    submit: () => false, snapshot: () => undefined, key: () => false, write: () => false,
    isEditorFocused: () => true, isInteractiveFocus: () => false, onLocalSubmit: () => () => {} },
});
registerTelegramRenderer({ on: (name, handler) => { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); } }, {
  getConfig: () => config, transport, getActiveTurn: () => getCurrentTelegramTurn(), hasActiveTurns: () => false,
  getSendLease: () => forum.lease() });
registerTelegramAttachmentTool({ registerTool: tool => { attachment = tool; } }, {
  transport, getActiveTurn: () => getCurrentTelegramTurn(), getDefaultChatId: () => config.forumChatId,
  isActive: () => !!forum.lease() });
let tail = Promise.resolve();
function heartbeat() {
  tail = tail.then(async () => {
    if (closed) return;
    const registration = forum.registration();
    const snapshot = await coordinator.reconcile({ cwd, sessionId: `session-${id}`, forum: registration });
    await forum.reconciled(registration, snapshot.forumConflict);
  });
  return tail;
}
await forum.prepare(context); await heartbeat();
const timer = setInterval(() => { void heartbeat(); }, 150);
function send(message) { if (process.connected) process.send(message, () => {}); }
process.on("message", message => {
  void (async () => {
    let result;
    if (message.action === "state") result = { ...state, streaming: agent.isStreaming,
      active: coordinator.isActive(), leader: coordinator.getActive(), registration: forum.registration() };
    else if (message.action === "reconcile") { await heartbeat(); result = { active: coordinator.isActive(), leader: coordinator.getActive() }; }
    else if (message.action === "reload") { await forum.close(); await forum.prepare(context); await heartbeat(); result = forum.registration(); }
    else if (message.action === "dispatch") {
      const update = message.update; const leader = coordinator.getActive();
      if (!coordinator.isActive() || !leader || !await coordinator.isCurrentLeader(leader)
        || !authorizedForumUpdate(update, config.forumChatId, 7)) result = { accepted: false };
      else {
        const route = findForumRoute(update, await coordinator.listInstances(), forumBotId(config.botToken), config.forumChatId, 7);
        if (!route) result = { accepted: false, reason: "offline" };
        else { await coordinator.persistCursor(update.update_id);
          result = await deliverForumUpdate(route.instance.forum, { target: route.target, leader, update: route.update }); }
      }
    } else throw new Error("Unknown fixture action");
    send({ reply: message.request, result });
  })().catch(error => send({ reply: message.request, error: String(error) }));
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; closed = true; clearInterval(timer);
  await tail.catch(() => {}); controller.dispose(); ui.dispose(); await forum.close();
  await coordinator.releaseActive().catch(() => {}); process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });
process.on("disconnect", () => { void stop(); });
send({ ready: true });
