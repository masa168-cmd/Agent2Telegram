import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === "__tests__" ? [] : walk(path);
  return /\.(ts|mjs)$/.test(name) ? [path] : [];
});

describe("lib/core stays agent-neutral", () => {
  it("imports neither Pi packages nor anything outside lib/core", () => {
    const violations: string[] = [];
    for (const file of walk(coreDir)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        const name = relative(coreDir, file);
        if (/^@earendil-works\/|^@oh-my-pi\//.test(spec)) violations.push(`${name}: ${spec}`);
        else if (spec.startsWith(".") && relative(coreDir, resolve(dirname(file), spec)).startsWith("..")) {
          violations.push(`${name}: ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
