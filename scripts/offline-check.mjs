// No installation, real host, Bot, model, tmux, global config, or inherited credential environment.
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(root, ".test-work");
for (const name of ["home", "agent", "tmp", "npm-cache"]) mkdirSync(join(work, name), { recursive: true });
const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: join(work, "home"),
  PI_CODING_AGENT_DIR: join(work, "agent"), TMPDIR: join(work, "tmp"), CI: "1", PI_OFFLINE: "1",
  EX_OFFLINE_ROOT: work, NODE_OPTIONS: `--import=${pathToFileURL(join(root, "scripts/offline-network-guard.mjs")).href}`,
  NPM_CONFIG_USERCONFIG: join(work, "npm-user.conf"), NPM_CONFIG_GLOBALCONFIG: join(work, "npm-global.conf"),
  NPM_CONFIG_CACHE: join(work, "npm-cache") };
for (const args of [
  ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2"],
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["scripts/changelog-version.mjs", "--check"],
]) {
  console.log(`\n[offline-check] node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("\nOffline tests, typecheck and changelog check passed. No real-host/Bot acceptance implied.");
