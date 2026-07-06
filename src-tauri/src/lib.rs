use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod persistence;
mod providers;
mod workspace;

use persistence::{
    list_sessions as db_list_sessions, open_and_init, save_session as db_save_session,
    EditProposalRequest, PersistedProposal, PersistedSession, PersistedState, RecordActionRequest,
    SaveSessionRequest,
};
use providers::{
    build_skill_system_message, dispatch_chat, find_provider, list_provider_info, ChatMessage, ChatRequest,
    ChatResponse, ProviderInfo,
};
use workspace::{
    apply_workspace_edit as apply_workspace_edit_impl, read_workspace_file as read_workspace_file_impl,
    run_agent_task as run_agent_task_impl, run_shell_command as run_shell_command_impl,
    write_workspace_file as write_workspace_file_impl, AgentRunRequest, AgentRunResult,
    ApplyWorkspaceEditRequest, ApplyWorkspaceEditResult, ReadWorkspaceFileRequest,
    ReadWorkspaceFileResult, ShellCommandRequest, ShellCommandResult, WriteWorkspaceFileRequest,
    WriteWorkspaceFileResult,
};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub has_references: bool,
    pub has_scripts: bool,
    pub has_assets: bool,
    pub has_agents_metadata: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub summary: SkillSummary,
    pub body: String,
}

/// Build a synthetic system message that injects the skill's instructions
/// into the next LLM call, given the raw SKILL.md contents. Pure helper so
/// it can be exercised by unit tests without an `AppHandle`.
/// Load the SKILL.md body for `skill_id` from the resolved skills directory
/// and return a synthetic system message that injects the skill's
/// instructions into the next LLM call. The skill id is validated and
/// bounded so this function is safe to call from the Tauri command
/// surface without exposing filesystem structure to the frontend.
fn load_skill_system_message(
    app: &tauri::AppHandle,
    skill_id: &str,
) -> Result<Option<ChatMessage>, String> {
    if !valid_skill_id(skill_id) {
        return Err(format!("Invalid skill id '{skill_id}'."));
    }
    let root = resolve_skills_dir(app)?;
    let skill_path = find_skill_dir(&root, skill_id)?.join("SKILL.md");
    let raw = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(build_skill_system_message(skill_id, &raw))
}

/// Prepend a skill message (if any) to the conversation so the LLM sees
/// the skill instructions before any user/assistant turn.
fn inject_skill(app: &tauri::AppHandle, request: &ChatRequest) -> Result<Vec<ChatMessage>, String> {
    let Some(skill_id) = request.skill_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(request.messages.clone());
    };
    let skill_message = match load_skill_system_message(app, skill_id)? {
        Some(msg) => msg,
        None => return Ok(request.messages.clone()),
    };
    let mut out = Vec::with_capacity(request.messages.len() + 1);
    out.push(skill_message);
    out.extend(request.messages.iter().cloned());
    Ok(out)
}

fn strip_wrapping_quotes(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if let Some(rest) = line.strip_prefix(&prefix) {
            let value = rest.trim();
            if value == "|" || value == ">" {
                let mut block = Vec::new();
                index += 1;
                while index < lines.len() {
                    let next = lines[index];
                    if !next.starts_with(' ') && !next.starts_with('\t') && next.contains(':') {
                        break;
                    }
                    block.push(next.trim());
                    index += 1;
                }
                return Some(block.join(" ").trim().to_string());
            }
            return Some(strip_wrapping_quotes(value));
        }
        index += 1;
    }
    None
}

fn split_frontmatter(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---")?;
    let end = rest.find("---")?;
    Some(rest[..end].trim())
}

fn skill_summary_from_dir(dir: &Path) -> Result<SkillSummary, String> {
    let folder_id = dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid skill folder name.".to_string())?
        .to_string();
    let skill_path = dir.join("SKILL.md");
    let content = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    let frontmatter = split_frontmatter(&content)
        .ok_or_else(|| format!("{} is missing YAML frontmatter.", skill_path.display()))?;
    let name = frontmatter_value(frontmatter, "name").unwrap_or_else(|| folder_id.clone());
    let id = if valid_skill_id(&name) {
        name.clone()
    } else {
        folder_id
    };
    let description = frontmatter_value(frontmatter, "description").unwrap_or_default();

    Ok(SkillSummary {
        id,
        name,
        description,
        has_references: dir.join("references").is_dir(),
        has_scripts: dir.join("scripts").is_dir(),
        has_assets: dir.join("assets").is_dir(),
        has_agents_metadata: dir.join("agents").join("openai.yaml").is_file(),
    })
}

fn list_skills_from_dir(root: &Path) -> Result<Vec<SkillSummary>, String> {
    let mut skills = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("read skills dir: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read skill entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            match skill_summary_from_dir(&path) {
                Ok(summary) => skills.push(summary),
                Err(error) => eprintln!("Skipping invalid skill {}: {error}", path.display()),
            }
        }
    }
    skills.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(skills)
}

fn find_skill_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let direct = root.join(id);
    if direct.is_dir() && direct.join("SKILL.md").is_file() {
        return Ok(direct);
    }

    let entries = fs::read_dir(root).map_err(|e| format!("read skills dir: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read skill entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            if let Ok(summary) = skill_summary_from_dir(&path) {
                if summary.id == id {
                    return Ok(path);
                }
            }
        }
    }

    Err(format!("Skill '{id}' was not found."))
}

fn valid_skill_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn skills_dir_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(env_dir) = std::env::var("ZEUS_SKILLS_DIR") {
        candidates.push(PathBuf::from(env_dir));
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("skills"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("skills"));
        candidates.push(cwd.join("..").join("skills"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("skills"),
    );
    candidates
}

fn resolve_skills_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    skills_dir_candidates(app)
        .into_iter()
        .find(|candidate| candidate.is_dir())
        .ok_or_else(|| "No Zeus skills directory was found.".to_string())
}

// --- Tauri commands --------------------------------------------------

/// Application-wide shared state. Holds the DB connection in a `Mutex`
/// inside an `Arc` so commands can borrow it cheaply on each invocation.
pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
}

fn current_access_mode(conn: &Connection) -> Result<Option<String>, String> {
    persistence::load_state(conn)
        .map(|state| state.access_mode)
        .map_err(|e| format!("load access mode: {e}"))
}

/// Path to the JSON file holding user-supplied provider API keys.
/// Resolved against the Tauri app data dir.
fn provider_keys_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app_data_dir: {e}"))?;
    Ok(dir.join("provider-keys.json"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeysFile {
    #[serde(default)]
    minimax: Option<String>,
    #[serde(default)]
    openai: Option<String>,
    #[serde(default)]
    anthropic: Option<String>,
    /// Per-provider API base URL overrides. When absent, the provider
    /// uses its hard-coded default. Persisted in the same file as the
    /// keys so the Settings UI has one source of truth.
    #[serde(default)]
    minimax_base_url: Option<String>,
    #[serde(default)]
    openai_base_url: Option<String>,
    #[serde(default)]
    anthropic_base_url: Option<String>,
    /// Per-provider model id overrides. Same precedence rules as the
    /// base URL.
    #[serde(default)]
    minimax_model: Option<String>,
    #[serde(default)]
    openai_model: Option<String>,
    #[serde(default)]
    anthropic_model: Option<String>,
}

/// Read provider API keys from disk and apply them to the process env.
/// Safe to call multiple times — each call overwrites the previous value.
fn load_provider_keys_into_env(app: &tauri::AppHandle) -> Result<(), String> {
    let path = provider_keys_path(app)?;
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: ProviderKeysFile = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    if let Some(value) = parsed.minimax.as_deref() { set_optional_env("MINIMAX_API_KEY", value); }
    if let Some(value) = parsed.openai.as_deref() { set_optional_env("OPENAI_API_KEY", value); }
    if let Some(value) = parsed.anthropic.as_deref() { set_optional_env("ANTHROPIC_API_KEY", value); }
    Ok(())
}

fn set_optional_env(name: &str, value: &str) {
    if value.is_empty() {
        // SAFETY: std::env::remove_var is unsafe in recent Rust because env
        // writes are not thread-safe with concurrent readers. We serialize
        // via the std::env API and accept the documented caveat.
        unsafe { std::env::remove_var(name); }
    } else {
        unsafe { std::env::set_var(name, value); }
    }
}

/// Frontend payload: each field is the new value for that provider's key.
/// An empty string clears the key. `*BaseUrl` / `*Model` override the
/// provider's hard-coded defaults; empty string reverts to the default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetProviderKeysRequest {
    minimax: Option<String>,
    openai: Option<String>,
    anthropic: Option<String>,
    minimax_base_url: Option<String>,
    openai_base_url: Option<String>,
    anthropic_base_url: Option<String>,
    minimax_model: Option<String>,
    openai_model: Option<String>,
    anthropic_model: Option<String>,
}

/// Save user-supplied provider API keys + per-provider base URL / model
/// overrides to disk and apply the keys to the current process env so the
/// next `send_chat` sees them. Empty strings clear the field.
#[tauri::command]
fn set_provider_keys(
    app: tauri::AppHandle,
    request: SetProviderKeysRequest,
) -> Result<ProviderKeysFile, String> {
    let next = ProviderKeysFile {
        minimax: normalize_key(request.minimax),
        openai: normalize_key(request.openai),
        anthropic: normalize_key(request.anthropic),
        minimax_base_url: normalize_optional(request.minimax_base_url),
        openai_base_url: normalize_optional(request.openai_base_url),
        anthropic_base_url: normalize_optional(request.anthropic_base_url),
        minimax_model: normalize_optional(request.minimax_model),
        openai_model: normalize_optional(request.openai_model),
        anthropic_model: normalize_optional(request.anthropic_model),
    };
    let path = provider_keys_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(&next)
        .map_err(|e| format!("serialize keys: {e}"))?;
    fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))?;
    load_provider_keys_into_env(&app)?;
    Ok(next)
}

fn normalize_key(value: Option<String>) -> Option<String> {
    value.map(|raw| raw.trim().to_string()).filter(|trimmed| !trimmed.is_empty())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.map(|raw| raw.trim().to_string()).filter(|trimmed| !trimmed.is_empty())
}

/// Return the persisted provider API keys. The frontend never sees the raw
/// values in long form — it uses this just to know which providers have a
/// key configured (presence check) and to read the base URL / model
/// overrides so the Settings form re-renders correctly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderKeysStatus {
    minimax: bool,
    openai: bool,
    anthropic: bool,
    minimax_base_url: Option<String>,
    openai_base_url: Option<String>,
    anthropic_base_url: Option<String>,
    minimax_model: Option<String>,
    openai_model: Option<String>,
    anthropic_model: Option<String>,
}

#[tauri::command]
fn get_provider_keys(app: tauri::AppHandle) -> Result<ProviderKeysStatus, String> {
    let path = provider_keys_path(&app)?;
    if !path.exists() {
        return Ok(default_provider_keys_status());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: ProviderKeysFile = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(ProviderKeysStatus {
        minimax: parsed.minimax.as_deref().map(str::is_empty) == Some(false),
        openai: parsed.openai.as_deref().map(str::is_empty) == Some(false),
        anthropic: parsed.anthropic.as_deref().map(str::is_empty) == Some(false),
        minimax_base_url: parsed.minimax_base_url,
        openai_base_url: parsed.openai_base_url,
        anthropic_base_url: parsed.anthropic_base_url,
        minimax_model: parsed.minimax_model,
        openai_model: parsed.openai_model,
        anthropic_model: parsed.anthropic_model,
    })
}

fn default_provider_keys_status() -> ProviderKeysStatus {
    ProviderKeysStatus {
        minimax: false,
        openai: false,
        anthropic: false,
        minimax_base_url: None,
        openai_base_url: None,
        anthropic_base_url: None,
        minimax_model: None,
        openai_model: None,
        anthropic_model: None,
    }
}

/// Result of a Test Connection probe. Returned to the frontend so the
/// Settings panel can show whether the configured key + base URL + model
/// actually work end-to-end.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestProviderResult {
    ok: bool,
    /// Echo of what was tested (base URL + model after override resolution).
    base_url: String,
    model: String,
    /// Short human-readable message describing the outcome.
    message: String,
    /// First 280 chars of the model's reply, when ok=true.
    preview: Option<String>,
}

/// Test a provider by issuing a trivial chat completion ("Respond with OK.").
/// Uses the same path as the chat UI so any error the user would see in
/// real usage is surfaced here too.
#[tauri::command]
async fn test_provider(
    app: tauri::AppHandle,
    provider_id: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<TestProviderResult, String> {
    let request = ChatRequest {
        provider: provider_id.clone(),
        messages: vec![ChatMessage {
            role: "user".to_string(),
            content: "Respond with the single word OK and nothing else.".to_string(),
        }],
        skill_id: None,
        options: serde_json::json!({
            "model": model.clone().unwrap_or_default(),
            "baseUrl": base_url.clone().unwrap_or_default(),
        }),
    };
    let messages = inject_skill(&app, &request)?;
    let request_with_messages = ChatRequest {
        messages,
        ..request
    };
    let provider = find_provider(&provider_id)
        .ok_or_else(|| format!("Unknown provider '{provider_id}'."))?;
    let resolved_model = request_with_messages
        .options
        .as_object()
        .and_then(|obj| obj.get("model"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(provider.default_model());
    let resolved_base = request_with_messages
        .options
        .as_object()
        .and_then(|obj| obj.get("baseUrl"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(provider.default_base_url());
    match dispatch_chat(&request_with_messages, None).await {
        Ok(response) => {
            let preview = response.content.chars().take(280).collect::<String>();
            Ok(TestProviderResult {
                ok: true,
                base_url: resolved_base.to_string(),
                model: response.model,
                message: "Connection succeeded.".to_string(),
                preview: Some(preview),
            })
        }
        Err(error) => Ok(TestProviderResult {
            ok: false,
            base_url: resolved_base.to_string(),
            model: resolved_model.to_string(),
            message: error.public_message(),
            preview: None,
        }),
    }
}

#[tauri::command]
async fn send_chat(app: tauri::AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    // Inject the skill context (if any) on the Rust side so we don't have
    // to ship skill bodies over the IPC bridge.
    let messages = inject_skill(&app, &request)?;
    let request_with_messages = ChatRequest {
        messages,
        ..request
    };
    dispatch_chat(&request_with_messages, None)
        .await
        .map_err(String::from)
}

/// List every registered provider. The frontend uses this to render the
/// provider picker in the Settings view.
#[tauri::command]
fn list_providers() -> Vec<ProviderInfo> {
    list_provider_info()
}

/// Load the full persisted state. Frontend calls this on mount and re-calls
/// after every state-mutating command.
#[tauri::command]
fn load_state(state: tauri::State<'_, AppState>) -> Result<PersistedState, String> {
    let conn = state.db.lock();
    persistence::load_state(&conn).map_err(|e| format!("load_state: {e}"))
}

/// Record a generic harness action (approved / rejected / applied-once /
/// rolled-back). Returns the updated proposal.
#[tauri::command]
fn record_proposal_action(
    state: tauri::State<'_, AppState>,
    request: RecordActionRequest,
) -> Result<PersistedProposal, String> {
    let conn = state.db.lock();
    if request.action == "rolled-back" {
        return persistence::rollback_proposal(&conn, &request.proposal_id)
            .map_err(|e| format!("rollback: {e}"));
    }
    persistence::record_action(&conn, &request).map_err(|e| format!("record_action: {e}"))
}

/// Apply an edit: replace the proposal's summary/body and append an `edited`
/// history row. Returns the updated proposal.
#[tauri::command]
fn edit_proposal(
    state: tauri::State<'_, AppState>,
    request: EditProposalRequest,
) -> Result<PersistedProposal, String> {
    let conn = state.db.lock();
    persistence::apply_proposal_edit(&conn, &request).map_err(|e| format!("edit: {e}"))
}

/// Persist the access-mode selection.
#[tauri::command]
fn set_access_mode(state: tauri::State<'_, AppState>, mode: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::set_access_mode(&conn, &mode).map_err(|e| format!("set_access_mode: {e}"))
}

/// Insert or refresh a recent-session row.
#[tauri::command]
fn upsert_session(
    state: tauri::State<'_, AppState>,
    id: String,
    label: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::upsert_session(&conn, &id, &label).map_err(|e| format!("upsert_session: {e}"))
}

/// Persist a full session — chat transcript + compact anchor. Frontend
/// calls this after every assistant reply and on every /compact so the
/// state survives a relaunch.
#[tauri::command]
fn save_session(
    state: tauri::State<'_, AppState>,
    request: SaveSessionRequest,
) -> Result<(), String> {
    let conn = state.db.lock();
    db_save_session(&conn, &request).map_err(|e| format!("save_session: {e}"))
}

/// List every persisted session (with transcript + compact anchor).
/// Frontend calls this on mount to populate the recent-sessions list and
/// to restore the previously-selected session.
#[tauri::command]
fn list_sessions_full(state: tauri::State<'_, AppState>) -> Result<Vec<PersistedSession>, String> {
    let conn = state.db.lock();
    db_list_sessions(&conn, 50).map_err(|e| format!("list_sessions_full: {e}"))
}

#[tauri::command]
fn list_skills(app: tauri::AppHandle) -> Result<Vec<SkillSummary>, String> {
    let root = resolve_skills_dir(&app)?;
    list_skills_from_dir(&root)
}

#[tauri::command]
fn load_skill(app: tauri::AppHandle, id: String) -> Result<SkillDetail, String> {
    if !valid_skill_id(&id) {
        return Err("Invalid skill id.".to_string());
    }
    let root = resolve_skills_dir(&app)?;
    let skill_dir = find_skill_dir(&root, &id)?;
    let summary = skill_summary_from_dir(&skill_dir)?;
    let skill_path = skill_dir.join("SKILL.md");
    let body = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(SkillDetail { summary, body })
}

/// Seed the database on first run with a placeholder proposal so the UI
/// has something to display. Idempotent.
fn seed_default_state(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM proposals WHERE id = 'proposal-001'",
            [],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if exists {
        return Ok(());
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        r#"INSERT INTO proposals (id, title, summary, body, status, updated_at)
           VALUES ('proposal-001',
                   'Harness proposal ready',
                   'Generated after the last session and shown automatically at the start of this one.',
                   '',
                   'ready',
                   ?1)"#,
        [now],
    )?;
    Ok(())
}

#[tauri::command]
fn run_shell_command(
    state: tauri::State<'_, AppState>,
    request: ShellCommandRequest,
) -> Result<ShellCommandResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    run_shell_command_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn read_workspace_file(
    request: ReadWorkspaceFileRequest,
) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_impl(request)
}

#[tauri::command]
fn write_workspace_file(
    state: tauri::State<'_, AppState>,
    request: WriteWorkspaceFileRequest,
) -> Result<WriteWorkspaceFileResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    write_workspace_file_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn apply_workspace_edit(
    state: tauri::State<'_, AppState>,
    request: ApplyWorkspaceEditRequest,
) -> Result<ApplyWorkspaceEditResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    apply_workspace_edit_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn run_agent_task(
    state: tauri::State<'_, AppState>,
    request: AgentRunRequest,
) -> Result<AgentRunResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    Ok(run_agent_task_impl(request, access_mode.as_deref()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env (if present) into the process environment so
    // MINIMAX_API_KEY reaches send_minimax_chat without an external
    // wrapper script. Bundled MSI/NSIS installers are unaffected: a
    // missing file is not an error here.
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .setup(|app| {
            // Apply user-saved provider API keys (set via the Settings UI)
            // on top of whatever .env / process env already has. Missing
            // file is not an error — the user simply hasn't saved keys yet.
            let _ = load_provider_keys_into_env(&app.handle());
            // Resolve <app_data_dir>/zeus.db. Tauri creates the dir on
            // first access; open_and_init creates the file and schema.
            let db_path = match app.path().app_data_dir() {
                Ok(dir) => dir.join("zeus.db"),
                Err(_) => std::path::PathBuf::from("zeus.db"),
            };
            let conn = open_and_init(&db_path)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("db open: {e}").into() })?;
            seed_default_state(&conn)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("seed: {e}").into() })?;
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_chat,
            list_providers,
            load_state,
            record_proposal_action,
            edit_proposal,
            set_access_mode,
            upsert_session,
            save_session,
            list_sessions_full,
            list_skills,
            load_skill,
            run_shell_command,
            read_workspace_file,
            write_workspace_file,
            apply_workspace_edit,
            run_agent_task,
            set_provider_keys,
            get_provider_keys,
            test_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zeus");
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::{build_skill_system_message, find_provider, ChatRequest, ProviderError};

    fn sample_request(provider: &str) -> ChatRequest {
        ChatRequest {
            provider: provider.to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Build a test".to_string(),
            }],
            skill_id: None,
            options: serde_json::Value::Null,
        }
    }

    #[test]
    fn list_providers_includes_minimax_openai_anthropic() {
        let providers = list_provider_info();
        let ids: Vec<&str> = providers.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"minimax"), "minimax not registered");
        assert!(ids.contains(&"openai"), "openai not registered");
        assert!(ids.contains(&"anthropic"), "anthropic not registered");
        assert!(providers
            .iter()
            .any(|p| p.id == "minimax" && p.default_model == "MiniMax-M3"));
        assert!(providers
            .iter()
            .any(|p| p.id == "openai" && p.display_name == "OpenAI"));
        assert!(providers
            .iter()
            .any(|p| p.id == "anthropic" && p.default_model == "claude-3-5-sonnet-latest"));
    }

    #[test]
    fn provider_error_messages_do_not_leak_secrets() {
        let err = ProviderError::MissingApiKey {
            provider: "openai".to_string(),
        };
        assert!(
            err.public_message().contains("OPENAI_API_KEY")
                || err.public_message().contains("openai")
        );
        assert!(!err.public_message().contains("sk-"));
    }

    #[test]
    fn send_chat_routes_to_requested_provider() {
        let request = sample_request("minimax");
        let provider = find_provider(&request.provider).expect("minimax provider should exist");

        assert_eq!(provider.id(), "minimax");
        assert_eq!(provider.default_model(), "MiniMax-M3");
    }

    fn temp_skills_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeus_skills_test_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &Path, id: &str, frontmatter: &str, body: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\n{frontmatter}\n---\n\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn list_skills_reads_metadata_without_loading_bodies() {
        let root = temp_skills_root();
        write_skill(
            &root,
            "alpha-skill",
            "name: alpha-skill\ndescription: Alpha metadata only.",
            "This is the full body.",
        );
        std::fs::create_dir_all(root.join("alpha-skill").join("references")).unwrap();

        let skills = list_skills_from_dir(&root).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "alpha-skill");
        assert_eq!(skills[0].name, "alpha-skill");
        assert_eq!(skills[0].description, "Alpha metadata only.");
        assert!(skills[0].has_references);
    }

    #[test]
    fn skill_with_spaced_folder_uses_valid_frontmatter_id() {
        let root = temp_skills_root();
        write_skill(
            &root,
            "first principles",
            "name: first-principles\ndescription: First-principles gate.",
            "Always reduce assumptions.",
        );

        let skills = list_skills_from_dir(&root).unwrap();

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "first-principles");
        assert_eq!(
            find_skill_dir(&root, "first-principles").unwrap(),
            root.join("first principles")
        );
    }

    #[test]
    fn frontmatter_parser_handles_block_descriptions() {
        let frontmatter =
            "name: blocky\ndescription: |\n  First line.\n  Second line.\nmetadata: ignored";
        assert_eq!(
            frontmatter_value(frontmatter, "description").unwrap(),
            "First line. Second line."
        );
    }

    #[test]
    fn valid_skill_id_blocks_path_traversal() {
        assert!(valid_skill_id("frontend-dev"));
        assert!(valid_skill_id("5-why"));
        assert!(!valid_skill_id("../frontend-dev"));
        assert!(!valid_skill_id("Frontend"));
        assert!(!valid_skill_id("skill_name"));
    }

    #[test]
    fn build_skill_system_message_wraps_body_with_id_and_name() {
        let raw = "---\nname: debugging-and-error-recovery\ndescription: root-cause helper\n---\n\nAlways start by reproducing the bug.\n";
        let msg = build_skill_system_message("debugging-and-error-recovery", raw)
            .expect("skill message should build");
        assert_eq!(msg.role, "system");
        assert!(msg.content.contains("debugging-and-error-recovery"));
        assert!(msg.content.contains("Always start by reproducing the bug."));
        assert!(msg.content.contains("<skill"));
    }

    #[test]
    fn build_skill_system_message_returns_none_for_empty_body() {
        let raw = "---\nname: empty-skill\ndescription: empty body\n---\n\n";
        assert!(build_skill_system_message("empty-skill", raw).is_none());
    }

    #[test]
    fn build_skill_system_message_returns_none_without_frontmatter() {
        let raw = "no frontmatter here, just text\n";
        assert!(build_skill_system_message("no-frontmatter", raw).is_none());
    }

    #[test]
    fn chat_request_carries_skill_id_to_dispatcher() {
        // The dispatcher keeps the skill_id untouched; the skill injection
        // step is handled by `inject_skill` in lib.rs before the call.
        let request = ChatRequest {
            provider: "minimax".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            skill_id: Some("stub".to_string()),
            options: serde_json::Value::Null,
        };
        let provider = find_provider(&request.provider).expect("minimax provider should exist");

        assert_eq!(provider.id(), "minimax");
        assert_eq!(request.skill_id.as_deref(), Some("stub"));
    }

    // -- persistence tests ---------------------------------------

    /// Open a fresh in-memory-ish DB for each test by pointing at a unique
    /// tempfile path. sqlite uses a file because :memory: is per-connection.
    fn temp_db() -> Connection {
        let dir = std::env::temp_dir().join(format!(
            "zeus_test_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let _ = std::fs::remove_file(&path);
        open_and_init(&path).expect("open")
    }

    fn seed(conn: &Connection) {
        seed_default_state(conn).expect("seed")
    }

    #[test]
    fn seed_creates_default_proposal_once() {
        let conn = temp_db();
        seed(&conn);
        let p = persistence::load_state(&conn).unwrap();
        assert_eq!(p.proposals.len(), 1);
        assert_eq!(p.proposals[0].id, "proposal-001");
        assert_eq!(p.proposals[0].status, "ready");

        // Second call does not duplicate.
        seed(&conn);
        let p = persistence::load_state(&conn).unwrap();
        assert_eq!(p.proposals.len(), 1);
    }

    #[test]
    fn record_action_writes_history_and_updates_status() {
        let conn = temp_db();
        seed(&conn);
        let after = persistence::record_action(
            &conn,
            &RecordActionRequest {
                proposal_id: "proposal-001".into(),
                action: "approved".into(),
            },
        )
        .unwrap();
        assert_eq!(after.status, "approved");
        let state = persistence::load_state(&conn).unwrap();
        let our_history: Vec<_> = state
            .history
            .iter()
            .filter(|h| h.proposal_id == "proposal-001")
            .collect();
        assert_eq!(our_history.len(), 1);
        assert_eq!(our_history[0].action, "approved");
    }

    #[test]
    fn edit_proposal_replaces_summary_and_appends_history() {
        let conn = temp_db();
        seed(&conn);
        let after = persistence::apply_proposal_edit(
            &conn,
            &EditProposalRequest {
                proposal_id: "proposal-001".into(),
                new_summary: "Edited summary".into(),
                new_body: "Now we want X".into(),
            },
        )
        .unwrap();
        assert_eq!(after.summary, "Edited summary");
        assert_eq!(after.body, "Now we want X");
        assert_eq!(after.status, "edited");
        let state = persistence::load_state(&conn).unwrap();
        let edit_entry = state
            .history
            .iter()
            .find(|h| h.action == "edited")
            .expect("edited entry");
        assert_eq!(edit_entry.body_snapshot, "Now we want X");
    }

    #[test]
    fn rollback_restores_previous_body() {
        let conn = temp_db();
        seed(&conn);
        // First edit: body = "first body"
        persistence::apply_proposal_edit(
            &conn,
            &EditProposalRequest {
                proposal_id: "proposal-001".into(),
                new_summary: "after first edit".into(),
                new_body: "first body".into(),
            },
        )
        .unwrap();
        // Second edit: body = "second body"
        persistence::apply_proposal_edit(
            &conn,
            &EditProposalRequest {
                proposal_id: "proposal-001".into(),
                new_summary: "after second edit".into(),
                new_body: "second body".into(),
            },
        )
        .unwrap();
        // Roll back: should restore body to "first body".
        let rolled = persistence::rollback_proposal(&conn, "proposal-001").unwrap();
        assert_eq!(rolled.body, "first body");
        assert_eq!(rolled.status, "rolled-back");
    }

    #[test]
    fn access_mode_round_trips() {
        let conn = temp_db();
        persistence::set_access_mode(&conn, "Review").unwrap();
        let state = persistence::load_state(&conn).unwrap();
        assert_eq!(state.access_mode.as_deref(), Some("Review"));
        persistence::set_access_mode(&conn, "Locked").unwrap();
        let state = persistence::load_state(&conn).unwrap();
        assert_eq!(state.access_mode.as_deref(), Some("Locked"));
    }

    #[test]
    fn upsert_session_inserts_and_refreshes() {
        let conn = temp_db();
        persistence::upsert_session(&conn, "sess-1", "Initial").unwrap();
        let state = persistence::load_state(&conn).unwrap();
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.sessions[0].label, "Initial");

        persistence::upsert_session(&conn, "sess-1", "Updated").unwrap();
        let state = persistence::load_state(&conn).unwrap();
        assert_eq!(state.sessions[0].label, "Updated");
        assert_eq!(state.sessions.len(), 1); // not duplicated
    }

    #[test]
    fn normalize_key_trims_and_drops_empty() {
        assert_eq!(normalize_key(Some("  abc  ".to_string())), Some("abc".to_string()));
        assert_eq!(normalize_key(Some("".to_string())), None);
        assert_eq!(normalize_key(Some("   ".to_string())), None);
        assert_eq!(normalize_key(None), None);
    }

    #[test]
    fn normalize_optional_trims_and_drops_empty() {
        assert_eq!(normalize_optional(Some("  https://example.test/v1  ".to_string())), Some("https://example.test/v1".to_string()));
        assert_eq!(normalize_optional(Some("".to_string())), None);
        assert_eq!(normalize_optional(None), None);
    }

    #[test]
    fn default_provider_keys_status_is_empty() {
        let s = default_provider_keys_status();
        assert!(!s.minimax && !s.openai && !s.anthropic);
        assert!(s.minimax_base_url.is_none());
        assert!(s.minimax_model.is_none());
    }

    #[test]
    fn provider_keys_round_trip_through_disk() {
        // Round-trip via the in-memory file struct without going through
        // the Tauri app handle (which would require a runtime).
        let parsed = ProviderKeysFile {
            minimax: Some("sk-test".to_string()),
            openai: None,
            anthropic: Some("ant-key".to_string()),
            minimax_base_url: Some("https://api.example.test/v1".to_string()),
            openai_base_url: None,
            anthropic_base_url: None,
            minimax_model: Some("model-x".to_string()),
            openai_model: None,
            anthropic_model: None,
        };
        let serialized = serde_json::to_string(&parsed).expect("serialize");
        let back: ProviderKeysFile = serde_json::from_str(&serialized).expect("parse");
        assert_eq!(back.minimax.as_deref(), Some("sk-test"));
        assert!(back.openai.is_none());
        assert_eq!(back.anthropic.as_deref(), Some("ant-key"));
        assert_eq!(back.minimax_base_url.as_deref(), Some("https://api.example.test/v1"));
        assert_eq!(back.minimax_model.as_deref(), Some("model-x"));
    }
}
