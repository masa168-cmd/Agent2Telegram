// Interactive setup, run by the user in SSH (the token never passes through Claude):
//   node dist/lib/claude/gateway/setup.js
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { addBot, readBotRegistry, removeBot, setDefaultBot, setTelegramDataDir } from "../../core/config.ts";
import { ensureTelegramPairingCode, formatPairingInstructions } from "../../core/pairing.ts";
import { getTelegramBotUsername } from "../../core/telegram-api.ts";
import type { BotRecord } from "../../core/types.ts";
import { claudeTelegramDir } from "./paths.ts";

let muted = false;
const output = new Writable({ write(chunk, _enc, done) { if (!muted) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });

function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    muted = hidden;
    rl.question("", answer => {
      muted = false;
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const dataDir = claudeTelegramDir();
  setTelegramDataDir(dataDir);
  console.log(`Claude Code Telegram 配置（数据目录 ${dataDir}）`);

  const registry = await readBotRegistry();
  if (registry.bots.length > 0) {
    const names = registry.bots.map(b => b.name).join(", ");
    const replace = await ask(`已有 Bot：${names}。替换为新的 Bot？(y/N) `);
    if (replace.toLowerCase() !== "y") { console.log("未修改。"); return; }
    for (const bot of registry.bots) await removeBot(bot.id);
  }

  const name = (await ask("Bot 名称（默认 claude）：")) || "claude";
  const token = await ask("Bot Token（输入时不显示）：", true);
  if (!/^\d+:[\w-]+$/.test(token)) { console.log("Token 格式不对。"); process.exitCode = 1; return; }
  const chatText = await ask("论坛群 ID（以 -100 开头）：");
  const forumChatId = Number(chatText);
  if (!Number.isSafeInteger(forumChatId) || forumChatId >= 0) { console.log("群 ID 必须是 -100 开头的负数。"); process.exitCode = 1; return; }

  const botUsername = await getTelegramBotUsername(token).catch(() => undefined);
  if (!botUsername) { console.log("无法用这个 Token 连接 Telegram，请检查 Token 和网络。"); process.exitCode = 1; return; }

  const paired = ensureTelegramPairingCode({ botToken: token });
  const bot: BotRecord = {
    id: randomUUID(), name, token, forumChatId, botUsername,
    pairingCode: paired.pairingCode, pairingCodeExpiresAt: paired.pairingCodeExpiresAt,
  };
  await addBot(bot);
  await setDefaultBot(bot.id);
  console.log(`已保存 @${botUsername}。`);
  console.log("下一步：重启网关（systemctl --user restart claude-telegram-gateway），然后：");
  console.log(formatPairingInstructions(paired));
  console.log("另外请确认 Bot 已是论坛群管理员，并有「管理话题」权限。");
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(() => rl.close());
