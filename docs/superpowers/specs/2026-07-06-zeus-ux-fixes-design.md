# Zeus UX Fixes — Design Spec

**Date:** 2026-07-06
**Author:** Claude (brainstormed with user)
**Project:** Zeus — local-first coding agent (Tauri 2 + React/TS + Rust + SQLite)
**Status:** Draft, pending user review

## Goal

Address seven user-reported UX defects in the Zeus desktop app without changing the
public IPC surface, the data model, or the role of the agent loop.

After this work, Zeus:

- Launches as a fullscreen desktop window with no console attached.
- Renders chat bubbles using a mainstream chat-UI layout (user messages right-aligned).
- Provides a clear, harmless slash command menu that survives whitespace.
- Surfaces pending harness decisions via a notification badge.
- On approval, scaffolds a new chat session seeded with the proposal and runs the agent
  loop against it, with the model wired to self-recover from step failures and
  produce a structured three-section final reply.
- Renders per-step agent progress in a dedicated chat bubble so partial failures
  never look like total failures.

## Non-Goals

- Cross-platform installer work. (Already shipped in a prior task; see `bundle/`
  artifacts in `src-tauri/target/release/`.)
- Code-signing release artifacts. (Tracked in README "not yet production-ready" gap.)
- Adding a schema or IPC channel for structured self-recovery. (SYSTEM_PROMPT
  guidance is sufficient per user choice.)
- Editing a proposal after it has been decided. Apply is one-way; Discard is
  the only alternative path. Pre-send editing of the proposal body happens in
  the new session's composer instead of via a dedicated proposal-edit action.

## Sub-Projects

Four sub-projects in dependency order. Each is independently testable.

| # | Sub-project | Risk | Files touched |
|---|---|---|---|
| 1 | Window + console | low | `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs` |
| 2 | Chat bubble layout | low | `src/styles.css` |
| 3 | Slash picker UX | low | `src/providers/slash.ts` (no behavior change), `src/App.tsx` (hint copy) |
| 4 | Harness evolution + agent pipeline | medium-high | `src/state/harness.ts`, `src/state/harness.notifications.ts` (new), `src/App.tsx`, `src/styles.css`, `src/providers/slash.ts` (status copy), `src-tauri/src/lib.rs` (no schema change) |

---

## Sub-project 1 — Window mode + hide console

### Changes

**`src-tauri/tauri.conf.json`** — add `"fullscreen": true` to the single window
block:

```diff
   "app": {
     "windows": [
       {
         "title": "Zeus",
+        "fullscreen": true,
         "width": 1440,
         "height": 920,
         "minWidth": 1024,
         "minHeight": 720,
         "resizable": true
       }
     ],
```

The existing width/height/resizable flags remain. On launch Tauri fills the primary
monitor; the user can minimize or restore. We do not lock fullscreen
(`fullscreen: false` after launch). User can Esc or click the window control to
exit fullscreen on platforms that support it.

**`src-tauri/src/main.rs`** — hide the console window only on Windows release
builds. Rust's standard toolchain supports an attribute on `fn main`:

```rust
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    zeus_lib::run();
}
```

Effect: in `cargo run` (debug builds), the console window is visible for log
output. In packaged MSI/NSIS installers (release builds), no console window is
created. This matches the README's "Zeus is a desktop app" intent.

**`src-tauri/src/lib.rs`** — replace the bare `eprintln!` at line 234 with a
`tracing` call so debug output still flows through whatever subscriber the
project adds later. Concretely:

```diff
-            Err(error) => eprintln!("Skipping invalid skill {}: {error}", path.display()),
+            Err(error) => tracing::warn!(skill = %path.display(), "{error}", "Skipping invalid skill"),
```

The `tracing` crate is not yet a dependency. We add it to `Cargo.toml`
`[dependencies]` as `tracing = "0.1"`. No subscriber is registered by default
(no-op in release; logs to stderr in debug via the env-filter subscriber in a
follow-up if desired). This avoids re-introducing a console window.

### Verification

- `npm run tauri:build` produces MSI/NSIS with no console window on launch.
- `cargo run` (debug) still shows stderr.
- Existing skills list still logs invalid skills with the file path in stderr.

---

## Sub-project 2 — Chat bubble layout

### Problem

`src/styles.css:445–449` aligns user messages to the right edge using `direction: rtl`
on the row, then sets `direction: ltr` on the body. The `direction: rtl`
overrides any inherited layout direction locally. Net effect: the row reads
right-to-left, but text inside `chat-body` reverts to LTR. On some browsers /
WebView2 builds this bleeds into pre-wrapped text and bullet rendering; the user
reports the bubble looks "squeezed vertically on the left."

### Change

Replace the RTL trick with a standard two-column row where the avatar lives in
the last column and the body in the first, justified to the right edge of the
column:

```diff
 .chat-user {
-  /* Push the avatar + body to the right edge of the conversation. */
-  grid-template-columns: 1fr 32px;
-  direction: rtl;
+  /* User messages: avatar on the right edge, body to its left. */
+  grid-template-columns: 1fr 32px;
+  justify-content: end;
 }

 .chat-user .chat-body {
-  direction: ltr;
-  text-align: right;
-  align-items: flex-end;
+  justify-self: end;
+  text-align: right;
+  align-items: flex-end;
+  max-width: 85%;
 }
```

Net layout: row reads `body | avatar` left to right, with body justified to
the right edge of its column. Matches Slack, iMessage, ChatGPT. No RTL
side-effects on text rendering.

### Verification

- User messages align right, avatar on the right edge of the row.
- Pre-wrapped multi-line text wraps normally (no vertical squeeze).
- No regression on existing tests (`App.test.tsx`, `MarkdownView.test.tsx`).

---

## Sub-project 3 — Slash picker UX

### Problem

User reports: "when I type `/` in the input box no commands are shown." A
follow-up clarifies the user expects all commands at `/` and progressive
filtering while typing more characters, with no premature close.

Looking at `src/providers/slash.ts:90–96`:

```ts
export function detectSlash(value: string): string | null {
  if (!value.startsWith("/")) return null;
  if (/\s/.test(value.slice(1))) return null;
  return value.slice(1);
}
```

So `/read` shows all matches, `/read` plus any space closes the menu. The user
reads this as "the menu closed" and assumes filtering is broken. The actual
behavior is intentional (slash commands take no arguments after a space) but
the user can't tell.

### Change

Behavior is unchanged. Add an explanatory hint at the bottom of the slash menu
that names what the user just saw:

```diff
-                  <p className="slash-hint">Up Down to move - Enter or Tab to pick - Esc to close</p>
+                  <p className="slash-hint">Up Down to navigate, Enter or Tab to pick, Esc to close. Typing a space picks the command and starts its arguments.</p>
```

Additionally, while typing whitespace after a command, show a transient
reminder rather than vanishing silently. Concretely: when `detectSlash` returns
`null` because of trailing whitespace AND the bare slash prefix matched a known
command, the App's composer briefly flashes a small "→ /read" chip in the
slash-menu slot before the menu closes.

### Verification

- `/` shows all built-in commands + skills.
- `/run` shows only matches whose id/description contains "run".
- `/run ` followed by anything shows no slash menu but a transient chip "→ /run".
- Pre-existing tests in `slash.ts` continue to pass; we add `slash.test.ts` if
  one does not already exist (it does not, by inspection).

---

## Sub-project 4 — Harness evolution + agent pipeline

### Components

Five components, each with one job and clean boundaries. All live in the
existing `src/` tree; no new Rust IPC commands are introduced.

**a) `src/state/harness.ts` — proposal state machine (extended)**

Today:

```ts
export type HarnessProposalStatus =
  | "ready" | "approved" | "edited" | "rejected" | "applied-once" | "rolled-back";
```

Extended:

```ts
export type HarnessProposalStatus =
  | "ready"          // pending decision; counted in notification badge
  | "edited"         // user edited; still pending; counted in badge
  | "approved"       // user approved; about to start implementing session
  | "implementing"   // implementing session created and first message sent
  | "applied"        // implementing session reached a successful final reply
  | "applied-once"   // (legacy) explicit one-shot application
  | "failed"         // implementing session ended without a final success
  | "rejected"       // user rejected; no session created
  | "rolled-back";   // (legacy) explicit rollback
```

`HarnessHistoryEntry` gains a `sessionId?: string` so the history can link to
the implementing session.

```ts
export interface HarnessHistoryEntry {
  proposalId: string;
  action: HarnessProposalStatus;
  at: string;
  sessionId?: string;
}
```

The existing `transitionHarnessProposal` helper stays for backward compatibility
but new code uses `applyProposalTransition(proposal, action, sessionId?)` which
returns `{ proposal, historyEntry }` and stamps the optional `sessionId`.

**b) `src/state/harness.notifications.ts` — new module**

Tiny pure helper:

```ts
export function countPendingProposals(
  currentProposal: HarnessProposal | null,
  viewOpen: boolean,
): number {
  if (viewOpen) return 0;
  if (!currentProposal) return 0;
  return currentProposal.status === "ready" || currentProposal.status === "edited"
    ? 1
    : 0;
}
```

Today there is exactly one proposal at a time (the sidebar `harness-card` plus
the Harness Evolution view render the same single object). If the project
later moves to multiple proposals, this helper becomes a `.filter().length`
over the array.

**c) `App.tsx` — sidebar notification badge**

Find the `navItems.map(...)` block. Render a small badge element to the right
of the "Harness Evolution" label when `countPendingProposals > 0`:

```tsx
{label === "Harness Evolution" && notificationCount > 0 ? (
  <span className="nav-badge" aria-label={`${notificationCount} pending`}>{notificationCount}</span>
) : null}
```

Badge styling: small circular red (or `--accent-warning`) chip with a count or
"…" when count is greater than 9. The badge is hidden when
`activeView === "Harness Evolution"` because the user has explicitly opened
the menu.

**d) `App.tsx` — apply flow**

The current sidebar card and Harness Evolution panel render five buttons:
Approve / Edit / Reject / Apply Once / Roll Back. We replace them with
exactly two: **Apply** and **Discard**. (The user-facing button labels
change; the internal status enum literals — `approved`, `rejected`, etc. —
stay the same because they describe state transitions, not user actions.)

**Apply** opens a new chat session named after the proposal title and
pre-fills the composer with the proposal body. The user can edit the body
freely in the composer before pressing Send. The Composer (not the harness
panel) is now the edit surface. When the user presses Send, the existing
`handleSend` pipeline parses any `tool` block emitted by the model and runs
the agent loop. There is no auto-send on Apply — the user is always in
control of when the request actually goes to the model.

Implementation:

```ts
function applyProposal() {
  if (!proposal) return;
  const proposalSnapshot = proposal;
  // 1. Mark implementing; record history; clear the badge.
  applyProposalTransition(proposalSnapshot, "approved");
  // 2. Create a new session with the proposal title as its label.
  startNewSession({ label: proposalSnapshot.title });
  // 3. Seed the composer with the proposal body and focus it so the user
  //    can edit before sending. No auto-send.
  setMessage(proposalSnapshot.body);
  requestAnimationFrame(() => composerRef.current?.focus());
}
```

`startNewSession` is already defined; we extend its signature to accept an
optional `{ label }` arg. The harness card's existing **Apply** button calls
`applyProposal`. **Discard** records the transition to `rejected` and clears
the badge.

**Harness card UI:**

```diff
-<button type="button" onClick={() => recordProposal("approved")}>Approve</button>
-<button type="button" onClick={beginProposalEdit}>Edit</button>
-<button type="button" onClick={() => recordProposal("rejected")}>Reject</button>
+<button type="button" onClick={applyProposal}>Apply</button>
+<button type="button" onClick={discardProposal}>Discard</button>
```

The `proposalEditing` flow, the `proposalEditing` state, the `proposalDraft`
state, and the `Edit` action button are deleted (no longer needed —
pre-send editing happens in the new session's composer). The textarea
formerly rendered inside the Harness Evolution panel under `proposalEditing`
is removed; the panel becomes read-only when status is not pending.

**e) `App.tsx` — Harness Evolution view becomes read-only history**

The current view (`harness-card` sidebar + Harness Evolution panel) shows
proposal body + five action buttons + status + history list. We render:

- title, summary, status
- the linked session (if any), with an "Open implementing session" button that
  invokes `selectSession(sessionRefFromHistory)`. If the session has been
  pruned from `recentSessions` (current cap is 20), the button fetches the
  full session row from SQLite via `listSessions()` and rehydrates
  `activeSession`/`chat` from the persisted `messagesJson`, matching the
  existing flow inside `selectSession`. If the session has been deleted, the
  button is hidden and a "session no longer available" note is shown
  instead.
- a `history`-style chronological list of past decisions

Action buttons on the Harness Evolution panel match the sidebar card:
**Apply** (only when status is `ready`/`edited`) and **Discard** (only when
status is `ready`/`edited`). For other statuses, no buttons render.

**f) `App.tsx` — per-step agent-progress bubble**

When the agent pipeline starts, post a single chat-message variant with
`kind: "agent-progress"`:

```ts
interface AgentProgressMessage {
  id: number;
  role: "zeus";
  kind: "agent-progress";
  steps: AgentProgressStep[];
  expanded: boolean;
}

interface AgentProgressStep {
  index: number;
  label: string;
  status: "pending" | "running" | "ok" | "failed";
  result?: string;          // short summary
}
```

The Rust `run_agent_task` already returns `logs: AgentRunStepLog[]` with
`{ index, label, result }` where `result` is an `AgentStepResult` enum. The
frontend builds the `AgentProgressStep[]` from that return value when the
command resolves (no streaming in this iteration; see "Trade-offs" below).

Implementation:

```ts
function mapStepResult(result: AgentStepResult): "ok" | "failed" {
  // Match the tagged enum variants from the Rust schema. The exact
  // serialization shape (keyed enum vs string-tag) is set by Tauri's
  // IPC layer; we treat any non-Failed variant as "ok" and inspect the
  // payload of Failed to surface the message in the progress bubble.
  if (typeof (result as any).Failed === "string") return "failed";
  if (typeof (result as any).failed === "string") return "failed";
  return "ok";
}
```

The mapping handles the two shapes Tauri can serialize a Rust enum to
(`{ Failed: "..." }` or `{ failed: "..." }`) without flagging a runtime
warning. If neither shape matches, the step is treated as successful and a
dev-only `console.warn` is logged. The unit test for this helper covers both
shapes.

A small `<AgentProgressBubble>` component renders the list with icons
matching the MarkdownView vocabulary (Sparkles / Check / X). Default expanded
when a step is still pending, collapsed after the run.

**g) `App.tsx` — SYSTEM_PROMPT extension for self-recovery and structured reply**

Current prompt is concise. We extend with a clearly-marked block at the end:

```text
# On failures and partial outcomes
- If a tool step fails, attempt a corrected `tool` block that takes a
  different approach, or include a fallback in the next tool block, before
  emitting your final reply. Do not give up after one failure.
- Only emit a final reply when you cannot proceed further on your own.
- When you do emit a final reply (whether the run succeeded, partially
  succeeded, or fully failed), structure it as three sections:
  - **What was done** — concrete actions and the result for each.
  - **What's still pending** — open items, with the reason each is pending.
  - **Why it's pending** — the failure or constraint that left it open.
- If pending items need a user decision, end the final reply with a
  **Decision needed** section that names the choice, options, and which
  option you recommend.
```

This is plain text guidance to the model. No schema change, no Rust change.
The model is already producing `tool` blocks; we just teach it to recover and
to format its final reply.

### Trade-offs (called out so user can challenge)

- **No streaming for per-step progress.** Tauri's `ipc::Channel` would let the
  Rust loop push step updates as they happen. We defer that complexity: the
  agent loop is bounded by `MAX_TOOL_TURNS = 6` and runs locally, so the
  latency between step 1 finishing and all steps finishing is small enough
  that rendering the per-step list from the final `logs` array (animated-in)
  is acceptable. A future iteration can add streaming if the user wants to
  watch `cargo test` output live, etc.
- **Apply is one-way.** Per user choice ("no more actions directly here").
  Discard remains as the alternative.
- **`HarnessProposalStatus` enum grows.** This is a breaking change to anyone
  who imports the type. The repo has only one consumer (App.tsx) so the cost
  is contained.

### Verification

- New unit tests in `src/state/harness.test.ts`:
  - `approved` → `implementing` → `applied` happy path
  - `approved` → `implementing` → `failed` partial-failure path
  - history entry carries `sessionId` after approval
- New `src/state/harness.notifications.test.ts`:
  - count is 1 for `ready`/`edited` proposal
  - count is 0 when proposal is `approved`/`applied`/`rejected`
  - count is 0 when view is open even if proposal is `ready`
- `App.test.tsx` additions:
  - approving a proposal creates a new session whose label matches the proposal title
  - approving a proposal records a `history` entry with the new sessionId
  - approving a proposal seeds the composer with the proposal body and
    triggers `handleSend` (mock the model call + the Rust `run_agent_task`)
- CSS regression: `App.test.tsx` and `MarkdownView.test.tsx` continue passing.

### Out of scope (re-stated, deliberate)

- Editing proposals or retrying after Discard (one-way per user)
- Persisting the notification badge across launches (computed from state)
- Changing the right-inspector plan items list (separate concern)
- Cross-platform installer changes
- Code signing for installers

---

## End-to-end impact summary

After this work:

1. Zeus launches as a fullscreen window with no console window attached in
   release builds. The MSI/NSIS artifact produced by the previous task continues
   to work; the source change to `tauri.conf.json` is what propagates to the
   next installer's bundle config.
2. Chat layout follows the standard right-aligned user bubble pattern.
3. The slash command picker behaves the same way it did, but its hint copy
   makes the "pick a command then arguments" semantics obvious.
4. Harness Evolution menu shows a notification badge while pending decisions
   exist; the badge clears when the user opens the menu.
5. Clicking "Apply" creates a new chat session named after the proposal and
   pre-fills the composer with the proposal body. The user edits as desired
   in the composer and presses Send manually; on Send the agent pipeline
   runs.
6. During that run, a per-step progress bubble shows each tool step by index
   and outcome, so partial failures never look like total failures.
7. The model is instructed to self-recover from failed steps via corrected
   `tool` blocks and to produce a structured final reply with sections "What
   was done," "What's still pending," "Why it's pending," and "Decision
   needed" when applicable.
8. A failed or partially-failed run leaves the implementing session available
   to the user, who can continue chatting to address model decision requests.
9. The proposal becomes `applied` (success) or `failed` (otherwise); the
   harness history permanently records the linked session id.

Nothing in this design changes the IPC schema, the SQLite schema, the public
TypeScript surface beyond `harness.ts`, or the test runner configuration.

## Open questions for user

None — all addressed during brainstorming.
