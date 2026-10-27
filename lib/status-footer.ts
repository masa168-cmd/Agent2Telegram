import { stripVTControlCharacters } from "node:util";
import type { FooterComponent } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import { TELEGRAM_STATUS_KEY } from "./status.ts";

const footerLog = log.child("status-footer");

/**
 * `FooterComponent` MUST NOT be a static value import.
 *
 * pi >= 1.0.0 re-exports `createCodemodeExtension` from its package root, and that
 * chain statically imports `MCP_TYPESCRIPT_PREAMBLE` from `@earendil-works/pi-codemode`,
 * an export removed in pi-codemode 1.2.0. Because pi declares that dependency with a
 * caret range, a lockfile-less install floats to a codemode newer than pi expects and
 * importing the package root throws:
 *
 *   SyntaxError: The requested module '@earendil-works/pi-codemode/declarations'
 *   does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'
 *
 * Inside the pi CLI this is masked by the CLI's virtual-module alias table (which
 * serves `@earendil-works/pi-coding-agent` from the CLI's own bundle), but any plain
 * Node consumer — including the vitest matrix — dies at import time before a single
 * test runs. Resolving lazily and degrading to a no-op keeps the extension loadable
 * everywhere while preserving the patch whenever the real class is reachable.
 *
 * Resolution happens once via top-level await, at extension-load time. That keeps
 * `installTelegramStatusAlignment()` fully synchronous, which matters because pi
 * rejects extension API calls made after an `await` inside the extension factory
 * ("Extension runtime not initialized. Action methods cannot be called during
 * extension loading."). Top-level await is itself safe: pi awaits the extension
 * module graph before invoking the factory.
 */
type FooterPrototype = {
  render: FooterRender;
  [key: symbol]: FooterRender | undefined;
};

type FooterComponentConstructor = { prototype: FooterPrototype };

function isFooterComponentConstructor(value: unknown): value is FooterComponentConstructor {
  if (typeof value !== "function") return false;
  const prototype = (value as { prototype?: FooterPrototype }).prototype;
  return typeof prototype?.render === "function";
}

async function loadFooterComponent(): Promise<FooterComponentConstructor | undefined> {
  try {
    const module = await import("@earendil-works/pi-coding-agent");
    const candidate = (module as unknown as { FooterComponent?: unknown }).FooterComponent;
    if (isFooterComponentConstructor(candidate)) return candidate;
    footerLog.warn("FooterComponent has no render(); Telegram status alignment disabled", {
      type: typeof candidate,
    });
  } catch (error) {
    footerLog.warn("FooterComponent unavailable; Telegram status alignment disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

const FOOTER_COMPONENT = await loadFooterComponent();

type FooterDataView = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type FooterRender = (this: FooterComponent, width: number) => string[];
type FooterWithData = { footerData: FooterDataView };

const ORIGINAL_RENDER_KEY = Symbol.for("pi-telegram-plus.footer.original-render");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isWideCharacter(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function terminalWidth(text: string): number {
  const plainText = stripVTControlCharacters(text);
  let width = 0;

  for (const { segment } of graphemeSegmenter.segment(plainText)) {
    if (/\p{Extended_Pictographic}/u.test(segment)
      || /\p{Regional_Indicator}{2}/u.test(segment)
      || /[\uFE0F\u20E3]/u.test(segment)) {
      width += 2;
      continue;
    }

    for (const character of segment) {
      if (/[\p{Control}\p{Mark}]/u.test(character) || character === "\u200d") continue;
      width += isWideCharacter(character.codePointAt(0) ?? 0) ? 2 : 1;
    }
  }

  return width;
}

export function rightAlignStatusText(text: string, width: number): string {
  const padding = Math.max(0, width - terminalWidth(text));
  return `${" ".repeat(padding)}${text}`;
}

function createFooterDataView(
  footerData: FooterDataView,
  statuses: ReadonlyMap<string, string>,
): FooterDataView {
  return {
    getGitBranch: () => footerData.getGitBranch(),
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
    onBranchChange: (callback) => footerData.onBranchChange(callback),
  };
}

export function renderFooterWithTelegramStatusRight(
  footer: FooterComponent,
  originalRender: FooterRender,
  width: number,
): string[] {
  const footerWithData = footer as unknown as FooterWithData;
  const footerData = footerWithData.footerData;
  const statuses = footerData.getExtensionStatuses();
  const telegramStatus = statuses.get(TELEGRAM_STATUS_KEY);
  if (telegramStatus === undefined) return originalRender.call(footer, width);

  const telegramStatuses = new Map([[TELEGRAM_STATUS_KEY, telegramStatus]]);
  const otherStatuses = new Map(statuses);
  otherStatuses.delete(TELEGRAM_STATUS_KEY);

  try {
    footerWithData.footerData = createFooterDataView(footerData, telegramStatuses);
    const telegramLines = originalRender.call(footer, width);
    const telegramLine = telegramLines.at(-1);

    footerWithData.footerData = createFooterDataView(footerData, otherStatuses);
    const lines = originalRender.call(footer, width);
    if (telegramLine !== undefined) {
      lines.splice(Math.min(2, lines.length), 0, rightAlignStatusText(telegramLine, width));
    }
    return lines;
  } finally {
    footerWithData.footerData = footerData;
  }
}

/**
 * Installs the right-alignment patch onto a given `FooterComponent`-shaped
 * constructor. Exported for tests: it carries the whole install logic, so the
 * degradation and idempotency paths can be exercised without a real pi install.
 *
 * Validates its input rather than trusting the caller: a malformed candidate (a
 * plain object, a class without `render`) degrades to a no-op instead of throwing,
 * which is the whole point of this seam.
 *
 * Idempotent via ORIGINAL_RENDER_KEY: a second call is a no-op and never captures
 * an already-patched render as the "original".
 */
export function installAlignmentOn(component: unknown): boolean {
  if (!isFooterComponentConstructor(component)) return false;

  const prototype = component.prototype;
  if (prototype[ORIGINAL_RENDER_KEY]) return true;

  const originalRender = prototype.render;
  Object.defineProperty(prototype, ORIGINAL_RENDER_KEY, { value: originalRender });
  prototype.render = function renderWithTelegramStatusRight(width: number): string[] {
    return renderFooterWithTelegramStatusRight(this as unknown as FooterComponent, originalRender, width);
  };
  return true;
}

/**
 * Installs the right-alignment patch on the real `FooterComponent.prototype`.
 *
 * Synchronous by design (see FOOTER_COMPONENT above). Never throws: when
 * `FooterComponent` could not be resolved, this degrades to a no-op so the
 * extension still loads and every other Telegram feature keeps working.
 *
 * @returns true when the patch is installed, false when it degraded to a no-op.
 */
export function installTelegramStatusAlignment(): boolean {
  return installAlignmentOn(FOOTER_COMPONENT);
}
