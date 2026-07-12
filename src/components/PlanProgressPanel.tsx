import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  type PlanStatus,
  type RuntimePlan,
} from "../agentRuntimeDeepLoop";

interface PlanProgressPanelProps {
  /** Most recent user message text. Empty string means "no objective yet". */
  latestUserObjective: string;
  /** True when the last tool/agent invocation failed and we're in recovery. */
  lastToolFailed?: boolean;
  /**
   * LLM-generated plan for the latest objective. When set, the panel
   * surfaces these specific steps instead of the generic 5-step
   * boilerplate from `derivePlanFromObjective`. Falls back to the
   * heuristic plan when null (planning was skipped or failed).
   */
  runtimePlan?: RuntimePlan | null;
  planPhase?: "idle" | "conversation" | "planning" | "ready" | "unavailable";
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

function buildPlan(
  latestUserObjective: string,
  lastToolFailed: boolean | undefined,
  runtimePlan: RuntimePlan | null | undefined,
): RuntimePlan | null {
  const objective = latestUserObjective.trim();
  if (!objective) return null;
  // Prefer the LLM-generated plan when available — it carries task-
  // specific steps that match this objective. Conversational turns and
  // planner failures deliberately remain planless instead of displaying
  // generic progress that did not come from the objective.
  if (!runtimePlan || runtimePlan.steps.length === 0) return null;
  const basePlan = { ...runtimePlan, objective: runtimePlan.objective || objective };
  const updated = basePlan;
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
  lastToolFailed,
  runtimePlan,
  planPhase = "idle",
}: PlanProgressPanelProps): ReactNode {
  const plan = buildPlan(latestUserObjective, lastToolFailed, runtimePlan);
  const total = plan?.steps.length ?? 0;
  const completed = plan?.steps.filter((step) => step.status === "done").length ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Plan Progress</h2>
        <span>{total > 0 ? `${completed} / ${total} done` : planPhase === "planning" ? "planning" : "waiting"}</span>
      </div>
      {total > 0 ? <><div className="progress-track"><span style={{ width: `${percent}%` }} /></div><p className="progress-percent">{percent}%</p></> : null}
      {plan ? (
        <p className="plan-objective"><strong>Objective:</strong> {plan.objective}</p>
      ) : (
        <p className="plan-empty">
          {planPhase === "conversation" ? "No execution plan needed for this conversational turn."
            : planPhase === "planning" ? "Planning…"
              : planPhase === "unavailable" ? "Plan unavailable for this objective."
                : "Start a task and Zeus will track the objective and subtasks here."}
        </p>
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
