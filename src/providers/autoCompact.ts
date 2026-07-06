/**
 * Auto-compaction policy.
 *
 * Decides whether the current outgoing prompt is large enough that the
 * chat history should be compacted automatically *before* sending. The
 * threshold is 40% of the active model's context window, per the user
 * request: "automatic context compaction when 40% of the context window
 * for a given model is filled".
 *
 * Why 40% rather than e.g. 80%? Two reasons:
 *   1. The model is charged for *output* too. Reserving at least 60% of
 *      the window for completion, follow-up tool results, and any
 *      system messages added at send time keeps the conversation from
 *      hitting the wall mid-turn.
 *   2. The token estimator is approximate. A 40% trigger with a ±15%
 *      estimator means the real threshold is in the 34–46% band — still
 *      safely under the wire.
 *
 * The actual compaction logic is delegated to the existing
 * `compactContext` flow in App.tsx; this module is *pure policy*: given
 * the current outgoing prompt + active model, return a decision.
 */

import { lookupContextWindow } from "./contextWindow";
import { estimateTokensForMessages, type ProviderMessageLike } from "./tokenEstimator";

/** Default trigger threshold. Overridable for tests / power users. */
export const DEFAULT_COMPACT_TRIGGER_RATIO = 0.4;

export interface AutoCompactDecision {
  /** Should the chat history be compacted before sending? */
  shouldCompact: boolean;
  /** Estimated tokens in the outgoing prompt. */
  estimatedTokens: number;
  /** Active model's context window. */
  contextWindow: number;
  /** Ratio of window used by the prompt (0..1). */
  ratio: number;
  /** Threshold that triggered the decision. */
  threshold: number;
}

/**
 * Decide whether to auto-compact. Pure — same inputs always yield the
 * same decision. The caller is responsible for actually running the
 * compaction; this module only reports *what to do*.
 */
export function decideAutoCompact(
  messages: ReadonlyArray<ProviderMessageLike>,
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  threshold: number = DEFAULT_COMPACT_TRIGGER_RATIO,
): AutoCompactDecision {
  const contextWindow = lookupContextWindow(modelId ?? undefined, providerId ?? undefined);
  const estimatedTokens = estimateTokensForMessages(messages);
  const ratio = contextWindow > 0 ? estimatedTokens / contextWindow : 0;
  const shouldCompact = ratio >= threshold && estimatedTokens > 0;
  return {
    shouldCompact,
    estimatedTokens,
    contextWindow,
    ratio,
    threshold,
  };
}

/**
 * Human-readable summary for a compact action, e.g.
 *   "Auto-compacted at 41% (52,400 / 128,000 tokens)"
 * Used by the chat bubble that gets appended when auto-compaction fires.
 */
export function formatCompactNotice(decision: AutoCompactDecision): string {
  const pct = (decision.ratio * 100).toFixed(1);
  return `Auto-compacted at ${pct}% of the model's context window (${decision.estimatedTokens.toLocaleString()} / ${decision.contextWindow.toLocaleString()} tokens).`;
}
