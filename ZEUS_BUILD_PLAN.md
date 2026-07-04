# Zeus Build Plan

## Current Decisions

Zeus will be built in this folder as a Tauri + React desktop app with a Rust core and a compact Codex-style UI. The written HTML specs and README are the source of truth; the reference images in the zip are obsolete. The first build focuses on a faithful, functional app shell with a real MiniMax M3 provider adapter, local state scaffolding, access-mode UI, harness-evolution workflow placeholders backed by app state, and cross-platform packaging configuration.

The visual direction should stay beautiful, simple, and Codex-like: compact controls, quiet surfaces, and no oversized buttons or bulky decorative treatment.

MiniMax M3 is the first model provider. The adapter uses the OpenAI-compatible API at `https://api.minimax.io/v1` and model `MiniMax-M3`. API keys must come from environment or local runtime config, not from committed source.

Packaging should remain platform-neutral: the Tauri app should build on Windows, macOS, and Linux from the same codebase, with CI/workflow hooks prepared for platform-specific bundles.

## Source Specs Read

- `zeus_visual_specs.zip/README.md`
- `zeus_visual_specs.zip/index.html`
- `zeus_visual_specs.zip/screen-main.html`

## Implementation Phases

### Phase 1: Project Foundation

Status: complete

Acceptance:

- Tauri + React + TypeScript project files exist in `C:\Users\thoma\Zeus`.
- Standard scripts exist for dev, frontend build, Tauri dev, Tauri build, tests, and type checking.
- Rust/Tauri config is cross-platform and does not hard-code Windows-only paths.
- `.gitignore` excludes build output, dependency folders, and local secrets.

Progress:

- [x] Create project/package/config files.
- [x] Add Tauri Rust crate and command bridge.
- [x] Add CI packaging workflow scaffold.
- [x] Install dependencies.
- [x] Generate cross-platform Tauri icon assets.
- [x] Verify frontend type/build command.

### Phase 2: Zeus Visual Shell

Status: complete

Acceptance:

- Main screen uses Zeus naming throughout.
- Three-column app shell is implemented: left navigation/session/harness panel, center task chat/run area, right progress/memory/access panel.
- Attach controls exist only beside the bottom input box.
- No top-bar file add controls, no right-panel file add controls, and no lower-left engine card.
- Typography uses compact system font scale.
- Controls are compact and visually quiet; no big-button treatment.
- Layout is responsive enough not to overlap at desktop and narrower widths.

Progress:

- [x] Implement React component structure.
- [x] Implement CSS tokens and responsive layout.
- [x] Wire sample state for sessions, plan progress, harness proposal, memory snapshot, and access mode.
- [x] Add component tests for key source-of-truth UI rules.
- [x] Refine controls toward a smaller, quieter Codex-like visual language.

### Phase 3: MiniMax M3 Adapter

Status: complete

Acceptance:

- Rust core exposes a Tauri command that sends OpenAI-compatible chat requests to MiniMax M3.
- Base URL defaults to `https://api.minimax.io/v1`.
- Model defaults to `MiniMax-M3`.
- API key is read from `MINIMAX_API_KEY`.
- Errors avoid leaking secrets.
- Frontend can invoke the adapter through a provider module.

Progress:

- [x] Define request/response types.
- [x] Implement Rust command and secret-safe error handling.
- [x] Implement frontend provider wrapper.
- [x] Add Rust unit tests for request construction/error behavior where possible.

### Phase 4: Local App State and Harness Workflow

Status: pending

Acceptance:

- Harness proposals appear in the left panel as next-session review items.
- User can approve, edit, reject, apply once, and roll back in UI state.
- Change history and harness memory have local data structures ready for SQLite persistence.
- Access mode selection is visible and reflected in app state.

Progress:

- [ ] Add state model/types.
- [ ] Wire harness proposal actions.
- [ ] Add history/memory placeholders.
- [ ] Add tests for harness state transitions.

### Phase 5: Verification and Packaging

Status: complete

Acceptance:

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run tauri:build` is attempted with local Rust path configured.
- Any environment blockers are documented with exact output.

Progress:

- [x] Run typecheck.
- [x] Run tests.
- [x] Run frontend build.
- [x] Run Tauri build/check.
- [x] Update this document with exact command output.
- [x] Publish public GitHub repository.

## Risks and Mitigations

Rust is installed locally but not on PATH in this shell. I will prepend `C:\Users\thoma\.cargo\bin` for Rust/Tauri commands and keep the project itself standard so it remains portable.

MiniMax M3 is a current external API. I verified the endpoint/model shape against MiniMax's docs before wiring it. Live API calls will require `MINIMAX_API_KEY` and should not run during automated tests unless explicitly enabled.

Tauri packaging can only fully prove the current host OS locally. Cross-platform packaging will be supported by project config and CI matrix, while actual macOS/Linux bundle verification requires runners for those OSes.

## Verification Log

- `npm install` succeeded. Output: added 190 packages and audited 191 packages in 1m. NPM reported 5 vulnerabilities: 3 moderate, 1 high, 1 critical, with `npm audit fix --force` suggested for breaking changes.
- `npm run typecheck` succeeded. Output: `tsc --noEmit`.
- First `npm run test` failed. Harness state test passed, but 2 App tests failed because Testing Library saw duplicate rendered app trees; root cause was missing cleanup between Vitest tests.
- After adding Vitest cleanup, `npm run test` succeeded. Output: 2 test files passed, 4 tests passed.
- `npm run build` succeeded. Output: `tsc && vite build`; Vite transformed 1581 modules and built `dist/` in 8.36s.
- First `cargo test` from `src-tauri` timed out after 184407 ms before returning useful output, likely during initial Rust dependency compilation.
- After the compact visual refinement, `npm run typecheck` succeeded again. Output: `tsc --noEmit`.
- After the compact visual refinement, `npm run test` succeeded again. Output: 2 test files passed, 4 tests passed.
- After the compact visual refinement, `npm run build` succeeded again. Output: `tsc && vite build`; Vite transformed 1581 modules and built `dist/` in 10.48s.
- Second `cargo test` from `src-tauri` failed after compiling dependencies because `icons/icon.ico` was missing for Windows resource generation.
- Generated Zeus icon assets and ran `npx tauri icon src-tauri/icons/icon.png`. Output included creation of AppX logos, `icon.icns`, `icon.ico`, PNG sizes, iOS icons, and Android mipmaps.
- `cargo test` from `src-tauri` succeeded after icon generation. Output: 3 tests passed, 0 failed; doc tests passed.
- Browser verification used Vite on `http://127.0.0.1:5317/`. Page title was `Zeus`, accessibility snapshot showed the three main regions and compact controls. Initial console error was `favicon.ico` 404; after copying `public/favicon.ico`, a fresh check returned 0 errors and 0 warnings. Screenshot saved by Playwright as `zeus-main-screen.png`.
- User screenshot showed the page body scrolling vertically and the composer cut off below the window. CSS was changed to make the app shell `height: 100vh`, hide body overflow, make side panels internally scrollable, and keep the composer flex-shrunk inside the visible workspace. A regression test was added for this viewport contract.
- First run after that test: `npm run typecheck` succeeded and `npm run build` succeeded, but `npm run test` failed because `App` tests did not import the stylesheet. Fix: move `styles.css` import from `main.tsx` into `App.tsx` so direct component tests include layout CSS.
- Follow-up `npm run test` still failed because jsdom did not expose the imported body stylesheet through `getComputedStyle`. The regression was changed to assert the stylesheet source contract directly and rely on Playwright for runtime layout verification.
- `npm run test` then succeeded. Output: 2 test files passed, 5 tests passed.
- `npm run typecheck` and `npm run build` then failed because the stylesheet-source regression imports `node:fs` and `node:path`, but the project did not yet include Node type declarations.
- Added `@types/node`; npm reported 0 vulnerabilities. Follow-up typecheck still failed until `node` was added to the explicit `types` allowlist in `tsconfig.json`.
- Runtime browser viewport verification with installed Chrome at 2048x1152 showed: page title `Zeus`, body overflow `hidden`, body/document heights equal to viewport height, shell height 1152, composer bottom 1138, composer visible true, page vertical overflow false, and no console errors. Screenshot saved to `C:\Users\thoma\Zeus\zeus-viewport-fit.png`.
- User requested a Codex-like composer: one-line by default, growing upward as input expands. Implemented textarea `rows=1`, auto-resize up to 160px, and compact composer CSS; added regression coverage for the one-line/growth contract.
- After the composer change, `npm run typecheck` succeeded, `npm run test` succeeded with 2 test files and 6 tests passed, and `npm run build` succeeded; Vite built `dist/` in 8.32s.
- Runtime composer verification with installed Chrome at 2048x1152 showed one-line default textarea height 24px and composer height 85.59px; after multi-line input textarea height grew to 148px and composer height to 209.59px. In both states composer bottom stayed at 1138, visible true, page overflow false, and console errors were empty. Screenshot saved to `C:\Users\thoma\Zeus\zeus-composer-fit.png`.
- `cargo fmt -- --check` from `src-tauri` succeeded.
- `cargo test` from `src-tauri` succeeded. Output: 3 tests passed, 0 failed; main/doc test targets had 0 tests and passed.
- `npm audit --audit-level=moderate` succeeded. Output: found 0 vulnerabilities.
- First `npm run tauri:build` compiled the release app successfully and produced `C:\Users\thoma\Zeus\src-tauri\target\release\zeus.exe`, but MSI bundling failed with `Couldn't find a .ico icon`. Fix: add the standard Tauri `bundle.icon` list to `src-tauri/tauri.conf.json`, including `icons/icon.ico`.
- Second `npm run tauri:build` succeeded. Output: built `C:\Users\thoma\Zeus\src-tauri\target\release\zeus.exe`, `C:\Users\thoma\Zeus\src-tauri\target\release\bundle\msi\Zeus_0.1.0_x64_en-US.msi`, and `C:\Users\thoma\Zeus\src-tauri\target\release\bundle\nsis\Zeus_0.1.0_x64-setup.exe`.
- Publication preparation: copied real runtime screenshots to `docs/assets/zeus-main-screen.png` and `docs/assets/zeus-composer-growth.png`, added `docs/assets/zeus-banner.svg`, and wrote `README.md` with current status, screenshots, architecture, installation, verification, roadmap, and security notes.
- README prerequisites were expanded to include Node/npm, Rust/Cargo, Git, WebView2, Windows C++ build tools, macOS Xcode tools, Linux Tauri packages, and `MINIMAX_API_KEY`.
- Git publishing preparation: initialized a nested Git repository in `C:\Users\thoma\Zeus` on `main` because the parent `C:\Users\thoma` directory is also a Git repository. This prevents accidentally publishing the whole home directory.
- Pre-commit hygiene: README asset references were checked and all files existed; `git diff --cached --check` passed after trimming extra blank EOF lines; a targeted staged-diff scan found no committed secret values. Temporary root screenshots, logs, build output, dependency folders, and the obsolete spec zip are ignored.
- GitHub publication: committed initial build as `b220d17 feat: initial Zeus desktop app`, created public repository `https://github.com/benclawbot/Zeus`, pushed `main`, and verified the remote branch/README through `gh`.
- Live provider troubleshooting: user reported "MiniMax request failed." on first launch. `MINIMAX_API_KEY` was missing from the spawned `zeus.exe` process env. Verified the endpoint with `curl` against `https://api.minimax.io/v1/chat/completions` using the user's API key (`http=200`, model `MiniMax-M3`, 1.8s). Diagnosed that Tauri's `tauri dev` does not auto-load `.env`, so the Rust command received `MissingApiKey` while the user perceived a network failure. Resolved with a wrapper script that sourced `.env` and prepended `~/.cargo/bin` to `PATH`, then `exec npm run tauri:dev`. Confirmed end-to-end round-trip by clicking through the Tauri UI with `cua-driver`: the agent returned a real reply and no longer errored.
- Strip `` reasoning blocks from MiniMax-M3 responses. Rust side: added `strip_thinking(content: &str)` in `src-tauri/src/lib.rs` that walks the response char-by-char, discards every ``…`` block (and unterminated trailing reasoning), and trims the result. Wired into `call_minimax` via `.map(|raw| strip_thinking(&raw))` on the parsed content. Added four unit tests in `mod tests` covering single-block, multi-block, unterminated, and pass-through cases. Frontend side: added `stripThinkingTags` as defense-in-depth in `src/App.tsx`. CSS: a `.agent-body p.thinking` placeholder style with grey italic text and animated dots that shows while `runState === "running" && !assistantText`, then swaps to the real answer. New regression test in `src/App.test.tsx` asserts the `.thinking` class is defined and that the literal `` tag pair never appears in the bundled CSS source.
- Move env-loading into `lib.rs` properly. Added `dotenvy = "0.15"` to `src-tauri/Cargo.toml` and called `let _ = dotenvy::dotenv();` at the top of `run()`. The early-return shape means bundled MSI/NSIS builds aren't affected (a missing `.env` is not an error); local dev gets the key from `C:\Users\thoma\Zeus\.env` automatically. Removed the temporary `scripts/tauri-dev-with-env.sh` wrapper. Re-launched with plain `npm run tauri:dev`, no wrapper, and confirmed the chat completes a fresh round-trip with key flowing from `.env` through Rust into the MiniMax API. Added unit test `missing_api_key_message_does_not_leak_key` asserting `MissingApiKey`'s public message contains only the literal `"MINIMAX_API_KEY"` string and never a value.
- Final verification: `cargo test` passes 8/8 (was 3; 4 new `strip_thinking_*` cases, 1 new `missing_api_key_message_does_not_leak_key`). `npm run typecheck`, `npm run test` (7 passed), and `npm run build` (built `dist/` in ~1.5s) all green. Live UI smoke test: typed a prompt, observed the "Thinking" placeholder, then watched the response land clean (no `` markup in the rendered assistant text).
- Current UI pass: inspected the latest MiniMax/user edits and found the center workspace still rendered a top task header plus an empty-state prompt. Changed the workspace so the center conversation is blank until the first user message, kept the bottom composer, and made chat auto-scroll to the latest message/reply update. Added regression coverage for the blank center and scroll contract.
- Verification after current UI pass: `npm run typecheck` passed, `npm run test -- --run` passed with 11 tests, `npm run build` passed, and Rust tests passed with `C:\Users\thoma\.cargo\bin\cargo.exe test` (14 passed). Plain `cargo test` still fails in this PowerShell session because Cargo is not on PATH; the project itself is fine.
- Skills inventory: found 41 local skill folders under `C:\Users\thoma\Zeus\skills`, all with `SKILL.md`. Main overlap candidates are frontend/mobile stacks (`frontend-dev`, `fullstack-dev`, `android-native-dev`, `react-native-dev`, `flutter-dev`), document generators (`minimax-docx`, `minimax-pdf`, `minimax-xlsx`, `pptx-generator`), planning/todo helpers (`planf3`, `planning-and-task-breakdown`, `write-todos`, `todo-update`), self-improvement loops (`self-improve`, `self-optimization-loop`, `skill-evolution`), and root-cause/debugging (`5-why`, `debugging-and-error-recovery`). No merge/delete was performed yet because several overlaps may be intentional trigger specialization.
- Skills wiring: added read-only Tauri commands `list_skills` and `load_skill`. `list_skills` reads only skill folder metadata/frontmatter and resource flags; `load_skill` validates the selected id and reads only that one `SKILL.md` body. Added the `skills/` folder as a Tauri bundle resource so packaged apps can resolve it from `resource_dir()/skills`, with `ZEUS_SKILLS_DIR` retained as an override for local/custom skill directories.
- Skills UI: wired the sidebar `Skills` nav item to a compact registry view. The view lazy-loads metadata on first entry, lazy-loads the selected skill body on click, and surfaces overlap groups without merging anything automatically.
- Verification after skills wiring: `npm run typecheck` passed, `npm run test -- --run` passed with 11 tests, `npm run build` passed, `cargo fmt -- --check` passed through `C:\Users\thoma\.cargo\bin\cargo.exe`, Rust tests passed with 17 tests, and `npm run tauri:build` passed when Cargo was prepended to PATH. Built artifacts: `src-tauri\target\release\zeus.exe`, `src-tauri\target\release\bundle\msi\Zeus_0.1.0_x64_en-US.msi`, and `src-tauri\target\release\bundle\nsis\Zeus_0.1.0_x64-setup.exe`. Packaged release output includes `src-tauri\target\release\skills` with 41 folders and 363 files.
- Visible control wiring: sidebar nav now switches to state-backed Home, Sessions, Skills, Memory, Harness Evolution, and Settings views. New Session clears chat/draft/attachments and returns Home. Recent session rows select the session and return Home. The composer attach control opens a real file input, file chips render only after selection, chip remove buttons update state, and the mention control inserts `@` into the composer. Inspector `View Memory` routes to the Memory view.
- Verification after visible control wiring: `npm run typecheck` passed, `npm run test -- --run` passed with 14 tests, Rust tests passed with 17 tests, and a final `npm run tauri:build` with Cargo on PATH succeeded. Browser runtime check at 1440x900 confirmed blank initial center, no old prompt, no page vertical overflow, mention insertion, New Session draft clearing, Sessions/Memory/Skills view switching, and active Skills nav. Screenshot saved by Playwright as `zeus-skills-wiring-check.png`.

### Phase 6: Live Chat Surface and Skills Wiring

Status: in progress

Acceptance:

- Center workspace is empty until the user starts chatting.
- Conversation auto-scrolls as model text appears.
- Skills stored under `skills/` are discoverable without loading every skill body into the UI at startup.
- The Skills screen shows the available skill registry and can lazy-load a selected skill body.
- Redundant or overlapping skills are identified before any merge/delete action.
- Plan document is updated as each slice completes.

Progress:

- [x] Remove center top/bottom stub content from the initial chat surface.
- [x] Add regression tests for blank initial conversation and auto-scroll behavior.
- [x] Verify frontend build/test/typecheck and Rust tests after the UI pass.
- [x] Inventory local `skills/` metadata and identify overlaps.
- [x] Add lazy skill registry/loading commands in Tauri.
- [x] Wire the Skills screen to browse and load local skills.
- [x] Add tests for skill discovery and loading.
- [x] Run final runtime verification that all visible screen controls are wired.

### Phase 7: Visible Control Wiring

Status: in progress

Acceptance:

- Sidebar nav buttons switch to real views instead of inert highlights.
- New Session clears the current chat draft/session state and returns to Home.
- Recent session buttons select a session and return to the chat view.
- Composer attachment controls are not fake: file chips appear only after selection and can be removed.
- Memory, Harness Evolution, Settings, and Sessions screens render state-backed content.
- Inspector action buttons route to the matching view.

Progress:

- [x] Wire sidebar nav and recent session actions.
- [x] Replace the stub attachment chip with real selected-file state.
- [x] Add state-backed Memory, Sessions, Harness, and Settings views.
- [x] Wire inspector shortcuts.
- [x] Add regression tests for the visible control wiring.
- [x] Run full build/test/package verification.

---

## Phase 6: Pluggable Chat Providers + Slash-Command Composer

Status: complete

Acceptance:

- Chat is dispatched through a provider abstraction so adding a new model is a single-file addition on both sides.
- Skills are loaded server-side and injected as silent system-prompt context.
- Slash commands (`/new`, `/compact`, `/stop`, plus every installed skill) are available inside the chat composer with keyboard navigation.
- A visible current-session pill surfaces the active session name and the active skill.

Changes:

- `src-tauri/src/providers/mod.rs` — `ChatProvider` trait, generic `ChatRequest`/`ChatResponse`/`ProviderError`, built-in provider registry, `dispatch_chat`, `list_provider_info`. Skill-body loader (`build_skill_system_message`) lives here, provider-agnostic.
- `src-tauri/src/providers/minimax.rs` — `MinimaxProvider`, OpenAI-compatible chat completions, `<think>...</think>` strip, `MINIMAX_API_KEY` env var.
- `src-tauri/src/providers/openai.rs` — `OpenAiProvider`, OpenAI chat completions, `OPENAI_API_KEY` env var.
- `src-tauri/src/providers/anthropic.rs` — `AnthropicProvider`, Anthropic Messages API with system-prompt-as-top-level-field translation, `ANTHROPIC_API_KEY` env var.
- `src-tauri/src/lib.rs` — `send_chat` (replaces `send_minimax_chat`) takes a `provider` string and routes via `dispatch_chat`; new `list_providers` Tauri command; skill injection on the Rust side; legacy minimax-only code paths removed.
- `src/providers/registry.ts` — frontend mirror of the registry; `dispatchChat`, `findProvider`, `listProviders`.
- `src/providers/slash.ts` — `useSlashMenu(message, isTauri)` hook with lazy skill loading, filter, keyboard navigation glue; `detectSlash` parser.
- `src/App.tsx` — slash picker UI above the composer (Up/Down/Enter/Tab/Esc); `/new`, `/compact`, `/stop` direct-run paths; AbortController-driven `/stop` with stop-button affordance while running; active-skill chip; visible session pill.
- `src/styles.css` — `.slash-menu`, `.slash-row`, `.slash-empty`, `.slash-hint`, `.composer-skill-chip`, `.chat-skill-chip`, `.stop-button`, `.workspace-header`, `.session-pill`.
- `src/App.test.tsx` — slash-picker open/close, keyboard nav, Escape, direct-run paths, provider-registry shape, session-pill visibility.
- Removed: `src-tauri/src/_tag_debug.rs` (stale one-off debug helper).

Tests:

- 31 Rust tests pass.
- 20 frontend tests pass.
- TypeScript clean (`tsc --noEmit`).

Adding a new provider (recipe):

1. Add `src-tauri/src/providers/<name>.rs` with a struct implementing `ChatProvider`.
2. Register it in `BUILTIN_PROVIDERS` in `providers/mod.rs`.
3. Add the matching entry in `src/providers/registry.ts`.

No other code needs to change — the composer, dispatch, persistence, and UI all use the generic types.
