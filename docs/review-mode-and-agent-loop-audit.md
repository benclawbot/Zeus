# Review mode and agent-loop audit

## Approval gate status

The approval concern still partially applies.

Explicit slash commands now carry approval intent through the frontend workspace provider. Calls such as `/run`, `/write`, and `/edit` use the direct helper functions, and those helpers default `approved` to true because the human submitted the command in the composer.

Agent-generated tool blocks still do not have a dedicated review dialog. `runAgentTask` preserves `request.approved` and does not auto-approve generated steps. This is safer than silently bypassing Review mode, but it means Review mode still needs a real approval UI before generated write/shell steps can run smoothly.

Git operations need backend cleanup as well. The frontend now sends `approved: true` for explicit git commands, but the Rust `GitOperationRequest` does not yet model that field, so mutating git policy should be hardened on the Rust side in a follow-up.

## Agent loop status

The backend statement still applies: `run_agent_task` executes a pre-built list of `AgentStepRequest` values sequentially. It is an executor, not a backend ReAct loop.

The frontend does run a bounded observe-and-replan loop: `runChatTurn` asks the model for a tool block, executes it, summarizes the result, then recursively re-prompts the model so it can choose another tool block or produce a final answer. That means the agent is not purely one fixed script, but the autonomy lives in the frontend orchestration rather than in Rust.

## Recommended next backend work

1. Normalize `.` and `./` to the workspace root in Rust `resolve_workspace_path` / directory resolution, not only in the frontend.
2. Add an `approved` field to `GitOperationRequest` and enforce it for mutating git operations in Review mode.
3. Add a structured approval queue for model-generated tool blocks: requested steps, risk class, expected files touched, approve-once / reject / edit-plan actions.
4. Keep Rust as a guarded executor, but expose richer observation envelopes so the frontend ReAct loop can make better next-step decisions.
