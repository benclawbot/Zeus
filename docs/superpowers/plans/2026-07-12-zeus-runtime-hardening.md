# Zeus Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the audited approval, command execution, credential, and webview security gaps while preserving Zeus's active native runtime.

**Architecture:** Remove the unused legacy execution endpoint instead of maintaining two authorization paths. Route command execution through the central policy module, drain child output concurrently, isolate credential persistence behind a backend trait, and restrict the Tauri webview with CSP.

**Tech Stack:** Rust 1.95, Tauri 2, React 18, TypeScript, Vitest, Cargo tests, OS credential services.

## Global Constraints

Preserve current access-mode semantics and the active native agent loop. Keep provider base URLs and model IDs in JSON but never return or persist raw provider keys there after successful migration. Maintain Windows, macOS, and Linux packaging. Preserve the user's existing untracked files. Do not commit without explicit user authorization.

---

### Task 1: Remove the legacy engine execution surface

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/providers/agentEngine.ts`
- Modify: `src/providers/bridge.test.ts`
- Modify: `src-tauri/src/engine/mod.rs`

**Interfaces:**
- Removes: `agent_engine_execute_tools` Tauri command and `executeAgentEngineTools` TypeScript wrapper.
- Preserves: engine health and follow-up metadata.

- [ ] Change the bridge test expectation first so `agent_engine_execute_tools` is forbidden, then run `npm test -- src/providers/bridge.test.ts` and verify it fails because the command remains registered.
- [ ] Remove `agent_engine_execute_tools` from `generate_handler!`, delete its Rust command wrapper, remove the TypeScript request/result execution API, and remove engine batch execution code that has no remaining caller.
- [ ] Run `npm test -- src/providers/bridge.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml engine::` and verify both pass.

### Task 2: Consolidate command classification

**Files:**
- Modify: `src-tauri/src/workspace.rs`
- Modify: `src-tauri/src/policy.rs`

**Interfaces:**
- Consumes: `policy::classify_command(program: &str, args: &[String]) -> CommandClass`.
- Removes: the private duplicate `workspace::classify_command`.

- [ ] Add policy regression assertions for `pkexec`, `truncate`, `nc`, `git pull`, and `git branch -D`; run `cargo test --manifest-path src-tauri/Cargo.toml policy::tests` and verify any missing classification fails.
- [ ] Import and use `policy::classify_command` in every workspace execution path, delete the duplicate classifier, and update existing workspace tests to reference the central type.
- [ ] Run the policy and workspace Rust tests and verify they pass.

### Task 3: Drain shell output without deadlock

**Files:**
- Modify: `src-tauri/src/workspace.rs`

**Interfaces:**
- Produces: a private bounded reader helper that drains any `Read + Send + 'static` stream and retains at most `MAX_CAPTURE_BYTES`.
- Preserves: `run_shell_command(ShellCommandRequest, Option<&str>) -> Result<ShellCommandResult, String>`.

- [ ] Add a regression test that runs the current test executable as a helper process producing output larger than the pipe capacity, and assert completion without timeout plus bounded output. Run it and verify it fails or times out under the old collector.
- [ ] Take stdout/stderr immediately after spawn, drain each on a reader thread, retain bounded bytes, kill and wait on timeout, join both readers, then redact and format the captured bytes.
- [ ] Run the focused shell tests and the full Rust suite.

### Task 4: Prevent provider secrets from crossing IPC or remaining in JSON

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Create: `src-tauri/src/credentials.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/providers/providers.ts`

**Interfaces:**
- Produces: `CredentialStore` trait with `get`, `set`, and `delete` operations and an OS-backed implementation.
- Changes: `set_provider_keys(...) -> Result<ProviderKeysStatus, String>`.
- Preserves: non-secret provider settings in `provider-keys.json` and legacy-key fallback until successful migration.

- [ ] Add unit tests using an in-memory credential backend for save, clear, status-only return, successful migration, and failed migration retaining legacy JSON; run them and verify they fail before the new module exists.
- [ ] Add the maintained cross-platform credential dependency, implement the backend abstraction, and connect provider-key loading and saving through it.
- [ ] Migrate legacy JSON keys transactionally: write credentials first, rewrite only non-secret settings after all writes succeed, and retain legacy fields on failure.
- [ ] Return only `ProviderKeysStatus` from the Tauri command and update TypeScript typing/documentation.
- [ ] Run focused credential tests, the full Rust suite, TypeScript tests, and `cargo clippy --all-targets -- -D warnings`.

### Task 5: Enable CSP and complete verification

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `scripts/check-tauri-capabilities.sh` only if its baseline intentionally covers CSP.

**Interfaces:**
- Produces: production CSP with `default-src 'self'`, no objects or frames, and only Tauri-required script/style/image sources.

- [ ] Replace `csp: null` with the restrictive policy and run the production build plus Tauri configuration validation.
- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `bash scripts/check-tauri-capabilities.sh`, and `npm audit --json`.
- [ ] Review `git diff --stat`, `git diff --check`, and `git status --short`; confirm only intended changes plus the pre-existing untracked files remain.
