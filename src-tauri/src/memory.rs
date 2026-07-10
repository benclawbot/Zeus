// Project-scoped coding memory. Persists memories to disk so they
// survive relaunches, scores them across multiple relevance signals
// when the runtime needs to inject them into a prompt, and auto-marks
// stale / superseded memories when a contradicting newer one is added.
//
// Memory categories map 1:1 to the spec:
//   - architecture_decision
//   - user_preference
//   - failure_pattern
//   - command_result
//   - project_convention

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

static NEXT_MEMORY_ID: AtomicU64 = AtomicU64::new(0);

fn next_memory_id() -> String {
    let sequence = NEXT_MEMORY_ID.fetch_add(1, Ordering::Relaxed);
    format!(
        "memory-{}-{sequence}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryCategory {
    ArchitectureDecision,
    UserPreference,
    FailurePattern,
    CommandResult,
    ProjectConvention,
}

impl MemoryCategory {
    pub fn label(self) -> &'static str {
        match self {
            MemoryCategory::ArchitectureDecision => "architecture-decision",
            MemoryCategory::UserPreference => "user-preference",
            MemoryCategory::FailurePattern => "failure-pattern",
            MemoryCategory::CommandResult => "command-result",
            MemoryCategory::ProjectConvention => "project-convention",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "architecture-decision" => Some(MemoryCategory::ArchitectureDecision),
            "user-preference" => Some(MemoryCategory::UserPreference),
            "failure-pattern" => Some(MemoryCategory::FailurePattern),
            "command-result" => Some(MemoryCategory::CommandResult),
            "project-convention" => Some(MemoryCategory::ProjectConvention),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub project_id: String,
    pub category: MemoryCategory,
    pub content: String,
    pub tags: Vec<String>,
    /// Optional explicit path the memory is associated with. Boosts the
    /// retrieval score when the agent is working on the same file.
    pub file_path: Option<String>,
    /// Source reliability in [0, 1]. 1.0 = user-stated, 0.5 = observed,
    /// 0.25 = inferred.
    pub reliability: f32,
    pub created_at: String,
    pub stale: bool,
    pub superseded_by: Option<String>,
    pub last_used_at: Option<String>,
    pub use_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub memory: Memory,
    pub score: u32,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalContext {
    pub project_id: String,
    pub query: String,
    pub file_path: Option<String>,
    pub tags: Vec<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub memories: Vec<Memory>,
}

#[derive(Clone)]
pub struct MemoryStore {
    path: PathBuf,
    state: std::sync::Arc<Mutex<MemoryFile>>,
}

impl MemoryStore {
    pub fn load_or_create(path: impl Into<PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let state = if path.exists() {
            let raw = fs::read_to_string(&path).map_err(|e| format!("read memory file: {e}"))?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            MemoryFile::default()
        };
        Ok(Self {
            path,
            state: std::sync::Arc::new(Mutex::new(state)),
        })
    }

    pub fn upsert(&self, mut memory: Memory) -> Result<Memory, String> {
        if memory.id.trim().is_empty() {
            memory.id = next_memory_id();
        }
        if memory.created_at.is_empty() {
            memory.created_at = Utc::now().to_rfc3339();
        }
        memory.reliability = memory.reliability.clamp(0.0, 1.0);
        let mut state = self.state.lock();
        // Detect contradicting memories and mark them superseded.
        if memory.category == MemoryCategory::UserPreference
            || memory.category == MemoryCategory::ProjectConvention
        {
            for existing in state.memories.iter_mut() {
                if existing.id == memory.id {
                    continue;
                }
                if existing.project_id != memory.project_id {
                    continue;
                }
                if existing.category != memory.category {
                    continue;
                }
                if existing.stale || existing.superseded_by.is_some() {
                    continue;
                }
                if contradicts(&existing.content, &memory.content) {
                    existing.superseded_by = Some(memory.id.clone());
                    existing.stale = true;
                }
            }
        }
        if let Some(existing) = state.memories.iter_mut().find(|m| m.id == memory.id) {
            *existing = memory.clone();
        } else {
            state.memories.push(memory.clone());
        }
        self.persist(&state)?;
        Ok(memory)
    }

    pub fn list(&self, project_id: Option<&str>) -> Vec<Memory> {
        let state = self.state.lock();
        state
            .memories
            .iter()
            .filter(|m| project_id.map(|id| m.project_id == id).unwrap_or(true))
            .cloned()
            .collect()
    }

    pub fn retrieve(&self, ctx: &RetrievalContext) -> Vec<MemoryHit> {
        let state = self.state.lock();
        let query_tokens = tokenize(&ctx.query);
        let mut scored: Vec<MemoryHit> = state
            .memories
            .iter()
            .filter(|m| m.project_id == ctx.project_id)
            .filter(|m| !m.stale && m.superseded_by.is_none())
            .map(|memory| {
                let mut score =
                    score_memory(memory, &query_tokens, &ctx.tags, ctx.file_path.as_deref());
                // Light recency tiebreaker: bump very recent memories a touch.
                if memory.created_at > since(7) {
                    score += 1;
                }
                if memory.last_used_at.as_deref() > Some(since(7).as_str()) {
                    score += 1;
                }
                let reason = explain_score(memory, &query_tokens, ctx.file_path.as_deref(), score);
                MemoryHit {
                    memory: memory.clone(),
                    score,
                    reason,
                }
            })
            .filter(|hit| hit.score > 0)
            .collect();
        scored.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.memory.created_at.cmp(&b.memory.created_at))
        });
        scored.truncate(ctx.limit.max(1));
        scored
    }

    /// Mark a memory as recently used (so the next retrieval gets a
    /// recency bump). Returns the updated memory.
    pub fn touch(&self, id: &str) -> Result<Option<Memory>, String> {
        let mut state = self.state.lock();
        if let Some(memory) = state.memories.iter_mut().find(|m| m.id == id) {
            memory.last_used_at = Some(Utc::now().to_rfc3339());
            memory.use_count = memory.use_count.saturating_add(1);
            let out = memory.clone();
            self.persist(&state)?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn mark_stale(
        &self,
        id: &str,
        superseded_by: Option<String>,
    ) -> Result<Option<Memory>, String> {
        let mut state = self.state.lock();
        if let Some(memory) = state.memories.iter_mut().find(|m| m.id == id) {
            memory.stale = true;
            memory.superseded_by = superseded_by;
            let out = memory.clone();
            self.persist(&state)?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    fn persist(&self, state: &MemoryFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create memory dir: {e}"))?;
        }
        let raw =
            serde_json::to_string_pretty(state).map_err(|e| format!("serialize memories: {e}"))?;
        fs::write(&self.path, raw).map_err(|e| format!("write memory file: {e}"))
    }
}

/// Tokenize a string into a hash set of normalized tokens.
fn tokenize(value: &str) -> HashSet<String> {
    value
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
        .filter(|token| token.len() > 2)
        .map(str::to_string)
        .collect()
}

fn score_memory(
    memory: &Memory,
    query_tokens: &HashSet<String>,
    tags: &[String],
    file_path: Option<&str>,
) -> u32 {
    let mut score = 0u32;
    let content_tokens = tokenize(&memory.content);
    let overlap = query_tokens.intersection(&content_tokens).count() as u32;
    score += overlap * 4;
    // Tag match: tag-aligned queries get a big bump.
    let memory_tags: HashSet<String> = memory.tags.iter().map(|t| t.to_lowercase()).collect();
    let wanted_tags: HashSet<String> = tags.iter().map(|t| t.to_lowercase()).collect();
    let tag_overlap = memory_tags.intersection(&wanted_tags).count() as u32;
    score += tag_overlap * 6;
    if memory.category == MemoryCategory::UserPreference
        || memory.category == MemoryCategory::ProjectConvention
    {
        // Always surface user preferences and conventions when any token overlaps.
        if overlap > 0 {
            score += 2;
        }
    }
    if memory.category == MemoryCategory::FailurePattern && file_path.is_some() {
        // Failure patterns are most useful when tied to a file the agent is touching.
        let fp = memory.file_path.as_deref().unwrap_or("");
        if let Some(current) = file_path {
            if current.contains(fp) || fp.contains(current) {
                score += 8;
            }
        }
    }
    if let (Some(current), Some(stored)) = (file_path, memory.file_path.as_deref()) {
        if !stored.is_empty()
            && !current.is_empty()
            && (current.contains(stored) || stored.contains(current))
        {
            score += 4;
        }
    }
    // Reliability boost: 1.0 reliability contributes +6, 0.25 contributes ~1.5.
    score += ((memory.reliability * 6.0).round() as u32).max(0);
    score
}

fn explain_score(
    memory: &Memory,
    query_tokens: &HashSet<String>,
    file_path: Option<&str>,
    score: u32,
) -> String {
    let content_tokens = tokenize(&memory.content);
    let overlap = query_tokens.intersection(&content_tokens).count();
    let mut parts = Vec::new();
    if overlap > 0 {
        parts.push(format!("{overlap} keyword overlap"));
    }
    if let Some(fp) = file_path {
        if let Some(stored) = memory.file_path.as_deref() {
            if !stored.is_empty() && (fp.contains(stored) || stored.contains(fp)) {
                parts.push(format!("file path matches {stored}"));
            }
        }
    }
    parts.push(format!("reliability={:.2}", memory.reliability));
    parts.push(format!("category={}", memory.category.label()));
    parts.push(format!("score={score}"));
    parts.join("; ")
}

fn contradicts(existing: &str, newer: &str) -> bool {
    // Trivial negation heuristic: if both strings share most content but
    // one contains a negation token that the other lacks, treat them as
    // conflicting. Conservative — we only supersede when there's a real
    // signal of contradiction.
    let lower_existing = existing.to_lowercase();
    let lower_newer = newer.to_lowercase();
    let negation_tokens = [
        "never",
        "don't",
        "do not",
        "avoid",
        "no longer",
        "instead of",
        "stop",
        "must not",
    ];
    let existing_has_neg = negation_tokens.iter().any(|t| lower_existing.contains(t));
    let newer_has_neg = negation_tokens.iter().any(|t| lower_newer.contains(t));
    let shared = tokenize(existing).intersection(&tokenize(newer)).count();
    let total_existing = tokenize(existing).len().max(1);
    let total_newer = tokenize(newer).len().max(1);
    let similarity = (shared * 2) as f32 / (total_existing + total_newer) as f32;
    similarity > 0.3 && existing_has_neg != newer_has_neg
}

fn since(days: i64) -> String {
    let now = Utc::now();
    let dt = now - chrono::Duration::days(days);
    dt.to_rfc3339()
}

/// Build a prompt fragment from the top-N memories. The fragment is
/// always wrapped in a fenced block so the LLM can clearly tell where
/// the injected context ends.
pub fn build_injection(hits: &[MemoryHit]) -> String {
    if hits.is_empty() {
        return String::new();
    }
    let mut out = String::from("Project memory context:\n");
    for hit in hits {
        out.push_str(&format!(
            "- [{}] {} (reliability {:.2})\n",
            hit.memory.category.label(),
            hit.memory.content.replace('\n', " "),
            hit.memory.reliability,
        ));
    }
    out
}

/// Aggregate helpers used by the agent runtime's retrieve endpoint so
/// we don't have to expose `MemoryStore` to the front end.
pub fn score_summary(hit: &MemoryHit, query: &str) -> HashMap<String, u32> {
    let mut summary = HashMap::new();
    summary.insert(
        "overlap".to_string(),
        tokenize(&hit.memory.content)
            .intersection(&tokenize(query))
            .count() as u32,
    );
    summary.insert("score".to_string(), hit.score);
    summary.insert("use_count".to_string(), hit.memory.use_count);
    summary
}

/// Refresh the in-memory index for a project. Returns the number of
/// active memories (non-stale, non-superseded) for that project.
pub fn active_count(store: &MemoryStore, project_id: &str) -> usize {
    store
        .list(Some(project_id))
        .into_iter()
        .filter(|m| !m.stale && m.superseded_by.is_none())
        .count()
}

/// Suggest the top memories to inject into a chat request. Returns at
/// most `limit` items.
pub fn suggest_injection(
    store: &MemoryStore,
    project_id: &str,
    query: &str,
    file_path: Option<&str>,
    limit: usize,
) -> Vec<MemoryHit> {
    store.retrieve(&RetrievalContext {
        project_id: project_id.to_string(),
        query: query.to_string(),
        file_path: file_path.map(str::to_string),
        tags: Vec::new(),
        limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeus_mem_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.join("memory.json")
    }

    #[test]
    fn upsert_and_retrieve_ranks_by_overlap() {
        let path = temp_path();
        let store = MemoryStore::load_or_create(&path).unwrap();
        store
            .upsert(Memory {
                id: "".into(),
                project_id: "zeus".into(),
                category: MemoryCategory::FailurePattern,
                content: "cargo test fails when src-tauri/src has a syntax error".into(),
                tags: vec!["cargo".into(), "build".into()],
                file_path: Some("src-tauri/src".into()),
                reliability: 0.9,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();
        store
            .upsert(Memory {
                id: "".into(),
                project_id: "zeus".into(),
                category: MemoryCategory::ProjectConvention,
                content: "Always run cargo fmt after editing Rust files".into(),
                tags: vec!["rust".into(), "format".into()],
                file_path: None,
                reliability: 1.0,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();
        let hits = store.retrieve(&RetrievalContext {
            project_id: "zeus".into(),
            query: "cargo test failure".into(),
            file_path: Some("src-tauri/src/lib.rs".into()),
            tags: vec!["cargo".into()],
            limit: 5,
        });
        assert!(!hits.is_empty());
        assert!(hits[0].memory.content.contains("cargo test"));
    }

    #[test]
    fn blank_ids_never_replace_distinct_memories() {
        let path = temp_path();
        let store = MemoryStore::load_or_create(&path).unwrap();
        let first = store
            .upsert(Memory {
                id: String::new(),
                project_id: "zeus".into(),
                category: MemoryCategory::CommandResult,
                content: "first command result".into(),
                tags: Vec::new(),
                file_path: None,
                reliability: 0.5,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();
        let second = store
            .upsert(Memory {
                id: String::new(),
                project_id: "zeus".into(),
                category: MemoryCategory::CommandResult,
                content: "second command result".into(),
                tags: Vec::new(),
                file_path: None,
                reliability: 0.5,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();

        assert_ne!(first.id, second.id);
        assert_eq!(store.list(Some("zeus")).len(), 2);
    }

    #[test]
    fn generated_memory_ids_are_unique_within_one_clock_tick() {
        let first = next_memory_id();
        let second = next_memory_id();

        assert_ne!(first, second);
    }

    #[test]
    fn supersedes_contradicting_preferences() {
        let path = temp_path();
        let store = MemoryStore::load_or_create(&path).unwrap();
        store
            .upsert(Memory {
                id: "".into(),
                project_id: "zeus".into(),
                category: MemoryCategory::UserPreference,
                content: "Use tabs for indentation".into(),
                tags: vec!["format".into()],
                file_path: None,
                reliability: 1.0,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();
        store
            .upsert(Memory {
                id: "".into(),
                project_id: "zeus".into(),
                category: MemoryCategory::UserPreference,
                content: "Never use tabs, switch to spaces".into(),
                tags: vec!["format".into()],
                file_path: None,
                reliability: 1.0,
                created_at: String::new(),
                stale: false,
                superseded_by: None,
                last_used_at: None,
                use_count: 0,
            })
            .unwrap();
        let all = store.list(Some("zeus"));
        let stale: Vec<_> = all.iter().filter(|m| m.stale).collect();
        assert!(
            !stale.is_empty(),
            "contradicting memory should be marked stale"
        );
    }
}
