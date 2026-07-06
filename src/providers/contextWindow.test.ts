import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  contextWindowUsage,
  lookupContextWindow,
  lookupModelInfo,
} from "./contextWindow";

describe("lookupContextWindow", () => {
  it("returns the MiniMax-M3 window exactly", () => {
    expect(lookupContextWindow("MiniMax-M3", "minimax")).toBe(128_000);
  });

  it("is case-insensitive for model id", () => {
    expect(lookupContextWindow("gpt-4o", "openai")).toBe(128_000);
    expect(lookupContextWindow("GPT-4O", "openai")).toBe(128_000);
  });

  it("falls back to 32K for unknown models", () => {
    expect(lookupContextWindow("totally-made-up-model", "openai")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("falls back to 32K for empty / null input without throwing", () => {
    expect(lookupContextWindow(null, "openai")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(lookupContextWindow("", "openai")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(lookupContextWindow(undefined, "openai")).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("matches by prefix when the full id has a dated suffix", () => {
    // Future-dated snapshot: should still resolve to gpt-4o.
    expect(lookupContextWindow("gpt-4o-2025-08-06", "openai")).toBe(128_000);
  });

  it("matches Anthropic Claude 3.5 Sonnet (200K)", () => {
    expect(lookupContextWindow("claude-3-5-sonnet-20241022", "anthropic")).toBe(200_000);
  });
});

describe("lookupModelInfo", () => {
  it("returns the full record when found", () => {
    const info = lookupModelInfo("gpt-4o", "openai");
    expect(info).not.toBeNull();
    expect(info?.contextWindow).toBe(128_000);
    expect(info?.providerId).toBe("openai");
  });

  it("returns null for unknown models", () => {
    expect(lookupModelInfo("totally-fake", "openai")).toBeNull();
  });
});

describe("contextWindowUsage", () => {
  it("returns 0 for empty / negative input", () => {
    expect(contextWindowUsage(0, "gpt-4o", "openai")).toBe(0);
    expect(contextWindowUsage(-5, "gpt-4o", "openai")).toBe(0);
  });

  it("computes the ratio for a partial window", () => {
    // 40% of 128K is 51200.
    const result = contextWindowUsage(51_200, "gpt-4o", "openai");
    expect(result).toBeCloseTo(0.4, 5);
  });

  it("saturates at 1.0 when the prompt exceeds the window", () => {
    expect(contextWindowUsage(200_000, "gpt-4o", "openai")).toBe(1);
  });

  it("handles NaN / Infinity safely", () => {
    expect(contextWindowUsage(NaN, "gpt-4o", "openai")).toBe(0);
    expect(contextWindowUsage(Infinity, "gpt-4o", "openai")).toBe(1);
  });
});
