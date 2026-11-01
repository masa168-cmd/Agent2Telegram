import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../ansi.ts";

describe("stripAnsi", () => {
  it("removes SGR escape codes", () => {
    expect(stripAnsi("\x1B[1mbold\x1B[22m text")).toBe("bold text");
  });

  it("removes 256-color codes", () => {
    expect(stripAnsi("\x1B[38;5;42mcolored\x1B[39m")).toBe("colored");
  });

  it("passes plain text through", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});
