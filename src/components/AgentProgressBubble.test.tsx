import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  AgentProgressBubble,
  deriveStepFromLog,
  mapStepResult,
  type AgentProgressStep,
} from "./AgentProgressBubble";

describe("mapStepResult", () => {
  it("returns 'failed' with the message for the real Rust wire shape ({kind: 'failed', message})", () => {
    expect(mapStepResult({ kind: "failed", message: "boom" })).toEqual({ status: "failed", message: "boom" });
  });

  it("returns 'failed' for the legacy PascalCase {Failed: '...'} shape", () => {
    expect(mapStepResult({ Failed: "boom" })).toEqual({ status: "failed", message: "boom" });
  });

  it("returns 'failed' for the legacy lowercase {failed: '...'} shape", () => {
    expect(mapStepResult({ failed: "boom" })).toEqual({ status: "failed", message: "boom" });
  });

  it("returns 'ok' for successful Rust variants without logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mapStepResult({ kind: "readFile", path: "x", content: "", bytesRead: 0, truncated: false })).toEqual({ status: "ok" });
    expect(mapStepResult({ kind: "runCommand", program: "x", args: [], cwd: "", exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0, policy: { accessMode: "Full", commandClass: "safe", approvalRequired: false, approved: false } })).toEqual({ status: "ok" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns 'ok' and warns for unknown shapes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mapStepResult("totally unexpected")).toEqual({ status: "ok" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("deriveStepFromLog", () => {
  it("maps a failure log entry to a failed step carrying the message", () => {
    const step = deriveStepFromLog(0, "read src/foo.ts", { kind: "failed", message: "boom" });
    expect(step).toEqual({ index: 0, label: "read src/foo.ts", status: "failed", result: "boom" });
  });

  it("maps a successful log entry to an ok step without a result", () => {
    const step = deriveStepFromLog(0, "read src/foo.ts", { kind: "readFile", path: "x", content: "", bytesRead: 0, truncated: false });
    expect(step).toEqual({ index: 0, label: "read src/foo.ts", status: "ok" });
  });
});

const steps: AgentProgressStep[] = [
  { index: 0, label: "read src/foo.ts", status: "ok" },
  { index: 1, label: "edit src/foo.ts", status: "failed", result: "edit conflict" },
  { index: 2, label: "run npm test", status: "ok", result: "all green" },
];

describe("AgentProgressBubble", () => {
  it("renders the partial chip, all step labels, and the count when one step failed", () => {
    render(<AgentProgressBubble steps={steps} completed={2} total={3} partial />);
    expect(screen.getByText("read src/foo.ts")).toBeTruthy();
    expect(screen.getByText("edit src/foo.ts")).toBeTruthy();
    expect(screen.getByText("run npm test")).toBeTruthy();
    expect(screen.getByText(/2\s*\/\s*3\s*steps/i)).toBeTruthy();
    const chip = screen.getByText("partial");
    expect(chip).toBeTruthy();
    expect(chip.className).toMatch(/agent-progress-status-partial/);
  });

  it("renders the completed chip and class when the run finished without failures", () => {
    render(<AgentProgressBubble steps={steps} completed={3} total={3} partial={false} />);
    const chip = screen.getByText("completed");
    expect(chip).toBeTruthy();
    expect(chip.className).toMatch(/agent-progress-status-ok/);
  });
});