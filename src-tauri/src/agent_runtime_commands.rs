use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::agent_runtime::{
    approval_for_steps, search_code, AgentRuntimeService, AgentRuntimeStatus, ApprovalStatus,
    BrowserToolRequest, BrowserToolResult, CodeSearchHit, CodeSearchRequest, MemoryHit,
    PendingApproval, ProjectMemory, RiskClass, RuntimePlan, RuntimeSession,
};

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

fn runtime(app: &tauri::AppHandle) -> Result<AgentRuntimeService, String> {
    app.try_state::<AgentRuntimeService>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "AgentRuntimeService was not managed by the Tauri app.".to_string())
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
    let approval = approval_for_steps(
        request.session_id,
        request.objective,
        request.action_labels,
        request.affected_files,
        request.risk_class,
        request.diff_preview,
    );
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
    search_code(request)
}
