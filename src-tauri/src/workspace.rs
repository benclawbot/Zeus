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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileRequest {
    pub path: String,
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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWorkspaceEditRequest {
    pub path: String,
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
}

pub fn run_shell_command(
    request: ShellCommandRequest,
    access_mode: Option<&str>,
) -> Result<ShellCommandResult, String> {
    ensure_write_allowed(access_mode, request.approved, "shell command")?;
    validate_program(&request.program)?;
    validate_args(&request.args)?;

    let root = workspace_root()?;
    let cwd = match request.cwd.as_deref() {
        Some(value) if !value.trim().is_empty() => resolve_workspace_path(&root, value)?,
        _ => root.clone(),
    };
    if !cwd.is_dir() {
        return Err(format!("Working directory '{}' does not exist.", display_path(&cwd)));
    }

    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
    let started = Instant::now();
    let mut child = Command::new(&request.program)
        .args(&request.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn '{}': {e}", request.program))?;

    let mut timed_out = false;
    loop {
        if let Some(_status) = child.try_wait().map_err(|e| format!("wait '{}': {e}", request.program))? {
            break;
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
        .map_err(|e| format!("collect output for '{}': {e}", request.program))?;

    Ok(ShellCommandResult {
        program: request.program,
        args: request.args,
        cwd: display_path(&cwd),
        exit_code: output.status.code(),
        stdout: bytes_to_limited_string(&output.stdout, MAX_CAPTURE_BYTES),
        stderr: bytes_to_limited_string(&output.stderr, MAX_CAPTURE_BYTES),
        timed_out,
        duration_ms: started.elapsed().as_millis(),
    })
}

pub fn read_workspace_file(request: ReadWorkspaceFileRequest) -> Result<ReadWorkspaceFileResult, String> {
    let root = workspace_root()?;
    let path = resolve_workspace_path(&root, &request.path)?;
    if !path.is_file() {
        return Err(format!("Workspace file '{}' does not exist.", request.path));
    }
    let max_bytes = request.max_bytes.unwrap_or(MAX_FILE_READ_BYTES).min(MAX_FILE_READ_BYTES);
    let bytes = fs::read(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
    let truncated = bytes.len() > max_bytes;
    let visible = if truncated { &bytes[..max_bytes] } else { &bytes[..] };
    Ok(ReadWorkspaceFileResult {
        path: workspace_relative_display(&root, &path),
        content: String::from_utf8_lossy(visible).to_string(),
        bytes_read: visible.len(),
        truncated,
    })
}

pub fn write_workspace_file(
    request: WriteWorkspaceFileRequest,
    access_mode: Option<&str>,
) -> Result<WriteWorkspaceFileResult, String> {
    ensure_write_allowed(access_mode, request.approved, "file write")?;
    validate_content_size(&request.content)?;

    let root = workspace_root()?;
    let path = resolve_workspace_path(&root, &request.path)?;
    let existed = path.exists();
    if existed && !request.overwrite && request.expected_text.is_none() {
        return Err(format!(
            "Refusing to overwrite '{}' without overwrite=true or expectedText.",
            request.path
        ));
    }
    if !existed && !request.create {
        return Err(format!("Refusing to create '{}' without create=true.", request.path));
    }
    if let Some(expected) = request.expected_text.as_deref() {
        let current = fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
        if current != expected {
            return Err(format!("Refusing to write '{}': expectedText does not match current file.", request.path));
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent for '{}': {e}", request.path))?;
    }
    fs::write(&path, request.content.as_bytes()).map_err(|e| format!("write '{}': {e}", request.path))?;
    Ok(WriteWorkspaceFileResult {
        path: workspace_relative_display(&root, &path),
        bytes_written: request.content.len(),
        created: !existed,
    })
}

pub fn apply_workspace_edit(
    request: ApplyWorkspaceEditRequest,
    access_mode: Option<&str>,
) -> Result<ApplyWorkspaceEditResult, String> {
    ensure_write_allowed(access_mode, request.approved, "file edit")?;
    if request.find.is_empty() {
        return Err("find must not be empty.".to_string());
    }
    let root = workspace_root()?;
    let path = resolve_workspace_path(&root, &request.path)?;
    let current = fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
    let replacements = current.matches(&request.find).count();
    if replacements == 0 {
        return Err(format!("No match found in '{}'.", request.path));
    }
    let next = if request.replace_all {
        current.replace(&request.find, &request.replace)
    } else {
        current.replacen(&request.find, &request.replace, 1)
    };
    validate_content_size(&next)?;
    fs::write(&path, next.as_bytes()).map_err(|e| format!("write '{}': {e}", request.path))?;
    Ok(ApplyWorkspaceEditResult {
        path: workspace_relative_display(&root, &path),
        replacements: if request.replace_all { replacements } else { 1 },
        bytes_written: next.len(),
    })
}

fn ensure_write_allowed(access_mode: Option<&str>, approved: bool, action: &str) -> Result<(), String> {
    match access_mode.unwrap_or("Full") {
        "Full" | "Local" => Ok(()),
        "Review" if approved => Ok(()),
        "Review" => Err(format!("Review mode requires explicit approval before running {action}.")),
        "Locked" => Err(format!("Locked mode blocks {action}.")),
        other => Err(format!("Unknown access mode '{other}' blocks {action}.")),
    }
}

fn workspace_root() -> Result<PathBuf, String> {
    let configured = std::env::var("ZEUS_WORKSPACE_DIR").ok().filter(|v| !v.trim().is_empty());
    let root = match configured {
        Some(path) => PathBuf::from(path),
        None => std::env::current_dir().map_err(|e| format!("resolve current dir: {e}"))?,
    };
    root.canonicalize().map_err(|e| format!("resolve workspace root '{}': {e}", root.display()))
}

fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let raw = Path::new(relative);
    if raw.as_os_str().is_empty() {
        return Err("Workspace path must not be empty.".to_string());
    }
    let mut clean = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Workspace path '{}' escapes the workspace.", relative));
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("Workspace path must point to a file or directory inside the workspace.".to_string());
    }
    Ok(root.join(clean))
}

fn workspace_relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn validate_program(program: &str) -> Result<(), String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("Program must not be empty.".to_string());
    }
    if trimmed != program || program.contains('\0') {
        return Err("Program contains invalid characters.".to_string());
    }
    let denied = [
        "rm", "del", "erase", "rmdir", "format", "mkfs", "dd", "shutdown", "reboot", "halt",
        "poweroff", "sudo", "su",
    ];
    let name = Path::new(program)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(program)
        .to_ascii_lowercase();
    if denied.iter().any(|blocked| *blocked == name) {
        return Err(format!("Program '{}' is blocked by the workspace guard.", program));
    }
    Ok(())
}

fn validate_args(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("Command arguments contain invalid characters.".to_string());
    }
    Ok(())
}

fn validate_content_size(content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_WRITE_BYTES {
        return Err(format!("File content is too large: {} bytes > {} bytes.", content.len(), MAX_FILE_WRITE_BYTES));
    }
    Ok(())
}

fn bytes_to_limited_string(bytes: &[u8], max: usize) -> String {
    let truncated = bytes.len() > max;
    let visible = if truncated { &bytes[..max] } else { bytes };
    let mut out = String::from_utf8_lossy(visible).to_string();
    if truncated {
        out.push_str("\n...[truncated]");
    }
    out
}

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
    fn review_mode_requires_approval() {
        assert!(ensure_write_allowed(Some("Review"), false, "shell command").is_err());
        assert!(ensure_write_allowed(Some("Review"), true, "shell command").is_ok());
    }

    #[test]
    fn locked_mode_blocks_actions() {
        assert!(ensure_write_allowed(Some("Locked"), true, "file write").is_err());
    }

    #[test]
    fn dangerous_programs_are_blocked() {
        assert!(validate_program("npm").is_ok());
        assert!(validate_program("rm").is_err());
        assert!(validate_program("sudo").is_err());
    }
}
