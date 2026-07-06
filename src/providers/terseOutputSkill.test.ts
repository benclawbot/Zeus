import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERSE_LEVEL,
  getTerseOutputInstructions,
  type TerseLevel,
} from "./terseOutputSkill";

describe("getTerseOutputInstructions", () => {
  it("returns the empty string for `off`", () => {
    expect(getTerseOutputInstructions("off")).toBe("");
  });

  it("returns the empty string for null / undefined / empty input", () => {
    expect(getTerseOutputInstructions(null)).toBe("");
    expect(getTerseOutputInstructions(undefined)).toBe("");
    expect(getTerseOutputInstructions("")).toBe("");
  });

  it("returns the lite block for `lite`", () => {
    const block = getTerseOutputInstructions("lite");
    expect(block).toContain("terse (lite)");
    expect(block).toContain("Skip preamble");
  });

  it("returns the full block for `full`", () => {
    const block = getTerseOutputInstructions("full");
    expect(block).toContain("terse mode");
    expect(block).toContain("Do not restate");
  });

  it("returns the ultra block for `ultra` (full + extras)", () => {
    const ultra = getTerseOutputInstructions("ultra");
    const full = getTerseOutputInstructions("full");
    expect(ultra).toContain(full);
    expect(ultra.length).toBeGreaterThan(full.length);
    expect(ultra).toContain("drop articles");
  });

  it("unknown levels fall back to the no-op (fail open)", () => {
    expect(getTerseOutputInstructions("nonsense")).toBe("");
    expect(getTerseOutputInstructions("FULL" as TerseLevel)).toBe("");
  });

  it("the full block never asks the model to compress byte-exact content", () => {
    const block = getTerseOutputInstructions("full");
    // Spot-check that the four anchor categories the spec protects
    // (code blocks, file paths, error messages, identifiers) are named
    // in the instruction.
    expect(block).toContain("code blocks");
    expect(block).toContain("file paths");
    expect(block).toContain("error messages");
    expect(block).toContain("identifiers");
  });
});

describe("DEFAULT_TERSE_LEVEL", () => {
  it("is `full` (matches the spec recommendation)", () => {
    expect(DEFAULT_TERSE_LEVEL).toBe("full");
  });
});
