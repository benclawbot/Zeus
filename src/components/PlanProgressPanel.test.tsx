import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PlanProgressPanel } from "./PlanProgressPanel";

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

  it("falls back to heuristic plan when runtimePlan is null", () => {
    render(<PlanProgressPanel latestUserObjective="do a thing" runtimePlan={null} />);
    expect(screen.getByText("Understand objective")).toBeTruthy();
    expect(screen.getByText("Inspect workspace and available tools")).toBeTruthy();
  });
});
