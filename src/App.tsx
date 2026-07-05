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
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  User,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { dispatchChat } from "./providers/registry";
import { isTauriRuntime } from "./providers/minimax";
import { listSkills, loadSkill, type SkillDetail, type SkillSummary } from "./providers/skills";
import { useSlashMenu, type SlashItem } from "./providers/slash";
import { buildContextMessages, type UiChatBubble } from "./providers/context";
import { listSessions, newSessionId, saveSession, type PersistedSession } from "./providers/sessions";
import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";
import "./styles.css";

type AccessMode = "Full" | "Local" | "Review" | "Locked";
type AppView = "Home" | "Sessions" | "Skills" | "Memory" | "Harness Evolution" | "Settings";

type ChatRole = "user" | "zeus";

interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
  thinking?: boolean;
  skillId?: string;
}

const planItems = [
  { label: "Initialize Tauri + React project", status: "Completed" },
  { label: "Wire MiniMax M3 adapter", status: "Completed" },
  { label: "Pluggable chat providers (OpenAI + Anthropic)", status: "Completed" },
  { label: "Slash-command composer + skill registry", status: "Completed" },
  { label: "Local memory model + SQLite persistence", status: "Completed" },
  { label: "Harness approvals", status: "Completed" },
  { label: "Package desktop builds", status: "In Progress" },
];

interface SessionRef {
  id: string;
  label: string;
}

/**
 * Seed labels shown on a fresh install before the user has created any
 * sessions. Clicking one creates a real persisted row so the seed list
 * disappears after the first interaction.
 */
const SEED_SESSION_LABELS = ["Rust CLI Todo App", "API Integration", "Refactor Auth Module", "Add Unit Tests", "UI Bug Fix"];

const navItems: Array<{ label: AppView; icon: LucideIcon }> = [
  { label: "Home", icon: Home },
  { label: "Sessions", icon: Archive },
  { label: "Skills", icon: Wrench },
  { label: "Memory", icon: MemoryStick },
  { label: "Harness Evolution", icon: Sparkles },
  { label: "Settings", icon: Settings },
];

const mergeCandidateRules = [
  { label: "Frontend and mobile stacks", ids: ["frontend-dev", "fullstack-dev", "android-native-dev", "react-native-dev", "flutter-dev"] },
  { label: "Document and office generators", ids: ["minimax-docx", "minimax-pdf", "minimax-xlsx", "pptx-generator"] },
  { label: "Planning and todo helpers", ids: ["planf3", "planning-and-task-breakdown", "write-todos", "todo-update"] },
  { label: "Self-improvement loops", ids: ["self-improve", "self-optimization-loop", "skill-evolution"] },
  { label: "Debugging and root-cause analysis", ids: ["5-why", "debugging-and-error-recovery"] },
];

const SYSTEM_PROMPT = "You are Zeus, a concise local-first coding agent.";
const COMPACT_KEEP_LAST = 6;

let messageIdCounter = 0;
function nextMessageId() {
  messageIdCounter += 1;
  return messageIdCounter;
}

export function App() {
  const [activeView, setActiveView] = useState<AppView>("Home");
  const [accessMode, setAccessMode] = useState<AccessMode>("Full");
  const [proposal, setProposal] = useState<HarnessProposal>({
    id: "proposal-001",
    title: "Harness proposal ready",
    summary: "Generated after the last session and shown automatically at the start of this one.",
    status: "ready",
  });
  const [history, setHistory] = useState<HarnessHistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [compactFromId, setCompactFromId] = useState<number | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "error">("idle");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [skillsError, setSkillsError] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailStatus, setSkillDetailStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [recentSessions, setRecentSessions] = useState<SessionRef[]>(
    // Seed the list with a couple of canned labels so the UI has something
    // to render on a fresh install (or in the test environment, which
    // can't hit the Tauri runtime). The Tauri mount effect replaces
    // these with the real persisted list once Rust answers.
    SEED_SESSION_LABELS.map((label) => ({ id: label, label })),
  );
  const [activeSession, setActiveSession] = useState<SessionRef | null>(
    SEED_SESSION_LABELS.length > 0 ? { id: SEED_SESSION_LABELS[0], label: SEED_SESSION_LABELS[0] } : null,
  );
  const [sessionsStatus, setSessionsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sessionsError, setSessionsError] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [provider] = useState("minimax");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isTauri = isTauriRuntime();
  const slash = useSlashMenu(message, isTauri);

  const completed = planItems.filter((item) => item.status === "Completed").length;
  const progress = Math.round((completed / planItems.length) * 100);

  const accessSummary = useMemo(() => {
    if (accessMode === "Full") return "Files, shell, internet, dependencies and configured APIs with guards enabled.";
    if (accessMode === "Local") return "Repo and shell are allowed. Internet and external APIs stay blocked.";
    if (accessMode === "Review") return "Writes, shell, git and network require review first.";
    return "Read-only mode. Shell, writes and network are disabled.";
  }, [accessMode]);

  const mergeCandidates = useMemo(() => {
    const available = new Set(skills.map((skill) => skill.id));
    return mergeCandidateRules
      .map((rule) => ({ label: rule.label, ids: rule.ids.filter((id) => available.has(id)) }))
      .filter((rule) => rule.ids.length > 1);
  }, [skills]);

  function recordProposal(action: Exclude<HarnessProposal["status"], "ready">) {
    const result = transitionHarnessProposal(proposal, action);
    setProposal(result.proposal);
    setHistory((entries) => [result.historyEntry, ...entries].slice(0, 4));
  }

  // Persist the active session if there's any meaningful state to save
  // (chat non-empty OR a non-default compact anchor). Debounced internally
  // via the React state — callers fire-and-forget, errors are logged but
  // never thrown into the UI.
  const persistActiveSession = React.useCallback(
    (overrides?: { id?: string; label?: string; chat?: ChatMessage[]; compactFromId?: number | null }) => {
      const id = overrides?.id ?? activeSession?.id;
      const label = overrides?.label ?? activeSession?.label;
      if (!id) return;
      const chatSnapshot = overrides?.chat ?? chat;
      const compactSnapshot = overrides?.compactFromId ?? compactFromId;
      const payload = {
        id,
        label: label ?? "Untitled Session",
        messagesJson: JSON.stringify(chatSnapshot),
        compactFromId: compactSnapshot,
      };
      saveSession(payload).catch((err) => {
        // Persistence failure shouldn't break the active UI; just log.
        // The next successful save will overwrite any stale row.
        console.warn("saveSession failed", err);
      });
    },
    [activeSession, chat, compactFromId],
  );

  function startNewSession() {
    const id = newSessionId();
    const ref: SessionRef = { id, label: "Untitled Session" };
    setRecentSessions((current) => [ref, ...current.filter((entry) => entry.id !== id)].slice(0, 20));
    setActiveSession(ref);
    setChat([]);
    setCompactFromId(null);
    setMessage("");
    setAttachedFiles([]);
    setActiveSkillId(null);
    setRunState("idle");
    setActiveView("Home");
    // Persist the empty row so it shows up on the next launch.
    saveSession({ id, label: ref.label, messagesJson: "[]", compactFromId: null }).catch(() => undefined);
  }

  function selectSession(session: SessionRef) {
    // Save the outgoing session before swapping.
    persistActiveSession();
    setActiveSession(session);
    setChat([]);
    setCompactFromId(null);
    setMessage("");
    setActiveSkillId(null);
    setRunState("idle");
    setActiveView("Home");
    // Load the incoming session's transcript.
    listSessions().then((rows) => {
      const row = rows.find((r) => r.id === session.id);
      if (!row) return;
      let parsed: ChatMessage[] = [];
      try {
        const raw = JSON.parse(row.messagesJson);
        if (Array.isArray(raw)) parsed = raw as ChatMessage[];
      } catch {
        parsed = [];
      }
      // Push message-id counter past any persisted ids so future
      // messages never collide.
      for (const entry of parsed) {
        if (typeof entry.id === "number" && entry.id >= messageIdCounter) {
          messageIdCounter = entry.id + 1;
        }
      }
      setChat(parsed);
      setCompactFromId(row.compactFromId);
    }).catch((err) => {
      console.warn("load session failed", err);
    });
  }

  function addContextMention() {
    setMessage((value) => `${value}${value.endsWith(" ") || value.length === 0 ? "" : " "}@`);
    requestAnimationFrame(() => { composerRef.current?.focus(); resizeComposer(); });
  }

  function handleFileSelection(files: FileList | null) {
    if (!files) return;
    const names = Array.from(files).map((file) => file.name);
    setAttachedFiles((current) => Array.from(new Set([...current, ...names])));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function activateSkill(id: string) {
    setActiveSkillId(id);
    let nextChat: ChatMessage[] = [];
    setChat((entries) => {
      nextChat = [...entries, { id: nextMessageId(), role: "zeus", text: `Skill attached: ${id}` }];
      return nextChat;
    });
    setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
  }

  function detachSkill() { setActiveSkillId(null); }

  function compactContext() {
    // Anchor the LLM-context window at the first kept entry's id. Future
    // turns send only entries with id >= compactFromId, so the dropped
    // turns never re-enter the model's context window.
    let firstKeptId: number | null = null;
    let nextChat: ChatMessage[] = [];
    setChat((entries) => {
      const recent = entries.slice(-COMPACT_KEEP_LAST);
      firstKeptId = recent.length > 0 ? recent[0].id : null;
      const note: ChatMessage = { id: nextMessageId(), role: "zeus", text: `Context compacted. Kept the last ${recent.length} turn(s).` };
      nextChat = [...recent, note];
      return nextChat;
    });
    setCompactFromId(firstKeptId);
    // Persist after the next tick so the `setChat` updater above has
    // already produced the new array (we read `nextChat` from closure).
    setTimeout(() => persistActiveSession({ compactFromId: firstKeptId, chat: nextChat }), 0);
  }

  function stopRun() {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setRunState("idle");
    let nextChat: ChatMessage[] = [];
    setChat((entries) => {
      nextChat = [...entries, { id: nextMessageId(), role: "zeus", text: "Run stopped." }];
      return nextChat;
    });
    setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
  }

  function stripThinkingTags(text: string): string {
    const LT = String.fromCharCode(0x3c);
    const SLASH = String.fromCharCode(0x2f);
    const GT = String.fromCharCode(0x3e);
    const OPEN = LT + "think" + GT;
    const CLOSE = LT + SLASH + "think" + GT;
    let out = "";
    let i = 0;
    while (i < text.length) {
      const openIdx = text.indexOf(OPEN, i);
      if (openIdx === -1) { out += text.slice(i); break; }
      out += text.slice(i, openIdx);
      const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
      if (closeIdx === -1) break;
      i = closeIdx + CLOSE.length;
    }
    return out.trim();
  }

  async function handleSend() {
    const prompt = message.trim();
    if (!prompt) return;
    if (runState === "running") return;
    if (prompt === "/new") { setMessage(""); startNewSession(); return; }
    if (prompt === "/compact") { setMessage(""); compactContext(); return; }
    if (prompt === "/stop") { setMessage(""); stopRun(); return; }

    const skillForTurn = activeSkillId;
    const userMessage: ChatMessage = { id: nextMessageId(), role: "user", text: prompt, skillId: skillForTurn ?? undefined };
    const thinkingMessage: ChatMessage = { id: nextMessageId(), role: "zeus", text: "", thinking: true };
    setChat((entries) => [...entries, userMessage, thinkingMessage]);
    setMessage("");
    setRunState("running");
    requestAnimationFrame(() => { if (composerRef.current) composerRef.current.style.height = "24px"; });

    const controller = new AbortController();
    abortRef.current = controller;

    // Snapshot the chat at dispatch time so the history we send reflects
    // exactly what the user saw, even if a concurrent setter updates chat
    // while the await is in flight.
    const historySnapshot = chat as UiChatBubble[];
    const contextMessages = buildContextMessages(historySnapshot, compactFromId);

    try {
      const response = await dispatchChat({
        provider,
        skillId: skillForTurn ?? undefined,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...contextMessages,
          { role: "user", content: prompt },
        ],
      });
      if (controller.signal.aborted) return;
      const clean = stripThinkingTags(response.content);
      let nextChat: ChatMessage[] = [];
      setChat((entries) => {
        nextChat = entries.map((entry) => entry.id === thinkingMessage.id ? { ...entry, text: clean, thinking: false } : entry);
        return nextChat;
      });
      setRunState("idle");
      // Persist the new transcript after the state updater runs.
      setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
    } catch (error) {
      if (controller.signal.aborted) return;
      const text = error instanceof Error ? error.message : "Chat request failed.";
      let nextChat: ChatMessage[] = [];
      setChat((entries) => {
        nextChat = entries.map((entry) => entry.id === thinkingMessage.id ? { ...entry, text, thinking: false } : entry);
        return nextChat;
      });
      setRunState("error");
      setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
    } finally {
      abortRef.current = null;
    }
  }

  function applySlashPick(item: SlashItem) {
    setMessage("");
    if (item.kind === "skill") activateSkill(item.id);
    else if (item.id === "new") startNewSession();
    else if (item.id === "compact") compactContext();
    else if (item.id === "stop") stopRun();
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slash.open && slash.items.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); slash.setActiveIndex((slash.activeIndex + 1) % slash.items.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); slash.setActiveIndex((slash.activeIndex - 1 + slash.items.length) % slash.items.length); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = slash.pick(slash.activeIndex);
        if (picked) applySlashPick(picked);
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); setMessage(""); return; }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); void handleSend(); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault(); void handleSend();
    }
  }

  function resizeComposer() {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    composer.style.height = `${Math.min(composer.scrollHeight, 160)}px`;
  }

  // Load persisted sessions on first mount. Done once per app lifetime
  // (status === "idle" guards re-runs); the recent-sessions list is then
  // mutated locally as the user creates new sessions.
  useEffect(() => {
    if (!isTauri || sessionsStatus !== "idle") return;
    let cancelled = false;
    setSessionsStatus("loading");
    listSessions()
      .then((rows) => {
        if (cancelled) return;
        const refs: SessionRef[] = rows.map((row) => ({ id: row.id, label: row.label }));
        setRecentSessions(refs.slice(0, 20));
        setSessionsStatus("ready");
        // Restore the most recently seen session, or fall back to the
        // first seed if the DB is empty.
        if (refs.length > 0) {
          const head = refs[0];
          setActiveSession(head);
          const row = rows.find((r) => r.id === head.id);
          if (row) {
            let parsed: ChatMessage[] = [];
            try {
              const raw = JSON.parse(row.messagesJson);
              if (Array.isArray(raw)) parsed = raw as ChatMessage[];
            } catch {
              parsed = [];
            }
            for (const entry of parsed) {
              if (typeof entry.id === "number" && entry.id >= messageIdCounter) {
                messageIdCounter = entry.id + 1;
              }
            }
            setChat(parsed);
            setCompactFromId(row.compactFromId);
          }
        } else if (SEED_SESSION_LABELS.length > 0) {
          const first = SEED_SESSION_LABELS[0];
          setActiveSession({ id: first, label: first });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setSessionsError(err instanceof Error ? err.message : "Session discovery failed.");
        setSessionsStatus("error");
      });
    return () => { cancelled = true; };
  }, [isTauri, sessionsStatus]);

  useEffect(() => {
    const node = conversationRef.current;
    if (!node) return;
    const frame = requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [chat]);

  useEffect(() => {
    if (activeView !== "Skills" || skillsStatus !== "idle") return;
    let cancelled = false;
    setSkillsStatus("loading");
    listSkills().then((items) => { if (cancelled) return; setSkills(items); setSkillsStatus("ready"); })
      .catch((error) => { if (cancelled) return; setSkillsError(error instanceof Error ? error.message : "Skill discovery failed."); setSkillsStatus("error"); });
    return () => { cancelled = true; };
  }, [activeView, skillsStatus]);

  useEffect(() => {
    if (activeView !== "Skills" || !selectedSkillId) return;
    let cancelled = false;
    setSkillDetailStatus("loading");
    loadSkill(selectedSkillId).then((detail) => { if (cancelled) return; setSkillDetail(detail); setSkillDetailStatus("ready"); })
      .catch((error) => { if (cancelled) return; setSkillsError(error instanceof Error ? error.message : "Skill loading failed."); setSkillDetailStatus("error"); });
    return () => { cancelled = true; };
  }, [activeView, selectedSkillId]);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="window-dots" aria-hidden="true">
          <span className="dot red" /><span className="dot yellow" /><span className="dot green" />
        </div>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <h1>Zeus</h1><span className="version">v0.1.0</span>
        </div>
        <button className="new-session" type="button" onClick={startNewSession}>
          <MessageSquare size={16} />New Session<kbd>⌘ N</kbd>
        </button>
        <nav className="nav-list">
          {navItems.map(({ label, icon: Icon }) => (
            <button className={label === activeView ? "nav-item active" : "nav-item"} key={label} type="button" onClick={() => setActiveView(label)}>
              <Icon size={16} />{label}
            </button>
          ))}
        </nav>
        <section className="recent-block" aria-labelledby="recent-title">
          <div className="section-label" id="recent-title">Recent Sessions<Clock3 size={14} /></div>
          {recentSessions.length === 0 && sessionsStatus === "loading" ? (
            <p className="skills-muted">Loading sessions...</p>
          ) : recentSessions.length === 0 && sessionsStatus === "error" ? (
            <p className="skills-error">{sessionsError}</p>
          ) : (
            recentSessions.map((session, index) => (
              <button className={session.id === activeSession?.id ? "recent-item active" : "recent-item"} key={session.id} type="button" onClick={() => selectSession(session)}>
                <span>{session.label}</span><time>{index === 0 ? "just now" : `${index}d ago`}</time>
              </button>
            ))
          )}
        </section>
        <section className="harness-card" aria-labelledby="harness-title">
          <p className="section-label">Next session review</p>
          <h2 id="harness-title">{proposal.title}</h2>
          <p>{proposal.summary}</p>
          <div className="proposal-actions">
            <button type="button" onClick={() => recordProposal("approved")}>Approve</button>
            <button type="button" onClick={() => recordProposal("edited")}>Edit</button>
            <button type="button" onClick={() => recordProposal("rejected")}>Reject</button>
          </div>
          <div className="proposal-actions secondary">
            <button type="button" onClick={() => recordProposal("applied-once")}>Apply Once</button>
            <button type="button" onClick={() => recordProposal("rolled-back")}>Roll Back</button>
          </div>
          <p className="proposal-status">Status: {proposal.status}</p>
        </section>
        <div className="profile-row">
          <div className="avatar">B</div><span>benclawbot</span><ChevronDown size={14} />
        </div>
      </aside>

      <section className="workspace" aria-label="Task execution">
        {activeView === "Skills" ? (
          <section className="skills-view" aria-label="Skills registry">
            <div className="skills-header">
              <div><p className="section-label">Local Skills</p><h2>Lazy-loaded registry</h2></div>
              <span>{skillsStatus === "ready" ? `${skills.length} found` : skillsStatus}</span>
            </div>
            {skillsStatus === "error" ? (
              <p className="skills-error">{skillsError}</p>
            ) : (
              <div className="skills-layout">
                <div className="skills-list" aria-label="Available skills">
                  {skillsStatus === "loading" ? (
                    <p className="skills-muted">Scanning skill frontmatter...</p>
                  ) : (
                    skills.map((skill) => (
                      <button className={skill.id === selectedSkillId ? "skill-row selected" : "skill-row"} key={skill.id} type="button" onClick={() => setSelectedSkillId(skill.id)}>
                        <span><strong>{skill.name}</strong><em>{skill.id}</em></span>
                        <small>{[skill.hasReferences ? "references" : null, skill.hasScripts ? "scripts" : null, skill.hasAssets ? "assets" : null, skill.hasAgentsMetadata ? "metadata" : null].filter(Boolean).join(" / ") || "single file"}</small>
                      </button>
                    ))
                  )}
                </div>
                <div className="skill-detail" aria-live="polite">
                  {!selectedSkillId ? (
                    <div className="skill-placeholder"><h3>Select a skill</h3><p>Only metadata is loaded so far. Pick a skill to read its full instructions.</p></div>
                  ) : skillDetailStatus === "loading" ? (
                    <p className="skills-muted">Loading {selectedSkillId}...</p>
                  ) : skillDetailStatus === "error" ? (
                    <p className="skills-error">{skillsError}</p>
                  ) : skillDetail ? (
                    <>
                      <div className="skill-detail-heading">
                        <div><h3>{skillDetail.summary.name}</h3><p>{skillDetail.summary.description || "No description in frontmatter."}</p></div>
                        <span>{skillDetail.body.length.toLocaleString()} chars</span>
                      </div>
                      <pre>{skillDetail.body}</pre>
                    </>
                  ) : (
                    <div className="skill-placeholder"><h3>Ready</h3><p>Skill bodies remain unloaded until you choose one.</p></div>
                  )}
                </div>
              </div>
            )}
            <section className="merge-panel" aria-label="Potential skill merges">
              <div className="skills-header compact">
                <div><p className="section-label">Audit</p><h2>Potential overlap</h2></div>
                <span>{mergeCandidates.length} groups</span>
              </div>
              {mergeCandidates.length === 0 ? (
                <p className="skills-muted">Load the registry to see overlap candidates.</p>
              ) : (
                mergeCandidates.map((group) => (
                  <p key={group.label}><strong>{group.label}</strong><span>{group.ids.join(" / ")}</span></p>
                ))
              )}
            </section>
          </section>
        ) : activeView === "Home" ? (
          <>
            <div className="workspace-header">
              <span className="session-pill" aria-label="Current session">{activeSession?.label ?? "Untitled Session"}</span>
              {activeSkillId ? <span className="session-pill skill">skill: {activeSkillId}</span> : null}
            </div>
            <div className="conversation" aria-label="Conversation" ref={conversationRef}>
              {chat.map((entry) => entry.role === "user" ? (
                <article key={entry.id} className="chat-bubble chat-user">
                  <div className="chat-avatar" aria-hidden="true"><User size={16} /></div>
                  <div className="chat-body">
                    <div className="chat-heading"><strong>Me</strong><time>just now</time></div>
                    {entry.skillId ? (
                      <p className="chat-skill-chip" aria-label={`Active skill ${entry.skillId}`}>skill: {entry.skillId}</p>
                    ) : null}
                    <p>{entry.text}</p>
                  </div>
                </article>
              ) : (
                <article key={entry.id} className="chat-bubble chat-zeus">
                  <div className="chat-avatar" aria-hidden="true"><Sparkles size={16} /></div>
                  <div className="chat-body">
                    <div className="chat-heading"><strong>Zeus</strong><time>just now</time></div>
                    {entry.thinking ? (
                      <p className="thinking" aria-live="polite">Thinking<span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span></p>
                    ) : (
                      <p>{entry.text}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>

            <section className="composer" aria-label="Message composer">
              {slash.visible ? (
                <div className="slash-menu" role="listbox" aria-label="Slash commands">
                  {slash.items.length === 0 ? (
                    <p className="slash-empty">No matches for /{slash.query}</p>
                  ) : (
                    slash.items.map((item, index) => {
                      const isActive = index === slash.activeIndex;
                      const label = item.kind === "skill" ? `/${item.id}` : item.label;
                      const description = item.kind === "skill" ? (item.description || `Skill: ${item.name}`) : item.description;
                      return (
                        <button aria-selected={isActive} className={isActive ? "slash-row active" : "slash-row"} key={`${item.kind}-${item.kind === "skill" ? item.id : (item as { id: string }).id}`} onClick={() => applySlashPick(item)} onMouseEnter={() => slash.setActiveIndex(index)} type="button">
                          <span className="slash-row-label">{label}</span>
                          <span className="slash-row-desc">{description}</span>
                          {item.kind === "skill" ? <span className="slash-row-kind">skill</span> : null}
                        </button>
                      );
                    })
                  )}
                  <p className="slash-hint">Up Down to move - Enter or Tab to pick - Esc to close</p>
                </div>
              ) : null}

              {activeSkillId ? (
                <div className="composer-skill-chip" aria-label={`Active skill ${activeSkillId}`}>
                  skill: {activeSkillId}
                  <button aria-label="Remove active skill" onClick={detachSkill} type="button"><X size={12} /></button>
                </div>
              ) : null}

              <textarea aria-label="Message Zeus" onChange={(event) => { setMessage(event.target.value); resizeComposer(); }} onKeyDown={handleComposerKeyDown} placeholder="Type / for skills and commands - Message Zeus..." ref={composerRef} rows={1} value={message} />
              <div className="composer-bottom">
                <div className="composer-tools">
                  <input aria-label="Choose files" className="file-input" multiple onChange={(event) => handleFileSelection(event.target.files)} ref={fileInputRef} type="file" />
                  <button aria-label="Attach file" type="button" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
                  <button aria-label="Mention context" type="button" onClick={addContextMention}>@</button>
                  {attachedFiles.map((file) => (
                    <span className="attached-chip" key={file}>
                      <FileText size={14} />{file}
                      <button aria-label={`Remove ${file}`} type="button" onClick={() => setAttachedFiles((current) => current.filter((item) => item !== file))}><X size={13} /></button>
                    </span>
                  ))}
                </div>
                <div className="send-cluster">
                  <span>{
                    slash.visible
                      ? (runState === "running" ? "Slash picker open - run in progress, Esc to close" : "Up Down navigate - Enter to pick")
                      : runState === "running"
                        ? "Generating... press the stop button to cancel"
                        : "Enter to send / Shift+Enter newline"
                  }</span>
                  {runState === "running" ? (
                    <button aria-label="Stop run" className="stop-button" onClick={stopRun} type="button"><Square size={14} /></button>
                  ) : (
                    <button aria-label="Send message" className="send-button" onClick={() => void handleSend()} type="button"><Send size={17} /></button>
                  )}
                </div>
              </div>
            </section>
          </>
        ) : (
          <section className="utility-view" aria-label={`${activeView} view`}>
            <div className="skills-header">
              <div><p className="section-label">{activeView}</p><h2>{activeView === "Harness Evolution" ? proposal.title : activeView}</h2></div>
              <span>{activeView === "Sessions" ? (activeSession?.label ?? "none") : "state-backed"}</span>
            </div>
            {activeView === "Sessions" && (
              <div className="utility-grid">
                {recentSessions.length === 0 ? (
                  <p className="skills-muted">No sessions yet. Click "New Session" to start one.</p>
                ) : (
                  recentSessions.map((session, index) => (
                    <button className={session.id === activeSession?.id ? "utility-row selected" : "utility-row"} key={session.id} type="button" onClick={() => selectSession(session)}>
                      <strong>{session.label}</strong><span>{index === 0 ? "just now" : `${index}d ago`}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {activeView === "Memory" && (
              <div className="utility-card">
                <dl>
                  <div><dt>Project</dt><dd>Zeus Coding Agent</dd></div>
                  <div><dt>Current Session</dt><dd>{activeSession?.label ?? "none"}</dd></div>
                  <div><dt>Provider</dt><dd>MiniMax-M3 through api.minimax.io/v1</dd></div>
                  <div><dt>Skills</dt><dd>{skillsStatus === "ready" ? `${skills.length} indexed locally` : "Open Skills to index local metadata"}</dd></div>
                  <div><dt>Active Skill</dt><dd>{activeSkillId ?? "none"}</dd></div>
                </dl>
              </div>
            )}
            {activeView === "Harness Evolution" && (
              <div className="utility-card">
                <p>{proposal.summary}</p>
                <div className="proposal-actions">
                  <button type="button" onClick={() => recordProposal("approved")}>Approve</button>
                  <button type="button" onClick={() => recordProposal("edited")}>Edit</button>
                  <button type="button" onClick={() => recordProposal("rejected")}>Reject</button>
                  <button type="button" onClick={() => recordProposal("applied-once")}>Apply Once</button>
                  <button type="button" onClick={() => recordProposal("rolled-back")}>Roll Back</button>
                </div>
                <p className="proposal-status">Status: {proposal.status}</p>
                {history.length === 0 ? (
                  <p className="skills-muted">No harness changes applied in this session.</p>
                ) : (
                  history.map((entry) => (
                    <p key={`${entry.proposalId}-${entry.at}`}>{entry.action} / {new Date(entry.at).toLocaleTimeString()}</p>
                  ))
                )}
              </div>
            )}
            {activeView === "Settings" && (
              <div className="utility-card">
                <p>Access mode</p>
                <div className="access-grid" role="group" aria-label="Settings access mode">
                  {(["Full", "Local", "Review", "Locked"] as AccessMode[]).map((mode) => (
                    <button className={mode === accessMode ? "selected" : ""} key={mode} type="button" onClick={() => setAccessMode(mode)}>{mode}</button>
                  ))}
                </div>
                <p className="skills-muted">{accessSummary}</p>
              </div>
            )}
          </section>
        )}
      </section>

      <aside className="inspector" aria-label="Progress and memory">
        <section className="panel">
          <div className="panel-heading">
            <h2>Plan Progress</h2>
            <span>{completed} / {planItems.length} completed</span>
          </div>
          <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
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
            <div><dt>Project</dt><dd>Zeus Coding Agent</dd></div>
            <div><dt>Tech</dt><dd>Tauri, React, Rust, SQLite</dd></div>
            <div><dt>Provider</dt><dd>MiniMax-M3</dd></div>
            <div><dt>Harness</dt><dd>Approval before rule changes</dd></div>
          </dl>
          <button type="button" onClick={() => setActiveView("Memory")}>View Memory</button>
        </section>

        <section className="panel access-panel">
          <div className="panel-heading">
            <h2>Access Mode</h2>
            <ShieldCheck size={16} />
          </div>
          <div className="access-grid" role="group" aria-label="Access mode">
            {(["Full", "Local", "Review", "Locked"] as AccessMode[]).map((mode) => (
              <button className={mode === accessMode ? "selected" : ""} key={mode} type="button" onClick={() => setAccessMode(mode)}>{mode}</button>
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
              <p key={`${entry.proposalId}-${entry.at}`}>{entry.action} / {new Date(entry.at).toLocaleTimeString()}</p>
            ))
          )}
        </section>
      </aside>
    </main>
  );
}