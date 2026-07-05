# Zeus Execution Capability Contract

This document tracks the execution-related capabilities that must be explicit in code, UI, tests, and release process before Zeus can honestly describe them as production-ready.

## Fully Wired in This PR

### Guarded local shell command execution

- Rust command: `run_shell_command`.
- Frontend binding: `runShellCommand`.
- Workspace root: `ZEUS_WORKSPACE_DIR`, falling back to the current process directory.
- Safety behavior:
  - Uses structured `program + args` execution, not shell-string interpolation.
  - Runs inside a workspace-relative working directory.
  - Blocks parent traversal and absolute workspace paths.
  - Blocks destructive programs such as `rm`, `del`, `format`, `mkfs`, `dd`, `shutdown`, `reboot`, `sudo`, and `su`.
  - Captures stdout/stderr with a size cap.
  - Enforces a bounded timeout.
  - Honors access mode: `Full` and `Local` allow, `Review` requires explicit approval, `Locked` blocks.

### Repository file reading

- Rust command: `read_workspace_file`.
- Frontend binding: `readWorkspaceFile`.
- Reads only workspace-relative paths.
- Blocks parent traversal and absolute paths.
- Caps returned file size and marks truncated reads.

### Repository file writing and patch-style edits

- Rust commands: `write_workspace_file`, `apply_workspace_edit`.
- Frontend bindings: `writeWorkspaceFile`, `applyWorkspaceEdit`.
- Writes only workspace-relative paths.
- Blocks parent traversal and absolute paths.
- Requires `create=true` for new files.
- Requires `overwrite=true` or exact `expectedText` for full-file replacement.
- Supports focused text replacement through `find` / `replace`.
- Honors access mode: `Full` and `Local` allow, `Review` requires explicit approval, `Locked` blocks.

### Policy-enforced guards

The first production guard layer now exists in Rust for:

- Filesystem boundaries.
- Shell command structure.
- Destructive command blocking.
- Access-mode enforcement.
- Output/file size limits.
- Execution timeout limits.

## Scaffolded, Not Yet Complete

The following are intentionally tracked as contracts but should not be claimed as fully complete until the UI and automation surfaces are built around them.

### Autonomous code-change loops

Target behavior:

1. Plan a task.
2. Read files.
3. Apply one or more workspace edits.
4. Run tests through guarded shell execution.
5. Capture logs.
6. Summarize changed files, test output, risks, and rollback.
7. Require review before repeating or expanding blast radius.

Current status: backend primitives are present; autonomous orchestration is not yet implemented.

### Diff and log panels

Target behavior:

- Show command logs per run.
- Show stdout/stderr separately.
- Show generated file diffs before writes are approved.
- Keep an action timeline per session.

Current status: backend command results include enough structured output for a panel; dedicated UI panels are not yet implemented.

### Automatic harness-rule generation from completed sessions

Target behavior:

- Analyze completed sessions.
- Extract repeated failures or friction.
- Generate a proposed harness rule.
- Store the proposal in the harness proposal table.
- Surface it at the next session start for approval.

Current status: proposal storage and transitions exist; automatic generation is not yet implemented.

### Signed multi-platform release publishing

Target behavior:

- Build Windows, macOS, and Linux packages.
- Sign artifacts where platform credentials are configured.
- Publish release artifacts from CI.

Current status: local/package scripts exist; signed release publishing is not yet implemented.

## Rollback Expectations

Every execution feature should keep rollback practical:

- Shell commands return captured output and exit status.
- File writes require explicit create/overwrite or exact expected text.
- Focused edits report replacement count and bytes written.
- Future autonomous loops must list files touched and produce a rollback plan before applying broad changes.
