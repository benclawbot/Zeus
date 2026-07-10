# Zeus Native Coding Agent Repair — Design

## Status

Approved for implementation on 2026-07-10. This design replaces the legacy frontend fenced-tool loop; it is not retained as a compatibility or rollback path.

## Goal

Make Zeus a trustworthy, end-to-end coding agent whose Rust runtime owns provider turns, structured tool calls, approvals, persistence, browser automation, and recovery while the React application renders typed runtime events.

## Context

The audit found a functional browser capability that has no driver script, approval records that do not gate workspace execution, divergent runtime and memory implementations, collision-prone timestamp IDs, bridge-contract drift, and a Rust backend that cannot pass strict Clippy. The existing `engine` module intentionally exposes only a typed foundation and batch executor; chat still relies on frontend parsing of provider-emitted fenced tool blocks. That split leaves the documented agent runtime and the actual execution path inconsistent.

The Claude inspection identified the browser, approval, redaction, and duplicate-memory risks. Its claim that the runtime service is not managed is obsolete: `lib.rs` now creates and manages `AgentRuntimeService` and registers its command bridge. Pi's engine inspection correctly identifies the remaining gap: provider-native tool calls, a durable Rust turn loop, event streaming, approval continuation, and recovery have not been implemented.

## Decision

Zeus will have one production execution path: a Rust-owned agent loop. Provider adapters will return typed assistant messages and structured tool calls; the Rust loop will validate and authorize every call, execute it through the guarded workspace services, persist a typed event log, then send typed tool-result messages back to the provider. React will invoke the native run command and render emitted events. The legacy TypeScript fenced-tool parser and recursive observe-and-replan loop will be removed once the native path is covered by equivalent tests.

The engine is not a second runtime. Its types, tool manifest, execution policy, events, session records, and persistence will become the canonical implementation. The existing `AgentRuntimeService` is retained only as the durable runtime state owner while its duplicate memory and approval representations are consolidated into the canonical engine types.

## Architecture

### Native turn loop

`src-tauri/src/engine/` gains focused modules for model messages, provider tool schemas, loop control, events, session persistence, recovery, and the approval gate. A run starts with a session ID, project root, provider selection, model messages, access mode, and bounded autonomy settings. It emits `agentStart`, `turnStart`, message, tool, approval, save-point, terminal, and failure events in order.

Provider adapters accept an engine request and return either final assistant content or a list of typed `AgentEngineToolCall` values. The loop rejects incomplete or malformed calls before execution. It applies the tool manifest and policy before passing a call to workspace, browser, search, patch, or GitHub services. Tool results contain typed validation failures rather than frontend-parsed prose. The loop stops on a final answer, user abort, terminal policy denial, or configured turn/correction budget.

### Single approval gate

Every non-read-only operation receives a runtime-created approval ID. The runtime consumes `ApprovedOnce` exactly once or validates `ApprovedForSession` against the current session before the operation is executed. A caller-provided `approved: bool` no longer authorizes an operation. Git, writes, edits, patches, commands, tests with side effects, browser evaluation, dependency installs, and GitHub mutations all pass through the same gate.

The approval event includes tool name, risk class, normalized arguments, expected files, rollback information where available, and a diff preview for file changes. The UI can approve once, approve for the session, reject, or abort the run; approval resumes the blocked native turn rather than launching a second independent operation.

### Browser automation

`scripts/zeus-browser-driver.mjs` implements the existing JSON-lines protocol: it prints a ready event, accepts a request with an ID and semantic action, and returns a matching structured result. It uses Playwright for status, open, snapshot, click, type, screenshot, safe evaluation, and test execution. Browser sessions track their URL, snapshots, and artifact paths in the runtime. The driver is included as a Tauri resource and its availability is verified before Zeus advertises browser capability.

### Durable state and recovery

Runtime events are appended to SQLite as session entries instead of duplicating state across ad-hoc JSON and SQLite stores. Existing JSON transcript sessions remain readable through a migration adapter, then new turns write the normalized log. A save point is recorded after each completed tool result. Interrupted idempotent reads may be retried; incomplete writes, commands, browser actions, Git operations, and GitHub mutations become error observations that require an explicit new decision.

Project memory has one storage API, one typed ID generator, one retrieval scorer, and one frontend client. IDs are collision-resistant rather than timestamp-only. Superseded and stale memories never rank above active ones, and memory injection includes provenance and relevance reasons.

### Security and secret handling

LLM output is treated as untrusted input. Every tool argument remains schema-validated in Rust. Every model-visible result, including file reads, diffs, shell/test/Git output, browser values, and error observations, is passed through the existing secret redactor. Command capture is bounded per output stream with timeout-aware readers so a noisy process cannot deadlock the loop. Command classification handles shell interpreters and mutating Git configuration as risky operations.

The webview receives a production CSP and Markdown rendering is covered by malicious-HTML tests. No provider credential, environment secret, or arbitrary local credential file is sent to a model in clear text.

### Frontend cutover and deletion

`src/providers/agentEngine.ts` becomes the client for native run, abort, approval, and event subscription commands. `AgentProgressBubble`, tool results, plans, and approvals consume typed events. `src/providers/toolDispatch.ts`, `src/providers/toolBlockParser.ts`, and the legacy chat recursion are deleted rather than hidden behind a flag. README and runtime docs describe only the native path.

Dead-code removal follows proof, not appearance: a symbol is removed only after Rust command registration, TypeScript import/use analysis, tests, documentation, and history establish that it has no active responsibility. Public commands that are useful but not yet surfaced are either wired to a typed client or removed together with their docs and tests. Strict Clippy is the mechanical guard against unused imports, variables, fields, and private APIs.

## Alternatives rejected

### Repair the fenced-tool loop only

This would make browser execution and individual tool operations work sooner, but it would keep tool parsing, retry logic, safety decisions, and event state split across TypeScript and Rust. It does not satisfy the documented native harness design and leaves two sources of truth.

### Keep the legacy loop as a fallback

Rejected by the user. Maintaining two execution models doubles security review, state synchronization, test matrices, and future maintenance. The native loop must reach the acceptance criteria before cutover; it will not ship with a second path.

### Rewrite Zeus from scratch

Rejected because its provider adapters, workspace execution, patch engine, sessions UI, and tests are valuable. Incremental replacement around typed interfaces has lower migration risk and produces verifiable checkpoints.

## Delivery slices

1. Restore correctness and safety foundations: browser driver, bridge parity, collision-free IDs, one memory API, secret redaction, bounded command capture, typed failures, single approval gate, and strict Rust hygiene.
2. Implement typed provider messages/tool calls and the bounded Rust turn loop with persistence, event delivery, cancellation, and approval continuation.
3. Cut React over to native events and delete fenced-tool parsing and recursive frontend orchestration.
4. Harden and streamline: recovery, compaction, durable session migration, code-index caching, CSP/Markdown tests, sidecar/package CI, documentation accuracy, and dead-code removal.

Each slice is independently tested and committed. Slices two and three are intentionally sequential: no frontend cutover happens before a native run can complete a real coding task.

## Acceptance criteria

- A configured provider completes a multi-turn coding task using structured native tool calls; no fenced tool block is parsed or executed by the frontend.
- A read, edit, test, browser verification, and final response produce ordered durable events and restore correctly after an app restart.
- Risky actions cannot run without a valid approval ID; an approved-once ID fails on reuse and a rejected ID never runs.
- Browser status, open, snapshot, click/type, screenshot, and test actions run through the shipped driver and return artifacts without leaking credentials.
- File reads, diffs, command output, Git output, test output, browser output, and provider errors redact recognized secrets before reaching the model or UI.
- Memory upserts cannot overwrite distinct records created within the same millisecond; retrieval favors active, relevant, non-superseded records.
- The legacy tool parser, dispatcher, and recursive loop are absent from production source and documentation.
- `npm run typecheck`, `npm test`, `npm run build`, `bash scripts/check-tauri-capabilities.sh`, `cargo fmt --check`, `cargo test --all-targets`, `cargo clippy --all-targets -- -D warnings`, the Tauri package build, browser smoke tests, and the live end-to-end agent verification all pass.

## Scope boundaries

This work does not add a new provider, billing system, cloud synchronization, multi-user identity, or a generic plugin marketplace. GitHub verification uses the user-authorized local account and repository state; it does not modify unrelated repositories. Existing untracked `artifacts/` remain untouched.
