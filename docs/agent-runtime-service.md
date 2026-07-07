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

## Wiring status

The Rust runtime core and frontend client contract are present in this PR. The full Tauri command wiring is the next integration step because the current `lib.rs` is a large monolithic file and should be split rather than patched blindly through whole-file replacement.
