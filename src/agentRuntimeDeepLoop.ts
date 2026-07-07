export type PlanStatus = "todo" | "in_progress" | "done" | "failed";

export interface RuntimePlanStep {
  id: string;
  label: string;
  status: PlanStatus;
  detail?: string;
}

export interface RuntimePlan {
  objective: string;
  status: PlanStatus;
  steps: RuntimePlanStep[];
}

export interface ToolObservation {
  label: string;
  ok: boolean;
  message: string;
}

export function derivePlanFromObjective(objective: string): RuntimePlan {
  const clean = objective.trim() || "Current session";
  return {
    objective: clean,
    status: "in_progress",
    steps: [
      { id: "understand", label: "Understand objective", status: "done" },
      { id: "inspect", label: "Inspect workspace and available tools", status: "todo" },
      { id: "act", label: "Run the next safest tool action", status: "todo" },
      { id: "verify", label: "Verify output with tests or focused checks", status: "todo" },
      { id: "recover", label: "Recover from failures before stopping", status: "todo" },
    ],
  };
}

export function updatePlanFromObservations(plan: RuntimePlan, observations: ToolObservation[]): RuntimePlan {
  const anyFailed = observations.some((item) => !item.ok);
  const anyOk = observations.some((item) => item.ok);
  const next = plan.steps.map((step) => ({ ...step }));
  const mark = (id: string, status: PlanStatus, detail?: string) => {
    const found = next.find((step) => step.id === id);
    if (found) {
      found.status = status;
      found.detail = detail;
    }
  };

  if (anyOk) {
    mark("inspect", "done");
    mark("act", anyFailed ? "failed" : "done");
    mark("verify", anyFailed ? "todo" : "in_progress");
  }
  if (anyFailed) {
    const failed = observations.filter((item) => !item.ok).map((item) => `${item.label}: ${item.message}`).join("; ");
    mark("recover", "in_progress", failed.slice(0, 240));
  }
  return {
    ...plan,
    status: anyFailed ? "in_progress" : anyOk ? "in_progress" : plan.status,
    steps: next,
  };
}

export function classifyAgentFailure(message: string): "workspace" | "tool_args" | "policy" | "transient" | "unknown" {
  if (/workspace path|must point inside|not inside|does not exist/i.test(message)) return "workspace";
  if (/json|parse|argument|schema|missing|required/i.test(message)) return "tool_args";
  if (/policy|approval|denied|forbidden|locked|review/i.test(message)) return "policy";
  if (/timeout|network|fetch failed|econnreset|econnrefused|503|502|500|504|429/i.test(message)) return "transient";
  return "unknown";
}

export function recoveryInstructionFor(message: string): string {
  const kind = classifyAgentFailure(message);
  switch (kind) {
    case "workspace":
      return "The previous tool action failed because the workspace/path was invalid. Re-plan by listing the workspace root first, then use only relative paths discovered from that listing. Do not stop after this failure.";
    case "tool_args":
      return "The previous tool action failed because the tool arguments were invalid. Re-emit a smaller corrected tool block with valid JSON and one narrowly scoped action.";
    case "policy":
      return "The previous tool action hit a policy/approval guard. Choose a read-only inspection step or explain the specific permission needed instead of retrying the blocked write/destructive action.";
    case "transient":
      return "The previous tool action looks transient. Retry once with a smaller command or alternate inspection path, then verify the result.";
    default:
      return "The previous tool action failed. Diagnose the failure from the exact output, choose a different next action, and continue with a bounded recovery attempt before giving a final answer.";
  }
}
