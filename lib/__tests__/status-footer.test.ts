import type { FooterComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  installAlignmentOn,
  installTelegramStatusAlignment,
  renderFooterWithTelegramStatusRight,
  rightAlignStatusText,
} from "../status-footer.ts";
import { TELEGRAM_STATUS_KEY } from "../status.ts";

type TestFooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type TestFooter = { footerData: TestFooterData };

function createFooter(statuses: ReadonlyMap<string, string>): {
  footer: TestFooter;
  footerData: TestFooterData;
} {
  const footerData: TestFooterData = {
    getGitBranch: () => "master",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => undefined,
  };
  return {
    footer: { footerData },
    footerData,
  };
}

function renderTestFooter(this: FooterComponent): string[] {
  const footerData = (this as unknown as TestFooter).footerData;
  const lines = ["~/workspace", "stats                  model"];
  const statusLine = [...footerData.getExtensionStatuses().values()].join(" ");
  if (statusLine) lines.push(statusLine);
  return lines;
}

describe("rightAlignStatusText", () => {
  it("right-aligns ANSI-colored text by visible width", () => {
    const text = "\u001b[32mtelegram+\u001b[39m connected";
    expect(rightAlignStatusText(text, 24)).toBe(`     ${text}`);
  });

  it("counts wide characters as two terminal cells", () => {
    // CJK for "status", written as escapes: each character is two terminal cells.
    expect(rightAlignStatusText("\u72b6\u6001", 6)).toBe("  \u72b6\u6001");
  });
});

describe("renderFooterWithTelegramStatusRight", () => {
  it("places Telegram status below the model and keeps other statuses", () => {
    const statuses = new Map([
      ["goal", "goal active"],
      [TELEGRAM_STATUS_KEY, "telegram+ connected"],
    ]);
    const { footer, footerData } = createFooter(statuses);

    const lines = renderFooterWithTelegramStatusRight(
      footer as unknown as FooterComponent,
      renderTestFooter,
      24,
    );

    expect(lines).toEqual([
      "~/workspace",
      "stats                  model",
      "     telegram+ connected",
      "goal active",
    ]);
    expect(footer.footerData).toBe(footerData);
  });

  it("uses the original renderer once when Telegram status is absent", () => {
    const { footer } = createFooter(new Map([["goal", "goal active"]]));
    const render = vi.fn(renderTestFooter);

    expect(renderFooterWithTelegramStatusRight(
      footer as unknown as FooterComponent,
      render,
      24,
    )).toEqual([
      "~/workspace",
      "stats                  model",
      "goal active",
    ]);
    expect(render).toHaveBeenCalledOnce();
  });
});

/**
 * These cover the upstream-drift degradation path.
 *
 * pi >= 1.0.0 pulls `@earendil-works/pi-codemode` through a caret range, and
 * pi-codemode 1.2.0 removed `MCP_TYPESCRIPT_PREAMBLE`, which pi still imports. A
 * lockfile-less install therefore fails to import the package root outside the pi CLI
 * (the CLI masks it via its virtual-module alias table). Resolution is guarded so the
 * extension degrades to a no-op instead of failing to load.
 */
describe("installAlignmentOn", () => {
  function createFakeFooterConstructor() {
    class FakeFooter {
      footerData = createFooter(new Map()).footerData;
      render(_width: number): string[] {
        return ["original"];
      }
    }
    return FakeFooter as unknown as { prototype: Record<symbol, unknown> & { render: (w: number) => string[] } };
  }

  it("degrades to a no-op when FooterComponent could not be resolved", () => {
    expect(installAlignmentOn(undefined)).toBe(false);
  });

  it("patches render and routes it through the Telegram status renderer", () => {
    const Footer = createFakeFooterConstructor();
    const original = Footer.prototype.render;

    expect(installAlignmentOn(Footer as never)).toBe(true);
    expect(Footer.prototype.render).not.toBe(original);

    const instance = new (Footer as unknown as new () => { render(w: number): string[] })();
    expect(instance.render(20)).toEqual(["original"]);
  });

  it("is idempotent and never captures a patched render as the original", () => {
    const Footer = createFakeFooterConstructor();
    const original = Footer.prototype.render;

    installAlignmentOn(Footer as never);
    const firstPatch = Footer.prototype.render;
    expect(installAlignmentOn(Footer as never)).toBe(true);
    expect(Footer.prototype.render).toBe(firstPatch);

    // Call twice more: a double capture would return ["original","original"]-style
    // nesting instead of the plain original output.
    const instance = new (Footer as unknown as new () => { render(w: number): string[] })();
    expect(instance.render(20)).toEqual(["original"]);
    expect(original).toBeDefined();
  });

  it("never throws for a non-constructor or render-less candidate", () => {
    expect(() => installAlignmentOn(undefined)).not.toThrow();
    expect(installAlignmentOn({} as never)).toBe(false);
  });
});

describe("installTelegramStatusAlignment", () => {
  it("returns a boolean and never throws, whatever the ambient pi install looks like", () => {
    const result = installTelegramStatusAlignment();
    expect(typeof result).toBe("boolean");
    // Idempotent: a second call reports success again without re-patching.
    expect(installTelegramStatusAlignment()).toBe(result);
  });
});
