import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramTokenHash } from "../../core/forum-binding.ts";
import { claimBot } from "../ownership.ts";

const TOKEN = "123456:abc";

describe("Bot ownership", () => {
  let root: string;
  const saved = { a2t: process.env.AGENT2TELEGRAM_DIR, pi: process.env.PI_CODING_AGENT_DIR };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "a2t-owner-"));
    process.env.AGENT2TELEGRAM_DIR = join(root, "a2t");
    process.env.PI_CODING_AGENT_DIR = join(root, "pi");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env.AGENT2TELEGRAM_DIR = saved.a2t;
    process.env.PI_CODING_AGENT_DIR = saved.pi;
    if (saved.a2t === undefined) delete process.env.AGENT2TELEGRAM_DIR;
    if (saved.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
  });

  it("claims a free Bot and keeps it for the same agent", () => {
    expect(claimBot(TOKEN, "claude")).toEqual({ ok: true });
    expect(claimBot(TOKEN, "claude")).toEqual({ ok: true });
  });

  it("refuses a Bot claimed by another agent", () => {
    claimBot(TOKEN, "codex");
    const result = claimBot(TOKEN, "claude");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("codex");
  });

  it("refuses a Bot a live Pi is using, and allows it once that Pi is gone", () => {
    const dir = join(root, "pi", "tg-runtime", telegramTokenHash(TOKEN), "instances");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "i1.json"), JSON.stringify({ id: "i1", pid: 4242 }));
    expect(claimBot(TOKEN, "claude", pid => pid === 4242).ok).toBe(false);
    expect(claimBot(TOKEN, "claude", () => false)).toEqual({ ok: true });
  });
});
