import { describe, expect, it } from "vitest";
import { classifyAgentFailure, derivePlanFromObjective, recoveryInstructionFor, updatePlanFromObservations } from "./agentRuntimeDeepLoop";

describe("agentRuntimeDeepLoop", () => {
  it("creates a non-stub plan from the current objective", () => {
    const plan = derivePlanFromObjective("Fix tool use");
    expect(plan.objective).toBe("Fix tool use");
    expect(plan.status).toBe("in_progress");
    expect(plan.steps.map((step) => step.status)).toEqual(["done", "todo", "todo", "todo", "todo"]);
  });

  it("marks failed observations as recoverable instead of terminal", () => {
    const plan = derivePlanFromObjective("Fix workspace path failure");
    const next = updatePlanFromObservations(plan, [
      { label: "ls .", ok: false, message: "Workspace path must point inside the workspace." },
    ]);
    expect(next.status).toBe("in_progress");
    expect(next.steps.find((step) => step.id === "recover")?.status).toBe("in_progress");
    expect(next.steps.find((step) => step.id === "recover")?.detail).toContain("Workspace path");
  });

  it("classifies workspace failures and emits a concrete recovery instruction", () => {
    expect(classifyAgentFailure("Workspace path must point inside the workspace.")).toBe("workspace");
    expect(recoveryInstructionFor("Workspace path must point inside the workspace.")).toContain("listing the workspace root");
  });
});
