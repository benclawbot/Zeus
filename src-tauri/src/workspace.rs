use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::policy;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
// Default file-read cap. The frontend previously got a 512 KB truncation
// for everything, which forced the agent to re-issue reads with smaller
// windows to see the rest of the file. 2 MiB comfortably fits most
// source files (a typical React component is well under 20 KB) without
// overflowing the LLM context for a single read.
const MAX_FILE_READ_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILE_WRITE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub workspace_dir: Option<String>,
    pub timeout_ms: Option<u64>,
    /// Backward-compatible flag. Use `approval_id` for any new code —
    /// the runtime-mediated id is what the spec calls for.
    #[serde(default)]
    pub approved: bool,
    /// Runtime-issued approval id. When set, the runtime has already
    /// validated this id against its `ApprovedOnce` /
    /// `ApprovedForSession` ledger. The runtime command surface is
    /// responsible for the actual check; here we just log it.
    #[serde(default)]
    pub approval_id: Option<String>,
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
    /// Approval id used to authorize the call, when supplied.
    #[serde(default)]
    pub approval_id: Option<String>,
    /// True when the call was blocked because the supplied approval
    /// id was missing, unknown, or already consumed.
    #[serde(default)]
    pub approval_required: bool,
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
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileResult {
    pub path: String,
    pub bytes_written: usize,
    pub created: bool,
    pub diff: String,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub approval_required: bool,
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
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyWorkspaceEditResult {
    pub path: String,
    pub replacements: usize,
    pub bytes_written: usize,
    pub diff: String,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub approval_required: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentStepRequest {
    ReadFile {
        path: String,
        max_bytes: Option<usize>,
    },
    WriteFile {
        path: String,
        content: String,
        create: bool,
        overwrite: bool,
    },
    EditFile {
        path: String,
        find: String,
        replace: String,
        replace_all: bool,
    },
    RunCommand {
        program: String,
        args: Vec<String>,
        cwd: Option<String>,
        timeout_ms: Option<u64>,
    },
    ListDir {
        path: String,
        max_entries: Option<usize>,
    },
    LoadProjectConfig,
    GitOp {
        args: Vec<String>,
        timeout_ms: Option<u64>,
    },
    RunTest {
        args: Vec<String>,
        timeout_ms: Option<u64>,
    },
    /// Autonomous web research. Hits DuckDuckGo's HTML endpoint and
    /// returns ranked title + URL + snippet so the model can pull
    /// external context without a browser session.
    WebSearch {
        query: String,
        max_results: Option<usize>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub objective: String,
    pub workspace_dir: Option<String>,
    pub steps: Vec<AgentStepRequest>,
    #[serde(default)]
    pub approved: bool,
    /// Runtime approval id covering every risky step in this run. The
    /// Tauri command surface resolves it via the runtime service before
    /// invoking `run_agent_task`. When set, the request is treated as
    /// authorized for any risky step the agent attempts.
    #[serde(default)]
    pub approval_id: Option<String>,
    /// Hard cap on the total number of self-correction iterations the
    /// agent is allowed to run after the initial plan executes. Defaults
    /// to 5 so a stuck agent doesn't loop forever.
    #[serde(default)]
    pub max_correction_steps: Option<usize>,
    #[serde(default)]
    pub stop_on_error: bool,
    #[serde(default)]
    pub prior_failures: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentStepResult {
    ReadFile(ReadWorkspaceFileResult),
    WriteFile(WriteWorkspaceFileResult),
    EditFile(ApplyWorkspaceEditResult),
    RunCommand(ShellCommandResult),
    ListDir(ListWorkspaceDirResult),
    ProjectConfig(ProjectConfigResult),
    GitOp(GitOperationResult),
    RunTest(TestRunResult),
    WebSearch(crate::web_search::WebSearchResult),
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStepLog {
    pub index: usize,
    pub label: String,
    pub result: AgentStepResult,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EffortTier {
    Low,
    Medium,
    High,
}

impl EffortTier {
    fn label(self) -> &'static str {
        match self {
            EffortTier::Low => "low",
            EffortTier::Medium => "medium",
            EffortTier::High => "high",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffortSignals {
    pub files_touched: usize,
    pub prior_failures: usize,
    pub novelty_score: f32,
    pub risky_steps: usize,
    pub total_steps: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EffortLog {
    pub subtask_id: String,
    pub tier_selected: EffortTier,
    pub signals: EffortSignals,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCheckpoint {
    pub subtask_id: String,
    pub timestamp: String,
    pub decision: String,
    pub rationale: String,
    pub next_dependency: Option<String>,
    pub source: String,
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
    pub effort_log: EffortLog,
    pub memory_checkpoints: Vec<MemoryCheckpoint>,
    /// Approval id used to authorize the run, when supplied.
    #[serde(default)]
    pub approval_id: Option<String>,
    /// Structured diagnosis of the most recent failure (if any). The
    /// frontend surfaces this so the user can see *why* the agent
    /// stopped and what it would try next.
    #[serde(default)]
    pub diagnosis: Option<Diagnosis>,
}

/// One diagnosis entry — produced automatically when a step fails.
/// The agent can attach a follow-up plan so the next iteration knows
/// what to try.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub step_index: usize,
    pub step_label: String,
    pub failure_category: String,
    pub root_cause: String,
    pub next_action: String,
    pub revised_plan: Vec<String>,
    pub fallback_strategy: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDecision {
    pub access_mode: String,
    pub command_class: String,
    pub approval_required: bool,
    pub approved: bool,
    /// Approval id that authorized the call, when supplied.
    #[serde(default)]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandClass {
    Safe,
    Dependency,
    Network,
    Destructive,
    Privileged,
}

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

    fn is_risky(self) -> bool {
        !matches!(self, CommandClass::Safe)
    }
}

pub fn run_agent_task(request: AgentRunRequest, access_mode: Option<&str>) -> AgentRunResult {
    let signals = effort_signals(&request);
    let mut effort_tier = classify_effort(&signals);
    let mut logs = Vec::new();
    let mut files_touched = Vec::new();
    let mut diffs = Vec::new();
    let mut rollback_plan = Vec::new();
    let mut checkpoints = Vec::new();
    let mut completed = true;
    let mut diagnosis: Option<Diagnosis> = None;

    for (index, step) in request.steps.iter().cloned().enumerate() {
        let (label, result) = match step {
            AgentStepRequest::ReadFile { path, max_bytes } => {
                let label = format!("read {path}");
                let result = read_workspace_file(
                    ReadWorkspaceFileRequest {
                        path,
                        workspace_dir: request.workspace_dir.clone(),
                        max_bytes,
                    },
                    access_mode,
                )
                .map(AgentStepResult::ReadFile)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::WriteFile {
                path,
                content,
                create,
                overwrite,
            } => {
                let label = format!("write {path}");
                let result = write_workspace_file(
                    WriteWorkspaceFileRequest {
                        path,
                        workspace_dir: request.workspace_dir.clone(),
                        content,
                        create,
                        overwrite,
                        expected_text: None,
                        approved: request.approved,
                        approval_id: request.approval_id.clone(),
                    },
                    access_mode,
                )
                .map(|out| {
                    files_touched.push(out.path.clone());
                    diffs.push(out.diff.clone());
                    rollback_plan.push(format!(
                        "Restore {} from git or previous editor contents.",
                        out.path
                    ));
                    AgentStepResult::WriteFile(out)
                })
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::EditFile {
                path,
                find,
                replace,
                replace_all,
            } => {
                let label = format!("edit {path}");
                let result = apply_workspace_edit(
                    ApplyWorkspaceEditRequest {
                        path,
                        workspace_dir: request.workspace_dir.clone(),
                        find,
                        replace,
                        replace_all,
                        approved: request.approved,
                        approval_id: request.approval_id.clone(),
                    },
                    access_mode,
                )
                .map(|out| {
                    files_touched.push(out.path.clone());
                    diffs.push(out.diff.clone());
                    rollback_plan.push(format!(
                        "Revert {} using the generated diff or git checkout.",
                        out.path
                    ));
                    AgentStepResult::EditFile(out)
                })
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::RunCommand {
                program,
                args,
                cwd,
                timeout_ms,
            } => {
                let label = format!("run {} {}", program, args.join(" "))
                    .trim()
                    .to_string();
                let result = run_shell_command(
                    ShellCommandRequest {
                        program,
                        args,
                        cwd,
                        workspace_dir: request.workspace_dir.clone(),
                        timeout_ms,
                        approved: request.approved,
                        approval_id: request.approval_id.clone(),
                    },
                    access_mode,
                )
                .map(AgentStepResult::RunCommand)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::ListDir { path, max_entries } => {
                let label = format!("ls {path}");
                let result = list_workspace_dir(
                    ListWorkspaceDirRequest {
                        path,
                        workspace_dir: request.workspace_dir.clone(),
                        max_entries,
                    },
                    access_mode,
                )
                .map(AgentStepResult::ListDir)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::LoadProjectConfig => {
                let label = "load project config".to_string();
                let result = load_project_config(
                    ProjectConfigRequest {
                        workspace_dir: request.workspace_dir.clone(),
                    },
                    access_mode,
                )
                .map(AgentStepResult::ProjectConfig)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::GitOp { args, timeout_ms } => {
                let label = format!("git {}", args.join(" "));
                let result = run_git_operation(
                    GitOperationRequest {
                        workspace_dir: request.workspace_dir.clone(),
                        args,
                        timeout_ms,
                    },
                    access_mode,
                )
                .map(|out| {
                    if out.mutated {
                        files_touched.push(format!("git:{}", out.args.join(" ")));
                    }
                    AgentStepResult::GitOp(out)
                })
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::RunTest { args, timeout_ms } => {
                let label = "run tests".to_string();
                let result = run_project_test(
                    TestRunRequest {
                        workspace_dir: request.workspace_dir.clone(),
                        args,
                        timeout_ms,
                    },
                    access_mode,
                )
                .map(AgentStepResult::RunTest)
                .unwrap_or_else(|message| AgentStepResult::Failed { message });
                (label, result)
            }
            AgentStepRequest::WebSearch { query, max_results } => {
                let label = format!("web search \"{query}\"");
                let search_request = crate::web_search::WebSearchRequest {
                    query: query.clone(),
                    max_results,
                };
                let result = match tauri::async_runtime::block_on(crate::web_search::web_search(
                    search_request,
                )) {
                    Ok(value) => AgentStepResult::WebSearch(value),
                    Err(message) => AgentStepResult::Failed { message },
                };
                (label, result)
            }
        };

        let failed = matches!(result, AgentStepResult::Failed { .. });
        if failed {
            completed = false;
            effort_tier = escalate_effort(effort_tier);
            // Build a diagnosis so the agent loop knows what to try next.
            diagnosis = Some(diagnose_step(&request.objective, index, &label, &result));
        }

        let checkpoint = checkpoint_from_step(&request.objective, index, &label, &result);
        if let Some(checkpoint) = checkpoint {
            checkpoints.push(checkpoint);
        }

        logs.push(AgentRunStepLog {
            index,
            label,
            result,
        });
        if failed && request.stop_on_error {
            break;
        }
    }

    files_touched.sort();
    files_touched.dedup();
    let outcome = if completed { "success" } else { "failure" }.to_string();
    let effort_log = EffortLog {
        subtask_id: stable_subtask_id(&request.objective),
        tier_selected: effort_tier,
        signals,
        outcome,
    };
    let proposed_harness_rule = harness_rule_from_logs(&request.objective, &logs, effort_tier);
    let summary = summarize_agent_run(
        &request.objective,
        completed,
        &files_touched,
        &logs,
        &effort_log,
        diagnosis.as_ref(),
    );
    AgentRunResult {
        objective: request.objective,
        completed,
        files_touched,
        logs,
        diff: diffs
            .into_iter()
            .filter(|d| !d.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        summary,
        proposed_harness_rule,
        rollback_plan,
        effort_log,
        memory_checkpoints: checkpoints,
        approval_id: request.approval_id,
        diagnosis,
    }
}

/// Build a `Diagnosis` from a failed step. The category, root cause, and
/// next-action strings are deliberately conservative — they tell the
/// agent loop *which class of problem* this is so it can decide what
/// to retry without prescribing a specific fix.
fn diagnose_step(
    objective: &str,
    index: usize,
    label: &str,
    result: &AgentStepResult,
) -> Diagnosis {
    let failure_message = match result {
        AgentStepResult::Failed { message } => message.clone(),
        AgentStepResult::RunCommand(out) if out.exit_code != Some(0) || out.timed_out => {
            let tail = out
                .stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_default();
            format!("command exited {:?}: {}", out.exit_code, tail)
        }
        AgentStepResult::RunTest(out) if out.exit_code != Some(0) => {
            let tail = out
                .stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_default();
            format!("test exit {:?}: {}", out.exit_code, tail)
        }
        _ => "step did not produce expected result".to_string(),
    };
    let lower = failure_message.to_lowercase();
    let (category, next_action) = if lower.contains("compile")
        || lower.contains("error[")
        || lower.contains("tsc")
    {
        ("compilation", "Run the typecheck step locally, fix the first reported error, then re-run the failing step.")
    } else if lower.contains("test") && lower.contains("fail") {
        ("test-failure", "Inspect the failing test, read the asserted file, and propose a minimal targeted edit.")
    } else if lower.contains("permission") || lower.contains("approval") {
        (
            "approval-required",
            "Ask the user to approve the next risky step before re-running.",
        )
    } else if lower.contains("not found")
        || lower.contains("no such file")
        || lower.contains("enoent")
    {
        ("missing-file", "Verify the path. If the file should exist, create it as a pre-step; if not, fix the referring code.")
    } else if lower.contains("timeout") || lower.contains("timed out") {
        (
            "timeout",
            "Increase the timeout, narrow the step's scope, or split into smaller sub-steps.",
        )
    } else {
        (
            "other",
            "Read the failure output, search related files, and propose a targeted next step.",
        )
    };
    let revised_plan = vec![
        format!("Read the failure output for `{label}`."),
        format!("Locate the referenced file (search the workspace if needed)."),
        "Propose one targeted edit or shell step that addresses the failure.".to_string(),
    ];
    let fallback_strategy = if category == "compilation" {
        "If the error is in a dependency, consider `cargo update` or reinstalling the package (requires approval).".to_string()
    } else if category == "test-failure" {
        "If the failing test is flaky, re-run it in isolation; if it's deterministic, fix the production code.".to_string()
    } else if category == "missing-file" {
        "If the file was renamed, update the references; otherwise create a stub.".to_string()
    } else {
        "Capture the stderr in a memory entry so the next attempt avoids the same trap.".to_string()
    };
    Diagnosis {
        step_index: index,
        step_label: label.to_string(),
        failure_category: category.to_string(),
        root_cause: failure_message,
        next_action: next_action.to_string(),
        revised_plan,
        fallback_strategy,
    }
    .with_objective(objective)
}

impl Diagnosis {
    fn with_objective(mut self, objective: &str) -> Self {
        self.revised_plan
            .insert(0, format!("Re-anchor on objective: '{objective}'."));
        self
    }
}

fn policy_redact(bytes: &[u8]) -> (Vec<u8>, usize) {
    let text = String::from_utf8_lossy(bytes);
    let (scrubbed, count) = policy::redact_secrets(&text);
    (scrubbed.into_bytes(), count)
}

pub fn run_shell_command(
    request: ShellCommandRequest,
    access_mode: Option<&str>,
) -> Result<ShellCommandResult, String> {
    validate_program(&request.program)?;
    validate_args(&request.args)?;
    let command_class = classify_command(&request.program, &request.args);
    let policy = authorize_command(
        access_mode,
        request.approved,
        command_class,
        request.approval_id.as_deref(),
    )?;
    if policy.approval_required && !policy.approved {
        return Ok(ShellCommandResult {
            program: request.program,
            args: request.args,
            cwd: String::new(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            duration_ms: 0,
            policy,
            approval_id: request.approval_id,
            approval_required: true,
        });
    }
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let cwd = match request.cwd.as_deref() {
        Some(value) if !value.trim().is_empty() => {
            resolve_existing_workspace_dir(&root, value, access_mode)?
        }
        _ => root.clone(),
    };
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );
    let started = Instant::now();
    let env = policy::scrubbed_env();
    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        command.env(k, v);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("spawn '{}': {e}", request.program))?;
    let mut timed_out = false;
    loop {
        if child
            .try_wait()
            .map_err(|e| format!("wait '{}': {e}", request.program))?
            .is_some()
        {
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
    let (stdout_redacted, _) = policy_redact(&output.stdout);
    let (stderr_redacted, _) = policy_redact(&output.stderr);
    Ok(ShellCommandResult {
        program: request.program,
        args: request.args,
        cwd: display_path(&cwd),
        exit_code: output.status.code(),
        stdout: bytes_to_limited_string(&stdout_redacted, MAX_CAPTURE_BYTES),
        stderr: bytes_to_limited_string(&stderr_redacted, MAX_CAPTURE_BYTES),
        timed_out,
        duration_ms: started.elapsed().as_millis(),
        policy,
        approval_id: request.approval_id,
        approval_required: false,
    })
}

pub fn read_workspace_file(
    request: ReadWorkspaceFileRequest,
    access_mode: Option<&str>,
) -> Result<ReadWorkspaceFileResult, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path_with_mode(&root, &request.path, access_mode)?;
    if !path.is_file() {
        return Err(format!("Workspace file '{}' does not exist.", request.path));
    }
    let max_bytes = request
        .max_bytes
        .unwrap_or(MAX_FILE_READ_BYTES)
        .min(MAX_FILE_READ_BYTES);
    let bytes = fs::read(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
    let truncated = bytes.len() > max_bytes;
    let visible = if truncated {
        &bytes[..max_bytes]
    } else {
        &bytes[..]
    };
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
    let policy = authorize_file_write(
        access_mode,
        request.approved,
        request.approval_id.as_deref(),
    )?;
    if policy.approval_required && !policy.approved {
        return Ok(WriteWorkspaceFileResult {
            path: request.path,
            bytes_written: 0,
            created: false,
            diff: String::new(),
            approval_id: request.approval_id,
            approval_required: true,
        });
    }
    validate_content_size(&request.content)?;
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path_with_mode(&root, &request.path, access_mode)?;
    let existed = path.exists();
    let before = if existed {
        fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    };
    if !existed && !request.create {
        return Err(format!(
            "Refusing to create '{}' without create=true.",
            request.path
        ));
    }
    if let Some(expected) = request.expected_text.as_deref() {
        let current =
            fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", request.path))?;
        if current != expected {
            return Err(format!(
                "Refusing to write '{}': expectedText does not match current file.",
                request.path
            ));
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create parent for '{}': {e}", request.path))?;
    }
    fs::write(&path, request.content.as_bytes())
        .map_err(|e| format!("write '{}': {e}", request.path))?;
    let rel = workspace_relative_display(&root, &path);
    let diff = simple_diff(&rel, &before, &request.content);
    Ok(WriteWorkspaceFileResult {
        path: rel,
        bytes_written: request.content.len(),
        created: !existed,
        diff,
        approval_id: request.approval_id,
        approval_required: false,
    })
}

pub fn apply_workspace_edit(
    request: ApplyWorkspaceEditRequest,
    access_mode: Option<&str>,
) -> Result<ApplyWorkspaceEditResult, String> {
    let policy = authorize_file_write(
        access_mode,
        request.approved,
        request.approval_id.as_deref(),
    )?;
    if policy.approval_required && !policy.approved {
        return Ok(ApplyWorkspaceEditResult {
            path: request.path,
            replacements: 0,
            bytes_written: 0,
            diff: String::new(),
            approval_id: request.approval_id,
            approval_required: true,
        });
    }
    if request.find.is_empty() {
        return Err("find must not be empty.".to_string());
    }
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let path = resolve_workspace_path_with_mode(&root, &request.path, access_mode)?;
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
    let rel = workspace_relative_display(&root, &path);
    let diff = simple_diff(&rel, &current, &next);
    Ok(ApplyWorkspaceEditResult {
        path: rel,
        replacements: if request.replace_all { replacements } else { 1 },
        bytes_written: next.len(),
        diff,
        approval_id: request.approval_id,
        approval_required: false,
    })
}

// ---------- new commands: ls / project-config / git / test ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceDirRequest {
    pub path: String,
    pub workspace_dir: Option<String>,
    pub max_entries: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceDirEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspaceDirResult {
    pub path: String,
    pub entries: Vec<ListWorkspaceDirEntry>,
    pub truncated: bool,
}

/// List the contents of a workspace directory. Read-only and safe under
/// every access mode. Useful as the autonomous file-discovery primitive
/// the model uses to explore an unfamiliar repo.
pub fn list_workspace_dir(
    request: ListWorkspaceDirRequest,
    access_mode: Option<&str>,
) -> Result<ListWorkspaceDirResult, String> {
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let dir = if request.path.trim().is_empty() {
        root.clone()
    } else {
        resolve_workspace_path_with_mode(&root, &request.path, access_mode)?
    };
    if !dir.is_dir() {
        return Err(format!(
            "Workspace directory '{}' does not exist.",
            request.path
        ));
    }
    let cap = request.max_entries.unwrap_or(500).min(2000);
    let mut entries: Vec<ListWorkspaceDirEntry> = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&dir).map_err(|e| format!("read_dir '{}': {e}", request.path))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if metadata.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        };
        entries.push(ListWorkspaceDirEntry {
            name,
            kind,
            size: metadata.len(),
        });
        if entries.len() >= cap {
            truncated = true;
            break;
        }
    }
    entries.sort_by(|a, b| (a.kind.cmp(&b.kind)).then(a.name.cmp(&b.name)));
    Ok(ListWorkspaceDirResult {
        path: workspace_relative_display(&root, &dir),
        entries,
        truncated,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigRequest {
    pub workspace_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfigResult {
    pub path: String,
    pub root: String,
    pub config: serde_json::Value,
}

/// Discover and parse the project's nearest config file. Walks up from
/// the workspace root looking for `package.json`, `pyproject.toml`,
/// `Cargo.toml`, `go.mod`, or `pom.xml`. Returns a parsed JSON value
/// (TOML/Go/Python configs are returned as their raw text inside a
/// JSON wrapper so the frontend can show them).
pub fn load_project_config(
    request: ProjectConfigRequest,
    access_mode: Option<&str>,
) -> Result<ProjectConfigResult, String> {
    let _ = access_mode;
    let root = workspace_root(request.workspace_dir.as_deref())?;
    const CANDIDATES: &[&str] = &[
        "package.json",
        "pyproject.toml",
        "Cargo.toml",
        "go.mod",
        "pom.xml",
    ];
    let mut current = root.clone();
    loop {
        for candidate in CANDIDATES {
            let path = current.join(candidate);
            if !path.is_file() {
                continue;
            }
            let raw =
                fs::read_to_string(&path).map_err(|e| format!("read '{}': {e}", path.display()))?;
            let value: serde_json::Value =
                if path.extension().and_then(|s| s.to_str()) == Some("json") {
                    serde_json::from_str(&raw)
                        .map_err(|e| format!("parse '{}': {e}", path.display()))?
                } else {
                    serde_json::json!({ "raw": raw })
                };
            return Ok(ProjectConfigResult {
                path: workspace_relative_display(&root, &path),
                root: workspace_relative_display(&root, &current),
                config: value,
            });
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    Err("No recognized project config found (looked for package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml).".to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationRequest {
    pub workspace_dir: Option<String>,
    pub args: Vec<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationResult {
    pub args: Vec<String>,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u128,
    pub mutated: bool,
}

/// Run a single `git` subcommand against the workspace. Read-only
/// subcommands (`status`, `log`, `diff`, `show`, `branch`) run under any
/// access mode. Mutating subcommands (`commit`, `merge`, `reset`,
/// `checkout`, `clean`, `push`, `pull`) require explicit `approved: true`
/// AND `Review` access mode OR `Full` access mode.
pub fn run_git_operation(
    request: GitOperationRequest,
    access_mode: Option<&str>,
) -> Result<GitOperationResult, String> {
    let mode = access_mode.unwrap_or("Full");
    let subcommand = request.args.first().map(String::as_str).unwrap_or("");
    let read_only = matches!(
        subcommand,
        "status"
            | "log"
            | "diff"
            | "show"
            | "branch"
            | "remote"
            | "rev-parse"
            | "ls-files"
            | "ls-tree"
    );
    if !read_only {
        match mode {
            "Locked" => return Err("Locked mode blocks git mutations.".to_string()),
            "Review" | "Full" => {}
            _ => return Err(format!("Access mode '{mode}' blocks git mutations.")),
        }
    }
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS),
    );
    let started = Instant::now();
    let mut child = Command::new("git")
        .args(&request.args)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove("MINIMAX_API_KEY")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("GITHUB_TOKEN")
        .spawn()
        .map_err(|e| format!("spawn git: {e}"))?;
    let mut timed_out = false;
    loop {
        if child
            .try_wait()
            .map_err(|e| format!("wait git: {e}"))?
            .is_some()
        {
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
        .map_err(|e| format!("collect git output: {e}"))?;
    Ok(GitOperationResult {
        args: request.args.clone(),
        cwd: workspace_relative_display(&root, &root),
        exit_code: output.status.code(),
        stdout: bytes_to_limited_string(&output.stdout, MAX_CAPTURE_BYTES),
        stderr: bytes_to_limited_string(&output.stderr, MAX_CAPTURE_BYTES),
        timed_out,
        duration_ms: started.elapsed().as_millis(),
        mutated: !read_only,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunRequest {
    pub workspace_dir: Option<String>,
    pub args: Vec<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub failed_count: i32,
    pub passed_count: i32,
}

/// Run the project's test suite. Detects the runner by looking for the
/// usual manifest files (package.json, Cargo.toml, pyproject.toml,
/// go.mod). For Node projects it shells out to `npm test --silent
/// -- --reporter=json` and parses the failed/passed counts out of the
/// output; for others it runs the project's package script / cargo test
/// and falls back to a heuristic count when no JSON is available.
pub fn run_project_test(
    request: TestRunRequest,
    access_mode: Option<&str>,
) -> Result<TestRunResult, String> {
    let mode = access_mode.unwrap_or("Full");
    if mode == "Locked" {
        return Err("Locked mode blocks test execution.".to_string());
    }
    let root = workspace_root(request.workspace_dir.as_deref())?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(180_000).min(MAX_TIMEOUT_MS));
    let (program, base_args) = detect_test_runner(&root);
    let mut full_args = base_args;
    full_args.extend(request.args.iter().cloned());
    let start = Instant::now();
    let mut child = Command::new(&program)
        .args(&full_args)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn test runner: {e}"))?;
    let mut timed_out = false;
    loop {
        if child
            .try_wait()
            .map_err(|e| format!("wait test runner: {e}"))?
            .is_some()
        {
            break;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("collect test output: {e}"))?;
    let stdout = bytes_to_limited_string(&output.stdout, MAX_CAPTURE_BYTES);
    let stderr = bytes_to_limited_string(&output.stderr, MAX_CAPTURE_BYTES);
    let combined = format!("{}\n{}", stdout, stderr);
    let (passed, failed) = parse_test_counts(&combined, output.status.code());
    let _ = timed_out;
    Ok(TestRunResult {
        command: program,
        args: full_args,
        cwd: workspace_relative_display(&root, &root),
        exit_code: output.status.code(),
        stdout,
        stderr,
        duration_ms: start.elapsed().as_millis(),
        passed_count: passed,
        failed_count: failed,
    })
}

fn detect_test_runner(root: &Path) -> (String, Vec<String>) {
    if root.join("package.json").is_file() {
        return (
            "npm".to_string(),
            vec!["test".to_string(), "--silent".to_string()],
        );
    }
    if root.join("Cargo.toml").is_file() {
        return (
            "cargo".to_string(),
            vec!["test".to_string(), "--no-fail-fast".to_string()],
        );
    }
    if root.join("pyproject.toml").is_file() || root.join("pytest.ini").is_file() {
        return (
            "python".to_string(),
            vec!["-m".to_string(), "pytest".to_string(), "-q".to_string()],
        );
    }
    if root.join("go.mod").is_file() {
        return (
            "go".to_string(),
            vec!["test".to_string(), "./...".to_string()],
        );
    }
    ("npm".to_string(), vec!["test".to_string()])
}

/// Best-effort pass/fail counter. Looks for common Vitest, Jest, Cargo,
/// and pytest summary lines. Returns (-1, -1) when nothing matches so
/// the caller can fall back to exit code semantics.
fn parse_test_counts(combined: &str, exit_code: Option<i32>) -> (i32, i32) {
    let mut passed: i32 = -1;
    let mut failed: i32 = -1;
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
            // Vitest summary line like "Tests  3 passed (3)"
            if let Some(num) = extract_int_before(&lower, "passed") {
                passed = num;
            }
        }
    }
    if passed < 0 && failed < 0 {
        // Fall back to exit-code-only heuristic: exit 0 means everything
        // passed; non-zero means at least one failed.
        if exit_code == Some(0) {
            passed = 0;
            failed = 0;
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
    let trimmed = digits.trim();
    trimmed.parse::<i32>().ok()
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
        .map_err(|e| format!("resolve workspace root '{}': {e}", root.display()))
}

fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    resolve_workspace_path_with_mode(root, relative, None)
}

/// Resolve a caller-supplied path. Zeus currently runs in unrestricted
/// filesystem mode: absolute paths, Windows drive prefixes, and `..`
/// traversal are accepted for every access mode. Relative paths are still
/// resolved against the session workspace/current directory for convenience,
/// but the workspace is no longer a security boundary.
fn resolve_workspace_path_with_mode(
    root: &Path,
    relative: &str,
    mode: Option<&str>,
) -> Result<PathBuf, String> {
    let _ = mode;
    let raw = Path::new(relative);
    if raw.as_os_str().is_empty() {
        return Err("Path must not be empty.".to_string());
    }
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };
    Ok(canonicalize_if_exists(&candidate))
}

fn canonicalize_if_exists(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn resolve_existing_workspace_dir(
    root: &Path,
    relative: &str,
    mode: Option<&str>,
) -> Result<PathBuf, String> {
    let path = resolve_workspace_path_with_mode(root, relative, mode)?;
    if !path.is_dir() {
        return Err(format!(
            "Working directory '{}' does not exist.",
            display_path(&path)
        ));
    }
    Ok(path)
}

fn authorize_command(
    access_mode: Option<&str>,
    approved: bool,
    class: CommandClass,
    approval_id: Option<&str>,
) -> Result<PolicyDecision, String> {
    let mode = access_mode.unwrap_or("Full").to_string();
    let approval_required = match (mode.as_str(), class) {
        ("Full", CommandClass::Privileged) => true,
        ("Full", _) => false,
        (
            "Local",
            CommandClass::Network
            | CommandClass::Dependency
            | CommandClass::Destructive
            | CommandClass::Privileged,
        ) => true,
        ("Local", CommandClass::Safe) => false,
        ("Review", _) => true,
        ("Locked", _) => {
            return Err(format!(
                "Locked mode blocks {} shell commands.",
                class.label()
            ))
        }
        (other, _) => return Err(format!("Unknown access mode '{other}'.")),
    };
    // Approval id is treated as authorization even when the legacy
    // `approved: bool` is false — the runtime has already validated
    // the id. The Tauri command surface is responsible for the
    // consumption check; here we just trust the caller and log the id.
    let effective_approved = approved || approval_id.is_some();
    if approval_required && !effective_approved {
        return Err(format!(
            "{} mode requires explicit approval for {} shell commands.",
            mode,
            class.label()
        ));
    }
    Ok(PolicyDecision {
        access_mode: mode,
        command_class: class.label().to_string(),
        approval_required,
        approved: effective_approved,
        approval_id: approval_id.map(String::from),
    })
}

fn authorize_file_write(
    access_mode: Option<&str>,
    approved: bool,
    approval_id: Option<&str>,
) -> Result<PolicyDecision, String> {
    let mode = access_mode.unwrap_or("Full").to_string();
    let approval_required = match mode.as_str() {
        "Full" | "Local" => false,
        "Review" => true,
        "Locked" => return Err("Locked mode blocks file writes.".to_string()),
        other => return Err(format!("Unknown access mode '{other}'.")),
    };
    let effective_approved = approved || approval_id.is_some();
    if approval_required && !effective_approved {
        return Err("Review mode requires explicit approval for file writes.".to_string());
    }
    Ok(PolicyDecision {
        access_mode: mode,
        command_class: "file-write".to_string(),
        approval_required,
        approved: effective_approved,
        approval_id: approval_id.map(String::from),
    })
}

fn classify_command(program: &str, args: &[String]) -> CommandClass {
    let name = Path::new(program)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(program)
        .to_ascii_lowercase();
    let text = std::iter::once(name.as_str())
        .chain(args.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if ["sudo", "su", "doas"].contains(&name.as_str()) {
        return CommandClass::Privileged;
    }
    if [
        "rm", "del", "erase", "rmdir", "format", "mkfs", "dd", "shutdown", "reboot", "halt",
        "poweroff",
    ]
    .contains(&name.as_str())
    {
        return CommandClass::Destructive;
    }
    if name == "git"
        && (text.contains(" reset")
            || text.contains(" clean")
            || text.contains(" push")
            || text.contains(" checkout --"))
    {
        return CommandClass::Destructive;
    }
    if [
        "npm", "pnpm", "yarn", "cargo", "pip", "pip3", "poetry", "bun",
    ]
    .contains(&name.as_str())
        && (text.contains(" install")
            || text.contains(" add")
            || text.contains(" update")
            || text.contains(" remove"))
    {
        return CommandClass::Dependency;
    }
    if ["curl", "wget", "ssh", "scp", "rsync", "gh"].contains(&name.as_str()) {
        return CommandClass::Network;
    }
    CommandClass::Safe
}

fn validate_program(program: &str) -> Result<(), String> {
    if program.trim().is_empty() || program.trim() != program || program.contains('\0') {
        return Err("Program contains invalid characters.".to_string());
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
        return Err(format!(
            "File content is too large: {} bytes > {} bytes.",
            content.len(),
            MAX_FILE_WRITE_BYTES
        ));
    }
    Ok(())
}

fn simple_diff(path: &str, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let before_lines: Vec<&str> = before.lines().collect();
    let after_lines: Vec<&str> = after.lines().collect();
    let mut out = format!("--- a/{path}\n+++ b/{path}\n");
    let max = before_lines.len().max(after_lines.len()).min(200);
    for i in 0..max {
        match (before_lines.get(i), after_lines.get(i)) {
            (Some(a), Some(b)) if a == b => {}
            (Some(a), Some(b)) => {
                out.push_str(&format!("-{}\n+{}\n", a, b));
            }
            (Some(a), None) => out.push_str(&format!("-{}\n", a)),
            (None, Some(b)) => out.push_str(&format!("+{}\n", b)),
            (None, None) => {}
        }
    }
    if before_lines.len().max(after_lines.len()) > max {
        out.push_str("...[diff truncated]\n");
    }
    out
}

fn effort_signals(request: &AgentRunRequest) -> EffortSignals {
    let mut files = Vec::new();
    let mut risky_steps = 0;
    for step in &request.steps {
        match step {
            AgentStepRequest::ReadFile { path, .. }
            | AgentStepRequest::WriteFile { path, .. }
            | AgentStepRequest::EditFile { path, .. } => files.push(path.clone()),
            AgentStepRequest::RunCommand { program, args, .. } => {
                if classify_command(program, args).is_risky() {
                    risky_steps += 1;
                }
            }
            AgentStepRequest::ListDir { path, .. } => files.push(path.clone()),
            AgentStepRequest::LoadProjectConfig => {}
            AgentStepRequest::GitOp { .. } => {}
            AgentStepRequest::RunTest { .. } => {}
            AgentStepRequest::WebSearch { .. } => {}
        }
    }
    files.sort();
    files.dedup();
    let novelty_score = novelty_score(&request.objective, &files, risky_steps, request.steps.len());
    EffortSignals {
        files_touched: files.len(),
        prior_failures: request.prior_failures,
        novelty_score,
        risky_steps,
        total_steps: request.steps.len(),
    }
}

fn classify_effort(signals: &EffortSignals) -> EffortTier {
    if signals.prior_failures >= 2
        || signals.files_touched >= 8
        || signals.risky_steps >= 2
        || signals.novelty_score >= 0.75
    {
        return EffortTier::High;
    }
    if signals.prior_failures == 1
        || signals.files_touched >= 3
        || signals.risky_steps == 1
        || signals.novelty_score >= 0.35
    {
        return EffortTier::Medium;
    }
    EffortTier::Low
}

fn escalate_effort(current: EffortTier) -> EffortTier {
    match current {
        EffortTier::Low => EffortTier::Medium,
        EffortTier::Medium | EffortTier::High => EffortTier::High,
    }
}

fn novelty_score(objective: &str, files: &[String], risky_steps: usize, total_steps: usize) -> f32 {
    let mut score: f32 = 0.0;
    let objective = objective.to_ascii_lowercase();
    if objective.contains("new")
        || objective.contains("implement")
        || objective.contains("refactor")
        || objective.contains("wire")
    {
        score += 0.25;
    }
    if files.iter().any(|path| path.ends_with(".rs")) {
        score += 0.25;
    }
    if files.len() >= 3 {
        score += 0.25;
    }
    if risky_steps > 0 {
        score += 0.2;
    }
    if total_steps >= 5 {
        score += 0.1;
    }
    score.min(1.0)
}

fn checkpoint_from_step(
    objective: &str,
    index: usize,
    label: &str,
    result: &AgentStepResult,
) -> Option<MemoryCheckpoint> {
    let (source, rationale) = match result {
        AgentStepResult::Failed { message } => ("error", format!("Step failed: {message}")),
        AgentStepResult::WriteFile(out) => (
            "checkpoint",
            format!("Wrote {} ({} bytes).", out.path, out.bytes_written),
        ),
        AgentStepResult::EditFile(out) => (
            "checkpoint",
            format!(
                "Edited {} with {} replacement(s).",
                out.path, out.replacements
            ),
        ),
        AgentStepResult::RunCommand(out) if out.exit_code != Some(0) || out.timed_out => (
            "error",
            format!(
                "Command exited {:?}; timed_out={}.",
                out.exit_code, out.timed_out
            ),
        ),
        _ => return None,
    };
    Some(MemoryCheckpoint {
        subtask_id: format!("{}-{index}", stable_subtask_id(objective)),
        timestamp: current_timestamp(),
        decision: label.to_string(),
        rationale,
        next_dependency: dependency_from_label(label),
        source: source.to_string(),
    })
}

fn dependency_from_label(label: &str) -> Option<String> {
    label
        .split_whitespace()
        .last()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn stable_subtask_id(value: &str) -> String {
    let mut out = value
        .chars()
        .flat_map(|ch| ch.to_lowercase())
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "agent-run".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

fn current_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("unix:{}", now.as_secs())
}

fn harness_rule_from_logs(
    objective: &str,
    logs: &[AgentRunStepLog],
    effort_tier: EffortTier,
) -> Option<String> {
    let failures = logs
        .iter()
        .filter(|log| matches!(log.result, AgentStepResult::Failed { .. }))
        .count();
    if failures == 0 {
        return None;
    }
    Some(format!("When working on '{}', Zeus escalated effort to {} after a failed execution step. Re-plan with the failure output in context before attempting broader changes.", objective, effort_tier.label()))
}

fn summarize_agent_run(
    objective: &str,
    completed: bool,
    files: &[String],
    logs: &[AgentRunStepLog],
    effort: &EffortLog,
    diagnosis: Option<&Diagnosis>,
) -> String {
    let mut out = format!(
        "Objective: {objective}. Status: {}. Steps: {}. Files touched: {}. Adaptive effort: {} (files={}, priorFailures={}, riskySteps={}, novelty={:.2}).",
        if completed { "completed" } else { "failed" },
        logs.len(),
        if files.is_empty() { "none".to_string() } else { files.join(", ") },
        effort.tier_selected.label(),
        effort.signals.files_touched,
        effort.signals.prior_failures,
        effort.signals.risky_steps,
        effort.signals.novelty_score,
    );
    if let Some(d) = diagnosis {
        out.push_str(&format!(
            " Diagnosis: category={}, next={}",
            d.failure_category, d.next_action
        ));
    }
    out
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
    fn resolve_allows_unrestricted_paths() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        assert!(resolve_workspace_path(&root, "src/main.rs").is_ok());
        assert!(resolve_workspace_path(&root, "../secret.txt").is_ok());
        assert!(resolve_workspace_path(&root, "/tmp/secret.txt").is_ok());
    }

    #[test]
    fn resolve_treats_current_dir_as_root() {
        let root = std::env::current_dir().unwrap().canonicalize().unwrap();
        let dot = resolve_workspace_path(&root, ".").expect("dot resolves");
        let dot_slash = resolve_workspace_path(&root, "./").expect("./ resolves");
        let dot_dot_slash = resolve_workspace_path(&root, "./.").expect("./. resolves");
        let nested =
            resolve_workspace_path(&root, "./src/main.rs").expect("./src/main.rs resolves");
        assert_eq!(dot, root);
        assert_eq!(dot_slash, root);
        assert_eq!(dot_dot_slash, root);
        assert_eq!(nested, root.join("src").join("main.rs"));
    }

    #[test]
    fn policy_depends_on_access_mode() {
        assert!(authorize_command(Some("Full"), false, CommandClass::Safe, None).is_ok());
        assert!(authorize_command(Some("Local"), false, CommandClass::Dependency, None).is_err());
        assert!(authorize_command(Some("Local"), true, CommandClass::Dependency, None).is_ok());
        assert!(authorize_command(Some("Review"), false, CommandClass::Safe, None).is_err());
        assert!(authorize_command(Some("Locked"), true, CommandClass::Safe, None).is_err());
    }

    #[test]
    fn approval_id_authorizes_risky_command() {
        let decision = authorize_command(
            Some("Review"),
            false,
            CommandClass::Safe,
            Some("approval-1"),
        )
        .unwrap();
        assert!(decision.approved);
        assert_eq!(decision.approval_id.as_deref(), Some("approval-1"));
    }

    #[test]
    fn classifies_risky_commands() {
        assert_eq!(
            classify_command("npm", &["test".into()]),
            CommandClass::Safe
        );
        assert_eq!(
            classify_command("npm", &["install".into()]),
            CommandClass::Dependency
        );
        assert_eq!(
            classify_command("git", &["reset".into(), "--hard".into()]),
            CommandClass::Destructive
        );
        assert_eq!(
            classify_command("curl", &["https://example.com".into()]),
            CommandClass::Network
        );
    }

    #[test]
    fn selects_effort_from_rust_execution_signals() {
        let low = EffortSignals {
            files_touched: 1,
            prior_failures: 0,
            novelty_score: 0.1,
            risky_steps: 0,
            total_steps: 1,
        };
        let medium = EffortSignals {
            files_touched: 1,
            prior_failures: 0,
            novelty_score: 0.1,
            risky_steps: 1,
            total_steps: 1,
        };
        let high = EffortSignals {
            files_touched: 1,
            prior_failures: 2,
            novelty_score: 0.1,
            risky_steps: 0,
            total_steps: 1,
        };
        assert_eq!(classify_effort(&low), EffortTier::Low);
        assert_eq!(classify_effort(&medium), EffortTier::Medium);
        assert_eq!(classify_effort(&high), EffortTier::High);
    }

    #[test]
    fn agent_run_returns_effort_and_checkpoints() {
        let result = run_agent_task(
            AgentRunRequest {
                objective: "exercise effort management".to_string(),
                workspace_dir: None,
                steps: vec![AgentStepRequest::ReadFile {
                    path: "definitely-missing-file.txt".to_string(),
                    max_bytes: None,
                }],
                approved: false,
                approval_id: None,
                max_correction_steps: None,
                stop_on_error: true,
                prior_failures: 1,
            },
            Some("Full"),
        );
        assert!(!result.completed);
        assert_eq!(result.effort_log.tier_selected, EffortTier::High);
        assert_eq!(result.memory_checkpoints.len(), 1);
        assert!(result.summary.contains("Adaptive effort"));
    }

    fn unique_tempdir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "zeus_{}_{}_{:?}",
            label,
            std::process::id(),
            std::thread::current().id()
        ))
    }

    fn make_dir_with_file(label: &str, file_name: &str, contents: &str) -> (PathBuf, PathBuf) {
        let dir = unique_tempdir(label);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(file_name);
        std::fs::write(&file, contents).unwrap();
        (dir, file)
    }

    #[test]
    fn all_modes_accept_absolute_existing_path() {
        let (dir, file) = make_dir_with_file("full_abs", "skill.md", "skill body");
        let bogus = unique_tempdir("full_abs_root");
        let _ = std::fs::remove_dir_all(&bogus);
        std::fs::create_dir_all(&bogus).unwrap();
        let root = bogus.canonicalize().unwrap();

        let file_str = file.to_str().unwrap();
        assert!(resolve_workspace_path_with_mode(&root, file_str, Some("Local")).is_ok());
        assert!(resolve_workspace_path_with_mode(&root, file_str, Some("Review")).is_ok());

        let resolved = resolve_workspace_path_with_mode(&root, file_str, Some("Full"))
            .expect("all modes accept absolute path; Full shown here for compatibility");
        assert_eq!(resolved, file.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&bogus);
    }

    #[test]
    fn all_modes_allow_parent_traversal() {
        let outer_dir = unique_tempdir("full_parent");
        let _ = std::fs::remove_dir_all(&outer_dir);
        std::fs::create_dir_all(&outer_dir).unwrap();
        let sub = outer_dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let outside = outer_dir.join("outside.md");
        std::fs::write(&outside, "outside").unwrap();
        let root = sub.canonicalize().unwrap();

        assert!(resolve_workspace_path_with_mode(&root, "../outside.md", None).is_ok());
        assert!(resolve_workspace_path_with_mode(&root, "../outside.md", Some("Local")).is_ok());
        assert!(resolve_workspace_path_with_mode(&root, "../outside.md", Some("Review")).is_ok());

        let resolved = resolve_workspace_path_with_mode(&root, "../outside.md", Some("Full"))
            .expect("all modes accept parent traversal; Full shown here for compatibility");
        assert_eq!(resolved, outside.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&outer_dir);
    }

    #[test]
    fn existing_workspace_dir_accepts_absolute_in_all_modes() {
        let (dir, _) = make_dir_with_file("existing_full", "anything.txt", "");
        let bogus = std::env::current_dir().unwrap();
        let resolved = resolve_existing_workspace_dir(&bogus, dir.to_str().unwrap(), Some("Full"))
            .expect("absolute dir accepted");
        assert_eq!(resolved, dir.canonicalize().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_run_full_mode_reads_absolute_outside_workspace() {
        let (skill_dir, skill_file) = make_dir_with_file("agent_full", "SKILL.md", "skill body");
        let bogus = unique_tempdir("agent_full_root");
        let _ = std::fs::remove_dir_all(&bogus);
        std::fs::create_dir_all(&bogus).unwrap();
        let root = bogus.canonicalize().unwrap();
        unsafe {
            std::env::set_var("ZEUS_WORKSPACE_DIR", &root);
        }
        let result = run_agent_task(
            AgentRunRequest {
                objective: "read absolute path in full mode".to_string(),
                workspace_dir: None,
                steps: vec![AgentStepRequest::ReadFile {
                    path: skill_file.to_string_lossy().into_owned(),
                    max_bytes: None,
                }],
                approved: false,
                approval_id: None,
                max_correction_steps: None,
                stop_on_error: true,
                prior_failures: 0,
            },
            Some("Full"),
        );
        unsafe {
            std::env::remove_var("ZEUS_WORKSPACE_DIR");
        }
        assert!(
            result.completed,
            "Full mode should read the absolute path; logs: {:?}",
            result.logs
        );
        let AgentStepResult::ReadFile(read) = &result.logs[0].result else {
            panic!("expected ReadFile, got {:?}", result.logs[0].result)
        };
        assert!(read.content.contains("skill body"));
        let _ = std::fs::remove_dir_all(&skill_dir);
        let _ = std::fs::remove_dir_all(&bogus);
    }

    #[test]
    fn agent_run_local_mode_reads_absolute_outside_workspace() {
        let (skill_dir, skill_file) = make_dir_with_file("agent_locked", "SKILL.md", "skill body");
        let bogus = unique_tempdir("agent_locked_root");
        let _ = std::fs::remove_dir_all(&bogus);
        std::fs::create_dir_all(&bogus).unwrap();
        let root = bogus.canonicalize().unwrap();
        unsafe {
            std::env::set_var("ZEUS_WORKSPACE_DIR", &root);
        }
        let result = run_agent_task(
            AgentRunRequest {
                objective: "read absolute path in local mode".to_string(),
                workspace_dir: None,
                steps: vec![AgentStepRequest::ReadFile {
                    path: skill_file.to_string_lossy().into_owned(),
                    max_bytes: None,
                }],
                approved: false,
                approval_id: None,
                max_correction_steps: None,
                stop_on_error: true,
                prior_failures: 0,
            },
            Some("Local"),
        );
        unsafe {
            std::env::remove_var("ZEUS_WORKSPACE_DIR");
        }
        assert!(result.completed, "Local mode should also read absolute paths while workspace limits are disabled; logs: {:?}", result.logs);
        let AgentStepResult::ReadFile(read) = &result.logs[0].result else {
            panic!("expected ReadFile, got {:?}", result.logs[0].result)
        };
        assert!(read.content.contains("skill body"));
        let _ = std::fs::remove_dir_all(&skill_dir);
        let _ = std::fs::remove_dir_all(&bogus);
    }
}
