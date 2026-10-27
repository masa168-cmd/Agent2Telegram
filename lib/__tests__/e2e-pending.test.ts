import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classify, loadPending } from "../../scripts/e2e/pending.mjs";

interface Entry {
  suite: string;
  host: string;
  step: string;
  task: string;
  reason: string;
}

const entry = (over: Partial<Entry> = {}): Entry => ({
  suite: "commands",
  host: "omp",
  step: "/models list from Telegram",
  task: "T3.2e",
  reason: "model menu still draws the legacy Telegram keyboard",
  ...over,
});
const step = (name: string, ok: boolean, detail = "") => ({ name, ok, detail });

const dir = mkdtempSync(join(tmpdir(), "pitg-pending-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const listFile = (name: string, doc: unknown) => {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(doc));
  return path;
};

describe("classify", () => {
  it("treats every failure as a regression when the list is empty", () => {
    const { regressions, expected, nowPassing } = classify([], "commands", "omp:main", [
      step("/model", true),
      step("/models list from Telegram", false, "no keyboard"),
      step("/logout", false, "no reply"),
    ]);
    expect(regressions.map((r) => r.name)).toEqual(["/models list from Telegram", "/logout"]);
    expect(regressions[0].detail).toBe("no keyboard");
    expect(expected).toEqual([]);
    expect(nowPassing).toEqual([]);
  });

  it("reports a listed failure as expected, with its task", () => {
    const { regressions, expected } = classify([entry()], "commands", "omp", [
      step("/models list from Telegram", false, "no keyboard"),
    ]);
    expect(regressions).toEqual([]);
    expect(expected).toEqual([{ name: "/models list from Telegram", detail: "no keyboard", task: "T3.2e" }]);
  });

  it("matches host * on any host and a phase-suffixed label on its host", () => {
    const star = [entry({ host: "*" })];
    for (const hostLabel of ["omp", "pi:main", "pi"]) {
      expect(classify(star, "commands", hostLabel, [step("/models list from Telegram", false)]).expected).toHaveLength(1);
    }
    expect(classify([entry()], "commands", "pi:quit", [step("/models list from Telegram", false)]).regressions).toHaveLength(1);
    expect(classify([entry()], "commands", "omp:disconnect", [step("/models list from Telegram", false)]).expected).toHaveLength(1);
  });

  it("flags a listed step that now passes so the entry gets removed", () => {
    const { nowPassing, regressions, expected } = classify([entry()], "commands", "omp", [
      step("/models list from Telegram", true, "mirror keyboard"),
    ]);
    expect(nowPassing).toEqual([{ name: "/models list from Telegram", detail: "mirror keyboard", task: "T3.2e" }]);
    expect(regressions).toEqual([]);
    expect(expected).toEqual([]);
  });

  it("does not match across suites", () => {
    const listed = [entry({ suite: "dialogs" })];
    expect(classify(listed, "commands", "omp", [step("/models list from Telegram", false)]).regressions).toHaveLength(1);
    expect(classify(listed, "dialogs", "omp", [step("/models list from Telegram", false)]).expected).toHaveLength(1);
  });
});

describe("loadPending", () => {
  it("accepts the committed list", () => {
    expect(Array.isArray(loadPending())).toBe(true);
  });

  it("returns the validated entries", () => {
    const path = listFile("ok", { version: 1, entries: [entry(), entry({ suite: "dialogs", host: "*", step: "/login" })] });
    expect(loadPending(path)).toHaveLength(2);
    expect(loadPending(path)[1].host).toBe("*");
  });

  it("rejects a wrong version", () => {
    const path = listFile("version", { version: 2, entries: [] });
    expect(() => loadPending(path)).toThrow(/version must be 1/);
  });

  it("rejects entries that are not an array", () => {
    expect(() => loadPending(listFile("entries", { version: 1, entries: {} }))).toThrow(/entries must be an array/);
  });

  it("rejects a missing or blank task", () => {
    const { task: _task, ...noTask } = entry();
    expect(() => loadPending(listFile("no-task", { version: 1, entries: [noTask] }))).toThrow(/entry 1: task/);
    expect(() => loadPending(listFile("blank-task", { version: 1, entries: [entry({ task: "  " })] }))).toThrow(/entry 1: task/);
  });

  it("rejects an unknown host or suite", () => {
    expect(() => loadPending(listFile("host", { version: 1, entries: [entry({ host: "both" })] }))).toThrow(/entry 1: host/);
    expect(() => loadPending(listFile("suite", { version: 1, entries: [entry({ suite: "tui" })] }))).toThrow(/entry 1: suite/);
  });

  it("rejects a blank step and names the offending entry", () => {
    expect(() => loadPending(listFile("step", { version: 1, entries: [entry(), entry({ step: "" })] }))).toThrow(/entry 2: step/);
  });

  it("rejects a duplicate (suite, host, step)", () => {
    const path = listFile("dup", { version: 1, entries: [entry(), entry({ task: "T3.3" })] });
    expect(() => loadPending(path)).toThrow(/duplicate entry/);
    // same step under another host or suite is fine
    expect(loadPending(listFile("dup-ok", { version: 1, entries: [entry(), entry({ host: "pi" })] }))).toHaveLength(2);
  });
});
