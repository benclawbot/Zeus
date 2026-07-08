# Pi-to-Rust Zeus engine: self-review, implemented slice, and follow-up plan

## Self-critique of the first plan

The first plan was directionally right but too broad for one safe implementation pass. It mixed three different jobs:

1. defining the Rust engine contract,
2. replacing the provider/tool-call loop,
3. replacing persistence and recovery.

Doing all three at once would make debugging difficult and would risk breaking the current usable legacy loop. The revised approach is staged: first make the Rust side own concrete engine types and tool execution seams, then move provider-native turns into that seam, then persist durable sessions and recovery.

The other issue in the first plan was that it treated workspace boundaries as still meaningful. The current product direction is different: Zeus should be able to access anything anywhere for now. This pass therefore disables workspace path boundaries and makes `workspaceDir` only a relative-path anchor.

## Implemented in this slice

- Added `src-tauri/src/engine/mod.rs` as a real Rust engine foundation.
- Added typed engine health, event, queue, phase, tool manifest, follow-up milestone, and batch tool execution structures.
- Added `agent_engine_health`, `agent_engine_follow_up_plan`, and `agent_engine_execute_tools` Tauri commands.
- Routed engine tool execution through existing Zeus Rust backends instead of frontend-only text parsing.
- Preserved the existing legacy frontend observe/replan loop while the provider-native loop is built.
- Disabled workspace path boundaries: absolute paths and `..` traversal are allowed for every access mode.
- Updated frontend tool instructions to tell the model that filesystem access is unrestricted.
- Added a frontend typed wrapper in `src/providers/agentEngine.ts`.
- Added Rust and TypeScript tests covering the new foundation and unrestricted-path assumptions.

## What this slice deliberately does not claim

This is not yet the full Pi-style provider-native agent loop. The legacy frontend fenced-tool loop still exists and remains the default chat path. This slice creates the Rust-side boundary that the full loop will use next.

## Follow-up implementation plan

### 1. Provider-native tool calls

Outcome: model responses produce structured tool calls consumed by Rust, not fenced markdown parsed in `registry.ts`.

Files:

- `src-tauri/src/providers/mod.rs`
- `src-tauri/src/providers/minimax.rs`
- `src-tauri/src/providers/openai.rs`
- `src-tauri/src/providers/anthropic.rs`
- `src-tauri/src/engine/model.rs`
- `src-tauri/src/engine/loop.rs`
- `src/providers/registry.ts`

Acceptance:

- provider request includes tool schemas from `engine::tool_manifest()`
- assistant tool calls become `AgentEngineToolCall`
- no frontend parsing required for the new path
- legacy fenced path remains behind a feature flag

### 2. Rust agent loop and event stream

Outcome: Rust owns the turn loop: provider request, assistant message, tool execution, tool result messages, next provider request, abort, and final answer.

Files:

- `src-tauri/src/engine/loop.rs`
- `src-tauri/src/engine/events.rs`
- `src-tauri/src/engine/messages.rs`
- `src-tauri/src/engine/harness.rs`
- `src/providers/agentEngine.ts`
- `src/state/harness.ts`

Acceptance:

- emits `agentStart`, `turnStart`, `messageStart`, `toolExecutionStart`, `toolExecutionEnd`, `turnEnd`, `savePoint`, `settled`
- sequential and parallel tool modes work
- truncated/incomplete tool calls do not execute
- abort cancels provider and tool execution

### 3. Approval as the single gate

Outcome: all risky execution goes through one Rust gate before any tool runs.

Files:

- `src-tauri/src/engine/approval_gate.rs`
- `src-tauri/src/agent_runtime.rs`
- `src-tauri/src/workspace.rs`
- `src/providers/approvals.ts`
- approval UI components

Acceptance:

- every local write, shell, dependency, network, destructive, or privileged action creates or consumes `PendingApproval`
- `ApprovedOnce` is consumed exactly once
- `ApprovedForSession` persists for the session
- legacy `approved: bool` is compatibility-only

### 4. Durable session tree

Outcome: sessions become append-only, recoverable, and branchable, following Pi's session model but stored in Zeus SQLite.

Files:

- `src-tauri/src/persistence.rs`
- `src-tauri/src/engine/session_log.rs`
- `src-tauri/src/engine/recovery.rs`
- `src/providers/sessions.ts`

Acceptance:

- append message/tool/approval/queue/savepoint entries
- maintain leaf pointer
- restore interrupted turns as interrupted, not silently completed
- existing `messages_json` sessions remain readable

### 5. Compaction, branch summaries, and retry policy

Outcome: long sessions can compact safely and recover without losing tool history.

Files:

- `src-tauri/src/engine/compaction.rs`
- `src-tauri/src/engine/recovery.rs`
- `src-tauri/src/engine/harness.rs`

Acceptance:

- compaction summary is persisted as an entry
- branch summary is persisted as an entry
- retry only re-runs idempotent tools
- non-idempotent interrupted tools become error observations

### 6. Frontend cutover

Outcome: the UI renders the Rust engine event stream directly.

Files:

- `src/providers/registry.ts`
- `src/providers/agentEngine.ts`
- `src/components/ToolRunPanel.tsx`
- `src/components/AgentProgressBubble.tsx`
- `src/state/harness.ts`

Acceptance:

- tool progress panel is driven by Rust events
- approval queue continues a blocked Rust turn
- plan panel is empty for a new session and fills from real events
- legacy mode can still be toggled for rollback

## Rollback

- The legacy `dispatchChat` loop remains intact.
- The new engine commands are additive.
- Session schema is not destructively changed in this slice.
- To rollback this slice, remove `src-tauri/src/engine`, the three command registrations in `lib.rs`, and revert the path-boundary behavior in `workspace.rs`/`policy.rs`.
