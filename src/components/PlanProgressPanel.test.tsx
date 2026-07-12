import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlanProgressPanel } from "./PlanProgressPanel";

describe("PlanProgressPanel", () => {
  it("renders the empty state when there is no user objective", () => {
    render(<PlanProgressPanel latestUserObjective="" />);
    expect(screen.getByText(/Start a task and Zeus will track/i)).toBeTruthy();
    expect(screen.getByText("waiting")).toBeTruthy();
  });

  it("does not fabricate a plan for a conversational question", () => {
    render(<PlanProgressPanel latestUserObjective="what are your current coding limitations?" planPhase="conversation" />);
    expect(screen.getByText(/No execution plan needed/i)).toBeTruthy();
    expect(screen.queryByText("Understand objective")).toBeNull();
  });

  it("shows planning without fabricated progress", () => {
    render(<PlanProgressPanel latestUserObjective="Add a settings panel" planPhase="planning" />);
    expect(screen.getByText("Planning…")).toBeTruthy();
    expect(screen.queryByText("20%")).toBeNull();
  });

  it("renders LLM-generated plan steps when runtimePlan is provided", () => {
    const runtimePlan = {
      objective: "Add settings panel",
      status: "in_progress" as const,
      steps: [
        { id: "plan-0", label: "Read package.json", status: "todo" as const },
        { id: "plan-1", label: "Create SettingsPanel.tsx", status: "todo" as const },
        { id: "plan-2", label: "Wire panel into App.tsx", status: "todo" as const },
        { id: "plan-3", label: "Run npx tsc --noEmit", status: "todo" as const },
      ],
    };
    render(<PlanProgressPanel latestUserObjective="Add settings panel" runtimePlan={runtimePlan} />);
    // The LLM plan steps should appear, not the generic 5-step boilerplate.
    expect(screen.getByText("Read package.json")).toBeTruthy();
    expect(screen.getByText("Create SettingsPanel.tsx")).toBeTruthy();
    expect(screen.getByText("Wire panel into App.tsx")).toBeTruthy();
    expect(screen.getByText("Run npx tsc --noEmit")).toBeTruthy();
    // Generic boilerplate should NOT appear.
    expect(screen.queryByText("Understand objective")).toBeNull();
    expect(screen.queryByText("Inspect workspace and available tools")).toBeNull();
    expect(screen.getByText("0 / 4 done")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("shows plan unavailable instead of heuristic steps", () => {
    render(<PlanProgressPanel latestUserObjective="Implement a difficult change" runtimePlan={null} planPhase="unavailable" />);
    expect(screen.getByText(/Plan unavailable/i)).toBeTruthy();
    expect(screen.queryByText("Understand objective")).toBeNull();
  });
});
