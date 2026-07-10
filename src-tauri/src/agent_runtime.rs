// Persistent agent runtime. Owns the project-scoped state that lives
// across invocations: sessions, tool runs, approvals (with one-shot vs
// session-scoped consumption), memories, browser sessions, and the
// long-lived Playwright driver subprocess.
//
// The runtime is intentionally append-mostly: every state mutation is
// persisted to disk so a relaunch can pick up exactly where the agent
// left off. The browser driver is a single child process that this
// service lazily starts on the first browser action and keeps alive
// until the runtime itself is dropped.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(0);

fn next_runtime_id(prefix: &str) -> String {
    let sequence = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}-{}-{sequence}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

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
    /// Free-form command list surfaced to the user as part of the
    /// approval card. Optional — older callers may not populate it.
    #[serde(default)]
    pub commands: Vec<String>,
    /// Auto-generated rollback plan. Optional — older callers may not
    /// populate it.
    #[serde(default)]
    pub rollback_plan: Vec<String>,
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
    pub artifact_path: Option<String>,
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub title: String,
    pub url: String,
    pub body: String,
    pub truncated: bool,
    #[serde(default)]
    pub links: Vec<BrowserLink>,
    #[serde(default)]
    pub fields: Vec<BrowserField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLink {
    pub text: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct BrowserField {
    pub tag: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub placeholder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserToolResult {
    pub provider: String,
    pub session_id: String,
    pub action: String,
    pub ok: bool,
    pub snapshot: Option<BrowserSnapshot>,
    pub artifact: Option<String>,
    pub value: Option<serde_json::Value>,
    pub message: String,
    /// Echoed on test actions so the frontend can show the actual
    /// command that was run.
    pub test_command: Option<String>,
    pub exit_code: Option<i32>,
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
    pub kind: Option<String>,
    pub score: u32,
    pub already_read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Tracks one-shot approvals that have already been consumed. A
    /// second use of the same id returns `ApprovalAlreadyConsumed`.
    #[serde(default)]
    pub consumed_one_shot: HashSet<String>,
    /// Approvals that were resolved as ApprovedForSession so the agent
    /// can reuse them for the rest of the session.
    #[serde(default)]
    pub session_wide: HashSet<String>,
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        let now = now();
        Self {
            server_id: next_runtime_id("runtime"),
            started_at: now,
            sessions: HashMap::new(),
            tool_runs: Vec::new(),
            approvals: Vec::new(),
            memories: Vec::new(),
            browser_sessions: HashMap::new(),
            transcript: Vec::new(),
            consumed_one_shot: HashSet::new(),
            session_wide: HashSet::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalCheck {
    /// The id is valid and has not been used yet.
    Valid,
    /// The id is session-scoped; can be reused freely in the session.
    SessionWide,
    /// The id was already consumed in one-shot mode.
    AlreadyConsumed,
    /// The id is unknown to the runtime.
    Unknown,
    /// The id was rejected or never approved.
    NotApproved,
}

/// Browser driver subprocess wrapper. Spawns the Playwright-backed
/// Node script and exposes a typed `request` method that speaks the
/// driver's JSON-over-stdio protocol.
struct BrowserDriver {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    script_path: PathBuf,
    script_args: Vec<String>,
}

impl BrowserDriver {
    fn spawn(script_path: PathBuf, script_args: Vec<String>) -> Result<Self, String> {
        let mut command = Command::new("node");
        command.arg(&script_path);
        for arg in &script_args {
            command.arg(arg);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("MINIMAX_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("GITHUB_TOKEN")
            .spawn()
            .map_err(|e| format!("spawn browser driver: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "browser driver stdin unavailable".to_string())?;
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| "browser driver stdout unavailable".to_string())?,
        );
        // Wait for the ready line before returning. The driver emits
        // `{"kind":"ready",...}` on startup; we drop it and proceed.
        let mut driver = BrowserDriver {
            child,
            stdin,
            stdout,
            next_id: 1,
            script_path,
            script_args,
        };
        driver.read_ready_line()?;
        Ok(driver)
    }

    fn read_ready_line(&mut self) -> Result<(), String> {
        let mut line = String::new();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            line.clear();
            match self.stdout.read_line(&mut line) {
                Ok(0) => return Err("browser driver exited before becoming ready".to_string()),
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.contains("\"ready\"") {
                        return Ok(());
                    }
                    if trimmed.is_empty() {
                        continue;
                    }
                }
                Err(err) => return Err(format!("read browser driver: {err}")),
            }
        }
        Err("browser driver did not become ready within 10s".to_string())
    }

    fn request(
        &mut self,
        payload: &serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut framed = serde_json::json!({ "id": id });
        if let Some(obj) = payload.as_object() {
            for (k, v) in obj {
                framed[k] = v.clone();
            }
        }
        let serialized = serde_json::to_string(&framed)
            .map_err(|e| format!("serialize browser request: {e}"))?;
        self.stdin
            .write_all(serialized.as_bytes())
            .map_err(|e| format!("write browser driver: {e}"))?;
        self.stdin
            .write_all(b"\n")
            .map_err(|e| format!("write browser driver newline: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush browser driver: {e}"))?;
        let mut line = String::new();
        let started = Instant::now();
        while started.elapsed() < timeout {
            line.clear();
            match self.stdout.read_line(&mut line) {
                Ok(0) => return Err("browser driver closed the connection".to_string()),
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(value) => {
                            if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
                                return Ok(value);
                            }
                            // Not our response — keep reading.
                        }
                        Err(_) => continue,
                    }
                }
                Err(err) => return Err(format!("read browser driver response: {err}")),
            }
        }
        Err("browser driver request timed out".to_string())
    }
}

impl Drop for BrowserDriver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone)]
pub struct AgentRuntimeService {
    state_path: PathBuf,
    state: Arc<Mutex<AgentRuntimeState>>,
    driver: Arc<Mutex<Option<BrowserDriver>>>,
    script_path: PathBuf,
}

impl AgentRuntimeService {
    pub fn load_or_create(path: impl Into<PathBuf>) -> Result<Self, String> {
        Self::load_or_create_with(path, browser_driver_script_path())
    }

    pub fn load_or_create_with(
        path: impl Into<PathBuf>,
        script_path: PathBuf,
    ) -> Result<Self, String> {
        let state_path = path.into();
        let state = if state_path.exists() {
            let raw =
                fs::read_to_string(&state_path).map_err(|e| format!("read runtime state: {e}"))?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            AgentRuntimeState::default()
        };
        Ok(Self {
            state_path,
            state: Arc::new(Mutex::new(state)),
            driver: Arc::new(Mutex::new(None)),
            script_path,
        })
    }

    pub fn script_path(&self) -> &Path {
        &self.script_path
    }

    pub fn status(&self) -> AgentRuntimeStatus {
        let state = self.state.lock();
        AgentRuntimeStatus {
            server_id: state.server_id.clone(),
            started_at: state.started_at.clone(),
            sessions: state.sessions.len(),
            tool_runs: state.tool_runs.len(),
            pending_approvals: state
                .approvals
                .iter()
                .filter(|a| a.status == ApprovalStatus::Pending)
                .count(),
            memories: state
                .memories
                .iter()
                .filter(|m| !m.stale && m.superseded_by.is_none())
                .count(),
            browser_sessions: state.browser_sessions.len(),
        }
    }

    pub fn open_session(
        &self,
        id: String,
        project_id: String,
        label: String,
    ) -> Result<RuntimeSession, String> {
        let mut state = self.state.lock();
        let now = now();
        let session = state
            .sessions
            .entry(id.clone())
            .or_insert_with(|| RuntimeSession {
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

    pub fn define_plan(
        &self,
        session_id: &str,
        objective: String,
        labels: Vec<String>,
    ) -> Result<RuntimePlan, String> {
        let mut state = self.state.lock();
        let session = state
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| format!("Unknown runtime session '{session_id}'."))?;
        let now = now();
        let steps = labels
            .into_iter()
            .enumerate()
            .map(|(index, label)| RuntimePlanStep {
                id: format!("step-{}", index + 1),
                label,
                status: if index == 0 {
                    PlanStatus::InProgress
                } else {
                    PlanStatus::Todo
                },
                depends_on: if index == 0 {
                    Vec::new()
                } else {
                    vec![format!("step-{index}")]
                },
                updated_at: now.clone(),
            })
            .collect::<Vec<_>>();
        let plan = RuntimePlan {
            objective,
            status: PlanStatus::InProgress,
            steps,
            updated_at: now.clone(),
        };
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
        state.transcript.push(format!(
            "{} {} {}",
            run.created_at, run.tool, run.observation
        ));
        state.tool_runs.push(run.clone());
        drop(state);
        self.persist()?;
        Ok(run)
    }

    pub fn create_approval(
        &self,
        mut approval: PendingApproval,
    ) -> Result<PendingApproval, String> {
        if approval.id.trim().is_empty() {
            approval.id = next_runtime_id("approval");
        }
        approval.status = ApprovalStatus::Pending;
        approval.created_at = if approval.created_at.is_empty() {
            now()
        } else {
            approval.created_at
        };
        let mut state = self.state.lock();
        // If the approval already exists (re-submit), keep the original
        // id but refresh the payload.
        if let Some(existing) = state.approvals.iter_mut().find(|a| a.id == approval.id) {
            *existing = approval.clone();
        } else {
            state.approvals.push(approval.clone());
        }
        state.transcript.push(format!(
            "{} approval requested {}",
            approval.created_at, approval.id
        ));
        drop(state);
        self.persist()?;
        Ok(approval)
    }

    pub fn resolve_approval(
        &self,
        id: &str,
        status: ApprovalStatus,
        note: Option<String>,
    ) -> Result<PendingApproval, String> {
        let mut state = self.state.lock();
        let approval = state
            .approvals
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("Unknown approval '{id}'."))?;
        approval.status = status.clone();
        approval.resolved_at = Some(now());
        approval.resolution_note = note;
        let out = approval.clone();
        state.transcript.push(format!(
            "{} approval resolved {} {:?}",
            now(),
            id,
            out.status
        ));
        // Track approval scope so `check_approval` knows when the id is
        // session-wide reusable. Do NOT mark one-shot as consumed here —
        // `check_approval` does that on first use.
        match status {
            ApprovalStatus::ApprovedForSession => {
                state.session_wide.insert(id.to_string());
            }
            _ => {}
        }
        drop(state);
        self.persist()?;
        Ok(out)
    }

    /// Look up an approval id and tell the caller whether it is usable
    /// for an upcoming risky execution. Also marks one-shot approvals
    /// as consumed when `consume_one_shot` is true.
    pub fn check_approval(&self, id: &str, consume_one_shot: bool) -> ApprovalCheck {
        let mut state = self.state.lock();
        if state.session_wide.contains(id) {
            return ApprovalCheck::SessionWide;
        }
        if state.consumed_one_shot.contains(id) {
            return ApprovalCheck::AlreadyConsumed;
        }
        let Some(approval) = state.approvals.iter().find(|a| a.id == id) else {
            return ApprovalCheck::Unknown;
        };
        match approval.status {
            ApprovalStatus::ApprovedForSession => {
                state.session_wide.insert(id.to_string());
                ApprovalCheck::SessionWide
            }
            ApprovalStatus::ApprovedOnce => {
                if consume_one_shot {
                    state.consumed_one_shot.insert(id.to_string());
                }
                ApprovalCheck::Valid
            }
            ApprovalStatus::Rejected => ApprovalCheck::NotApproved,
            ApprovalStatus::Pending => ApprovalCheck::NotApproved,
        }
    }

    pub fn list_pending_approvals(&self, session_id: Option<&str>) -> Vec<PendingApproval> {
        let state = self.state.lock();
        state
            .approvals
            .iter()
            .filter(|item| item.status == ApprovalStatus::Pending)
            .filter(|item| session_id.map(|id| item.session_id == id).unwrap_or(true))
            .cloned()
            .collect()
    }

    pub fn upsert_memory(&self, mut memory: ProjectMemory) -> Result<ProjectMemory, String> {
        if memory.id.trim().is_empty() {
            memory.id = next_runtime_id("memory");
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
        let mut hits = state
            .memories
            .iter()
            .filter(|m| m.project_id == project_id && !m.stale && m.superseded_by.is_none())
            .filter_map(|memory| {
                let mut memory_tokens = tokens(&memory.content);
                for tag in &memory.tags {
                    memory_tokens.extend(tokens(tag));
                }
                let overlap = query_tokens.intersection(&memory_tokens).count() as u32;
                let tag_overlap = query_tokens
                    .intersection(&tokens(&memory.tags.join(" ")))
                    .count() as u32;
                let recency_bonus = if memory.created_at > since(7) {
                    1u32
                } else {
                    0
                };
                let reliability_bonus = 0; // default — richer scoring lives in memory.rs
                let score = overlap * 4 + tag_overlap * 6 + recency_bonus + reliability_bonus;
                (score > 0).then(|| MemoryHit {
                    memory: memory.clone(),
                    score,
                    reason: format!("{overlap} keyword overlap, {tag_overlap} tag overlap"),
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.memory.created_at.cmp(&b.memory.created_at))
        });
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
            value: None,
            message: "Semantic browser provider registered. Supported actions: status, open, snapshot, click, type, screenshot, eval, run_test.".to_string(),
            test_command: None,
            exit_code: None,
        }
    }

    /// Ensure the Playwright-backed driver subprocess is up. Lazily
    /// started on the first real browser action.
    fn ensure_driver(&self) -> Result<(), String> {
        let mut guard = self.driver.lock();
        if guard.is_some() {
            return Ok(());
        }
        let driver = BrowserDriver::spawn(self.script_path.clone(), vec![])?;
        *guard = Some(driver);
        Ok(())
    }

    pub fn browser_tool(&self, request: BrowserToolRequest) -> Result<BrowserToolResult, String> {
        let action = request.action.as_str();
        if action == "status" {
            return Ok(self.browser_status());
        }
        // Spawn / reuse the driver only for real actions.
        if let Err(err) = self.ensure_driver() {
            return Ok(BrowserToolResult {
                provider: "playwright".to_string(),
                session_id: request
                    .session_id
                    .unwrap_or_else(|| "browser-default".to_string()),
                action: action.to_string(),
                ok: false,
                snapshot: None,
                artifact: None,
                value: None,
                message: format!("Browser driver unavailable: {err}"),
                test_command: None,
                exit_code: None,
            });
        }
        let mut guard = self.driver.lock();
        let driver = guard.as_mut().expect("driver was just spawned");
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "browser-default".to_string());
        let mut payload = serde_json::Map::new();
        payload.insert(
            "action".to_string(),
            serde_json::Value::String(action.to_string()),
        );
        payload.insert(
            "sessionId".to_string(),
            serde_json::Value::String(session_id.clone()),
        );
        if let Some(url) = &request.url {
            payload.insert("url".to_string(), serde_json::Value::String(url.clone()));
        }
        if let Some(selector) = &request.selector {
            payload.insert(
                "selector".to_string(),
                serde_json::Value::String(selector.clone()),
            );
        }
        if let Some(text) = &request.text {
            payload.insert("text".to_string(), serde_json::Value::String(text.clone()));
        }
        if let Some(script) = &request.script {
            payload.insert(
                "script".to_string(),
                serde_json::Value::String(script.clone()),
            );
        }
        if let Some(test_command) = &request.test_command {
            payload.insert(
                "testCommand".to_string(),
                serde_json::Value::String(test_command.clone()),
            );
        }
        if let Some(artifact) = &request.artifact_path {
            payload.insert(
                "artifactPath".to_string(),
                serde_json::Value::String(artifact.clone()),
            );
        }
        if let Some(options) = &request.options {
            payload.insert("options".to_string(), options.clone());
        }
        let response =
            match driver.request(&serde_json::Value::Object(payload), Duration::from_secs(60)) {
                Ok(value) => value,
                Err(err) => {
                    // Drop the driver so the next call respawns it.
                    *guard = None;
                    return Ok(BrowserToolResult {
                        provider: "playwright".to_string(),
                        session_id,
                        action: action.to_string(),
                        ok: false,
                        snapshot: None,
                        artifact: None,
                        value: None,
                        message: format!("Browser driver error: {err}"),
                        test_command: None,
                        exit_code: None,
                    });
                }
            };
        let ok = response
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let message = response
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let snapshot = response
            .get("snapshot")
            .and_then(|v| serde_json::from_value::<BrowserSnapshot>(v.clone()).ok());
        let artifact = response
            .get("artifact")
            .and_then(|v| v.as_str())
            .map(String::from);
        let value = response.get("value").cloned();
        let test_command = response
            .get("testCommand")
            .and_then(|v| v.as_str())
            .map(String::from);
        let exit_code = response
            .get("exitCode")
            .and_then(|v| v.as_i64())
            .map(|n| n as i32);
        // Persist a session record so the UI can show the browser state.
        let mut state = self.state.lock();
        let entry = state
            .browser_sessions
            .entry(session_id.clone())
            .or_insert(BrowserSession {
                id: session_id.clone(),
                provider: "playwright".to_string(),
                current_url: snapshot
                    .as_ref()
                    .map(|s| s.url.clone())
                    .filter(|u| !u.is_empty()),
                last_snapshot: snapshot.as_ref().map(|s| s.body.clone()),
                updated_at: now(),
            });
        entry.updated_at = now();
        if let Some(snap) = &snapshot {
            if !snap.url.is_empty() {
                entry.current_url = Some(snap.url.clone());
            }
            entry.last_snapshot = Some(snap.body.clone());
        }
        drop(state);
        let result = BrowserToolResult {
            provider: "playwright".to_string(),
            session_id,
            action: action.to_string(),
            ok,
            snapshot,
            artifact,
            value,
            message: if message.is_empty() {
                if ok {
                    "ok".to_string()
                } else {
                    "failed".to_string()
                }
            } else {
                message
            },
            test_command,
            exit_code,
        };
        let _ = self.persist();
        Ok(result)
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.state_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create runtime state dir: {e}"))?;
        }
        let state = self.state.lock();
        let raw = serde_json::to_string_pretty(&*state)
            .map_err(|e| format!("serialize runtime state: {e}"))?;
        fs::write(&self.state_path, raw).map_err(|e| format!("write runtime state: {e}"))
    }
}

fn tokens(value: &str) -> HashSet<String> {
    value
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(str::to_string)
        .collect()
}

fn since(days: i64) -> String {
    let now = Utc::now();
    let dt = now - chrono::Duration::days(days);
    dt.to_rfc3339()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

/// Best-effort resolution of the browser driver script path. Looks at
/// the workspace's `scripts/zeus-browser-driver.mjs` first, then at the
/// Tauri resource dir, then at the repo-relative path next to Cargo.toml.
fn browser_driver_script_path() -> PathBuf {
    if let Ok(env_path) = std::env::var("ZEUS_BROWSER_DRIVER") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return p;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [
            cwd.join("scripts").join("zeus-browser-driver.mjs"),
            cwd.join("..")
                .join("scripts")
                .join("zeus-browser-driver.mjs"),
        ] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("zeus-browser-driver.mjs")
}

pub fn approval_for_steps(
    session_id: String,
    objective: String,
    labels: Vec<String>,
    files: Vec<String>,
    risk_class: RiskClass,
    diff_preview: Option<String>,
) -> PendingApproval {
    PendingApproval {
        id: next_runtime_id("approval"),
        session_id,
        objective,
        risk_class,
        action_labels: labels,
        affected_files: files,
        diff_preview,
        commands: Vec::new(),
        rollback_plan: Vec::new(),
        status: ApprovalStatus::Pending,
        created_at: now(),
        resolved_at: None,
        resolution_note: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_check_marks_one_shot_as_consumed() {
        let dir = std::env::temp_dir().join(format!(
            "zeus_rt_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime.json");
        let svc =
            AgentRuntimeService::load_or_create_with(&path, browser_driver_script_path()).unwrap();
        let approval = svc
            .create_approval(approval_for_steps(
                "s".into(),
                "obj".into(),
                vec!["label".into()],
                vec![],
                RiskClass::Shell,
                None,
            ))
            .unwrap();
        svc.resolve_approval(&approval.id, ApprovalStatus::ApprovedOnce, None)
            .unwrap();
        assert_eq!(svc.check_approval(&approval.id, true), ApprovalCheck::Valid);
        assert_eq!(
            svc.check_approval(&approval.id, true),
            ApprovalCheck::AlreadyConsumed
        );
    }

    #[test]
    fn approval_check_session_wide_can_be_reused() {
        let dir = std::env::temp_dir().join(format!(
            "zeus_rt_sw_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime.json");
        let svc =
            AgentRuntimeService::load_or_create_with(&path, browser_driver_script_path()).unwrap();
        let approval = svc
            .create_approval(approval_for_steps(
                "s".into(),
                "obj".into(),
                vec!["label".into()],
                vec![],
                RiskClass::Shell,
                None,
            ))
            .unwrap();
        svc.resolve_approval(&approval.id, ApprovalStatus::ApprovedForSession, None)
            .unwrap();
        for _ in 0..3 {
            assert_eq!(
                svc.check_approval(&approval.id, false),
                ApprovalCheck::SessionWide
            );
        }
    }

    #[test]
    fn check_unknown_approval_returns_unknown() {
        let dir = std::env::temp_dir().join(format!(
            "zeus_rt_u_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runtime.json");
        let svc =
            AgentRuntimeService::load_or_create_with(&path, browser_driver_script_path()).unwrap();
        assert_eq!(
            svc.check_approval("does-not-exist", false),
            ApprovalCheck::Unknown
        );
    }
}
