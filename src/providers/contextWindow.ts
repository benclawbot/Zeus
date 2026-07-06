/**
 * Model context-window registry.
 *
 * The Zeus status bar shows the live percentage of the *active model's*
 * context window that the current outgoing prompt will use, and the
 * pre-send pipeline auto-compacts the chat history when that share
 * crosses 40% (see `autoCompact.ts`).
 *
 * This module is the single source of truth for both the registry and
 * the lookup. Add a new model here once and every consumer (status bar,
 * auto-compaction, future compression pipeline) picks it up.
 *
 * Token counts come from the model provider's published context-window
 * spec. When a model id isn't in the table we fall back to a conservative
 * 32K default rather than guessing — over-estimating the window is
 * strictly worse than under-estimating it for an auto-compaction policy.
 */

export interface ModelContextInfo {
  /** Stable id as known to the provider. Case-insensitive lookup. */
  modelId: string;
  /** Maximum total tokens (input + output) the model accepts. */
  contextWindow: number;
  /** Soft recommended cap for output, used for status bar tooltip. */
  maxOutput?: number;
  /** Provider id this model belongs to. */
  providerId: string;
}

/**
 * Authoritative model table. Values are the public context windows.
 * Order is irrelevant — `lookupContextWindow` does a lowercase compare.
 */
export const MODEL_CONTEXT_TABLE: ReadonlyArray<ModelContextInfo> = [
  // MiniMax
  { modelId: "MiniMax-M3", providerId: "minimax", contextWindow: 128_000, maxOutput: 16_000 },
  { modelId: "minimax-m3", providerId: "minimax", contextWindow: 128_000, maxOutput: 16_000 },

  // OpenAI
  { modelId: "gpt-4o", providerId: "openai", contextWindow: 128_000, maxOutput: 16_384 },
  { modelId: "gpt-4o-mini", providerId: "openai", contextWindow: 128_000, maxOutput: 16_384 },
  { modelId: "gpt-4-turbo", providerId: "openai", contextWindow: 128_000, maxOutput: 4_096 },
  { modelId: "gpt-4", providerId: "openai", contextWindow: 8_192, maxOutput: 8_192 },
  { modelId: "gpt-3.5-turbo", providerId: "openai", contextWindow: 16_385, maxOutput: 4_096 },
  { modelId: "o1", providerId: "openai", contextWindow: 200_000, maxOutput: 100_000 },
  { modelId: "o1-mini", providerId: "openai", contextWindow: 128_000, maxOutput: 65_536 },
  { modelId: "o1-preview", providerId: "openai", contextWindow: 128_000, maxOutput: 32_768 },
  { modelId: "o3-mini", providerId: "openai", contextWindow: 200_000, maxOutput: 100_000 },

  // Anthropic
  { modelId: "claude-3-5-sonnet-latest", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
  { modelId: "claude-3-5-sonnet-20241022", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
  { modelId: "claude-3-5-sonnet-20240620", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
  { modelId: "claude-3-5-haiku-latest", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
  { modelId: "claude-3-opus-20240229", providerId: "anthropic", contextWindow: 200_000, maxOutput: 4_096 },
  { modelId: "claude-3-haiku-20240307", providerId: "anthropic", contextWindow: 200_000, maxOutput: 4_096 },
  { modelId: "claude-3-sonnet-20240229", providerId: "anthropic", contextWindow: 200_000, maxOutput: 4_096 },
  { modelId: "claude-sonnet-4-5", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
  { modelId: "claude-opus-4-5", providerId: "anthropic", contextWindow: 200_000, maxOutput: 8_192 },
];

/** Fallback window when a model id is unknown. Conservative on purpose. */
export const DEFAULT_CONTEXT_WINDOW = 32_000;

/**
 * Look up the context window for a model id, case-insensitive. Falls back
 * to `DEFAULT_CONTEXT_WINDOW` when the model is unknown. Never throws.
 */
export function lookupContextWindow(modelId: string | null | undefined, providerId?: string): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  const target = modelId.trim().toLowerCase();
  if (!target) return DEFAULT_CONTEXT_WINDOW;

  // First, try an exact provider+model match.
  if (providerId) {
    const pid = providerId.trim().toLowerCase();
    const exact = MODEL_CONTEXT_TABLE.find(
      (entry) => entry.providerId === pid && entry.modelId.toLowerCase() === target,
    );
    if (exact) return exact.contextWindow;
  }

  // Then, any provider's matching model id (e.g. "gpt-4o" via either
  // provider wrapper).
  const any = MODEL_CONTEXT_TABLE.find((entry) => entry.modelId.toLowerCase() === target);
  if (any) return any.contextWindow;

  // Try a prefix match: "gpt-4o-2024-..." should still resolve to gpt-4o.
  const prefix = MODEL_CONTEXT_TABLE.find((entry) => target.startsWith(entry.modelId.toLowerCase()));
  if (prefix) return prefix.contextWindow;

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Look up the full info record (window + max output + provider) for a
 * model. Returns null when the model is not in the table — callers that
 * just need a number should prefer `lookupContextWindow`.
 */
export function lookupModelInfo(modelId: string | null | undefined, providerId?: string): ModelContextInfo | null {
  if (!modelId) return null;
  const target = modelId.trim().toLowerCase();
  if (!target) return null;
  if (providerId) {
    const pid = providerId.trim().toLowerCase();
    const exact = MODEL_CONTEXT_TABLE.find(
      (entry) => entry.providerId === pid && entry.modelId.toLowerCase() === target,
    );
    if (exact) return exact;
  }
  const any = MODEL_CONTEXT_TABLE.find((entry) => entry.modelId.toLowerCase() === target);
  if (any) return any;
  const prefix = MODEL_CONTEXT_TABLE.find((entry) => target.startsWith(entry.modelId.toLowerCase()));
  return prefix ?? null;
}

/**
 * Compute the percentage of the model's context window that the given
 * token count represents. Returns a number in `[0, 1]`. Saturates at 1.0
 * when the token count exceeds the window (status bar caps the display).
 */
export function contextWindowUsage(tokens: number, modelId: string | null | undefined, providerId?: string): number {
  if (tokens === Infinity) return 1;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  const window = lookupContextWindow(modelId, providerId);
  if (window <= 0) return 0;
  return Math.min(1, tokens / window);
}
