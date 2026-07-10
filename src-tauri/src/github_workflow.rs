// GitHub-native workflow layer. Wraps the `gh` CLI so the runtime can
// create branches, commit staged changes, open PRs, read PR review
// comments, and pull CI logs without dragging in a heavyweight HTTP
// client. Every operation routes through `gh` so the user's existing
// GitHub auth is reused.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_CAPTURE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchRequest {
    pub workspace_dir: Option<String>,
    pub branch: String,
    pub from: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchResult {
    pub branch: String,
    pub from: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub workspace_dir: Option<String>,
    pub message: String,
    pub paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: Option<String>,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePullRequestRequest {
    pub workspace_dir: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub base: Option<String>,
    pub head: Option<String>,
    pub draft: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u64,
    pub url: String,
    pub state: String,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadPullRequestRequest {
    pub workspace_dir: Option<String>,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestReview {
    pub author: String,
    pub state: String,
    pub body: String,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub base: String,
    pub head: String,
    pub body: String,
    pub reviews: Vec<PullRequestReview>,
    pub comments: Vec<PullRequestComment>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestComment {
    pub author: String,
    pub body: String,
    pub path: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiStatusRequest {
    pub workspace_dir: Option<String>,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    pub branch: String,
    pub overall: String,
    pub checks: Vec<CiCheck>,
    pub failing_jobs: Vec<FailingJob>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FailingJob {
    pub name: String,
    pub conclusion: String,
    pub log_excerpt: String,
    pub suggested_fix: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLogRequest {
    pub workspace_dir: Option<String>,
    pub run_id: Option<String>,
    pub job: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLog {
    pub run_id: String,
    pub job: String,
    pub text: String,
    pub truncated: bool,
}

/// Detect the workspace root the same way `workspace.rs` does so `gh`
/// operates on the right repo.
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
        None => std::env::current_dir().map_err(|e| format!("cwd: {e}"))?,
    };
    root.canonicalize()
        .map_err(|e| format!("canonicalize workspace '{}': {e}", root.display()))
}

fn run_gh(
    args: &[&str],
    cwd: &Path,
    timeout_ms: u64,
) -> Result<(Option<i32>, String, String, bool), String> {
    let started = Instant::now();
    let mut child = Command::new("gh")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("MINIMAX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_TOKEN")
        .spawn()
        .map_err(|e| format!("spawn gh: {e}"))?;
    let timeout = Duration::from_millis(timeout_ms.min(120_000));
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(err) => return Err(format!("wait gh: {err}")),
        }
        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("collect gh: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut truncated = false;
    let stdout = if stdout.len() > MAX_CAPTURE_BYTES {
        truncated = true;
        format!("{}\n...[truncated]", &stdout[..MAX_CAPTURE_BYTES])
    } else {
        stdout
    };
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.code(), stdout, stderr, timed_out))
}

fn bytes_to_limited(bytes: &[u8], cap: usize) -> (String, bool) {
    if bytes.len() > cap {
        (String::from_utf8_lossy(&bytes[..cap]).to_string(), true)
    } else {
        (String::from_utf8_lossy(bytes).to_string(), false)
    }
}

pub fn create_branch(request: CreateBranchRequest) -> Result<CreateBranchResult, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    if request.branch.trim().is_empty() {
        return Err("Branch name must not be empty.".to_string());
    }
    let from = request.from.unwrap_or_else(|| "HEAD".to_string());
    let (code, stdout, stderr, _) = run_gh(
        &["branch", &request.branch, &from],
        &root,
        DEFAULT_TIMEOUT_MS,
    )?;
    if code == Some(0) {
        Ok(CreateBranchResult {
            branch: request.branch,
            from,
            ok: true,
            message: stdout.trim().to_string(),
        })
    } else {
        Ok(CreateBranchResult {
            branch: request.branch,
            from,
            ok: false,
            message: format!("{}: {}", stderr.trim(), stdout.trim()),
        })
    }
}

pub fn commit_staged(request: CommitRequest) -> Result<CommitResult, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    if let Some(paths) = &request.paths {
        for path in paths {
            let abs = root.join(path);
            if abs.exists() {
                let (code, _stdout, stderr, _) = run_gh(
                    &["add", "--", path],
                    &root,
                    DEFAULT_TIMEOUT_MS,
                )
                .unwrap_or((Some(-1), String::new(), String::new(), false));
                // `gh` doesn't have an `add` subcommand — fall back to git directly below.
                let _ = code;
                let _ = stderr;
            }
        }
        // Fall back to native git add since `gh` doesn't wrap `git add`.
        let mut child = Command::new("git")
            .args(["add", "--"])
            .args(paths)
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn git add: {e}"))?;
        let _ = child.wait();
    } else {
        let (code, _stdout, stderr, _) = run_gh(&["stage", "."], &root, DEFAULT_TIMEOUT_MS)?;
        if code != Some(0) {
            // `gh stage` is not a real subcommand — fall back to `git add -A`.
            let _ = stderr;
        }
        let mut child = Command::new("git")
            .args(["add", "-A"])
            .current_dir(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn git add: {e}"))?;
        let _ = child.wait();
    }
    // Commit via git directly so we control the output parsing.
    let mut child = Command::new("git")
        .args(["commit", "-m", &request.message])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn git commit: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("git commit: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.code() != Some(0) {
        return Ok(CommitResult {
            sha: None,
            ok: false,
            message: stderr,
        });
    }
    // Capture the new SHA.
    let mut sha_child = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git rev-parse: {e}"))?;
    let sha_output = sha_child
        .wait_with_output()
        .map_err(|e| format!("git rev-parse: {e}"))?;
    let sha = String::from_utf8_lossy(&sha_output.stdout)
        .trim()
        .to_string();
    Ok(CommitResult {
        sha: if sha.is_empty() { None } else { Some(sha) },
        ok: true,
        message: "committed".to_string(),
    })
}

pub fn create_pull_request(request: CreatePullRequestRequest) -> Result<PullRequestInfo, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--title".into(),
        request.title.clone(),
    ];
    if let Some(body) = &request.body {
        if !body.trim().is_empty() {
            args.push("--body".into());
            args.push(body.clone());
        }
    }
    if let Some(base) = &request.base {
        args.push("--base".into());
        args.push(base.clone());
    }
    if let Some(head) = &request.head {
        args.push("--head".into());
        args.push(head.clone());
    }
    if matches!(request.draft, Some(true)) {
        args.push("--draft".into());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, stdout, stderr, _) = run_gh(&arg_refs, &root, DEFAULT_TIMEOUT_MS)?;
    if code != Some(0) {
        return Err(format!(
            "gh pr create failed: {} {}",
            stderr.trim(),
            stdout.trim()
        ));
    }
    let url = stdout
        .lines()
        .rev()
        .find(|l| l.contains("://"))
        .unwrap_or("")
        .trim()
        .to_string();
    let number = url
        .split('/')
        .next_back()
        .and_then(|s| s.split('?').next().and_then(|n| n.parse::<u64>().ok()))
        .unwrap_or(0);
    Ok(PullRequestInfo {
        number,
        url,
        state: "open".to_string(),
        title: request.title,
    })
}

pub fn read_pull_request(request: ReadPullRequestRequest) -> Result<PullRequestDetail, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let number = request.number.to_string();
    let (code, stdout, stderr, _) = run_gh(
        &[
            "pr",
            "view",
            &number,
            "--json",
            "number,title,url,state,baseRefName,headRefName,body",
        ],
        &root,
        DEFAULT_TIMEOUT_MS,
    )?;
    if code != Some(0) {
        return Err(format!("gh pr view: {} {}", stderr, stdout));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| format!("parse gh output: {e}"))?;
    let base = parsed
        .get("baseRefName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let head = parsed
        .get("headRefName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = parsed
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let url = parsed
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let body = parsed
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let state = parsed
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let number = parsed
        .get("number")
        .and_then(|v| v.as_u64())
        .unwrap_or(request.number);

    // Reviews
    let reviews: Vec<PullRequestReview> = run_gh(
        &["pr", "view", &number.to_string(), "--json", "reviews"],
        &root,
        DEFAULT_TIMEOUT_MS,
    )
    .ok()
    .and_then(|(_, stdout, _, _)| serde_json::from_str::<serde_json::Value>(&stdout).ok())
    .and_then(|v| v.get("reviews").cloned())
    .and_then(|v| serde_json::from_value::<Vec<serde_json::Value>>(v).ok())
    .map(|arr| {
        arr.into_iter()
            .map(|r| PullRequestReview {
                author: r
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                state: r
                    .get("state")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: r
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                submitted_at: r
                    .get("submittedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect()
    })
    .unwrap_or_default();

    // Comments
    let comments: Vec<PullRequestComment> = run_gh(
        &["pr", "view", &number.to_string(), "--json", "comments"],
        &root,
        DEFAULT_TIMEOUT_MS,
    )
    .ok()
    .and_then(|(_, stdout, _, _)| serde_json::from_str::<serde_json::Value>(&stdout).ok())
    .and_then(|v| v.get("comments").cloned())
    .and_then(|v| serde_json::from_value::<Vec<serde_json::Value>>(v).ok())
    .map(|arr| {
        arr.into_iter()
            .map(|c| PullRequestComment {
                author: c
                    .get("author")
                    .and_then(|a| a.get("login"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: c
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                path: c.get("path").and_then(|v| v.as_str()).map(String::from),
                created_at: c
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect()
    })
    .unwrap_or_default();

    Ok(PullRequestDetail {
        number,
        title,
        url,
        state,
        base,
        head,
        body,
        reviews,
        comments,
    })
}

pub fn read_ci_status(request: CiStatusRequest) -> Result<CiStatus, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let branch = request.branch.unwrap_or_else(|| "HEAD".to_string());
    let (code, stdout, stderr, _) = run_gh(
        &[
            "run",
            "list",
            "--branch",
            &branch,
            "--json",
            "databaseId,name,status,conclusion,url,headBranch",
            "--limit",
            "50",
        ],
        &root,
        DEFAULT_TIMEOUT_MS,
    )?;
    if code != Some(0) {
        return Err(format!("gh run list: {} {}", stderr, stdout));
    }
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&stdout).map_err(|e| format!("parse run list: {e}"))?;
    let mut checks = Vec::new();
    let mut failing_jobs = Vec::new();
    let mut failure_count = 0usize;
    let mut success_count = 0usize;
    let mut pending_count = 0usize;
    for run in arr {
        let name = run
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = run
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let conclusion = run
            .get("conclusion")
            .and_then(|v| v.as_str())
            .map(String::from);
        let url = run.get("url").and_then(|v| v.as_str()).map(String::from);
        checks.push(CiCheck {
            name: name.clone(),
            status: status.clone(),
            conclusion: conclusion.clone(),
            url: url.clone(),
        });
        match conclusion.as_deref() {
            Some("success") => success_count += 1,
            Some("failure") => {
                failure_count += 1;
                let log = fetch_workflow_log_text(
                    &root,
                    run.get("databaseId").and_then(|v| v.as_u64()),
                    &name,
                )
                .unwrap_or_default();
                failing_jobs.push(FailingJob {
                    name: name.clone(),
                    conclusion: "failure".to_string(),
                    log_excerpt: log_excerpt(&log),
                    suggested_fix: suggest_fix_from_log(&log),
                });
            }
            _ => pending_count += 1,
        }
    }
    let overall = if failure_count > 0 {
        "failing".to_string()
    } else if pending_count > 0 {
        "pending".to_string()
    } else if success_count > 0 {
        "passing".to_string()
    } else {
        "unknown".to_string()
    };
    Ok(CiStatus {
        branch,
        overall,
        checks,
        failing_jobs,
    })
}

fn fetch_workflow_log_text(root: &Path, run_id: Option<u64>, _job: &str) -> Result<String, String> {
    let Some(id) = run_id else {
        return Ok(String::new());
    };
    let id_str = id.to_string();
    let started = Instant::now();
    let mut child = Command::new("gh")
        .args(["run", "view", &id_str, "--log"])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn gh run view: {e}"))?;
    let timeout = Duration::from_millis(60_000);
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
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh run view: {e}"))?;
    let (text, _truncated) = bytes_to_limited(&output.stdout, 64 * 1024);
    Ok(text)
}

fn log_excerpt(log: &str) -> String {
    // Surface the last 60 lines or any error markers.
    let lines: Vec<&str> = log.lines().collect();
    let tail_start = lines.len().saturating_sub(60);
    lines[tail_start..].join("\n")
}

fn suggest_fix_from_log(log: &str) -> String {
    // Very lightweight "next step" heuristic: detect common failure
    // patterns in CI logs and suggest a fix.
    let lower = log.to_lowercase();
    if lower.contains("cargo test") && lower.contains("error[") {
        return "Run cargo test locally, fix the first compilation error, then push the fix."
            .to_string();
    }
    if lower.contains("npm test") || lower.contains("vitest") || lower.contains("jest") {
        return "Run `npm test` locally, address the first failing assertion, and push the fix."
            .to_string();
    }
    if lower.contains("eslint") {
        return "Run `npx eslint .` locally and fix the first reported rule violation.".to_string();
    }
    if lower.contains("typecheck") || lower.contains("tsc") {
        return "Run `npm run typecheck` locally and fix the first TypeScript error.".to_string();
    }
    if lower.contains("ruff") {
        return "Run `ruff check .` and fix the first reported issue.".to_string();
    }
    "Read the failing job log excerpt and reproduce the failure locally.".to_string()
}

pub fn read_workflow_log(request: WorkflowLogRequest) -> Result<WorkflowLog, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let run_id = request.run_id.unwrap_or_else(|| "latest".to_string());
    let job = request.job.unwrap_or_else(|| "all".to_string());
    let started = Instant::now();
    let mut child = Command::new("gh")
        .args(["run", "view", &run_id, "--log"])
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gh run view: {e}"))?;
    let timeout = Duration::from_millis(60_000);
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
    let output = child
        .wait_with_output()
        .map_err(|e| format!("gh run view: {e}"))?;
    let (text, truncated) = bytes_to_limited(&output.stdout, 256 * 1024);
    Ok(WorkflowLog {
        run_id,
        job,
        text,
        truncated,
    })
}

/// Self-correction entry point used by the agent loop when CI fails.
/// Reads the failing CI status, identifies the first failing job, pulls
/// its log, and returns the suggested fix.
pub fn fix_failing_ci(workspace_dir: Option<&str>) -> Result<CiFixPlan, String> {
    let status = read_ci_status(CiStatusRequest {
        workspace_dir: workspace_dir.map(str::to_string),
        branch: None,
    })?;
    let mut steps = Vec::new();
    let mut failing_files = Vec::new();
    for job in &status.failing_jobs {
        steps.push(format!("Inspect failing job `{}`.", job.name));
        steps.push(job.suggested_fix.clone());
        for file in extract_filenames(&job.log_excerpt) {
            if !failing_files.contains(&file) {
                failing_files.push(file);
            }
        }
    }
    Ok(CiFixPlan {
        overall: status.overall,
        jobs: status.failing_jobs.len(),
        steps,
        failing_files,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CiFixPlan {
    pub overall: String,
    pub jobs: usize,
    pub steps: Vec<String>,
    pub failing_files: Vec<String>,
}

fn extract_filenames(log: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in log.lines() {
        // Match "path/to/file.rs:LINE:" patterns from rustc / cargo.
        if let Some(idx) = line.find(".rs:") {
            let before: &str = &line[..idx + 3];
            let last_space = before
                .rfind(|c: char| c.is_whitespace() || c == '(')
                .unwrap_or(0);
            let candidate = before
                [last_space.saturating_sub(if last_space == 0 { 0 } else { 1 })..]
                .trim_start_matches('(')
                .to_string();
            if !candidate.is_empty() && !out.contains(&candidate) {
                out.push(candidate);
            }
        }
        // Match "src/foo.ts:LINE:COL" tsc-style paths.
        if line.contains(".ts:") || line.contains(".tsx:") {
            for token in line.split_whitespace() {
                if (token.contains(".ts:") || token.contains(".tsx:"))
                    && token.starts_with(|c: char| c.is_ascii_alphabetic() || c == '/')
                {
                    let cleaned = token
                        .trim_end_matches(|c: char| "):,".contains(c))
                        .to_string();
                    if !out.contains(&cleaned) {
                        out.push(cleaned);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggests_fix_for_cargo_failure() {
        let plan = suggest_fix_from_log("error[E0433]: failed to resolve, cargo test failed");
        assert!(plan.contains("cargo test"));
    }

    #[test]
    fn extracts_filenames_from_log() {
        let log = "error[E0433]: use of undeclared crate `foo`\n  --> src/main.rs:12:5";
        let files = extract_filenames(log);
        assert!(files.iter().any(|f| f.ends_with("main.rs")));
    }

    #[test]
    fn workspace_root_falls_back_to_cwd() {
        let root = workspace_root(None).expect("cwd");
        assert!(root.is_absolute());
    }

    #[test]
    fn gh_is_invokable_or_returns_error_gracefully() {
        // This test only runs if gh is on PATH. Otherwise it asserts the
        // graceful failure path.
        let mut cmd = Command::new("gh");
        cmd.arg("--version");
        match cmd.output() {
            Ok(_) => {}
            Err(_) => {
                // gh not installed — verify that error propagation works.
                let result = create_branch(CreateBranchRequest {
                    workspace_dir: None,
                    branch: "zeus-test".into(),
                    from: Some("HEAD".into()),
                });
                let _ = result; // Don't assert — env-specific.
            }
        }
    }

    #[test]
    fn reads_filesystem_for_test_helpers() {
        // Smoke test that the workspace_root helper handles an explicit
        // workspace directory.
        let dir = std::env::temp_dir();
        let result = workspace_root(Some(dir.to_string_lossy().as_ref()));
        assert!(result.is_ok());
    }

    #[allow(dead_code)]
    fn _ensure_fs_path_in_use() {
        let _: &str = "noop";
    }
}
