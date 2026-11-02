// `a2t setup <pi|claude>`: interactive, run by the user in a terminal, so the
// Bot token never passes through anything else. Writes <agent data dir>/tg.json.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { addBot, readBotRegistry, removeBot, setDefaultBot, setTelegramDataDir, getTelegramConfigPath } from "../core/config.ts";
import { ensureTelegramPairingCode, formatPairingInstructions } from "../core/pairing.ts";
import { getTelegramBotUsername } from "../core/telegram-api.ts";
import type { BotRecord } from "../core/types.ts";

export type SetupAgent = "pi" | "claude";

export async function runSetup(agent: SetupAgent, dataDir: string): Promise<number> {
  // Read from the terminal even when stdin is a pipe (curl … | bash).
  let input: NodeJS.ReadableStream = process.stdin;
  if (!process.stdin.isTTY) {
    try { input = createReadStream("/dev/tty"); } catch { /* no terminal */ }
  }
  let muted = false;
  const output = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
  const rl = createInterface({ input, output, terminal: true });
  const ask = (question: string, hidden = false) => new Promise<string>(resolve => {
    process.stdout.write(question);
    muted = hidden;
    rl.question("", answer => { muted = false; if (hidden) process.stdout.write("\n"); resolve(answer.trim()); });
  });
  try {
    setTelegramDataDir(dataDir);
    console.log(`${agent === "pi" ? "Pi" : "Claude Code"} 的 Telegram 配置（${getTelegramConfigPath()}）`);
    console.log("每个 Agent 用自己的 Bot 和自己的论坛群。");
    const registry = await readBotRegistry();
    if (registry.bots.length > 0) {
      const replace = await ask(`已有 Bot：${registry.bots.map(b => b.name).join(", ")}。替换为新的 Bot？(y/N) `);
      if (replace.toLowerCase() !== "y") { console.log("未修改。"); return 0; }
      for (const bot of registry.bots) await removeBot(bot.id);
    }
    const name = (await ask(`Bot 名称（默认 ${agent}）：`)) || agent;
    const token = await ask("Bot Token（输入时不显示）：", true);
    if (!/^\d+:[\w-]+$/.test(token)) { console.log("Token 格式不对。"); return 1; }
    const forumChatId = Number(await ask("论坛群 ID（以 -100 开头，可在群消息链接 t.me/c/<数字>/… 前加 -100 得到）："));
    if (!Number.isSafeInteger(forumChatId) || forumChatId >= 0) { console.log("群 ID 必须是 -100 开头的负数。"); return 1; }
    const userText = await ask("你的 Telegram 用户 ID（可留空，留空则用配对码配对）：");
    const allowedUserId = userText ? Number(userText) : undefined;
    if (allowedUserId !== undefined && (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0)) { console.log("用户 ID 必须是正整数。"); return 1; }

    const botUsername = await getTelegramBotUsername(token).catch(() => undefined);
    if (!botUsername) { console.log("无法用这个 Token 连接 Telegram，请检查 Token 和网络。"); return 1; }
    const paired = allowedUserId === undefined ? ensureTelegramPairingCode({ botToken: token }) : {};
    const bot: BotRecord = {
      id: randomUUID(), name, token, forumChatId, botUsername,
      ...(allowedUserId === undefined ? {} : { allowedUserId }),
      ...("pairingCode" in paired && paired.pairingCode ? { pairingCode: paired.pairingCode, pairingCodeExpiresAt: paired.pairingCodeExpiresAt } : {}),
    };
    await addBot(bot);
    await setDefaultBot(bot.id);
    console.log(`已保存 @${botUsername}。请确认 Bot 已是论坛群管理员，并有「管理话题」权限。`);
    if (agent === "claude") console.log("下一步：a2t gateway restart，然后在项目目录运行 a2t enable claude。");
    else console.log("下一步：在项目目录运行 a2t enable pi，然后在该目录启动 pi。");
    if (allowedUserId === undefined) console.log(formatPairingInstructions({ ...bot, botToken: token }));
    return 0;
  } finally {
    rl.close();
  }
}
