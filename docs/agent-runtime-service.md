# AgentRuntime service

This PR introduces the first production boundary for moving Zeus orchestration out of React and into a persistent Rust runtime service.

## Runtime ownership

The runtime owns:

- sessions and their active plans;
- tool-run records and transcript notes;
- pending approvals with risk class, affected files, and diff previews;
- browser sessions and semantic browser-tool actions;
- project-scoped memories with provenance, stale flags, and supersession links;
- structured code-search observations, including whether a file was already read by the agent.

The immediate shape is a persisted JSON-backed Rust state store. It is intentionally designed so the backing store can move to SQLite without changing the frontend client contract.

## Approval queue

The old `approved?: boolean` pattern is not enough for model-generated actions. The runtime approval model uses `PendingApproval` objects:

- `riskClass`: read-only, local write, shell, network, dependency, browser, or destructive;
- `actionLabels`: human-readable action list;
- `affectedFiles`: files expected to change or be read;
- `diffPreview`: optional preview before applying writes;
- `status`: pending, approved once, rejected, or approved for session.

The UI should render this queue as the Review-mode gate. Explicit human slash commands may still pass approval intent directly, but model-generated tool blocks should become `PendingApproval` items before execution.

## Semantic browser tool

The browser surface is modeled as one semantic tool with these actions:

- `browser.status`
- `browser.open`
- `browser.snapshot`
- `browser.click`
- `browser.type`
- `browser.screenshot`
- `browser.eval`
- `browser.run_test`

The current Rust module establishes the provider/session/result contract. The next wiring step is to connect these commands to a Playwright adapter process that returns normalized DOM snapshots and artifacts.

## Memory sidecar

The runtime memory starts as project-scoped retrieval with source/provenance, tags, stale flags, and supersession links. Retrieval is currently deterministic lexical matching so it runs locally and is testable. The design intentionally leaves room for embeddings and a relevance sideagent later, without requiring a graph/cascade memory system on day one.

## Structured code search

`search_code` scans source files and returns:

- path;
- line number;
- snippet;
- nearest detected function/class/symbol;
- whether the file was already read.

This is meant to reduce blind full-file reads and give the planner a cheaper exploration tool.

## Command bridge

`src-tauri/src/agent_runtime_commands.rs` now contains the Tauri command bridge for the runtime service:

- `agent_runtime_health`
- `agent_runtime_status`
- `agent_runtime_open_session`
- `agent_runtime_define_plan`
- `agent_runtime_create_approval`
- `agent_runtime_list_approvals`
- `agent_runtime_resolve_approval`
- `agent_runtime_browser_tool`
- `agent_runtime_upsert_memory`
- `agent_runtime_retrieve_memories`
- `agent_runtime_search_code`

The bridge expects `AgentRuntimeService` to be managed by the Tauri app and returns a clear error if that state has not been registered.

## Bootstrap registration

The bridge is code-complete, but the current monolithic `src-tauri/src/lib.rs` still needs a small registration patch to make the commands callable from React:

```rust
mod agent_runtime;
mod agent_runtime_commands;

use agent_runtime::AgentRuntimeService;
```

In setup, after `zeus.db` is initialized:

```rust
let runtime_path = db_path.with_file_name("agent-runtime.json");
let runtime = AgentRuntimeService::load_or_create(runtime_path)
    .map_err(|e| -> Box<dyn std::error::Error> { format!("runtime: {e}").into() })?;
app.manage(runtime);
```

And in `tauri::generate_handler!`:

```rust
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
```

The connector available here only supports whole-file replacement for existing files. I added the bridge and client rather than blindly replacing `lib.rs`, because an imprecise replacement of the app bootstrap would risk breaking existing provider/session/tool wiring.
