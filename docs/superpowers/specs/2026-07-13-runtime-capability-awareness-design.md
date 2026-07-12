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

## Error handling

If runtime status cannot be collected, the turn continues with a degraded snapshot that states which status probe failed. A failed optional capability must not erase confirmed capabilities. Tool execution errors remain observations; they do not mutate the persistent capability description for later turns unless the underlying health check changes.

## Testing

Tests will first fail against the current behavior. Rust unit tests will assert that the capability snapshot advertises execution, tests, browser, and persistent memory when healthy; rejects the stale limitation phrases; renders unavailable capabilities with reasons; contains only manifest-backed callable tools; and is injected exactly once. Dispatcher tests will prove browser and memory calls reach the existing runtime services.

TypeScript tests will assert that the frontend no longer injects a duplicate tool list while preserving identity and response-style instructions. Existing bridge, approval, redaction, bounded-output, and native-loop tests must remain green.

Completion requires `npm run typecheck`, `npm test`, `npm run build`, `cargo fmt --check`, `cargo test --manifest-path src-tauri/Cargo.toml --all-targets`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `bash scripts/check-tauri-capabilities.sh`.

## Non-goals

This change does not promise unlimited context, perfect intent inference, or infallible dependency knowledge. It does not add autonomous permission escalation, silently bypass approvals, preload memory contents into every prompt, or probe/launch a real browser on every turn.
