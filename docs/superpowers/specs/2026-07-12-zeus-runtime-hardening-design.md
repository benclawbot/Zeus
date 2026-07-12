# Zeus Runtime Hardening Design

## Objective

Close the audited approval, command-execution, credential, and webview-security gaps without redesigning the active native agent loop. The changes must preserve the current access-mode semantics, provider configuration workflow, and cross-platform Tauri packaging.

## Scope

This hardening pass removes the unused legacy engine tool-execution command, consolidates command classification, makes shell output collection deadlock-safe, prevents provider keys from crossing Tauri IPC, migrates persisted secrets to an operating-system credential store, and enables a restrictive content security policy. It does not split the large application modules or redesign the provider/runtime architecture.

## Runtime authorization

`agent_engine_execute_tools` and its TypeScript execution wrapper will be removed because the current frontend does not call them and the active native runtime has dedicated, session-bound approval commands. Health metadata may remain, but it must not advertise an executable legacy surface. Bridge tests will assert that the removed command is no longer registered.

Every remaining shell path will call `policy::classify_command` and the central authorization matrix. The duplicate classifier in `workspace.rs` will be deleted. Regression tests will cover commands previously misclassified as safe, including `pkexec`, `truncate`, `nc`, `git pull`, and destructive branch operations.

## Process output and timeouts

Shell execution will take ownership of piped stdout and stderr immediately after spawn and drain them concurrently while the parent monitors the child. Each stream will retain only the configured capture limit while still draining excess bytes so the child cannot block on a full pipe. After a timeout, Zeus will terminate the child, wait for it, join both reader threads, redact secrets, and return bounded output with `timedOut=true`.

A regression test will run a cross-platform helper command that writes more than the platform pipe capacity and verify that it completes without timing out. A second test will verify bounded capture.

## Provider credentials

`set_provider_keys` will return `ProviderKeysStatus`, never `ProviderKeysFile`, so raw keys cannot be serialized over IPC. Provider base URLs and model IDs will remain in the existing JSON settings file because they are not secrets.

Secrets will be stored using an operating-system credential facility through a maintained cross-platform Rust credential library. On startup, Zeus will read credentials from the OS store. If the existing JSON file contains keys, Zeus will migrate them into the credential store, rewrite the JSON without secret fields only after all requested writes succeed, and continue to read the legacy fields if migration cannot complete. Clearing a key removes its credential entry. Errors will be surfaced to Settings rather than silently discarding credentials.

The migration and storage abstraction will be testable through an injected in-memory credential backend. Tests will cover save, clear, status-only responses, successful migration, and migration failure without data loss.

## Content security policy

The production webview will use a restrictive CSP that defaults to self, blocks objects and frames, and permits Tauri IPC requirements. Provider HTTP requests originate in Rust, so the webview does not need broad provider-domain `connect-src` access. Development behavior must continue to work through Tauri's development configuration.

## Verification

Each behavior change will follow a failing-test-first cycle. Completion requires `npm run typecheck`, `npm test`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `bash scripts/check-tauri-capabilities.sh`, and `npm audit --json` with no vulnerabilities. The final diff and `git status` must contain only intended files plus the user's pre-existing untracked files.

## Compatibility and rollback

The active native agent runtime and dedicated workspace Tauri commands remain unchanged at their public TypeScript interfaces, except that the unused legacy engine execution export is removed. Existing non-secret provider settings retain their schema. Legacy plaintext keys remain recoverable until credential migration succeeds, preventing upgrade-time data loss. Every change is independently reversible from the working-tree diff.
