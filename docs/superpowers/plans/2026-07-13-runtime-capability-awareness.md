# Runtime Capability Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zeus use and accurately report live runtime capabilities, real objective-specific plans, authoritative model/context status, and normalized cache-token telemetry.

**Architecture:** Rust owns the canonical capability snapshot and native browser/memory dispatch. React owns presentation of the authoritative turn result and removes duplicate runtime/tool assumptions. Provider usage is normalized once into a typed frontend model used by both status and session panels.

**Tech Stack:** Rust 1.95, Tauri 2, React 18, TypeScript, Vitest, rusqlite-backed runtime state.

## Global Constraints

Do not expose secrets or memory contents in capability prompts. Do not bypass approvals. Do not fabricate plan progress. Missing cache telemetry is unknown, not zero. Preserve stable prompt-prefix ordering and all existing native-loop limits.

---

### Task 1: Runtime capability snapshot

**Files:** Modify `src-tauri/src/engine/mod.rs`, `src-tauri/src/lib.rs`; test in the same Rust modules.

**Interfaces:** Produce `render_capability_snapshot(&RuntimeCapabilitySnapshot) -> String` and idempotent `inject_capability_snapshot(&mut Vec<ChatMessage>, &str)`.

- [ ] Add failing tests asserting healthy snapshots advertise file/shell/test/browser/memory capabilities, omit stale “static-only” claims, render unavailable reasons, contain manifest-backed tool names, and inject once.
- [ ] Run focused Rust tests and confirm the expected assertion failures.
- [ ] Implement typed snapshot construction from engine manifest, browser driver availability, runtime status, filesystem scope, and approval policy; inject it before native provider dispatch.
- [ ] Re-run focused tests to green.

### Task 2: Native browser and memory tools

**Files:** Modify `src-tauri/src/engine/mod.rs`, `src-tauri/src/lib.rs`, `src/providers/toolDispatch.ts`; extend existing Rust native-loop tests.

**Interfaces:** Add manifest/dispatch names `browser`, `retrieveMemory`, and `upsertMemory`, delegating to `AgentRuntimeService` and the persistent memory store.

- [ ] Add failing dispatch tests proving each tool reaches its existing runtime service and returns a structured observation.
- [ ] Add tool schemas to the canonical manifest, pass runtime/project context into dispatch, and remove the duplicate static frontend tool list.
- [ ] Run Rust and TypeScript focused tests to green.

### Task 3: Objective-linked plan states

**Files:** Modify `src/providers/planner.ts`, `src/agentRuntimeDeepLoop.ts`, `src/components/PlanProgressPanel.tsx`, `src/App.tsx`; update colocated tests.

**Interfaces:** Add explicit panel states `conversation`, `planning`, `ready`, and `unavailable`; bind plan results to an objective ID.

- [ ] Replace tests expecting generic boilerplate with failing tests for “No execution plan needed,” “Planning…,” objective-specific steps, stale-result rejection, and “Plan unavailable.”
- [ ] Remove heuristic fallback plans, carry objective IDs through planner state, and render only real plan steps.
- [ ] Run planner, deep-loop, panel, and App tests to green.

### Task 4: Authoritative model/context and cache telemetry

**Files:** Create `src/providers/tokenUsage.ts` and test; modify `src/App.tsx`, `src/components/StatusBar.tsx`, `src/views/HomeView.tsx`, `src/views/InspectorPanel.tsx` and their tests.

**Interfaces:** Produce `normalizeTokenUsage(usage: unknown) -> NormalizedTokenUsage | null` with `input`, `output`, `cacheRead`, and `cacheWrite`; persist the response model and normalized usage on assistant messages.

- [ ] Add failing normalizer tests for OpenAI, Anthropic, compatible nested fields, absent telemetry, and cache percentage clamping.
- [ ] Add failing UI tests for authoritative response model, actual last-turn context, projected-next estimate, cached-read percentage, cache-write display, and “not reported.”
- [ ] Implement normalization, message persistence, StatusBar actual/estimated labeling, and Session cache percentages.
- [ ] Run focused TypeScript tests to green.

### Task 5: Full verification and visible acceptance

**Files:** No new production files unless verification exposes a defect.

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `bash scripts/check-tauri-capabilities.sh`.
- [ ] Launch the Tauri app and verify the screenshot scenario: conversational limitation question shows no fake plan, the status bar shows the returned model and actual/estimated context labels, and Session shows cache percentage or “not reported.”
- [ ] Review `git diff --check`, changed files, and repository status before completion.
