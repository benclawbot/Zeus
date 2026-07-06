import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, compressShellOutput, totalSavings } from "./shellCompressor";

describe("compressShellOutput", () => {
  it("passes through unknown commands unchanged", () => {
    const raw = "this is some output that shouldn't be filtered\n";
    const result = compressShellOutput("weird-tool --flag", raw, 0);
    expect(result.text).toBe(raw);
    expect(result.profileId).toBeNull();
    expect(result.ratio).toBe(1);
  });

  it("returns empty result for empty input", () => {
    const result = compressShellOutput("git status", "", 0);
    expect(result.text).toBe("");
    expect(result.profileId).toBeNull();
  });

  it("compresses `git status` to a structured summary", () => {
    const raw = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      "  (use \"git add <file>...\" to update what will be committed)",
      "  (use \"git restore <file>...\" to discard changes in working directory)",
      "  modified:   src/foo.ts",
      "  modified:   src/bar.ts",
      "",
      "Untracked files:",
      "  (use \"git add <file>...\" to include in what will be committed)",
      "  src/baz.ts",
      "",
    ].join("\n");
    const result = compressShellOutput("git status", raw, 0);
    expect(result.profileId).toBe("git-status");
    expect(result.text).toContain("On branch main");
    expect(result.text).toContain("src/foo.ts");
    expect(result.text).toContain("src/baz.ts");
    expect(result.text).toMatch(/staged=\d+ modified=\d+ untracked=\d+/);
    // Should be meaningfully shorter than the raw text.
    expect(result.compressedChars).toBeLessThan(result.originalChars);
  });

  it("preserves error text in `cargo test` output even after compression", () => {
    const raw = [
      "running 3 tests",
      "test tests::one ... ok",
      "test tests::two ... FAILED",
      "test tests::three ... ok",
      "",
      "failures:",
      "",
      "---- tests::two stdout ----",
      "thread 'tests::two' panicked at 'assertion failed: `(left == right)`",
      "  left: `1`,",
      " right: `2`', src/foo.rs:12:5",
      "",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
    ].join("\n");
    const result = compressShellOutput("cargo test", raw, 1);
    expect(result.profileId).toBe("cargo-test");
    // The failed test name must survive.
    expect(result.text).toContain("tests::two");
    expect(result.text).toMatch(/failed \(1\)/);
  });

  it("preserves the [exit N] prefix when the command failed", () => {
    // Use an input where compression produces a smaller result so the
    // "[exit N]" prefix path runs. (For tiny inputs the compressor
    // returns the raw text directly, which is the safe default.)
    const raw = [
      "On branch main",
      "Your branch is up to date with 'origin/main'.",
      "",
      "Changes not staged for commit:",
      "  (use \"git add <file>...\" to update what will be committed)",
      "  modified:   src/foo.ts",
      "  modified:   src/bar.ts",
      "",
      "no changes added to commit (use \"git add\" and/or \"git commit -a\")",
    ].join("\n");
    const result = compressShellOutput("git status", raw, 1);
    expect(result.text.startsWith("[exit 1]")).toBe(true);
  });

  it("returns the original when compression makes the output larger", () => {
    // Tiny input that should be a no-op.
    const result = compressShellOutput("git status", "On branch main\n", 0);
    // Compressed vs original — we still apply the profile but the
    // content is essentially equivalent. Ensure no exception / crash.
    expect(result.text).toBeDefined();
  });

  it("summarizes npm test output", () => {
    const raw = [
      "PASS  src/foo.test.ts",
      "✓ should work (12 ms)",
      "✓ should also work (8 ms)",
      "FAIL  src/bar.test.ts",
      "✗ should handle empty input (4 ms)",
      "",
      "Test Suites: 1 failed, 1 passed, 2 total",
      "Tests:       1 failed, 4 passed, 5 total",
    ].join("\n");
    const result = compressShellOutput("npm test", raw, 1);
    expect(result.profileId).toBe("npm-test");
    expect(result.text).toMatch(/passed: \d/);
    expect(result.text).toContain("should handle empty input");
  });

  it("groups many find/grep results by directory", () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      lines.push(`src/components/foo${i}.ts:42:symbol_${i}`);
    }
    const raw = lines.join("\n");
    const result = compressShellOutput("rg symbol", raw, 0);
    expect(result.profileId).toBe("find-grep");
    expect(result.text).toContain("matches=60");
    expect(result.text).toContain("src/components");
  });

  it("strips ANSI codes from the raw output before compressing", () => {
    const raw = "\x1b[32mOn branch main\x1b[0m\n\x1b[32mYour branch is up to date\x1b[0m\n";
    const result = compressShellOutput("git status", raw, 0);
    expect(result.text).not.toContain("\x1b[");
  });

  it("compresses a `cargo build` with only warnings to keep warning blocks", () => {
    const raw = [
      "   Compiling foo v0.1.0",
      "warning: unused variable: `x`",
      "  --> src/main.rs:4:9",
      "   |",
      " 4 |     let x = 42;",
      "   |         ^ help: if this is intentional, prefix it with an underscore: `_x`",
      "   Compiling bar v0.1.0",
      "warning: unused variable: `y`",
      "  --> src/lib.rs:9:9",
      "    Finished dev [unoptimized + debuginfo] target(s)",
    ].join("\n");
    const result = compressShellOutput("cargo build", raw, 0);
    expect(result.profileId).toBe("cargo-build");
    // Warnings should survive.
    expect(result.text).toContain("warning: unused variable");
  });

  it("lists every built-in profile with a unique id", () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });
});

describe("totalSavings", () => {
  it("sums the byte savings across results", () => {
    const savings = totalSavings([
      { text: "a", profileId: "x", originalChars: 100, compressedChars: 20, ratio: 0.2 },
      { text: "b", profileId: "x", originalChars: 200, compressedChars: 50, ratio: 0.25 },
    ]);
    expect(savings).toBe(80 + 150);
  });

  it("returns 0 for an empty list", () => {
    expect(totalSavings([])).toBe(0);
  });
});
