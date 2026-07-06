import { describe, expect, it } from "vitest";
import { decideAutoCompact, formatCompactNotice, DEFAULT_COMPACT_TRIGGER_RATIO } from "./autoCompact";

function msg(role: string, content: string) {
  return { role, content };
}

describe("decideAutoCompact", () => {
  it("returns shouldCompact=false for empty messages", () => {
    const decision = decideAutoCompact([], "gpt-4o", "openai");
    expect(decision.shouldCompact).toBe(false);
    expect(decision.estimatedTokens).toBe(0);
    expect(decision.contextWindow).toBe(128_000);
    expect(decision.ratio).toBe(0);
  });

  it("returns shouldCompact=false when well under 40%", () => {
    // ~20 tokens of body + 4 overhead = 24 tokens. ~0.02% of 128K.
    const decision = decideAutoCompact([msg("user", "hi")], "gpt-4o", "openai");
    expect(decision.shouldCompact).toBe(false);
    expect(decision.ratio).toBeLessThan(DEFAULT_COMPACT_TRIGGER_RATIO);
  });

  it("triggers when the prompt crosses the 40% threshold", () => {
    // Build a >50K-token prompt. 50K / 128K = 39%, just under. Push
    // to ~60K to be safely over the 40% line.
    const big = "word ".repeat(60_000).trim();
    const decision = decideAutoCompact([msg("user", big)], "gpt-4o", "openai");
    expect(decision.estimatedTokens).toBeGreaterThan(50_000);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.ratio).toBeGreaterThan(0.4);
  });

  it("uses the correct context window for the active model", () => {
    // MiniMax-M3 has 128K. Anthropic Claude 3.5 Sonnet has 200K. The same
    // prompt should be relatively smaller against a 200K window.
    const prompt = "word ".repeat(60_000).trim();
    const minimax = decideAutoCompact([msg("user", prompt)], "MiniMax-M3", "minimax");
    const claude = decideAutoCompact([msg("user", prompt)], "claude-3-5-sonnet-latest", "anthropic");
    expect(minimax.contextWindow).toBe(128_000);
    expect(claude.contextWindow).toBe(200_000);
    expect(minimax.ratio).toBeGreaterThan(claude.ratio);
  });

  it("falls back to the default 32K window for unknown models", () => {
    const prompt = "word ".repeat(13_000).trim();
    const decision = decideAutoCompact([msg("user", prompt)], "totally-unknown-model", "openai");
    expect(decision.contextWindow).toBe(32_000);
  });

  it("respects a custom threshold", () => {
    // ~200 tokens of body. With threshold=0.001 this should compact;
    // with threshold=0.99 it should not.
    const prompt = "word ".repeat(800).trim();
    const lowThreshold = decideAutoCompact([msg("user", prompt)], "gpt-4o", "openai", 0.001);
    const highThreshold = decideAutoCompact([msg("user", prompt)], "gpt-4o", "openai", 0.99);
    expect(lowThreshold.shouldCompact).toBe(true);
    expect(highThreshold.shouldCompact).toBe(false);
  });

  it("never triggers for a zero-token prompt (empty chat)", () => {
    const decision = decideAutoCompact([msg("user", "")], "gpt-4o", "openai");
    expect(decision.shouldCompact).toBe(false);
  });
});

describe("formatCompactNotice", () => {
  it("renders a one-line human-readable summary", () => {
    const decision = decideAutoCompact([msg("user", "word ".repeat(60_000).trim())], "gpt-4o", "openai");
    const notice = formatCompactNotice(decision);
    expect(notice).toMatch(/Auto-compacted at \d+\.\d%/);
    expect(notice).toContain(decision.estimatedTokens.toLocaleString());
    expect(notice).toContain(decision.contextWindow.toLocaleString());
  });
});
