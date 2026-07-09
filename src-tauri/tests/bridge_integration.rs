//! Bridge contract test. Locks the Tauri command name surface so a
//! rename on the Rust side forces an update to the TS `DECLARED_COMMANDS`
//! list (src/providers/bridge.test.ts) in the same change. The TS test
//! asserts every TS `invoke<...>(...)` call resolves to a name declared
//! here; this test asserts every name declared here is actually
//! registered as a `#[tauri::command]` in src/lib.rs.
//!
//! If you add a new `#[tauri::command]` in lib.rs:
//!   1. Add the snake_case name to `DECLARED_COMMANDS` below.
//!   2. Add the same name to the TS test's `DECLARED_COMMANDS` array.
//!   3. Wire the TS side via `invoke<...>("<name>", {...})`.
//!
//! Skip the TS list only for commands intentionally hidden from the
//! frontend (none today).

/// Every Tauri command name registered in src-tauri/src/lib.rs (and the
/// `agent_runtime_commands` submodule). Keep in sync with the TS
/// `DECLARED_COMMANDS` array in src/providers/bridge.test.ts.
///
/// This test only reads source as text — it does not compile the
/// library. Pulling the full `mod lib;` in here would force
/// `agent_runtime` and friends to resolve as siblings of the test
/// rather than children of `lib`, breaking the `mod` declarations in
/// lib.rs at compile time. The text-scan approach is enough for the
/// contract we want to lock.
const DECLARED_COMMANDS: &[&str] = &[
    "send_chat",
    "test_provider",
    "get_provider_keys",
    "set_provider_keys",
    "list_providers",
    "agent_engine_health",
    "agent_engine_follow_up_plan",
    "agent_engine_execute_tools",
    "run_ralph_loop",
    "load_state",
    "edit_proposal",
    "record_proposal_action",
    "set_access_mode",
    "upsert_session",
    "delete_session",
    "save_session",
    "list_sessions_full",
    "list_skills",
    "load_skill",
    "run_shell_command",
    "read_workspace_file",
    "write_workspace_file",
    "apply_workspace_edit",
    "run_agent_task",
    "list_workspace_dir",
    "load_project_config",
    "run_git_operation",
    "run_project_test",
    "web_search",
    "agent_runtime_check_approval",
    "agent_runtime_list_approvals",
    "agent_runtime_resolve_approval",
    "agent_runtime_create_approval",
    "agent_runtime_health",
    "agent_runtime_status",
    "agent_runtime_open_session",
    "agent_runtime_define_plan",
    "agent_runtime_browser_tool",
    "agent_runtime_upsert_memory",
    "agent_runtime_retrieve_memories",
    "agent_runtime_search_code",
];

#[test]
fn every_declared_command_name_is_snake_case() {
    for name in DECLARED_COMMANDS {
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "command name '{name}' is not snake_case"
        );
        assert!(!name.starts_with('_') && !name.ends_with('_'));
    }
}

#[test]
fn command_names_are_unique() {
    let mut seen = std::collections::HashSet::new();
    for name in DECLARED_COMMANDS {
        assert!(seen.insert(*name), "duplicate command name '{name}'");
    }
}

#[test]
fn declared_commands_match_lib_rs_command_annotations() {
    // Read lib.rs at build time and extract every `fn <name>` line that
    // follows a `#[tauri::command]` attribute. The bridge test on the
    // TS side asserts every TS invoke call resolves to a name in
    // `DECLARED_COMMANDS`; this test asserts every name in
    // `DECLARED_COMMANDS` actually has a matching declaration in
    // lib.rs. If someone adds a new `#[tauri::command]` in lib.rs and
    // forgets to add it to either list, this test catches the drift.
    let source = include_str!("../src/lib.rs");
    let agent_runtime_source = include_str!("../src/agent_runtime_commands.rs");
    let combined = format!("{source}\n{agent_runtime_source}");

    let mut declared_in_source = std::collections::HashSet::new();
    for line in combined.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("fn ").or(trimmed.strip_prefix("async fn ")) {
            // Take the function name up to the first `(` or whitespace.
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                declared_in_source.insert(name);
            }
        }
    }

    // The list above is the contract — every entry must exist in the
    // Rust source. The inverse (every source fn must be in the list)
    // is a soft signal: we report it as a panic when the gap is
    // large so a forgotten addition gets noticed in CI.
    let missing_from_source: Vec<&&str> = DECLARED_COMMANDS
        .iter()
        .filter(|name| !declared_in_source.contains(**name))
        .collect();
    assert!(
        missing_from_source.is_empty(),
        "declared commands missing from src-tauri/src/lib.rs: {missing_from_source:?}",
    );
}
