export type EffortTier = "low" | "medium" | "high";
export type StepOutcome = "success" | "failure" | "escalated";
export type CheckpointSource = "checkpoint" | "error" | "escalation";
export type GateActionKind = "file-write" | "shell" | "network" | "credential" | "spend";

export interface GoalSpec {
  goal: string;
  successCriteria: string[];
  failureCriteria: string[];
  budget: { tokens: number; seconds: number };
}

export interface MemoryCheckpoint {
  subtaskId: string;
  timestamp: string;
  decision: string;
  rationale: string;
  nextDependency: string | null;
  source: CheckpointSource;
}

export interface EffortSignals {
  filesTouched: number;
  priorFailures: number;
  noveltyScore: number;
}

export interface EffortLog {
  subtaskId: string;
  tierSelected: EffortTier;
  signals: EffortSignals;
  outcome: StepOutcome;
}

export interface GateAction {
  id: string;
  kind: GateActionKind;
  target: string;
  workspaceRelative: boolean;
  amount?: number;
  approved?: boolean;
}

export interface GateDecision {
  allowed: boolean;
  approvalRequired: boolean;
  reason: string;
}

export interface HarnessMetrics {
  checkpointReadWriteRatio: number;
  failedHighEffortCount: number;
  failedLowEffortCount: number;
  gateFalsePositiveRate: number;
  unusedCheckpointCount: number;
}

export interface HarnessPatchProposal {
  title: string;
  summary: string;
  body: string;
  risk: "low" | "medium" | "high";
}

const SPEND_APPROVAL_THRESHOLD = 10;

export function classifyEffort(signals: EffortSignals): EffortTier {
  if (signals.priorFailures >= 2) return "high";
  if (signals.filesTouched >= 8) return "high";
  if (signals.noveltyScore >= 0.75) return "high";
  if (signals.priorFailures === 1) return "medium";
  if (signals.filesTouched >= 3) return "medium";
  if (signals.noveltyScore >= 0.35) return "medium";
  return "low";
}

export function escalateEffort(current: EffortTier): EffortTier {
  if (current === "low") return "medium";
  if (current === "medium") return "high";
  return "high";
}

export function shouldCheckpoint(input: {
  subtaskCompleted: boolean;
  constrainedFutureStep: boolean;
  environmentSurprise: boolean;
}): boolean {
  return input.subtaskCompleted || input.constrainedFutureStep || input.environmentSurprise;
}

export function checkpointToJsonl(checkpoint: MemoryCheckpoint): string {
  return JSON.stringify(checkpoint);
}

export function selectRelevantCheckpoints(
  checkpoints: MemoryCheckpoint[],
  dependencies: string[],
): MemoryCheckpoint[] {
  if (dependencies.length === 0) return [];
  const needles = dependencies.map((item) => item.toLowerCase());
  return checkpoints.filter((checkpoint) => {
    const haystack = [checkpoint.decision, checkpoint.rationale, checkpoint.nextDependency ?? ""]
      .join("\n")
      .toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

export function evaluateGate(action: GateAction): GateDecision {
  if (action.approved) {
    return { allowed: true, approvalRequired: true, reason: "approved" };
  }
  if (action.kind === "file-write" && !action.workspaceRelative) {
    return { allowed: false, approvalRequired: true, reason: "destructive or external file operation" };
  }
  if (action.kind === "network") {
    return { allowed: false, approvalRequired: true, reason: "new network egress target" };
  }
  if (action.kind === "credential") {
    return { allowed: false, approvalRequired: true, reason: "credential or API key use" };
  }
  if (action.kind === "spend" && (action.amount ?? 0) > SPEND_APPROVAL_THRESHOLD) {
    return { allowed: false, approvalRequired: true, reason: "spend above configured threshold" };
  }
  return { allowed: true, approvalRequired: false, reason: "routine in-workspace action" };
}

export function analyzeHarnessLogs(input: {
  checkpointsWritten: MemoryCheckpoint[];
  checkpointReads: string[];
  effortLogs: EffortLog[];
  gateDecisions: Array<GateDecision & { approverChangedRequest?: boolean }>;
}): { metrics: HarnessMetrics; proposal: HarnessPatchProposal | null } {
  const readIds = new Set(input.checkpointReads);
  const unusedCheckpointCount = input.checkpointsWritten.filter((entry) => !readIds.has(entry.subtaskId)).length;
  const failedHighEffortCount = input.effortLogs.filter((entry) => entry.tierSelected === "high" && entry.outcome !== "success").length;
  const failedLowEffortCount = input.effortLogs.filter((entry) => entry.tierSelected === "low" && entry.outcome !== "success").length;
  const gated = input.gateDecisions.filter((entry) => entry.approvalRequired);
  const unchangedApprovals = gated.filter((entry) => entry.allowed && entry.approverChangedRequest === false).length;
  const metrics: HarnessMetrics = {
    checkpointReadWriteRatio: input.checkpointsWritten.length === 0 ? 1 : input.checkpointReads.length / input.checkpointsWritten.length,
    failedHighEffortCount,
    failedLowEffortCount,
    gateFalsePositiveRate: gated.length === 0 ? 0 : unchangedApprovals / gated.length,
    unusedCheckpointCount,
  };

  const recommendations: string[] = [];
  if (metrics.checkpointReadWriteRatio < 0.4 || metrics.unusedCheckpointCount >= 3) {
    recommendations.push("Tighten memory write triggers: persist only decisions that constrain future subtasks or explain environment surprises.");
  }
  if (failedLowEffortCount > 0) {
    recommendations.push("Escalate from low to medium effort after the first failed self-correction on a subtask.");
  }
  if (metrics.gateFalsePositiveRate > 0.8) {
    recommendations.push("Narrow gate scope for actions that approvers repeatedly accept without edits.");
  }
  if (recommendations.length === 0) return { metrics, proposal: null };

  return {
    metrics,
    proposal: {
      title: "Adaptive harness tuning proposal",
      summary: recommendations[0],
      body: recommendations.map((item) => `- ${item}`).join("\n"),
      risk: recommendations.length >= 3 ? "medium" : "low",
    },
  };
}

export function shouldTerminate(input: {
  goalSatisfied: boolean;
  budgetExhausted: boolean;
  consecutiveFailures: number;
  maxCorrections: number;
}): "continue" | "complete" | "escalate" {
  if (input.goalSatisfied) return "complete";
  if (input.budgetExhausted) return "escalate";
  if (input.consecutiveFailures >= input.maxCorrections) return "escalate";
  return "continue";
}
