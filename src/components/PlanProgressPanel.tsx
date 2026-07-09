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
  /**
   * LLM-generated plan for the latest objective. When set, the panel
   * surfaces these specific steps instead of the generic 5-step
   * boilerplate from `derivePlanFromObjective`. Falls back to the
   * heuristic plan when null (planning was skipped or failed).
   */
  runtimePlan?: RuntimePlan | null;
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
  runtimePlan: RuntimePlan | null | undefined,
): RuntimePlan | null {
  const objective = latestUserObjective.trim();
  if (!objective) return null;
  // Prefer the LLM-generated plan when available — it carries task-
  // specific steps that match this objective. Fall back to the heuristic
  // 5-step boilerplate when the planner was skipped (short chat,
  // provider error, etc.).
  const basePlan = runtimePlan && runtimePlan.steps.length > 0
    ? { ...runtimePlan, objective: runtimePlan.objective || objective }
    : derivePlanFromObjective(objective);
  const updated = updatePlanFromObservations(basePlan, observationsFromAgentRun(lastAgentRun));
  if (lastToolFailed) {
    // Heuristic plan: a "recover" step is always present, target it.
    // LLM plan: promote the last in-progress or todo step into recovery.
    const heuristicRecover = updated.steps.find((step) => step.id === "recover");
    const fallbackTarget = heuristicRecover
      ?? updated.steps.find((step) => step.status === "in_progress")
      ?? updated.steps.find((step) => step.status === "todo")
      ?? updated.steps[updated.steps.length - 1];
    if (fallbackTarget) {
      return {
        ...updated,
        steps: updated.steps.map((step) =>
          step.id === fallbackTarget.id
            ? { ...step, status: "in_progress", detail: "Latest tool/action output failed; recovery remains active." }
            : step,
        ),
      };
    }
  }
  return updated;
}

export function PlanProgressPanel({
  latestUserObjective,
  lastAgentRun,
  lastToolFailed,
  runtimePlan,
}: PlanProgressPanelProps): ReactNode {
  const plan = buildPlan(latestUserObjective, lastAgentRun, lastToolFailed, runtimePlan);
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
