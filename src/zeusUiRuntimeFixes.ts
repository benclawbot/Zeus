import { derivePlanFromObjective, type PlanStatus, type RuntimePlan } from "./agentRuntimeDeepLoop";

const STYLE_ID = "zeus-runtime-ui-fixes";
const PANEL_ID = "zeus-live-plan-progress";

const styleText = `
.chat-bubble.chat-user {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) 32px !important;
  justify-items: end !important;
  align-items: start !important;
  gap: 12px !important;
  direction: ltr !important;
}
.chat-bubble.chat-user .chat-avatar {
  grid-column: 2 !important;
  grid-row: 1 !important;
}
.chat-bubble.chat-user .chat-body {
  grid-column: 1 !important;
  grid-row: 1 !important;
  width: min(100%, 720px) !important;
  max-width: min(85%, 720px) !important;
  min-width: min(420px, 100%) !important;
  justify-self: end !important;
  align-items: stretch !important;
  text-align: left !important;
}
.chat-bubble.chat-user .chat-heading {
  justify-content: flex-end !important;
  flex-direction: row !important;
}
.chat-bubble.chat-user .chat-md-para,
.chat-bubble.chat-user p {
  width: 100% !important;
  max-width: 100% !important;
  white-space: pre-wrap !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
  text-align: left !important;
}
.chat-bubble.chat-user .chat-body > * {
  max-width: 100% !important;
}
.inspector .memory-panel,
.inspector .history-panel {
  display: none !important;
}
#${PANEL_ID} .plan-objective {
  margin: 0 0 10px;
  color: var(--text);
  font-size: 0.86rem;
}
#${PANEL_ID} .plan-empty {
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
}
#${PANEL_ID} .compact-row[data-status="failed"] .status-dot {
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}
#${PANEL_ID} .compact-row[data-status="todo"] .status-dot {
  color: var(--muted);
  background: #fff;
}
#${PANEL_ID} .compact-row strong {
  font-size: 0.84rem;
  font-weight: 600;
}
#${PANEL_ID} .compact-row small {
  grid-column: 2 / -1;
  color: var(--muted);
  font-size: 0.74rem;
  overflow-wrap: anywhere;
}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const node = document.createElement("style");
  node.id = STYLE_ID;
  node.textContent = styleText;
  document.head.appendChild(node);
}

function statusLabel(status: PlanStatus): string {
  if (status === "in_progress") return "in progress";
  return status;
}

function statusGlyph(status: PlanStatus, index: number): string {
  if (status === "done") return "✓";
  if (status === "failed") return "!";
  if (status === "in_progress") return "…";
  return String(index + 1);
}

function latestUserObjective(): string {
  const userMessages = Array.from(document.querySelectorAll<HTMLElement>(".chat-bubble.chat-user .chat-md-para"));
  const last = userMessages.length > 0 ? userMessages[userMessages.length - 1].textContent?.trim() : undefined;
  return last || "No active objective yet";
}

function inferPlan(): RuntimePlan | null {
  const objective = latestUserObjective();
  if (objective === "No active objective yet") return null;
  const plan = derivePlanFromObjective(objective);
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".agent-progress-step, .tool-run-entry, .terminal-card, .compact-row"));
  const text = document.body.textContent ?? "";
  const failed = /agent run failed|failed:|status:\s*failed|Workspace path does not exist/i.test(text);
  const running = /Thinking|running \d+ agent step|Generating/i.test(text);
  const done = /agent run completed|test passed|exit 0/i.test(text);

  return {
    ...plan,
    status: failed ? "in_progress" : done ? "done" : running ? "in_progress" : "todo",
    steps: plan.steps.map((step) => {
      if (step.id === "inspect" && rows.length > 0) return { ...step, status: "done" };
      if (step.id === "act" && failed) return { ...step, status: "failed", detail: "Latest tool/action output failed; recovery remains active." };
      if (step.id === "act" && (running || done || rows.length > 0)) return { ...step, status: done ? "done" : "in_progress" };
      if (step.id === "verify" && done) return { ...step, status: "done" };
      if (step.id === "recover" && failed) return { ...step, status: "in_progress", detail: "Failure detected. Zeus should re-plan with the error output before stopping." };
      return step;
    }),
  };
}

function renderPlan(panel: HTMLElement, plan: RuntimePlan | null): void {
  const completed = plan?.steps.filter((step) => step.status === "done").length ?? 0;
  const total = plan?.steps.length ?? 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="panel-heading">
      <h2>Plan Progress</h2>
      <span>${total > 0 ? `${completed} / ${total} done` : "waiting"}</span>
    </div>
    <div class="progress-track"><span style="width: ${percent}%"></span></div>
    <p class="progress-percent">${percent}%</p>
    ${plan ? `<p class="plan-objective"><strong>Objective:</strong> ${escapeHtml(plan.objective)}</p>` : `<p class="plan-empty">Start a task and Zeus will track the objective and subtasks here.</p>`}
    <div class="compact-list">
      ${(plan?.steps ?? []).map((step, index) => `
        <div class="compact-row" data-status="${step.status}">
          <span class="status-dot ${step.status === "done" ? "done" : step.status === "in_progress" ? "live" : ""}">${statusGlyph(step.status, index)}</span>
          <strong>${escapeHtml(step.label)}</strong>
          <em>${statusLabel(step.status)}</em>
          ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch] ?? ch));
}

function planSignature(plan: RuntimePlan | null): string {
  if (!plan) return "idle";
  return `${plan.status}|${plan.steps.map((step) => `${step.id}:${step.status}:${step.detail ?? ""}`).join(",")}`;
}

function replacePlanPanel(): void {
  const inspector = document.querySelector<HTMLElement>(".inspector");
  if (!inspector) return;
  const current = document.getElementById(PANEL_ID) ?? Array.from(inspector.querySelectorAll<HTMLElement>(".panel")).find((panel) => panel.querySelector("h2")?.textContent?.trim() === "Plan Progress");
  if (!current) return;
  const plan = inferPlan();
  if (current.dataset.signature === planSignature(plan)) return;
  renderPlan(current, plan);
  current.dataset.signature = planSignature(plan);
}

let bootScheduled = false;
function boot(): void {
  ensureStyle();
  replacePlanPanel();
  const observer = new MutationObserver(() => {
    if (bootScheduled) return;
    bootScheduled = true;
    queueMicrotask(() => { bootScheduled = false; replacePlanPanel(); });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
