import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentProgressBubble, mapStepResult, type AgentProgressStep } from "./AgentProgressBubble";

describe("mapStepResult", () => {
  it("returns 'failed' when the result carries a Failed tag (PascalCase)", () => {
    expect(mapStepResult({ Failed: "boom" })).toBe("failed");
  });

  it("returns 'failed' when the result carries a failed tag (lowercase)", () => {
    expect(mapStepResult({ failed: "boom" })).toBe("failed");
  });

  it("returns 'ok' for all other result shapes", () => {
    expect(mapStepResult({ ReadFile: { path: "x", content: "" } })).toBe("ok");
    expect(mapStepResult({ RunCommand: { program: "x", args: [], cwd: "", stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 0 } })).toBe("ok");
    expect(mapStepResult("totally unexpected")).toBe("ok");
  });
});

const steps: AgentProgressStep[] = [
  { index: 0, label: "read src/foo.ts", status: "ok" },
  { index: 1, label: "edit src/foo.ts", status: "failed", result: "edit conflict" },
  { index: 2, label: "run npm test", status: "ok", result: "all green" },
];

describe("AgentProgressBubble", () => {
  it("renders the step list with status icons and labels", () => {
    render(<AgentProgressBubble steps={steps} completed={2} total={3} partial />);
    expect(screen.getByText("read src/foo.ts")).toBeTruthy();
    expect(screen.getByText("edit src/foo.ts")).toBeTruthy();
    expect(screen.getByText("run npm test")).toBeTruthy();
    expect(screen.getByText(/2\s*\/\s*3\s*steps/i)).toBeTruthy();
  });

  it("renders an indicator when the run is fully successful", () => {
    render(<AgentProgressBubble steps={steps} completed={3} total={3} partial={false} />);
    expect(screen.getByText(/succeeded|complete/i)).toBeTruthy();
  });
});
