use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// All persistent state the app loads on startup and saves during a session.
/// Returned by the `load_state` Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub proposals: Vec<PersistedProposal>,
    pub history: Vec<PersistedHistoryEntry>,
    pub access_mode: Option<String>,
    pub sessions: Vec<PersistedSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProposal {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedHistoryEntry {
    pub id: i64,
    pub proposal_id: String,
    pub action: String,
    pub body_snapshot: String,
    pub at: String,
}

/// One stored session. `messages_json` carries the chat transcript as a
/// JSON-serialized array (the frontend defines the shape — Rust stays
/// dumb and just persists whatever the frontend hands it). `compact_from_id`
/// anchors the LLM-context window: the LLM never sees messages older than
/// that id even after a relaunch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: String,
    pub label: String,
    pub project_id: String,
    pub project_name: String,
    pub last_seen_at: String,
    pub messages_json: String,
    pub compact_from_id: Option<i64>,
}

/// Request payload for `save_session` (also re-used by the legacy
/// `upsert_session` command — same shape, two names so the existing
/// frontend wires don't have to change in lockstep with persistence).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionRequest {
    pub id: String,
    pub label: String,
    pub project_id: String,
    pub project_name: String,
    pub messages_json: String,
    pub compact_from_id: Option<i64>,
}

/// Apply edit for a proposal: replace the proposal's stored summary and body
/// with `new_summary`/`new_body`, bump `updated_at`, and append an `edited`
/// entry to harness_history.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditProposalRequest {
    pub proposal_id: String,
    pub new_summary: String,
    pub new_body: String,
}

/// Record a transition action (approve / reject / applied-once / rolled-back / edited).
/// Frontend already passes the right action; the Rust side only does the
/// bookkeeping and audit trail, never mutating state outside what the action
/// naturally implies.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordActionRequest {
    pub proposal_id: String,
    pub action: String,
}

/// Open (or create, if missing) the SQLite file and ensure the schema exists.
pub fn open_and_init(path: &std::path::Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create db dir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open db: {e}"))?;
    init_schema(&conn).map_err(|e| format!("init schema: {e}"))?;
    migrate_schema(&conn).map_err(|e| format!("migrate schema: {e}"))?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS proposals (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            summary     TEXT NOT NULL,
            body        TEXT NOT NULL DEFAULT '',
            status      TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS harness_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id     TEXT NOT NULL,
            action          TEXT NOT NULL,
            body_snapshot   TEXT NOT NULL DEFAULT '',
            at              TEXT NOT NULL,
            FOREIGN KEY(proposal_id) REFERENCES proposals(id)
        );

        CREATE TABLE IF NOT EXISTS access_mode (
            key         TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            label           TEXT NOT NULL,
            project_id      TEXT NOT NULL DEFAULT 'zeus',
            project_name    TEXT NOT NULL DEFAULT 'Zeus',
            last_seen_at    TEXT NOT NULL,
            messages_json   TEXT NOT NULL DEFAULT '[]',
            compact_from_id INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_history_proposal_at
            ON harness_history(proposal_id, at DESC);
    "#,
    )
}

/// Bring an older `sessions` table up to the current shape. SQLite's
/// `CREATE TABLE IF NOT EXISTS` won't add columns to an existing table, so
/// we explicitly check `PRAGMA table_info` and ALTER as needed. Idempotent.
fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<_>>()?;
    if !columns.iter().any(|c| c == "messages_json") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN messages_json TEXT NOT NULL DEFAULT '[]'",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "compact_from_id") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN compact_from_id INTEGER",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "project_id") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'zeus'",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "project_name") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT 'Zeus'",
            [],
        )?;
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Read the entire persisted state. Frontend calls this on mount.
pub fn load_state(conn: &Connection) -> rusqlite::Result<PersistedState> {
    let proposals = {
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, body, status, updated_at
             FROM proposals ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PersistedProposal {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let history = {
        let mut stmt = conn.prepare(
            "SELECT id, proposal_id, action, body_snapshot, at
             FROM harness_history ORDER BY id DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PersistedHistoryEntry {
                id: row.get(0)?,
                proposal_id: row.get(1)?,
                action: row.get(2)?,
                body_snapshot: row.get(3)?,
                at: row.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let access_mode = conn
        .query_row(
            "SELECT value FROM access_mode WHERE key = 'mode'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    let sessions = list_sessions(conn, 20)?;

    Ok(PersistedState {
        proposals,
        history,
        access_mode,
        sessions,
    })
}

/// List the most-recently-seen `limit` sessions. Empty `messages_json`
/// (the pre-migration default) is deserialized as `[]` on the frontend.
pub fn list_sessions(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<PersistedSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, project_id, project_name, last_seen_at, messages_json, compact_from_id FROM sessions
         ORDER BY last_seen_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |row| {
        Ok(PersistedSession {
            id: row.get(0)?,
            label: row.get(1)?,
            project_id: row.get(2)?,
            project_name: row.get(3)?,
            last_seen_at: row.get(4)?,
            messages_json: row.get(5)?,
            compact_from_id: row.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

/// Load a single session by id. Returns `None` if the row doesn't exist.
#[allow(dead_code)]
pub fn get_session(conn: &Connection, id: &str) -> rusqlite::Result<Option<PersistedSession>> {
    conn.query_row(
        "SELECT id, label, project_id, project_name, last_seen_at, messages_json, compact_from_id
         FROM sessions WHERE id = ?1",
        params![id],
        |row| {
            Ok(PersistedSession {
                id: row.get(0)?,
                label: row.get(1)?,
                project_id: row.get(2)?,
                project_name: row.get(3)?,
                last_seen_at: row.get(4)?,
                messages_json: row.get(5)?,
                compact_from_id: row.get(6)?,
            })
        },
    )
    .optional()
}

/// Upsert a proposal. Used both for first-write and on any future state change
/// where the Rust side needs to be the source of truth.
#[allow(dead_code)]
pub fn upsert_proposal(conn: &Connection, proposal: &PersistedProposal) -> rusqlite::Result<()> {
    conn.execute(
        r#"INSERT INTO proposals (id, title, summary, body, status, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             summary = excluded.summary,
             body = excluded.body,
             status = excluded.status,
             updated_at = excluded.updated_at"#,
        params![
            proposal.id,
            proposal.title,
            proposal.summary,
            proposal.body,
            proposal.status,
            proposal.updated_at,
        ],
    )?;
    Ok(())
}

/// Apply an edit request, return the post-state proposal.
pub fn apply_proposal_edit(
    conn: &Connection,
    request: &EditProposalRequest,
) -> rusqlite::Result<PersistedProposal> {
    let updated_at = now();
    conn.execute(
        r#"UPDATE proposals
           SET summary = ?1, body = ?2, status = 'edited', updated_at = ?3
           WHERE id = ?4"#,
        params![
            request.new_summary,
            request.new_body,
            updated_at,
            request.proposal_id
        ],
    )?;
    append_history(
        conn,
        &request.proposal_id,
        "edited",
        &request.new_body,
        &updated_at,
    )?;
    read_proposal(conn, &request.proposal_id)
}

/// Record any non-edit transition (approve/reject/applied-once/rolled-back).
/// Updates the proposal's status column and appends a history row.
pub fn record_action(
    conn: &Connection,
    request: &RecordActionRequest,
) -> rusqlite::Result<PersistedProposal> {
    let updated_at = now();
    let proposal = read_proposal(conn, &request.proposal_id)?;
    let new_status = action_to_status(&request.action);
    conn.execute(
        r#"UPDATE proposals SET status = ?1, updated_at = ?2 WHERE id = ?3"#,
        params![new_status, updated_at, request.proposal_id],
    )?;
    append_history(
        conn,
        &request.proposal_id,
        &request.action,
        &proposal.body,
        &updated_at,
    )?;
    read_proposal(conn, &request.proposal_id)
}

/// "rolled-back" undoes the last change to a proposal. We restore the
/// proposal's `body` to the *second-most-recent* history snapshot — the
/// value the body held before the latest change — and set status to
/// 'rolled-back'. If there is no prior history, we just flip the status
/// so the UI lights up and the body stays as-is.
pub fn rollback_proposal(
    conn: &Connection,
    proposal_id: &str,
) -> rusqlite::Result<PersistedProposal> {
    // Most recent snapshot = the value after the last change.
    let latest_snapshot: Option<String> = conn
        .query_row(
            r#"SELECT body_snapshot FROM harness_history
               WHERE proposal_id = ?1
               ORDER BY id DESC LIMIT 1"#,
            params![proposal_id],
            |row| row.get(0),
        )
        .optional()?;
    // Second-most-recent snapshot = the value before the last change.
    let previous_snapshot: Option<String> = conn
        .query_row(
            r#"SELECT body_snapshot FROM harness_history
               WHERE proposal_id = ?1
               ORDER BY id DESC LIMIT 1 OFFSET 1"#,
            params![proposal_id],
            |row| row.get(0),
        )
        .optional()?;
    let updated_at = now();
    if let Some(previous) = previous_snapshot {
        conn.execute(
            r#"UPDATE proposals SET body = ?1, status = 'rolled-back', updated_at = ?2
               WHERE id = ?3"#,
            params![previous, updated_at, proposal_id],
        )?;
    } else {
        // Nothing to roll back to — just flip the status so the UI lights up.
        conn.execute(
            r#"UPDATE proposals SET status = 'rolled-back', updated_at = ?1 WHERE id = ?2"#,
            params![updated_at, proposal_id],
        )?;
    }
    let _ = latest_snapshot; // explicitly mark used to silence warnings if needed
    let current = read_proposal(conn, proposal_id)?;
    append_history(conn, proposal_id, "rolled-back", &current.body, &updated_at)?;
    Ok(current)
}

pub fn set_access_mode(conn: &Connection, mode: &str) -> rusqlite::Result<()> {
    let updated_at = now();
    conn.execute(
        r#"INSERT INTO access_mode (key, value, updated_at) VALUES ('mode', ?1, ?2)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"#,
        params![mode, updated_at],
    )?;
    Ok(())
}

/// Persist a full session — label, transcript, and the compact anchor.
/// Bumps `last_seen_at` so the row bubbles to the top of the recent list.
/// Overwrites the row on conflict (same id) so re-saving a session is
/// idempotent.
pub fn save_session(conn: &Connection, request: &SaveSessionRequest) -> rusqlite::Result<()> {
    let at = now();
    conn.execute(
        r#"INSERT INTO sessions (id, label, project_id, project_name, last_seen_at, messages_json, compact_from_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(id) DO UPDATE SET
             label = excluded.label,
             project_id = excluded.project_id,
             project_name = excluded.project_name,
             last_seen_at = excluded.last_seen_at,
             messages_json = excluded.messages_json,
             compact_from_id = excluded.compact_from_id"#,
        params![
            request.id,
            request.label,
            request.project_id,
            request.project_name,
            at,
            request.messages_json,
            request.compact_from_id,
        ],
    )?;
    Ok(())
}

/// Backwards-compatible upsert used by the existing `upsert_session` Tauri
/// command. Stores an empty transcript and no compact anchor — equivalent
/// to a freshly-created session that the frontend hasn't filled in yet.
pub fn upsert_session(conn: &Connection, id: &str, label: &str) -> rusqlite::Result<()> {
    let at = now();
    conn.execute(
        r#"INSERT INTO sessions (id, label, project_id, project_name, last_seen_at) VALUES (?1, ?2, 'zeus', 'Zeus', ?3)
           ON CONFLICT(id) DO UPDATE SET
             label = excluded.label,
             last_seen_at = excluded.last_seen_at"#,
        params![id, label, at],
    )?;
    Ok(())
}

/// Remove a session row by id. Returns true if a row was deleted, false
/// if the id didn't exist. Used by the recent-sessions delete icon.
pub fn delete_session(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let affected = conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

// --- helpers ---------------------------------------------------------

fn read_proposal(conn: &Connection, id: &str) -> rusqlite::Result<PersistedProposal> {
    conn.query_row(
        "SELECT id, title, summary, body, status, updated_at FROM proposals WHERE id = ?1",
        params![id],
        |row| {
            Ok(PersistedProposal {
                id: row.get(0)?,
                title: row.get(1)?,
                summary: row.get(2)?,
                body: row.get(3)?,
                status: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
}

fn append_history(
    conn: &Connection,
    proposal_id: &str,
    action: &str,
    body_snapshot: &str,
    at: &str,
) -> rusqlite::Result<i64> {
    conn.execute(
        r#"INSERT INTO harness_history (proposal_id, action, body_snapshot, at)
           VALUES (?1, ?2, ?3, ?4)"#,
        params![proposal_id, action, body_snapshot, at],
    )?;
    Ok(conn.last_insert_rowid())
}

fn action_to_status(action: &str) -> &str {
    match action {
        "approved" => "approved",
        "rejected" => "rejected",
        "applied-once" => "applied-once",
        "edited" => "edited",
        "rolled-back" => "rolled-back",
        _ => "ready",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Connection {
        let dir = std::env::temp_dir().join(format!(
            "zeus_persist_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("persist.db");
        let _ = std::fs::remove_file(&path);
        open_and_init(&path).expect("open")
    }

    #[test]
    fn save_session_persists_messages_and_compact_anchor() {
        let conn = temp_db();
        save_session(
            &conn,
            &SaveSessionRequest {
                id: "sess-1".to_string(),
                label: "Refactor auth".to_string(),
                project_id: "zeus".to_string(),
                project_name: "Zeus".to_string(),
                messages_json: r#"[{"id":1,"role":"user","text":"hi"}]"#.to_string(),
                compact_from_id: Some(2),
            },
        )
        .unwrap();

        let row = get_session(&conn, "sess-1").unwrap().unwrap();
        assert_eq!(row.label, "Refactor auth");
        assert!(row.messages_json.contains("hi"));
        assert_eq!(row.compact_from_id, Some(2));
    }

    #[test]
    fn save_session_is_idempotent_for_same_id() {
        let conn = temp_db();
        save_session(
            &conn,
            &SaveSessionRequest {
                id: "sess-1".to_string(),
                label: "First".to_string(),
                project_id: "zeus".to_string(),
                project_name: "Zeus".to_string(),
                messages_json: "[]".to_string(),
                compact_from_id: None,
            },
        )
        .unwrap();
        save_session(
            &conn,
            &SaveSessionRequest {
                id: "sess-1".to_string(),
                label: "Updated".to_string(),
                project_id: "docs".to_string(),
                project_name: "Docs".to_string(),
                messages_json: r#"[{"id":1,"role":"user","text":"new"}]"#.to_string(),
                compact_from_id: Some(3),
            },
        )
        .unwrap();
        let all = list_sessions(&conn, 10).unwrap();
        assert_eq!(all.len(), 1, "same id must not duplicate the row");
        assert_eq!(all[0].label, "Updated");
        assert!(all[0].messages_json.contains("new"));
    }

    #[test]
    fn list_sessions_orders_by_last_seen_at_desc() {
        let conn = temp_db();
        save_session(
            &conn,
            &SaveSessionRequest {
                id: "a".into(),
                label: "alpha".into(),
                project_id: "zeus".into(),
                project_name: "Zeus".into(),
                messages_json: "[]".into(),
                compact_from_id: None,
            },
        )
        .unwrap();
        // Force a later last_seen_at by sleeping a tick. chrono timestamps
        // are RFC3339 with nanosecond precision so even a single sleep
        // call guarantees ordering.
        std::thread::sleep(std::time::Duration::from_millis(5));
        save_session(
            &conn,
            &SaveSessionRequest {
                id: "b".into(),
                label: "beta".into(),
                project_id: "zeus".into(),
                project_name: "Zeus".into(),
                messages_json: "[]".into(),
                compact_from_id: None,
            },
        )
        .unwrap();
        let all = list_sessions(&conn, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "b");
        assert_eq!(all[1].id, "a");
    }

    #[test]
    fn migrate_schema_adds_columns_to_legacy_sessions_table() {
        // Build a DB with the old (pre-migration) schema, then open it
        // through `open_and_init` and verify the new columns exist.
        let dir = std::env::temp_dir().join(format!(
            "zeus_migrate_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("legacy.db");
        let _ = std::fs::remove_file(&path);

        // Hand-craft the legacy table.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES ('s1', 'legacy', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        drop(conn);

        // Re-open through open_and_init — migration should run.
        let conn = open_and_init(&path).unwrap();
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(sessions)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(columns.contains(&"messages_json".to_string()));
        assert!(columns.contains(&"compact_from_id".to_string()));

        // Existing row should be readable, with default values for the
        // new columns.
        let row = get_session(&conn, "s1").unwrap().unwrap();
        assert_eq!(row.label, "legacy");
        assert_eq!(row.compact_from_id, None);
    }
}
