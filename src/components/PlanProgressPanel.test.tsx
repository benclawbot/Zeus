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
});
