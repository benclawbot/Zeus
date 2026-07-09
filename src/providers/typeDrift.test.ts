/**
 * Type-drift guard. Locks the wire shape of the high-traffic Rust↔TS
 * boundaries against accidental serde-attribute changes on either side.
 *
 * How it works:
 * 1. Each fixture is a JSON sample that matches the TS interface
 *    exactly (camelCase keys, all required fields populated).
 * 2. The test parses the fixture and asserts every expected key is
 *    present with the expected type. A drift on either side (someone
 *    changes a `#[serde(rename_all = "...")]` attribute, or someone
 *    renames a TS field) breaks the parse and the test fails.
 * 3. The test also reads the Rust source to assert the matching
 *    `rename_all` attribute is present — catching the case where Rust
 *    silently flips back to snake_case while TS still expects camelCase.
 *
 * Adding a new boundary? Add a fixture, add a parse assertion, add a
 * Rust-source check. Keep this file the single place we lock the
 * contract for both sides.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface ProviderInfo {
  id: string;
  displayName: string;
  defaultModel: string;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  hasReferences: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  hasAgentsMetadata: boolean;
}

function loadFixture<T>(relativePath: string): T {
  // Tests live in src/providers/, fixtures live in src/test/fixtures/.
  // Walk up to the src/ root and append the relative path so the same
  // call site works regardless of the test file's location.
  const path = resolve(__dirname, "..", "test", relativePath);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readRustSource(relativePath: string): string {
  return readFileSync(resolve(__dirname, "..", "..", relativePath), "utf8");
}

describe("type drift — Rust ↔ TS wire shape", () => {
  it("provider-info.json matches the ProviderInfo interface", () => {
    const rows = loadFixture<ProviderInfo[]>("fixtures/provider-info.json");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.displayName).toBe("string");
      expect(typeof row.defaultModel).toBe("string");
      // Catches snake_case regressions — if Rust flips to
      // `#[serde(rename_all = "snake_case")]`, the fixture would have
      // `display_name` and this assertion would fail.
      expect((row as unknown as Record<string, unknown>).display_name).toBeUndefined();
      expect((row as unknown as Record<string, unknown>).default_model).toBeUndefined();
    }
  });

  it("ProviderInfo Rust struct keeps camelCase serde", () => {
    const source = readRustSource("src-tauri/src/providers/mod.rs");
    // The `ProviderInfo` struct MUST carry `rename_all = "camelCase"`
    // so `display_name` ships as `displayName`. If someone removes
    // this, the frontend silently gets undefined fields. The attribute
    // sits on the line(s) immediately above the struct.
    expect(source).toMatch(/rename_all\s*=\s*"camelCase"[\s\S]{0,200}pub struct ProviderInfo/);
  });

  it("skill-summary.json matches the SkillSummary interface", () => {
    const rows = loadFixture<SkillSummary[]>("fixtures/skill-summary.json");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.name).toBe("string");
      expect(typeof row.description).toBe("string");
      expect(typeof row.hasReferences).toBe("boolean");
      expect(typeof row.hasScripts).toBe("boolean");
      expect(typeof row.hasAssets).toBe("boolean");
      expect(typeof row.hasAgentsMetadata).toBe("boolean");
      // Catches snake_case regressions on the boolean flags.
      const flat = row as unknown as Record<string, unknown>;
      expect(flat.has_references).toBeUndefined();
      expect(flat.has_scripts).toBeUndefined();
      expect(flat.has_assets).toBeUndefined();
      expect(flat.has_agents_metadata).toBeUndefined();
    }
  });

  it("SkillSummary Rust struct keeps camelCase serde", () => {
    const source = readRustSource("src-tauri/src/lib.rs");
    expect(source).toMatch(/rename_all\s*=\s*"camelCase"[\s\S]{0,400}pub struct SkillSummary/);
  });
});
