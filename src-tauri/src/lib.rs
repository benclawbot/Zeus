use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod agent_runtime;
mod agent_runtime_commands;
mod code_intelligence;
mod github_workflow;
mod memory;
mod patch;
mod persistence;
mod policy;
mod providers;
mod validation;
mod workspace;

use agent_runtime::AgentRuntimeService;
use persistence::{
    list_sessions as db_list_sessions, open_and_init, save_session as db_save_session,
    EditProposalRequest, PersistedProposal, PersistedSession, PersistedState, RecordActionRequest,
    SaveSessionRequest,
};
use providers::{
    build_skill_system_message, dispatch_chat, find_provider, list_provider_info, ChatMessage,
    ChatRequest, ChatResponse, ProviderInfo,
};
use workspace::{
    apply_workspace_edit as apply_workspace_edit_impl,
    list_workspace_dir as list_workspace_dir_impl,
    load_project_config as load_project_config_impl,
    read_workspace_file as read_workspace_file_impl,
    run_agent_task as run_agent_task_impl,
    run_git_operation as run_git_operation_impl,
    run_project_test as run_project_test_impl,
    run_shell_command as run_shell_command_impl,
    write_workspace_file as write_workspace_file_impl,
    AgentRunRequest, AgentRunResult, ApplyWorkspaceEditRequest, ApplyWorkspaceEditResult,
    GitOperationRequest, GitOperationResult, ListWorkspaceDirRequest, ListWorkspaceDirResult,
    ProjectConfigRequest, ProjectConfigResult, ReadWorkspaceFileRequest, ReadWorkspaceFileResult,
    ShellCommandRequest, ShellCommandResult, TestRunRequest, TestRunResult,
    WriteWorkspaceFileRequest, WriteWorkspaceFileResult,
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

fn load_skill_system_message_from_dir(
    skill_dir: &Path,
    skill_id: &str,
) -> Result<Option<ChatMessage>, String> {
    let skill_path = skill_dir.join("SKILL.md");
    let raw = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(build_skill_system_message(skill_id, &raw))
}

/// Prepend explicit or automatically matched skill messages to the
/// conversation so the LLM sees skill instructions before any user/assistant
/// turn. Manual slash-selected skills win; otherwise Zeus chooses a small,
/// high-signal set from the user's request context.
fn inject_skill(app: &tauri::AppHandle, request: &ChatRequest) -> Result<Vec<ChatMessage>, String> {
    let skill_messages =
        if let Some(skill_id) = request.skill_id.as_deref().filter(|s| !s.is_empty()) {
            load_skill_system_message(app, skill_id)?
                .into_iter()
                .collect()
        } else {
            let root = resolve_skills_dir(app)?;
            select_auto_skill_messages(&root, request)?
        };
    if skill_messages.is_empty() {
        return Ok(request.messages.clone());
    }
    let mut out = Vec::with_capacity(request.messages.len() + skill_messages.len());
    out.extend(skill_messages);
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

fn frontmatter_bool(frontmatter: &str, key: &str) -> bool {
    frontmatter_value(frontmatter, key)
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
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

#[derive(Debug, Clone)]
struct SkillIndexEntry {
    summary: SkillSummary,
    dir: PathBuf,
    frontmatter: String,
}

fn skill_index_entry_from_dir(dir: &Path) -> Result<SkillIndexEntry, String> {
    let skill_path = dir.join("SKILL.md");
    let content = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    let frontmatter = split_frontmatter(&content)
        .ok_or_else(|| format!("{} is missing YAML frontmatter.", skill_path.display()))?
        .to_string();
    let summary = skill_summary_from_dir(dir)?;
    Ok(SkillIndexEntry {
        summary,
        dir: dir.to_path_buf(),
        frontmatter,
    })
}

fn collect_skill_dirs(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|e| format!("read skills dir: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read skill entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SKILL.md").is_file() {
            out.push(path);
        } else {
            collect_skill_dirs(&path, out)?;
        }
    }
    Ok(())
}

fn skill_index_from_dir(root: &Path) -> Result<Vec<SkillIndexEntry>, String> {
    let mut dirs = Vec::new();
    collect_skill_dirs(root, &mut dirs)?;
    let mut skills = Vec::new();
    for path in dirs {
        match skill_index_entry_from_dir(&path) {
            Ok(entry) => skills.push(entry),
            Err(error) => tracing::warn!(skill = %path.display(), "Skipping invalid skill: {error}"),
        }
    }
    skills.sort_by(|a, b| a.summary.id.cmp(&b.summary.id));
    Ok(skills)
}

fn list_skills_from_dir(root: &Path) -> Result<Vec<SkillSummary>, String> {
    Ok(skill_index_from_dir(root)?
        .into_iter()
        .map(|entry| entry.summary)
        .collect())
}

fn find_skill_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let direct = root.join(id);
    if direct.is_dir() && direct.join("SKILL.md").is_file() {
        return Ok(direct);
    }

    for entry in skill_index_from_dir(root)? {
        if entry.summary.id == id {
            return Ok(entry.dir);
        }
    }

    Err(format!("Skill '{id}' was not found."))
}

const MAX_AUTO_SKILLS: usize = 3;
const AUTO_SKILL_SCORE_THRESHOLD: i32 = 3;

fn select_auto_skill_messages(
    root: &Path,
    request: &ChatRequest,
) -> Result<Vec<ChatMessage>, String> {
    let context = request_context(request);
    if context.trim().is_empty() {
        return Ok(Vec::new());
    }
    let request_tokens = tokenize(&context);
    if request_tokens.is_empty() {
        return Ok(Vec::new());
    }

    let mut scored = skill_index_from_dir(root)?
        .into_iter()
        .filter(|entry| !frontmatter_bool(&entry.frontmatter, "disable-model-invocation"))
        .filter_map(|entry| {
            let score = auto_skill_score(&entry, &context, &request_tokens);
            (score >= AUTO_SKILL_SCORE_THRESHOLD).then_some((score, entry))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(score_a, skill_a), (score_b, skill_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| skill_a.summary.id.cmp(&skill_b.summary.id))
    });

    let mut out = Vec::new();
    for (_, entry) in scored.into_iter().take(MAX_AUTO_SKILLS) {
        if let Some(message) = load_skill_system_message_from_dir(&entry.dir, &entry.summary.id)? {
            out.push(message);
        }
    }
    Ok(out)
}

fn request_context(request: &ChatRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .filter(|message| message.role == "user")
        .take(3)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn auto_skill_score(
    entry: &SkillIndexEntry,
    context: &str,
    request_tokens: &HashSet<String>,
) -> i32 {
    let normalized_context = normalize_text(context);
    let id_phrase = entry.summary.id.replace('-', " ");
    let name_phrase = entry.summary.name.replace('-', " ");
    let mut score = 0;
    if normalized_context.contains(&id_phrase) {
        score += 8;
    }
    if normalized_context.contains(&name_phrase) && name_phrase != id_phrase {
        score += 8;
    }

    let name_tokens = tokenize(&entry.summary.name);
    let skill_tokens = tokenize(&format!(
        "{} {}",
        entry.summary.name, entry.summary.description
    ));
    for token in request_tokens {
        if name_tokens.contains(token) {
            score += 3;
        } else if skill_tokens.contains(token) {
            score += 2;
        }
    }

    for phrase in quoted_phrases(&entry.summary.description) {
        if normalized_context.contains(&normalize_text(&phrase)) {
            score += 5;
        }
    }

    score
}

fn normalize_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut last_was_space = true;
    for ch in value.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            out.push(' ');
            last_was_space = true;
        }
    }
    out.trim().to_string()
}

fn tokenize(value: &str) -> HashSet<String> {
    normalize_text(value)
        .split_whitespace()
        .filter(|token| token.len() > 2)
        .filter(|token| !auto_skill_stop_words().contains(*token))
        .map(str::to_string)
        .collect()
}

fn quoted_phrases(value: &str) -> Vec<String> {
    let mut phrases = Vec::new();
    let mut start = None;
    for (idx, ch) in value.char_indices() {
        if ch == '"' || ch == '\'' {
            if let Some(open) = start.take() {
                if idx > open + 1 {
                    phrases.push(value[open + 1..idx].to_string());
                }
            } else {
                start = Some(idx);
            }
        }
    }
    phrases
}

fn auto_skill_stop_words() -> HashSet<&'static str> {
    [
        "the",
        "and",
        "for",
        "with",
        "when",
        "user",
        "users",
        "use",
        "uses",
        "using",
        "asks",
        "asked",
        "request",
        "requests",
        "agent",
        "agents",
        "skill",
        "skills",
        "task",
        "work",
        "workflow",
        "create",
        "build",
        "make",
        "write",
        "edit",
        "update",
        "implement",
        "implementation",
        "fix",
        "improve",
        "review",
        "check",
        "change",
        "changes",
        "project",
        "code",
        "file",
        "files",
        "generic",
        "based",
        "needs",
        "before",
        "after",
        "from",
        "into",
        "this",
        "that",
        "they",
        "must",
        "should",
        "could",
        "would",
        "does",
        "done",
    ]
    .into_iter()
    .collect()
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
    let parsed: ProviderKeysFile =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if let Some(value) = parsed.minimax.as_deref() {
        set_optional_env("MINIMAX_API_KEY", value);
    }
    if let Some(value) = parsed.openai.as_deref() {
        set_optional_env("OPENAI_API_KEY", value);
    }
    if let Some(value) = parsed.anthropic.as_deref() {
        set_optional_env("ANTHROPIC_API_KEY", value);
    }
    Ok(())
}

fn set_optional_env(name: &str, value: &str) {
    if value.is_empty() {
        // SAFETY: std::env::remove_var is unsafe in recent Rust because env
        // writes are not thread-safe with concurrent readers. We serialize
        // via the std::env API and accept the documented caveat.
        unsafe {
            std::env::remove_var(name);
        }
    } else {
        unsafe {
            std::env::set_var(name, value);
        }
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
    let serialized =
        serde_json::to_string_pretty(&next).map_err(|e| format!("serialize keys: {e}"))?;
    fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))?;
    load_provider_keys_into_env(&app)?;
    Ok(next)
}

fn normalize_key(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|trimmed| !trimmed.is_empty())
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
    let parsed: ProviderKeysFile =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
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
    let provider =
        find_provider(&provider_id).ok_or_else(|| format!("Unknown provider '{provider_id}'."))?;
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

#[tauri::command]
fn list_workspace_dir(
    request: ListWorkspaceDirRequest,
) -> Result<ListWorkspaceDirResult, String> {
    list_workspace_dir_impl(request)
}

#[tauri::command]
fn load_project_config(
    request: ProjectConfigRequest,
) -> Result<ProjectConfigResult, String> {
    load_project_config_impl(request)
}

#[tauri::command]
fn run_git_operation(
    state: tauri::State<'_, AppState>,
    request: GitOperationRequest,
) -> Result<GitOperationResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    run_git_operation_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn run_project_test(
    state: tauri::State<'_, AppState>,
    request: TestRunRequest,
) -> Result<TestRunResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    run_project_test_impl(request, access_mode.as_deref())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Load .env (if present) into the process environment so
    // MINIMAX_API_KEY reaches send_minimax_chat without an external
    // wrapper script. Bundled MSI/NSIS installers are unaffected: a
    // missing file is not an error here.
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            let runtime_path = db_path.with_file_name("agent-runtime.json");
            let runtime = AgentRuntimeService::load_or_create(runtime_path).map_err(
                |e| -> Box<dyn std::error::Error> { format!("runtime open: {e}").into() },
            )?;
            app.manage(runtime);
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
            list_workspace_dir,
            load_project_config,
            run_git_operation,
            run_project_test,
            set_provider_keys,
            get_provider_keys,
            test_provider,
            agent_runtime_commands::agent_runtime_health,
            agent_runtime_commands::agent_runtime_status,
            agent_runtime_commands::agent_runtime_open_session,
            agent_runtime_commands::agent_runtime_define_plan,
            agent_runtime_commands::agent_runtime_create_approval,
            agent_runtime_commands::agent_runtime_list_approvals,
            agent_runtime_commands::agent_runtime_resolve_approval,
            agent_runtime_commands::agent_runtime_browser_tool,
            agent_runtime_commands::agent_runtime_upsert_memory,
            agent_runtime_commands::agent_runtime_retrieve_memories,
            agent_runtime_commands::agent_runtime_retrieve_memories_request,
            agent_runtime_commands::agent_runtime_search_code,
            agent_runtime_commands::agent_runtime_check_approval,
            agent_runtime_commands::agent_runtime_apply_patch,
            agent_runtime_commands::agent_runtime_suggest_tests,
            agent_runtime_commands::agent_runtime_dependency_graph,
            agent_runtime_commands::agent_runtime_run_validation,
            agent_runtime_commands::agent_runtime_github_create_branch,
            agent_runtime_commands::agent_runtime_github_commit,
            agent_runtime_commands::agent_runtime_github_create_pr,
            agent_runtime_commands::agent_runtime_github_read_pr,
            agent_runtime_commands::agent_runtime_github_ci_status,
            agent_runtime_commands::agent_runtime_github_fix_ci,
            agent_runtime_commands::agent_runtime_upsert_memory_v2,
            agent_runtime_commands::agent_runtime_retrieve_memories_v2,
            agent_runtime_commands::agent_runtime_inject_memories,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zeus");
}
