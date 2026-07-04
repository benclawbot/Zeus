import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Home,
  MemoryStick,
  MessageSquare,
  Paperclip,
  Play,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { sendMinimaxChat } from "./providers/minimax";
import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";
import "./styles.css";

type AccessMode = "Full" | "Local" | "Review" | "Locked";

const planItems = [
  { label: "Initialize Tauri + React project", status: "Completed" },
  { label: "Wire MiniMax M3 adapter", status: "In Progress" },
  { label: "Implement local memory model", status: "Pending" },
  { label: "Add harness approvals", status: "Pending" },
  { label: "Package desktop builds", status: "Pending" },
];

const recentSessions = ["Rust CLI Todo App", "API Integration", "Refactor Auth Module", "Add Unit Tests", "UI Bug Fix"];

export function App() {
  const [accessMode, setAccessMode] = useState<AccessMode>("Full");
  const [proposal, setProposal] = useState<HarnessProposal>({
    id: "proposal-001",
    title: "Harness proposal ready",
    summary: "Generated after the last session and shown automatically at the start of this one.",
    status: "ready",
  });
  const [history, setHistory] = useState<HarnessHistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [assistantText, setAssistantText] = useState(
    "I'll build a fast local-first coding agent with a visible harness-evolution loop. Here's the plan:",
  );
  const [runState, setRunState] = useState<"idle" | "running" | "error">("idle");
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const completed = planItems.filter((item) => item.status === "Completed").length;
  const progress = Math.round((completed / planItems.length) * 100);

  const accessSummary = useMemo(() => {
    if (accessMode === "Full") return "Files, shell, internet, dependencies and configured APIs with guards enabled.";
    if (accessMode === "Local") return "Repo and shell are allowed. Internet and external APIs stay blocked.";
    if (accessMode === "Review") return "Writes, shell, git and network require review first.";
    return "Read-only mode. Shell, writes and network are disabled.";
  }, [accessMode]);

  function recordProposal(action: Exclude<HarnessProposal["status"], "ready">) {
    const result = transitionHarnessProposal(proposal, action);
    setProposal(result.proposal);
    setHistory((entries) => [result.historyEntry, ...entries].slice(0, 4));
  }

  async function handleSend() {
    const prompt = message.trim();
    if (!prompt) return;

    setRunState("running");
    setAssistantText("Contacting MiniMax M3 through the Zeus Rust provider adapter...");
    setMessage("");

    try {
      const response = await sendMinimaxChat({
        messages: [
          { role: "system", content: "You are Zeus, a concise local-first coding agent." },
          { role: "user", content: prompt },
        ],
      });
      setAssistantText(response.content);
      setRunState("idle");
    } catch (error) {
      setAssistantText(error instanceof Error ? error.message : "MiniMax request failed.");
      setRunState("error");
    }
  }

  function resizeComposer() {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="window-dots" aria-hidden="true">
          <span className="dot red" />
          <span className="dot yellow" />
          <span className="dot green" />
        </div>

        <div className="brand-row">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <h1>Zeus</h1>
          <span className="version">v0.1.0</span>
        </div>

        <button className="new-session" type="button">
          <MessageSquare size={16} />
          New Session
          <kbd>⌘ N</kbd>
        </button>

        <nav className="nav-list">
          {[
            ["Home", Home],
            ["Sessions", Archive],
            ["Skills", Wrench],
            ["Memory", MemoryStick],
            ["Harness Evolution", Sparkles],
            ["Settings", Settings],
          ].map(([label, Icon]) => (
            <button className={label === "Home" ? "nav-item active" : "nav-item"} key={label as string} type="button">
              <Icon size={16} />
              {label as string}
            </button>
          ))}
        </nav>

        <section className="recent-block" aria-labelledby="recent-title">
          <div className="section-label" id="recent-title">
            Recent Sessions
            <Clock3 size={14} />
          </div>
          {recentSessions.map((session, index) => (
            <button className={index === 0 ? "recent-item active" : "recent-item"} key={session} type="button">
              <span>{session}</span>
              <time>{index === 0 ? "2m ago" : index === 1 ? "1h ago" : `${index}d ago`}</time>
            </button>
          ))}
        </section>

        <section className="harness-card" aria-labelledby="harness-title">
          <p className="section-label">Next session review</p>
          <h2 id="harness-title">{proposal.title}</h2>
          <p>{proposal.summary}</p>
          <div className="proposal-actions">
          <button type="button" onClick={() => recordProposal("approved")}>
            Approve
          </button>
            <button type="button" onClick={() => recordProposal("edited")}>
              Edit
            </button>
            <button type="button" onClick={() => recordProposal("rejected")}>
              Reject
            </button>
          </div>
          <div className="proposal-actions secondary">
            <button type="button" onClick={() => recordProposal("applied-once")}>
              Apply Once
            </button>
            <button type="button" onClick={() => recordProposal("rolled-back")}>
              Roll Back
            </button>
          </div>
          <p className="proposal-status">Status: {proposal.status}</p>
        </section>

        <div className="profile-row">
          <div className="avatar">B</div>
          <span>benclawbot</span>
          <ChevronDown size={14} />
        </div>
      </aside>

      <section className="workspace" aria-label="Task execution">
        <header className="topbar">
          <div>
            <h2>Rust CLI Todo App</h2>
            <span className="active-pill">Active</span>
          </div>
          <button className="run-button" type="button" onClick={() => setRunState("running")}>
            <Play size={15} />
            Run
          </button>
        </header>

        <div className="conversation">
          <article className="user-card">
            <strong>You</strong>
            <p>Build a simple CLI todo app in Rust with add, list, complete and remove commands.</p>
            <p>Use SQLite for persistence.</p>
            <time>10:42 AM</time>
          </article>

          <article className="agent-message">
            <div className="agent-avatar">
              <Sparkles size={20} />
            </div>
            <div className="agent-body">
              <div className="message-heading">
                <strong>Zeus</strong>
                <time>10:42 AM</time>
              </div>
              <p>{assistantText}</p>
              <div className="task-list">
                {planItems.map((item, index) => (
                  <div className="task-row" key={item.label}>
                    <span className={item.status === "Completed" ? "task-icon done" : item.status === "In Progress" ? "task-icon live" : "task-icon"}>
                      {item.status === "Completed" ? <Check size={14} /> : index + 1}
                    </span>
                    <span>{item.label}</span>
                    <em>{item.status}</em>
                  </div>
                ))}
              </div>

              <section className="terminal-card" aria-label="Live terminal output">
                <div className="terminal-status">
                  <span>{runState === "running" ? "Live" : runState === "error" ? "Needs attention" : "Ready"}</span>
                </div>
                <p>
                  <Check size={14} /> Checking provider adapter MiniMax-M3
                </p>
                <p>
                  <span className="terminal-dot" /> Preparing Tauri command bridge
                </p>
                <p>
                  <span className="terminal-dot muted" /> Running package verification
                </p>
                <button type="button">
                  <TerminalSquare size={15} />
                  View Logs
                </button>
              </section>
            </div>
          </article>
        </div>

        <section className="composer" aria-label="Message composer">
          <textarea
            aria-label="Message Zeus"
            onChange={(event) => {
              setMessage(event.target.value);
              resizeComposer();
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                void handleSend();
              }
            }}
            placeholder="Message Zeus..."
            ref={composerRef}
            rows={1}
            value={message}
          />
          <div className="composer-bottom">
            <div className="composer-tools">
              <button aria-label="Attach file" type="button">
                <Paperclip size={16} />
              </button>
              <button aria-label="Mention context" type="button">
                @
              </button>
              <span className="attached-chip">
                <FileText size={14} />
                requirements.md
                <X size={13} />
              </span>
            </div>
            <div className="send-cluster">
              <span>⌘ ↵ to send</span>
              <button aria-label="Send message" className="send-button" type="button" onClick={() => void handleSend()}>
                <Send size={17} />
              </button>
            </div>
          </div>
        </section>
      </section>

      <aside className="inspector" aria-label="Progress and memory">
        <section className="panel">
          <div className="panel-heading">
            <h2>Plan Progress</h2>
            <span>
              {completed} / {planItems.length} completed
            </span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p className="progress-percent">{progress}%</p>
          <div className="compact-list">
            {planItems.map((item, index) => (
              <div className="compact-row" key={item.label}>
                <span className={item.status === "Completed" ? "status-dot done" : item.status === "In Progress" ? "status-dot live" : "status-dot"}>
                  {item.status === "Completed" ? <Check size={12} /> : index + 1}
                </span>
                <span>{item.label}</span>
                <em>{item.status}</em>
              </div>
            ))}
          </div>
        </section>

        <section className="panel memory-panel">
          <div className="panel-heading">
            <h2>Memory Snapshot</h2>
            <span>Updated just now</span>
          </div>
          <dl>
            <div>
              <dt>Project</dt>
              <dd>Zeus Coding Agent</dd>
            </div>
            <div>
              <dt>Tech</dt>
              <dd>Tauri, React, Rust, SQLite</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>MiniMax-M3</dd>
            </div>
            <div>
              <dt>Harness</dt>
              <dd>Approval before rule changes</dd>
            </div>
          </dl>
          <button type="button">View Memory</button>
        </section>

        <section className="panel access-panel">
          <div className="panel-heading">
            <h2>Access Mode</h2>
            <ShieldCheck size={16} />
          </div>
          <div className="access-grid" role="group" aria-label="Access mode">
            {(["Full", "Local", "Review", "Locked"] as AccessMode[]).map((mode) => (
              <button className={mode === accessMode ? "selected" : ""} key={mode} type="button" onClick={() => setAccessMode(mode)}>
                {mode}
              </button>
            ))}
          </div>
          <p>{accessSummary}</p>
        </section>

        <section className="panel history-panel">
          <div className="panel-heading">
            <h2>Change History</h2>
            <Bot size={16} />
          </div>
          {history.length === 0 ? (
            <p>No harness changes applied in this session.</p>
          ) : (
            history.map((entry) => (
              <p key={`${entry.proposalId}-${entry.at}`}>
                {entry.action} · {new Date(entry.at).toLocaleTimeString()}
              </p>
            ))
          )}
        </section>
      </aside>
    </main>
  );
}
