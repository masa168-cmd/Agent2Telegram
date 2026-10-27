/**
 * Telegram Rich Messages — used to render Markdown tables natively.
 *
 * Telegram's regular message modes (the `HTML` parse mode this extension sends)
 * have no table element, so the renderer fakes tables as card / box-drawing /
 * transposed text (`lib/markdown.ts`). Bot API 10.1 added *Rich Messages*
 * (`sendRichMessage`, plus a `rich_message` field on `editMessageText`) whose
 * Markdown dialect renders GitHub-style pipe tables as real, bordered tables in
 * the client — the same mechanism `dsh-im` uses.
 *
 * This module is deliberately narrow: it decides *whether* an answer qualifies
 * for the rich path and converts it. Everything that does not qualify keeps the
 * existing HTML pipeline, so no content depends on the newer API.
 */
import { hasGfmTable, protectPseudoTables } from "./markdown.ts";

/**
 * Conservative Rich Message text budget. Telegram allows roughly 32k characters
 * (vs. 4096 for a regular message); staying at 30k keeps a safety margin.
 * Answers above it fall back to the HTML pipeline, which already splits safely.
 */
export const TELEGRAM_RICH_TEXT_LIMIT = 30_000;

/**
 * Escape the two characters that could make model output look like Telegram
 * Rich Markdown markup. Rich Markdown accepts HTML tags, so an unescaped `<`
 * from a tool result or a code sample would be interpreted as markup.
 *
 * `>` is deliberately left alone: it cannot open a tag on its own, and escaping
 * it would turn `> quoted line` into literal text instead of a blockquote.
 */
export function escapeRichMarkdown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** True when every code fence is closed (an unterminated fence swallows the rest). */
function hasBalancedFences(markdown: string): boolean {
  return (markdown.match(/^\s*(?:`{3,}|~{3,})/gm) ?? []).length % 2 === 0;
}

/**
 * Convert `markdown` into a Telegram `rich_message.markdown` payload, or
 * `undefined` when the answer should stay on the HTML path.
 *
 * Qualifies only when the body contains a real GFM table, fits one Rich
 * Message, and has balanced code fences. Pseudo-tables (aligned pipes without a
 * separator row) are fenced first so they keep their monospace alignment.
 */
export function richMarkdownForTables(markdown: string): string | undefined {
  if (!markdown.trim() || !hasGfmTable(markdown)) return undefined;
  if (!hasBalancedFences(markdown)) return undefined;
  const rich = escapeRichMarkdown(protectPseudoTables(markdown));
  if (Array.from(rich).length > TELEGRAM_RICH_TEXT_LIMIT) return undefined;
  return rich;
}
