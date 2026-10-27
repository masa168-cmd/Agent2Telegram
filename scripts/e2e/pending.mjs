/**
 * E2E "pending migration" list (plan §0.1 rule 5). Steps listed here are expected to fail
 * until their migration task lands; anything else that fails is a regression.
 *
 * Entry format (scripts/e2e/pending-migration.json):
 *   {
 *     "suite": "commands" | "dialogs",
 *     "host": "pi" | "omp" | "*",
 *     "step": "<exactly the name passed to record()>",
 *     "task": "<task id, e.g. T3.2e>",
 *     "reason": "<one line>"
 *   }
 *
 * The list is consumed by run-e2e-commands.mjs and run-e2e-dialogs.mjs; a step that is on the
 * list but passes is reported as `↑` so the entry gets removed.
 */
import { readFileSync } from "node:fs";

const SUITES = new Set(["commands", "dialogs"]);
const HOSTS = new Set(["pi", "omp", "*"]);

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Read and validate the pending list. Any bad entry throws - no tolerance, no silent skips:
 * a wrong `step` string would silently turn an expected gap back into a regression.
 * @param {string | URL} path
 * @returns {Array<{ suite: string, host: string, step: string, task: string, reason: string }>}
 */
export function loadPending(path = new URL("./pending-migration.json", import.meta.url)) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("pending-migration.json: expected an object with { version, entries }");
  }
  if (doc.version !== 1) {
    throw new Error(`pending-migration.json: version must be 1, got ${JSON.stringify(doc.version)}`);
  }
  if (!Array.isArray(doc.entries)) {
    throw new Error("pending-migration.json: entries must be an array");
  }

  const seen = new Set();
  doc.entries.forEach((entry, index) => {
    const at = `pending-migration.json: entry ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${at}: expected an object, got ${JSON.stringify(entry)}`);
    }
    if (!SUITES.has(entry.suite)) {
      throw new Error(`${at}: suite must be one of ${[...SUITES].join(", ")}, got ${JSON.stringify(entry.suite)}`);
    }
    if (!HOSTS.has(entry.host)) {
      throw new Error(`${at}: host must be one of ${[...HOSTS].join(", ")}, got ${JSON.stringify(entry.host)}`);
    }
    for (const field of ["step", "task", "reason"]) {
      if (!nonEmptyString(entry[field])) {
        throw new Error(`${at}: ${field} must be a non-empty string`);
      }
    }
    const key = `${entry.suite}\u0000${entry.host}\u0000${entry.step}`;
    if (seen.has(key)) {
      throw new Error(`${at}: duplicate entry for suite=${entry.suite} host=${entry.host} step="${entry.step}"`);
    }
    seen.add(key);
  });

  return doc.entries;
}

/**
 * Split one host's recorded steps into regressions, expected failures and entries that now pass.
 * @param {ReturnType<typeof loadPending>} entries
 * @param {"commands" | "dialogs"} suite
 * @param {string} hostLabel "<host>" or "<host>:<phase>", e.g. "omp:main"
 * @param {Array<{ name: string, ok: boolean, detail?: string }>} results
 */
export function classify(entries, suite, hostLabel, results) {
  const host = String(hostLabel).split(":")[0];
  const find = (name) =>
    entries.find((e) => e.suite === suite && (e.host === "*" || e.host === host) && e.step === name);

  const regressions = [];
  const expected = [];
  const nowPassing = [];
  for (const step of results) {
    const entry = find(step.name);
    const detail = step.detail ?? "";
    if (step.ok) {
      if (entry) nowPassing.push({ name: step.name, detail, task: entry.task });
    } else if (entry) {
      expected.push({ name: step.name, detail, task: entry.task });
    } else {
      regressions.push({ name: step.name, detail });
    }
  }
  return { regressions, expected, nowPassing };
}
