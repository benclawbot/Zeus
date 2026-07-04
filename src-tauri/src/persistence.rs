use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// All persistent state the app loads on startup and saves during a session.
/// Returned by the `load_state` Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedState {
    pub proposals: Vec<PersistedProposal>,
    pub history: Vec<PersistedHistoryEntry>,
    pub access_mode: Option<String>,
    pub sessions: Vec<PersistedSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedProposal {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub body: String,
    pub status: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedHistoryEntry {
    pub id: i64,
    pub proposal_id: String,
    pub action: String,
    pub body_snapshot: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub id: String,
    pub label: String,
    pub last_seen_at: String,
}

/// Apply edit for a proposal: replace the proposal's stored summary and body
/// with `new_summary`/`new_body`, bump `updated_at`, and append an `edited`
/// entry to harness_history.
#[derive(Debug, Clone, Deserialize)]
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
            last_seen_at    TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_history_proposal_at
            ON harness_history(proposal_id, at DESC);
    "#,
    )
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

    let sessions = {
        let mut stmt = conn.prepare(
            "SELECT id, label, last_seen_at FROM sessions
             ORDER BY last_seen_at DESC LIMIT 20",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PersistedSession {
                id: row.get(0)?,
                label: row.get(1)?,
                last_seen_at: row.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(PersistedState {
        proposals,
        history,
        access_mode,
        sessions,
    })
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
                             // Read current body for the snapshot (now either restored or original).
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

pub fn upsert_session(conn: &Connection, id: &str, label: &str) -> rusqlite::Result<()> {
    let at = now();
    conn.execute(
        r#"INSERT INTO sessions (id, label, last_seen_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET label = excluded.label, last_seen_at = excluded.last_seen_at"#,
        params![id, label, at],
    )?;
    Ok(())
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
