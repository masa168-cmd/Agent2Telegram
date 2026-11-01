import { describe, expect, it } from "vitest";
import { hasGfmTable } from "../markdown.ts";
import { escapeRichMarkdown, richMarkdownForTables, TELEGRAM_RICH_TEXT_LIMIT } from "../rich-message.ts";

const TABLE = [
  "| Project | Status | Count |",
  "| --- | :---: | ---: |",
  "| dsh-im plugin | Installed | 1 |",
  "| Current branch | master | 1 |",
].join("\n");

describe("hasGfmTable", () => {
  it("detects a real GFM pipe table", () => {
    expect(hasGfmTable(TABLE)).toBe(true);
    expect(hasGfmTable(`intro\n\n${TABLE}\n\noutro`)).toBe(true);
  });

  it("ignores pipe text that is not a table", () => {
    expect(hasGfmTable("a | b\nc | d")).toBe(false);
    expect(hasGfmTable("| a | b |\n| c | d |")).toBe(false);
    expect(hasGfmTable("---")).toBe(false);
  });

  it("ignores tables inside fenced code blocks", () => {
    expect(hasGfmTable(`\`\`\`md\n${TABLE}\n\`\`\``)).toBe(false);
  });
});

describe("escapeRichMarkdown", () => {
  it("escapes ampersands and angle brackets that could become markup", () => {
    expect(escapeRichMarkdown('<tg-spoiler>a & b')).toBe("&lt;tg-spoiler>a &amp; b");
  });

  it("leaves `>` alone so blockquotes keep working", () => {
    expect(escapeRichMarkdown("> quoted")).toBe("> quoted");
  });
});

describe("richMarkdownForTables", () => {
  it("returns the table markdown unchanged", () => {
    expect(richMarkdownForTables(TABLE)).toBe(TABLE);
  });

  it("returns undefined when the answer has no real table", () => {
    expect(richMarkdownForTables("just prose")).toBeUndefined();
    expect(richMarkdownForTables("| pseudo | table |\n| no | separator |")).toBeUndefined();
  });

  it("fences pseudo-tables so they keep monospace alignment", () => {
    const source = `${TABLE}\n\n\`ls -la\` style output:\n\naaa | bbb | ccc\n111 | 222 | 333`;
    const rich = richMarkdownForTables(source);
    expect(rich).toContain(TABLE);
    expect(rich).toContain("```\naaa | bbb | ccc\n111 | 222 | 333\n```");
  });

  it("escapes raw HTML in the body", () => {
    const rich = richMarkdownForTables(`${TABLE}\n\n<script>alert(1)</script>`);
    expect(rich).toContain("&lt;script>alert(1)&lt;/script>");
    expect(rich).not.toContain("<script>");
  });

  it("falls back to HTML for an unterminated code fence", () => {
    expect(richMarkdownForTables(`${TABLE}\n\n\`\`\`ts\nconst a = 1;`)).toBeUndefined();
  });

  it("falls back to HTML when the answer exceeds one Rich Message", () => {
    const huge = `${TABLE}\n\n${"x".repeat(TELEGRAM_RICH_TEXT_LIMIT)}`;
    expect(richMarkdownForTables(huge)).toBeUndefined();
    expect(richMarkdownForTables(huge.slice(0, TELEGRAM_RICH_TEXT_LIMIT - 100))).toBeDefined();
  });
});
