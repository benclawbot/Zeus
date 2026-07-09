# Zeus — Agent Conventions

This is a Tauri 2 + React 18 + TypeScript + Rust coding-agent harness. The
`skills/` directory is the runtime catalog the *shipped* Zeus app uses to
inject guidance into model calls; it is not the agent's own skill set.

## Project shape

- Frontend: `src/` — React + TypeScript, strict mode, vitest.
- Backend: `src-tauri/src/` — Rust 1.95, Tauri 2, SQLite (rusqlite).
- Bridge: Tauri commands in `src-tauri/src/agent_runtime_commands.rs`
  exposed to React via `src/providers/agentRuntime.ts`.
- Patch engine: `src-tauri/src/patch.rs` — multi-file transactional
  unified-diff applier.
- Agent loop: `src-tauri/src/agent_runtime.rs` owns sessions, plans,
  tool runs, approvals, browser sessions, memory, and code-search
  observations. The bounded observe-and-replan driver is mirrored in
  `src/agentRuntimeDeepLoop.ts`.
- Runtime policy (access modes, command classes, approval gates):
  `src-tauri/src/policy.rs`. The Rust types are mirrored in
  `src/providers/workspace.ts` for the tool-run panel.

## Process

1. **Read before edit.** Touched files only; check callers, not just the
   function being changed. Bug fix = root cause, not symptom.
2. **Build incrementally.** One logical change at a time, verify with
   `npm run typecheck && npm test && npm run build`, then move on.
3. **Match stated to actual.** If a config file, env example, README
   badge, or capability guard disagrees with what the code actually
   does, fix the doc, not the code. Drift is a process smell.
4. **No side-loaded scripts.** Every UI change goes through React. If
   the inspector needs a runtime plan, extract a component. If a panel
   needs DOM patching, fix the component.
5. **Use the patch engine for multi-file edits.** Single-file edits are
   fine via the IDE; multi-file changes route through `apply_patch`
   with `expectedText` guards. Do not "force-add past `.gitignore`"
   tracked files; either commit them properly or drop the rule.
6. **Tests alongside logic.** New helper or behavior change gets a
   `*.test.ts(x)` next to the file. One failing test is enough to
   start; passing tests stay passing.
7. **Pre-commit verification (mandatory):**
   - `npm run typecheck` — clean
   - `npm test` — all green
   - `npm run build` — clean
   - `bash scripts/check-tauri-capabilities.sh` — passes
   - `git diff --stat` — review for forgotten `console.log`,
     commented-out test code, hardcoded test paths
8. **Commit message format:** `type(scope): summary` in present tense.
   `fix(chat): …`, `feat(harness): …`, `chore: …`, `refactor(app): …`.
   One logical change per commit.

## Where things live

| To change … | Look in … |
|---|---|
| A new Tauri command (Rust → TS bridge) | `src-tauri/src/agent_runtime_commands.rs` + `src/providers/agentRuntime.ts` + the matching TypeScript types in the same file |
| A new slash command | `src/providers/slash.ts` (the picker) + the dispatcher in `src/App.tsx` |
| A new skill category | `skills/<Category>/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`); the runtime auto-discovers from `ZEUS_SKILLS_DIR` or the bundled `skills/` resource |
| Access-mode policy | `src-tauri/src/policy.rs` (Rust) — the binary allow/deny gate |
| Command classification (Safe / Dependency / Network / Destructive / Privileged) | `src-tauri/src/policy.rs` — drives the Tool Run panel badge color |
| Validation failure types (workspace / argument / policy / transient / unknown) | `src-tauri/src/validation.rs` + `src/agentRuntimeDeepLoop.ts` |
| The provider dispatch table | `src/providers/registry.ts` (TS) + `src-tauri/src/providers/` (Rust trait + per-provider adapter) |
| The agent runtime state machine (HarnessProposalStatus, etc.) | `src/state/harness.ts` |
| Plan / design documents | `docs/superpowers/specs/` and `docs/superpowers/plans/` |

## Pitfalls

- `App.tsx` is still 2300+ lines. A real refactor would split it by
  view (Home, Sessions, Skills, Memory, Harness Evolution, Settings).
  Don't expand it without extracting at least the new logic into a
  component file.
- `styles.css` is 2300+ lines. Same shape — pull view-specific rules
  into per-component CSS modules or per-panel `<style>` blocks when
  you add a new panel.
- `dist/index.html` is the Vite build output; never edit it directly.
- The desktop window config is `src-tauri/tauri.conf.json`. Changing
  the `windows` block changes the launched UX.
- The CI matrix is `.github/workflows/package.yml` (macOS, Ubuntu,
  Windows). Anything Tauri-build or platform-conditional needs to be
  tested on all three.

## Done means

- `npm run typecheck` clean
- `npm test` all green
- `npm run build` clean
- `bash scripts/check-tauri-capabilities.sh` passes
- `git status` shows only the files you intended to change
- The change is explained in the diff (no "fix stuff" commits)

## Pre-commit hook

`.githooks/pre-commit` runs typecheck + vitest (changed files when supported)
+ the tauri-capability check when `src-tauri/` is touched. Enable once per
clone: `git config core.hooksPath .githooks`. The hook is opt-in so it never
breaks fresh clones, sandboxed agents, or one-off commits.
