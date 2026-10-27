#!/usr/bin/env node
/**
 * Draft the `[Unreleased]` section of CHANGELOG.md from conventional commits.
 *
 * This exists because CHANGELOG.md is the only human-facing release-notes surface for this
 * project. The publish workflow creates tags but deliberately no GitHub Release (decided
 * against: tags plus this file are sufficient, and a Release page would be a second place
 * to keep in sync), so a consumer has nowhere else to read what changed. That makes the
 * file worth keeping — but it does not make it worth writing from scratch every release.
 *
 * This script produces a skeleton, not a finished section. It cannot know why a change
 * mattered, and it should not pretend to: the output is deliberately terse and is meant to
 * be edited down before release. Sections that are internal (ci/build/chore/test/docs)
 * are reported separately so they can be dropped on purpose rather than by accident.
 *
 * Usage:
 *   npm run changelog:draft                 # commits since the last tag
 *   npm run changelog:draft -- v0.0.9       # since an explicit ref
 *   npm run changelog:draft -- v0.0.9 HEAD
 *
 * Zero dependencies: this must keep working with no install step.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Conventional type -> changelog section. Types absent here are treated as internal. */
const SECTIONS = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
  revert: "Changed",
  build: "Changed",
};

/** Types that are internal housekeeping and normally do not belong in release notes. */
const INTERNAL = new Set(["ci", "chore", "test", "docs", "style", "release"]);

const SECTION_ORDER = ["Added", "Changed", "Fixed", "Removed"];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Last reachable tag, or undefined when the repo has none. */
function lastTag() {
  try {
    return git(["describe", "--tags", "--abbrev=0"]);
  } catch {
    return undefined;
  }
}

/**
 * Parse one commit subject.
 * Returns null for merge commits and anything without a recognised conventional prefix —
 * those are reported separately rather than silently dropped into a section.
 */
function parseCommit(line) {
  const match = line.match(/^([0-9a-f]+) ([a-z]+)(?:\(([^)]*)\))?(!)?: (.+)$/);
  if (!match) return null;
  const [, sha, type, scope, breaking, subject] = match;
  return { sha, type, scope, breaking: Boolean(breaking), subject };
}

/**
 * Build the draft as a list of lines.
 *
 * Exported so `changelog-version.mjs --auto-draft` can reuse it: the release workflow must
 * not fail just because nobody hand-wrote the notes, and duplicating the section mapping
 * would let the two scripts drift apart.
 *
 * `bodyOnly` drops the `## [Unreleased]` heading and the explanatory comments, leaving a
 * section body that can be spliced under an existing heading.
 */
export function buildDraft({ from, to = "HEAD", bodyOnly = false } = {}) {
  const start = from ?? lastTag();
  const range = start ? `${start}..${to}` : to;
  const raw = git(["log", "--no-merges", "--format=%h %s", range]);
  const lines = raw ? raw.split("\n").filter(Boolean) : [];

  const bySection = new Map();
  const internal = [];
  const unparsed = [];
  const breaking = [];

  for (const line of lines) {
    const commit = parseCommit(line);
    if (!commit) {
      // Merge commits are excluded by --no-merges; anything left is a non-conventional
      // subject, which needs a human decision rather than a guessed section.
      if (!/^[0-9a-f]+ Merge /.test(line)) unparsed.push(line);
      continue;
    }
    const text = commit.scope ? `**${commit.scope}:** ${commit.subject}` : commit.subject;
    const entry = { ...commit, text };
    if (commit.breaking) breaking.push(entry);

    if (INTERNAL.has(commit.type)) {
      internal.push(entry);
      continue;
    }
    const section = SECTIONS[commit.type];
    if (!section) {
      internal.push(entry);
      continue;
    }
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(entry);
  }

  const out = [];
  if (!bodyOnly) {
    const heading = start
      ? `commits in \`${range}\``
      : `all ${lines.length} commits (no tag found)`;
    out.push(`<!-- draft: ${heading} -->`);
    out.push("<!--\n  Draft only. Edit before release: keep the user-visible effect, drop the\n"
      + "  internal detail. Commit bodies already carry the full rationale.\n-->");
    out.push("");
    out.push("## [Unreleased]");
    out.push("");
  }

  if (breaking.length) {
    out.push("### Breaking", "");
    for (const entry of breaking) out.push(`- ${entry.text} (${entry.sha})`);
    out.push("");
  }

  for (const section of SECTION_ORDER) {
    const entries = bySection.get(section);
    if (!entries?.length) continue;
    out.push(`### ${section}`, "");
    for (const entry of entries) out.push(`- ${entry.text} (${entry.sha})`);
    out.push("");
  }

  const unmapped = [...bySection.keys()].filter((s) => !SECTION_ORDER.includes(s));
  for (const section of unmapped) {
    out.push(`### ${section}`, "");
    for (const entry of bySection.get(section)) out.push(`- ${entry.text} (${entry.sha})`);
    out.push("");
  }

  // Internal and non-conventional entries are included only in the human-facing draft:
  // --auto-draft writes them straight into the CHANGELOG, where HTML comments listing
  // commit hashes would be noise.
  if (!bodyOnly) {
    if (internal.length) {
      out.push("<!-- Internal (normally omitted from release notes):");
      for (const entry of internal) out.push(`       ${entry.type}  ${entry.text}`);
      out.push("-->", "");
    }
    if (unparsed.length) {
      out.push("<!-- Non-conventional subjects needing a decision:");
      for (const line of unparsed) out.push(`       ${line}`);
      out.push("-->", "");
    }
  }

  return { lines: out, count: lines.length };
}

/** True when the repo has no tags yet, so --auto-draft cannot scope a range. */
export function hasNoTags() {
  return lastTag() === undefined;
}

function main() {
  const bodyOnly = process.argv.slice(2).includes("--body-only");
  const [fromArg, toArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const { lines } = buildDraft({ from: fromArg, to: toArg, bodyOnly });
  process.stdout.write(`${lines.join("\n")}\n`);
}

// Imported by changelog-version.mjs: only run when invoked directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

