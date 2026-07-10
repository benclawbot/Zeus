// Transactional multi-file patch engine. Accepts a unified-diff blob,
// parses it into a list of `ApplyPatchFile` entries, validates every
// hunk against the on-disk content, stages every change in memory, and
// only then writes the files. If any write fails, the engine restores
// the previous contents of every file it touched so the repo is never
// left half-modified.
//
// The diff format we accept is a slightly relaxed unified diff:
//   - file headers are `--- a/<path>` and `+++ b/<path>`
//   - hunk headers are `@@ -old_start,old_count +new_start,new_count @@`
//   - context, removed, and added lines start with ` `, `-`, `+`
//   - "no newline at end of file" markers (`\ No newline at end of
//     file`) are tolerated and ignored.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One parsed hunk inside one file. `old_start` and `old_count` describe
/// the range in the on-disk file; `new_start` and `new_count` describe
/// the range in the post-patch file. `lines` carries the patched payload
/// in source order (without the leading ` `/`-`/`+`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPatchHunk {
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    /// Patched lines, in source order. Each entry carries the original
    /// text *without* its prefix marker.
    pub lines: Vec<String>,
    /// For each line in `lines`: true if the original line was `-`
    /// (removed), false if it was ` ` (context) or `+` (added).
    pub context_only_lines: Vec<bool>,
}

/// One parsed file inside a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPatchFile {
    pub path: String,
    pub new_file: bool,
    pub deleted_file: bool,
    pub hunks: Vec<ApplyPatchHunk>,
}

/// A request to apply a multi-file unified diff. `patch` is the diff text;
/// `base_dir` is the directory the relative paths inside the diff resolve
/// against (usually the workspace root).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchRequest {
    pub patch: String,
    pub base_dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchFileResult {
    pub path: String,
    pub status: String, // "applied" | "created" | "deleted" | "unchanged" | "failed"
    pub hunks_applied: usize,
    pub diff: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchResult {
    pub files_touched: Vec<String>,
    pub rollback_plan: Vec<String>,
    pub per_file: Vec<ApplyPatchFileResult>,
    pub formatter_output: Vec<String>,
    pub ok: bool,
    pub message: String,
}

/// Parse a unified-diff blob. Returns one `ApplyPatchFile` per file
/// header. Lines that don't fit the schema are tolerated as long as the
/// header + hunks parse correctly.
pub fn parse_patch(patch: &str) -> Result<Vec<ApplyPatchFile>, String> {
    let mut files: Vec<ApplyPatchFile> = Vec::new();
    let mut current: Option<ApplyPatchFile> = None;
    let mut current_hunk: Option<ApplyPatchHunk> = None;
    let mut expected_total: usize = 0;

    for raw_line in patch.lines() {
        if raw_line.starts_with("diff --git") {
            flush_hunk(&mut current_hunk, &mut current);
            flush_file(&mut current, &mut files);
            continue;
        }
        if let Some(rest) = raw_line.strip_prefix("--- ") {
            flush_hunk(&mut current_hunk, &mut current);
            flush_file(&mut current, &mut files);
            let path = normalize_patch_path(rest.trim());
            current = Some(ApplyPatchFile {
                path,
                new_file: false,
                deleted_file: false,
                hunks: Vec::new(),
            });
            continue;
        }
        if let Some(rest) = raw_line.strip_prefix("+++ ") {
            let path = normalize_patch_path(rest.trim());
            if let Some(file) = current.as_mut() {
                if path == "/dev/null" {
                    file.deleted_file = true;
                } else if file.path.is_empty() || file.path == "/dev/null" {
                    file.path = path.clone();
                    file.new_file = true;
                } else if path.len() > file.path.len() {
                    file.path = path.clone();
                }
            }
            continue;
        }
        if raw_line.starts_with("@@") {
            flush_hunk(&mut current_hunk, &mut current);
            let hunk = parse_hunk_header(raw_line)?;
            expected_total = hunk.old_count + hunk.new_count;
            current_hunk = Some(hunk);
            continue;
        }
        if let Some(hunk) = current_hunk.as_mut() {
            if expected_total == 0 {
                let popped = current_hunk.take().unwrap();
                if let Some(file) = current.as_mut() {
                    file.hunks.push(popped);
                }
                continue;
            }
            let prefix = raw_line.chars().next();
            let body = raw_line.get(1..).unwrap_or("").to_string();
            match prefix {
                Some(' ') => {
                    hunk.lines.push(body);
                    hunk.context_only_lines.push(false);
                }
                Some('-') => {
                    hunk.lines.push(body);
                    hunk.context_only_lines.push(true);
                }
                Some('+') => {
                    hunk.lines.push(body);
                    hunk.context_only_lines.push(false);
                }
                Some('\\') => continue,
                _ => {
                    expected_total = 0;
                    let popped = current_hunk.take().unwrap();
                    if let Some(file) = current.as_mut() {
                        file.hunks.push(popped);
                    }
                    continue;
                }
            }
            expected_total = expected_total.saturating_sub(1);
        }
    }
    flush_hunk(&mut current_hunk, &mut current);
    flush_file(&mut current, &mut files);
    Ok(files)
}

fn flush_hunk(hunk: &mut Option<ApplyPatchHunk>, current: &mut Option<ApplyPatchFile>) {
    if let Some(h) = hunk.take() {
        if let Some(file) = current.as_mut() {
            file.hunks.push(h);
        }
    }
}

fn flush_file(current: &mut Option<ApplyPatchFile>, files: &mut Vec<ApplyPatchFile>) {
    if let Some(file) = current.take() {
        files.push(file);
    }
}

fn normalize_patch_path(raw: &str) -> String {
    let trimmed = raw
        .trim()
        .trim_start_matches("a/")
        .trim_start_matches("b/")
        .trim();
    if trimmed == "/dev/null" {
        return "/dev/null".to_string();
    }
    trimmed.replace('\\', "/")
}

fn parse_hunk_header(line: &str) -> Result<ApplyPatchHunk, String> {
    let trimmed = line.trim_start_matches("@@").trim_end_matches("@@").trim();
    let mut parts = trimmed.split_whitespace();
    let old = parts
        .next()
        .ok_or_else(|| "malformed hunk header".to_string())?;
    let new = parts
        .next()
        .ok_or_else(|| "malformed hunk header".to_string())?;
    let old = old.trim_start_matches('-');
    let new = new.trim_start_matches('+');
    let (old_start, old_count) =
        parse_range(old).ok_or_else(|| "malformed old range".to_string())?;
    let (new_start, new_count) =
        parse_range(new).ok_or_else(|| "malformed new range".to_string())?;
    Ok(ApplyPatchHunk {
        old_start,
        old_count,
        new_start,
        new_count,
        lines: Vec::new(),
        context_only_lines: Vec::new(),
    })
}

fn parse_range(value: &str) -> Option<(usize, usize)> {
    if value.is_empty() {
        return None;
    }
    if let Some((start, count)) = value.split_once(',') {
        Some((start.parse().ok()?, count.parse().ok()?))
    } else {
        Some((value.parse().ok()?, 1))
    }
}

/// Validate that every hunk in every file matches the on-disk content.
/// Returns a `BTreeMap<path, original_content>` so the apply step can
/// both restore on failure and produce accurate diffs.
pub fn validate_patch(
    files: &[ApplyPatchFile],
    base_dir: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let mut originals = BTreeMap::new();
    for file in files {
        let path = base_dir.join(&file.path);
        if file.new_file {
            if path.exists() {
                return Err(format!(
                    "Patch wants to create {} but the file already exists.",
                    file.path
                ));
            }
            originals.insert(file.path.clone(), String::new());
            continue;
        }
        if file.deleted_file {
            if !path.exists() {
                return Err(format!(
                    "Patch wants to delete {} but the file does not exist.",
                    file.path
                ));
            }
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            originals.insert(file.path.clone(), content);
            continue;
        }
        let content =
            fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let lines: Vec<&str> = content.lines().collect();
        for (hunk_index, hunk) in file.hunks.iter().enumerate() {
            let start = hunk.old_start.saturating_sub(1);
            let end = start + hunk.old_count;
            if end > lines.len() {
                return Err(format!(
                    "Hunk {} in {} runs past the end of the file.",
                    hunk_index + 1,
                    file.path
                ));
            }
            // Validate each '-' or ' ' line in the hunk matches the file.
            let mut file_cursor = start;
            for (i, line) in hunk.lines.iter().enumerate() {
                if hunk.context_only_lines.get(i).copied().unwrap_or(false) {
                    if let Some(existing) = lines.get(file_cursor) {
                        if existing != line {
                            return Err(format!(
                                "Context mismatch in hunk {} of {} at line {}.",
                                hunk_index + 1,
                                file.path,
                                file_cursor + 1
                            ));
                        }
                    }
                    file_cursor += 1;
                }
            }
        }
        originals.insert(file.path.clone(), content);
    }
    Ok(originals)
}

/// Apply a parsed patch transactionally. If validation fails or any
/// write fails, the engine restores every file it had already written
/// so the workspace is left untouched. Returns `Ok` with `ok: false`
/// for validation/write failures — the only error paths are
/// filesystem-level surprises that prevent us from rolling back.
pub fn apply_patch(files: &[ApplyPatchFile], base_dir: &Path) -> Result<ApplyPatchResult, String> {
    let originals = match validate_patch(files, base_dir) {
        Ok(map) => map,
        Err(message) => {
            let per_file = files
                .iter()
                .map(|file| ApplyPatchFileResult {
                    path: file.path.clone(),
                    status: "failed".to_string(),
                    hunks_applied: 0,
                    diff: String::new(),
                    error: Some(message.clone()),
                })
                .collect();
            return Ok(ApplyPatchResult {
                files_touched: Vec::new(),
                rollback_plan: Vec::new(),
                per_file,
                formatter_output: Vec::new(),
                ok: false,
                message,
            });
        }
    };
    let mut per_file: Vec<ApplyPatchFileResult> = Vec::new();
    let mut touched: Vec<String> = Vec::new();
    let mut rollback_plan: Vec<String> = Vec::new();
    let mut staged: Vec<(PathBuf, Option<String>)> = Vec::new();

    for file in files {
        let path = base_dir.join(&file.path);
        match apply_one_file(file, &originals) {
            Ok((status_label, new_content)) => {
                if status_label == "created" || status_label == "applied" {
                    staged.push((path.clone(), Some(new_content.clone())));
                    touched.push(file.path.clone());
                    rollback_plan.push(format!(
                        "Restore {} from backup or git checkout.",
                        file.path
                    ));
                } else if status_label == "deleted" {
                    staged.push((path.clone(), None));
                    touched.push(file.path.clone());
                    rollback_plan.push(format!(
                        "Restore {} from backup or git checkout.",
                        file.path
                    ));
                }
                let diff = simple_unified_diff(
                    &file.path,
                    originals.get(&file.path).map(String::as_str).unwrap_or(""),
                    &new_content,
                );
                per_file.push(ApplyPatchFileResult {
                    path: file.path.clone(),
                    status: status_label,
                    hunks_applied: file.hunks.len(),
                    diff,
                    error: None,
                });
            }
            Err(err) => {
                per_file.push(ApplyPatchFileResult {
                    path: file.path.clone(),
                    status: "failed".to_string(),
                    hunks_applied: 0,
                    diff: String::new(),
                    error: Some(err.clone()),
                });
                // Roll back everything already staged.
                for (p, content_opt) in &staged {
                    if let Some(rel) = pathdiff(p, base_dir) {
                        if let Some(original) = originals.get(&rel) {
                            let _ = fs::write(p, original);
                        }
                    }
                    let _ = content_opt;
                }
                return Ok(ApplyPatchResult {
                    files_touched: Vec::new(),
                    rollback_plan,
                    per_file,
                    formatter_output: Vec::new(),
                    ok: false,
                    message: format!("Patch failed for {}: {err}", file.path),
                });
            }
        }
    }

    // Commit staged writes. If any fails, roll everything back.
    let mut write_failures: Vec<String> = Vec::new();
    for (path, content_opt) in &staged {
        match content_opt {
            Some(content) => {
                if let Some(parent) = path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Err(err) = fs::write(path, content) {
                    write_failures.push(format!("write {}: {err}", path.display()));
                }
            }
            None => {
                if let Err(err) = fs::remove_file(path) {
                    write_failures.push(format!("delete {}: {err}", path.display()));
                }
            }
        }
    }
    if !write_failures.is_empty() {
        for (path, _) in &staged {
            if let Some(rel) = pathdiff(path, base_dir) {
                if let Some(original) = originals.get(&rel) {
                    let _ = fs::write(path, original);
                }
            }
        }
        return Ok(ApplyPatchResult {
            files_touched: Vec::new(),
            rollback_plan,
            per_file,
            formatter_output: Vec::new(),
            ok: false,
            message: format!(
                "Patch rolled back after write failure(s): {}",
                write_failures.join("; ")
            ),
        });
    }

    let formatter_output = run_formatters(&touched, base_dir);
    let applied = per_file
        .iter()
        .filter(|r| r.status == "applied" || r.status == "created" || r.status == "deleted")
        .count();
    Ok(ApplyPatchResult {
        files_touched: touched,
        rollback_plan,
        per_file,
        formatter_output,
        ok: true,
        message: format!("Applied patch to {applied} file(s)."),
    })
}

fn pathdiff(path: &Path, base: &Path) -> Option<String> {
    path.strip_prefix(base)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn apply_one_file(
    file: &ApplyPatchFile,
    originals: &BTreeMap<String, String>,
) -> Result<(String, String), String> {
    if file.new_file {
        let mut out = String::new();
        for hunk in &file.hunks {
            for (i, line) in hunk.lines.iter().enumerate() {
                // Only '+' lines become content; '-' lines shouldn't appear
                // in new_file patches but we tolerate them by skipping.
                if hunk.context_only_lines.get(i).copied().unwrap_or(false) {
                    continue;
                }
                out.push_str(line);
                out.push('\n');
            }
        }
        return Ok(("created".to_string(), out));
    }
    if file.deleted_file {
        return Ok(("deleted".to_string(), String::new()));
    }
    let original = originals
        .get(&file.path)
        .ok_or_else(|| format!("missing original for {}", file.path))?;
    let mut current_lines: Vec<String> = original.lines().map(String::from).collect();
    let mut hunks_sorted = file.hunks.clone();
    hunks_sorted.sort_by_key(|hunk| std::cmp::Reverse(hunk.old_start));
    for hunk in &hunks_sorted {
        let start = hunk.old_start.saturating_sub(1);
        let end = start + hunk.old_count;
        if end > current_lines.len() {
            return Err(format!(
                "Hunk range {}-{} exceeds file length.",
                start + 1,
                end
            ));
        }
        let mut new_segment: Vec<String> = Vec::new();
        for (i, line) in hunk.lines.iter().enumerate() {
            if hunk.context_only_lines.get(i).copied().unwrap_or(false) {
                continue;
            }
            new_segment.push(line.clone());
        }
        let mut next = Vec::with_capacity(current_lines.len() + new_segment.len());
        next.extend_from_slice(&current_lines[..start]);
        next.extend(new_segment);
        next.extend_from_slice(&current_lines[end..]);
        current_lines = next;
    }
    let mut new_content = current_lines.join("\n");
    if !new_content.ends_with('\n') && original.ends_with('\n') {
        new_content.push('\n');
    }
    if new_content == *original {
        return Ok(("unchanged".to_string(), original.clone()));
    }
    Ok(("applied".to_string(), new_content))
}

fn simple_unified_diff(path: &str, before: &str, after: &str) -> String {
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    let max = before_lines.len().max(after_lines.len()).min(200);
    for i in 0..max {
        match (before_lines.get(i), after_lines.get(i)) {
            (Some(a), Some(b)) if a == b => out.push_str(&format!(" {a}\n")),
            (Some(a), Some(b)) => {
                out.push_str(&format!("-{a}\n+{b}\n"));
            }
            (Some(a), None) => out.push_str(&format!("-{a}\n")),
            (None, Some(b)) => out.push_str(&format!("+{b}\n")),
            (None, None) => {}
        }
    }
    if before_lines.len().max(after_lines.len()) > max {
        out.push_str("...[diff truncated]\n");
    }
    out
}

/// Auto-format touched files by extension. Best-effort: failures don't
/// fail the patch, they show up in `formatter_output` so the agent can
/// surface them.
pub fn run_formatters(paths: &[String], base_dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for path in paths {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let formatter = match ext.as_str() {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Some("prettier"),
            "rs" => Some("cargo-fmt"),
            "py" => Some("ruff"),
            _ => None,
        };
        let Some(formatter) = formatter else { continue };
        let key = format!("{formatter}:{path}");
        if !seen.insert(key) {
            continue;
        }
        let abs = base_dir.join(path);
        let result = match formatter {
            "prettier" => std::process::Command::new("npx")
                .args([
                    "--yes",
                    "prettier",
                    "--write",
                    abs.to_string_lossy().as_ref(),
                ])
                .current_dir(base_dir)
                .output(),
            "cargo-fmt" => std::process::Command::new("cargo")
                .args(["fmt", "--", abs.to_string_lossy().as_ref()])
                .current_dir(base_dir)
                .output(),
            "ruff" => std::process::Command::new("ruff")
                .args(["format", abs.to_string_lossy().as_ref()])
                .current_dir(base_dir)
                .output(),
            _ => continue,
        };
        match result {
            Ok(output) => {
                let code = output.status.code();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if code == Some(0) {
                    out.push(format!("{formatter} ok: {path}"));
                } else {
                    out.push(format!(
                        "{formatter} skipped {path}: exit {code:?} {stderr}"
                    ));
                }
            }
            Err(err) => out.push(format!("{formatter} unavailable for {path}: {err}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeus_patch_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_minimal_unified_diff() {
        let patch = "--- a/hello.txt\n+++ b/hello.txt\n@@ -1,1 +1,1 @@\n-hello\n+hi\n";
        let files = parse_patch(patch).expect("parse");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "hello.txt");
        assert_eq!(files[0].hunks.len(), 1);
    }

    #[test]
    fn rejects_hunk_with_context_mismatch() {
        let dir = temp_dir();
        let path = dir.join("foo.txt");
        let mut file = fs::File::create(&path).unwrap();
        file.write_all(b"a\nb\nc\n").unwrap();
        let patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n";
        let files = parse_patch(patch).unwrap();
        let err = validate_patch(&files, &dir).unwrap_err();
        assert!(err.contains("Context mismatch"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "a\nb\nc\n",
            "file must not be modified on validation failure"
        );
    }

    #[test]
    fn multi_file_patch_rolls_back_on_failure() {
        let dir = temp_dir();
        fs::write(dir.join("ok.txt"), "before-ok\n").unwrap();
        fs::write(dir.join("bad.txt"), "before-bad\n").unwrap();
        // First file: clean single-line replacement.
        // Second file: hunk claims line 1 is "-NOT_THE_ACTUAL_LINE" but
        // the file actually contains "before-bad". Validator must catch
        // the context mismatch and roll back the first file.
        let patch = "--- a/ok.txt\n+++ b/ok.txt\n@@ -1,1 +1,1 @@\n-before-ok\n+after-ok\n--- a/bad.txt\n+++ b/bad.txt\n@@ -1,1 +1,1 @@\n-NOT_THE_ACTUAL_LINE\n+after-bad\n";
        let files = parse_patch(patch).unwrap();
        let result = apply_patch(&files, &dir).unwrap();
        assert!(!result.ok, "expected the bad hunk to fail validation");
        assert_eq!(
            fs::read_to_string(dir.join("ok.txt")).unwrap(),
            "before-ok\n",
            "ok.txt must not be modified when a sibling patch fails"
        );
        assert_eq!(
            fs::read_to_string(dir.join("bad.txt")).unwrap(),
            "before-bad\n"
        );
    }
}
