import { describe, expect, it } from "vitest";
import { normalizeAgentStep } from "./workspace";

describe("workspace provider normalization", () => {
  it("maps listDir dot to workspace root", () => {
    expect(normalizeAgentStep({ kind: "listDir", path: "." })).toEqual({ kind: "listDir", path: "" });
    expect(normalizeAgentStep({ kind: "listDir", path: "./" })).toEqual({ kind: "listDir", path: "" });
  });

  it("keeps discovered relative paths unchanged", () => {
    expect(normalizeAgentStep({ kind: "readFile", path: "src/App.tsx" })).toEqual({ kind: "readFile", path: "src/App.tsx" });
  });

  it("normalizes command cwd dot to workspace root", () => {
    expect(normalizeAgentStep({ kind: "runCommand", program: "npm", args: ["test"], cwd: "." })).toEqual({
      kind: "runCommand",
      program: "npm",
      args: ["test"],
      cwd: undefined,
    });
  });
});
