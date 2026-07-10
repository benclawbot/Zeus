import { describe, expect, it } from "vitest";
import type { AgentEngineHealth, AgentEngineToolBatchRequest } from "./agentEngine";

describe("agentEngine frontend types", () => {
  it("models the unrestricted Rust foundation health payload", () => {
    const health: AgentEngineHealth = {
      ok: true,
      version: "pi-rust-foundation-1",
      phase: "idle",
      workspaceLimitsDisabled: true,
      filesystemScope: "unrestricted",
      events: ["agentStart", "toolExecutionEnd"],
      tools: [{ name: "readFile", label: "Read file", riskClass: "readOnly", executionMode: "parallel", description: "Read any file" }],
      nextImplementation: [{ id: "provider-native-tool-calls", title: "Provider-native tool calls", outcome: "Run turns in Rust", files: ["src-tauri/src/lib.rs"] }],
    };
    expect(health.workspaceLimitsDisabled).toBe(true);
    expect(health.tools[0].name).toBe("readFile");
  });

  it("allows per-call roots for follow-up provider migration", () => {
    const request: AgentEngineToolBatchRequest = {
      objective: "search anywhere",
      calls: [{ name: "searchCode", args: { root: "C:/Users", query: "AgentRuntime" } }],
      stopOnError: true,
    };
    expect(request.calls[0].args?.root).toBe("C:/Users");
  });
});
