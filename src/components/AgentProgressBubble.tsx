import { Check, ChevronDown, ChevronRight, Sparkles, X } from "lucide-react";
import React, { useState } from "react";

export type AgentStepStatus = "pending" | "running" | "ok" | "failed";

export interface AgentProgressStep {
  index: number;
  label: string;
  status: AgentStepStatus;
  result?: string;
}

/**
 * Map the unknown `AgentRunStepLog.result` payload (a serialized Rust enum)
 * to a coarse status used by the progress bubble.
 *
 * The Rust schema uses `serde(tag = "...")`. Both PascalCase (Tauri's
 * serde_json default) and lowercase key shapes are handled so the call
 * site stays robust against minor schema changes.
 */
export function mapStepResult(result: unknown): AgentStepStatus {
  if (typeof result !== "object" || result === null) return "ok";
  const obj = result as Record<string, unknown>;
  if (typeof obj.Failed === "string") return "failed";
  if (typeof obj.failed === "string") return "failed";
  return "ok";
}

interface AgentProgressBubbleProps {
  steps: AgentProgressStep[];
  /** Number of steps that completed (succeeded OR failed). */
  completed: number;
  /** Total step count. */
  total: number;
  /** True when at least one step failed but the run continued. */
  partial: boolean;
  /** Optional override for the start-open state. Default: true while any step is pending. */
  defaultOpen?: boolean;
}

export function AgentProgressBubble({
  steps,
  completed,
  total,
  partial,
  defaultOpen,
}: AgentProgressBubbleProps) {
  const [open, setOpen] = useState(
    defaultOpen ?? (steps.some((s) => s.status === "pending" || s.status === "running") || completed > 0),
  );
  const statusLabel = partial ? "partial" : completed === total ? "succeeded" : "running";
  const statusClass = partial ? "partial" : completed === total ? "ok" : "running";

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
            onClick={() => setOpen((current) => !current)}
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
