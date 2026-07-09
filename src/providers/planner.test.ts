import { describe, expect, it, vi, beforeEach } from "vitest";
import { isSubstantiveObjective, generatePlanSteps } from "./planner";
import * as registry from "./registry";

vi.mock("./registry", async () => {
  const actual = await vi.importActual<typeof registry>("./registry");
  return {
    ...actual,
    dispatchChat: vi.fn(),
  };
});

describe("planner.isSubstantiveObjective", () => {
  it("rejects very short messages", () => {
    expect(isSubstantiveObjective("ok")).toBe(false);
    expect(isSubstantiveObjective("thanks")).toBe(false);
    expect(isSubstantiveObjective("hi there")).toBe(false);
  });

  it("rejects slash commands", () => {
    expect(isSubstantiveObjective("/new")).toBe(false);
    expect(isSubstantiveObjective("/goal build a thing")).toBe(false);
  });

  it("rejects pure questions without an action verb", () => {
    expect(isSubstantiveObjective("What does this function do?")).toBe(false);
    expect(isSubstantiveObjective("Where is the auth module defined?")).toBe(false);
    expect(isSubstantiveObjective("Is this project using Rust or TypeScript?")).toBe(false);
  });

  it("accepts questions that carry an action verb", () => {
    expect(isSubstantiveObjective("Can you fix the failing test?")).toBe(true);
    expect(isSubstantiveObjective("How do I add a settings panel?")).toBe(true);
    // Diagnostic with an action verb still gets a plan — the result is
    // usually useful (identify / check logs / fix / verify).
    expect(isSubstantiveObjective("Why is the build failing?")).toBe(true);
  });

  it("accepts action statements", () => {
    expect(isSubstantiveObjective("Add a settings panel to the sidebar")).toBe(true);
    expect(isSubstantiveObjective("Refactor the agent loop into a smaller module")).toBe(true);
    expect(isSubstantiveObjective("Run npx tsc and fix any type errors")).toBe(true);
  });
});

describe("planner.generatePlanSteps", () => {
  beforeEach(() => {
    vi.mocked(registry.dispatchChat).mockReset();
  });

  it("returns null for non-substantive objectives", async () => {
    const result = await generatePlanSteps("hi", { provider: "minimax" });
    expect(result).toBeNull();
    expect(registry.dispatchChat).not.toHaveBeenCalled();
  });

  it("returns parsed steps when the model emits a strict JSON array", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: '["Read package.json","Add SettingsPanel","Wire it up","Run tsc"]',
      model: "test-model",
    });
    const result = await generatePlanSteps("Add a settings panel to the app", { provider: "minimax" });
    expect(result).toEqual(["Read package.json", "Add SettingsPanel", "Wire it up", "Run tsc"]);
  });

  it("tolerates prose around the JSON array", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: 'Here is the plan:\n["Step A","Step B","Step C"]\nThat covers it.',
      model: "test-model",
    });
    const result = await generatePlanSteps("Do a multi-step task that needs planning", { provider: "minimax" });
    expect(result).toEqual(["Step A", "Step B", "Step C"]);
  });

  it("tolerates a markdown code fence", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: '```json\n["Step A","Step B"]\n```',
      model: "test-model",
    });
    const result = await generatePlanSteps("Run a multi-step task with planning required", { provider: "minimax" });
    expect(result).toEqual(["Step A", "Step B"]);
  });

  it("returns null when the response has no JSON array", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: "I cannot generate a plan for this objective.",
      model: "test-model",
    });
    const result = await generatePlanSteps("Add a complex feature with many substeps", { provider: "minimax" });
    expect(result).toBeNull();
  });

  it("returns null when the array contains non-strings", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: '[{"label":"x"},{"label":"y"}]',
      model: "test-model",
    });
    const result = await generatePlanSteps("Add a complex feature with many substeps", { provider: "minimax" });
    expect(result).toBeNull();
  });

  it("returns null when the model throws", async () => {
    vi.mocked(registry.dispatchChat).mockRejectedValue(new Error("network down"));
    const result = await generatePlanSteps("Add a complex feature with many substeps", { provider: "minimax" });
    expect(result).toBeNull();
  });

  it("forwards the configured provider/model/baseUrl to dispatchChat", async () => {
    vi.mocked(registry.dispatchChat).mockResolvedValue({
      content: '["Step A","Step B"]',
      model: "test-model",
    });
    await generatePlanSteps("Add a complex feature with many substeps", {
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.example.com/v1",
      temperature: 0.2,
    });
    expect(registry.dispatchChat).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.example.com/v1",
      temperature: 0.2,
    }));
  });
});