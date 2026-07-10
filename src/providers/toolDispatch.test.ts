import { describe, expect, it } from "vitest";
import { NATIVE_WORKSPACE_TOOL_PROMPT, withWorkspaceToolPrompt } from "./toolDispatch";

describe("native workspace dispatch", () => {
  it("adds the native runtime prompt once", () => {
    const messages = [{ role: "system" as const, content: "base" }];
    const first = withWorkspaceToolPrompt(messages);
    const second = withWorkspaceToolPrompt(first);

    expect(first[0].content).toContain(NATIVE_WORKSPACE_TOOL_PROMPT);
    expect(second).toEqual(first);
  });
});
