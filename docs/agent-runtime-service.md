# AgentRuntime service

This PR moves Zeus toward a persistent Rust runtime boundary for agent orchestration.

## Runtime ownership

The runtime owns sessions, active plans, tool-run records, approvals, browser sessions, project memories, and structured code-search observations.

## Approval queue

The runtime approval model uses `PendingApproval` objects with:

- risk class;
- human-readable action labels;
- affected files;
- optional diff preview;
- status: pending, approved once, rejected, or approved for session.

Model-generated tool blocks should become pending approvals before risky execution.

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

The current module establishes the provider/session/result contract. A Playwright adapter can back the contract with DOM snapshots and artifacts.

## Memory sidecar

The first implementation is project-scoped retrieval with source/provenance, tags, stale flags, and supersession links. Retrieval is deterministic lexical matching for now so it is local and testable.

## Structured code search

`search_code` scans source files and returns path, line number, snippet, nearest detected symbol, and whether the file was already read.

## Command bridge and bootstrap registration

`src-tauri/src/agent_runtime_commands.rs` contains the Tauri command bridge for health, status, sessions, plans, approvals, browser actions, memory, and structured search.

`src-tauri/src/lib.rs` now wires that bridge into the actual app bootstrap:

- declares `mod agent_runtime;` and `mod agent_runtime_commands;`;
- imports `AgentRuntimeService`;
- creates `agent-runtime.json` beside `zeus.db` during setup;
- registers the runtime with `app.manage(runtime)`;
- exposes the runtime bridge commands through `tauri::generate_handler!`.

The React runtime client can now call the runtime commands from the desktop app.
