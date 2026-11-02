// The gateway serves several agents in one process, so it reads and updates
// each agent's tg.json by path instead of through the process-wide data dir.
// The lock is the same `tg.json.lock` directory Pi's own /tg menu uses.
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotRecord, BotRegistry } from "../core/types.ts";

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

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

async function withLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = join(dirname(path), "tg.json.lock");
  const started = Date.now();
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lock).then(s => s.mtimeMs).catch(() => Date.now()));
      if (age > 30_000 || Date.now() - started > 10_000) { await rmdir(lock).catch(() => undefined); continue; }
      await sleep(50);
    }
  }
  try { return await run(); } finally { await rmdir(lock).catch(() => undefined); }
}

/** Update one bot's fields in place (pairing results). Unset fields are dropped. */
export async function updateBotFile(path: string, id: string, updates: Partial<Omit<BotRecord, "id">>): Promise<void> {
  await withLock(path, async () => {
    const registry = await readRegistryFile(path);
    const bot = registry?.bots.find(b => b.id === id);
    if (!registry || !bot) throw new Error(`Bot not found: ${id}`);
    Object.assign(bot, updates);
    for (const key of Object.keys(bot) as Array<keyof BotRecord>) if (bot[key] === undefined) delete bot[key];
    await writeFile(`${path}.tmp`, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  });
}
