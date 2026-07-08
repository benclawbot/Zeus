import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  derivePlanFromObjective,
  updatePlanFromObservations,
  type PlanStatus,
  type RuntimePlan,
  type ToolObservation,
} from "../agentRuntimeDeepLoop";

/**
 * Per-step status shape produced by the most recent agent run, as
 * stored on `ChatMessage.agentProgress`. We only need a narrow slice
 * here to feed `updatePlanFromObservations`.
 */
export interface AgentRunSummary {
  steps: ReadonlyArray<{ index: number; label: string; status: "ok" | "failed" | "pending" | "running"; result?: string }>;
  partial: boolean;
}

interface PlanProgressPanelProps {
  /** Most recent user message text. Empty string means "no objective yet". */
  latestUserObjective: string;
  /** Summary of the most recent agent run, if any. Used to mark plan steps done/failed. */
  lastAgentRun?: AgentRunSummary | null;
  /** True when the last tool/agent invocation failed and we're in recovery. */
  lastToolFailed?: boolean;
}

function statusGlyph(status: PlanStatus, index: number): string {
  if (status === "done") return "✓";
  if (status === "failed") return "!";
  if (status === "in_progress") return "…";
  return String(index + 1);
}

function statusLabel(status: PlanStatus): string {
  if (status === "in_progress") return "in progress";
  return status;
}

function observationsFromAgentRun(run: AgentRunSummary | null | undefined): ToolObservation[] {
  if (!run) return [];
  return run.steps.map((step) => ({
    label: step.label,
    ok: step.status === "ok",
    message: step.result ?? (step.status === "failed" ? "step failed" : "ok"),
  }));
}

function buildPlan(
  latestUserObjective: string,
  lastAgentRun: AgentRunSummary | null | undefined,
  lastToolFailed: boolean | undefined,
): RuntimePlan | null {
  const objective = latestUserObjective.trim();
  if (!objective) return null;
  const plan = derivePlanFromObjective(objective);
  const updated = updatePlanFromObservations(plan, observationsFromAgentRun(lastAgentRun));
  if (lastToolFailed) {
    return {
      ...updated,
      steps: updated.steps.map((step) =>
        step.id === "recover"
          ? { ...step, status: "in_progress", detail: "Latest tool/action output failed; recovery remains active." }
          : step,
      ),
    };
  }
  return updated;
}

export function PlanProgressPanel({
  latestUserObjective,
  lastAgentRun,
  lastToolFailed,
}: PlanProgressPanelProps): ReactNode {
  const plan = buildPlan(latestUserObjective, lastAgentRun, lastToolFailed);
  const total = plan?.steps.length ?? 0;
  const completed = plan?.steps.filter((step) => step.status === "done").length ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Plan Progress</h2>
        <span>{total > 0 ? `${completed} / ${total} done` : "waiting"}</span>
      </div>
      <div className="progress-track"><span style={{ width: `${percent}%` }} /></div>
      <p className="progress-percent">{percent}%</p>
      {plan ? (
        <p className="plan-objective"><strong>Objective:</strong> {plan.objective}</p>
      ) : (
        <p className="plan-empty">Start a task and Zeus will track the objective and subtasks here.</p>
      )}
      <div className="compact-list">
        {(plan?.steps ?? []).map((step, index) => (
          <div className="compact-row" data-status={step.status} key={step.id}>
            <span
              className={
                step.status === "done"
                  ? "status-dot done"
                  : step.status === "in_progress"
                    ? "status-dot live"
                    : "status-dot"
              }
              aria-hidden="true"
            >
              {step.status === "done" ? <Check size={12} /> : statusGlyph(step.status, index)}
            </span>
            <span>{step.label}</span>
            <em>{statusLabel(step.status)}</em>
            {step.detail ? <small className="compact-row-detail">{step.detail}</small> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
