#[path = "../src/agent_runtime.rs"]
mod agent_runtime;

#[path = "../src/code_intelligence.rs"]
mod code_intelligence;

use std::collections::HashSet;
use std::fs;

use agent_runtime::{
    approval_for_steps, AgentRuntimeService, ApprovalStatus, BrowserToolRequest, ProjectMemory,
    RiskClass, ToolRunRecord,
};

fn temp_state_path(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("zeus-{name}-{}.json", std::process::id()));
    let _ = fs::remove_file(&path);
    path
}

#[test]
fn runtime_persists_sessions_plans_approvals_and_memory() {
    let path = temp_state_path("runtime-state");
    let runtime = AgentRuntimeService::load_or_create(&path).unwrap();
    runtime
        .open_session("s1".into(), "zeus".into(), "Main".into())
        .unwrap();
    runtime
        .define_plan(
            "s1",
            "Build runtime".into(),
            vec!["inspect".into(), "implement".into()],
        )
        .unwrap();

    let approval = runtime
        .create_approval(approval_for_steps(
            "s1".into(),
            "Build runtime".into(),
            vec!["edit src/App.tsx".into()],
            vec!["src/App.tsx".into()],
            RiskClass::LocalWrite,
            Some("--- before\n+++ after".into()),
        ))
        .unwrap();
    assert_eq!(runtime.status().pending_approvals, 1);
    runtime
        .resolve_approval(
            &approval.id,
            ApprovalStatus::ApprovedOnce,
            Some("human approved".into()),
        )
        .unwrap();
    assert_eq!(runtime.status().pending_approvals, 0);

    runtime
        .upsert_memory(ProjectMemory {
            id: "m1".into(),
            project_id: "zeus".into(),
            source: "session:s1".into(),
            content: "Playwright browser snapshots helped repair the UI".into(),
            tags: vec!["browser".into(), "ui".into()],
            stale: false,
            superseded_by: None,
            created_at: "".into(),
        })
        .unwrap();
    let hits = runtime.retrieve_memories("zeus", "repair browser ui", 3);
    assert_eq!(hits.len(), 1);

    let reloaded = AgentRuntimeService::load_or_create(&path).unwrap();
    assert_eq!(reloaded.status().sessions, 1);
    assert_eq!(reloaded.status().memories, 1);
}

#[test]
fn records_tool_runs_and_browser_sessions() {
    let path = temp_state_path("tool-runs");
    let runtime = AgentRuntimeService::load_or_create(&path).unwrap();
    runtime
        .open_session("s1".into(), "zeus".into(), "Main".into())
        .unwrap();
    runtime
        .record_tool_run(ToolRunRecord {
            id: "run-1".into(),
            session_id: "s1".into(),
            tool: "search_code".into(),
            label: "search App".into(),
            ok: true,
            risk_class: RiskClass::ReadOnly,
            files_touched: vec!["src/App.tsx".into()],
            observation: "found 3 hits".into(),
            created_at: "now".into(),
        })
        .unwrap();
    assert_eq!(runtime.status().tool_runs, 1);

    let status = runtime
        .browser_tool(BrowserToolRequest {
            action: "status".into(),
            session_id: Some("ui".into()),
            url: None,
            selector: None,
            text: None,
            script: None,
            test_command: None,
            artifact_path: None,
            options: None,
        })
        .unwrap();
    // `status` is the only action that does not require the Playwright
    // driver to be on PATH, so it is safe in any CI environment. We
    // assert the structured contract: provider + action echoed back
    // plus a non-empty status message.
    assert_eq!(status.action, "status");
    assert_eq!(status.provider, "playwright");
    assert!(!status.message.is_empty());
}

#[test]
fn search_code_returns_symbol_and_seen_file_state() {
    let mut root = std::env::temp_dir();
    root.push(format!("zeus-search-code-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src").join("demo.rs"),
        "pub fn approve_request() {\n  // pending approval\n}\n",
    )
    .unwrap();

    let hits = {
        let mut cache = code_intelligence::SymbolCache::default();
        cache.ensure(&root).unwrap();
        let seen: HashSet<String> = ["src/demo.rs".to_string()].into_iter().collect();
        code_intelligence::search(&cache.index, "approval", &seen, 10)
    };
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "src/demo.rs");
    assert_eq!(hits[0].symbol.as_deref(), Some("approve_request"));
    assert!(hits[0].already_read);
}
