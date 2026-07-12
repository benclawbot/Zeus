import { describe, expect, it } from "vitest";
import { cacheReadPercent, normalizeTokenUsage } from "./tokenUsage";

describe("normalizeTokenUsage", () => {
  it("normalizes OpenAI cached tokens", () => {
    expect(normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 750 } }))
      .toEqual({ input: 1000, output: 50, cacheRead: 750 });
  });

  it("normalizes Anthropic cache read and creation tokens", () => {
    expect(normalizeTokenUsage({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 600, cache_creation_input_tokens: 200 }))
      .toEqual({ input: 1000, output: 50, cacheRead: 600, cacheWrite: 200 });
  });

  it("keeps absent cache telemetry unknown", () => {
    expect(normalizeTokenUsage({ input_tokens: 100, output_tokens: 10 }))
      .toEqual({ input: 100, output: 10 });
  });

  it("clamps cache percentage", () => {
    expect(cacheReadPercent({ input: 100, output: 1, cacheRead: 150 })).toBe(100);
    expect(cacheReadPercent({ input: 0, output: 1, cacheRead: 0 })).toBe(0);
  });
});
