import { describe, expect, it } from "vitest";

// The registry module exports `dispatchChat` as the chat entry point and
// `parseToolSteps` (renamed during the failure-formatting refactor).
// We test the tool-step parsing and the observation formatting that
// prevents the "Stopped after 6 tool turns" failure mode, where the
// model kept emitting the same tool block because the previous
// observation didn't surface the structured failure.

import {
  parseToolSteps,
  withWorkspaceToolPrompt,
  extractToolBlocks,
  formatAgentRunResult,
  formatStepLog,
  findProvider,
  listProviders,
} from "./registry";
import type { ChatMessage } from "./registry";

describe("registry tool parsing", () => {
  it("returns no steps when the model emits no tool block", () => {
    expect(extractToolBlocks("Here is a plain answer with no fenced tool block.")).toEqual([]);
    expect(parseToolSteps("nothing here")).toEqual([]);
  });

  it("parses a single tool block with one JSON step per line", () => {
    const content = [
      "I'll inspect the project first.",
      "```tool",
      "listDir {\"path\":\".\"}",
      "readFile {\"path\":\"package.json\"}",
      "```",
      "Then I'll plan the edit.",
    ].join("\n");
    const blocks = extractToolBlocks(content);
    expect(blocks).toHaveLength(1);
    const steps = parseToolSteps(content);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "listDir", path: "." });
    expect(steps[1]).toMatchObject({ kind: "readFile", path: "package.json" });
  });

  it("skips malformed JSON lines without dropping valid siblings", () => {
    const content = [
      "```tool",
      "listDir {\"path\":\".\"}",
      "readFile {not-json}",
      "editFile {\"path\":\"a\",\"find\":\"x\",\"replace\":\"y\",\"replaceAll\":false}",
      "```",
    ].join("\n");
    const steps = parseToolSteps(content);
    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.kind)).toEqual(["listDir", "editFile"]);
  });

  it("parses multiple tool blocks in one model reply", () => {
    const content = [
      "```tool",
      "listDir {\"path\":\"src\"}",
      "```",
      "Some prose between blocks.",
      "```tool",
      "search {\"query\":\"foo\",\"maxResults\":5}",
      "```",
    ].join("\n");
    const steps = parseToolSteps(content);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "listDir", path: "src" });
    expect(steps[1]).toMatchObject({ kind: "search", query: "foo", maxResults: 5 });
  });
});

describe("withWorkspaceToolPrompt", () => {
  it("appends the tool prompt to the system message exactly once", () => {
    const initial: ChatMessage[] = [
      { role: "user", content: "do something" },
    ];
    const out = withWorkspaceToolPrompt(initial);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("# Zeus workspace tools");
    expect(out[1]).toEqual(initial[0]);
  });

  it("does not double-append when the tool prompt is already present", () => {
    const initial: ChatMessage[] = [
      { role: "system", content: "existing system\n\n# Zeus workspace tools\nAlready injected." },
      { role: "user", content: "go" },
    ];
    const out = withWorkspaceToolPrompt(initial);
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("Already injected.");
    expect(out[0].content.match(/# Zeus workspace tools/g)).toHaveLength(1);
  });

  it("includes the 'fix the call before re-emitting' hint", () => {
    const initial: ChatMessage[] = [{ role: "user", content: "go" }];
    const out = withWorkspaceToolPrompt(initial);
    const lowered = out[0].content.toLowerCase();
    expect(lowered).toContain("failed [code]: message");
    expect(lowered).toContain("do not retry the same tool block");
  });
});

describe("observation formatting", () => {
  it("surfaces structured failure codes for the model to act on", () => {
    const line = formatStepLog({
      index: 0,
      label: "edit src/foo.rs",
      result: {
        kind: "failed",
        code: "ambiguousMatch",
        occurrences: 3,
        message: "find matched 3 times",
        suggestion: "Pass replaceAll=true or include more surrounding context.",
      },
    });
    expect(line).toContain("edit src/foo.rs");
    expect(line).toContain("[ambiguousMatch (3 occurrences)]");
    expect(line).toContain("Suggestion: Pass replaceAll=true");
  });

  it("emits a one-line ok summary for successful steps", () => {
    const line = formatStepLog({
      index: 1,
      label: "read package.json",
      result: { kind: "readFile", bytesRead: 1234 },
    });
    expect(line).toBe("Step 2 (read package.json) ok.");
  });

  it("renders a failed agent run with all per-step details", () => {
    const formatted = formatAgentRunResult({
      objective: "fix foo",
      completed: false,
      filesTouched: [],
      logs: [
        {
          index: 0,
          label: "edit src/foo.rs",
          result: {
            kind: "failed",
            code: "notFound",
            message: "No match found in 'src/foo.rs'.",
            suggestion: "Closest match at line 12.",
          },
        },
        {
          index: 1,
          label: "read package.json",
          result: { kind: "readFile", bytesRead: 1234 },
        },
      ],
      diff: "",
      summary: "Objective: fix foo. Status: failed. Steps: 2.",
      proposedHarnessRule: null,
      rollbackPlan: [],
    });
    expect(formatted[0]).toContain("agent run failed");
    expect(formatted[1]).toContain("Objective: fix foo");
    expect(formatted.join("\n")).toContain("[notFound]");
    expect(formatted.join("\n")).toContain("Closest match at line 12.");
    expect(formatted.join("\n")).toContain("Step 2 (read package.json) ok.");
  });
});

describe("provider registry", () => {
  it("registers the default MiniMax provider", () => {
    const providers = listProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0].id).toBe("minimax");
    expect(providers[0].defaultModel).toBe("MiniMax-M3");
  });

  it("looks up providers by id", () => {
    expect(findProvider("minimax")?.id).toBe("minimax");
    expect(findProvider("does-not-exist")).toBeUndefined();
  });
});