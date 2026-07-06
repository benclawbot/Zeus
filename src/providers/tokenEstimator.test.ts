import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTokensForMessages, estimateTokensForString } from "./tokenEstimator";

describe("estimateTokensForString", () => {
  it("returns 0 for empty / null / undefined input", () => {
    expect(estimateTokensForString("")).toBe(0);
    expect(estimateTokensForString(null)).toBe(0);
    expect(estimateTokensForString(undefined)).toBe(0);
  });

  it("is deterministic for the same input", () => {
    const input = "the quick brown fox jumps over the lazy dog";
    expect(estimateTokensForString(input)).toBe(estimateTokensForString(input));
  });

  it("treats whitespace as zero-cost", () => {
    expect(estimateTokensForString("   \n\t  ")).toBe(0);
  });

  it("handles plain English at roughly 1 token per 4 characters", () => {
    // 40 chars of pure letters → ~10 tokens.
    const input = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
    const tokens = estimateTokensForString(input);
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it("adds a small weight for symbols and punctuation", () => {
    // ~27 punctuation chars → ~40 tokens (each char is 1 + 0.5 weight).
    const input = "!@#$%^&*()_+-={}[]|:;\"'<>,.?/`~";
    const tokens = estimateTokensForString(input);
    expect(tokens).toBeGreaterThanOrEqual(20);
    expect(tokens).toBeLessThanOrEqual(50);
  });

  it("treats CJK characters as roughly 1 token per character", () => {
    // 10 CJK chars → ~10 tokens.
    const input = "你好世界测试用例代码";
    const tokens = estimateTokensForString(input);
    expect(tokens).toBeGreaterThanOrEqual(9);
    expect(tokens).toBeLessThanOrEqual(11);
  });

  it("treats identifier runs as alphanumeric", () => {
    // snake_case identifier: 9 chars → ~2 tokens, plus underscore weights
    // contributing minor extras.
    const input = "my_func_name";
    const tokens = estimateTokensForString(input);
    expect(tokens).toBeGreaterThanOrEqual(2);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it("handles a realistic mixed prompt", () => {
    const prompt = "def calculate_total(items: list[int]) -> int:\n    return sum(items)";
    const tokens = estimateTokensForString(prompt);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(40);
  });
});

describe("estimateTokensForMessages", () => {
  it("returns 0 for an empty array", () => {
    expect(estimateTokensForMessages([])).toBe(0);
  });

  it("adds a 4-token overhead per message", () => {
    const tokens = estimateTokensForMessages([
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ]);
    // 2 messages × 4 overhead = 8 tokens, plus body tokens (0 here).
    expect(tokens).toBe(8);
  });

  it("sums body and overhead", () => {
    const tokens = estimateTokensForMessages([
      { role: "user", content: "hello world" },
      { role: "assistant", content: "hi there friend" },
    ]);
    // Body + 4 per message.
    expect(tokens).toBeGreaterThan(8);
  });
});

describe("estimateTokens (thin wrapper)", () => {
  it("matches estimateTokensForString for non-null input", () => {
    expect(estimateTokens("hello")).toBe(estimateTokensForString("hello"));
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});
