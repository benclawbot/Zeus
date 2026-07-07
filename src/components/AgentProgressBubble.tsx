import { Check, ChevronDown, ChevronRight, Sparkles, X } from "lucide-react";
import React, { useState } from "react";

export type AgentStepStatus = "pending" | "running" | "ok" | "failed";

export interface AgentProgressStep {
  index: number;
  label: string;
  status: AgentStepStatus;
  result?: string;
}

export interface MappedStepResult {
  status: Exclude<AgentStepStatus, "pending" | "running">;
  message?: string;
}

/**
 * Map the unknown `AgentRunStepLog.result` payload (a serialized Rust enum
 * with `#[serde(tag = "kind", rename_all = "camelCase")]`) to a coarse
 * status used by the progress bubble.
 *
 * Real wire shapes:
 *   - failure:  { kind: "failed", message: string }
 *   - success:  { kind: "readFile",  ... } | { kind: "writeFile", ... } |
 *               { kind: "editFile",  ... } | { kind: "runCommand", ... }
 *
 * Legacy tag shapes (`{ Failed: "..." }`, `{ failed: "..." }`) are still
 * tolerated as a defensive fallback. Unknown shapes log a dev-only
 * `console.warn` and are treated as success — this matches the design spec.
 */
export function mapStepResult(result: unknown): MappedStepResult {
  if (typeof result !== "object" || result === null) {
    // Unknown shape — surface it for developers but don't fail the UI.
    // eslint-disable-next-line no-console
    console.warn("[AgentProgressBubble] Unhandled step result shape:", result);
    return { status: "ok" };
  }
  const obj = result as Record<string, unknown>;
  if (obj.kind === "failed" && typeof obj.message === "string") {
    return { status: "failed", message: obj.message };
  }
  if (typeof obj.Failed === "string") {
    return { status: "failed", message: obj.Failed };
  }
  if (typeof obj.failed === "string") {
    return { status: "failed", message: obj.failed };
  }
  if (typeof obj.kind === "string" && obj.kind !== "failed") {
    return { status: "ok" };
  }
  // Unknown shape — surface it for developers but don't fail the UI.
  // eslint-disable-next-line no-console
  console.warn("[AgentProgressBubble] Unhandled step result shape:", result);
  return { status: "ok" };
}

/**
 * Derive an `AgentProgressStep` from a raw log entry. Call sites (Task 8)
 * use this to feed streamed events into the bubble while preserving the
 * failure message as the row's `result` text.
 */
export function deriveStepFromLog(
  index: number,
  label: string,
  result: unknown,
): AgentProgressStep {
  const mapped = mapStepResult(result);
  const step: AgentProgressStep = { index, label, status: mapped.status };
  if (mapped.message !== undefined) step.result = mapped.message;
  return step;
}

interface AgentProgressBubbleProps {
  steps: AgentProgressStep[];
  /** Number of steps that completed (succeeded OR failed). */
  completed: number;
  /** Total step count. */
  total: number;
  /** True when at least one step failed but the run continued. */
  partial: boolean;
  /** Optional override for the start-open state. */
  defaultOpen?: boolean;
}

export function AgentProgressBubble({
  steps,
  completed,
  total,
  partial,
  defaultOpen,
}: AgentProgressBubbleProps) {
  // Auto-open while there are running/pending steps OR any progress has
  // been made. Re-evaluates each render so streamed updates don't leave
  // the bubble stuck closed if it mounted before events arrived.
  const autoOpen =
    defaultOpen ??
    (steps.some((s) => s.status === "pending" || s.status === "running") ||
      completed > 0);
  const [userToggled, setUserToggled] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const open = userToggled ? userOpen : autoOpen;
  const statusLabel = partial
    ? "partial"
    : completed === total
      ? "completed"
      : "running";
  const statusClass = partial
    ? "partial"
    : completed === total
      ? "ok"
      : "running";

  return (
    <article className="chat-bubble chat-zeus agent-progress" data-testid="agent-progress">
      <div className="chat-avatar" aria-hidden="true">
        <Sparkles size={16} />
      </div>
      <div className="chat-body">
        <div className="agent-progress-header">
          <button
            aria-expanded={open}
            className="agent-progress-toggle"
            onClick={() => {
              setUserToggled(true);
              setUserOpen((current) => !current);
            }}
            type="button"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <strong>Agent run</strong>
            <span className={`agent-progress-status agent-progress-status-${statusClass}`}>
              {statusLabel}
            </span>
            <span className="agent-progress-count">{completed} / {total} steps</span>
          </button>
        </div>
        {open ? (
          <ol className="agent-progress-list">
            {steps.map((step) => (
              <li
                className={`agent-progress-row agent-progress-row-${step.status}`}
                key={`${step.index}-${step.label}`}
              >
                <span className="agent-progress-icon" aria-hidden="true">
                  {step.status === "failed" ? (
                    <X size={12} />
                  ) : step.status === "ok" ? (
                    <Check size={12} />
                  ) : step.status === "running" ? (
                    <Sparkles size={12} />
                  ) : (
                    <span className="agent-progress-num">{step.index + 1}</span>
                  )}
                </span>
                <span className="agent-progress-label">{step.label}</span>
                {step.result ? <span className="agent-progress-result">{step.result}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </article>
  );
}