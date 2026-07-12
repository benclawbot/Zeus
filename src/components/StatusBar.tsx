/**
 * Status bar — pinned to the bottom of the workspace.
 *
 * Renders:
 *   - Active model + provider
 *   - Live token count of the next outgoing prompt vs. the model's
 *     context window, with a percentage indicator
 *   - The auto-compaction threshold for the active model
 *   - A colour-coded status pill (green / amber / red) driven by the
 *     ratio against the threshold
 *
 * Pure: the parent owns the token count, the model id, and the
 * provider id. This component re-renders cheaply because the props
 * shape is small.
 */

import React from "react";
import { contextWindowUsage, lookupContextWindow } from "../providers/contextWindow";
import { DEFAULT_COMPACT_TRIGGER_RATIO } from "../providers/autoCompact";

export interface StatusBarProps {
  /** Active model id, e.g. "MiniMax-M3". */
  modelId: string;
  /** Active provider id, e.g. "minimax". */
  providerId: string;
  /** Token count of the next outgoing prompt (already built). */
  promptTokens: number;
  /** Provider-reported input tokens for the last completed turn. */
  actualPromptTokens?: number;
  /** Trigger ratio for auto-compaction, default 0.4. */
  triggerRatio?: number;
  /** Optional click handler — usually routes to the Settings view. */
  onOpenSettings?: () => void;
}

interface BandResult {
  label: string;
  className: string;
}

function ratioBand(ratio: number, threshold: number, isActual: boolean): BandResult {
  if (ratio <= 0) return { label: "idle", className: "status-bar-band idle" };
  if (ratio >= threshold) return { label: isActual ? "over target" : "compact on send", className: "status-bar-band red" };
  if (ratio >= threshold * 0.75) return { label: "watch", className: "status-bar-band amber" };
  return { label: "ok", className: "status-bar-band green" };
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { modelId, providerId, promptTokens, actualPromptTokens, onOpenSettings } = props;
  const displayedTokens = actualPromptTokens ?? promptTokens;
  const triggerRatio = props.triggerRatio ?? DEFAULT_COMPACT_TRIGGER_RATIO;
  const contextWindow = lookupContextWindow(modelId, providerId);
  const ratio = contextWindowUsage(displayedTokens, modelId, providerId);
  const band = ratioBand(ratio, triggerRatio, actualPromptTokens !== undefined);
  const percentText = `${(ratio * 100).toFixed(1)}%`;
  const thresholdText = `${Math.round(triggerRatio * 100)}%`;
  const promptDisplay = formatTokens(displayedTokens);
  const windowDisplay = formatTokens(contextWindow);

  return (
    <div
      className="status-bar"
      role="status"
      aria-live="polite"
      aria-label="Conversation status"
    >
      <div className="status-bar-cell status-bar-model" title={`${providerId}/${modelId}`}>
        <span className="status-bar-label">Model</span>
        <span className="status-bar-value">{modelId || "—"}</span>
      </div>
      <div
        className="status-bar-cell status-bar-context"
        title={actualPromptTokens === undefined
          ? `Projected next prompt: ${promptTokens.toLocaleString()} tokens / ${contextWindow.toLocaleString()} window`
          : `Last provider input: ${actualPromptTokens.toLocaleString()} tokens / ${contextWindow.toLocaleString()} window; next estimate: ${promptTokens.toLocaleString()}`}
      >
        <span className="status-bar-label">Context</span>
        <span className="status-bar-value">
          {promptDisplay} / {windowDisplay}{actualPromptTokens === undefined ? " est." : " actual"}
        </span>
        <span className="status-bar-percent">{percentText}</span>
        <div className="status-bar-track" aria-hidden="true">
          <div
            className="status-bar-fill"
            style={{ width: `${Math.min(100, ratio * 100).toFixed(1)}%` }}
          />
          <div
            className="status-bar-threshold"
            style={{ left: `${(triggerRatio * 100).toFixed(1)}%` }}
            title={`Auto-compact at ${thresholdText}`}
          />
        </div>
        <span className={band.className}>{band.label}</span>
      </div>
      <div className="status-bar-cell status-bar-trigger" title={`Auto-compact fires at ${thresholdText} of the context window`}>
        <span className="status-bar-label">Auto-compact</span>
        <span className="status-bar-value">≥ {thresholdText}</span>
      </div>
      {onOpenSettings ? (
        <button
          type="button"
          className="status-bar-settings"
          onClick={onOpenSettings}
          aria-label="Open settings"
        >
          ⚙
        </button>
      ) : null}
    </div>
  );
}
