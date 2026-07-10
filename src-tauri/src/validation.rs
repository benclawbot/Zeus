// End-to-end validation pipeline. Detects the project's language /
// framework, picks the right validation commands (typecheck, unit tests,
// build, browser smoke, coverage), runs them through the same execution
// path as the workspace shell, and parses the log output into a
// structured summary the agent can act on.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::policy::{authorize, classify_command, AccessMode, AuthOutcome};

const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MAX_CAPTURE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    Node,
    Rust,
    Python,
    Go,
    Unknown,
}

impl ProjectKind {
    pub fn label(self) -> &'static str {
        match self {
            ProjectKind::Node => "node",
            ProjectKind::Rust => "rust",
            ProjectKind::Python => "python",
            ProjectKind::Go => "go",
            ProjectKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectType {
    pub kind: String,
    pub root: String,
    pub config_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRequest {
    pub workspace_dir: Option<String>,
    pub kinds: Option<Vec<String>>, // subset of [typecheck, test, build, browser_smoke, coverage]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCommandResult {
    pub kind: String, // "typecheck" | "test" | "build" | "browser_smoke" | "coverage"
    pub program: String,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub passed: i32,
    pub failed: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NextFix {
    pub file: Option<String>,
    pub line: Option<usize>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub project: ProjectType,
    pub ok: bool,
    pub commands: Vec<ValidationCommandResult>,
    pub errors: Vec<String>,
    pub likely_files: Vec<String>,
    pub next_fix: NextFix,
    pub summary: String,
    pub coverage: Option<CoverageSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoverageSummary {
    pub lines_pct: Option<f32>,
    pub branches_pct: Option<f32>,
    pub raw_excerpt: String,
}

pub fn detect_project_type(workspace_dir: Option<&str>) -> Result<ProjectType, String> {
    let root = workspace_root(workspace_dir)?;
    let mut files = Vec::new();
    let mut kind = ProjectKind::Unknown;
    if root.join("package.json").is_file() {
        files.push("package.json".to_string());
        kind = ProjectKind::Node;
    }
    if root.join("Cargo.toml").is_file() {
        files.push("Cargo.toml".to_string());
        kind = ProjectKind::Rust;
    }
    if root.join("pyproject.toml").is_file() || root.join("pytest.ini").is_file() {
        files.push("pyproject.toml".to_string());
        kind = if kind == ProjectKind::Unknown {
            ProjectKind::Python
        } else {
            kind
        };
    }
    if root.join("go.mod").is_file() {
        files.push("go.mod".to_string());
        kind = if kind == ProjectKind::Unknown {
            ProjectKind::Go
        } else {
            kind
        };
    }
    Ok(ProjectType {
        kind: kind.label().to_string(),
        root: root.to_string_lossy().to_string(),
        config_files: files,
    })
}

/// Pick validation commands for the given project kind and the requested
/// kinds (or the full default set if none specified).
pub fn select_commands(
    kind: ProjectKind,
    kinds: &[String],
) -> Vec<(&'static str, String, Vec<String>)> {
    let wanted: Option<BTreeSet<&str>> = if kinds.is_empty() {
        None
    } else {
        Some(kinds.iter().map(|s| s.as_str()).collect())
    };
    let mut out = Vec::new();
    let include = |label: &'static str| {
        wanted
            .as_ref()
            .map(|set| set.contains(label))
            .unwrap_or(true)
    };
    match kind {
        ProjectKind::Node => {
            if include("typecheck") {
                out.push((
                    "typecheck",
                    "npx".to_string(),
                    vec!["tsc".into(), "--noEmit".into()],
                ));
            }
            if include("test") {
                out.push((
                    "test",
                    "npm".to_string(),
                    vec!["test".into(), "--silent".into()],
                ));
            }
            if include("build") {
                out.push((
                    "build",
                    "npm".to_string(),
                    vec!["run".into(), "build".into()],
                ));
            }
            if include("browser_smoke") {
                out.push((
                    "browser_smoke",
                    "node".to_string(),
                    vec!["scripts/browser-smoke.mjs".into()],
                ));
            }
            if include("coverage") {
                out.push((
                    "coverage",
                    "npm".to_string(),
                    vec!["test".into(), "--".into(), "--coverage".into()],
                ));
            }
        }
        ProjectKind::Rust => {
            if include("typecheck") {
                out.push(("typecheck", "cargo".to_string(), vec!["check".into()]));
            }
            if include("test") {
                out.push((
                    "test",
                    "cargo".to_string(),
                    vec!["test".into(), "--no-fail-fast".into()],
                ));
            }
            if include("build") {
                out.push(("build", "cargo".to_string(), vec!["build".into()]));
            }
        }
        ProjectKind::Python => {
            if include("typecheck") {
                out.push((
                    "typecheck",
                    "python".to_string(),
                    vec!["-m".into(), "mypy".into(), ".".into()],
                ));
            }
            if include("test") {
                out.push((
                    "test",
                    "python".to_string(),
                    vec!["-m".into(), "pytest".into(), "-q".into()],
                ));
            }
            if include("build") {
                out.push((
                    "build",
                    "python".to_string(),
                    vec!["-m".into(), "build".into()],
                ));
            }
        }
        ProjectKind::Go => {
            if include("typecheck") {
                out.push((
                    "typecheck",
                    "go".to_string(),
                    vec!["vet".into(), "./...".into()],
                ));
            }
            if include("test") {
                out.push((
                    "test",
                    "go".to_string(),
                    vec!["test".into(), "./...".into()],
                ));
            }
            if include("build") {
                out.push((
                    "build",
                    "go".to_string(),
                    vec!["build".into(), "./...".into()],
                ));
            }
        }
        ProjectKind::Unknown => {}
    }
    out
}

pub fn run_validation(request: ValidationRequest) -> Result<ValidationResult, String> {
    let project = detect_project_type(request.workspace_dir.as_deref())?;
    let kind = match project.kind.as_str() {
        "node" => ProjectKind::Node,
        "rust" => ProjectKind::Rust,
        "python" => ProjectKind::Python,
        "go" => ProjectKind::Go,
        _ => ProjectKind::Unknown,
    };
    let root = PathBuf::from(&project.root);
    let empty: Vec<String> = Vec::new();
    let kinds_slice: Vec<String> = request.kinds.clone().unwrap_or(empty);
    let commands = select_commands(kind, &kinds_slice);
    let timeout_ms = request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let mode = AccessMode::Full; // Validation always runs at full mode — the user explicitly asked.
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut likely_files = BTreeSet::new();
    let mut coverage = None;
    for (kind_label, program, args) in commands {
        let class = classify_command(&program, &args);
        if matches!(authorize(mode, class), AuthOutcome::Forbidden(_)) {
            errors.push(format!(
                "Access mode blocks validation step '{kind_label}'."
            ));
            results.push(ValidationCommandResult {
                kind: kind_label.to_string(),
                program,
                args,
                exit_code: None,
                stdout: String::new(),
                stderr: "blocked by policy".to_string(),
                duration_ms: 0,
                passed: -1,
                failed: -1,
            });
            continue;
        }
        let result = run_one(&root, &program, &args, timeout_ms);
        if !result.stdout.is_empty() {
            for f in extract_filenames(&result.stdout) {
                likely_files.insert(f);
            }
        }
        if !result.stderr.is_empty() {
            for f in extract_filenames(&result.stderr) {
                likely_files.insert(f);
            }
        }
        if result.exit_code != Some(0) {
            errors.push(format!(
                "{kind_label} ({program}) exited with code {:?}",
                result.exit_code
            ));
        }
        if kind_label == "coverage" && result.exit_code == Some(0) {
            coverage = parse_coverage(&result.stdout, &result.stderr);
        }
        results.push(ValidationCommandResult {
            kind: kind_label.to_string(),
            program,
            args,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            duration_ms: result.duration_ms,
            passed: result.passed,
            failed: result.failed,
        });
    }
    let ok = results
        .iter()
        .all(|r| r.exit_code == Some(0) || r.exit_code.is_none() && r.kind == "coverage");
    let likely_files_vec: Vec<String> = likely_files.iter().cloned().collect();
    let next_fix = next_fix_target(&results, &likely_files_vec);
    let summary = if ok {
        "Validation passed.".to_string()
    } else {
        format!("Validation failed: {}", errors.join("; "))
    };
    Ok(ValidationResult {
        project,
        ok,
        commands: results,
        errors,
        likely_files: likely_files.into_iter().collect(),
        next_fix,
        summary,
        coverage,
    })
}

struct RawCommandResult {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    duration_ms: u128,
    passed: i32,
    failed: i32,
}

fn run_one(root: &Path, program: &str, args: &[String], timeout_ms: u64) -> RawCommandResult {
    let started = Instant::now();
    let mut child = match Command::new(program)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("MINIMAX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("GITHUB_TOKEN")
        .spawn()
    {
        Ok(c) => c,
        Err(err) => {
            return RawCommandResult {
                exit_code: Some(-1),
                stdout: String::new(),
                stderr: format!("spawn {program}: {err}"),
                duration_ms: 0,
                passed: -1,
                failed: -1,
            };
        }
    };
    let timeout = Duration::from_millis(timeout_ms.min(240_000));
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => break,
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = match child.wait_with_output() {
        Ok(o) => o,
        Err(err) => {
            return RawCommandResult {
                exit_code: Some(-1),
                stdout: String::new(),
                stderr: format!("collect {program}: {err}"),
                duration_ms: started.elapsed().as_millis(),
                passed: -1,
                failed: -1,
            };
        }
    };
    let (stdout, _) = bytes_to_limited(&output.stdout, MAX_CAPTURE_BYTES);
    let (stderr, _) = bytes_to_limited(&output.stderr, MAX_CAPTURE_BYTES);
    let combined = format!("{stdout}\n{stderr}");
    let (passed, failed) = parse_test_counts(&combined);
    RawCommandResult {
        exit_code: output.status.code(),
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis(),
        passed,
        failed,
    }
}

fn parse_test_counts(combined: &str) -> (i32, i32) {
    let mut passed = -1i32;
    let mut failed = -1i32;
    for line in combined.lines() {
        let lower = line.to_lowercase();
        if lower.contains("tests passed") || lower.contains("test passed") {
            if let Some(num) = extract_int_after(&lower, "passed") {
                passed = num;
            }
        }
        if lower.contains("tests failed")
            || lower.contains("test failed")
            || lower.contains("failed:")
        {
            if let Some(num) = extract_int_after(&lower, "failed") {
                failed = num;
            }
        }
        if lower.contains(" ok") && lower.contains(" passed") {
            if let Some(num) = extract_int_before(&lower, "passed") {
                passed = num;
            }
        }
    }
    (passed, failed)
}

fn extract_int_after(line: &str, keyword: &str) -> Option<i32> {
    let idx = line.find(keyword)?;
    let after = &line[idx + keyword.len()..];
    after
        .split(|c: char| !c.is_ascii_digit() && c != '-')
        .find_map(|s| s.parse::<i32>().ok())
}

fn extract_int_before(line: &str, keyword: &str) -> Option<i32> {
    let idx = line.find(keyword)?;
    let before = &line[..idx];
    let digits: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == ' ')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.trim().parse::<i32>().ok()
}

fn extract_filenames(log: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in log.lines() {
        if line.contains(".rs:") {
            if let Some(idx) = line.find(".rs:") {
                let start = line[..idx]
                    .rfind(|c: char| c.is_whitespace() || c == '(')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let candidate = line[start..idx + 3].to_string();
                if !out.contains(&candidate) {
                    out.push(candidate);
                }
            }
        }
        for token in line.split_whitespace() {
            if (token.contains(".ts:") || token.contains(".tsx:") || token.contains(".py:"))
                && !token.starts_with('(')
            {
                let cleaned = token
                    .trim_end_matches(|c: char| ":),".contains(c))
                    .to_string();
                if !out.contains(&cleaned) && !cleaned.is_empty() {
                    out.push(cleaned);
                }
            }
        }
    }
    out
}

fn parse_coverage(stdout: &str, stderr: &str) -> Option<CoverageSummary> {
    let combined = format!("{stdout}\n{stderr}");
    let mut lines_pct = None;
    let mut branches_pct = None;
    for line in combined.lines() {
        let lower = line.to_lowercase();
        if lower.contains("lines") && lower.contains('%') {
            if let Some(p) = extract_percent(line) {
                lines_pct = Some(p);
            }
        }
        if lower.contains("branches") && lower.contains('%') {
            if let Some(p) = extract_percent(line) {
                branches_pct = Some(p);
            }
        }
    }
    if lines_pct.is_none() && branches_pct.is_none() {
        return None;
    }
    let excerpt: String = combined
        .lines()
        .filter(|l| l.contains('%'))
        .take(8)
        .collect::<Vec<_>>()
        .join("\n");
    Some(CoverageSummary {
        lines_pct,
        branches_pct,
        raw_excerpt: excerpt,
    })
}

fn extract_percent(line: &str) -> Option<f32> {
    let idx = line.find('%')?;
    let before = &line[..idx];
    let digits: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ' ')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.trim().parse::<f32>().ok()
}

fn next_fix_target(results: &[ValidationCommandResult], likely_files: &[String]) -> NextFix {
    // Pick the first failing step that names a file. Prefer the
    // simplest description so the agent doesn't over-fit on log noise.
    for result in results {
        if result.exit_code == Some(0) {
            continue;
        }
        if let Some(file) = likely_files.first() {
            let line =
                extract_first_line(&result.stderr).or_else(|| extract_first_line(&result.stdout));
            return NextFix {
                file: Some(file.clone()),
                line,
                description: format!(
                    "Investigate the failing {} step and fix the first reported issue.",
                    result.kind
                ),
            };
        }
        return NextFix {
            file: None,
            line: None,
            description: format!(
                "Investigate the failing {} step (no file hint in logs).",
                result.kind
            ),
        };
    }
    NextFix {
        file: None,
        line: None,
        description: "No fix required — validation passed.".to_string(),
    }
}

fn extract_first_line(text: &str) -> Option<usize> {
    for line in text.lines() {
        for token in line.split_whitespace() {
            if token.contains(':') {
                let parts: Vec<&str> = token.split(':').collect();
                if parts.len() >= 2 {
                    if let Ok(n) = parts[1].parse::<usize>() {
                        return Some(n);
                    }
                }
            }
        }
    }
    None
}

fn workspace_root(session_workspace: Option<&str>) -> Result<PathBuf, String> {
    let configured = session_workspace
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("ZEUS_WORKSPACE_DIR")
                .ok()
                .filter(|v| !v.trim().is_empty())
        });
    let root = match configured {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().map_err(|e| format!("resolve current dir: {e}"))?,
    };
    root.canonicalize()
        .map_err(|e| format!("canonicalize workspace '{}': {e}", root.display()))
}

fn bytes_to_limited(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() > cap {
        (String::from_utf8_lossy(&bytes[..cap]).to_string(), true)
    } else {
        (String::from_utf8_lossy(bytes).to_string(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_node_project() {
        let dir = std::env::temp_dir().join(format!(
            "zeus_val_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{}").unwrap();
        let pt = detect_project_type(Some(dir.to_string_lossy().as_ref())).unwrap();
        assert_eq!(pt.kind, "node");
        assert!(pt.config_files.contains(&"package.json".to_string()));
    }

    #[test]
    fn selects_node_commands() {
        let cmds = select_commands(ProjectKind::Node, &[]);
        let kinds: Vec<_> = cmds.iter().map(|c| c.0).collect();
        assert!(kinds.contains(&"typecheck"));
        assert!(kinds.contains(&"test"));
        assert!(kinds.contains(&"build"));
        assert!(kinds.contains(&"browser_smoke"));
    }

    #[test]
    fn extracts_filenames_from_ts_log() {
        let log = "src/foo.ts:10:5 — error TS2304: Cannot find name 'Bar'.";
        let files = extract_filenames(log);
        assert!(files.iter().any(|f| f.contains("src/foo.ts")));
    }

    #[test]
    fn next_fix_returns_filename_from_failure() {
        let result = ValidationCommandResult {
            kind: "test".into(),
            program: "npm".into(),
            args: vec!["test".into()],
            exit_code: Some(1),
            stdout: "src/foo.ts:10:5 error".into(),
            stderr: String::new(),
            duration_ms: 100,
            passed: 0,
            failed: 1,
        };
        let fix = next_fix_target(&[result], &["src/foo.ts".to_string()]);
        assert_eq!(fix.file.as_deref(), Some("src/foo.ts"));
    }
}
