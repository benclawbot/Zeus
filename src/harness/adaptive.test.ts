import { describe, expect, it } from "vitest";
import {
  analyzeHarnessLogs,
  checkpointToJsonl,
  classifyEffort,
  evaluateGate,
  selectRelevantCheckpoints,
  shouldCheckpoint,
  shouldTerminate,
} from "./adaptive";

describe("adaptive harness core", () => {
  it("classifies effort from concrete task signals", () => {
    expect(classifyEffort({ filesTouched: 1, priorFailures: 0, noveltyScore: 0.1 })).toBe("low");
    expect(classifyEffort({ filesTouched: 3, priorFailures: 0, noveltyScore: 0.1 })).toBe("medium");
    expect(classifyEffort({ filesTouched: 1, priorFailures: 2, noveltyScore: 0.1 })).toBe("high");
  });

  it("writes checkpoints only for decision-relevant events", () => {
    expect(shouldCheckpoint({ subtaskCompleted: false, constrainedFutureStep: false, environmentSurprise: false })).toBe(false);
    expect(shouldCheckpoint({ subtaskCompleted: true, constrainedFutureStep: false, environmentSurprise: false })).toBe(true);
    expect(checkpointToJsonl({
      subtaskId: "s1",
      timestamp: "2026-07-06T00:00:00.000Z",
      decision: "Use SQLite checkpoints first",
      rationale: "Zeus already persists sessions there",
      nextDependency: "persistence",
      source: "checkpoint",
    })).toContain("SQLite checkpoints");
  });

  it("retrieves checkpoints by declared subtask dependency", () => {
    const selected = selectRelevantCheckpoints([
      { subtaskId: "a", timestamp: "t", decision: "Use workspace policy", rationale: "gate shell commands", nextDependency: "workspace", source: "checkpoint" },
      { subtaskId: "b", timestamp: "t", decision: "Adjust image UI", rationale: "not relevant", nextDependency: null, source: "checkpoint" },
    ], ["workspace"]);
    expect(selected.map((entry) => entry.subtaskId)).toEqual(["a"]);
  });

  it("scopes approval gates to irreversible actions", () => {
    expect(evaluateGate({ id: "1", kind: "file-write", target: "src/App.tsx", workspaceRelative: true }).allowed).toBe(true);
    expect(evaluateGate({ id: "2", kind: "file-write", target: "/etc/hosts", workspaceRelative: false }).approvalRequired).toBe(true);
    expect(evaluateGate({ id: "3", kind: "network", target: "https://example.com", workspaceRelative: true }).approvalRequired).toBe(true);
    expect(evaluateGate({ id: "4", kind: "credential", target: "OPENAI_API_KEY", workspaceRelative: true }).approvalRequired).toBe(true);
  });

  it("proposes harness tuning from observed waste and failures", () => {
    const result = analyzeHarnessLogs({
      checkpointsWritten: [
        { subtaskId: "a", timestamp: "t", decision: "x", rationale: "x", nextDependency: null, source: "checkpoint" },
        { subtaskId: "b", timestamp: "t", decision: "x", rationale: "x", nextDependency: null, source: "checkpoint" },
        { subtaskId: "c", timestamp: "t", decision: "x", rationale: "x", nextDependency: null, source: "checkpoint" },
      ],
      checkpointReads: [],
      effortLogs: [{ subtaskId: "a", tierSelected: "low", signals: { filesTouched: 1, priorFailures: 0, noveltyScore: 0 }, outcome: "failure" }],
      gateDecisions: [],
    });
    expect(result.metrics.unusedCheckpointCount).toBe(3);
    expect(result.proposal?.body).toContain("Tighten memory write triggers");
  });

  it("terminates completed goals and escalates exhausted correction loops", () => {
    expect(shouldTerminate({ goalSatisfied: true, budgetExhausted: false, consecutiveFailures: 0, maxCorrections: 3 })).toBe("complete");
    expect(shouldTerminate({ goalSatisfied: false, budgetExhausted: false, consecutiveFailures: 3, maxCorrections: 3 })).toBe("escalate");
    expect(shouldTerminate({ goalSatisfied: false, budgetExhausted: false, consecutiveFailures: 1, maxCorrections: 3 })).toBe("continue");
  });
});
