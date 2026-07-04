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

Status: in progress

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

Status: in progress

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

Status: in progress

Acceptance:

- `npm run typecheck` passes.
- `npm run test` passes.
- `npm run build` passes.
- `npm run tauri:build` is attempted with local Rust path configured.
- Any environment blockers are documented with exact output.

Progress:

- [ ] Run typecheck.
- [ ] Run tests.
- [ ] Run frontend build.
- [ ] Run Tauri build/check.
- [ ] Update this document with exact command output.

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
