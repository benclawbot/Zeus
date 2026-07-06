# Adaptive Harness Loops Implementation Plan

This plan maps the Zeus Harness Enhancement Spec onto the current Zeus codebase instead of introducing a parallel generic harness tree.

## Current repository anchors

- `src/App.tsx` already owns the recursive model/tool loop through `runChatTurn` and the bounded `MAX_TOOL_TURNS` guard.
- `src/providers/workspace.ts` is the frontend IPC surface for shell, read, write, edit, and agent task execution.
- `src-tauri/src/workspace.rs` already classifies shell commands and applies access-mode policy.
- `src-tauri/src/persistence.rs` already persists sessions, compact context anchors, harness proposals, access mode, and history in SQLite.
- `src-tauri/src/providers/mod.rs` already supports provider options through a free-form JSON bag, which is the right place to pass effort settings without changing every provider call site.

## Implemented in this PR

- Added `src/harness/adaptive.ts`, a production TypeScript harness core with:
  - goal termination decisions,
  - checkpoint write gating,
  - dependency-scoped checkpoint retrieval,
  - effort classification and escalation,
  - scoped approval gate decisions,
  - session-log analysis that emits reviewable harness patch proposals.
- Added `src/harness/adaptive.test.ts`, covering effort classification, checkpoint discipline, scoped checkpoint retrieval, approval gates, self-improvement proposals, and termination behavior.

## Next wiring commits

1. Feed `classifyEffort` from `runChatTurn` before provider dispatch and include the selected tier in provider options.
2. Replace the current fixed compacting behavior with checkpoint creation using `shouldCheckpoint` after successful tool runs, environment surprises, and decisions constraining future steps.
3. Add SQLite tables for `memory_checkpoints`, `effort_logs`, and `approval_queue`, then expose Tauri commands for writing and reading them.
4. Move the existing policy errors in `workspace.rs` into queueable approval decisions where the action can safely wait without blocking unrelated subtasks.
5. Run `analyzeHarnessLogs` after every N sessions and create a persisted harness proposal rather than only showing ad-hoc one-step rules.

## Acceptance checks

- Routine in-workspace reads/writes continue without new approval in Full/Local modes.
- Network, credential, spend, privileged, and destructive actions produce an explicit approval decision.
- Failed tool execution causes re-planning with the error in context, not blind retry.
- Repeated self-correction failures increase effort tier before human escalation.
- Memory checkpoint writes are sparse and read back only by declared dependency.
- Self-improvement output is a proposal, never auto-applied.
