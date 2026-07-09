import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PlanProgressPanel, type AgentRunSummary } from "./PlanProgressPanel";

describe("PlanProgressPanel", () => {
  it("renders the empty state when there is no user objective", () => {
    render(<PlanProgressPanel latestUserObjective="" />);
    expect(screen.getByText(/Start a task and Zeus will track/i)).toBeTruthy();
    expect(screen.getByText("waiting")).toBeTruthy();
  });

  it("renders five steps derived from the latest user objective", () => {
    render(<PlanProgressPanel latestUserObjective="Add a settings panel" />);
    expect(screen.getByText("Understand objective")).toBeTruthy();
    expect(screen.getByText("Inspect workspace and available tools")).toBeTruthy();
    expect(screen.getByText("Run the next safest tool action")).toBeTruthy();
    expect(screen.getByText("Verify output with tests or focused checks")).toBeTruthy();
    expect(screen.getByText("Recover from failures before stopping")).toBeTruthy();
    const objective = screen.getByText((_, element) =>
      element?.className === "plan-objective" && /Add a settings panel/.test(element.textContent ?? ""),
    );
    expect(objective.textContent).toMatch(/Add a settings panel/);
  });

  it("marks the act step done and verify in-progress after a successful agent run", () => {
    const run: AgentRunSummary = {
      steps: [
        { index: 0, label: "read package.json", status: "ok" },
        { index: 1, label: "edit src/App.tsx", status: "ok" },
      ],
      partial: false,
    };
    const { container } = render(
      <PlanProgressPanel latestUserObjective="ship a panel" lastAgentRun={run} />,
    );
    const list = container.querySelector(".compact-list");
    expect(list).toBeTruthy();
    // The "act" row should carry data-status="done" after ok observations.
    const actRow = within(list as HTMLElement).getByText("Run the next safest tool action").closest(".compact-row");
    expect(actRow?.getAttribute("data-status")).toBe("done");
    // Verify should be in_progress when observations have all passed.
    const verifyRow = within(list as HTMLElement).getByText("Verify output with tests or focused checks").closest(".compact-row");
    expect(verifyRow?.getAttribute("data-status")).toBe("in_progress");
  });

  it("marks recover in-progress when the last tool run failed", () => {
    const { container } = render(
      <PlanProgressPanel latestUserObjective="debug it" lastToolFailed />,
    );
    const list = container.querySelector(".compact-list");
    expect(list).toBeTruthy();
    const recoverRow = within(list as HTMLElement).getByText("Recover from failures before stopping").closest(".compact-row");
    expect(recoverRow?.getAttribute("data-status")).toBe("in_progress");
    expect(recoverRow?.textContent ?? "").toMatch(/failure|recovery/i);
  });

  it("shows the completed count and percent in the heading", () => {
    render(<PlanProgressPanel latestUserObjective="do a thing" />);
    // The "Understand objective" step starts as done; the rest as todo.
    expect(screen.getByText("1 / 5 done")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
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

  it("updates LLM plan step statuses from agent observations", () => {
    const runtimePlan = {
      objective: "Add settings panel",
      status: "in_progress" as const,
      steps: [
        { id: "plan-0", label: "Read package.json", status: "todo" as const },
        { id: "plan-1", label: "Create SettingsPanel.tsx", status: "todo" as const },
        { id: "plan-2", label: "Wire panel into App.tsx", status: "todo" as const },
      ],
    };
    const run = {
      steps: [
        { index: 0, label: "readFile /package.json", status: "ok" as const },
      ],
      partial: false,
    };
    const { container } = render(
      <PlanProgressPanel
        latestUserObjective="Add settings panel"
        runtimePlan={runtimePlan}
        lastAgentRun={run}
      />,
    );
    const list = container.querySelector(".compact-list");
    expect(list).toBeTruthy();
    // First step is done; second step is in_progress; rest todo.
    const row0 = within(list as HTMLElement).getByText("Read package.json").closest(".compact-row");
    expect(row0?.getAttribute("data-status")).toBe("done");
    const row1 = within(list as HTMLElement).getByText("Create SettingsPanel.tsx").closest(".compact-row");
    expect(row1?.getAttribute("data-status")).toBe("in_progress");
    // Heading reflects 1 of 3 done.
    expect(screen.getByText("1 / 3 done")).toBeTruthy();
  });

  it("falls back to heuristic plan when runtimePlan is null", () => {
    render(<PlanProgressPanel latestUserObjective="do a thing" runtimePlan={null} />);
    expect(screen.getByText("Understand objective")).toBeTruthy();
    expect(screen.getByText("Inspect workspace and available tools")).toBeTruthy();
  });
});
