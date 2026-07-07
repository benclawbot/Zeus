use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::agent_runtime::{
    approval_for_steps, AgentRuntimeService, AgentRuntimeStatus, ApprovalCheck,
    ApprovalStatus, BrowserToolRequest, BrowserToolResult, CodeSearchHit, CodeSearchRequest,
    MemoryHit, PendingApproval, ProjectMemory, RiskClass, RuntimePlan, RuntimeSession,
};
use crate::code_intelligence::{self, CodeSearchHit as CodeIntelHit, TestImpact};
use crate::github_workflow::{
    self, CiFixPlan, CiStatusRequest, CommitRequest, CommitResult, CreateBranchRequest,
    CreateBranchResult, CreatePullRequestRequest, PullRequestDetail, PullRequestInfo,
    ReadPullRequestRequest, WorkflowLogRequest, WorkflowLog,
};
use crate::memory as memory_mod;
use crate::patch::{self, ApplyPatchRequest, ApplyPatchResult};
use crate::validation::{self, ValidationRequest, ValidationResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRuntimeSessionRequest {
    pub id: String,
    pub project_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefineRuntimePlanRequest {
    pub session_id: String,
    pub objective: String,
    pub steps: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApprovalRequest {
    pub session_id: String,
    pub objective: String,
    pub action_labels: Vec<String>,
    pub affected_files: Vec<String>,
    pub risk_class: RiskClass,
    pub diff_preview: Option<String>,
    pub commands: Option<Vec<String>>,
    pub rollback_plan: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveApprovalRequest {
    pub id: String,
    pub status: ApprovalStatus,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveMemoriesRequest {
    pub project_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWiringHealth {
    pub ok: bool,
    pub registered_commands: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalCheckResult {
    pub status: String,
    pub approved: bool,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckApprovalRequest {
    pub id: String,
    /// True when the caller intends to consume this one-shot approval
    /// immediately. Session-wide approvals ignore this flag.
    #[serde(default)]
    pub consume_one_shot: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectMemoriesRequest {
    pub project_id: String,
    pub query: String,
    pub file_path: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectMemoriesResult {
    pub prompt_fragment: String,
    pub hits: Vec<memory_mod::MemoryHit>,
}

fn runtime(app: &tauri::AppHandle) -> Result<AgentRuntimeService, String> {
    app.try_state::<AgentRuntimeService>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "AgentRuntimeService was not managed by the Tauri app.".to_string())
}

fn memory_store(app: &tauri::AppHandle) -> Result<memory_mod::MemoryStore, String> {
    let runtime = runtime(app)?;
    let path = runtime.script_path().parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::env::temp_dir());
    let store_path = path.join("agent-memory.json");
    memory_mod::MemoryStore::load_or_create(store_path)
}

#[tauri::command]
pub fn agent_runtime_health() -> RuntimeWiringHealth {
    RuntimeWiringHealth {
        ok: true,
        registered_commands: vec![
            "agent_runtime_status",
            "agent_runtime_open_session",
            "agent_runtime_define_plan",
            "agent_runtime_create_approval",
            "agent_runtime_list_approvals",
            "agent_runtime_resolve_approval",
            "agent_runtime_browser_tool",
            "agent_runtime_upsert_memory",
            "agent_runtime_retrieve_memories",
            "agent_runtime_search_code",
            "agent_runtime_check_approval",
            "agent_runtime_apply_patch",
            "agent_runtime_suggest_tests",
            "agent_runtime_dependency_graph",
            "agent_runtime_run_validation",
            "agent_runtime_github_create_branch",
            "agent_runtime_github_commit",
            "agent_runtime_github_create_pr",
            "agent_runtime_github_read_pr",
            "agent_runtime_github_ci_status",
            "agent_runtime_github_fix_ci",
        ],
    }
}

#[tauri::command]
pub fn agent_runtime_status(app: tauri::AppHandle) -> Result<AgentRuntimeStatus, String> {
    Ok(runtime(&app)?.status())
}

#[tauri::command]
pub fn agent_runtime_open_session(app: tauri::AppHandle, request: OpenRuntimeSessionRequest) -> Result<RuntimeSession, String> {
    runtime(&app)?.open_session(request.id, request.project_id, request.label)
}

#[tauri::command]
pub fn agent_runtime_define_plan(app: tauri::AppHandle, request: DefineRuntimePlanRequest) -> Result<RuntimePlan, String> {
    runtime(&app)?.define_plan(&request.session_id, request.objective, request.steps)
}

#[tauri::command]
pub fn agent_runtime_create_approval(app: tauri::AppHandle, request: CreateApprovalRequest) -> Result<PendingApproval, String> {
    let mut approval = approval_for_steps(
        request.session_id,
        request.objective,
        request.action_labels,
        request.affected_files,
        request.risk_class,
        request.diff_preview,
    );
    approval.commands = request.commands.unwrap_or_default();
    approval.rollback_plan = request.rollback_plan.unwrap_or_default();
    runtime(&app)?.create_approval(approval)
}

#[tauri::command]
pub fn agent_runtime_list_approvals(app: tauri::AppHandle, session_id: Option<String>) -> Result<Vec<PendingApproval>, String> {
    Ok(runtime(&app)?.list_pending_approvals(session_id.as_deref()))
}

#[tauri::command]
pub fn agent_runtime_resolve_approval(app: tauri::AppHandle, id: String, status: ApprovalStatus, note: Option<String>) -> Result<PendingApproval, String> {
    runtime(&app)?.resolve_approval(&id, status, note)
}

#[tauri::command]
pub fn agent_runtime_check_approval(app: tauri::AppHandle, request: CheckApprovalRequest) -> Result<ApprovalCheckResult, String> {
    let status = runtime(&app)?.check_approval(&request.id, request.consume_one_shot);
    let (label, approved, message) = match status {
        ApprovalCheck::Valid => ("valid", true, "Approval is valid for one execution.".to_string()),
        ApprovalCheck::SessionWide => ("session-wide", true, "Approval is valid for the rest of the session.".to_string()),
        ApprovalCheck::AlreadyConsumed => ("already-consumed", false, "This approval has already been used.".to_string()),
        ApprovalCheck::Unknown => ("unknown", false, "No approval matches the supplied id.".to_string()),
        ApprovalCheck::NotApproved => ("not-approved", false, "Approval was rejected or never approved.".to_string()),
    };
    Ok(ApprovalCheckResult { status: label.to_string(), approved, message })
}

#[tauri::command]
pub fn agent_runtime_browser_tool(app: tauri::AppHandle, request: BrowserToolRequest) -> Result<BrowserToolResult, String> {
    runtime(&app)?.browser_tool(request)
}

#[tauri::command]
pub fn agent_runtime_upsert_memory(app: tauri::AppHandle, memory: ProjectMemory) -> Result<ProjectMemory, String> {
    runtime(&app)?.upsert_memory(memory)
}

#[tauri::command]
pub fn agent_runtime_retrieve_memories(app: tauri::AppHandle, project_id: String, query: String, limit: Option<usize>) -> Result<Vec<MemoryHit>, String> {
    Ok(runtime(&app)?.retrieve_memories(&project_id, &query, limit.unwrap_or(5)))
}

#[tauri::command]
pub fn agent_runtime_retrieve_memories_request(app: tauri::AppHandle, request: RetrieveMemoriesRequest) -> Result<Vec<MemoryHit>, String> {
    Ok(runtime(&app)?.retrieve_memories(&request.project_id, &request.query, request.limit.unwrap_or(5)))
}

#[tauri::command]
pub fn agent_runtime_search_code(request: CodeSearchRequest) -> Result<Vec<CodeSearchHit>, String> {
    // Re-route to the richer code-intelligence module: it owns the
    // symbol index, dep graph, and test-impact analysis that the
    // original `search_code` stub lacked.
    let max = request.max_results.max(1);
    let seen = request.seen_files.into_iter().collect::<std::collections::HashSet<_>>();
    let root = std::path::PathBuf::from(&request.root);
    let mut cache = code_intelligence::SymbolCache::default();
    cache.ensure(&root).map_err(|e| format!("build symbol index: {e}"))?;
    let hits = code_intelligence::search(&cache.index, &request.query, &seen, max);
    Ok(hits.into_iter().map(|h| CodeSearchHit {
        path: h.path,
        line: h.line,
        snippet: h.snippet,
        symbol: h.symbol,
        kind: h.kind,
        score: h.score,
        already_read: h.already_read,
    }).collect())
}

#[tauri::command]
pub fn agent_runtime_apply_patch(request: ApplyPatchRequest) -> Result<ApplyPatchResult, String> {
    let parsed = patch::parse_patch(&request.patch)?;
    let base_dir = std::path::PathBuf::from(&request.base_dir);
    patch::apply_patch(&parsed, &base_dir)
}

#[tauri::command]
pub fn agent_runtime_suggest_tests(workspace_dir: Option<String>, files: Vec<String>) -> Result<TestImpact, String> {
    let root = std::path::PathBuf::from(workspace_dir.unwrap_or_else(|| ".".to_string()));
    Ok(code_intelligence::suggest_tests(&root, &files))
}

#[tauri::command]
pub fn agent_runtime_dependency_graph(workspace_dir: String) -> Result<Vec<code_intelligence::DependencyNode>, String> {
    code_intelligence::build_dependency_graph(std::path::Path::new(&workspace_dir))
}

#[tauri::command]
pub fn agent_runtime_run_validation(request: ValidationRequest) -> Result<ValidationResult, String> {
    validation::run_validation(request)
}

#[tauri::command]
pub fn agent_runtime_github_create_branch(request: CreateBranchRequest) -> Result<CreateBranchResult, String> {
    github_workflow::create_branch(request)
}

#[tauri::command]
pub fn agent_runtime_github_commit(request: CommitRequest) -> Result<CommitResult, String> {
    github_workflow::commit_staged(request)
}

#[tauri::command]
pub fn agent_runtime_github_create_pr(request: CreatePullRequestRequest) -> Result<PullRequestInfo, String> {
    github_workflow::create_pull_request(request)
}

#[tauri::command]
pub fn agent_runtime_github_read_pr(request: ReadPullRequestRequest) -> Result<PullRequestDetail, String> {
    github_workflow::read_pull_request(request)
}

#[tauri::command]
pub fn agent_runtime_github_ci_status(request: CiStatusRequest) -> Result<github_workflow::CiStatus, String> {
    github_workflow::read_ci_status(request)
}

#[tauri::command]
pub fn agent_runtime_github_fix_ci(workspace_dir: Option<String>) -> Result<CiFixPlan, String> {
    github_workflow::fix_failing_ci(workspace_dir.as_deref())
}

#[tauri::command]
pub fn agent_runtime_github_workflow_log(request: WorkflowLogRequest) -> Result<WorkflowLog, String> {
    github_workflow::read_workflow_log(request)
}

#[tauri::command]
pub fn agent_runtime_upsert_memory_v2(app: tauri::AppHandle, memory: memory_mod::Memory) -> Result<memory_mod::Memory, String> {
    memory_store(&app)?.upsert(memory)
}

#[tauri::command]
pub fn agent_runtime_retrieve_memories_v2(app: tauri::AppHandle, request: RetrieveMemoriesRequest) -> Result<Vec<memory_mod::MemoryHit>, String> {
    Ok(memory_store(&app)?.retrieve(&memory_mod::RetrievalContext {
        project_id: request.project_id,
        query: request.query,
        file_path: None,
        tags: Vec::new(),
        limit: request.limit.unwrap_or(5),
    }))
}

#[tauri::command]
pub fn agent_runtime_inject_memories(app: tauri::AppHandle, request: InjectMemoriesRequest) -> Result<InjectMemoriesResult, String> {
    let store = memory_store(&app)?;
    let hits = store.retrieve(&memory_mod::RetrievalContext {
        project_id: request.project_id,
        query: request.query.clone(),
        file_path: request.file_path.clone(),
        tags: Vec::new(),
        limit: request.limit.unwrap_or(5),
    });
    let prompt_fragment = memory_mod::build_injection(&hits);
    Ok(InjectMemoriesResult { prompt_fragment, hits })
}

// Compile-time sanity: make sure unused imports don't sneak in.
#[allow(dead_code)]
fn _type_anchor(_: CodeIntelHit) {}