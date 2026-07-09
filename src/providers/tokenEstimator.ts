/**
 * Deterministic, dependency-free token estimator.
 *
 * LLM providers charge for tokens, not characters. To drive the status
 * bar and the auto-compaction policy we need a fast, *deterministic*
 * estimate of the tokens an outgoing prompt will use. The estimate
 * doesn't need to be byte-exact — it needs to be:
 *   1. Deterministic (same input → same output every time, so the
 *      status bar and tests don't jitter).
 *   2. Fast (called on every keystroke for the status bar, and on
 *      every send for auto-compaction).
 *   3. Directionally accurate (rounded within ~15% of real counts
 *      so the 40% threshold lands in the right ballpark).
 *
 * Approach: BPE-grade tokenizers are out of scope for a frontend-only
 * estimator. We use a content-aware heuristic:
 *   - Words: roughly 1 token per 4 characters of contiguous
 *     non-whitespace, matching the OpenAI "1 token ≈ 4 chars in
 *     English" rule of thumb.
 *   - Code / symbols: bumped up because identifiers, operators, and
 *     punctuation each consume a token. We treat every non-alphanumeric
 *     character outside of whitespace as a separate token contribution.
 *   - Whitespace runs: collapsed (BPE eats them cheaply).
 *   - CJK / wide-character runs: roughly 1 token per character (the
 *     common ratio for non-Latin scripts).
 *
 * The result is a single integer. Round to nearest so the status bar
 * doesn't shimmer.
 */

const NON_WHITESPACE_TOKEN_RATIO = 0.25; // 1 token per 4 chars
const CJK_CHAR_RATIO = 1.0; // 1 token per char
const SYMBOL_WEIGHT = 0.5; // extra per non-alphanumeric, non-space char

/**
 * Conservative token estimate for a single string. Pure — same input
 * always produces the same integer.
 */
export function estimateTokensForString(input: string | null | undefined): number {
  if (!input) return 0;
  // Early-out for the empty string.
  if (input.length === 0) return 0;

  let tokens = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const code = input.charCodeAt(i);

    // CJK Unified Ideographs (rough range) — treat as 1 token per char.
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
      (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
    ) {
      tokens += CJK_CHAR_RATIO;
      i += 1;
      continue;
    }

    // Whitespace: skip without adding tokens (BPE eats runs cheaply).
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      i += 1;
      continue;
    }

    // Alphanumeric run: count as ~4 chars per token.
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      code === 0x5f // underscore (treat as letter for identifier runs)
    ) {
      let j = i;
      while (j < n) {
        const c = input.charCodeAt(j);
        const isAlnum =
          (c >= 0x30 && c <= 0x39) ||
          (c >= 0x41 && c <= 0x5a) ||
          (c >= 0x61 && c <= 0x7a) ||
          c === 0x5f;
        if (!isAlnum) break;
        j += 1;
      }
      const runLen = j - i;
      tokens += runLen * NON_WHITESPACE_TOKEN_RATIO;
      i = j;
      continue;
    }

    // Punctuation / symbol / anything else: contributes 1 token plus
    // its own symbol weight.
    tokens += 1 + SYMBOL_WEIGHT;
    i += 1;
  }

  return Math.max(0, Math.round(tokens));
}

export interface ProviderMessageLike {
  role: string;
  content: string;
}

/**
 * One part of a multimodal message content array. Mirrors the OpenAI /
 * Anthropic shapes (text + image_url). Kept loose on purpose — provider
 * adapters own the final wire format; this is just the shape the chat
 * loop builds so image bytes can travel to the model.
 */
export type OutboundContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type OutboundContent = string | OutboundContentPart[];

export interface ProviderMessageLikeMultimodal {
  role: string;
  content: OutboundContent;
}

/**
 * Estimate tokens for an array of provider messages. Adds a flat 4-token
 * per-message overhead (the model's role / boundary markers). Accepts
 * either plain-string content or the multimodal `OutboundContent` shape
 * (string | part[]). For arrays, text parts count their text and image
 * parts count a flat per-image allowance so the estimator doesn't
 * under-report when a user pastes screenshots.
 */
export function estimateTokensForMessages(
  messages: ReadonlyArray<ProviderMessageLike | ProviderMessageLikeMultimodal>,
): number {
  if (!messages || messages.length === 0) return 0;
  let total = 0;
  for (const msg of messages) {
    total += estimateTokensForContent(msg.content) + 4;
  }
  return total;
}

function estimateTokensForContent(content: OutboundContent): number {
  if (typeof content === "string") return estimateTokensForString(content);
  let tokens = 0;
  for (const part of content) {
    if (part.type === "text") {
      tokens += estimateTokensForString(part.text);
    } else if (part.type === "image_url") {
      // Rough per-image cost (covers Anthropic/OpenAI low-detail band).
      // High-detail is closer to 1500+ but conservative here is fine
      // because the trigger threshold is 40% of window.
      tokens += 85;
    }
  }
  return tokens;
}

/**
 * Estimate tokens for a single string. Thin wrapper used by the status
 * bar — kept separate so future swapping to a real BPE tokenizer is
 * a one-line change.
 */
export function estimateTokens(input: string | null | undefined): number {
  return estimateTokensForString(input);
}
