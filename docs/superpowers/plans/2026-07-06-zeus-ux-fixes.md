# Zeus UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four sub-projects specified in `docs/superpowers/specs/2026-07-06-zeus-ux-fixes-design.md`: fullscreen launch, hidden console window, right-aligned chat bubbles, slash picker hint clarity, harness notification badge, Apply/Discard flow with pre-send composer editing, per-step agent-progress bubble, and SYSTEM_PROMPT guidance for self-recovery + structured final reply.

**Architecture:** Pure extension of existing Tauri + React + TS patterns. No new IPC commands, no new schema, no SQLite migrations. STATE MACHINE extension in `src/state/harness.ts`. New tiny pure helper `src/state/harness.notifications.ts`. CSS-only fixes for layout. SYSTEM_PROMPT edited in place. Most behavior changes are local to `App.tsx`.

**Tech Stack:** Tauri 2, React 18, TypeScript, Vitest, Rust 1.95, Cargo, WiX 3, NSIS 3.11, vite, npm.

**Spec:** `docs/superpowers/specs/2026-07-06-zeus-ux-fixes-design.md`

---

## File Structure

Files created in this plan:
- `src/state/harness.notifications.ts` — pure helper, one function.
- `src/state/harness.notifications.test.ts` — vitest unit tests.
- `src/components/AgentProgressBubble.tsx` — UI component for per-step agent run rendering.

Files modified:
- `src-tauri/tauri.conf.json` — `"fullscreen": true` flag.
- `src-tauri/src/main.rs` — `#![windows_subsystem = "windows"]` attribute.
- `src-tauri/src/lib.rs` — replace `eprintln!` with `tracing::warn!`.
- `src-tauri/Cargo.toml` — add `tracing = "0.1"` dependency.
- `src/styles.css` — chat bubble layout, agent-progress bubble styles, nav-badge style, harness read-only view styles.
- `src/state/harness.ts` — extended `HarnessProposalStatus` enum, add `sessionId?` to `HarnessHistoryEntry`, add `applyProposalTransition`.
- `src/state/harness.test.ts` — additional tests for new statuses and helper.
- `src/App.tsx` — major edit: notification badge, apply/discard flow, agent-progress bubble rendering, SYSTEM_PROMPT extended, harness view refactored.
- `src/components/AgentProgressBubble.tsx` — new file (created above).

Each task below produces self-contained changes that compile and test independently. Sub-projects are ordered: 1 (window+console) → 2 (chat layout) → 3 (slash hint) → 4 (harness/agent pipeline). Sub-project 4 is the largest and contains its own internal ordering.

---

## Task 1: Fullscreen window flag

**Files:**
- Modify: `src-tauri/tauri.conf.json:13-22`

- [ ] **Step 1: Edit tauri.conf.json**

Open `src-tauri/tauri.conf.json` and add `"fullscreen": true` to the window block. The block currently reads:

```json
    "windows": [
      {
        "title": "Zeus",
        "width": 1440,
        "height": 920,
        "minWidth": 1024,
        "minHeight": 720,
        "resizable": true
      }
    ],
```

Add `"fullscreen": true` as a new line right after `"title": "Zeus",`. Result:

```json
    "windows": [
      {
        "title": "Zeus",
        "fullscreen": true,
        "width": 1440,
        "height": 920,
        "minWidth": 1024,
        "minHeight": 720,
        "resizable": true
      }
    ],
```

- [ ] **Step 2: Verify JSON is valid**

Run: `cd ~/Projects/Zeus && node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('ok')"`
Expected output: `ok`

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/Zeus && git add src-tauri/tauri.conf.json && git commit -m "feat(window): launch Zeus in fullscreen on Windows"
```

---

## Task 2: Hide console window in release builds

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs:234`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Replace main.rs to add windows_subsystem attribute**

Replace the entire content of `src-tauri/src/main.rs` (currently 3 lines) with:

```rust
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    zeus_lib::run();
}
```

- [ ] **Step 2: Add tracing dependency**

In `src-tauri/Cargo.toml`, find the `[dependencies]` section. Add this line at the end of the dependencies list (after `once_cell = "1"` or after the last entry):

```toml
tracing = "0.1"
```

- [ ] **Step 3: Replace eprintln! with tracing::warn! in lib.rs**

In `src-tauri/src/lib.rs`, find the line (line ~234):

```rust
            Err(error) => eprintln!("Skipping invalid skill {}: {error}", path.display()),
```

Replace with:

```rust
            Err(error) => tracing::warn!(skill = %path.display(), "{error}", "Skipping invalid skill"),
```

- [ ] **Step 4: Verify cargo check passes**

Run: `cd ~/Projects/Zeus/src-tauri && cargo check 2>&1 | tail -30`
Expected: ends with `Finished ...` and no `error[E...]` lines.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/Zeus && git add src-tauri/src/main.rs src-tauri/src/lib.rs src-tauri/Cargo.toml && git commit -m "feat(window): hide Windows console in release builds"
```

---

## Task 3: Chat bubble layout fix

**Files:**
- Modify: `src/styles.css:440-465`

- [ ] **Step 1: Replace the .chat-user layout in styles.css**

In `src/styles.css`, find the block starting at `.chat-zeus` (line ~440) and ending at `.chat-user .chat-heading time` (line ~464). The block currently reads:

```css
.chat-zeus {
  grid-template-columns: 32px 1fr;
  justify-content: start;
}

.chat-user {
  /* Push the avatar + body to the right edge of the conversation. */
  grid-template-columns: 1fr 32px;
  direction: rtl;
}

.chat-user .chat-body {
  direction: ltr;
  text-align: right;
  align-items: flex-end;
}

.chat-user .chat-heading {
  justify-content: flex-end;
  flex-direction: row-reverse;
}

.chat-user .chat-heading time {
  margin-right: 0;
  margin-left: 12px;
}
```

Replace the `.chat-user` block (lines 445-449) with:

```css
.chat-user {
  /* User messages: avatar on the right edge, body to its left.
     Standard chat layout without RTL side-effects. */
  grid-template-columns: 1fr 32px;
  justify-content: end;
}
```

Replace `.chat-user .chat-body` (lines 451-455) with:

```css
.chat-user .chat-body {
  justify-self: end;
  text-align: right;
  align-items: flex-end;
  max-width: 85%;
}
```

Leave the `.chat-user .chat-heading` and `.chat-user .chat-heading time` blocks unchanged (they handle heading alignment and are correct).

- [ ] **Step 2: Run existing tests to verify no regression**

Run: `cd ~/Projects/Zeus && npx vitest run 2>&1 | tail -40`
Expected: all tests pass, no failures.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/Zeus && git add src/styles.css && git commit -m "fix(css): right-align user chat bubbles without RTL side effects"
```

---

## Task 4: Slash picker hint expansion

**Files:**
- Modify: `src/App.tsx:1321`

- [ ] **Step 1: Update the slash-menu hint copy**

In `src/App.tsx`, find line ~1321:

```tsx
                  <p className="slash-hint">Up Down to move - Enter or Tab to pick - Esc to close</p>
```

Replace with:

```tsx
                  <p className="slash-hint">Up Down navigate, Enter or Tab pick, Esc close. Typing a space picks the command and starts its arguments.</p>
```

- [ ] **Step 2: Verify tests pass**

Run: `cd ~/Projects/Zeus && npx vitest run 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/Zeus && git add src/App.tsx && git commit -m "feat(slash): expand picker hint to explain space-picks-command behavior"
```

---

## Task 5: Extend HarnessProposalStatus enum + history.sessionId

**Files:**
- Modify: `src/state/harness.ts`
- Modify: `src/state/harness.test.ts`

- [ ] **Step 1: Update harness.ts with extended state machine**

Replace the entire current content of `src/state/harness.ts` with:

```ts
export type HarnessProposalStatus =
  // Pre-decision states (counted in notification badge).
  | "ready"
  | "edited"
  // User actions.
  | "approved"        // user picked Apply on the harness card
  | "rejected"        // user picked Discard on the harness card
  // Lifecycle of the implementing session.
  | "implementing"    // session created, composer pre-filled with proposal body
  | "applied"         // implementing session reached a successful final reply
  | "failed"          // implementing session ended without success
  // Legacy / one-shot states preserved for history entries imported from older sessions.
  | "applied-once"
  | "rolled-back";

export interface HarnessProposal {
  id: string;
  title: string;
  summary: string;
  body: string;
  status: HarnessProposalStatus;
}

export interface HarnessHistoryEntry {
  proposalId: string;
  action: HarnessProposalStatus;
  at: string;
  /** Set when the action created or referred to a chat session
   *  (e.g. "approved" → implementing session, "applied" → completed session). */
  sessionId?: string;
}

/**
 * Apply a status transition. Returns the updated proposal plus a history
 * entry stamped at `at`. Prefer this over mutating the proposal directly
 * so callers cannot forget the history entry.
 *
 * `sessionId` is stamped on the history entry only when supplied;
 * callers that have a session to link should pass it explicitly.
 */
export function transitionHarnessProposal(
  proposal: HarnessProposal,
  action: HarnessProposalStatus,
  at = new Date().toISOString(),
  sessionId?: string,
): { proposal: HarnessProposal; historyEntry: HarnessHistoryEntry } {
  const proposalAfter = { ...proposal, status: action };
  const historyEntry: HarnessHistoryEntry = {
    proposalId: proposal.id,
    action,
    at,
  };
  if (sessionId !== undefined) {
    historyEntry.sessionId = sessionId;
  }
  return { proposal: proposalAfter, historyEntry };
}
```

- [ ] **Step 2: Run existing harness tests to verify they still pass**

Run: `cd ~/Projects/Zeus && npx vitest run src/state/harness.test.ts 2>&1 | tail -20`
Expected: the existing single test (`records approval in the proposal and change history`) passes.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/Zeus && git add src/state/harness.ts src/state/harness.test.ts && git commit -m "feat(harness): extend proposal status state machine with implementing/applied/failed"
```

---

## Task 6: Harness notifications helper

**Files:**
- Create: `src/state/harness.notifications.ts`
- Create: `src/state/harness.notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/state/harness.notifications.test.ts` with the following content:

```ts
import { describe, expect, it } from "vitest";
import type { HarnessProposal } from "./harness";
import { countPendingProposals } from "./harness.notifications";

function proposal(overrides: Partial<HarnessProposal> = {}): HarnessProposal {
  return {
    id: "p-1",
    title: "Test proposal",
    summary: "Summary",
    body: "Body",
    status: "ready",
    ...overrides,
  };
}

describe("countPendingProposals", () => {
  it("returns 0 when there is no proposal", () => {
    expect(countPendingProposals(null, false)).toBe(0);
  });

  it("returns 1 when the current proposal is in a pending state", () => {
    expect(countPendingProposals(proposal({ status: "ready" }), false)).toBe(1);
    expect(countPendingProposals(proposal({ status: "edited" }), false)).toBe(1);
  });

  it("returns 0 when the current proposal has been decided", () => {
    expect(countPendingProposals(proposal({ status: "approved" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "applied" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "failed" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "rejected" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "implementing" }), false)).toBe(0);
  });

  it("returns 0 when the menu view is open even for a pending proposal", () => {
    expect(countPendingProposals(proposal({ status: "ready" }), true)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Projects/Zeus && npx vitest run src/state/harness.notifications.test.ts 2>&1 | tail -20`
Expected: FAIL with "Cannot find module './harness.notifications'" or similar module-not-found error.

- [ ] **Step 3: Implement countPendingProposals**

Create `src/state/harness.notifications.ts`:

```ts
import type { HarnessProposal } from "./harness";

/**
 * Compute the notification-badge count for the Harness Evolution menu.
 *
 * Today Zeus carries exactly one pending proposal at a time, so this
 * returns 1 or 0. If the project ever moves to multiple proposals,
 * change the implementation to a `.filter().length` over the array —
 * the call sites stay the same.
 */
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/Projects/Zeus && npx vitest run src/state/harness.notifications.test.ts 2>&1 | tail -20`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/Zeus && git add src/state/harness.notifications.ts src/state/harness.notifications.test.ts && git commit -m "feat(harness): add notification badge count helper"
```

---

## Task 7: AgentProgressBubble component + step-result mapper

**Files:**
- Create: `src/components/AgentProgressBubble.tsx`
- Create: `src/components/AgentProgressBubble.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/AgentProgressBubble.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentProgressBubble, mapStepResult, type AgentProgressStep } from "./AgentProgressBubble";

describe("mapStepResult", () => {
  it("returns 'failed' when the result carries a Failed tag (PascalCase)", () => {
    expect(mapStepResult({ Failed: "boom" })).toBe("failed");
  });

  it("returns 'failed' when the result carries a failed tag (lowercase)", () => {
    expect(mapStepResult({ failed: "boom" })).toBe("failed");
  });

  it("returns 'ok' for all other result shapes", () => {
    expect(mapStepResult({ ReadFile: { path: "x", content: "" } })).toBe("ok");
    expect(mapStepResult({ RunCommand: { program: "x", args: [], cwd: "", stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 0 } })).toBe("ok");
    expect(mapStepResult("totally unexpected")).toBe("ok");
  });
});

const steps: AgentProgressStep[] = [
  { index: 0, label: "read src/foo.ts", status: "ok" },
  { index: 1, label: "edit src/foo.ts", status: "failed", result: "edit conflict" },
  { index: 2, label: "run npm test", status: "ok", result: "all green" },
];

describe("AgentProgressBubble", () => {
  it("renders the step list with status icons and labels", () => {
    render(<AgentProgressBubble steps={steps} completed={2} total={3} partial />);
    expect(screen.getByText("read src/foo.ts")).toBeTruthy();
    expect(screen.getByText("edit src/foo.ts")).toBeTruthy();
    expect(screen.getByText("run npm test")).toBeTruthy();
    expect(screen.getByText(/2\s*\/\s*3\s*steps/i)).toBeTruthy();
  });

  it("renders an indicator when the run is fully successful", () => {
    render(<AgentProgressBubble steps={steps} completed={3} total={3} partial={false} />);
    expect(screen.getByText(/succeeded|complete/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/Projects/Zeus && npx vitest run src/components/AgentProgressBubble.test.tsx 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AgentProgressBubble**

Create `src/components/AgentProgressBubble.tsx`:

```tsx
import { Check, ChevronDown, ChevronRight, Sparkles, X } from "lucide-react";
import React, { useState } from "react";

export type AgentStepStatus = "pending" | "running" | "ok" | "failed";

export interface AgentProgressStep {
  index: number;
  label: string;
  status: AgentStepStatus;
  result?: string;
}

/**
 * Map the unknown `AgentRunStepLog.result` payload (a serialized Rust enum)
 * to a coarse status used by the progress bubble.
 *
 * The Rust schema uses `serde(tag = "...")`. Both PascalCase (Tauri's
 * serde_json default) and lowercase key shapes are handled so the call
 * site stays robust against minor schema changes.
 */
export function mapStepResult(result: unknown): AgentStepStatus {
  if (typeof result !== "object" || result === null) return "ok";
  const obj = result as Record<string, unknown>;
  if (typeof obj.Failed === "string") return "failed";
  if (typeof obj.failed === "string") return "failed";
  return "ok";
}

interface AgentProgressBubbleProps {
  steps: AgentProgressStep[];
  /** Number of steps that completed (succeeded OR failed). */
  completed: number;
  /** Total step count. */
  total: number;
  /** True when at least one step failed but the run continued. */
  partial: boolean;
  /** Optional override for the start-open state. Default: true while any step is pending. */
  defaultOpen?: boolean;
}

export function AgentProgressBubble({
  steps,
  completed,
  total,
  partial,
  defaultOpen,
}: AgentProgressBubbleProps) {
  const [open, setOpen] = useState(
    defaultOpen ?? steps.some((s) => s.status === "pending" || s.status === "running"),
  );
  const statusLabel = partial ? "partial" : completed === total ? "succeeded" : "running";
  const statusClass = partial ? "partial" : completed === total ? "ok" : "running";

  return (
    <article className="chat-bubble chat-zeus agent-progress" data-testid="agent-progress">
      <div className="chat-avatar" aria-hidden="true">
        <Sparkles size={16} />
      </div>
      <div className="chat-body">
        <div className="agent-progress-header">
          <button
            aria-expanded={open}
            className="agent-progress-toggle"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <strong>Agent run</strong>
            <span className={`agent-progress-status agent-progress-status-${statusClass}`}>
              {statusLabel}
            </span>
            <span className="agent-progress-count">{completed} / {total} steps</span>
          </button>
        </div>
        {open ? (
          <ol className="agent-progress-list">
            {steps.map((step) => (
              <li
                className={`agent-progress-row agent-progress-row-${step.status}`}
                key={`${step.index}-${step.label}`}
              >
                <span className="agent-progress-icon" aria-hidden="true">
                  {step.status === "failed" ? (
                    <X size={12} />
                  ) : step.status === "ok" ? (
                    <Check size={12} />
                  ) : step.status === "running" ? (
                    <Sparkles size={12} />
                  ) : (
                    <span className="agent-progress-num">{step.index + 1}</span>
                  )}
                </span>
                <span className="agent-progress-label">{step.label}</span>
                {step.result ? <span className="agent-progress-result">{step.result}</span> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </article>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/Projects/Zeus && npx vitest run src/components/AgentProgressBubble.test.tsx 2>&1 | tail -30`
Expected: 5 tests pass.

- [ ] **Step 5: Add minimal CSS**

In `src/styles.css`, append the following at the end of the file:

```css
/* Agent run progress bubble (sub-project 4) */

.agent-progress-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  color: inherit;
}

.agent-progress-status {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 999px;
}

.agent-progress-status-ok {
  background: #e6f4ea;
  color: #137333;
}

.agent-progress-status-partial {
  background: #fef7e0;
  color: #b06000;
}

.agent-progress-status-running {
  background: #e8eaf6;
  color: #3a47b1;
}

.agent-progress-count {
  color: var(--muted, #888);
  font-size: 12px;
}

.agent-progress-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-progress-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.agent-progress-row-ok {
  color: var(--text, #222);
}

.agent-progress-row-failed {
  color: #b00020;
}

.agent-progress-row-running {
  color: #3a47b1;
}

.agent-progress-icon {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 11px;
}

.agent-progress-num {
  font-size: 11px;
  color: inherit;
}

.agent-progress-result {
  font-size: 11px;
  color: var(--muted, #888);
  text-align: right;
}
```

- [ ] **Step 6: Run all tests again**

Run: `cd ~/Projects/Zeus && npx vitest run 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/Zeus && git add src/components/AgentProgressBubble.tsx src/components/AgentProgressBubble.test.tsx src/styles.css && git commit -m "feat(agent): add AgentProgressBubble for per-step run rendering"
```

---

## Task 8: Refactor App.tsx — apply flow, notification badge, agent-progress rendering, harness view

**Files:**
- Modify: `src/App.tsx`

This is the largest task. Edits are additive and structured so a partial completion can still typecheck. Steps below each represent a self-contained unit.

### Step 8a: Update imports + state shape

- [ ] **Step 1: Add new imports + state fields**

In `src/App.tsx`, find the existing `import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";` (around line 34). Replace with:

```ts
import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";
import { countPendingProposals } from "./state/harness.notifications";
import { AgentProgressBubble, mapStepResult, type AgentProgressStep } from "./components/AgentProgressBubble";
```

Find the existing `[proposal, setProposal] = useState<...>(...)` block (around line 220-228) and append new state after it (right after the `setProposalDraft` line ~228):

```ts
  const [agentProgress, setAgentProgress] = useState<{ steps: AgentProgressStep[]; completed: number; partial: boolean } | null>(null);
  const [proposalDraftBody, setProposalDraftBody] = useState<string | null>(null);
  const notificationCount = countPendingProposals(proposal, activeView === "Harness Evolution");
```

Find the existing `function startNewSession() {` declaration (around line 386) and replace the entire function with:

```ts
  function startNewSession(options?: { label?: string }) {
    const id = newSessionId();
    const label = options?.label?.trim() || "Untitled Session";
    const ref: SessionRef = { id, label, projectId: activeProject.id, projectName: activeProject.name };
    setRecentSessions((current) => [ref, ...current.filter((entry) => entry.id !== id)].slice(0, 20));
    setActiveSession(ref);
    setChat([]);
    setCompactFromId(null);
    setMessage("");
    setAttachedFiles([]);
    setActiveSkillId(null);
    setRunState("idle");
    setActiveView("Home");
    saveSession({ id, label: ref.label, projectId: ref.projectId, projectName: ref.projectName, messagesJson: "[]", compactFromId: null }).catch(() => undefined);
  }
```

- [ ] **Step 2: Run typecheck**

Run: `cd ~/Projects/Zeus && npx tsc --noEmit 2>&1 | tail -30`
Expected: any errors refer only to the still-unused `applyProposal` / `discardProposal` calls, which we add next. If there are unrelated errors, fix those first.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/Zeus && git add src/App.tsx && git commit -m "refactor(app): add agent progress state, extend startNewSession signature"
```

### Step 8b: Replace recordProposal with applyProposal + discardProposal

- [ ] **Step 4: Replace recordProposal helper**

Find the existing `function recordProposal(...)` block (around line 324-328). Replace with:

```ts
  function recordProposalTransition(action: HarnessProposal["status"], sessionId?: string) {
    if (!proposal) return;
    const result = transitionHarnessProposal(proposal, action, new Date().toISOString(), sessionId);
    setProposal(result.proposal);
    setHistory((entries) => [result.historyEntry, ...entries].slice(0, 4));
  }

  function applyProposal() {
    if (!proposal) return;
    const proposalSnapshot = proposal;
    const newSessionId = newSessionId();
    const ref: SessionRef = {
      id: newSessionId,
      label: proposalSnapshot.title,
      projectId: activeProject.id,
      projectName: activeProject.name,
    };
    // 1. Mark the proposal as approved and link the implementing session in history.
    const proposalApproved = { ...proposalSnapshot, status: "approved" as const };
    setProposal(proposalApproved);
    setHistory((entries) => [
      { proposalId: proposalApproved.id, action: "approved" as const, at: new Date().toISOString(), sessionId: newSessionId },
      ...entries,
    ].slice(0, 4));
    // 2. Create the new session with the proposal title as its label.
    setRecentSessions((current) => [ref, ...current.filter((entry) => entry.id !== newSessionId)].slice(0, 20));
    setActiveSession(ref);
    setChat([]);
    setCompactFromId(null);
    setMessage(proposalSnapshot.body);
    setAttachedFiles([]);
    setActiveSkillId(null);
    setRunState("idle");
    setActiveView("Home");
    setActiveProjectId(ref.projectId);
    setProposalDraftBody(proposalSnapshot.body);
    saveSession({
      id: ref.id,
      label: ref.label,
      projectId: ref.projectId,
      projectName: ref.projectName,
      messagesJson: "[]",
      compactFromId: null,
    }).catch(() => undefined);
    // 3. Focus the composer — no auto-send. The user edits and presses Send.
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function discardProposal() {
    recordProposalTransition("rejected");
  }
```

- [ ] **Step 5: Replace the sidebar harness-card buttons**

Find the existing sidebar `.harness-card` section (around line 1189-1203). It currently contains two blocks of `<div className="proposal-actions">`. Replace those two action blocks with:

```tsx
          <div className="proposal-actions">
            <button type="button" onClick={applyProposal}>Apply</button>
            <button type="button" onClick={discardProposal}>Discard</button>
          </div>
```

(Replace both the primary and secondary button rows with a single row. Remove the "Edit", "Apply Once", "Roll Back" buttons.)

- [ ] **Step 6: Replace the Harness Evolution view buttons**

Find the `activeView === "Harness Evolution"` block in `App.tsx` (around line 1447-1477). Replace the entire `proposal-actions` row at the end:

```tsx
                <div className="proposal-actions">
                  <button type="button" onClick={() => recordProposalTransition("approved")}>Approve</button>
                  <button type="button" onClick={beginProposalEdit}>Edit</button>
                  <button type="button" onClick={() => recordProposalTransition("rejected")}>Reject</button>
                  <button type="button" onClick={() => recordProposalTransition("applied-once")}>Apply Once</button>
                  <button type="button" onClick={() => recordProposalTransition("rolled-back")}>Roll Back</button>
                </div>
```

with:

```tsx
                {(proposal.status === "ready" || proposal.status === "edited") ? (
                  <div className="proposal-actions">
                    <button type="button" onClick={applyProposal}>Apply</button>
                    <button type="button" onClick={discardProposal}>Discard</button>
                  </div>
                ) : proposal.status === "implementing" || proposal.status === "applied" || proposal.status === "failed" ? (
                  <p className="proposal-status-linked">
                    {proposal.status === "implementing" ? "Implementing session is active in Home. Edit the composer and send to start the agent run." : proposal.status === "applied" ? "Approved improvement was applied via the implementing session. No further actions on this proposal." : "Approved improvement did not complete. Review the implementing session for partial results."}
                  </p>
                ) : null}
```

Also delete the inline `proposalEditing` textarea block (around line 1451-1457) and replace it with a single read-only paragraph:

```tsx
                <p className="proposal-body">{proposal.body}</p>
```

Add a "Linked implementing session" note when history has a session id for this proposal. Inside the same `{activeView === "Harness Evolution" && (...)}` block, after the existing `{history.length === 0 ? (...) : (history.map(...))}` block, add:

```tsx
                {(() => {
                  const linked = history.find((entry) => entry.sessionId && entry.proposalId === proposal.id);
                  if (!linked?.sessionId) return null;
                  const sessionRef = recentSessions.find((s) => s.id === linked.sessionId);
                  return (
                    <p className="proposal-linked-session">
                      Implementing session:{" "}
                      {sessionRef ? (
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => selectSession(sessionRef)}
                        >
                          {sessionRef.label}
                        </button>
                      ) : (
                        <span className="skills-muted">session no longer in recent list</span>
                      )}
                    </p>
                  );
                })()}
```

Delete the `beginProposalEdit` and `saveProposalEdit` functions (around line 330-349) and any references to `proposalEditing`, `proposalDraft`, `setProposalEditing`, `setProposalDraft`. Specifically:

- Remove `const [proposalEditing, setProposalEditing] = useState(false);` (around line 227)
- Remove `const [proposalDraft, setProposalDraft] = useState("");` (around line 228)
- Remove the `beginProposalEdit` function (around line 330-333)
- Remove the `saveProposalEdit` function (around line 335-349)
- Remove `adoptProposedHarnessRule` references to `setProposalEditing(false);` and `setProposalDraft` (around line 508)

- [ ] **Step 7: Run typecheck**

Run: `cd ~/Projects/Zeus && npx tsc --noEmit 2>&1 | tail -30`
Expected: clean (no errors).

- [ ] **Step 8: Run all tests**

Run: `cd ~/Projects/Zeus && npx vitest run 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd ~/Projects/Zeus && git add src/App.tsx && git commit -m "feat(harness): apply/discard flow with pre-send composer editing"
```

### Step 8c: Add notification badge to nav button

- [ ] **Step 10: Add notification badge to nav list**

Find the `navItems.map(...)` block (around line 1142-1147):

```tsx
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button className={label === activeView ? "nav-item active" : "nav-item"} key={label} type="button" onClick={() => setActiveView(label)}>
              <Icon size={16} />{label}
            </button>
          ))}
        </nav>
```

Replace with:

```tsx
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button className={label === activeView ? "nav-item active" : "nav-item"} key={label} type="button" onClick={() => setActiveView(label)}>
              <Icon size={16} />
              <span className="nav-label">{label}</span>
              {label === "Harness Evolution" && notificationCount > 0 ? (
                <span className="nav-badge" aria-label={`${notificationCount} pending proposal${notificationCount === 1 ? "" : "s"}`}>
                  {notificationCount > 9 ? "9+" : notificationCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
```

Add CSS for `.nav-badge` and `.nav-label`. In `src/styles.css`, append:

```css
/* Harness Evolution notification badge */

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-label {
  flex: 1;
  text-align: left;
}

.nav-badge {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: #d93025;
  color: white;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
```

- [ ] **Step 11: Run typecheck + tests**

Run: `cd ~/Projects/Zeus && npx tsc --noEmit 2>&1 | tail -20 && npx vitest run 2>&1 | tail -15`
Expected: both pass clean.

- [ ] **Step 12: Commit**

```bash
cd ~/Projects/Zeus && git add src/App.tsx src/styles.css && git commit -m "feat(harness): render notification badge on Harness Evolution nav item"
```

### Step 8d: Render AgentProgressBubble in chat

- [ ] **Step 13: Wire the agent progress bubble into chat rendering**

Find the chat-rendering block (around line 1274-1299). It currently maps `chat` with a ternary on `entry.role === "user"`. Add a new branch for progress messages. Replace the existing block:

```tsx
              {chat.map((entry) => entry.role === "user" ? (
                <article key={entry.id} className="chat-bubble chat-user">
                  ...
                </article>
              ) : (
                <article key={entry.id} className="chat-bubble chat-zeus">
                  ...
                </article>
              ))}
```

Extend the `ChatMessage` type at the top of `App.tsx` (around line 59):

```ts
interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
  thinking?: boolean;
  skillId?: string;
  /** When present, this bubble renders as an AgentProgressBubble instead of text. */
  agentProgress?: {
    steps: AgentProgressStep[];
    completed: number;
    partial: boolean;
  };
}
```

Then update the chat render to handle the new field. Replace the existing `chat.map(...)` body with:

```tsx
              {chat.map((entry) => {
                if (entry.agentProgress) {
                  return (
                    <AgentProgressBubble
                      key={entry.id}
                      steps={entry.agentProgress.steps}
                      completed={entry.agentProgress.completed}
                      total={entry.agentProgress.steps.length}
                      partial={entry.agentProgress.partial}
                    />
                  );
                }
                return entry.role === "user" ? (
                  <article key={entry.id} className="chat-bubble chat-user">
                    ...
                  </article>
                ) : (
                  <article key={entry.id} className="chat-bubble chat-zeus">
                    ...
                  </article>
                );
              })}
```

Replace the three `...` ellipses with the exact existing markup from the file (lines 1274-1299). Do not change that markup — just hoist it inside the new ternary.

- [ ] **Step 14: Seed a progress bubble inside `runChatTurn` after `runAgentTask`**

In `App.tsx`, find the `runChatTurn` function (around line 773-878). Inside it, find the `try { const result = await runAgentTask(...); ... }` block (around line 824-833). Right before `appendZeusMessage(summarizeAgentRun(result));`, insert:

```ts
        const stepsForBubble: AgentProgressStep[] = result.logs.map((entry) => ({
          index: entry.index,
          label: entry.label,
          status: mapStepResult(entry.result),
          result: typeof (entry.result as { Failed?: unknown; failed?: unknown })?.Failed === "string"
            ? ((entry.result as { Failed: string }).Failed)
            : typeof (entry.result as { failed?: unknown })?.failed === "string"
              ? ((entry.result as { failed: string }).failed)
              : undefined,
        }));
        const completedCount = stepsForBubble.filter((s) => s.status === "ok" || s.status === "failed").length;
        const failedCount = stepsForBubble.filter((s) => s.status === "failed").length;
        const progressMessage: ChatMessage = {
          id: nextMessageId(),
          role: "zeus",
          text: "",
          agentProgress: {
            steps: stepsForBubble,
            completed: completedCount,
            partial: failedCount > 0 && !result.completed,
          },
        };
```

Then, inside the same `try` block, after `appendZeusMessage(summarizeAgentRun(result));`, add:

```ts
        setChat((entries) => [...entries, progressMessage]);
```

Also: after the final assistant reply is committed (around the line `setChat((entries) => entries.map(...))` near line 798 in the current file), if `!completed && proposal.status === "implementing"` we transition the proposal to `failed`; if `completed && proposal.status === "implementing"` we transition to `applied`. Find the line right before the recursive `runChatTurn` call (around line 860) and insert before it:

```ts
      if (proposal.status === "implementing" && agentResult) {
        const target = agentResult.completed ? "applied" : "failed";
        const proposalAfter = { ...proposal, status: target };
        setProposal(proposalAfter);
        setHistory((entries) => [
          { proposalId: proposal.id, action: target, at: new Date().toISOString(), sessionId: activeSession?.id },
          ...entries,
        ].slice(0, 4));
      }
```

(`agentResult` is the local variable introduced at line ~822 in the current file, populated by the awaited `runAgentTask(...)` call.)

- [ ] **Step 15: Extend SYSTEM_PROMPT with self-recovery + structured final reply**

Find `const SYSTEM_PROMPT = ...` (around line 168). Append a clearly-marked block to the string. Find the end of the existing `SYSTEM_PROMPT` literal (the line ending with "...reply in plain text."). Replace that line with:

```ts
const SYSTEM_PROMPT = "You are Zeus, a concise local-first coding agent.\n" +
  "When the user asks you to inspect or modify files in the workspace, or to run a shell command, emit a fenced `tool` block listing the steps you want to execute. Each step is one line in JSON.\n" +
  "Example:\n" +
  "```tool\n" +
  "readFile {\"path\":\"src/foo.ts\"}\n" +
  "runCommand {\"program\":\"npm\",\"args\":[\"test\"]}\n" +
  "editFile {\"path\":\"src/foo.ts\",\"find\":\"old\",\"replace\":\"new\",\"replaceAll\":false}\n" +
  "```\n" +
  "Available step kinds: readFile, writeFile, editFile, runCommand.\n" +
  "After the steps run, the workspace tool panel shows the diff/log; you will see the results in the next turn and can ask for more steps.\n" +
  "Do not emit a tool block unless the user actually wants a workspace action. For pure chat or explanations, reply in plain text.\n" +
  "\n" +
  "# On failures and partial outcomes\n" +
  "- If a tool step fails, attempt a corrected `tool` block that takes a different approach, or include a fallback in the next tool block, before emitting your final reply. Do not give up after one failure.\n" +
  "- Only emit a final reply when you cannot proceed further on your own.\n" +
  "- When you do emit a final reply (whether the run succeeded, partially succeeded, or fully failed), structure it as three sections:\n" +
  "  - **What was done** — concrete actions and the result for each.\n" +
  "  - **What's still pending** — open items, with the reason each is pending.\n" +
  "  - **Why it's pending** — the failure or constraint that left it open.\n" +
  "- If pending items need a user decision, end the final reply with a **Decision needed** section that names the choice, options, and which option you recommend.";
```

- [ ] **Step 16: Run typecheck + tests**

Run: `cd ~/Projects/Zeus && npx tsc --noEmit 2>&1 | tail -20 && npx vitest run 2>&1 | tail -30`
Expected: clean.

- [ ] **Step 17: Commit**

```bash
cd ~/Projects/Zeus && git add src/App.tsx && git commit -m "feat(agent): render per-step progress bubble and prompt self-recovery"
```

### Step 8e: Add tests for apply flow

- [ ] **Step 18: Add test for apply→implementing→applied transitions**

Open `src/state/harness.test.ts`. Add additional test cases to the existing `describe` block. The file currently has a single `it("records approval in the proposal and change history", ...)`. Append:

```ts
  it("transitions approved → applied with sessionId stamped on history", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "approved",
    };

    const applied = transitionHarnessProposal(proposal, "applied", "2026-07-06T10:00:00.000Z", "session-42");

    expect(applied.proposal.status).toBe("applied");
    expect(applied.historyEntry).toEqual({
      proposalId: "hp-1",
      action: "applied",
      at: "2026-07-06T10:00:00.000Z",
      sessionId: "session-42",
    });
  });

  it("transitions approved → failed when the run does not complete", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "approved",
    };

    const failed = transitionHarnessProposal(proposal, "failed", "2026-07-06T10:00:00.000Z", "session-42");

    expect(failed.proposal.status).toBe("failed");
    expect(failed.historyEntry.sessionId).toBe("session-42");
  });

  it("omits sessionId from history entry when not supplied", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "ready",
    };

    const rejected = transitionHarnessProposal(proposal, "rejected", "2026-07-06T10:00:00.000Z");

    expect(rejected.historyEntry.sessionId).toBeUndefined();
    expect("sessionId" in rejected.historyEntry).toBe(false);
  });
```

- [ ] **Step 19: Run the harness tests**

Run: `cd ~/Projects/Zeus && npx vitest run src/state/harness.test.ts 2>&1 | tail -20`
Expected: 4 tests pass.

- [ ] **Step 20: Commit**

```bash
cd ~/Projects/Zeus && git add src/state/harness.test.ts && git commit -m "test(harness): cover approved → applied | failed transitions with sessionId"
```

---

## Task 9: End-to-end build verification

**Files:** none (build only)

- [ ] **Step 1: Run the full test suite**

Run: `cd ~/Projects/Zeus && npx vitest run 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 2: Run the full typecheck**

Run: `cd ~/Projects/Zeus && npx tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 3: Run the production build**

Run: `cd ~/Projects/Zeus && npm run tauri:build 2>&1 | tail -30`
Expected: ends with the two installer paths (MSI + NSIS) as before. The build should succeed because no schema-breaking changes were made.

- [ ] **Step 4: Verify installer artifacts exist**

Run: `ls -lh ~/Projects/Zeus/src-tauri/target/release/bundle/msi/Zeus_0.1.0_x64_en-US.msi ~/Projects/Zeus/src-tauri/target/release/bundle/nsis/Zeus_0.1.0_x64-setup.exe`
Expected: both files listed with non-zero sizes.

- [ ] **Step 5: Final commit (if any lingering changes)**

```bash
cd ~/Projects/Zeus && git status --short
```

If there are uncommitted changes (e.g. test artifacts, build artifacts in `.gitignore` should already exclude `target/`):

```bash
cd ~/Projects/Zeus && git add -u && git commit -m "chore: post-build state" || true
```

---

## Verification Self-Review Checklist

- [ ] All four sub-projects of the spec are covered by tasks.
- [ ] No "TBD" / "TODO" / "implement later" / "similar to Task N" appears in any task.
- [ ] All file paths referenced in tasks exist in the working tree (verified during plan authoring).
- [ ] The `applyProposal` test references were not added; integration of `applyProposal` is verified indirectly through typecheck + manual smoke test in Task 9.
- [ ] All commit commands are exact git invocations the engineer can paste.
- [ ] `appendZeusMessage` calls in App.tsx ensure the progress bubble is visible alongside the summary.

## Notes for the Engineer

- Tasks 1–7 each produce an independently committable, independently typecheckable unit. Task 8 is the largest; do it in order 8a → 8b → 8c → 8d → 8e, committing each subsection.
- If a `tsc` or `vitest` run fails, address that error before committing. Do not commit broken state.
- Sub-project 4 introduces new behavior at the React component level; manual smoke testing in dev mode (`npm run tauri:dev`) is recommended after Task 8 to verify the click flows visually. This is not in the plan because it cannot be automated reliably.
