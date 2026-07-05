import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  FolderPlus,
  Home,
  Image as ImageIcon,
  MemoryStick,
  MessageSquare,
  Paperclip,
  Pencil,
  Save,
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
import { listProviders as listProvidersTauri, setAccessMode as persistAccessMode, type ProviderInfo } from "./providers/providers";
import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";
import {
  runShellCommand,
  readWorkspaceFile,
  writeWorkspaceFile,
  applyWorkspaceEdit,
  runAgentTask,
  parseShellWords,
  type ShellCommandResult,
  type WriteWorkspaceFileResult,
  type ApplyWorkspaceEditResult,
  type ReadWorkspaceFileResult,
  type AgentRunResult,
  type AgentStepRequest,
} from "./providers/workspace";
import { ToolRunPanel, type ToolRunEntry } from "./components/ToolRunPanel";
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
  projectId: string;
  projectName: string;
}

interface ProjectRef {
  id: string;
  name: string;
}

interface AttachedFile {
  id: string;
  name: string;
  type: string;
  kind: "file" | "image";
  previewUrl?: string;
}

// Parse a fenced `tool` block from the model's response. The model is told
// (via SYSTEM_PROMPT) to emit exactly one block per turn, with one JSON step
// per line. We extract the steps; the surrounding text stays in the chat
// bubble so the user sees the model's commentary.
function parseToolBlock(text: string): AgentStepRequest[] | null {
  const match = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  const steps: AgentStepRequest[] = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const kind = line.slice(0, space).trim();
    const json = line.slice(space + 1).trim();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(json); } catch { continue; }
    if (kind === "readFile" && typeof parsed.path === "string") {
      steps.push({ kind: "readFile", path: parsed.path });
    } else if (kind === "writeFile" && typeof parsed.path === "string" && typeof parsed.content === "string") {
      steps.push({
        kind: "writeFile",
        path: parsed.path,
        content: parsed.content,
        create: parsed.create === true,
        overwrite: parsed.overwrite === true,
      });
    } else if (kind === "editFile" && typeof parsed.path === "string" && typeof parsed.find === "string" && typeof parsed.replace === "string") {
      steps.push({
        kind: "editFile",
        path: parsed.path,
        find: parsed.find,
        replace: parsed.replace,
        replaceAll: parsed.replaceAll === true,
      });
    } else if (kind === "runCommand" && typeof parsed.program === "string" && Array.isArray(parsed.args)) {
      steps.push({
        kind: "runCommand",
        program: parsed.program,
        args: parsed.args.filter((arg): arg is string => typeof arg === "string"),
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
        timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
      });
    }
  }
  return steps.length > 0 ? steps : null;
}

interface GoalState {
  objective: string;
  status: "active" | "complete";
  startedAt: string;
}

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
  "Do not emit a tool block unless the user actually wants a workspace action. For pure chat or explanations, reply in plain text.";
const COMPACT_KEEP_LAST = 6;
const PROJECT_NAME = "Zeus";
const DEFAULT_PROJECT: ProjectRef = { id: "zeus", name: "Zeus" };
const FALLBACK_IMAGE_PREVIEW = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

let messageIdCounter = 0;
function nextMessageId() {
  messageIdCounter += 1;
  return messageIdCounter;
}

function projectIdFromName(name: string): string {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || `project-${Date.now().toString(36)}`;
}

function fileToAttachment(file: File): AttachedFile {
  const kind = file.type.startsWith("image/") ? "image" : "file";
  const previewUrl =
    kind === "image" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(file)
      : kind === "image"
        ? FALLBACK_IMAGE_PREVIEW
        : undefined;
  return {
    id: `${file.name}-${file.lastModified}-${file.size}-${Math.random().toString(36).slice(2)}`,
    name: file.name || "pasted-image.png",
    type: file.type || "application/octet-stream",
    kind,
    previewUrl,
  };
}

function attachmentPrompt(attachments: AttachedFile[]): string {
  return attachments.map((file) => `- ${file.name} (${file.type || "unknown type"}, ${file.kind})`).join("\n");
}

export function App() {
  const [activeView, setActiveView] = useState<AppView>("Home");
  const [accessMode, setAccessMode] = useState<AccessMode>("Full");
  const [proposal, setProposal] = useState<HarnessProposal>({
    id: "proposal-001",
    title: "Harness proposal: close visible workflow gaps",
    summary: "Add the missing daily-use loops: skill discovery, image paste, session projects, proposal editing, memory clarity, and /goal.",
    body: "When a session ends, Zeus should turn the observed friction into a concrete next-session proposal. This one proposes wiring the visible shell to real state: load local skills, let screenshots enter the composer, make recent sessions editable and project-scoped, show what the memory snapshot means, and expose a /goal command for active objectives.",
    status: "ready",
  });
  const [proposalEditing, setProposalEditing] = useState(false);
  const [proposalDraft, setProposalDraft] = useState("");
  const [history, setHistory] = useState<HarnessHistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [activeGoal, setActiveGoal] = useState<GoalState | null>(null);
  const [compactFromId, setCompactFromId] = useState<number | null>(null);
  const [runState, setRunState] = useState<"idle" | "running" | "error">("idle");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [skillsError, setSkillsError] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailStatus, setSkillDetailStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  // recentSessions and activeSession are populated from Rust on mount.
  // On a brand-new install the mount effect auto-creates a real
  // "Untitled Session" so the user always has somewhere to type. We
  // also seed the in-memory state with a real (unpersisted) ref so
  // the UI is never empty during the brief window before the mount
  // effect fires in the Tauri runtime, and so the browser dev env
  // (no Tauri) still has a working session to type into.
  const [recentSessions, setRecentSessions] = useState<SessionRef[]>(() => {
    const id = "untitled";
    return [{ id, label: "Untitled Session", projectId: DEFAULT_PROJECT.id, projectName: DEFAULT_PROJECT.name }];
  });
  const [activeSession, setActiveSession] = useState<SessionRef | null>(() => ({ id: "untitled", label: "Untitled Session", projectId: DEFAULT_PROJECT.id, projectName: DEFAULT_PROJECT.name }));
  const [projects, setProjects] = useState<ProjectRef[]>([DEFAULT_PROJECT]);
  const [activeProjectId, setActiveProjectId] = useState(DEFAULT_PROJECT.id);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState("");
  // Provider list for the Memory panel. Populated from Rust on mount.
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string>("minimax");
  const [sessionsStatus, setSessionsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sessionsError, setSessionsError] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [provider] = useState("minimax");
  // Tool execution results live in the chat as zeus bubbles (so they persist
  // with the session) AND in a parallel ToolRunEntry[] feed so the workspace
  // panel can render diffs, policy decisions, and step logs without
  // re-parsing chat text. Newest entries first.
  const [toolRuns, setToolRuns] = useState<ToolRunEntry[]>([]);
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

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? DEFAULT_PROJECT,
    [projects, activeProjectId],
  );

  const projectSessionGroups = useMemo(() => {
    return projects.map((project) => ({
      ...project,
      sessions: recentSessions.filter((session) => session.projectId === project.id),
    }));
  }, [projects, recentSessions]);

  // Label for the active provider, derived from the live `providers`
  // list populated by Rust's listProviders() command. Falls back to the
  // hardcoded default id until the list arrives.
  const activeProviderLabel = useMemo(() => {
    const found = providers.find((p) => p.id === activeProviderId);
    if (found) return `${found.displayName} (${found.defaultModel})`;
    return activeProviderId;
  }, [providers, activeProviderId]);

  function recordProposal(action: Exclude<HarnessProposal["status"], "ready">) {
    const result = transitionHarnessProposal(proposal, action);
    setProposal(result.proposal);
    setHistory((entries) => [result.historyEntry, ...entries].slice(0, 4));
  }

  function beginProposalEdit() {
    setProposalDraft(proposal.body || proposal.summary);
    setProposalEditing(true);
  }

  function saveProposalEdit() {
    const nextBody = proposalDraft.trim();
    if (!nextBody) return;
    setProposal((current) => ({
      ...current,
      body: nextBody,
      summary: nextBody.length > 140 ? `${nextBody.slice(0, 137)}...` : nextBody,
      status: "edited",
    }));
    setHistory((entries) => [
      { proposalId: proposal.id, action: "edited" as const, at: new Date().toISOString() },
      ...entries,
    ].slice(0, 4));
    setProposalEditing(false);
  }

  // Persist the active session if there's any meaningful state to save
  // (chat non-empty OR a non-default compact anchor). Debounced internally
  // via the React state — callers fire-and-forget, errors are logged but
  // never thrown into the UI.
  // Mirror the access-mode change into SQLite so it survives a relaunch.
  // Fire-and-forget; a failed write is logged but never breaks the UI.
  const persistAccess = React.useCallback((mode: AccessMode) => {
    if (!isTauri) return;
    persistAccessMode(mode).catch((err) => console.warn("set_access_mode failed", err));
  }, [isTauri]);

  const persistActiveSession = React.useCallback(
    (overrides?: { id?: string; label?: string; projectId?: string; projectName?: string; chat?: ChatMessage[]; compactFromId?: number | null }) => {
      const id = overrides?.id ?? activeSession?.id;
      const label = overrides?.label ?? activeSession?.label;
      if (!id) return;
      const chatSnapshot = overrides?.chat ?? chat;
      const compactSnapshot = overrides?.compactFromId ?? compactFromId;
      const payload = {
        id,
        label: label ?? "Untitled Session",
        projectId: overrides?.projectId ?? activeSession?.projectId ?? DEFAULT_PROJECT.id,
        projectName: overrides?.projectName ?? activeSession?.projectName ?? DEFAULT_PROJECT.name,
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
    const ref: SessionRef = { id, label: "Untitled Session", projectId: activeProject.id, projectName: activeProject.name };
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
    saveSession({ id, label: ref.label, projectId: ref.projectId, projectName: ref.projectName, messagesJson: "[]", compactFromId: null }).catch(() => undefined);
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

  function handleFileSelection(files: FileList | File[] | null) {
    if (!files) return;
    const next = Array.from(files).map(fileToAttachment);
    setAttachedFiles((current) => [...current, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    handleFileSelection(files);
  }

  function renameSession(session: SessionRef, label: string) {
    const nextLabel = label.trim() || "Untitled Session";
    const updated = { ...session, label: nextLabel };
    setRecentSessions((current) => current.map((entry) => (entry.id === session.id ? updated : entry)));
    if (activeSession?.id === session.id) setActiveSession(updated);
    setEditingSessionId(null);
    setEditingSessionName("");
    persistActiveSession({
      id: updated.id,
      label: updated.label,
      projectId: updated.projectId,
      projectName: updated.projectName,
    });
  }

  function createProject() {
    const name = projectNameDraft.trim();
    if (!name) return;
    const baseId = projectIdFromName(name);
    const existingIds = new Set(projects.map((project) => project.id));
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const project = { id, name };
    setProjects((current) => [...current, project]);
    setActiveProjectId(project.id);
    setProjectNameDraft("");
  }

  function appendZeusMessage(text: string) {
    let nextChat: ChatMessage[] = [];
    setChat((entries) => {
      nextChat = [...entries, { id: nextMessageId(), role: "zeus", text }];
      return nextChat;
    });
    setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
  }

  function recordToolRun(entry: ToolRunEntry) {
    setToolRuns((entries) => [entry, ...entries].slice(0, 50));
  }

  function adoptProposedHarnessRule(rule: string) {
    // When the agent run auto-generates a harness rule, replace the current
    // pending proposal with one derived from it. This closes the loop between
    // real agent execution and the harness evolution surface.
    const id = `agent-${Date.now()}`;
    setProposal({
      id,
      title: "Agent-suggested harness rule",
      summary: rule.length > 140 ? `${rule.slice(0, 137)}...` : rule,
      body: rule,
      status: "ready",
    });
    setProposalEditing(false);
    const at = new Date().toISOString();
    const newEntry: HarnessHistoryEntry = { proposalId: id, action: "ready", at };
    setHistory((entries) => [newEntry, ...entries].slice(0, 4));
  }

  function summarizeRun(result: ShellCommandResult): string {
    const head = result.exitCode === 0 ? "ran" : result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`;
    const tail = result.stdout.trim() || result.stderr.trim();
    const trimmed = tail.length > 320 ? `${tail.slice(0, 317)}...` : tail;
    const policy = `policy: ${result.policy.commandClass} / ${result.policy.accessMode}${result.policy.approvalRequired && !result.policy.approved ? " (needs approval)" : ""}`;
    return `${head} \`${result.program} ${result.args.join(" ")}` +
      `${result.timedOut ? " [timed out]" : ""}` +
      ` (${result.durationMs}ms)` +
      `${trimmed ? `\n\n${trimmed}` : ""}\n\n${policy}`;
  }

  function summarizeWrite(result: WriteWorkspaceFileResult): string {
    return `wrote ${result.path} (${result.bytesWritten} bytes${result.created ? ", created" : ""})`;
  }

  function summarizeEdit(result: ApplyWorkspaceEditResult): string {
    return `edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}, ${result.bytesWritten} bytes)`;
  }

  function summarizeRead(result: ReadWorkspaceFileResult): string {
    const preview = result.content.length > 480 ? `${result.content.slice(0, 477)}...` : result.content;
    return `read ${result.path} (${result.bytesRead} bytes${result.truncated ? ", truncated" : ""})\n\n\`\`\`\n${preview}\n\`\`\``;
  }

  function summarizeAgentRun(result: AgentRunResult): string {
    return `agent run ${result.completed ? "completed" : "failed"} — ${result.summary}` +
      (result.filesTouched.length ? `\n\nfiles touched: ${result.filesTouched.join(", ")}` : "") +
      (result.proposedHarnessRule ? `\n\nproposed harness rule: ${result.proposedHarnessRule}` : "");
  }

  async function handleShellCommand(input: string): Promise<boolean> {
    const trimmed = input.replace(/^\/run\s+/, "").trim();
    if (!trimmed) { appendZeusMessage("Usage: /run <command>"); return true; }
    if (!isTauri) { appendZeusMessage("Shell execution is only available inside the Zeus desktop runtime."); return true; }
    let words: string[];
    try { words = parseShellWords(trimmed); } catch (err) {
      appendZeusMessage(`Shell parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
    if (words.length === 0) { appendZeusMessage("Empty shell command."); return true; }
    const [program, ...args] = words;
    setRunState("running");
    try {
      const result = await runShellCommand({ program, args });
      recordToolRun({ kind: "shell", at: new Date().toISOString(), shell: result });
      appendZeusMessage(summarizeRun(result));
      setRunState(result.exitCode === 0 ? "idle" : "error");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordToolRun({ kind: "shell", at: new Date().toISOString(), error: message });
      appendZeusMessage(`Shell failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat }), 0);
    }
    return true;
  }

  async function handleReadCommand(input: string): Promise<boolean> {
    const path = input.replace(/^\/read\s+/, "").trim();
    if (!path) { appendZeusMessage("Usage: /read <path>"); return true; }
    if (!isTauri) { appendZeusMessage("Workspace file reads are only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      const result = await readWorkspaceFile(path);
      recordToolRun({ kind: "read", at: new Date().toISOString(), read: result, path });
      appendZeusMessage(summarizeRead(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordToolRun({ kind: "read", at: new Date().toISOString(), error: message, path });
      appendZeusMessage(`Read failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat }), 0);
    }
    return true;
  }

  async function handleWriteCommand(input: string): Promise<boolean> {
    // Format: /write <path> :: <content>
    const body = input.replace(/^\/write\s+/, "").trim();
    const sep = body.indexOf("::");
    if (sep < 0) { appendZeusMessage("Usage: /write <path> :: <content>"); return true; }
    const path = body.slice(0, sep).trim();
    const content = body.slice(sep + 2).replace(/^\n/, "");
    if (!path) { appendZeusMessage("Write target path is required."); return true; }
    if (!isTauri) { appendZeusMessage("Workspace file writes are only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      const result = await writeWorkspaceFile({ path, content, create: true, overwrite: true });
      recordToolRun({ kind: "write", at: new Date().toISOString(), write: result, path });
      appendZeusMessage(summarizeWrite(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordToolRun({ kind: "write", at: new Date().toISOString(), error: message, path });
      appendZeusMessage(`Write failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat }), 0);
    }
    return true;
  }

  async function handleEditCommand(input: string): Promise<boolean> {
    // Format: /edit <path> :: <find> => <replace>
    const body = input.replace(/^\/edit\s+/, "").trim();
    const sep = body.indexOf("::");
    if (sep < 0) { appendZeusMessage("Usage: /edit <path> :: <find> => <replace>"); return true; }
    const path = body.slice(0, sep).trim();
    const tail = body.slice(sep + 2);
    const arrow = tail.indexOf("=>");
    if (arrow < 0) { appendZeusMessage("Usage: /edit <path> :: <find> => <replace>"); return true; }
    const find = tail.slice(0, arrow).replace(/\n$/, "");
    const replace = tail.slice(arrow + 2).replace(/^\n/, "");
    if (!path) { appendZeusMessage("Edit target path is required."); return true; }
    if (!isTauri) { appendZeusMessage("Workspace file edits are only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      const result = await applyWorkspaceEdit({ path, find, replace, replaceAll: false });
      recordToolRun({ kind: "edit", at: new Date().toISOString(), edit: result, path });
      appendZeusMessage(summarizeEdit(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordToolRun({ kind: "edit", at: new Date().toISOString(), error: message, path });
      appendZeusMessage(`Edit failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat }), 0);
    }
    return true;
  }

  function handleGoalCommand(prompt: string) {
    const objective = prompt.slice("/goal".length).trim();
    if (!objective) {
      appendZeusMessage(activeGoal ? `Active goal: ${activeGoal.objective}` : "No active goal. Use /goal <objective> to set one.");
      return;
    }
    setActiveGoal({ objective, status: "active", startedAt: new Date().toISOString() });
    appendZeusMessage(`Goal set: ${objective}`);
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
    if (prompt === "/goal" || prompt.startsWith("/goal ")) { setMessage(""); handleGoalCommand(prompt); return; }
    if (prompt.startsWith("/run")) { setMessage(""); void handleShellCommand(prompt); return; }
    if (prompt.startsWith("/read")) { setMessage(""); void handleReadCommand(prompt); return; }
    if (prompt.startsWith("/write")) { setMessage(""); void handleWriteCommand(prompt); return; }
    if (prompt.startsWith("/edit")) { setMessage(""); void handleEditCommand(prompt); return; }

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
    const attachmentsText = attachmentPrompt(attachedFiles);
    const promptWithAttachments = attachmentsText ? `${prompt}\n\nAttached files:\n${attachmentsText}` : prompt;

    try {
      const response = await dispatchChat({
        provider,
        skillId: skillForTurn ?? undefined,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...contextMessages,
          { role: "user", content: promptWithAttachments },
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
      setAttachedFiles([]);
      // Persist the new transcript after the state updater runs.
      setTimeout(() => persistActiveSession({ chat: nextChat }), 0);

      // Model-driven tool call: if the response includes a fenced `tool`
      // block, run those steps through runAgentTask and surface the result.
      // The user sees the model's prose + the tool run panel below; if the
      // agent run proposes a harness rule, we adopt it as a pending proposal.
      const steps = parseToolBlock(clean);
      if (steps && steps.length > 0) {
        if (!isTauri) {
          appendZeusMessage("Workspace tool steps require the Zeus desktop runtime.");
          return;
        }
        appendZeusMessage(`running ${steps.length} agent step${steps.length === 1 ? "" : "s"}...`);
        try {
          const result = await runAgentTask({
            objective: prompt,
            steps,
            stopOnError: true,
          });
          recordToolRun({ kind: "agent", at: new Date().toISOString(), agent: result });
          appendZeusMessage(summarizeAgentRun(result));
          if (result.proposedHarnessRule) adoptProposedHarnessRule(result.proposedHarnessRule);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordToolRun({ kind: "agent", at: new Date().toISOString(), error: message });
          appendZeusMessage(`Agent run failed: ${message}`);
        }
      }
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
    else if (item.id === "goal") {
      setMessage("/goal ");
      requestAnimationFrame(() => composerRef.current?.focus());
    }
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

  // Load persisted sessions and provider list on first mount. The
  // session list is then mutated locally as the user creates new ones.
  // When the DB is empty we auto-create a real "Untitled Session" so the
  // composer always has somewhere to write to — no fake seed rows.
  useEffect(() => {
    if (!isTauri || sessionsStatus !== "idle") return;
    let cancelled = false;
    setSessionsStatus("loading");
    // Best-effort provider fetch; failure is non-fatal (the Memory panel
    // falls back to the hardcoded default id).
    listProvidersTauri().then((rows) => {
      if (cancelled) return;
      setProviders(rows);
      if (rows.length > 0) setActiveProviderId(rows[0].id);
    }).catch(() => undefined);

    listSessions()
      .then((rows) => {
        if (cancelled) return;
        const refs: SessionRef[] = rows.map((row) => ({
          id: row.id,
          label: row.label,
          projectId: row.projectId ?? DEFAULT_PROJECT.id,
          projectName: row.projectName ?? DEFAULT_PROJECT.name,
        }));
        setRecentSessions(refs.slice(0, 20));
        const nextProjects = new Map<string, ProjectRef>();
        nextProjects.set(DEFAULT_PROJECT.id, DEFAULT_PROJECT);
        refs.forEach((ref) => nextProjects.set(ref.projectId, { id: ref.projectId, name: ref.projectName }));
        setProjects(Array.from(nextProjects.values()));
        setSessionsStatus("ready");
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
        } else {
          // First launch: mint and persist a real session so the user
          // has a real (not seed) entry to type into.
          const id = newSessionId();
          const ref: SessionRef = { id, label: "Untitled Session", projectId: DEFAULT_PROJECT.id, projectName: DEFAULT_PROJECT.name };
          setRecentSessions([ref]);
          setActiveSession(ref);
          saveSession({ id, label: ref.label, projectId: ref.projectId, projectName: ref.projectName, messagesJson: "[]", compactFromId: null })
            .catch((err) => console.warn("initial session save failed", err));
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
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setSkillsError("Skill discovery timed out. Check the bundled skills permission and registry path.");
      setSkillsStatus("error");
    }, 12000);
    setSkillsStatus("loading");
    listSkills().then((items) => { if (cancelled) return; window.clearTimeout(timeout); setSkills(items); setSkillsStatus("ready"); })
      .catch((error) => { if (cancelled) return; window.clearTimeout(timeout); setSkillsError(error instanceof Error ? error.message : "Skill discovery failed."); setSkillsStatus("error"); });
    return () => { cancelled = true; window.clearTimeout(timeout); };
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
              <div className={session.id === activeSession?.id ? "recent-item-row active" : "recent-item-row"} key={session.id}>
                {editingSessionId === session.id ? (
                  <div className="recent-edit">
                    <input
                      aria-label="Session name"
                      onChange={(event) => setEditingSessionName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") renameSession(session, editingSessionName);
                        if (event.key === "Escape") setEditingSessionId(null);
                      }}
                      value={editingSessionName}
                    />
                    <button aria-label="Save session name" type="button" onClick={() => renameSession(session, editingSessionName)}><Save size={13} /></button>
                  </div>
                ) : (
                  <>
                    <button className="recent-item" type="button" onClick={() => selectSession(session)}>
                      <span>{session.label}<small>{session.projectName}</small></span><time>{index === 0 ? "just now" : `${index}d ago`}</time>
                    </button>
                    <button
                      aria-label={`Rename ${session.label}`}
                      className="recent-rename"
                      type="button"
                      onClick={() => { setEditingSessionId(session.id); setEditingSessionName(session.label); }}
                    >
                      <Pencil size={13} />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </section>
        <section className="harness-card" aria-labelledby="harness-title">
          <p className="section-label">Next session review</p>
          <h2 id="harness-title">{proposal.title}</h2>
          <p>{proposal.summary}</p>
          <div className="proposal-actions">
            <button type="button" onClick={() => recordProposal("approved")}>Approve</button>
            <button type="button" onClick={beginProposalEdit}>Edit</button>
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

              <textarea aria-label="Message Zeus" onChange={(event) => { setMessage(event.target.value); resizeComposer(); }} onKeyDown={handleComposerKeyDown} onPaste={handleComposerPaste} placeholder="Type / for skills and commands - Message Zeus..." ref={composerRef} rows={1} value={message} />
              <div className="composer-bottom">
                <div className="composer-tools">
                  <input aria-label="Choose files" className="file-input" multiple onChange={(event) => handleFileSelection(event.target.files)} ref={fileInputRef} type="file" />
                  <button aria-label="Attach file" type="button" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button>
                  <label className="composer-access">
                    <span className="composer-access-label">Access</span>
                    <select
                      aria-label="Access mode"
                      className="composer-access-select"
                      onChange={(event) => {
                        const next = event.target.value as AccessMode;
                        setAccessMode(next);
                        persistAccess(next);
                      }}
                      value={accessMode}
                    >
                      {(["Full", "Local", "Review", "Locked"] as AccessMode[]).map((mode) => (
                        <option key={mode} value={mode}>{mode}</option>
                      ))}
                    </select>
                  </label>
                  {attachedFiles.map((file) => (
                    <span className={file.kind === "image" ? "attached-chip image" : "attached-chip"} key={file.id}>
                      {file.kind === "image" && file.previewUrl ? (
                        <img alt={`${file.name} preview`} src={file.previewUrl} />
                      ) : file.kind === "image" ? (
                        <ImageIcon size={14} />
                      ) : (
                        <FileText size={14} />
                      )}
                      {file.name}
                      <button aria-label={`Remove ${file.name}`} type="button" onClick={() => setAttachedFiles((current) => current.filter((item) => item.id !== file.id))}><X size={13} /></button>
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

            <ToolRunPanel entries={toolRuns} />
          </>
        ) : (
          <section className="utility-view" aria-label={`${activeView} view`}>
            <div className="skills-header">
              <div><p className="section-label">{activeView}</p><h2>{activeView === "Harness Evolution" ? proposal.title : activeView}</h2></div>
              <span>{activeView === "Sessions" ? (activeSession?.label ?? "none") : "state-backed"}</span>
            </div>
            {activeView === "Sessions" && (
              <div className="sessions-manager">
                <div className="project-create">
                  <input
                    aria-label="New project name"
                    onChange={(event) => setProjectNameDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") createProject(); }}
                    placeholder="New project name"
                    value={projectNameDraft}
                  />
                  <button type="button" onClick={createProject}><FolderPlus size={15} />Create project</button>
                </div>
                <div className="project-tabs" aria-label="Projects">
                  {projects.map((project) => (
                    <button className={project.id === activeProjectId ? "selected" : ""} key={project.id} type="button" onClick={() => setActiveProjectId(project.id)}>
                      {project.name}
                    </button>
                  ))}
                </div>
                <div className="utility-grid">
                  {projectSessionGroups.map((group) => (
                    <section className="project-group" key={group.id} aria-label={`${group.name} sessions`}>
                      <h3>{group.name}</h3>
                      {group.sessions.length === 0 ? (
                        <p className="skills-muted">No sessions in this project yet. New Session will add one here.</p>
                      ) : (
                        group.sessions.map((session, index) => (
                          <button className={session.id === activeSession?.id ? "utility-row selected" : "utility-row"} key={session.id} type="button" onClick={() => selectSession(session)}>
                            <strong>{session.label}</strong><span>{index === 0 ? "just now" : `${index}d ago`}</span>
                          </button>
                        ))
                      )}
                    </section>
                  ))}
                </div>
              </div>
            )}
            {activeView === "Memory" && (
              <div className="utility-card">
                <p className="skills-muted">Memory Snapshot shows the current local state Zeus should carry into the next turn: project, session, goal, provider, access mode, compact window, and active skill.</p>
                <dl>
                  <div><dt>Project</dt><dd>{PROJECT_NAME}</dd></div>
                  <div><dt>Session Project</dt><dd>{activeSession?.projectName ?? "none"}</dd></div>
                  <div><dt>Current Session</dt><dd>{activeSession ? `${activeSession.label} (${chat.length} turn(s))` : "none"}</dd></div>
                  <div><dt>Goal</dt><dd>{activeGoal?.objective ?? "none"}</dd></div>
                  <div><dt>Provider</dt><dd>{activeProviderLabel}</dd></div>
                  <div><dt>Access</dt><dd>{accessMode}</dd></div>
                  <div><dt>Skills</dt><dd>{skillsStatus === "ready" ? `${skills.length} indexed locally` : (skillsStatus === "loading" ? "loading..." : skillsStatus === "error" ? "discovery failed" : "open Skills to index")}</dd></div>
                  <div><dt>Active Skill</dt><dd>{activeSkillId ?? "none"}</dd></div>
                  <div><dt>Context Anchor</dt><dd>{compactFromId === null ? "full visible session" : `messages from #${compactFromId}`}</dd></div>
                </dl>
                <p className="skills-muted">{accessSummary}</p>
              </div>
            )}
            {activeView === "Harness Evolution" && (
              <div className="utility-card">
                <p>{proposal.summary}</p>
                {proposalEditing ? (
                  <div className="proposal-editor">
                    <textarea aria-label="Harness proposal body" value={proposalDraft} onChange={(event) => setProposalDraft(event.target.value)} />
                    <div className="proposal-actions">
                      <button type="button" onClick={saveProposalEdit}>Save proposal</button>
                      <button type="button" onClick={() => setProposalEditing(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p className="proposal-body">{proposal.body}</p>
                )}
                <div className="proposal-actions">
                  <button type="button" onClick={() => recordProposal("approved")}>Approve</button>
                  <button type="button" onClick={beginProposalEdit}>Edit</button>
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
                <p className="section-label">Access mode</p>
                <p>Active mode: <strong>{accessMode}</strong></p>
                <p className="skills-muted">{accessSummary}</p>
                <p className="skills-muted">Change the mode from the listbox in the composer.</p>
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
            <span>{activeSession ? `${chat.length} turn(s)` : "no session"}</span>
          </div>
          <dl>
            <div><dt>Project</dt><dd>{PROJECT_NAME}</dd></div>
            <div><dt>Session</dt><dd>{activeSession ? `${activeSession.projectName} / ${activeSession.label}` : "none"}</dd></div>
            <div><dt>Goal</dt><dd>{activeGoal?.objective ?? "none"}</dd></div>
            <div><dt>Tech</dt><dd>Tauri, React, Rust, SQLite</dd></div>
            <div><dt>Provider</dt><dd>{activeProviderLabel}</dd></div>
            <div><dt>Access</dt><dd>{accessMode} — {accessSummary}</dd></div>
            <div><dt>Last action</dt><dd>{history[0] ? `${history[0].action} at ${new Date(history[0].at).toLocaleTimeString()}` : "none"}</dd></div>
          </dl>
          <button type="button" onClick={() => setActiveView("Memory")}>View Memory</button>
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
