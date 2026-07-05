import React, { useState } from "react";
import type {
  ShellCommandResult,
  ReadWorkspaceFileResult,
  WriteWorkspaceFileResult,
  ApplyWorkspaceEditResult,
  AgentRunResult,
} from "../providers/workspace";

export type ToolRunEntry =
  | { kind: "shell"; at: string; shell: ShellCommandResult }
  | { kind: "shell"; at: string; error: string }
  | { kind: "read"; at: string; read: ReadWorkspaceFileResult; path: string }
  | { kind: "read"; at: string; error: string; path: string }
  | { kind: "write"; at: string; write: WriteWorkspaceFileResult; path: string }
  | { kind: "write"; at: string; error: string; path: string }
  | { kind: "edit"; at: string; edit: ApplyWorkspaceEditResult; path: string }
  | { kind: "edit"; at: string; error: string; path: string }
  | { kind: "agent"; at: string; agent: AgentRunResult }
  | { kind: "agent"; at: string; error: string };

interface PanelProps {
  entries: ToolRunEntry[];
}

function policyBadgeClass(commandClass: string): string {
  switch (commandClass) {
    case "destructive": return "tool-policy destructive";
    case "network": return "tool-policy network";
    case "dependency": return "tool-policy dependency";
    case "privileged": return "tool-policy privileged";
    default: return "tool-policy safe";
  }
}

function exitBadge(result: ShellCommandResult): string {
  if (result.timedOut) return "tool-exit timed-out";
  if (result.exitCode === 0) return "tool-exit ok";
  return "tool-exit error";
}

function DiffBlock({ diff }: { diff: string }) {
  if (!diff || !diff.trim()) return null;
  return (
    <pre className="tool-diff" aria-label="Diff">
      {diff}
    </pre>
  );
}

function StepLog({ logs }: { logs: AgentRunResult["logs"] }) {
  if (!logs || logs.length === 0) return null;
  return (
    <ol className="tool-step-log" aria-label="Agent step log">
      {logs.map((step) => {
        const r = step.result as Record<string, unknown> & { message?: string; stdout?: string; stderr?: string; diff?: string; replacements?: number; bytesWritten?: number };
        const summary = (() => {
          if (typeof r.message === "string") return `failed: ${r.message}`;
          if (r.exitCode !== undefined) {
            const stdout = typeof r.stdout === "string" ? r.stdout.trim() : "";
            const stderr = typeof r.stderr === "string" ? r.stderr.trim() : "";
            const tail = (stdout || stderr).slice(0, 200);
            return `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}${tail ? ` — ${tail}` : ""}`;
          }
          if (typeof r.replacements === "number") return `${r.replacements} replacement${r.replacements === 1 ? "" : "s"}, ${r.bytesWritten ?? 0} bytes`;
          if (typeof r.bytesWritten === "number") return `${r.bytesWritten} bytes`;
          if (typeof r.content === "string") return `${r.content.length} bytes read`;
          return "ok";
        })();
        const kind = Object.keys(r).find((k) => k !== "policy" && typeof r[k] !== "object");
        return (
          <li key={step.index} className="tool-step">
            <span className="tool-step-index">{step.index + 1}</span>
            <span className="tool-step-label">{step.label}</span>
            <span className="tool-step-kind">{kind ?? "step"}</span>
            <span className="tool-step-summary">{summary}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ShellEntry({ entry }: { entry: ToolRunEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.kind !== "shell") return null;
  if ("error" in entry) {
    return (
      <article className="tool-run error" aria-label="Shell error">
        <header><span className="tool-run-kind">shell</span><time>{entry.at}</time></header>
        <p>{entry.error}</p>
      </article>
    );
  }
  const shell = entry.shell;
  return (
    <article className="tool-run" aria-label="Shell run">
      <header>
        <span className="tool-run-kind">shell</span>
        <code>{shell.program} {shell.args.join(" ")}</code>
        <span className={exitBadge(shell)}>{shell.timedOut ? "timed out" : `exit ${shell.exitCode ?? "?"}`}</span>
        <span className="tool-run-duration">{shell.durationMs}ms</span>
        <span className={policyBadgeClass(shell.policy.commandClass)} title={shell.policy.approvalRequired && !shell.policy.approved ? "Approval required" : "Allowed by current policy"}>
          {shell.policy.commandClass}
        </span>
        <time>{entry.at}</time>
        <button type="button" className="tool-run-toggle" onClick={() => setOpen(!open)}>{open ? "hide" : "show"}</button>
      </header>
      {open ? (
        <>
          {shell.stdout ? <pre className="tool-stdout" aria-label="stdout">{shell.stdout}</pre> : null}
          {shell.stderr ? <pre className="tool-stderr" aria-label="stderr">{shell.stderr}</pre> : null}
          <p className="tool-policy-note">mode={shell.policy.accessMode} approved={String(shell.policy.approved)}</p>
        </>
      ) : null}
    </article>
  );
}

function ReadEntry({ entry }: { entry: ToolRunEntry }) {
  if (entry.kind !== "read") return null;
  if ("error" in entry) {
    return (
      <article className="tool-run error" aria-label="Read error">
        <header><span className="tool-run-kind">read</span><code>{entry.path}</code><time>{entry.at}</time></header>
        <p>{entry.error}</p>
      </article>
    );
  }
  const preview = entry.read.content.length > 600 ? `${entry.read.content.slice(0, 597)}...` : entry.read.content;
  return (
    <article className="tool-run" aria-label="Read result">
      <header>
        <span className="tool-run-kind">read</span>
        <code>{entry.path}</code>
        <span className="tool-run-meta">{entry.read.bytesRead} bytes{entry.read.truncated ? " (truncated)" : ""}</span>
        <time>{entry.at}</time>
      </header>
      <pre className="tool-read">{preview}</pre>
    </article>
  );
}

function WriteEntry({ entry }: { entry: ToolRunEntry }) {
  if (entry.kind !== "write") return null;
  if ("error" in entry) {
    return (
      <article className="tool-run error" aria-label="Write error">
        <header><span className="tool-run-kind">write</span><code>{entry.path}</code><time>{entry.at}</time></header>
        <p>{entry.error}</p>
      </article>
    );
  }
  return (
    <article className="tool-run" aria-label="Write result">
      <header>
        <span className="tool-run-kind">write</span>
        <code>{entry.path}</code>
        <span className="tool-run-meta">{entry.write.bytesWritten} bytes{entry.write.created ? " (created)" : ""}</span>
        <time>{entry.at}</time>
      </header>
      <DiffBlock diff={entry.write.diff} />
    </article>
  );
}

function EditEntry({ entry }: { entry: ToolRunEntry }) {
  if (entry.kind !== "edit") return null;
  if ("error" in entry) {
    return (
      <article className="tool-run error" aria-label="Edit error">
        <header><span className="tool-run-kind">edit</span><code>{entry.path}</code><time>{entry.at}</time></header>
        <p>{entry.error}</p>
      </article>
    );
  }
  return (
    <article className="tool-run" aria-label="Edit result">
      <header>
        <span className="tool-run-kind">edit</span>
        <code>{entry.path}</code>
        <span className="tool-run-meta">{entry.edit.replacements} replacement{entry.edit.replacements === 1 ? "" : "s"}</span>
        <time>{entry.at}</time>
      </header>
      <DiffBlock diff={entry.edit.diff} />
    </article>
  );
}

function AgentEntry({ entry }: { entry: ToolRunEntry }) {
  if (entry.kind !== "agent") return null;
  if ("error" in entry) {
    return (
      <article className="tool-run error" aria-label="Agent run error">
        <header><span className="tool-run-kind">agent</span><time>{entry.at}</time></header>
        <p>{entry.error}</p>
      </article>
    );
  }
  const a = entry.agent;
  return (
    <article className="tool-run" aria-label="Agent run">
      <header>
        <span className="tool-run-kind">agent</span>
        <strong>{a.completed ? "completed" : "failed"}</strong>
        <span className="tool-run-meta">{a.filesTouched.length} file{a.filesTouched.length === 1 ? "" : "s"} touched</span>
        <time>{entry.at}</time>
      </header>
      <p className="tool-agent-summary">{a.summary}</p>
      {a.filesTouched.length ? (
        <ul className="tool-files">
          {a.filesTouched.map((file) => <li key={file}><code>{file}</code></li>)}
        </ul>
      ) : null}
      <StepLog logs={a.logs} />
      <DiffBlock diff={a.diff} />
      {a.proposedHarnessRule ? (
        <div className="tool-harness-rule" aria-label="Proposed harness rule">
          <strong>Proposed harness rule</strong>
          <p>{a.proposedHarnessRule}</p>
        </div>
      ) : null}
      {a.rollbackPlan.length ? (
        <details className="tool-rollback">
          <summary>Rollback plan ({a.rollbackPlan.length})</summary>
          <ol>
            {a.rollbackPlan.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

export function ToolRunPanel({ entries }: PanelProps) {
  if (entries.length === 0) {
    return (
      <section className="tool-run-panel empty" aria-label="Workspace tool runs">
        <header><h3>Tool runs</h3><span>no runs yet</span></header>
        <p className="tool-empty-hint">Use <code>/run</code>, <code>/read</code>, <code>/write</code>, <code>/edit</code> from the composer, or ask the agent to perform a workspace action.</p>
      </section>
    );
  }
  return (
    <section className="tool-run-panel" aria-label="Workspace tool runs">
      <header><h3>Tool runs</h3><span>{entries.length}</span></header>
      <div className="tool-run-list">
        {entries.map((entry, i) => {
          // Stable key per entry. Same kind+timestamp is enough in practice.
          const key = `${entry.kind}-${entry.at}-${i}`;
          switch (entry.kind) {
            case "shell": return <ShellEntry key={key} entry={entry} />;
            case "read": return <ReadEntry key={key} entry={entry} />;
            case "write": return <WriteEntry key={key} entry={entry} />;
            case "edit": return <EditEntry key={key} entry={entry} />;
            case "agent": return <AgentEntry key={key} entry={entry} />;
          }
        })}
      </div>
    </section>
  );
}