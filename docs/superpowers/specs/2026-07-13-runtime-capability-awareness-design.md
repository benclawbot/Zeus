# Runtime Capability Awareness Design

## Objective

Make Zeus describe and use its actual runtime capabilities instead of producing stale, generic limitations such as “static-only,” “cannot run tests,” or “no persistent memory.” Capability claims must be derived from registered runtime services and callable native tools on every agent turn.

## Current mismatch

The React system prompt states that Zeus can read and edit files, execute commands, and run tests. A second static prompt lists workspace tools. Rust separately owns the canonical engine manifest, runtime status, browser service, persistent memory, approvals, and native observe-and-replan loop. These sources can drift. Browser and memory commands are callable from the UI bridge but are not first-class tools in the normal chat loop, so the model cannot reliably verify or use everything the application advertises.

## Authoritative capability snapshot

Rust will build a concise capability snapshot immediately before each native agent turn. The snapshot will be injected into the first system message after user-authored identity guidance and before any skill-specific instructions. It will contain the canonical callable tool names, filesystem and approval policy, browser availability, persistent-memory availability and current entry count, runtime session/tool-run state, and explicit inherent limitations.

The snapshot will instruct the model to distinguish three states: available and callable now, registered but currently unavailable with a concrete reason, and inherently limited. Zeus must attempt a relevant tool or use a runtime status result before claiming an available capability is missing. It must not describe itself as static-only when shell or file tools are registered, claim that tests are invisible when `runTest` or `runCommand` is callable, or claim there is no persistent memory when the runtime memory store is active.

Inherent limitations remain honest: finite context, imperfect intent inference, possible API uncertainty, and the need for approval on gated actions. The snapshot will name the mitigations Zeus can use: source inspection, test/build execution, browser verification, bounded observations, plans, transactional patches, checkpoints, and persistent memory.

## Native browser and memory tools

The canonical engine manifest and native tool dispatcher will add `browser`, `retrieveMemory`, and `upsertMemory` tools. Browser accepts the existing semantic actions and delegates to `AgentRuntimeService::browser_tool`. Memory tools delegate to the existing persistent runtime store and remain scoped by project/session identifiers.

Tool schemas in the prompt will come from the same manifest entries used by dispatch. The implementation will not expose a tool merely because a Tauri command exists; the tool must be reachable through the native agent loop and covered by a dispatch test.

Browser availability will be checked without launching a browser for unrelated turns. The snapshot reports browser tooling as available when the shipped driver resource exists and the runtime service is healthy; an actual driver-start error is returned as a structured tool observation when the model invokes it.

## Prompt ownership

React retains identity, response style, compaction, and optional terse/minimal-code instructions. It will stop maintaining a duplicate list of runtime tools. Rust owns the capability snapshot and appends it idempotently so retries and re-planning do not duplicate the block.

The snapshot builder will be a pure Rust function over typed capability data. This keeps wording testable and prevents live secrets, full memory contents, file contents, or unbounded runtime state from entering the system prompt.

## Live model and context status

The bottom status bar will use the model identifier and normalized usage returned by the latest completed native turn. It will clearly distinguish actual last-turn input from the locally projected next prompt. The active configured model remains a temporary preflight value only until the provider returns an authoritative model identifier.

The projected count must include every frontend-known system block, workspace hint, chat message, compact anchor, and composer draft. The UI will label it as an estimate because Rust may inject capability, skill, memory, and tool-observation context after the frontend projection. After a response, the status bar displays the provider-reported input count against the returned model's registered context window and retains the projected next-turn estimate separately.

Unknown model identifiers will visibly use the conservative fallback window instead of appearing authoritative. Tests will cover configured-model fallback, authoritative response-model replacement, actual versus estimated labels, and context-window calculation.

## Objective-linked plan progress

The Plan Progress panel will never synthesize a generic five-step plan. A substantive execution objective displays only provider-generated or runtime-generated objective-specific steps. A conversational question or explanation request displays a concise “No execution plan needed” state. While a substantive objective is waiting for its plan, the panel displays “Planning…” without fabricated progress. Planner failure displays “Plan unavailable” and the objective, not boilerplate TODOs.

Plan results will be bound to an objective/request identifier so a late planner response cannot replace the plan for a newer user turn. Progress updates will apply only to the active objective's real steps.

## Cache-token visibility and diagnosis

Provider usage will be normalized into input, output, cache-read, and cache-write token counts. Normalization will recognize OpenAI-compatible `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens` and `cache_creation_input_tokens`, and equivalent nested fields returned by compatible providers. Missing cache telemetry is represented as “not reported,” not zero.

The Session panel will display cached-read tokens and cached-read percentage of input tokens, plus cache-write tokens when supplied. Its tooltip/status copy will distinguish “0% reported” from “provider did not report cache usage.” The percentage formula is `cacheRead / input * 100`, clamped to 0–100.

The implementation will not claim that a low percentage is a Zeus defect without telemetry. Stable system-prefix ordering will be preserved to maximize provider cache reuse; per-turn dynamic capability values will be placed after the stable capability/tool description so runtime counters do not invalidate the reusable prefix.

## Error handling

If runtime status cannot be collected, the turn continues with a degraded snapshot that states which status probe failed. A failed optional capability must not erase confirmed capabilities. Tool execution errors remain observations; they do not mutate the persistent capability description for later turns unless the underlying health check changes.

## Testing

Tests will first fail against the current behavior. Rust unit tests will assert that the capability snapshot advertises execution, tests, browser, and persistent memory when healthy; rejects the stale limitation phrases; renders unavailable capabilities with reasons; contains only manifest-backed callable tools; and is injected exactly once. Dispatcher tests will prove browser and memory calls reach the existing runtime services.

TypeScript tests will assert that the frontend no longer injects a duplicate tool list while preserving identity and response-style instructions. Existing bridge, approval, redaction, bounded-output, and native-loop tests must remain green.

Completion requires `npm run typecheck`, `npm test`, `npm run build`, `cargo fmt --check`, `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `bash scripts/check-tauri-capabilities.sh`.

## Non-goals

This change does not promise unlimited context, perfect intent inference, or infallible dependency knowledge. It does not add autonomous permission escalation, silently bypass approvals, preload memory contents into every prompt, or probe/launch a real browser on every turn.
