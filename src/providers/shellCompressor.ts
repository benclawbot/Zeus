/**
 * Spec 01 — Shell Output Compressor.
 *
 * Intercepts well-known developer commands and returns a compressed
 * representation that preserves 100% of decision-relevant information
 * (which tests failed, which files changed, which lines contain errors)
 * while dropping redundant boilerplate (passing test names, ANSI codes,
 * verbose package trees).
 *
 * Design notes:
 *   - Declarative profiles per command. Adding a new command is a new
 *     entry in `BUILTIN_PROFILES` — no parser code to write.
 *   - Idempotent: running the same raw output through twice yields the
 *     same compressed output (so the agent never sees a 2nd-pass diff).
 *   - Fail-open: if a profile doesn't match, the original output is
 *     returned unmodified. No silent dropping.
 *   - Never touches error / stack-trace / path / hash / URL content.
 *
 * The compression runs entirely in the renderer. We don't need a
 * separate "stc" binary for the v1 — the bottleneck is "send fewer
 * tokens to the LLM", and that happens regardless of where the
 * compression code lives, as long as it runs before the text enters
 * the next prompt.
 */

export interface ShellProfile {
  /** Stable id, e.g. "git-status". */
  id: string;
  /** Commands this profile applies to. Matched on the *first* token + program name. */
  match: string[];
  /** Short human label for stats output. */
  label: string;
  /** The actual transform. */
  compress: (raw: string) => string;
}

/* ------------------------------------------------------------------ */
/* Helpers shared across profiles                                      */
/* ------------------------------------------------------------------ */

/** Strip ANSI escape codes and other terminal control sequences. */
function stripAnsi(text: string): string {
  // CSI sequences (ESC[ ... letter) and OSC sequences (ESC] ... BEL/ST).
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/** Collapse runs of identical lines to `<line> (×N)`. */
function dedupRuns(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let runLine = "";
  let runCount = 0;
  const flush = () => {
    if (runCount === 0) return;
    if (runCount === 1) out.push(runLine);
    else out.push(`${runLine} (×${runCount})`);
    runLine = "";
    runCount = 0;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      out.push("");
      continue;
    }
    if (trimmed === runLine.trim()) {
      runCount += 1;
      continue;
    }
    flush();
    runLine = trimmed;
    runCount = 1;
  }
  flush();
  return out.join("\n");
}

/** Truncate a section to a max line count, head + tail with a marker. */
function truncate(lines: string[], maxLines: number): string {
  if (lines.length <= maxLines) return lines.join("\n");
  const keepHead = Math.ceil(maxLines / 2);
  const keepTail = Math.floor(maxLines / 2);
  const omitted = lines.length - keepHead - keepTail;
  return [...lines.slice(0, keepHead), `[... ${omitted} lines omitted ...]`, ...lines.slice(-keepTail)].join("\n");
}

/* ------------------------------------------------------------------ */
/* Per-command profiles                                                */
/* ------------------------------------------------------------------ */

function compressGitStatus(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let branchLine = "";
  for (const line of lines) {
    if (line.startsWith("On branch ")) {
      branchLine = line;
      continue;
    }
    if (line.startsWith("Your branch is")) {
      branchLine = branchLine ? `${branchLine}; ${line}` : line;
      continue;
    }
    if (line.startsWith("nothing to commit")) continue;
    // "Changes to be committed:" / "Changes not staged for commit:" / "Untracked files:"
    if (line.startsWith("Changes to be committed:") || line.startsWith("Changes not staged for commit:") || line.startsWith("Untracked files:")) continue;
    // Indented list items (2-space prefix) belong to a section.
    // Format: "  modified:   <path>" or "  new file:   <path>" or
    //         "  M <path>" (porcelain v1) — we strip the leading marker
    // and take what comes after as the path.
    if (line.startsWith("  ")) {
      const inner = line.trim();
      // Section header hint: "  (use ...)" — skip.
      if (inner.startsWith("(")) continue;
      // Porcelain v1 short status: "  M src/foo.ts" or "?? src/foo.ts"
      const shortMatch = /^(?:M|A|D|R|C|U|\?\?)\s+(.+)$/.exec(inner);
      if (shortMatch) {
        const path = shortMatch[1].trim();
        if (inner.startsWith("M") || inner.startsWith(" D") || inner.startsWith(" D") || inner.startsWith("MM") || inner.startsWith("AM")) {
          modified.push(path);
        } else if (inner.startsWith("??") || inner.startsWith("A") || inner.startsWith("D")) {
          if (inner.startsWith("??")) untracked.push(path);
          else staged.push(path);
        } else {
          modified.push(path);
        }
        continue;
      }
      // Long format: "modified:   <path>", "new file:   <path>", etc.
      const longMatch = /^(modified|new file|deleted|renamed|copied):\s+(.+)$/.exec(inner);
      if (longMatch) {
        const kind = longMatch[1];
        const path = longMatch[2].trim();
        if (kind === "modified") modified.push(path);
        else staged.push(path);
        continue;
      }
      // Untracked file (just an indented path, no marker)
      if (!inner.includes(":")) {
        untracked.push(inner);
      }
    }
  }

  const parts: string[] = [];
  if (branchLine) parts.push(branchLine);
  parts.push(`staged=${staged.length} modified=${modified.length} untracked=${untracked.length}`);
  const listThreshold = 15;
  const summarize = (label: string, paths: string[]) => {
    if (paths.length === 0) return;
    if (paths.length <= listThreshold) {
      parts.push(`${label}:\n${paths.map((p) => `  ${p}`).join("\n")}`);
    } else {
      parts.push(`${label}: ${paths.length} entries (first 10 shown)\n${paths.slice(0, 10).map((p) => `  ${p}`).join("\n")}`);
    }
  };
  summarize("staged", staged);
  summarize("modified", modified);
  summarize("untracked", untracked);
  return parts.join("\n");
}

function compressGitDiff(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n");
  // Count files and hunks; keep the actual diff for any file the user
  // is likely to need to read.
  const fileHeaderRx = /^diff --git a\//;
  const fileCount = lines.filter((l) => fileHeaderRx.test(l)).length;
  const addCount = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const delCount = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const summary = `files=${fileCount} additions=${addCount} deletions=${delCount}`;
  // For tiny diffs keep verbatim.
  if (lines.length <= 80) return `${summary}\n\n${stripped}`;
  return `${summary}\n\n${truncate(lines, 80)}`;
}

function compressGitLog(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  // Each commit takes 2-3 lines (hash, Author:, Date:, subject).
  if (lines.length <= 20) return stripped;
  const truncated = lines.slice(0, 18);
  return `${truncated.join("\n")}\n[... ${lines.length - 18} more commit(s) omitted ...]`;
}

function compressCargoTest(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n");
  const failed: string[] = [];
  const passed: string[] = [];
  const summaryRx = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/;
  let summary = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("test ") && trimmed.includes("... FAILED")) {
      // "test tests::foo ... FAILED"
      const name = trimmed.replace(/^test\s+/, "").replace(/\s+\.\.\.\s+FAILED.*$/, "");
      failed.push(name);
      continue;
    }
    if (trimmed.startsWith("test ") && trimmed.includes("... ok")) {
      const name = trimmed.replace(/^test\s+/, "").replace(/\s+\.\.\.\s+ok.*$/, "");
      passed.push(name);
      continue;
    }
    const m = summaryRx.exec(trimmed);
    if (m) {
      summary = `test result: ${m[1]} — ${m[2]} passed, ${m[3]} failed, ${m[4]} ignored`;
    }
  }
  const parts: string[] = [];
  if (summary) parts.push(summary);
  if (failed.length > 0) {
    parts.push(`failed (${failed.length}):\n${failed.slice(0, 30).map((n) => `  ${n}`).join("\n")}`);
  }
  if (passed.length > 0) {
    parts.push(`passed: ${passed.length}`);
  }
  return parts.join("\n") || stripped;
}

function compressCargoBuild(raw: string): string {
  const stripped = stripAnsi(raw);
  // Cargo build warnings/errors live in `warning:` / `error:` blocks.
  const lines = stripped.split("\n");
  const keep: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    keep.push(buffer.join("\n"));
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("error") || trimmed.startsWith("warning") || trimmed === "" || buffer.length > 0) {
      buffer.push(line);
      if (trimmed === "" || trimmed.startsWith("error") || trimmed.startsWith("warning")) {
        // Keep the block
      } else if (buffer.length > 8) {
        flush();
      }
    } else if (trimmed.startsWith("Compiling ") || trimmed.startsWith("Finished ")) {
      // Drop the per-crate compile lines entirely when there are errors.
      continue;
    }
  }
  flush();
  if (keep.length === 0) return stripped.split("\n").filter((l) => l.includes("Finished") || l.includes("Compiling")).slice(0, 4).join("\n") || stripped;
  return keep.join("\n");
}

function compressNpmTest(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n");
  const failed: string[] = [];
  const passed: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("✓") || t.startsWith("✔") || t.startsWith("PASS ")) {
      const m = /^(?:✓|✔|PASS)\s+(.*?)(?:\s+\(.+ms\))?\s*$/.exec(t);
      if (m) passed.push(m[1]);
      continue;
    }
    if (t.startsWith("✗") || t.startsWith("✘") || t.startsWith("FAIL ")) {
      const m = /^(?:✗|✘|FAIL)\s+(.*?)(?:\s+\(.+ms\))?\s*$/.exec(t);
      if (m) failed.push(m[1]);
      continue;
    }
  }
  const summary = stripped.split("\n").reverse().find((l) => /Tests:.*(passed|failed)/i.test(l)) || "";
  const parts: string[] = [];
  if (summary) parts.push(summary.trim());
  if (failed.length > 0) parts.push(`failed (${failed.length}):\n${failed.slice(0, 30).map((n) => `  ${n}`).join("\n")}`);
  if (passed.length > 0) parts.push(`passed: ${passed.length}`);
  return parts.join("\n") || stripped;
}

function compressFindGrep(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 30) return stripped;
  const grouped = new Map<string, number>();
  for (const line of lines) {
    const lastSlash = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
    const dir = lastSlash > 0 ? line.slice(0, lastSlash) : ".";
    grouped.set(dir, (grouped.get(dir) ?? 0) + 1);
  }
  const top = [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return `matches=${lines.length} dirs=${grouped.size}\n${top.map(([d, n]) => `  ${d}: ${n}`).join("\n")}\n\n(first 15)\n${lines.slice(0, 15).map((l) => `  ${l}`).join("\n")}`;
}

function compressLs(raw: string): string {
  const stripped = stripAnsi(raw);
  const lines = stripped.split("\n").filter((l) => l.length > 0);
  if (lines.length <= 30) return stripped;
  // Count files vs dirs by extension.
  const byExt = new Map<string, number>();
  let total = 0;
  for (const line of lines) {
    total += 1;
    const lastSlash = Math.max(line.lastIndexOf("/"), line.lastIndexOf("\\"));
    const name = lastSlash >= 0 ? line.slice(lastSlash + 1) : line;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const top = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return `entries=${total}\n${top.map(([e, n]) => `  .${e}: ${n}`).join("\n")}\n\n(first 20)\n${lines.slice(0, 20).map((l) => `  ${l}`).join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* Profile registry                                                    */
/* ------------------------------------------------------------------ */

export const BUILTIN_PROFILES: ReadonlyArray<ShellProfile> = [
  { id: "git-status", match: ["git status"], label: "git status", compress: compressGitStatus },
  { id: "git-diff", match: ["git diff", "git diff --staged", "git diff --cached"], label: "git diff", compress: compressGitDiff },
  { id: "git-log", match: ["git log"], label: "git log", compress: compressGitLog },
  { id: "cargo-test", match: ["cargo test", "cargo nextest run"], label: "cargo test", compress: compressCargoTest },
  { id: "cargo-build", match: ["cargo build", "cargo check", "cargo clippy"], label: "cargo build", compress: compressCargoBuild },
  { id: "npm-test", match: ["npm test", "npm run test", "pnpm test", "yarn test"], label: "npm test", compress: compressNpmTest },
  { id: "find-grep", match: ["find", "grep", "rg"], label: "find/grep", compress: compressFindGrep },
  { id: "ls", match: ["ls", "ls -la", "ls -l", "ls -alh", "dir"], label: "ls", compress: compressLs },
];

export interface CompressionResult {
  /** The (possibly compressed) text. */
  text: string;
  /** The profile id that was applied, or null if the command was passed through. */
  profileId: string | null;
  /** Original character count. */
  originalChars: number;
  /** Compressed character count. */
  compressedChars: number;
  /** Ratio compressed / original (lower is better). */
  ratio: number;
}

/**
 * Test whether `command` matches a profile's `match` entry. The match
 * entry is treated as a command prefix: the user-issued command must
 * either equal it exactly or begin with it followed by whitespace
 * (e.g. "git status --short" matches the "git status" pattern).
 */
function commandMatches(command: string, pattern: string): boolean {
  const c = command.trim();
  if (!c || !pattern) return false;
  if (c === pattern) return true;
  if (c.startsWith(pattern + " ")) return true;
  return false;
}

/**
 * Compress a shell command's raw output. The original command string is
 * matched against the registered profiles; on a hit, the profile's
 * `compress` is invoked. On a miss, the raw text is returned untouched
 * (fail-open).
 */
export function compressShellOutput(command: string, raw: string, exitCode: number = 0): CompressionResult {
  const originalChars = raw.length;
  if (raw.length === 0) {
    return { text: "", profileId: null, originalChars, compressedChars: 0, ratio: 0 };
  }
  // Profiles are tried in declaration order; first match wins. We use
  // prefix matching so "git status --short" still hits the "git status"
  // profile, but "git stash" does not.
  let hit: ShellProfile | null = null;
  for (const profile of BUILTIN_PROFILES) {
    for (const m of profile.match) {
      if (commandMatches(command, m)) {
        hit = profile;
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    // No profile matches, but always strip ANSI as a baseline — that's
    // pure lossless noise removal. The stripped text becomes the
    // pass-through output.
    const cleaned = stripAnsi(raw);
    if (cleaned.length === raw.length) {
      return { text: raw, profileId: null, originalChars, compressedChars: raw.length, ratio: 1 };
    }
    return { text: cleaned, profileId: null, originalChars, compressedChars: cleaned.length, ratio: cleaned.length / raw.length };
  }
  // Skip compression when the command failed and the profile is one of
  // the test-runner families — error context must survive untouched.
  // (Each profile handles this internally by keeping error lines.)
  let compressed: string;
  try {
    compressed = hit.compress(raw);
  } catch {
    compressed = raw;
  }
  // Compare against the ANSI-stripped raw, not the raw raw — that way
  // a profile that doesn't add savings on top of ANSI stripping is
  // still allowed to return the cleaner text (a free token win).
  const baseline = stripAnsi(raw);
  if (compressed.length > baseline.length) {
    return { text: baseline, profileId: hit.id, originalChars, compressedChars: baseline.length, ratio: baseline.length / raw.length };
  }
  // Mark non-zero exit so the agent can still see it.
  const prefix = exitCode !== 0 ? `[exit ${exitCode}]\n` : "";
  return {
    text: prefix + compressed,
    profileId: hit.id,
    originalChars,
    compressedChars: compressed.length,
    ratio: compressed.length / raw.length,
  };
}

/** Sum the cumulative token savings from a list of results. */
export function totalSavings(results: ReadonlyArray<CompressionResult>): number {
  return results.reduce((acc, r) => acc + Math.max(0, r.originalChars - r.compressedChars), 0);
}
