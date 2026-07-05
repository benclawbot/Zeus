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
    open_and_init, save_session as db_save_session, list_sessions as db_list_sessions,
    EditProposalRequest, PersistedProposal, PersistedSession, PersistedState, RecordActionRequest,
    SaveSessionRequest,
};
use providers::{
    build_skill_system_message, dispatch_chat, list_provider_info, ChatMessage, ChatRequest,
    ChatResponse, ProviderInfo,
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

fn load_skill_system_message(
    app: &tauri::AppHandle,
    skill_id: &str,
) -> Result<Option<ChatMessage>, String> {
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

fn inject_skill(
    app: &tauri::AppHandle,
    request: &ChatRequest,
) -> Result<Vec<ChatMessage>, String> {
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
    let name = frontmatter_value(frontmatter, "name").unwrap_or_else(|| id.clone());
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

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
}

fn current_access_mode(conn: &Connection) -> Result<Option<String>, String> {
    persistence::load_state(conn)
        .map(|state| state.access_mode)
        .map_err(|e| format!("load access mode: {e}"))
}

#[tauri::command]
async fn send_chat(
    app: tauri::AppHandle,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    let messages = inject_skill(&app, &request)?;
    let request_with_messages = ChatRequest {
        messages,
        ..request
    };
    dispatch_chat(&request_with_messages, None)
        .await
        .map_err(String::from)
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

#[tauri::command]
fn edit_proposal(
    state: tauri::State<'_, AppState>,
    request: EditProposalRequest,
) -> Result<PersistedProposal, String> {
    let conn = state.db.lock();
    persistence::apply_proposal_edit(&conn, &request).map_err(|e| format!("edit: {e}"))
}

#[tauri::command]
fn set_access_mode(state: tauri::State<'_, AppState>, mode: String) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::set_access_mode(&conn, &mode).map_err(|e| format!("set_access_mode: {e}"))
}

#[tauri::command]
fn upsert_session(
    state: tauri::State<'_, AppState>,
    id: String,
    label: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    persistence::upsert_session(&conn, &id, &label).map_err(|e| format!("upsert_session: {e}"))
}

#[tauri::command]
fn save_session(
    state: tauri::State<'_, AppState>,
    request: SaveSessionRequest,
) -> Result<(), String> {
    let conn = state.db.lock();
    db_save_session(&conn, &request).map_err(|e| format!("save_session: {e}"))
}

#[tauri::command]
fn list_sessions_full(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PersistedSession>, String> {
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
    let skill_path = skill_dir.join("SKILL.md");
    let body = fs::read_to_string(&skill_path)
        .map_err(|e| format!("read {}: {e}", skill_path.display()))?;
    Ok(SkillDetail { summary, body })
}

#[tauri::command]
fn run_shell_command(
    state: tauri::State<'_, AppState>,
    request: workspace::ShellCommandRequest,
) -> Result<workspace::ShellCommandResult, String> {
    let conn = state.db.lock();
    let mode = current_access_mode(&conn)?;
    workspace::run_shell_command(request, mode.as_deref())
}

#[tauri::command]
fn read_workspace_file(
    request: workspace::ReadWorkspaceFileRequest,
) -> Result<workspace::ReadWorkspaceFileResult, String> {
    workspace::read_workspace_file(request)
}

#[tauri::command]
fn write_workspace_file(
    state: tauri::State<'_, AppState>,
    request: workspace::WriteWorkspaceFileRequest,
) -> Result<workspace::WriteWorkspaceFileResult, String> {
    let conn = state.db.lock();
    let mode = current_access_mode(&conn)?;
    workspace::write_workspace_file(request, mode.as_deref())
}

#[tauri::command]
fn apply_workspace_edit(
    state: tauri::State<'_, AppState>,
    request: workspace::ApplyWorkspaceEditRequest,
) -> Result<workspace::ApplyWorkspaceEditResult, String> {
    let conn = state.db.lock();
    let mode = current_access_mode(&conn)?;
    workspace::apply_workspace_edit(request, mode.as_deref())
}

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Zeus");
}

#[cfg(test)]
mod tests {
    use super::*;
    use providers::{ChatRequest, ProviderError};

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
        assert!(ids.contains(&"minimax"));
        assert!(ids.contains(&"openai"));
        assert!(ids.contains(&"anthropic"));
    }

    #[test]
    fn send_chat_routes_to_requested_provider() {
        let request = sample_request("minimax");
        let result = futures_block_on(dispatch_chat(&request, None));
        match result {
            Err(ProviderError::MissingApiKey { provider }) => {
                assert_eq!(provider, "minimax");
            }
            other => panic!("expected MissingApiKey for minimax, got {other:?}"),
        }
    }

    fn futures_block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker, RawWaker, RawWakerVTable};

        fn dummy_waker() -> Waker {
            fn no_op(_: *const ()) {}
            fn clone(_: *const ()) -> RawWaker {
                RawWaker::new(std::ptr::null(), &VT)
            }
            static VT: RawWakerVTable = RawWakerVTable::new(clone, no_op, no_op, no_op);
            unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VT)) }
        }

        let mut future = Box::pin(future);
        let waker = dummy_waker();
        let mut cx = Context::from_waker(&waker);
        loop {
            match future.as_mut().poll(&mut cx) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
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
        assert_eq!(skills[0].description, "Alpha metadata only.");
        assert!(skills[0].has_references);
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

    #[test]
    fn seed_creates_default_proposal_once() {
        let conn = temp_db();
        seed_default_state(&conn).unwrap();
        let p = persistence::load_state(&conn).unwrap();
        assert_eq!(p.proposals.len(), 1);
        assert_eq!(p.proposals[0].id, "proposal-001");
        seed_default_state(&conn).unwrap();
        let p = persistence::load_state(&conn).unwrap();
        assert_eq!(p.proposals.len(), 1);
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
}
