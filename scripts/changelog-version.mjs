#!/usr/bin/env node
/**
 * Roll CHANGELOG.md forward for a release, or verify it is consistent.
 *
 * Why this exists: the publish workflow bumps `package.json` and tags a release, but
 * nothing ever moved the `[Unreleased]` section into a version section. v0.0.11 shipped
 * with its own release notes still labelled `[Unreleased]`, and with the `[Unreleased]`
 * link ref still anchored at `v0.0.10` — the notes for a released version described as
 * unreleased, inside the published tarball. A check alone would have caught that; the
 * workflow runs this script's `roll` action so the common path cannot produce it at all.
 *
 * Usage:
 *   node scripts/changelog-version.mjs              # roll [Unreleased] -> [<version>]
 *   node scripts/changelog-version.mjs --check      # verify consistency, write nothing
 *   node scripts/changelog-version.mjs --auto-draft # fill an empty [Unreleased] first
 *   node scripts/changelog-version.mjs --date=2026-10-18
 *   node scripts/changelog-version.mjs --allow-empty
 *
 * `--check` is wired into `prepublishOnly` and the publish workflow, so a release whose
 * CHANGELOG does not describe it fails instead of publishing quietly. The workflow calls
 * `roll --auto-draft`, which means a release is never blocked on someone having written
 * the notes by hand first: the draft is committed like any other change and can be
 * improved afterwards.
 *
 * Zero dependencies, matching scripts/changelog-draft.mjs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDraft, hasNoTags } from "./changelog-draft.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const ALLOW_EMPTY = args.includes("--allow-empty");
const AUTO_DRAFT = args.includes("--auto-draft");
const DATE = args.find((a) => a.startsWith("--date="))?.slice("--date=".length)
  ?? new Date().toISOString().slice(0, 10);

function readVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return pkg.version;
}

/** Split the file into a version-section map plus the surrounding structure. */
function parse(text) {
  const lines = text.split("\n");
  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^## \[([^\]]+)\]/);
    if (m) headings.push({ label: m[1], line: i });
  }
  const sections = headings.map((h, idx) => ({
    label: h.label,
    start: h.line,
    end: idx + 1 < headings.length ? headings[idx + 1].line : lines.length,
  }));
  const refs = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^\[([^\]]+)\]:\s*(\S+)\s*$/);
    if (m) refs.set(m[1], { line: i, url: m[2] });
  });
  return { lines, sections, refs };
}

/** A version section counts as empty when it has no bullet items. */
function isEffectivelyEmpty(lines, section) {
  return !lines.slice(section.start + 1, section.end).some((l) => /^\s*[-*]\s/.test(l));
}

/**
 * Regenerate the trailing provenance comment from the link refs themselves.
 *
 * Deriving this from the file rather than from `git tag` is deliberate: the workflow
 * checks out a single commit, so tags are not available there, and this note is about
 * which refs are tag-based — which is exactly what the file records.
 */
function tagNote(refs) {
  const tagged = [...refs.entries()]
    .filter(([label, { url }]) => label !== "Unreleased" && url.endsWith(`v${label}`))
    .map(([label]) => label)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const first = tagged.length
    ? `Versions linked by tag: ${tagged.map((v) => `v${v}`).join(", ")}; versions`
      + " without a tag are compared by commit SHA."
    : "No versions are linked by tag yet; all are compared by commit SHA.";

  // The two sentences after this are frozen history, not observations about the file.
  const frozen = "The v0.0.1 tag points at the initial commit, whose package.json still"
    + " read 0.1.0, so it is linked as a tree, not a range. The v0.0.8 tag (bb69f57)"
    + " sits one commit past the 0.0.8 release commit (f65e372).";

  const words = `${first} ${frozen}`.split(" ");
  const out = ["<!--"];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > 76) {
      out.push(`     ${line.trimEnd()}`);
      line = "";
    }
    line += `${word} `;
  }
  out.push(`     ${line.trimEnd()}`);
  // Close on the same line as the final word: the block always ends the file.
  out[out.length - 1] += " -->";
  return out;
}

/**
 * Replace the trailing provenance comment (everything from the first comment on).
 * Appends one when absent, so a CHANGELOG that does not carry the note yet still rolls.
 */
function replaceTagNote(lines, refs) {
  const lastRef = Math.max(...[...refs.values()].map((r) => r.line), 0);
  const start = lines.findIndex((l, i) => i > lastRef && l.startsWith("<!--"));
  const end = lines.findIndex((l, i) => i > lastRef && l.endsWith("-->"));

  if (start === -1 || end === -1) {
    // Drop a trailing blank line so the appended note does not gain one.
    const trimmed = [...lines];
    while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
    return [...trimmed, "", ...tagNote(refs)];
  }

  // Preserve the intent of the blank line before the comment, if there was one.
  const prefix = lines.slice(0, start);
  const hadBlank = prefix.length > 0 && prefix[prefix.length - 1].trim() === "";
  const head = hadBlank ? prefix : [...prefix, ""];
  return [...head, ...tagNote(refs), ...lines.slice(end + 1)];
}

function check() {
  const version = readVersion();
  const text = readFileSync(CHANGELOG, "utf8");
  const { lines, sections, refs } = parse(text);
  const problems = [];

  const unreleased = sections.find((s) => s.label === "Unreleased");
  if (!unreleased) problems.push("CHANGELOG.md has no `## [Unreleased]` section");

  const released = sections.find((s) => s.label === version);
  if (!released) {
    problems.push(
      `CHANGELOG.md has no \`## [${version}]\` section, but package.json is at ${version}`,
    );
  }

  const duplicates = sections
    .map((s) => s.label)
    .filter((label, i, all) => label !== "Unreleased" && all.indexOf(label) !== i);
  if (duplicates.length) {
    problems.push(`CHANGELOG.md repeats section(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  const unreleasedRef = refs.get("Unreleased");
  if (!unreleasedRef) {
    problems.push("CHANGELOG.md has no `[Unreleased]:` link reference");
  } else if (!unreleasedRef.url.endsWith(`v${version}...HEAD`)) {
    problems.push(
      `\`[Unreleased]:\` should compare from v${version}, but is ${unreleasedRef.url}`,
    );
  }

  for (const section of sections) {
    if (section.label !== "Unreleased" && !refs.has(section.label)) {
      problems.push(`CHANGELOG.md section [${section.label}] has no link reference`);
    }
  }

  const expectedNote = tagNote(refs).join("\n");
  const lastRef = Math.max(...[...refs.values()].map((r) => r.line), 0);
  const noteStart = lines.findIndex((l, i) => i > lastRef && l.startsWith("<!--"));
  const noteEnd = lines.findIndex((l, i) => i > lastRef && l.endsWith("-->"));
  if (noteStart === -1 || noteEnd === -1) {
    problems.push("CHANGELOG.md has no trailing provenance comment");
  } else {
    const actual = lines.slice(noteStart, noteEnd + 1).join("\n");
    if (actual !== expectedNote) {
      problems.push("the trailing provenance comment is out of date");
    }
  }

  if (problems.length) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    console.error("  Run `npm run changelog:roll` and commit the result.");
    process.exitCode = 1;
    return;
  }
  console.log(`✓ CHANGELOG.md describes ${version} (${sections.length - 1} versions)`);
}

function roll() {
  const version = readVersion();
  const text = readFileSync(CHANGELOG, "utf8");
  let { lines, sections, refs } = parse(text);

  let unreleased = sections.find((s) => s.label === "Unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has no `## [Unreleased]` section");
  if (sections.some((s) => s.label === version)) {
    throw new Error(`CHANGELOG.md already has a \`## [${version}]\` section`);
  }

  // An empty [Unreleased] would otherwise produce an empty release section. Under
  // --auto-draft it is filled from the conventional commits instead, so the release
  // workflow never blocks on hand-written notes.
  if (isEffectivelyEmpty(lines, unreleased)) {
    if (AUTO_DRAFT) {
      if (hasNoTags()) throw new Error("cannot --auto-draft: the repo has no tags to range from");
      const { lines: draft, count } = buildDraft({ bodyOnly: true });
      // Never block the release on emptiness: --auto-draft exists precisely so a release
      // does not depend on someone having written the notes first, and a release with no
      // user-visible commits is legitimate. Say so explicitly rather than leaving a blank.
      const drafted = draft.some((l) => /^### /.test(l))
        ? draft
        : [
            "### Notes",
            "",
            count === 0
              ? "- No commits since the previous release."
              : `- No user-visible changes (${count} internal commit(s) omitted).`,
            "",
          ];

      lines = [
        ...lines.slice(0, unreleased.start + 1),
        "",
        ...drafted,
        ...lines.slice(unreleased.end),
      ];
      ({ sections, refs } = parse(lines.join("\n")));
      unreleased = sections.find((s) => s.label === "Unreleased");
      console.log("· [Unreleased] was empty; filled it from commits since the last tag");
    } else if (!ALLOW_EMPTY) {
      throw new Error(
        "`[Unreleased]` has no entries; write the release notes first"
        + " (or pass --auto-draft / --allow-empty)",
      );
    }
  }

  // Everything the [Unreleased] heading currently owns becomes the new version section.
  const body = lines.slice(unreleased.start + 1, unreleased.end);
  const rolled = [
    ...lines.slice(0, unreleased.start),
    "## [Unreleased]",
    "",
    `## [${version}] — ${DATE}`,
    ...body,
    ...lines.slice(unreleased.end),
  ];

  const next = { lines: rolled, refs: parse(rolled.join("\n")).refs };
  const prev = sections.filter((s) => s.label !== "Unreleased").map((s) => s.label)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

  // The existing [Unreleased] line becomes the new version's; a fresh [Unreleased] is
  // inserted above it, so the ref block keeps its newest-first ordering.
  const unreleasedRef = next.refs.get("Unreleased");
  const repo = unreleasedRef.url.replace(/\/compare\/.*$/, "");
  const refLines = [
    `[Unreleased]: ${repo}/compare/v${version}...HEAD`,
    `[${version}]: ${repo}/compare/v${prev}...v${version}`,
  ];
  if (prev && !refs.get(prev)?.url.endsWith(`v${prev}`)) {
    console.error(
      `! v${prev} is not tag-linked, so \`[${version}]\` compares against it by tag`
      + " anyway — check that tag exists.",
    );
  }
  next.lines.splice(unreleasedRef.line, 1, ...refLines);

  const withNote = replaceTagNote(next.lines, parse(next.lines.join("\n")).refs);

  // Always terminate with a newline; POSIX text convention, and it keeps diffs clean.
  writeFileSync(CHANGELOG, `${withNote.join("\n").replace(/\n*$/, "")}\n`);
  console.log(`✓ rolled [Unreleased] into [${version}] — ${DATE}`);
}

try {
  if (CHECK) check();
  else roll();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
