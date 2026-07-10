//! Rust-native agent engine foundation inspired by Pi's harness shape.
//!
//! This module is intentionally usable now: it exposes a typed tool manifest
//! and a batch tool executor that routes through Zeus' real guarded Rust
//! backends. The provider-native turn loop will build on these types instead
//! of the frontend fenced-tool parser owning orchestration.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::code_intelligence;
use crate::patch;
use crate::workspace::{
    self, ApplyWorkspaceEditRequest, GitOperationRequest, ListWorkspaceDirRequest,
    ProjectConfigRequest, ReadWorkspaceFileRequest, ShellCommandRequest, TestRunRequest,
    WriteWorkspaceFileRequest,
};

pub const ENGINE_VERSION: &str = "pi-rust-foundation-1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnginePhase {
    Idle,
    Turn,
    ApprovalBlocked,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EngineEventType {
    AgentStart,
    AgentEnd,
    TurnStart,
    TurnEnd,
    MessageStart,
    MessageUpdate,
    MessageEnd,
    ToolExecutionStart,
    ToolExecutionUpdate,
    ToolExecutionEnd,
    ApprovalRequested,
    SavePoint,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineToolManifest {
    pub name: &'static str,
    pub label: &'static str,
    pub risk_class: &'static str,
    pub execution_mode: ToolExecutionMode,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpMilestone {
    pub id: &'static str,
    pub title: &'static str,
    pub outcome: &'static str,
    pub files: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineHealth {
    pub ok: bool,
    pub version: &'static str,
    pub phase: EnginePhase,
    pub workspace_limits_disabled: bool,
    pub filesystem_scope: &'static str,
    pub events: Vec<EngineEventType>,
    pub tools: Vec<EngineToolManifest>,
    pub next_implementation: Vec<FollowUpMilestone>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineToolCall {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineToolBatchRequest {
    pub objective: String,
    pub workspace_dir: Option<String>,
    pub calls: Vec<AgentEngineToolCall>,
    #[serde(default)]
    pub approved: bool,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub approval_session_id: Option<String>,
    #[serde(default)]
    pub stop_on_error: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineToolResult {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub content: String,
    pub details: Value,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEngineToolBatchResult {
    pub version: &'static str,
    pub objective: String,
    pub completed: bool,
    pub workspace_limits_disabled: bool,
    pub results: Vec<AgentEngineToolResult>,
    pub files_touched: Vec<String>,
    pub diff: String,
    pub summary: String,
}

pub fn health() -> AgentEngineHealth {
    AgentEngineHealth {
        ok: true,
        version: ENGINE_VERSION,
        phase: EnginePhase::Idle,
        workspace_limits_disabled: true,
        filesystem_scope: "unrestricted: absolute paths and parent traversal are allowed; workspaceDir is only a relative-path anchor",
        events: vec![
            EngineEventType::AgentStart,
            EngineEventType::AgentEnd,
            EngineEventType::TurnStart,
            EngineEventType::TurnEnd,
            EngineEventType::MessageStart,
            EngineEventType::MessageUpdate,
            EngineEventType::MessageEnd,
            EngineEventType::ToolExecutionStart,
            EngineEventType::ToolExecutionUpdate,
            EngineEventType::ToolExecutionEnd,
            EngineEventType::ApprovalRequested,
            EngineEventType::SavePoint,
            EngineEventType::Settled,
        ],
        tools: tool_manifest(),
        next_implementation: follow_up_plan(),
    }
}

pub fn tool_manifest() -> Vec<EngineToolManifest> {
    vec![
        EngineToolManifest { name: "listDir", label: "List directory", risk_class: "readOnly", execution_mode: ToolExecutionMode::Parallel, description: "List any directory. Absolute paths are accepted." },
        EngineToolManifest { name: "readFile", label: "Read file", risk_class: "readOnly", execution_mode: ToolExecutionMode::Parallel, description: "Read any text/binary-ish file as UTF-8-lossy text with truncation." },
        EngineToolManifest { name: "searchCode", label: "Search code", risk_class: "readOnly", execution_mode: ToolExecutionMode::Parallel, description: "Build Zeus' symbol index under a root and return ranked hits." },
        EngineToolManifest { name: "loadProjectConfig", label: "Load project config", risk_class: "readOnly", execution_mode: ToolExecutionMode::Parallel, description: "Discover package/project config from a root." },
        EngineToolManifest { name: "writeFile", label: "Write file", risk_class: "localWrite", execution_mode: ToolExecutionMode::Sequential, description: "Create or overwrite a file through Zeus' diff-producing writer." },
        EngineToolManifest { name: "editFile", label: "Edit file", risk_class: "localWrite", execution_mode: ToolExecutionMode::Sequential, description: "Targeted find/replace edit through Zeus' workspace editor." },
        EngineToolManifest { name: "applyPatch", label: "Apply patch", risk_class: "localWrite", execution_mode: ToolExecutionMode::Sequential, description: "Transactional multi-file unified diff application." },
        EngineToolManifest { name: "runCommand", label: "Run command", risk_class: "shell", execution_mode: ToolExecutionMode::Sequential, description: "Run a local command with Zeus output capture and secret redaction." },
        EngineToolManifest { name: "gitOp", label: "Git operation", risk_class: "shell", execution_mode: ToolExecutionMode::Sequential, description: "Run git in a chosen directory through the existing Git wrapper." },
        EngineToolManifest { name: "runTest", label: "Run tests", risk_class: "shell", execution_mode: ToolExecutionMode::Sequential, description: "Run configured project tests and parse pass/fail counts." },
        EngineToolManifest { name: "webSearch", label: "Web search", risk_class: "network", execution_mode: ToolExecutionMode::Parallel, description: "Search DuckDuckGo and return ranked title + URL + snippet hits for autonomous research." },
    ]
}

pub fn follow_up_plan() -> Vec<FollowUpMilestone> {
    vec![
        FollowUpMilestone {
            id: "provider-native-tool-calls",
            title: "Provider-native tool calls",
            outcome: "Replace frontend fenced tool parsing with provider-emitted structured tool calls and streamed engine events.",
            files: vec!["src-tauri/src/providers/mod.rs", "src-tauri/src/providers/*.rs", "src-tauri/src/engine/model.rs", "src-tauri/src/engine/loop.rs"],
        },
        FollowUpMilestone {
            id: "durable-session-tree",
            title: "Durable session tree",
            outcome: "Persist Pi-style append-only messages, tool runs, approvals, queues, save points, and interrupted operations in SQLite.",
            files: vec!["src-tauri/src/persistence.rs", "src-tauri/src/engine/session_log.rs", "src-tauri/src/engine/recovery.rs"],
        },
        FollowUpMilestone {
            id: "approval-single-gate",
            title: "Approval as the only gate",
            outcome: "Create and consume session-bound approvals before any risky tool execution.",
            files: vec!["src-tauri/src/agent_runtime.rs", "src-tauri/src/engine/approval_gate.rs", "src-tauri/src/workspace.rs"],
        },
        FollowUpMilestone {
            id: "frontend-engine-switch",
            title: "Frontend engine switch",
            outcome: "Render engine events directly, replace registry.ts observe/replan loop, and add approval continuation.",
            files: vec!["src/providers/registry.ts", "src/providers/agentEngine.ts", "src/state/harness.ts", "src/components/ToolRunPanel.tsx"],
        },
        FollowUpMilestone {
            id: "compaction-branching-recovery",
            title: "Compaction, branching, recovery",
            outcome: "Add Pi-style turn snapshots, compaction summaries, branch summaries, crash recovery, and retry-safe tool policies.",
            files: vec!["src-tauri/src/engine/harness.rs", "src-tauri/src/engine/compaction.rs", "src-tauri/src/engine/recovery.rs"],
        },
    ]
}

pub fn execute_tool_batch(
    request: AgentEngineToolBatchRequest,
    access_mode: Option<&str>,
) -> AgentEngineToolBatchResult {
    let mut results = Vec::new();
    let mut files_touched = Vec::new();
    let mut diffs = Vec::new();
    let mut completed = true;

    for (index, call) in request.calls.iter().enumerate() {
        let id = call
            .id
            .clone()
            .unwrap_or_else(|| format!("tool-{}", index + 1));
        let result = execute_one_tool(&id, call, &request, access_mode);
        if !result.ok {
            completed = false;
        }
        if let Some(path) = result.details.get("fileTouched").and_then(Value::as_str) {
            files_touched.push(path.to_string());
        }
        if let Some(diff) = result
            .details
            .get("diff")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
        {
            diffs.push(diff.to_string());
        }
        let should_stop = request.stop_on_error && !result.ok;
        results.push(result);
        if should_stop {
            break;
        }
    }

    files_touched.sort();
    files_touched.dedup();
    AgentEngineToolBatchResult {
        version: ENGINE_VERSION,
        objective: request.objective,
        completed,
        workspace_limits_disabled: true,
        summary: format!(
            "Executed {} engine tool call{} with unrestricted filesystem path resolution.",
            results.len(),
            if results.len() == 1 { "" } else { "s" }
        ),
        results,
        files_touched,
        diff: diffs.join("\n"),
    }
}

fn execute_one_tool(
    id: &str,
    call: &AgentEngineToolCall,
    batch: &AgentEngineToolBatchRequest,
    access_mode: Option<&str>,
) -> AgentEngineToolResult {
    match run_tool(call, batch, access_mode) {
        Ok((content, details)) => AgentEngineToolResult {
            id: id.to_string(),
            name: call.name.clone(),
            ok: true,
            content,
            details,
            is_error: false,
        },
        Err(message) => AgentEngineToolResult {
            id: id.to_string(),
            name: call.name.clone(),
            ok: false,
            content: message.clone(),
            details: json!({ "error": message }),
            is_error: true,
        },
    }
}

fn run_tool(
    call: &AgentEngineToolCall,
    batch: &AgentEngineToolBatchRequest,
    access_mode: Option<&str>,
) -> Result<(String, Value), String> {
    match call.name.as_str() {
        "listDir" | "list_dir" => {
            let path = string_arg(&call.args, "path").unwrap_or_else(|| ".".to_string());
            let max_entries = usize_arg(&call.args, "maxEntries");
            let out = workspace::list_workspace_dir(
                ListWorkspaceDirRequest {
                    path,
                    workspace_dir: workspace_dir(&call.args, batch),
                    max_entries,
                },
                access_mode,
            )?;
            Ok((
                format!("listed {} entries under {}", out.entries.len(), out.path),
                json!(out),
            ))
        }
        "readFile" | "read_file" => {
            let path = required_string_arg(&call.args, "path")?;
            let max_bytes = usize_arg(&call.args, "maxBytes");
            let out = workspace::read_workspace_file(
                ReadWorkspaceFileRequest {
                    path,
                    workspace_dir: workspace_dir(&call.args, batch),
                    max_bytes,
                },
                access_mode,
            )?;
            Ok((
                format!("read {} bytes from {}", out.bytes_read, out.path),
                json!(out),
            ))
        }
        "writeFile" | "write_file" => {
            let path = required_string_arg(&call.args, "path")?;
            let content = required_string_arg(&call.args, "content")?;
            let out = workspace::write_workspace_file(
                WriteWorkspaceFileRequest {
                    path,
                    workspace_dir: workspace_dir(&call.args, batch),
                    content,
                    create: bool_arg(&call.args, "create", true),
                    overwrite: bool_arg(&call.args, "overwrite", true),
                    expected_text: string_arg(&call.args, "expectedText"),
                    approved: batch.approved,
                    approval_id: batch.approval_id.clone(),
                    approval_session_id: batch.approval_session_id.clone(),
                },
                access_mode,
            )?;
            Ok((
                format!("wrote {} bytes to {}", out.bytes_written, out.path),
                json!({ "fileTouched": out.path, "diff": out.diff, "result": out }),
            ))
        }
        "editFile" | "edit_file" => {
            let path = required_string_arg(&call.args, "path")?;
            let find = required_string_arg(&call.args, "find")?;
            let replace = required_string_arg(&call.args, "replace")?;
            let out = workspace::apply_workspace_edit(
                ApplyWorkspaceEditRequest {
                    path,
                    workspace_dir: workspace_dir(&call.args, batch),
                    find,
                    replace,
                    replace_all: bool_arg(&call.args, "replaceAll", false),
                    approved: batch.approved,
                    approval_id: batch.approval_id.clone(),
                    approval_session_id: batch.approval_session_id.clone(),
                },
                access_mode,
            )?;
            Ok((
                format!("edited {} replacement(s) in {}", out.replacements, out.path),
                json!({ "fileTouched": out.path, "diff": out.diff, "result": out }),
            ))
        }
        "applyPatch" | "apply_patch" => {
            let patch_text = required_string_arg(&call.args, "patch")?;
            let base_dir = string_arg(&call.args, "baseDir")
                .or_else(|| workspace_dir(&call.args, batch))
                .unwrap_or_else(|| ".".to_string());
            let parsed = patch::parse_patch(&patch_text)?;
            let out = patch::apply_patch(&parsed, &PathBuf::from(base_dir))?;
            let touched = out.files_touched.join(", ");
            Ok((
                format!("patch applied: {}", out.message),
                json!({ "fileTouched": touched, "result": out }),
            ))
        }
        "runCommand" | "run_command" => {
            let program = required_string_arg(&call.args, "program")?;
            let args = string_list_arg(&call.args, "args");
            let out = workspace::run_shell_command(
                ShellCommandRequest {
                    program,
                    args,
                    cwd: string_arg(&call.args, "cwd"),
                    workspace_dir: workspace_dir(&call.args, batch),
                    timeout_ms: u64_arg(&call.args, "timeoutMs"),
                    approved: batch.approved,
                    approval_id: batch.approval_id.clone(),
                    approval_session_id: batch.approval_session_id.clone(),
                },
                access_mode,
            )?;
            Ok((
                format!("command exited {:?}: {}", out.exit_code, out.program),
                json!(out),
            ))
        }
        "gitOp" | "git_op" => {
            let args = string_list_arg(&call.args, "args");
            let out = workspace::run_git_operation(
                GitOperationRequest {
                    workspace_dir: workspace_dir(&call.args, batch),
                    args,
                    timeout_ms: u64_arg(&call.args, "timeoutMs"),
                    approved: batch.approved,
                    approval_id: batch.approval_id.clone(),
                    approval_session_id: batch.approval_session_id.clone(),
                },
                access_mode,
            )?;
            Ok((format!("git exited {:?}", out.exit_code), json!(out)))
        }
        "runTest" | "run_test" => {
            let args = string_list_arg(&call.args, "args");
            let out = workspace::run_project_test(
                TestRunRequest {
                    workspace_dir: workspace_dir(&call.args, batch),
                    args,
                    timeout_ms: u64_arg(&call.args, "timeoutMs"),
                },
                access_mode,
            )?;
            Ok((
                format!(
                    "tests exited {:?}: passed={}, failed={}",
                    out.exit_code, out.passed_count, out.failed_count
                ),
                json!(out),
            ))
        }
        "loadProjectConfig" | "load_project_config" => {
            let out = workspace::load_project_config(
                ProjectConfigRequest {
                    workspace_dir: workspace_dir(&call.args, batch),
                },
                access_mode,
            )?;
            Ok((format!("loaded project config {}", out.path), json!(out)))
        }
        "searchCode" | "search" | "search_code" => {
            let query = required_string_arg(&call.args, "query")?;
            let root = string_arg(&call.args, "root")
                .or_else(|| workspace_dir(&call.args, batch))
                .unwrap_or_else(|| ".".to_string());
            let max = usize_arg(&call.args, "maxResults")
                .unwrap_or(50)
                .clamp(1, 200);
            let seen = string_list_arg(&call.args, "seenFiles")
                .into_iter()
                .collect::<HashSet<_>>();
            let mut cache = code_intelligence::SymbolCache::default();
            cache
                .ensure(&PathBuf::from(root))
                .map_err(|e| format!("build symbol index: {e}"))?;
            let hits = code_intelligence::search(&cache.index, &query, &seen, max);
            Ok((
                format!("search returned {} hits for {:?}", hits.len(), query),
                json!({ "query": query, "hits": hits }),
            ))
        }
        "webSearch" | "web_search" => {
            let query = required_string_arg(&call.args, "query")?;
            let max_results = usize_arg(&call.args, "maxResults");
            let request = crate::web_search::WebSearchRequest { query, max_results };
            let result = tauri::async_runtime::block_on(crate::web_search::web_search(request))
                .map_err(|e| format!("web search: {e}"))?;
            let summary = format!(
                "web search returned {} hit(s) for {:?}",
                result.hits.len(),
                result.query
            );
            Ok((summary, json!(result)))
        }
        other => Err(format!("Unknown engine tool '{other}'.")),
    }
}

fn workspace_dir(args: &Value, batch: &AgentEngineToolBatchRequest) -> Option<String> {
    string_arg(args, "workspaceDir")
        .or_else(|| string_arg(args, "root"))
        .or_else(|| batch.workspace_dir.clone())
}

fn required_string_arg(args: &Value, name: &str) -> Result<String, String> {
    string_arg(args, name).ok_or_else(|| format!("Missing required string argument '{name}'."))
}

fn string_arg(args: &Value, name: &str) -> Option<String> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_arg(args: &Value, name: &str, default: bool) -> bool {
    args.get(name).and_then(Value::as_bool).unwrap_or(default)
}

fn usize_arg(args: &Value, name: &str) -> Option<usize> {
    args.get(name).and_then(Value::as_u64).map(|v| v as usize)
}

fn u64_arg(args: &Value, name: &str) -> Option<u64> {
    args.get(name).and_then(Value::as_u64)
}

fn string_list_arg(args: &Value, name: &str) -> Vec<String> {
    args.get(name)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    fn temp_root(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let dir = std::env::temp_dir().join(format!("zeus-engine-{name}-{stamp}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn health_reports_unrestricted_filesystem() {
        let health = health();
        assert!(health.ok);
        assert!(health.workspace_limits_disabled);
        assert!(health.tools.iter().any(|tool| tool.name == "readFile"));
        assert!(health
            .next_implementation
            .iter()
            .any(|step| step.id == "provider-native-tool-calls"));
    }

    #[test]
    fn execute_tool_batch_reads_absolute_file_outside_workspace_anchor() {
        let root = temp_root("root");
        let outside = temp_root("outside").join("note.txt");
        fs::write(&outside, "unrestricted read works").unwrap();
        let request = AgentEngineToolBatchRequest {
            objective: "read outside workspace".to_string(),
            workspace_dir: Some(root.to_string_lossy().to_string()),
            calls: vec![AgentEngineToolCall {
                id: Some("read-1".to_string()),
                name: "readFile".to_string(),
                args: json!({ "path": outside.to_string_lossy() }),
            }],
            approved: true,
            approval_id: None,
            approval_session_id: None,
            stop_on_error: true,
        };
        let result = execute_tool_batch(request, Some("Full"));
        assert!(result.completed, "{result:?}");
        assert_eq!(result.results[0].id, "read-1");
        assert!(result.results[0].content.contains("read"));
        assert!(result.results[0].details["content"]
            .as_str()
            .unwrap()
            .contains("unrestricted read works"));
    }

    #[test]
    fn execute_tool_batch_stops_on_unknown_tool_when_requested() {
        let request = AgentEngineToolBatchRequest {
            objective: "bad tool".to_string(),
            workspace_dir: None,
            calls: vec![
                AgentEngineToolCall {
                    id: None,
                    name: "nope".to_string(),
                    args: json!({}),
                },
                AgentEngineToolCall {
                    id: None,
                    name: "listDir".to_string(),
                    args: json!({ "path": "." }),
                },
            ],
            approved: false,
            approval_id: None,
            approval_session_id: None,
            stop_on_error: true,
        };
        let result = execute_tool_batch(request, Some("Full"));
        assert!(!result.completed);
        assert_eq!(result.results.len(), 1);
        assert!(result.results[0].is_error);
    }
}
