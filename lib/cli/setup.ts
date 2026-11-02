// `a2t setup <pi|claude|codex>`: interactive, run by the user in a terminal, so the
// Bot token never passes through anything else. Writes <agent data dir>/tg.json.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { addBot, readBotRegistry, removeBot, setDefaultBot, setTelegramDataDir, getTelegramConfigPath } from "../core/config.ts";
import { getTelegramBotUsername } from "../core/telegram-api.ts";
import type { BotRecord } from "../core/types.ts";

export type SetupAgent = "pi" | "claude" | "codex";

const LABEL: Record<SetupAgent, string> = { pi: "Pi", claude: "Claude Code", codex: "Codex" };

export async function runSetup(agent: SetupAgent, dataDir: string): Promise<number> {
  // Read from the terminal even when stdin is a pipe (curl … | bash).
  let input: NodeJS.ReadableStream = process.stdin;
  if (!process.stdin.isTTY) {
    try { input = createReadStream("/dev/tty"); } catch { /* no terminal */ }
  }
  let muted = false;
  const output = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input, output, terminal: true });
  // The question is readline's own prompt: written to stdout beside it, the
  // line refresh (cursor to column 1, clear) would wipe it from the screen.
  const ask = (question: string, hidden = false) => new Promise<string>(resolve => {
    muted = false;
    rl.question(question, answer => { muted = false; if (hidden) process.stdout.write("\n"); resolve(answer.trim()); });
    muted = hidden;
  });
  try {
    setTelegramDataDir(dataDir);
    console.log(`${LABEL[agent]} 的 Telegram 配置（${getTelegramConfigPath()}）`);
    console.log("每个 Agent 用自己的 Bot 和自己的论坛群。");
    const registry = await readBotRegistry();
    if (registry.bots.length > 0) {
      const replace = await ask(`已有 Bot：${registry.bots.map(b => b.name).join(", ")}。替换为新的 Bot？(y/N) `);
      if (replace.toLowerCase() !== "y") { console.log("未修改。"); return 0; }
    }
    const name = (await ask(`Bot 名称（默认 ${agent}）：`)) || agent;
    const token = await ask("Bot Token（输入时不显示）：", true);
    if (!/^\d+:[\w-]+$/.test(token)) { console.log("Token 格式不对。"); return 1; }
    const forumChatId = Number(await ask("论坛群 ID（以 -100 开头，可在群消息链接 t.me/c/<数字>/… 前加 -100 得到）："));
    if (!Number.isSafeInteger(forumChatId) || forumChatId >= 0) { console.log("群 ID 必须是 -100 开头的负数。"); return 1; }
    // Only this account may operate the agent. Not a secret, but nobody else can send as it.
    const allowedUserId = Number(await ask("你的 Telegram 用户 ID（私聊 @userinfobot 可查到）："));
    if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) { console.log("用户 ID 必须是正整数。"); return 1; }

    const botUsername = await getTelegramBotUsername(token).catch(() => undefined);
    if (!botUsername) { console.log("无法用这个 Token 连接 Telegram，请检查 Token 和网络。"); return 1; }
    const bot: BotRecord = { id: randomUUID(), name, token, forumChatId, botUsername, allowedUserId };
    // Replace the old Bot only now that everything checked out: a typo above keeps it.
    for (const old of registry.bots) await removeBot(old.id);
    await addBot(bot);
    await setDefaultBot(bot.id);
    console.log(`已保存 @${botUsername}。请确认 Bot 已是论坛群管理员，并有「管理话题」权限。`);
    console.log(`下一步：a2t gateway restart，然后在项目目录运行 a2t enable ${agent}${agent === "pi" ? "，再在该目录启动 pi" : agent === "codex" ? "，再在该目录的 tmux 里启动 codex" : ""}。`);
    return 0;
  } finally {
    rl.close();
  }
}
