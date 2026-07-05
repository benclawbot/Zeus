use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_FILE_READ_BYTES: usize = 512 * 1024;
const MAX_FILE_WRITE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub workspace_dir: Option<String>,
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandResult {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u128,
    pub policy: PolicyDecision,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileRequest {
    pub path: String,
    pub workspace_dir: Option<String>,
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileResult {
    pub path: String,
    pub content: String,
    pub bytes_read: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileRequest {
    pub path: String,
    pub workspace_dir: Option<String>,
    pub content: String,
    #[serde(default)]
    pub create: bool,
    #[serde(default)]
    pub overwrite: bool,
    pub expected_text: Option<String>,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileResult {
    pub path: String,
    pub bytes_written: usize,
    pub created: bool,
    pub diff: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWorkspaceEditRequest {
    pub path: String,
    pub workspace_dir: Option<String>,
    pub find: String,
    pub replace: String,
    #[serde(default)]
    pub replace_all: bool,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWorkspaceEditResult {
    pub path: String,
    pub replacements: usize,
    pub bytes_written: usize,
    pub diff: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentStepRequest {
    ReadFile { path: String },
    WriteFile { path: String, content: String, create: bool, overwrite: bool },
    EditFile { path: String, find: String, replace: String, replace_all: bool },
    RunCommand { program: String, args: Vec<String>, cwd: Option<String>, timeout_ms: Option<u64> },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub objective: String,
    pub workspace_dir: Option<String>,
    pub steps: Vec<AgentStepRequest>,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub stop_on_error: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentStepResult {
    ReadFile(ReadWorkspaceFileResult),
    WriteFile(WriteWorkspaceFileResult),
    EditFile(ApplyWorkspaceEditResult),
    RunCommand(ShellCommandResult),
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStepLog {
    pub index: usize,
    pub label: String,
    pub result: AgentStepResult,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub objective: String,
    pub completed: bool,
    pub files_touched: Vec<String>,
    pub logs: Vec<AgentRunStepLog>,
    pub diff: String,
    pub summary: String,
    pub proposed_harness_rule: Option<String>,
    pub rollback_plan: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub access_mode: String,
    pub command_class: String,
    pub approval_required: bool,
    pub approved: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandClass { Safe, Dependency, Network, Destructive, Privileged }

impl CommandClass {
    fn label(self) -> &'static str {
        match self {
            CommandClass::Safe => "safe",
            CommandClass::Dependency => "dependency",
            CommandClass::Network => "network",
            CommandClass::Destructive => "destructive",
            CommandClass::Privileged => "privileged",
        }
    }
}

pub fn run_agent_task(request: AgentRunRequest, access_mode: Option<&str>) -> AgentRunResult {
    let mut logs = Vec::new();
    let mut files_touched = Vec::new();
    let mut diffs = Vec::new();
    let mut rollback_plan = Vec::new();
    let mut completed = true;

    for (index, step) in request.steps.into_iter().enumerate() {
        let (label, result) = match step {
            AgentStepRequest::ReadFile { path } => {
                let label = format!("read {path}");
                let result = read_workspace_file(ReadWorkspaceFileRequest { path, workspace_dir: request.workspace_dir.clone(), max_bytes: None })
                    .map(AgentStepResult::ReadFile)
                    .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::WriteFile { path, content, create, overwrite } => {
                let label = format!("write {path}");
                let result = write_workspace_file(WriteWorkspaceFileRequest {
                    path,
                    workspace_dir: request.workspace_dir.clone(),
                    content,
                    create,
                    overwrite,
                    expected_text: None,
                    approved: request.approved,
                }, access_mode)
                .map(|out| { files_touched.push(out.path.clone()); diffs.push(out.diff.clone()); rollback_plan.push(format!("Restore {} from git or previous editor contents.", out.path)); AgentStepResult::WriteFile(out) })
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::EditFile { path, find, replace, replace_all } => {
                let label = format!("edit {path}");
                let result = apply_workspace_edit(ApplyWorkspaceEditRequest {
                    path,
                    workspace_dir: request.workspace_dir.clone(),
                    find,
                    replace,
                    replace_all,
                    approved: request.approved,
                }, access_mode)
                .map(|out| { files_touched.push(out.path.clone()); diffs.push(out.diff.clone()); rollback_plan.push(format!("Revert {} using the generated diff or git checkout.", out.path)); AgentStepResult::EditFile(out) })
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::RunCommand { program, args, cwd, timeout_ms } => {
                let label = format!("run {} {}", program, args.join(" ")).trim().to_string();
                let result = run_shell_command(ShellCommandRequest {
                    program,
                    args,
                    cwd,
                    workspace_dir: request.workspace_dir.clone(),
                    timeout_ms,
                    approved: request.approved,
                }, access_mode)
                .map(AgentStepResult::RunCommand)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
        };
        if matches!(result, AgentStepResult::Failed { .. }) {
            completed = false;
        }
        logs.push(AgentRunStepLog { index, label, result });
        if !completed && request.stop_on_error { break; }
    }

    files_touched.sort();
    files_touched.dedup();
    let proposed_harness_rule = harness_rule_from_logs(&request.objective, &logs);
    let summary = summarize_agent_run(&request.objective, completed, &files_touched, &logs);
    AgentRunResult {
        objective: request.objective,
        completed,
        files_touched,
        logs,
        diff: diffs.into_iter().filter(|d| !d.trim().is_empty()).collect::<Vec<_>>().join("\n\n"),
        summary,
        proposed_harness_rule,
        rollback_plan,
    }
}

pub fn run_shell_command(request: ShellCommandRequest, access_mode: Option<&str>) -> Result<ShellCommandResult, String> {
    validate_program(&request.program)?;
    validate_args(&request.args)?;
    let command_class = classify_command(&request.program, &request.args);
    let policy = authorize_command(access_mode, request.approved, command_class)?;
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let cwd = match request.cwd.as_deref() {
        Some(value) if !value.trim().is_empty() => resolve_existing_workspace_dir(&root, value)?,
        _ => root.clone(),
    };
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
    let started = Instant::now();
    let mut child = Command::new(&request.program)
        .args(&request.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("MINIMAX_API_KEY").env_remove("OPENAI_API_KEY").env_remove("ANTHROPIC_API_KEY").env_remove("GITHUB_TOKEN")
        .spawn().map_err(|e| format!("spawn '{}': {e}", request.program))?;
    let mut timed_out = false;
    loop {
        if child.try_wait().map_err(|e| format!("wait '{}': {e}", request.program))?.is_some() { break; }
        if started.elapsed() >= timeout { timed_out = true; let _ = child.kill(); break; }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output().map_err(|e| format!("collect output for '{}': {e}", request.program))?;
    Ok(ShellCommandResult {
        program: request.program,
        args: request.args,
        cwd: display_path(&cwd),
        exit_code: output.status.code(),
        stdout: bytes_to_limited_string(&output.stdout, MAX_CAPTURE_BYTES),
        stderr: bytes_to_limited_string(&output.stderr, MAX_CAPTURE_BYTES),
        timed_out,
        duration_ms: started.elapsed().as_millis(),
        policy,
    })
}

pub fn read_workspace_file(request: ReadWorkspaceFileRequest) -> Result<ReadWorkspaceFileResult, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path(&root, &request.path)?;
    if !path.is_file() { return Err(format!("Workspace file '{}' does not exist.", request.path)); }
    let max_bytes = request.max_bytes.unwrap_or(MAX_FILE_READ_BYTES).min(MAX_FILE_READ_BYTES);
    let bytes = fs::read(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
    let truncated = bytes.len() > max_bytes;
    let visible = if truncated { &bytes[..max_bytes] } else { &bytes[..] };
    Ok(ReadWorkspaceFileResult { path: workspace_relative_display(&root, &path), content: String::from_utf8_lossy(visible).to_string(), bytes_read: visible.len(), truncated })
}

pub fn write_workspace_file(request: WriteWorkspaceFileRequest, access_mode: Option<&str>) -> Result<WriteWorkspaceFileResult, String> {
    let policy = authorize_file_write(access_mode, request.approved)?;
    let _ = policy;
    validate_content_size(&request.content)?;
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path(&root, &request.path)?;
    let existed = path.exists();
    let before = if existed { fs::read_to_string(&path).unwrap_or_default() } else { String::new() };
    if existed && !request.overwrite && request.expected_text.is_none() { return Err(format!("Refusing to overwrite '{}' without overwrite=true or expectedText.", request.path)); }
    if !existed && !request.create { return Err(format!("Refusing to create '{}' without create=true.", request.path)); }
    if let Some(expected) = request.expected_text.as_deref() {
        let current = fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
        if current != expected { return Err(format!("Refusing to write '{}': expectedText does not match current file.", request.path)); }
    }
    if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| format!("create parent for '{}': {e}", request.path))?; }
    fs::write(&path, request.content.as_bytes()).map_err(|e| format!("write '{}': {e}", request.path))?;
    let rel = workspace_relative_display(&root, &path);
    let diff = simple_diff(&rel, &before, &request.content);
    Ok(WriteWorkspaceFileResult { path: rel, bytes_written: request.content.len(), created: !existed, diff })
}

pub fn apply_workspace_edit(request: ApplyWorkspaceEditRequest, access_mode: Option<&str>) -> Result<ApplyWorkspaceEditResult, String> {
    let policy = authorize_file_write(access_mode, request.approved)?;
    let _ = policy;
    if request.find.is_empty() { return Err("find must not be empty.".to_string()); }
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path(&root, &request.path)?;
    let current = fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
    let replacements = current.matches(&request.find).count();
    if replacements == 0 { return Err(format!("No match found in '{}'.", request.path)); }
    let next = if request.replace_all { current.replace(&request.find, &request.replace) } else { current.replacen(&request.find, &request.replace, 1) };
    validate_content_size(&next)?;
    fs::write(&path, next.as_bytes()).map_err(|e| format!("write '{}': {e}", request.path))?;
    let rel = workspace_relative_display(&root, &path);
    let diff = simple_diff(&rel, &current, &next);
    Ok(ApplyWorkspaceEditResult { path: rel, replacements: if request.replace_all { replacements } else { 1 }, bytes_written: next.len(), diff })
}

fn workspace_root(session_workspace: Option<&str>) -> Result<PathBuf, String> {
    let configured = session_workspace.filter(|v| !v.trim().is_empty()).map(str::to_string)
        .or_else(|| std::env::var("ZEUS_WORKSPACE_DIR").ok().filter(|v| !v.trim().is_empty()));
    let root = match configured { Some(path) => PathBuf::from(path), None => std::env::current_dir().map_err(|e| format!("resolve current dir: {e}"))? };
    root.canonicalize().map_err(|e| format!("resolve workspace root '{}': {e}", root.display()))
}

fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let raw = Path::new(relative);
    if raw.as_os_str().is_empty() { return Err("Workspace path must not be empty.".to_string()); }
    let mut clean = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return Err(format!("Workspace path '{}' escapes the workspace.", relative)),
        }
    }
    if clean.as_os_str().is_empty() { return Err("Workspace path must point inside the workspace.".to_string()); }
    Ok(root.join(clean))
}

fn resolve_existing_workspace_dir(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = resolve_workspace_path(root, relative)?;
    if !path.is_dir() { return Err(format!("Working directory '{}' does not exist.", display_path(&path))); }
    Ok(path)
}

fn authorize_command(access_mode: Option<&str>, approved: bool, class: CommandClass) -> Result<PolicyDecision, String> {
    let mode = access_mode.unwrap_or("Full").to_string();
    let approval_required = match (mode.as_str(), class) {
        ("Full", CommandClass::Privileged) => true,
        ("Full", _) => false,
        ("Local", CommandClass::Network | CommandClass::Dependency | CommandClass::Destructive | CommandClass::Privileged) => true,
        ("Local", CommandClass::Safe) => false,
        ("Review", _) => true,
        ("Locked", _) => return Err(format!("Locked mode blocks {} shell commands.", class.label())),
        (other, _) => return Err(format!("Unknown access mode '{other}'.")),
    };
    if approval_required && !approved { return Err(format!("{} mode requires explicit approval for {} shell commands.", mode, class.label())); }
    Ok(PolicyDecision { access_mode: mode, command_class: class.label().to_string(), approval_required, approved })
}

fn authorize_file_write(access_mode: Option<&str>, approved: bool) -> Result<PolicyDecision, String> {
    let mode = access_mode.unwrap_or("Full").to_string();
    let approval_required = match mode.as_str() {
        "Full" | "Local" => false,
        "Review" => true,
        "Locked" => return Err("Locked mode blocks file writes.".to_string()),
        other => return Err(format!("Unknown access mode '{other}'.")),
    };
    if approval_required && !approved { return Err("Review mode requires explicit approval for file writes.".to_string()); }
    Ok(PolicyDecision { access_mode: mode, command_class: "file-write".to_string(), approval_required, approved })
}

fn classify_command(program: &str, args: &[String]) -> CommandClass {
    let name = Path::new(program).file_stem().and_then(OsStr::to_str).unwrap_or(program).to_ascii_lowercase();
    let text = std::iter::once(name.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if ["sudo", "su", "doas"].contains(&name.as_str()) { return CommandClass::Privileged; }
    if ["rm", "del", "erase", "rmdir", "format", "mkfs", "dd", "shutdown", "reboot", "halt", "poweroff"].contains(&name.as_str()) { return CommandClass::Destructive; }
    if name == "git" && (text.contains(" reset") || text.contains(" clean") || text.contains(" push") || text.contains(" checkout --")) { return CommandClass::Destructive; }
    if ["npm", "pnpm", "yarn", "cargo", "pip", "pip3", "poetry", "bun"].contains(&name.as_str()) && (text.contains(" install") || text.contains(" add") || text.contains(" update") || text.contains(" remove")) { return CommandClass::Dependency; }
    if ["curl", "wget", "ssh", "scp", "rsync", "gh"].contains(&name.as_str()) { return CommandClass::Network; }
    CommandClass::Safe
}

fn validate_program(program: &str) -> Result<(), String> {
    if program.trim().is_empty() || program.trim() != program || program.contains('\0') { return Err("Program contains invalid characters.".to_string()); }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg.contains('\0')) { return Err("Command arguments contain invalid characters.".to_string()); }
    Ok(())
}

fn validate_content_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_WRITE_BYTES { return Err(format!("File content is too large: {} bytes > {} bytes.", content.len(), MAX_FILE_WRITE_BYTES)); }
    Ok(())
}

fn simple_diff(path: &str, before: &str, after: &str) -> String {
    if before == after { return String::new(); }
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let max = before_lines.len().max(after_lines.len()).min(200);
    for i in 0..max {
        match (before_lines.get(i), after_lines.get(i)) {
            (Some(a), Some(b)) if a == b => {}
            (Some(a), Some(b)) => { out.push_str(&format!("-{}\n+{}\n", a, b)); }
            (Some(a), None) => out.push_str(&format!("-{}\n", a)),
            (None, Some(b)) => out.push_str(&format!("+{}\n", b)),
            (None, None) => {}
        }
    }
    if before_lines.len().max(after_lines.len()) > max { out.push_str("...[diff truncated]\n"); }
    out
}

fn harness_rule_from_logs(objective: &str, logs: &[AgentRunStepLog]) -> Option<String> {
    let failures = logs.iter().filter(|log| matches!(log.result, AgentStepResult::Failed { .. })).count();
    if failures == 0 { return None; }
    Some(format!("When working on '{}', stop after the first failed execution step, summarize the failing command/file operation, and ask for approval before expanding the blast radius.", objective))
}

fn summarize_agent_run(objective: &str, completed: bool, files: &[String], logs: &[AgentRunStepLog]) -> String {
    format!("Objective: {objective}. Status: {}. Steps: {}. Files touched: {}.", if completed { "completed" } else { "failed" }, logs.len(), if files.is_empty() { "none".to_string() } else { files.join(", ") })
}

fn workspace_relative_display(root: &Path, path: &Path) -> String { path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/") }
fn display_path(path: &Path) -> String { path.to_string_lossy().to_string() }
fn bytes_to_limited_string(bytes: &[u8], max: usize) -> String { let truncated = bytes.len() > max; let visible = if truncated { &bytes[..max] } else { bytes }; let mut out = String::from_utf8_lossy(visible).to_string(); if truncated { out.push_str("\n...[truncated]"); } out }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_blocks_parent_traversal() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert!(resolve_workspace_path(&root, "src/main.rs").is_ok());
        assert!(resolve_workspace_path(&root, "../secret.txt").is_err());
        assert!(resolve_workspace_path(&root, "/tmp/secret.txt").is_err());
    }

    #[test]
    fn policy_depends_on_access_mode() {
        assert!(authorize_command(Some("Full"), false, CommandClass::Safe).is_ok());
        assert!(authorize_command(Some("Local"), false, CommandClass::Dependency).is_err());
        assert!(authorize_command(Some("Local"), true, CommandClass::Dependency).is_ok());
        assert!(authorize_command(Some("Review"), false, CommandClass::Safe).is_err());
        assert!(authorize_command(Some("Locked"), true, CommandClass::Safe).is_err());
    }

    #[test]
    fn classifies_risky_commands() {
        assert_eq!(classify_command("npm", &["test".into()]), CommandClass::Safe);
        assert_eq!(classify_command("npm", &["install".into()]), CommandClass::Dependency);
        assert_eq!(classify_command("git", &["reset".into(), "--hard".into()]), CommandClass::Destructive);
        assert_eq!(classify_command("curl", &["https://example.com".into()]), CommandClass::Network);
    }
}
