// The gateway serves several agents in one process, so it reads each agent's
// tg.json by path instead of through the process-wide data dir.
import { readFile } from "node:fs/promises";
import type { BotRecord, BotRegistry } from "../core/types.ts";

export async function readRegistryFile(path: string): Promise<BotRegistry | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch { return undefined; }
  const value = JSON.parse(raw) as BotRegistry;
  if (value?.version !== 3 || !Array.isArray(value.bots)) throw new Error(`${path} 不是第 3 版格式，请用 a2t setup 重新配置。`);
  return value;
}

export function defaultBot(registry: BotRegistry | undefined): BotRecord | undefined {
  return registry?.bots.find(b => b.id === registry.defaultBotId) ?? registry?.bots[0];
}
