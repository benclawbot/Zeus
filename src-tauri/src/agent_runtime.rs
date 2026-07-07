use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanStatus {
    Todo,
    InProgress,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RiskClass {
    ReadOnly,
    LocalWrite,
    Shell,
    Network,
    Dependency,
    Browser,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalStatus {
    Pending,
    ApprovedOnce,
    Rejected,
    ApprovedForSession,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlanStep {
    pub id: String,
    pub label: String,
    pub status: PlanStatus,
    pub depends_on: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlan {
    pub objective: String,
    pub status: PlanStatus,
    pub steps: Vec<RuntimePlanStep>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSession {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub created_at: String,
    pub updated_at: String,
    pub current_plan: Option<RuntimePlan>,
    pub read_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRunRecord {
    pub id: String,
    pub session_id: String,
    pub tool: String,
    pub label: String,
    pub ok: bool,
    pub risk_class: RiskClass,
    pub files_touched: Vec<String>,
    pub observation: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub session_id: String,
    pub objective: String,
    pub risk_class: RiskClass,
    pub action_labels: Vec<String>,
    pub affected_files: Vec<String>,
    pub diff_preview: Option<String>,
    pub status: ApprovalStatus,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub resolution_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemory {
    pub id: String,
    pub project_id: String,
    pub source: String,
    pub content: String,
    pub tags: Vec<String>,
    pub stale: bool,
    pub superseded_by: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub memory: ProjectMemory,
    pub score: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub id: String,
    pub provider: String,
    pub current_url: Option<String>,
    pub last_snapshot: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolRequest {
    pub action: String,
    pub session_id: Option<String>,
    pub url: Option<String>,
    pub selector: Option<String>,
    pub text: Option<String>,
    pub script: Option<String>,
    pub test_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolResult {
    pub provider: String,
    pub session_id: String,
    pub action: String,
    pub ok: bool,
    pub snapshot: Option<String>,
    pub artifact: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchRequest {
    pub root: String,
    pub query: String,
    pub max_results: usize,
    pub seen_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchHit {
    pub path: String,
    pub line: usize,
    pub snippet: String,
    pub symbol: Option<String>,
    pub already_read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub server_id: String,
    pub started_at: String,
    pub sessions: usize,
    pub tool_runs: usize,
    pub pending_approvals: usize,
    pub memories: usize,
    pub browser_sessions: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeState {
    pub server_id: String,
    pub started_at: String,
    pub sessions: HashMap<String, RuntimeSession>,
    pub tool_runs: Vec<ToolRunRecord>,
    pub approvals: Vec<PendingApproval>,
    pub memories: Vec<ProjectMemory>,
    pub browser_sessions: HashMap<String, BrowserSession>,
    pub transcript: Vec<String>,
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        let now = now();
        Self {
            server_id: format!("runtime-{}", Utc::now().timestamp_millis()),
            started_at: now,
            sessions: HashMap::new(),
            tool_runs: Vec::new(),
            approvals: Vec::new(),
            memories: Vec::new(),
            browser_sessions: HashMap::new(),
            transcript: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct AgentRuntimeService {
    state_path: PathBuf,
    state: Arc<Mutex<AgentRuntimeState>>,
}

impl AgentRuntimeService {
    pub fn load_or_create(path: impl Into<PathBuf>) -> Result<Self, String> {
        let state_path = path.into();
        let state = if state_path.exists() {
            let raw = fs::read_to_string(&state_path).map_err(|e| format!("read runtime state: {e}"))?;
            serde_json::from_str(&raw).map_err(|e| format!("parse runtime state: {e}"))?
        } else {
            AgentRuntimeState::default()
        };
        Ok(Self { state_path, state: Arc::new(Mutex::new(state)) })
    }

    pub fn status(&self) -> AgentRuntimeStatus {
        let state = self.state.lock();
        AgentRuntimeStatus {
            server_id: state.server_id.clone(),
            started_at: state.started_at.clone(),
            sessions: state.sessions.len(),
            tool_runs: state.tool_runs.len(),
            pending_approvals: state.approvals.iter().filter(|a| a.status == ApprovalStatus::Pending).count(),
            memories: state.memories.iter().filter(|m| !m.stale && m.superseded_by.is_none()).count(),
            browser_sessions: state.browser_sessions.len(),
        }
    }

    pub fn open_session(&self, id: String, project_id: String, label: String) -> Result<RuntimeSession, String> {
        let mut state = self.state.lock();
        let now = now();
        let session = state.sessions.entry(id.clone()).or_insert_with(|| RuntimeSession {
            id,
            project_id,
            label: label.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            current_plan: None,
            read_files: Vec::new(),
        });
        session.label = label;
        session.updated_at = now;
        let out = session.clone();
        drop(state);
        self.persist()?;
        Ok(out)
    }

    pub fn define_plan(&self, session_id: &str, objective: String, labels: Vec<String>) -> Result<RuntimePlan, String> {
        let mut state = self.state.lock();
        let session = state.sessions.get_mut(session_id).ok_or_else(|| format!("Unknown runtime session '{session_id}'."))?;
        let now = now();
        let steps = labels.into_iter().enumerate().map(|(index, label)| RuntimePlanStep {
            id: format!("step-{}", index + 1),
            label,
            status: if index == 0 { PlanStatus::InProgress } else { PlanStatus::Todo },
            depends_on: if index == 0 { Vec::new() } else { vec![format!("step-{index}")] },
            updated_at: now.clone(),
        }).collect::<Vec<_>>();
        let plan = RuntimePlan { objective, status: PlanStatus::InProgress, steps, updated_at: now.clone() };
        session.current_plan = Some(plan.clone());
        session.updated_at = now;
        drop(state);
        self.persist()?;
        Ok(plan)
    }

    pub fn record_tool_run(&self, run: ToolRunRecord) -> Result<ToolRunRecord, String> {
        let mut state = self.state.lock();
        if let Some(session) = state.sessions.get_mut(&run.session_id) {
            for file in &run.files_touched {
                if !session.read_files.contains(file) {
                    session.read_files.push(file.clone());
                }
            }
            session.updated_at = now();
        }
        state.transcript.push(format!("{} {} {}", run.created_at, run.tool, run.observation));
        state.tool_runs.push(run.clone());
        drop(state);
        self.persist()?;
        Ok(run)
    }

    pub fn create_approval(&self, mut approval: PendingApproval) -> Result<PendingApproval, String> {
        if approval.id.trim().is_empty() {
            approval.id = format!("approval-{}", Utc::now().timestamp_millis());
        }
        approval.status = ApprovalStatus::Pending;
        approval.created_at = if approval.created_at.is_empty() { now() } else { approval.created_at };
        let mut state = self.state.lock();
        state.approvals.push(approval.clone());
        state.transcript.push(format!("{} approval requested {}", approval.created_at, approval.id));
        drop(state);
        self.persist()?;
        Ok(approval)
    }

    pub fn resolve_approval(&self, id: &str, status: ApprovalStatus, note: Option<String>) -> Result<PendingApproval, String> {
        let mut state = self.state.lock();
        let approval = state.approvals.iter_mut().find(|item| item.id == id).ok_or_else(|| format!("Unknown approval '{id}'."))?;
        approval.status = status;
        approval.resolved_at = Some(now());
        approval.resolution_note = note;
        let out = approval.clone();
        state.transcript.push(format!("{} approval resolved {} {:?}", now(), id, out.status));
        drop(state);
        self.persist()?;
        Ok(out)
    }

    pub fn list_pending_approvals(&self, session_id: Option<&str>) -> Vec<PendingApproval> {
        let state = self.state.lock();
        state.approvals.iter()
            .filter(|item| item.status == ApprovalStatus::Pending)
            .filter(|item| session_id.map(|id| item.session_id == id).unwrap_or(true))
            .cloned()
            .collect()
    }

    pub fn upsert_memory(&self, mut memory: ProjectMemory) -> Result<ProjectMemory, String> {
        if memory.id.trim().is_empty() {
            memory.id = format!("memory-{}", Utc::now().timestamp_millis());
        }
        if memory.created_at.is_empty() {
            memory.created_at = now();
        }
        let mut state = self.state.lock();
        if let Some(existing) = state.memories.iter_mut().find(|item| item.id == memory.id) {
            *existing = memory.clone();
        } else {
            state.memories.push(memory.clone());
        }
        drop(state);
        self.persist()?;
        Ok(memory)
    }

    pub fn retrieve_memories(&self, project_id: &str, query: &str, limit: usize) -> Vec<MemoryHit> {
        let query_tokens = tokens(query);
        let state = self.state.lock();
        let mut hits = state.memories.iter()
            .filter(|m| m.project_id == project_id && !m.stale && m.superseded_by.is_none())
            .filter_map(|memory| {
                let mut memory_tokens = tokens(&memory.content);
                for tag in &memory.tags { memory_tokens.extend(tokens(tag)); }
                let score = query_tokens.intersection(&memory_tokens).count() as u32;
                (score > 0).then(|| MemoryHit {
                    memory: memory.clone(),
                    score,
                    reason: format!("{} shared keyword(s) with current objective", score),
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.memory.created_at.cmp(&b.memory.created_at)));
        hits.truncate(limit.max(1));
        hits
    }

    pub fn browser_status(&self) -> BrowserToolResult {
        BrowserToolResult {
            provider: "playwright".to_string(),
            session_id: "runtime".to_string(),
            action: "status".to_string(),
            ok: true,
            snapshot: None,
            artifact: None,
            message: "Semantic browser provider registered. Supported actions: status, open, snapshot, click, type, screenshot, eval, run_test.".to_string(),
        }
    }

    pub fn browser_tool(&self, request: BrowserToolRequest) -> Result<BrowserToolResult, String> {
        let mut state = self.state.lock();
        let action = request.action.as_str();
        if action == "status" { return Ok(self.browser_status()); }
        let session_id = request.session_id.unwrap_or_else(|| "browser-default".to_string());
        let now = now();
        let session = state.browser_sessions.entry(session_id.clone()).or_insert(BrowserSession {
            id: session_id.clone(),
            provider: "playwright".to_string(),
            current_url: None,
            last_snapshot: None,
            updated_at: now.clone(),
        });
        session.updated_at = now;
        let message = match action {
            "open" => {
                let url = request.url.ok_or_else(|| "browser.open requires url.".to_string())?;
                session.current_url = Some(url.clone());
                session.last_snapshot = Some(format!("Opened {url}; snapshot pending from Playwright adapter."));
                format!("Opened {url}")
            }
            "snapshot" => {
                session.last_snapshot.get_or_insert_with(|| "No DOM snapshot has been captured yet.".to_string());
                "Returned last normalized page snapshot".to_string()
            }
            "click" => format!("Queued click on {}", request.selector.unwrap_or_default()),
            "type" => format!("Queued type into {}", request.selector.unwrap_or_default()),
            "screenshot" => "Queued screenshot capture".to_string(),
            "eval" => "Queued browser eval".to_string(),
            "run_test" => format!("Queued Playwright test command {}", request.test_command.unwrap_or_else(|| "npm run browser:smoke".to_string())),
            other => return Err(format!("Unknown browser action '{other}'.")),
        };
        Ok(BrowserToolResult {
            provider: session.provider.clone(),
            session_id,
            action: action.to_string(),
            ok: true,
            snapshot: session.last_snapshot.clone(),
            artifact: None,
            message,
        })
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create runtime state dir: {e}"))?;
        }
        let state = self.state.lock();
        let raw = serde_json::to_string_pretty(&*state).map_err(|e| format!("serialize runtime state: {e}"))?;
        fs::write(&self.state_path, raw).map_err(|e| format!("write runtime state: {e}"))
    }
}

pub fn search_code(request: CodeSearchRequest) -> Result<Vec<CodeSearchHit>, String> {
    let root = PathBuf::from(&request.root).canonicalize().map_err(|e| format!("resolve search root: {e}"))?;
    let query = request.query.trim().to_lowercase();
    if query.is_empty() { return Err("search_code query must not be empty.".to_string()); }
    let seen = request.seen_files.into_iter().collect::<HashSet<_>>();
    let mut hits = Vec::new();
    visit_files(&root, &root, &query, &seen, request.max_results.max(1), &mut hits)?;
    Ok(hits)
}

fn visit_files(root: &Path, dir: &Path, query: &str, seen: &HashSet<String>, cap: usize, hits: &mut Vec<CodeSearchHit>) -> Result<(), String> {
    if hits.len() >= cap { return Ok(()); }
    for entry in fs::read_dir(dir).map_err(|e| format!("read search dir: {e}"))? {
        if hits.len() >= cap { break; }
        let entry = entry.map_err(|e| format!("read search entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" || name == "dist" { continue; }
        if path.is_dir() {
            visit_files(root, &path, query, seen, cap, hits)?;
        } else if path.is_file() && is_text_candidate(&path) {
            scan_file(root, &path, query, seen, cap, hits)?;
        }
    }
    Ok(())
}

fn scan_file(root: &Path, path: &Path, query: &str, seen: &HashSet<String>, cap: usize, hits: &mut Vec<CodeSearchHit>) -> Result<(), String> {
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
    let raw = match fs::read_to_string(path) { Ok(value) => value, Err(_) => return Ok(()) };
    let mut current_symbol: Option<String> = None;
    for (idx, line) in raw.lines().enumerate() {
        if let Some(symbol) = symbol_from_line(line) { current_symbol = Some(symbol); }
        if line.to_lowercase().contains(query) {
            hits.push(CodeSearchHit {
                path: rel.clone(),
                line: idx + 1,
                snippet: line.trim().chars().take(240).collect(),
                symbol: current_symbol.clone(),
                already_read: seen.contains(&rel),
            });
            if hits.len() >= cap { break; }
        }
    }
    Ok(())
}

fn symbol_from_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    for prefix in ["fn ", "pub fn ", "function ", "export function ", "class ", "export class ", "const ", "let "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return Some(rest.split(|c: char| c == '(' || c == '<' || c == ':' || c == '=' || c.is_whitespace()).next().unwrap_or(rest).to_string());
        }
    }
    None
}

fn is_text_candidate(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "md" | "toml" | "css" | "html" | "py" | "go" | "java" | "kt" | "swift" | "cpp" | "c" | "h")
}

fn tokens(value: &str) -> HashSet<String> {
    value.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(str::to_string)
        .collect()
}

fn now() -> String { Utc::now().to_rfc3339() }

pub fn approval_for_steps(session_id: String, objective: String, labels: Vec<String>, files: Vec<String>, risk_class: RiskClass, diff_preview: Option<String>) -> PendingApproval {
    PendingApproval {
        id: format!("approval-{}", Utc::now().timestamp_millis()),
        session_id,
        objective,
        risk_class,
        action_labels: labels,
        affected_files: files,
        diff_preview,
        status: ApprovalStatus::Pending,
        created_at: now(),
        resolved_at: None,
        resolution_note: None,
    }
}
