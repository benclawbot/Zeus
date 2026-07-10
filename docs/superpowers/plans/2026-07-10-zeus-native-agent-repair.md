# Zeus Native Coding Agent Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Zeus's frontend-parsed tool loop with one durable, approval-gated Rust coding-agent runtime that completes real provider, workspace, browser, and GitHub tasks safely.

**Architecture:** Rust owns provider messages, structured tool calls, loop state, authorizations, persistence, and typed events. React invokes a native run and renders event state. The Playwright browser driver is a shipped JSON-lines sidecar. The legacy fenced-tool parser and recursive frontend loop are deleted after the native path reaches equivalent end-to-end coverage.

**Tech Stack:** Tauri 2, Rust 1.95, rusqlite, reqwest, React 18, TypeScript, Vitest, Playwright, Node 22, GitHub CLI.

## Global Constraints

- Preserve the existing untracked `artifacts/` directory and do not stage it.
- The native Rust loop is the only production path; do not retain a legacy compatibility or rollback path.
- Every non-read-only action must consume a runtime approval ID before the executor runs it.
- Treat provider output, web content, browser values, files, and command output as untrusted data; redact secrets before returning model-visible observations.
- Add a failing regression test before each behavior change and prove the red-to-green transition.
- Do not add dependencies unless the existing Rust, Node, and Playwright stack cannot meet the requirement.
- Keep every slice compilable and run the repository's full verification gate after a touched layer changes.

---

## File structure

| Path | Responsibility after this repair |
|---|---|
| `src-tauri/src/engine/model.rs` | Provider-neutral request, assistant response, structured tool-call, and tool-result message types. |
| `src-tauri/src/engine/events.rs` | Serializable native agent lifecycle events and stable event names consumed by React. |
| `src-tauri/src/engine/approval_gate.rs` | The sole runtime approval check and one-shot consumption policy. |
| `src-tauri/src/engine/loop.rs` | Bounded native provider/tool/observation loop, cancellation, and event persistence. |
| `src-tauri/src/engine/session_log.rs` | Append-only SQLite records, save points, interrupted-turn restoration, and migration adapter. |
| `src-tauri/src/engine/mod.rs` | Tool manifest and guarded tool execution wired into the loop modules. |
| `src-tauri/src/agent_runtime.rs` | Canonical runtime session, approval, browser-session, and memory state; no duplicate mutable APIs. |
| `src-tauri/src/workspace.rs` | Validated, redacted, output-bounded executor implementations. |
| `src-tauri/src/providers/*.rs` | Provider adapters that translate native model messages and tool schemas. |
| `src-tauri/src/agent_runtime_commands.rs` | Tauri command surface for native runs, events, aborts, and approval continuation. |
| `src/providers/agentEngine.ts` | Typed React client for native runs, events, aborts, and approvals. |
| `src/state/harness.ts` | Reducer state derived from native events instead of frontend loop guesses. |
| `src/views/HomeView.tsx` and related components | Composer, progress, plan, approval, and browser state backed by native events. |
| `scripts/zeus-browser-driver.mjs` | Shipped JSON-lines Playwright driver. |

## Task 1: Establish regression coverage and remove bridge/memory drift

**Files:**

- Modify: `src-tauri/src/memory.rs:105-175`
- Modify: `src-tauri/src/agent_runtime.rs:473-561`
- Modify: `src-tauri/tests/bridge_integration.rs:1-130`
- Modify: `src-tauri/src/lib.rs:1529-1585`
- Create: `src-tauri/tests/runtime_contract.rs`

**Interfaces:**

- Consumes: `MemoryStore::upsert`, `AgentRuntimeService::create_approval`, and `tauri::generate_handler!` registration.
- Produces: collision-resistant `MemoryId` and `ApprovalId` values plus a contract test that understands module-qualified handlers.

- [ ] **Step 1: Write failing collision and bridge tests**

```rust
#[test]
fn upserting_distinct_blank_id_memories_keeps_both_records() {
    let store = MemoryStore::load_or_create(temp_path()).unwrap();
    store.upsert(memory_with_blank_id("first")).unwrap();
    store.upsert(memory_with_blank_id("second")).unwrap();
    assert_eq!(store.list(Some("zeus")).len(), 2);
}

#[test]
fn module_qualified_registered_commands_match_command_annotations() {
    let handlers = registered_handler_names(include_str!("../src/lib.rs"));
    let commands = command_names_from_sources(&["../src/lib.rs", "../src/agent_runtime_commands.rs"]);
    assert!(handlers.is_subset(&commands));
}
```

- [ ] **Step 2: Run the focused tests and verify the expected red state**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml upserting_distinct_blank_id_memories_keeps_both_records -- --exact`

Expected: FAIL because two blank IDs can share the same millisecond timestamp.

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test bridge_integration`

Expected: FAIL because the current text-only contract cannot resolve module-qualified handlers.

- [ ] **Step 3: Add monotonic collision-safe ID allocation and accurate registration discovery**

```rust
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(0);

fn new_runtime_id(prefix: &str) -> String {
    let sequence = NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{sequence}", Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

if memory.id.trim().is_empty() {
    memory.id = new_runtime_id("memory");
}
```

Replace the bridge test's single-file regex with source-aware extraction that parses both `lib.rs` and `agent_runtime_commands.rs`, normalizes `agent_runtime_commands::name` to `name`, and fails only for actual registration drift. Register `agent_runtime_github_workflow_log` if the command remains public; otherwise remove its type, implementation, tests, and documentation in the dead-code task.

- [ ] **Step 4: Run focused tests and strict formatter**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: PASS.

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test bridge_integration`

Expected: PASS.

- [ ] **Step 5: Commit the isolated regression repair**

```powershell
git add src-tauri/src/memory.rs src-tauri/src/agent_runtime.rs src-tauri/tests/bridge_integration.rs src-tauri/tests/runtime_contract.rs src-tauri/src/lib.rs
git commit -m "fix(runtime): make ids collision-safe and bridge contracts accurate"
```

## Task 2: Ship the Playwright browser driver

**Files:**

- Create: `scripts/zeus-browser-driver.mjs`
- Modify: `src-tauri/src/agent_runtime.rs:286-376,614-700`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `scripts/browser-smoke.mjs`
- Create: `src-tauri/tests/browser_driver.rs`

**Interfaces:**

- Consumes: `BrowserToolRequest` and the existing Rust JSON-lines request framing.
- Produces: one JSON response per `{ id, action, sessionId, url, selector, text, script, testCommand, artifactPath, options }` request and a `{"kind":"ready"}` startup frame.

- [ ] **Step 1: Write a failing protocol test and smoke fixture**

```rust
#[test]
fn browser_driver_is_packaged_and_status_is_available() {
    let script = browser_driver_script_path();
    assert!(script.is_file(), "missing browser driver: {}", script.display());
    let service = AgentRuntimeService::load_or_create(temp_runtime_path()).unwrap();
    let result = service.browser_tool(BrowserToolRequest::status());
    assert!(result.unwrap().ok);
}
```

```javascript
const response = await requestDriver({ action: "open", sessionId: "smoke", url: target });
assert.equal(response.ok, true);
assert.match(response.snapshot, /<body/i);
```

- [ ] **Step 2: Run the browser-driver test and verify it fails**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml browser_driver_is_packaged_and_status_is_available -- --exact`

Expected: FAIL because `scripts/zeus-browser-driver.mjs` does not exist.

- [ ] **Step 3: Implement the driver and package it**

```javascript
import readline from "node:readline";
import { chromium } from "playwright";

process.stdout.write(`${JSON.stringify({ kind: "ready", provider: "playwright" })}\n`);
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  const result = await handleBrowserRequest(request);
  process.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`);
}
```

`handleBrowserRequest` must validate every action, preserve browser contexts by `sessionId`, write screenshots only under the requested approved artifact path, and return structured errors rather than writing diagnostics to stdout. Add the script to Tauri resources so installed builds resolve the same file as development.

- [ ] **Step 4: Prove protocol, smoke, and packaged path**

Run: `npm run browser:smoke`

Expected: PASS with an open/snapshot/screenshot result.

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml browser_driver_is_packaged_and_status_is_available -- --exact`

Expected: PASS.

- [ ] **Step 5: Commit the browser capability**

```powershell
git add scripts/zeus-browser-driver.mjs scripts/browser-smoke.mjs src-tauri/src/agent_runtime.rs src-tauri/tauri.conf.json src-tauri/tests/browser_driver.rs
git commit -m "feat(browser): ship the native Playwright driver"
```

## Task 3: Make runtime approval the only execution gate

**Files:**

- Create: `src-tauri/src/engine/approval_gate.rs`
- Modify: `src-tauri/src/engine/mod.rs:224-420`
- Modify: `src-tauri/src/workspace.rs:1-1100`
- Modify: `src-tauri/src/agent_runtime.rs:473-535`
- Modify: `src-tauri/src/agent_runtime_commands.rs:149-205`
- Create: `src-tauri/tests/approval_gate.rs`

**Interfaces:**

- Consumes: `AgentRuntimeService::check_approval(id, consume_one_shot)` and `policy::authorize_command`.
- Produces: `ApprovalGate::authorize(session_id, approval_id, operation) -> Result<ApprovalGrant, ValidationFailure>`.

- [ ] **Step 1: Write failing approval-reuse and Git review-mode tests**

```rust
#[test]
fn approved_once_id_cannot_authorize_a_second_write() {
    let approval = approved_once("session-1");
    assert!(gate.authorize("session-1", Some(&approval.id), write_operation()).is_ok());
    assert_eq!(gate.authorize("session-1", Some(&approval.id), write_operation()).unwrap_err().kind, FailureKind::Policy);
}

#[test]
fn review_mode_git_push_requires_an_approval_id() {
    let result = run_git_operation(git_push_request(None), Some("Review"));
    assert!(matches!(result, Err(message) if message.contains("approval")));
}
```

- [ ] **Step 2: Run the focused tests and verify the expected red state**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test approval_gate`

Expected: FAIL because workspace executors only inspect the legacy boolean and Git requests have no approval field.

- [ ] **Step 3: Thread `session_id` and `approval_id` through every risky request**

```rust
pub struct GitOperationRequest {
    pub workspace_dir: Option<String>,
    pub args: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub session_id: String,
    pub approval_id: Option<String>,
}

fn require_approval(gate: &ApprovalGate, request: &ExecutionRequest, risk: CommandClass) -> Result<(), ValidationFailure> {
    if risk.is_read_only() { return Ok(()); }
    gate.authorize(&request.session_id, request.approval_id.as_deref(), request.operation())?;
    Ok(())
}
```

Remove `approved` from new request types. Apply `require_approval` before write, edit, patch, command, test, Git, browser evaluation, dependency, and GitHub mutations. `ApprovedForSession` must match the same session ID; `ApprovedOnce` must be persisted as consumed before execution starts.

- [ ] **Step 4: Run approval, workspace, and runtime integration tests**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test approval_gate --test agent_runtime`

Expected: PASS.

- [ ] **Step 5: Commit the authorization cutover**

```powershell
git add src-tauri/src/engine/approval_gate.rs src-tauri/src/engine/mod.rs src-tauri/src/workspace.rs src-tauri/src/agent_runtime.rs src-tauri/src/agent_runtime_commands.rs src-tauri/tests/approval_gate.rs
git commit -m "fix(policy): require runtime approvals for every risky tool"
```

## Task 4: Make tool observations typed, bounded, and secret-safe

**Files:**

- Modify: `src-tauri/src/validation.rs`
- Modify: `src-tauri/src/workspace.rs`
- Modify: `src-tauri/src/policy.rs`
- Modify: `src-tauri/src/patch.rs`
- Modify: `src-tauri/src/web_search.rs`
- Modify: `src/agentRuntimeDeepLoop.ts`
- Create: `src-tauri/tests/tool_observation_safety.rs`
- Create: `src/agentRuntimeDeepLoop.test.ts`

**Interfaces:**

- Consumes: `ValidationFailureKind::{Workspace, Argument, Policy, Transient, Unknown}` and `policy::redact_secrets`.
- Produces: `ToolObservation { kind, message, content, truncated, suggestion }` returned from every executor.

- [ ] **Step 1: Write failing redaction, stream-bound, CRLF, and failure-kind tests**

```rust
#[test]
fn file_reads_redact_provider_credentials_before_observation() {
    let result = read_workspace_file(secret_file_request(), Some("Full")).unwrap();
    assert!(!result.content.contains("sk-live-secret"));
    assert!(result.content.contains("[REDACTED:"));
}

#[test]
fn crlf_patch_preserves_the_dominant_line_ending() {
    apply_patch_to("one\r\ntwo\r\n", "@@ -1,2 +1,2 @@\n one\n-two\n+three\n");
    assert_eq!(read_output(), "one\r\nthree\r\n");
}
```

- [ ] **Step 2: Run focused tests and verify the expected red state**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test tool_observation_safety`

Expected: FAIL because file content and several observations bypass redaction, and patch handling assumes LF text.

- [ ] **Step 3: Normalize observations at the Rust boundary**

```rust
fn observation(kind: FailureKind, raw: String, suggestion: Option<String>) -> ToolObservation {
    let (content, redactions) = redact_secrets(&raw);
    ToolObservation { kind, content, redactions, truncated: false, suggestion }
}
```

Replace buffered `Command::output` use with stdout/stderr reader tasks that take `MAX_CAPTURE_BYTES` independently, signal truncation, and allow timeout cancellation. Normalize patch input to LF internally, preserve the target file's dominant ending on write, and return a typed unsupported-binary-patch failure. Replace frontend regex classification with the Rust `FailureKind` value.

- [ ] **Step 4: Prove all observation paths stay safe**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test tool_observation_safety`

Expected: PASS.

Run: `npm test -- src/agentRuntimeDeepLoop.test.ts`

Expected: PASS with typed failure classification.

- [ ] **Step 5: Commit safe observations**

```powershell
git add src-tauri/src/validation.rs src-tauri/src/workspace.rs src-tauri/src/policy.rs src-tauri/src/patch.rs src-tauri/src/web_search.rs src/agentRuntimeDeepLoop.ts src/agentRuntimeDeepLoop.test.ts src-tauri/tests/tool_observation_safety.rs
git commit -m "fix(runtime): return bounded typed redacted tool observations"
```

## Task 5: Implement provider-native messages and the Rust turn loop

**Files:**

- Create: `src-tauri/src/engine/model.rs`
- Create: `src-tauri/src/engine/events.rs`
- Create: `src-tauri/src/engine/loop.rs`
- Modify: `src-tauri/src/engine/mod.rs`
- Modify: `src-tauri/src/providers/mod.rs`
- Modify: `src-tauri/src/providers/minimax.rs`
- Modify: `src-tauri/src/providers/openai.rs`
- Modify: `src-tauri/src/providers/anthropic.rs`
- Modify: `src-tauri/src/agent_runtime_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/native_agent_loop.rs`

**Interfaces:**

- Consumes: `engine::tool_manifest`, `ApprovalGate`, provider credentials, and guarded tool execution.
- Produces: `RunNativeAgentRequest`, `NativeAgentEvent`, `NativeAgentTerminal`, and `abort_native_agent(run_id)` Tauri commands.

- [ ] **Step 1: Write a failing deterministic loop test against a scripted provider**

```rust
#[test]
fn native_loop_executes_structured_read_then_returns_final_text() {
    let provider = ScriptedProvider::new([
        assistant_tool_call("readFile", json!({"path":"README.md"})),
        assistant_final("The repository README was read."),
    ]);
    let result = run_native_agent(request("session-1"), &provider, &runtime).unwrap();
    assert_eq!(result.terminal, NativeAgentTerminal::Completed);
    assert_eq!(result.events.iter().map(NativeAgentEvent::kind).collect::<Vec<_>>(), vec!["agentStart", "turnStart", "toolExecutionStart", "toolExecutionEnd", "turnEnd", "settled"]);
}
```

- [ ] **Step 2: Run the native-loop test and verify it fails**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test native_agent_loop`

Expected: FAIL because `engine::loop` and native provider tool messages do not exist.

- [ ] **Step 3: Add typed model messages, event stream, and bounded loop**

```rust
pub enum ProviderTurn {
    Final { content: String, usage: ProviderUsage },
    ToolCalls { calls: Vec<AgentEngineToolCall>, usage: ProviderUsage },
}

pub fn run_native_agent(request: RunNativeAgentRequest, provider: &dyn NativeProvider, runtime: &Runtime) -> Result<NativeAgentResult, NativeAgentError> {
    for turn in 0..request.max_turns.clamp(1, 24) {
        runtime.emit(NativeAgentEvent::turn_start(&request.run_id, turn));
        match provider.turn(&request.messages, &tool_manifest())? {
            ProviderTurn::Final { content, usage } => return runtime.complete(content, usage),
            ProviderTurn::ToolCalls { calls, usage } => request.messages.extend(execute_calls(calls, runtime)?),
        }
    }
    runtime.stop_due_to_budget()
}
```

The provider adapters must construct each vendor's tool schema request and parse its native tool-call response. Invalid, truncated, unknown, and duplicate non-idempotent calls produce typed error observations rather than execution.

- [ ] **Step 4: Verify loop behavior across providers and cancellation**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test native_agent_loop`

Expected: PASS for final answer, approved tool call, rejected call, malformed call, turn budget, and abort.

- [ ] **Step 5: Commit the native runtime core**

```powershell
git add src-tauri/src/engine src-tauri/src/providers src-tauri/src/agent_runtime_commands.rs src-tauri/src/lib.rs src-tauri/tests/native_agent_loop.rs
git commit -m "feat(engine): run provider-native tool turns in Rust"
```

## Task 6: Persist runtime events, save points, and canonical project memory

**Files:**

- Create: `src-tauri/src/engine/session_log.rs`
- Create: `src-tauri/src/engine/recovery.rs`
- Modify: `src-tauri/src/persistence.rs`
- Modify: `src-tauri/src/agent_runtime.rs`
- Modify: `src-tauri/src/agent_runtime_commands.rs`
- Modify: `src-tauri/src/memory.rs`
- Modify: `src/providers/agentRuntime.ts`
- Create: `src-tauri/tests/session_recovery.rs`

**Interfaces:**

- Consumes: `NativeAgentEvent`, `RuntimeSession`, `MemoryStore`, and existing persisted chat sessions.
- Produces: `append_session_event`, `restore_interrupted_run`, `save_point`, and one public memory API.

- [ ] **Step 1: Write failing restart and memory supersession tests**

```rust
#[test]
fn interrupted_non_idempotent_tool_restores_as_error_observation() {
    let log = SessionLog::open(temp_db()).unwrap();
    log.append(tool_execution_started("writeFile", false)).unwrap();
    let restored = restore_interrupted_run(&log, "run-1").unwrap();
    assert!(restored.events.iter().any(|event| event.kind() == "toolInterrupted"));
}

#[test]
fn superseding_memory_is_ranked_above_the_stale_record() {
    let hits = store.retrieve(&context("new convention"));
    assert_eq!(hits.first().unwrap().memory.content, "new convention");
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test session_recovery`

Expected: FAIL because the runtime does not append normalized events or restore interrupted work.

- [ ] **Step 3: Add the append-only session log and delete duplicate memory endpoints**

```rust
pub fn append_event(&self, event: &NativeAgentEvent) -> Result<(), String> {
    self.connection.execute(
        "INSERT INTO session_events (session_id, run_id, sequence, kind, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![event.session_id(), event.run_id(), event.sequence(), event.kind(), serde_json::to_string(event)?, event.created_at()],
    )?;
    Ok(())
}
```

Migrate existing `messages_json` rows into readable legacy entries on first load. Keep one memory store and one Tauri command pair; remove v1/v2 duplicates, their React wrapper duplicates, and stale health claims. Store a save point after each completed tool event.

- [ ] **Step 4: Prove restart, migration, and memory behavior**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test session_recovery`

Expected: PASS.

- [ ] **Step 5: Commit durability consolidation**

```powershell
git add src-tauri/src/engine/session_log.rs src-tauri/src/engine/recovery.rs src-tauri/src/persistence.rs src-tauri/src/agent_runtime.rs src-tauri/src/agent_runtime_commands.rs src-tauri/src/memory.rs src/providers/agentRuntime.ts src-tauri/tests/session_recovery.rs
git commit -m "feat(runtime): persist native events and consolidate memory"
```

## Task 7: Cut React over to native events and delete the legacy loop

**Files:**

- Modify: `src/providers/agentEngine.ts`
- Modify: `src/state/harness.ts`
- Modify: `src/components/AgentProgressBubble.tsx`
- Modify: `src/components/PlanProgressPanel.tsx`
- Modify: `src/views/HomeView.tsx`
- Modify: `src/App.tsx`
- Delete: `src/providers/toolDispatch.ts`
- Delete: `src/providers/toolBlockParser.ts`
- Delete: `src/agentRuntimeDeepLoop.ts`
- Delete: their associated tests only after equivalent native-event tests exist
- Modify: `src/providers/registry.ts`
- Modify: `README.md`
- Create: `src/providers/agentEngine.test.ts`
- Create: `src/views/HomeView.test.tsx`

**Interfaces:**

- Consumes: `RunNativeAgentRequest`, `NativeAgentEvent`, approval continuation, and abort commands.
- Produces: a UI that renders only backend-authored progress, plans, approvals, errors, and final assistant content.

- [ ] **Step 1: Write failing event-reducer and composer tests**

```typescript
it("renders a pending approval from a native event and resumes the same run", async () => {
  emit({ kind: "approvalRequested", runId: "run-1", approvalId: "approval-1" });
  await user.click(screen.getByRole("button", { name: "Approve once" }));
  expect(resolveApproval).toHaveBeenCalledWith("approval-1", "approvedOnce");
  expect(resumeNativeAgent).toHaveBeenCalledWith("run-1");
});

it("never sends a fenced tool parser prompt to the provider", () => {
  expect(buildNativeRequest(messages).systemPrompt).not.toContain("```tool");
});
```

- [ ] **Step 2: Run focused frontend tests and verify they fail**

Run: `npm test -- src/providers/agentEngine.test.ts src/views/HomeView.test.tsx`

Expected: FAIL because the client still dispatches through the fenced-tool path.

- [ ] **Step 3: Replace dispatch with the native client and delete old modules**

```typescript
const run = await startNativeAgent({ sessionId, projectRoot, provider, messages, maxTurns });
for await (const event of subscribeNativeAgentEvents(run.id)) {
  dispatch(applyNativeAgentEvent(event));
}
```

Remove imports and exports for `dispatchChat`, `parseToolBlocks`, `runToolSteps`, `runChatTurn`, and regex-derived failure recovery. The composer submits one typed native request. The UI must expose abort and pending-approval actions tied to the current run ID.

- [ ] **Step 4: Verify no legacy-path references remain**

Run: `rg -n "toolBlockParser|dispatchChat|MAX_TOOL_TURNS|```tool|runChatTurn" src README.md`

Expected: no production matches.

Run: `npm test -- src/providers/agentEngine.test.ts src/views/HomeView.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the single-path frontend cutover**

```powershell
git add src
git add README.md
git commit -m "feat(chat): consume the native Rust agent event stream"
```

## Task 8: Remove proven dead code and harden shipped surfaces

**Files:**

- Modify: `src-tauri/src/github_workflow.rs`
- Modify: `src-tauri/src/code_intelligence.rs`
- Modify: `src-tauri/src/policy.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/patch.rs`
- Modify: `src-tauri/src/web_search.rs`
- Modify: `src/components/MarkdownView.tsx`
- Modify: `src/components/MarkdownView.test.tsx`
- Modify: `index.html`
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/tests/security_regressions.rs`

**Interfaces:**

- Consumes: compiler reachability, bridge registration, frontend imports, and documentation references.
- Produces: zero strict-Clippy warnings, hardened command classification, sanitized Markdown rendering, and a production CSP.

- [ ] **Step 1: Write failing security and dead-code boundary tests**

```rust
#[test]
fn shell_interpreter_with_command_string_is_risky() {
    assert!(classify_command("powershell", &["-Command".into(), "Remove-Item -Recurse C:\\temp".into()]).is_risky());
}

#[test]
fn global_git_config_write_is_destructive() {
    assert_eq!(classify_command("git", &["config".into(), "--global".into(), "core.hooksPath".into(), "x".into()]), CommandClass::Destructive);
}
```

```tsx
it("does not execute provider-supplied script markup", () => {
  render(<MarkdownView content={'<img src=x onerror="window.pwned=1">'} />);
  expect(window).not.toHaveProperty("pwned");
});
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --test security_regressions`

Expected: FAIL until shell interpreters and mutating Git configuration are classified as risky.

Run: `npm test -- src/components/MarkdownView.test.tsx`

Expected: FAIL until rendering is hardened.

- [ ] **Step 3: Remove only proven-unused symbols and add hardening**

```rust
if is_shell_interpreter(name) && args.iter().any(|arg| matches!(arg.as_str(), "-c" | "/c" | "-Command")) {
    return CommandClass::Destructive;
}
```

Use compiler diagnostics plus `rg` for each candidate before deleting it. Remove stale imports, unused fields, obsolete duplicate command types, abandoned helper APIs, and comments only after their active replacement is in place. Keep public API only if it is registered, reachable, tested, and documented. Replace or configure Markdown rendering so raw provider HTML cannot execute. Add a CSP consistent with Tauri's asset and provider connection requirements.

- [ ] **Step 4: Prove strict hygiene and security tests**

Run: `C:\Users\thoma\.cargo\bin\cargo.exe clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

Expected: PASS with zero warnings.

Run: `npm test -- src/components/MarkdownView.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit cleanup and hardening**

```powershell
git add src-tauri/src src/components/MarkdownView.tsx src/components/MarkdownView.test.tsx index.html src-tauri/tauri.conf.json src-tauri/tests/security_regressions.rs
git commit -m "refactor(runtime): remove dead paths and harden agent surfaces"
```

## Task 9: Package, CI, documentation, and live end-to-end verification

**Files:**

- Modify: `.github/workflows/package.yml`
- Modify: `.github/workflows/contract.yml`
- Modify: `package.json`
- Modify: `.githooks/pre-commit`
- Modify: `README.md`
- Modify: `docs/agent-runtime-service.md`
- Modify: `docs/agent-loop-and-browser-testing.md`
- Create: `scripts/native-agent-e2e.mjs`
- Create: `scripts/check-native-agent-cutover.mjs`

**Interfaces:**

- Consumes: packaged browser driver, native Tauri commands, provider configuration, and the approved GitHub account.
- Produces: reproducible CI checks and a local live test that performs a bounded coding task.

- [ ] **Step 1: Write failing cutover and package checks**

```javascript
assert.equal(await exists("scripts/zeus-browser-driver.mjs"), true);
assert.equal(await hasLegacyParserReference("src"), false);
assert.equal(await nativeAgentCanCompleteFixture(), true);
```

- [ ] **Step 2: Run checks and verify the expected red state**

Run: `node scripts/check-native-agent-cutover.mjs`

Expected: FAIL until the native path is complete and legacy production files are absent.

- [ ] **Step 3: Wire release checks and live agent verification**

```yaml
- run: cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
- run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
- run: npm run sidecar:build:win
- run: npm run browser:smoke
- run: node scripts/check-native-agent-cutover.mjs
```

Set `engines.node` to the documented Node floor. Update the README and agent docs to describe only the native loop, its approval behavior, browser driver, verification commands, and Cargo location guidance for Windows. `native-agent-e2e.mjs` must create a disposable fixture project, ask the configured provider to add a tested source change, approve the planned write, run its test, verify the file, and clean up the fixture. The GitHub portion runs only against the user-authorized branch and uses a draft pull request if a remote integration is requested.

- [ ] **Step 4: Run the complete repository and live acceptance gate**

Run: `npm run typecheck; npm test; npm run build; bash scripts/check-tauri-capabilities.sh; C:\Users\thoma\.cargo\bin\cargo.exe fmt --manifest-path src-tauri/Cargo.toml -- --check; C:\Users\thoma\.cargo\bin\cargo.exe test --manifest-path src-tauri/Cargo.toml --all-targets; C:\Users\thoma\.cargo\bin\cargo.exe clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; npm run browser:smoke; node scripts/check-native-agent-cutover.mjs; node scripts/native-agent-e2e.mjs`

Expected: every command exits 0, no legacy parser references remain, and the live fixture task ends with a verified tested change.

- [ ] **Step 5: Commit verification and documentation**

```powershell
git add .github package.json .githooks README.md docs scripts
git commit -m "ci(agent): verify the native coding agent end to end"
```
