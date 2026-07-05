use std::{fs, path::{Path, PathBuf}, sync::Arc};

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::Manager;

mod persistence;
mod providers;
mod workspace;

use persistence::{
    open_and_init, save_session as db_save_session, list_sessions as db_list_sessions,
    EditProposalRequest, PersistedProposal, PersistedSession, PersistedState, RecordActionRequest,
    SaveSessionRequest,
};
use providers::{
    build_skill_system_message, dispatch_chat, list_provider_info, ChatMessage, ChatRequest,
    ChatResponse, ProviderInfo,
};
use workspace::{
    apply_workspace_edit as apply_workspace_edit_impl, read_workspace_file as read_workspace_file_impl,
    run_shell_command as run_shell_command_impl, write_workspace_file as write_workspace_file_impl,
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

fn load_skill_system_message(app: &tauri::AppHandle, skill_id: &str) -> Result<Option<ChatMessage>, String> {
    if !valid_skill_id(skill_id) {
        return Err(format!("Invalid skill id '{skill_id}'."));
    }
    let root = resolve_skills_dir(app)?;
    let skill_path = root.join(skill_id).join("SKILL.md");
    if !skill_path.is_file() {
        return Err(format!("Skill '{skill_id}' was not found."));
    }
    let raw = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(build_skill_system_message(skill_id, &raw))
}

fn inject_skill(app: &tauri::AppHandle, request: &ChatRequest) -> Result<Vec<ChatMessage>, String> {
    let Some(skill_id) = request.skill_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(request.messages.clone());
    };
    let Some(skill_message) = load_skill_system_message(app, skill_id)? else {
        return Ok(request.messages.clone());
    };
    let mut out = Vec::with_capacity(request.messages.len() + 1);
    out.push(skill_message);
    out.extend(request.messages.iter().cloned());
    Ok(out)
}

fn strip_wrapping_quotes(value: &str) -> String {
    value.trim().trim_matches('"').trim_matches('\'').trim().to_string()
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
    let id = dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid skill folder name.".to_string())?
        .to_string();
    let skill_path = dir.join("SKILL.md");
    let content = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    let frontmatter = split_frontmatter(&content)
        .ok_or_else(|| format!("{} is missing YAML frontmatter.", skill_path.display()))?;
    Ok(SkillSummary {
        id: id.clone(),
        name: frontmatter_value(frontmatter, "name").unwrap_or_else(|| id.clone()),
        description: frontmatter_value(frontmatter, "description").unwrap_or_default(),
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

fn valid_skill_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
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
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("skills"));
    candidates
}

fn resolve_skills_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    skills_dir_candidates(app)
        .into_iter()
        .find(|candidate| candidate.is_dir())
        .ok_or_else(|| "No Zeus skills directory was found.".to_string())
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
}

fn current_access_mode(conn: &Connection) -> Result<Option<String>, String> {
    persistence::load_state(conn)
        .map(|state| state.access_mode)
        .map_err(|e| format!("load access mode: {e}"))
}

#[tauri::command]
async fn send_chat(app: tauri::AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    let messages = inject_skill(&app, &request)?;
    let request_with_messages = ChatRequest { messages, ..request };
    dispatch_chat(&request_with_messages, None).await.map_err(String::from)
}

#[tauri::command]
async fn send_minimax_chat(app: tauri::AppHandle, request: ChatRequest) -> Result<ChatResponse, String> {
    let request = ChatRequest { provider: "minimax".to_string(), ..request };
    send_chat(app, request).await
}

#[tauri::command]
fn list_providers() -> Vec<ProviderInfo> {
    list_provider_info()
}

#[tauri::command]
fn load_state(state: tauri::State<'_, AppState>) -> Result<PersistedState, String> {
    let conn = state.db.lock();
    persistence::load_state(&conn).map_err(|e| format!("load_state: {e}"))
}

#[tauri::command]
fn record_proposal_action(state: tauri::State<'_, AppState>, request: RecordActionRequest) -> Result<PersistedProposal, String> {
    let conn = state.db.lock();
    if request.action == "rolled-back" {
        return persistence::rollback_proposal(&conn, &request.proposal_id).map_err(|e| format!("rollback: {e}"));
    }
    persistence::record_action(&conn, &request).map_err(|e| format!("record_action: {e}"))
}

#[tauri::command]
fn edit_proposal(state: tauri::State<'_, AppState>, request: EditProposalRequest) -> Result<PersistedProposal, String> {
    let conn = state.db.lock();
    persistence::apply_proposal_edit(&conn, &request).map_err(|e| format!("edit: {e}"))
}

#[tauri::command]
fn set_access_mode(state: tauri::State<'_, AppState>, mode: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::set_access_mode(&conn, &mode).map_err(|e| format!("set_access_mode: {e}"))
}

#[tauri::command]
fn upsert_session(state: tauri::State<'_, AppState>, id: String, label: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::upsert_session(&conn, &id, &label).map_err(|e| format!("upsert_session: {e}"))
}

#[tauri::command]
fn save_session(state: tauri::State<'_, AppState>, request: SaveSessionRequest) -> Result<(), String> {
    let conn = state.db.lock();
    db_save_session(&conn, &request).map_err(|e| format!("save_session: {e}"))
}

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
    let skill_dir = root.join(&id);
    if !skill_dir.is_dir() {
        return Err(format!("Skill '{id}' was not found."));
    }
    let summary = skill_summary_from_dir(&skill_dir)?;
    let body = fs::read_to_string(skill_dir.join("SKILL.md"))
        .map_err(|e| format!("read skill '{id}': {e}"))?;
    Ok(SkillDetail { summary, body })
}

#[tauri::command]
fn run_shell_command(state: tauri::State<'_, AppState>, request: ShellCommandRequest) -> Result<ShellCommandResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    run_shell_command_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn read_workspace_file(request: ReadWorkspaceFileRequest) -> Result<ReadWorkspaceFileResult, String> {
    read_workspace_file_impl(request)
}

#[tauri::command]
fn write_workspace_file(state: tauri::State<'_, AppState>, request: WriteWorkspaceFileRequest) -> Result<WriteWorkspaceFileResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    write_workspace_file_impl(request, access_mode.as_deref())
}

#[tauri::command]
fn apply_workspace_edit(state: tauri::State<'_, AppState>, request: ApplyWorkspaceEditRequest) -> Result<ApplyWorkspaceEditResult, String> {
    let access_mode = {
        let conn = state.db.lock();
        current_access_mode(&conn)?
    };
    apply_workspace_edit_impl(request, access_mode.as_deref())
}

fn seed_default_state(conn: &Connection) -> rusqlite::Result<()> {
    let exists: bool = conn
        .query_row("SELECT 1 FROM proposals WHERE id = 'proposal-001'", [], |_| Ok(true))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = dotenvy::dotenv();

    tauri::Builder::default()
        .setup(|app| {
            let db_path = match app.path().app_data_dir() {
                Ok(dir) => dir.join("zeus.db"),
                Err(_) => std::path::PathBuf::from("zeus.db"),
            };
            let conn = open_and_init(&db_path)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("db open: {e}").into() })?;
            seed_default_state(&conn)
                .map_err(|e| -> Box<dyn std::error::Error> { format!("seed: {e}").into() })?;
            app.manage(AppState { db: Arc::new(Mutex::new(conn)) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            send_chat,
            send_minimax_chat,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zeus");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_skill_id_blocks_path_traversal() {
        assert!(valid_skill_id("frontend-dev"));
        assert!(valid_skill_id("5-why"));
        assert!(!valid_skill_id("../frontend-dev"));
        assert!(!valid_skill_id("Frontend"));
        assert!(!valid_skill_id("skill_name"));
    }

    #[test]
    fn frontmatter_parser_handles_block_descriptions() {
        let frontmatter = "name: blocky\ndescription: |\n  First line.\n  Second line.\nmetadata: ignored";
        assert_eq!(frontmatter_value(frontmatter, "description").unwrap(), "First line. Second line.");
    }

    #[test]
    fn seed_creates_default_proposal_once() {
        let dir = std::env::temp_dir().join(format!("zeus_lib_seed_{}_{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.db");
        let _ = std::fs::remove_file(&path);
        let conn = open_and_init(&path).expect("open");
        seed_default_state(&conn).expect("seed");
        seed_default_state(&conn).expect("seed again");
        let state = persistence::load_state(&conn).unwrap();
        assert_eq!(state.proposals.len(), 1);
        assert_eq!(state.proposals[0].id, "proposal-001");
    }
}
