import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINIMAL_LEVEL,
  MINIMAL_EXEMPTIONS,
  getMinimalCodeInstructions,
  type MinimalLevel,
} from "./minimalCodeSkill";

describe("getMinimalCodeInstructions", () => {
  it("returns the empty string for `off`", () => {
    expect(getMinimalCodeInstructions("off")).toBe("");
  });

  it("returns the empty string for null / undefined / empty input", () => {
    expect(getMinimalCodeInstructions(null)).toBe("");
    expect(getMinimalCodeInstructions(undefined)).toBe("");
    expect(getMinimalCodeInstructions("")).toBe("");
  });

  it("returns the lite block for `lite`", () => {
    const block = getMinimalCodeInstructions("lite");
    expect(block).toContain("minimal (lite)");
    expect(block).toContain("work through these checks in order");
    // Lite should NOT include the audit comment guidance.
    expect(block).not.toContain("Auditability");
  });

  it("returns the full block for `full`", () => {
    const block = getMinimalCodeInstructions("full");
    expect(block).toContain("Auditability");
    expect(block).toContain("minimal:");
  });

  it("returns the strict block for `strict` (full + deviation comments)", () => {
    const strict = getMinimalCodeInstructions("strict");
    const full = getMinimalCodeInstructions("full");
    expect(strict).toContain(full);
    expect(strict.length).toBeGreaterThan(full.length);
    expect(strict).toContain("heavy:");
  });

  it("unknown levels fail open to the no-op", () => {
    expect(getMinimalCodeInstructions("nonsense")).toBe("");
  });

  it("the full block enumerates the security-critical exemption list", () => {
    const block = getMinimalCodeInstructions("full");
    // Spot-check anchor entries from Spec 05 §4.
    expect(block).toContain("input_validation");
    expect(block).toContain("authentication");
    expect(block).toContain("error_handling");
    expect(block).toContain("crypto");
  });
});

describe("MINIMAL_EXEMPTIONS", () => {
  it("is non-empty and never short enough to be a placeholder", () => {
    expect(MINIMAL_EXEMPTIONS.length).toBeGreaterThanOrEqual(8);
  });
});

describe("DEFAULT_MINIMAL_LEVEL", () => {
  it("is `full` (spec recommendation)", () => {
    expect(DEFAULT_MINIMAL_LEVEL).toBe("full");
  });
});
