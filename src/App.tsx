import {
  Archive,
  Bot,
  ChevronDown,
  Clock3,
  FolderPlus,
  Home,
  MemoryStick,
  MessageSquare,
  Pencil,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { dispatchChat } from "./providers/registry";
import { isTauriRuntime } from "./providers/minimax";
import { listSkills, loadSkill, type SkillDetail, type SkillSummary } from "./providers/skills";
import { useSlashMenu, type SlashItem } from "./providers/slash";
import { buildContextMessages, type UiChatBubble } from "./providers/context";
import { generatePlanSteps, summarizeSessionTitle } from "./providers/planner";
import type { RuntimePlan, RuntimePlanStep } from "./agentRuntimeDeepLoop";
import { deleteSession, listSessions, newSessionId, saveSession, type PersistedSession } from "./providers/sessions";
import { listProviders as listProvidersTauri, setAccessMode as persistAccessMode, getProviderKeys, setProviderKeys, testProvider, type ProviderInfo, type ProviderKeysStatus } from "./providers/providers";
import { transitionHarnessProposal, type HarnessHistoryEntry, type HarnessProposal } from "./state/harness";
import { countPendingProposals } from "./state/harness.notifications";
import { mapStepResult, type AgentProgressStep } from "./components/AgentProgressBubble";
import {
  runShellCommand,
  readWorkspaceFile,
  writeWorkspaceFile,
  applyWorkspaceEdit,
  runAgentTask,
  parseShellWords,
  listWorkspaceDir,
  runProjectTest,
  runGitOperation,
  loadProjectConfig,
  type ShellCommandResult,
  type WriteWorkspaceFileResult,
  type ApplyWorkspaceEditResult,
  type ReadWorkspaceFileResult,
  type AgentRunResult,
  type AgentStepRequest,
  type ListWorkspaceDirResult,
  type GitOperationResult,
  type TestRunResult,
  type ProjectConfigSnapshot,
} from "./providers/workspace";
// ToolRunPanel removed — the bottom-of-workspace panel was redundant
// with the per-turn Tool Run badge and the agent progress bubble.
// Workspace actions still surface their results inline.
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";
import { InspectorPanel } from "./views/InspectorPanel";
import { MemoryView } from "./views/MemoryView";
import { HarnessEvolutionView } from "./views/HarnessEvolutionView";
import { ProjectsView, type ProjectRef } from "./views/ProjectsView";
import { HomeView } from "./views/HomeView";
import { compressShellOutput } from "./providers/shellCompressor";
import {
  DEFAULT_TERSE_LEVEL,
  getTerseOutputInstructions,
  type TerseLevel,
} from "./providers/terseOutputSkill";
import {
  DEFAULT_MINIMAL_LEVEL,
  getMinimalCodeInstructions,
  type MinimalLevel,
} from "./providers/minimalCodeSkill";
import {
  contextWindowUsage,
  lookupContextWindow,
} from "./providers/contextWindow";
import {
  decideAutoCompact,
  DEFAULT_COMPACT_TRIGGER_RATIO,
  formatCompactNotice,
} from "./providers/autoCompact";
import { estimateTokensForMessages } from "./providers/tokenEstimator";
import "./styles.css";

type AccessMode = "Full" | "Local" | "Review" | "Locked";
type AppView = "Home" | "Projects" | "Skills" | "Memory" | "Harness Evolution" | "Settings";

type ChatRole = "user" | "zeus";

// Exported so view components can type their prop interfaces without
// duplicating these shapes.
export type { AccessMode, AppView, ChatRole };

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  kind: "file" | "image";
  /**
   * Base64 data URI (`data:<mime>;base64,...`). Always populated for image
   * attachments so the bytes can travel through to the model and the
   * session row. For non-image files this is left undefined — the model
   * only ever needs the filename.
   */
  dataUrl?: string;
}

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
  /**
   * Files attached to this turn. Persisted with the chat row so the user
   * can scroll back and reference the screenshot in a follow-up question.
   * The composer pill clears after send; the attachments live on the chat
   * row, not in the composer.
   */
  attachments?: ChatAttachment[];
  /**
   * Token accounting for an assistant turn. Populated when the provider
   * returns usage info (OpenAI-compatible endpoints usually do). The
   * right-side Session panel reads the latest entry to render the
   * in/out/cached counter. Optional — older rows and providers that
   * don't expose usage simply leave it undefined.
   */
  tokens?: {
    in: number;
    out: number;
    cached?: number;
  };
}
export type { ChatMessage };

interface SessionRef {
  id: string;
  label: string;
  projectId: string;
  projectName: string;
  /** ISO timestamp of the most recent write to this session. Used to render
   *  the relative time label in the sidebar. Optional so older UI seeds
   *  that pre-date this field keep working. */
  lastSeenAt?: string;
}
export type { SessionRef };

/** Render an ISO timestamp as a short relative string for the sidebar.
 *  Falls back to "just now" when the timestamp is missing or unparseable. */
function relativeTimeLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "just now";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "just now";
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// ProjectRef is owned by ProjectsView (see ./views/ProjectsView). The
// orchestrator imports it from there so both sides share the same shape.
interface AttachedFile {
  id: string;
  name: string;
  type: string;
  kind: "file" | "image";
  previewUrl?: string;
  /** Base64 data URI, set asynchronously right after the file is selected
   *  or pasted. Required for image attachments so we can ship the bytes
   *  to the model on send. For non-image files we skip the read. */
  dataUrl?: string;
}
export type { AttachedFile };

// Parse a fenced `tool` block from the model's response. The model is told
// (via SYSTEM_PROMPT) to emit exactly one block per turn, with one JSON step
// per line. We extract the steps; the surrounding text stays in the chat
// bubble so the user sees the model's commentary.
// Sentinel that marks the end of a `createArtifact` raw-body block inside
// a `tool` fence. The line up to (and not including) this marker is
// appended verbatim to the file body. Mirrors `RAW_BODY_END_MARKER` in
// providers/registry.ts.
const RAW_BODY_END_MARKER = "<<<END";
// Tool kinds whose body is collected verbatim until RAW_BODY_END_MARKER,
// instead of being JSON-parsed on a single line. Matches registry.ts.
const RAW_BODY_KINDS = new Set(["createArtifact"]);

function parseToolBlock(text: string): AgentStepRequest[] | null {
  const match = text.match(/```tool\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  const rawLines = match[1].split(/\r?\n/);
  const steps: AgentStepRequest[] = [];
  for (let i = 0; i < rawLines.length; ) {
    const line = rawLines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) { i += 1; continue; }
    const space = line.indexOf(" ");
    if (space < 0) { i += 1; continue; }
    const kind = line.slice(0, space).trim();
    const rest = line.slice(space + 1).trim();
    if (RAW_BODY_KINDS.has(kind)) {
      // `createArtifact path=foo.html create=true overwrite=true`
      // — header carries key=value tokens, body runs until `<<<END`.
      const metadata: Record<string, string> = {};
      for (const token of rest.split(/\s+/)) {
        if (!token) continue;
        const eq = token.indexOf("=");
        if (eq === -1) continue;
        metadata[token.slice(0, eq)] = token.slice(eq + 1);
      }
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < rawLines.length) {
        const nextTrim = rawLines[j].trim();
        if (nextTrim === RAW_BODY_END_MARKER) { j += 1; break; }
        bodyLines.push(rawLines[j]);
        j += 1;
      }
      i = j;
      if (metadata.path) {
        steps.push({
          kind: "writeFile",
          path: metadata.path,
          content: bodyLines.join("\n"),
          create: metadata.create !== "false",
          overwrite: metadata.overwrite !== "false",
        });
      }
      continue;
    }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rest); } catch { i += 1; continue; }
    const step = parseSingleToolStep(kind, parsed);
    if (step) steps.push(step);
    i += 1;
  }
  return steps.length > 0 ? steps : null;
}

function parseSingleToolStep(kind: string, parsed: Record<string, unknown>): AgentStepRequest | null {
  if (kind === "readFile" && typeof parsed.path === "string") {
    return { kind: "readFile", path: parsed.path, maxBytes: typeof parsed.maxBytes === "number" ? parsed.maxBytes : undefined };
  }
  if (kind === "writeFile" && typeof parsed.path === "string" && typeof parsed.content === "string") {
    return {
      kind: "writeFile",
      path: parsed.path,
      content: parsed.content,
      create: parsed.create === true,
      overwrite: parsed.overwrite === true,
    };
  }
  if (kind === "editFile" && typeof parsed.path === "string" && typeof parsed.find === "string" && typeof parsed.replace === "string") {
    // Accept both `replaceAll` (canonical) and `replace_all` (snake_case
    // variant some models emit); an explicit true is required to enable
    // replace-all, otherwise we default to a single replacement.
    const replaceAll = parsed.replaceAll === true || parsed.replace_all === true;
    return { kind: "editFile", path: parsed.path, find: parsed.find, replace: parsed.replace, replaceAll };
  }
  if (kind === "runCommand" && typeof parsed.program === "string" && Array.isArray(parsed.args)) {
    return {
      kind: "runCommand",
      program: parsed.program,
      args: parsed.args.filter((arg): arg is string => typeof arg === "string"),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
    };
  }
  if (kind === "listDir" && typeof parsed.path === "string") {
    return {
      kind: "listDir",
      path: parsed.path,
      maxEntries: typeof parsed.maxEntries === "number" ? parsed.maxEntries : undefined,
    };
  }
  if (kind === "loadProjectConfig") {
    return { kind: "loadProjectConfig" };
  }
  if (kind === "gitOp" && Array.isArray(parsed.args)) {
    return {
      kind: "gitOp",
      args: parsed.args.filter((arg): arg is string => typeof arg === "string"),
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
    };
  }
  if (kind === "runTest") {
    return {
      kind: "runTest",
      args: Array.isArray(parsed.args) ? parsed.args.filter((arg): arg is string => typeof arg === "string") : [],
      timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
    };
  }
  return null;
}

interface GoalState {
  objective: string;
  status: "active" | "complete";
  startedAt: string;
}

const navItems: Array<{ label: AppView; icon: LucideIcon }> = [
  { label: "Home", icon: Home },
  { label: "Projects", icon: Archive },
  { label: "Settings", icon: Settings },
];

const SYSTEM_PROMPT = [
  "# Identity",
  "You are Zeus, a local-first autonomous coding agent running inside the Zeus desktop app.",
  "You live in the user's project, can read and edit files, run shell commands, run tests, and drive the workspace through structured tool calls.",
  "Your single conversation with the user is one continuous chat — every reply goes to them, and every `tool` block you emit runs against their machine.",
  "",
  "# How to reply",
  "- When the user asks a conversational question — about you, your capabilities, your setup, what just happened, anything that isn't a request to act — answer in plain text. Do not emit a `tool` block.",
  "- When the user asks you to do something in the workspace (read/edit a file, run a command, run tests, search code, git operations, project config inspection), emit a fenced `tool` block listing the steps you want executed. Each step is one line of JSON.",
  "- When a step fails, attempt a corrected `tool` block on the next turn before giving up. Don't loop on the same failing call — switch tools or stop and explain.",
  "",
  "# Tool call syntax",
  "```tool",
  "readFile {\"path\":\"src/foo.ts\"}",
  "runCommand {\"program\":\"npm\",\"args\":[\"test\"]}",
  "editFile {\"path\":\"src/foo.ts\",\"find\":\"old\",\"replace\":\"new\",\"replaceAll\":false}",
  "```",
  "Available step kinds: readFile, writeFile, editFile, runCommand, listDir, search, createArtifact, loadProjectConfig, gitOp, runTest.",
  "After the steps run, you'll see the structured observation in the next turn and can either chain another tool block or write a plain-text summary.",
  "",
  "# Final reply structure",
  "When you emit a final reply (whether the run succeeded, partially succeeded, or failed), structure it as three sections:",
  "- **What was done** — concrete actions and the result for each.",
  "- **What's still pending** — open items, with the reason each is pending.",
  "- **Why it's pending** — the failure or constraint that left it open.",
  "If pending items need a user decision, end the reply with a **Decision needed** section that names the choice, options, and which option you recommend.",
].join("\n");
const COMPACT_KEEP_LAST = 6;
const MAX_TOOL_TURNS = 6;
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

/**
 * Read a `File` into a base64 data URI so it can travel through to the
 * model and persist on the chat row. Images are required to ship as
 * data URIs (OpenAI multimodal / Anthropic image blocks both want a URL
 * or base64 payload); non-image files skip the read because the model
 * only ever needs the filename. Falls back to undefined on read error so
 * the UI doesn't get stuck waiting on a broken blob.
 */
function readFileDataUrl(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (typeof FileReader === "undefined") {
      resolve(undefined);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? result : undefined);
    };
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

/**
 * Walk the file list, attach synchronously first (so the preview pill
 * shows up immediately), then asynchronously read base64 into each
 * image attachment. Non-image files are returned without a dataUrl.
 * Returns attachments keyed by their existing id so the async update
 * can map back into the `attachedFiles` state without regenerating ids.
 */
async function hydrateAttachmentBytes(
  files: FileList | File[] | null,
  initial: AttachedFile[],
): Promise<AttachedFile[]> {
  if (!files) return initial;
  const sourceArray = Array.from(files);
  return Promise.all(
    initial.map(async (attachment, index) => {
      if (attachment.kind !== "image") return attachment;
      const source = sourceArray[index];
      if (!source) return attachment;
      const dataUrl = await readFileDataUrl(source);
      return dataUrl ? { ...attachment, dataUrl } : attachment;
    }),
  );
}

/**
 * Release every Blob URL we created for image previews. Called when an
 * attachment is removed, when the chat sends and clears the attachment
 * list, and on window unload. Without this the preview URLs are leaked
 * for the lifetime of the page — the underlying blob stays pinned in
 * memory and Image previews keep their network-style references alive.
 */
function revokeAttachmentUrls(attachments: AttachedFile[]): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const attachment of attachments) {
    if (attachment.previewUrl && attachment.previewUrl !== FALLBACK_IMAGE_PREVIEW && attachment.previewUrl.startsWith("blob:")) {
      try { URL.revokeObjectURL(attachment.previewUrl); } catch { /* ignore double-revoke */ }
    }
  }
}

function attachmentPrompt(attachments: AttachedFile[]): string {
  return attachments.map((file) => `- ${file.name} (${file.type || "unknown type"}, ${file.kind})`).join("\n");
}

/**
 * One part of a multimodal user message. Mirrors the OpenAI / Anthropic
 * shapes (text + image_url). The provider adapter is responsible for
 * translating this to whatever wire format the active model expects.
 */
export type UserOutboundPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type UserOutboundContent = string | UserOutboundPart[];

/**
 * The shape of a chat message we send to the model: a string for
 * text-only turns and an array of parts when an image is attached.
 * Persisted `ChatMessage` rows still store `text` + `attachments`; this
 * type is the wire view, built fresh on each send.
 */
export interface ChatRequestMessage {
  role: "system" | "user" | "assistant";
  content: UserOutboundContent;
}

/**
 * Build the outbound content for a user message. Image attachments become
 * inline `image_url` blocks (base64 data URI). Non-image files keep the
 * filename list in the text prompt — the model can always pull bytes
 * via the `readFile` tool if it needs them. Returns a plain string when
 * there's nothing to attach, which keeps the auto-compaction token
 * estimator cheap for the common case.
 */
export function buildUserOutboundContent(
  prompt: string,
  attachments: ChatAttachment[],
): UserOutboundContent {
  const images = attachments.filter((a) => a.kind === "image" && typeof a.dataUrl === "string");
  if (images.length === 0) {
    const fileNames = attachments
      .filter((a) => a.kind === "file")
      .map((a) => `- ${a.name} (${a.mime || "unknown type"})`)
      .join("\n");
    if (!fileNames) return prompt;
    return `${prompt}\n\nAttached files:\n${fileNames}`;
  }
  const parts: UserOutboundPart[] = [{ type: "text", text: prompt }];
  for (const image of images) {
    parts.push({ type: "image_url", image_url: { url: image.dataUrl! } });
  }
  return parts;
}

export function App() {
  const [activeView, setActiveView] = useState<AppView>("Home");
  const [accessMode, setAccessMode] = useState<AccessMode>(() => {
    if (typeof localStorage === "undefined") return "Full";
    const stored = localStorage.getItem("zeus.accessMode");
    return stored === "Full" || stored === "Local" || stored === "Review" || stored === "Locked" ? stored : "Full";
  });
  const [proposal, setProposal] = useState<HarnessProposal>(() => {
    const fallback: HarnessProposal = {
      id: "proposal-001",
      title: "Harness proposal: close visible workflow gaps",
      summary: "Add the missing daily-use loops: skill discovery, image paste, session projects, proposal editing, memory clarity, and /goal.",
      body: "When a session ends, Zeus should turn the observed friction into a concrete next-session proposal. This one proposes wiring the visible shell to real state: load local skills, let screenshots enter the composer, make recent sessions editable and project-scoped, show what the memory snapshot means, and expose a /goal command for active objectives.",
      status: "ready",
    };
    if (typeof localStorage === "undefined") return fallback;
    try {
      const raw = localStorage.getItem("zeus.proposal");
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Partial<HarnessProposal>;
      if (!parsed || typeof parsed.id !== "string") return fallback;
      return {
        id: parsed.id,
        title: typeof parsed.title === "string" ? parsed.title : fallback.title,
        summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
        body: typeof parsed.body === "string" ? parsed.body : fallback.body,
        status: (parsed.status as HarnessProposal["status"]) ?? "ready",
      };
    } catch {
      return fallback;
    }
  });
  const [history, setHistory] = useState<HarnessHistoryEntry[]>(() => {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = localStorage.getItem("zeus.harnessHistory");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as HarnessHistoryEntry[];
      return Array.isArray(parsed) ? parsed.slice(0, 16) : [];
    } catch { return []; }
  });
  const [agentProgress, setAgentProgress] = useState<{ steps: AgentProgressStep[]; completed: number; partial: boolean } | null>(null);
  const [runtimePlan, setRuntimePlan] = useState<RuntimePlan | null>(null);
  const [proposalDraftBody, setProposalDraftBody] = useState<string | null>(null);
  const notificationCount = countPendingProposals(proposal, activeView === "Harness Evolution");
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
  const [activeProviderId, setActiveProviderId] = useState<string>(() => {
    if (typeof localStorage === "undefined") return "minimax";
    return localStorage.getItem("zeus.activeProviderId") ?? "minimax";
  });
  const [sessionsStatus, setSessionsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [sessionsError, setSessionsError] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const provider = activeProviderId;
  // Provider API key state. The Rust side holds the actual values; the
  // frontend only tracks whether each provider is configured (for the
  // Settings panel + to know if chat is likely to fail) plus draft
  // strings the user is currently typing.
  const [providerKeysStatus, setProviderKeysStatus] = useState<ProviderKeysStatus>({ minimax: false, openai: false, anthropic: false, minimaxBaseUrl: null, openaiBaseUrl: null, anthropicBaseUrl: null, minimaxModel: null, openaiModel: null, anthropicModel: null });
  const [providerKeyDrafts, setProviderKeyDrafts] = useState<Record<string, string>>({ minimax: "", openai: "", anthropic: "", minimaxBaseUrl: "", openaiBaseUrl: "", anthropicBaseUrl: "", minimaxModel: "", openaiModel: "", anthropicModel: "" });
  const [testResults, setTestResults] = useState<Record<string, { status: "running" | "ok" | "error"; message: string; baseUrl?: string; model?: string; preview?: string } | undefined>>({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Refs that mirror state so async code paths (timeouts, awaited calls)
  // always see the latest values without depending on a stale closure.
  const chatRef = useRef<ChatMessage[]>(chat);
  chatRef.current = chat;
  const compactFromIdRef = useRef<number | null>(compactFromId);
  compactFromIdRef.current = compactFromId;
  const activeSessionRef = useRef<SessionRef | null>(activeSession);
  activeSessionRef.current = activeSession;
  // Reentrancy guard for handleSend: runState is async to update across the
  // React commit boundary, so a rapid double-Enter can slip past the
  // `runState === "running"` check. This ref flips synchronously.
  const inFlightSendRef = useRef<boolean>(false);

  const isTauri = isTauriRuntime();
  const slash = useSlashMenu(message, isTauri);
  // Token/cost display state. Updated whenever the model returns a usage
  // payload. Persisted in localStorage so the daily totals survive a
  // relaunch and the user can see how much they've spent.
  const [tokenTotals, setTokenTotals] = useState<{ prompt: number; completion: number; costUsd: number }>(() => {
    if (typeof localStorage === "undefined") return { prompt: 0, completion: 0, costUsd: 0 };
    try {
      const raw = localStorage.getItem("zeus.tokenTotals");
      if (!raw) return { prompt: 0, completion: 0, costUsd: 0 };
      const parsed = JSON.parse(raw) as { prompt?: number; completion?: number; costUsd?: number };
      return {
        prompt: typeof parsed.prompt === "number" ? parsed.prompt : 0,
        completion: typeof parsed.completion === "number" ? parsed.completion : 0,
        costUsd: typeof parsed.costUsd === "number" ? parsed.costUsd : 0,
      };
    } catch { return { prompt: 0, completion: 0, costUsd: 0 }; }
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.tokenTotals", JSON.stringify(tokenTotals)); } catch { /* ignore */ }
  }, [tokenTotals]);
  // Terse-output skill level (Spec 04). Persisted in localStorage so the
  // user's preference survives a relaunch. Default: "full" (the spec's
  // recommended default).
  const [terseLevel, setTerseLevel] = useState<TerseLevel>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_TERSE_LEVEL;
    const raw = localStorage.getItem("zeus.terseLevel");
    if (raw === "off" || raw === "lite" || raw === "full" || raw === "ultra") return raw;
    return DEFAULT_TERSE_LEVEL;
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.terseLevel", terseLevel); } catch { /* ignore */ }
  }, [terseLevel]);
  // Minimal-code-generation skill level (Spec 05). Persisted.
  const [minimalLevel, setMinimalLevel] = useState<MinimalLevel>(() => {
    if (typeof localStorage === "undefined") return DEFAULT_MINIMAL_LEVEL;
    const raw = localStorage.getItem("zeus.minimalLevel");
    if (raw === "off" || raw === "lite" || raw === "full" || raw === "strict") return raw;
    return DEFAULT_MINIMAL_LEVEL;
  });
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.minimalLevel", minimalLevel); } catch { /* ignore */ }
  }, [minimalLevel]);
  // Project-aware context: cache the most recent project config snapshot
  // so the model knows the workspace it is operating in without the user
  // pasting package.json into the composer. Refreshed on mount and
  // whenever the user explicitly runs `/config`.
  const [projectConfig, setProjectConfig] = useState<{ path: string; config: unknown } | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    loadProjectConfig()
      .then((snap) => { if (cancelled) return; setProjectConfig({ path: snap.path, config: snap.config }); })
      .catch(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [isTauri]);

  const accessSummary = useMemo(() => {
    if (accessMode === "Full") return "Files, shell, internet, dependencies and configured APIs with guards enabled.";
    if (accessMode === "Local") return "Repo and shell are allowed. Internet and external APIs stay blocked.";
    if (accessMode === "Review") return "Writes, shell, git and network require review first.";
    return "Read-only mode. Shell, writes and network are disabled.";
  }, [accessMode]);

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

  // Live projected token count for the next outgoing prompt. Recomputed
  // whenever the chat, the compact anchor, the typed message, or the
  // active provider/model changes. Drives the status bar's percentage.
  // Token usage recorded on the most recent assistant turn (in/out/cached).
// Driven by what the provider's `usage` payload returned; rendered in the
// right-side Session panel as the live cost-of-this-conversation summary.
const latestTurnTokens = useMemo(() => {
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const entry = chat[index];
    if (entry.role !== "user" && entry.tokens) return entry.tokens;
  }
  return null;
}, [chat]);

const livePromptTokens = useMemo(() => {
    const providerOverrides = (() => {
      switch (activeProviderId) {
        case "openai":
          return { model: providerKeysStatus.openaiModel ?? undefined };
        case "anthropic":
          return { model: providerKeysStatus.anthropicModel ?? undefined };
        case "minimax":
        default:
          return { model: providerKeysStatus.minimaxModel ?? undefined };
      }
    })();
    const activeModel = providerOverrides.model ?? providers.find((p) => p.id === activeProviderId)?.defaultModel ?? "";
    const projected: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: SYSTEM_PROMPT + getTerseOutputInstructions(terseLevel) + getMinimalCodeInstructions(minimalLevel) },
      ...buildContextMessages(chat, compactFromId),
      ...(message.trim() ? [{ role: "user" as const, content: message.trim() }] : []),
    ];
    return estimateTokensForMessages(projected);
  }, [chat, compactFromId, message, activeProviderId, providers, terseLevel, minimalLevel, providerKeysStatus.openaiModel, providerKeysStatus.anthropicModel, providerKeysStatus.minimaxModel]);

  function recordProposalTransition(action: HarnessProposal["status"], sessionId?: string) {
    if (!proposal) return;
    const result = transitionHarnessProposal(proposal, action, new Date().toISOString(), sessionId);
    setProposal(result.proposal);
    setHistory((entries) => [result.historyEntry, ...entries].slice(0, 4));
  }

  function applyProposal() {
    if (!proposal) return;
    const proposalSnapshot = proposal;
    const implementingSessionId = newSessionId();
    const ref: SessionRef = {
      id: implementingSessionId,
      label: proposalSnapshot.title,
      projectId: activeProject.id,
      projectName: activeProject.name,
    };
    // 1. Mark the proposal as approved and link the implementing session in history.
    const proposalApproved = { ...proposalSnapshot, status: "approved" as const };
    setProposal(proposalApproved);
    setHistory((entries) => [
      { proposalId: proposalApproved.id, action: "approved" as const, at: new Date().toISOString(), sessionId: implementingSessionId },
      ...entries,
    ].slice(0, 4));
    // 2. Create the new session with the proposal title as its label.
    setRecentSessions((current) => [ref, ...current.filter((entry) => entry.id !== implementingSessionId)].slice(0, 20));
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
    // 4. Advance the proposal to "implementing" so the terminal transition
    //    block fires when this session's agent run completes, and so the
    //    notification badge clears.
    setProposal((current) => (current ? { ...current, status: "implementing" } : current));
  }

  function discardProposal() {
    recordProposalTransition("rejected");
  }

  // Persist the active session if there's any meaningful state to save
  // (chat non-empty OR a non-default compact anchor). Debounced internally
  // via the React state — callers fire-and-forget, errors are logged but
  // never thrown into the UI.
  // Mirror the access-mode change into SQLite so it survives a relaunch.
  // Fire-and-forget; a failed write is logged but never breaks the UI.
  // Also mirrors the selection into localStorage so the browser/dev runtime
  // and the very first frame after relaunch already show the right mode
  // (the SQLite round-trip is async and would otherwise lag).
  const persistAccess = React.useCallback((mode: AccessMode) => {
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem("zeus.accessMode", mode); } catch { /* ignore quota errors */ }
    }
    if (!isTauri) return;
    persistAccessMode(mode).catch((err) => console.warn("set_access_mode failed", err));
  }, [isTauri]);

  // Keep the active provider id mirrored in localStorage so it survives
  // a relaunch immediately. The Tauri mount effect below also syncs
  // the persisted choice back into React state on startup.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.activeProviderId", activeProviderId); } catch { /* ignore */ }
  }, [activeProviderId]);

  // Persist the harness proposal + history so the user's prior decisions
  // survive a relaunch. Without this the sidebar always opens on the
  // default "ready" proposal even if they approved/edited one yesterday.
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.proposal", JSON.stringify(proposal)); } catch { /* ignore */ }
  }, [proposal]);
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try { localStorage.setItem("zeus.harnessHistory", JSON.stringify(history)); } catch { /* ignore */ }
  }, [history]);

  const persistActiveSession = React.useCallback(
    (overrides?: { id?: string; label?: string; projectId?: string; projectName?: string; chat?: ChatMessage[]; compactFromId?: number | null }) => {
      // Read latest values from refs so a `setTimeout(..., 0)` callback
      // doesn't capture a stale snapshot of chat/activeSession/compact
      // anchor (the previous closure-based implementation would persist
      // the pre-update state when called from a queued timer).
      const session = activeSessionRef.current;
      const id = overrides?.id ?? session?.id;
      const label = overrides?.label ?? session?.label;
      if (!id) return;
      const chatSnapshot = overrides?.chat ?? chatRef.current;
      const compactSnapshot = overrides?.compactFromId ?? compactFromIdRef.current;
      const payload = {
        id,
        label: label ?? "Untitled Session",
        projectId: overrides?.projectId ?? session?.projectId ?? DEFAULT_PROJECT.id,
        projectName: overrides?.projectName ?? session?.projectName ?? DEFAULT_PROJECT.name,
        messagesJson: JSON.stringify(chatSnapshot),
        compactFromId: compactSnapshot,
      };
      saveSession(payload).catch((err) => {
        // Persistence failure shouldn't break the active UI; just log.
        // The next successful save will overwrite any stale row.
        console.warn("saveSession failed", err);
      });
    },
    [],
  );

  function startNewSession(options?: { label?: string }) {
    const id = newSessionId();
    const label = options?.label?.trim() || "Untitled Session";
    const ref: SessionRef = { id, label, projectId: activeProject.id, projectName: activeProject.name, lastSeenAt: new Date().toISOString() };
    setRecentSessions((current) => [ref, ...current.filter((entry) => entry.id !== id)].slice(0, 20));
    setActiveSession(ref);
    setChat([]);
    setCompactFromId(null);
    setMessage("");
    setRuntimePlan(null);
    // Release any blob preview URLs pinned to the previous session's
    // attachments before we drop the references on the floor.
    setAttachedFiles((current) => { revokeAttachmentUrls(current); return []; });
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
    const initial = Array.from(files).map(fileToAttachment);
    setAttachedFiles((current) => [...current, ...initial]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // Kick off the async base64 hydration so the bytes are ready by the
    // time the user hits Send. The pill renders from `attachedFiles` so
    // it appears instantly; `dataUrl` fills in a moment later.
    void hydrateAttachmentBytes(files, initial).then((hydrated) => {
      if (hydrated.length === 0) return;
      const byId = new Map(hydrated.map((entry) => [entry.id, entry] as const));
      setAttachedFiles((current) =>
        current.map((entry) => {
          const next = byId.get(entry.id);
          return next ? { ...entry, ...(next.dataUrl ? { dataUrl: next.dataUrl } : {}) } : entry;
        }),
      );
    });
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

  function removeSession(session: SessionRef) {
    // Drop the row from the local mirror and from SQLite. If we're
    // deleting the active session, hand the active pointer to the most
    // recent remaining row so the chat surface never collapses onto a
    // deleted id. The default project catches any orphaned activeSession
    // fallbacks so the sidebar keeps rendering.
    setRecentSessions((current) => {
      const next = current.filter((entry) => entry.id !== session.id);
      if (activeSession?.id === session.id) {
        const fallback = next[0] ?? null;
        if (fallback) {
          setActiveSession(fallback);
          setChat([]);
          setCompactFromId(null);
        } else {
          // No sessions left — synthesize a fresh default so the UI
          // has something to anchor to.
          const fresh: SessionRef = { id: newSessionId(), label: "Untitled Session", projectId: DEFAULT_PROJECT.id, projectName: DEFAULT_PROJECT.name };
          setActiveSession(fresh);
          setChat([]);
          setCompactFromId(null);
          setRecentSessions((rows) => [fresh, ...rows]);
        }
      }
      return next;
    });
    if (editingSessionId === session.id) {
      setEditingSessionId(null);
      setEditingSessionName("");
    }
    deleteSession(session.id).catch((err) => console.warn("deleteSession failed", err));
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

  function deleteProject(projectId: string) {
    // The default project is the always-on fallback; refuse to delete it
    // so the sidebar always has a valid active project anchor.
    if (projectId === DEFAULT_PROJECT.id) return;
    // Re-home any sessions that lived in this project onto the default
    // project so nothing is silently orphaned. Delete the session rows
    // from SQLite too — the user asked for the project gone.
    const orphaned = recentSessions.filter((session) => session.projectId === projectId);
    for (const session of orphaned) {
      deleteSession(session.id).catch((err) => console.warn("deleteSession failed", err));
    }
    setRecentSessions((current) =>
      current.map((session) =>
        session.projectId === projectId
          ? { ...session, projectId: DEFAULT_PROJECT.id, projectName: DEFAULT_PROJECT.name }
          : session,
      ),
    );
    setProjects((current) => current.filter((project) => project.id !== projectId));
    if (activeProjectId === projectId) {
      setActiveProjectId(DEFAULT_PROJECT.id);
    }
    if (activeSession && activeSession.projectId === projectId) {
      setActiveSession({
        ...activeSession,
        projectId: DEFAULT_PROJECT.id,
        projectName: DEFAULT_PROJECT.name,
      });
    }
  }

  function appendZeusMessage(text: string) {
    let nextChat: ChatMessage[] = [];
    setChat((entries) => {
      nextChat = [...entries, { id: nextMessageId(), role: "zeus", text }];
      return nextChat;
    });
    setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
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
    const at = new Date().toISOString();
    const newEntry: HarnessHistoryEntry = { proposalId: id, action: "ready", at };
    setHistory((entries) => [newEntry, ...entries].slice(0, 4));
  }

  function summarizeRun(result: ShellCommandResult): string {
    const head = result.exitCode === 0 ? "ran" : result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`;
    // Spec 01 — apply the built-in shell-output compressor to the
    // command's stdout so the next turn's context stays small. The
    // compressor is fail-open: unknown commands pass through untouched.
    const cmdString = `${result.program} ${result.args.join(" ")}`;
    const compressed = compressShellOutput(cmdString, result.stdout, result.exitCode ?? 0);
    const tail = compressed.text.trim() || result.stderr.trim();
    const trimmed = tail.length > 800 ? `${tail.slice(0, 797)}...` : tail;
    const policy = `policy: ${result.policy.commandClass} / ${result.policy.accessMode}${result.policy.approvalRequired && !result.policy.approved ? " (needs approval)" : ""}`;
    // Annotate when the compressor actually reduced the output so the
    // user can see Spec 01 saving tokens in real time.
    const saved = compressed.profileId && compressed.originalChars > compressed.compressedChars
      ? ` (compressed ${compressed.profileId}: ${compressed.originalChars}→${compressed.compressedChars} chars)`
      : "";
    return `${head} \`${result.program} ${result.args.join(" ")}` +
      `${result.timedOut ? " [timed out]" : ""}` +
      ` (${result.durationMs}ms)${saved}` +
      `${trimmed ? `\n\n${trimmed}` : ""}\n\n${policy}`;
  }

  function summarizeWrite(result: WriteWorkspaceFileResult): string {
    return `wrote ${result.path} (${result.bytesWritten} bytes${result.created ? ", created" : ""})`;
  }

  function summarizeEdit(result: ApplyWorkspaceEditResult): string {
    return `edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}, ${result.bytesWritten} bytes)`;
  }

  function summarizeRead(result: ReadWorkspaceFileResult): string {
    const preview = result.content.length > 4000 ? `${result.content.slice(0, 3997)}...` : result.content;
    return `read ${result.path} (${result.bytesRead} bytes${result.truncated ? ", truncated" : ""})\n\n\`\`\`\n${preview}\n\`\`\``;
  }

  function summarizeAgentRun(result: AgentRunResult): string {
    return `agent run ${result.completed ? "completed" : "failed"} — ${result.summary}` +
      (result.filesTouched.length ? `\n\nfiles touched: ${result.filesTouched.join(", ")}` : "") +
      (result.proposedHarnessRule ? `\n\nproposed harness rule: ${result.proposedHarnessRule}` : "");
  }

  function summarizeList(result: ListWorkspaceDirResult): string {
    if (result.entries.length === 0) return `ls ${result.path || "/"}: empty`;
    const lines = result.entries.slice(0, 200).map((e) => `- ${e.name} (${e.kind})`);
    return `ls ${result.path || "/"} (${result.entries.length}${result.truncated ? "+" : ""}):\n${lines.join("\n")}`;
  }

  function summarizeTest(result: TestRunResult): string {
    const status = result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode ?? "?"})`;
    const counts = result.failedCount >= 0
      ? `${result.passedCount} passed / ${result.failedCount} failed`
      : "no summary line detected";
    const tail = (result.stdout || result.stderr).trim().split("\n").slice(-3).join("\n");
    return `test ${status} — ${counts} in ${result.durationMs}ms${tail ? `\n\n${tail}` : ""}`;
  }

  function summarizeGit(result: GitOperationResult): string {
    const status = result.exitCode === 0 ? "ok" : `failed (exit ${result.exitCode ?? "?"})`;
    const out = (result.stdout || result.stderr).trim();
    const tail = out.split("\n").slice(0, 30).join("\n");
    return `git ${result.args.join(" ")} ${status} in ${result.durationMs}ms${tail ? `\n\n${tail}` : ""}`;
  }

  async function handleConfigCommand(input: string): Promise<boolean> {
    const body = input.replace(/^\/config\s*/, "").trim();
    if (body && !isTauri) { appendZeusMessage("Project config is only available inside the Zeus desktop runtime."); return true; }
    if (!body) {
      if (!isTauri) { appendZeusMessage("Project config requires the Zeus desktop runtime."); return true; }
      setRunState("running");
      try {
        const result = await loadProjectConfig();
        appendZeusMessage(`project config (${result.path}):\n\n\`\`\`json\n${JSON.stringify(result.config, null, 2).slice(0, 4000)}\n\`\`\``);
        setRunState("idle");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendZeusMessage(`config failed: ${message}`);
        setRunState("error");
      } finally {
        setTimeout(() => persistActiveSession({ chat: chatRef.current }), 0);
      }
      return true;
    }
    appendZeusMessage("Usage: /config");
    return true;
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
      appendZeusMessage(summarizeRun(result));
      setRunState(result.exitCode === 0 ? "idle" : "error");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      appendZeusMessage(summarizeRead(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      appendZeusMessage(summarizeWrite(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      appendZeusMessage(summarizeEdit(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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

  // /ls <path> — autonomous file discovery. Empty path defaults to the
  // runtime launch directory, but absolute paths are accepted so the agent
  // can inspect anywhere on the machine.
  async function handleListCommand(input: string): Promise<boolean> {
    const path = input.replace(/^\/ls\s+/, "").trim();
    if (!isTauri) { appendZeusMessage("Workspace listing is only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      const result = await listWorkspaceDir(path);
      appendZeusMessage(summarizeList(result));
      setRunState("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendZeusMessage(`ls failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat: chatRef.current }), 0);
    }
    return true;
  }

  // /test [args...] — iterate the project's test suite. Designed to be
  // chained: the model emits `/test`, sees the failed count, then issues
  // follow-up `editFile` steps and re-runs `/test` until exit code 0.
  async function handleTestCommand(input: string): Promise<boolean> {
    const body = input.replace(/^\/test\s*/, "").trim();
    let extraArgs: string[] = [];
    if (body) {
      try { extraArgs = parseShellWords(body); } catch (err) {
        appendZeusMessage(`Test args parse failed: ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
    }
    if (!isTauri) { appendZeusMessage("Test execution is only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      const result = await runProjectTest(extraArgs);
      appendZeusMessage(summarizeTest(result));
      setRunState(result.exitCode === 0 ? "idle" : "error");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendZeusMessage(`test failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat: chatRef.current }), 0);
    }
    return true;
  }

  // /git <args...> — real git ops with the access-mode policy applied
  // (read-only subcommands run anywhere; mutating ones require Review/Full
  // mode and the rust-side `approved` flag flows through `request.approved`).
  async function handleGitCommand(input: string): Promise<boolean> {
    const body = input.replace(/^\/git\s+/, "").trim();
    if (!body) { appendZeusMessage("Usage: /git status, /git log -10, /git commit -m msg"); return true; }
    let args: string[];
    try { args = parseShellWords(body); } catch (err) {
      appendZeusMessage(`git args parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
    if (!isTauri) { appendZeusMessage("git is only available inside the Zeus desktop runtime."); return true; }
    setRunState("running");
    try {
      // Mutating subcommands always carry the user's approval because they
      // came through the chat composer — the rust policy layer still
      // enforces the access-mode gate independently.
      const isMutating = !["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "ls-tree"].includes(args[0] ?? "");
      const result = await runGitOperation(args, undefined, undefined);
      appendZeusMessage(summarizeGit(result));
      setRunState(result.exitCode === 0 ? "idle" : "error");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendZeusMessage(`git failed: ${message}`);
      setRunState("error");
    } finally {
      setTimeout(() => persistActiveSession({ chat: chatRef.current }), 0);
    }
    return true;
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
    // Synchronous reentrancy guard. `runState` is async to read (it's set
    // in a render tick after React commits), so two rapid Enter presses
    // can both observe `runState !== "running"`. The ref flips immediately
    // and guarantees only one in-flight send at a time.
    if (inFlightSendRef.current) return;
    if (runState === "running") return;
    inFlightSendRef.current = true;
    try {
      await handleSendInner(prompt);
    } finally {
      inFlightSendRef.current = false;
    }
  }

  async function handleSendInner(prompt: string): Promise<void> {
    if (prompt === "/new") { setMessage(""); startNewSession(); return; }
    if (prompt === "/compact") { setMessage(""); compactContext(); return; }
    if (prompt === "/stop") { setMessage(""); stopRun(); return; }
    if (prompt === "/goal" || prompt.startsWith("/goal ")) { setMessage(""); handleGoalCommand(prompt); return; }
    if (prompt.startsWith("/run")) { setMessage(""); void handleShellCommand(prompt); return; }
    if (prompt.startsWith("/read")) { setMessage(""); void handleReadCommand(prompt); return; }
    if (prompt.startsWith("/write")) { setMessage(""); void handleWriteCommand(prompt); return; }
    if (prompt.startsWith("/edit")) { setMessage(""); void handleEditCommand(prompt); return; }
    if (prompt.startsWith("/ls")) { setMessage(""); void handleListCommand(prompt); return; }
    if (prompt.startsWith("/test")) { setMessage(""); void handleTestCommand(prompt); return; }
    if (prompt.startsWith("/git")) { setMessage(""); void handleGitCommand(prompt); return; }
    if (prompt === "/config" || prompt.startsWith("/config ")) { setMessage(""); void handleConfigCommand(prompt); return; }

    const skillForTurn = activeSkillId;
    // Snapshot the attachments so the chat row stores them and the model
    // call ships the image bytes in the same tick. Without this snapshot
    // the async base64 hydration can finish after Send clears the pill,
    // leaving us with attachments that have no `dataUrl` to send.
    const attachmentSnapshot = attachedFiles
      .filter((file) => file.kind === "image" && typeof file.dataUrl === "string")
      .map<ChatAttachment>((file) => ({
        id: file.id,
        name: file.name,
        mime: file.type,
        kind: "image",
        dataUrl: file.dataUrl!,
      }));
    const userMessage: ChatMessage = {
      id: nextMessageId(),
      role: "user",
      text: prompt,
      skillId: skillForTurn ?? undefined,
      ...(attachmentSnapshot.length > 0 ? { attachments: attachmentSnapshot } : {}),
    };
    const thinkingMessage: ChatMessage = { id: nextMessageId(), role: "zeus", text: "", thinking: true };
    // Build the snapshot synchronously so it reflects the new user turn
    // (the closure-captured `chat` is from before `setChat` ran and would
    // otherwise send the model the previous transcript, missing the
    // just-typed prompt).
    const historySnapshot = [...chat, userMessage, thinkingMessage] as UiChatBubble[];
    setChat((entries) => [...entries, userMessage, thinkingMessage]);
    setMessage("");
    setRunState("running");
    requestAnimationFrame(() => { if (composerRef.current) composerRef.current.style.height = "24px"; });

    // Codex-style planning: ask the active provider for a 3-7 step plan
    // for this objective. Result lands in `runtimePlan`, which
    // PlanProgressPanel reads to surface task-specific steps instead of
    // the generic 5-step boilerplate. Fire-and-forget — the agent loop
    // doesn't wait for the plan; the panel shows the heuristic fallback
    // until the LLM response arrives.
    setRuntimePlan(null);
    {
      const overrides = getActiveProviderOverrides();
      void generatePlanSteps(prompt, {
        provider: activeProviderId,
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      }).then((steps) => {
        if (!steps) return;
        setRuntimePlan({
          objective: prompt.trim(),
          status: "in_progress",
          steps: steps.map<RuntimePlanStep>((label, index) => ({
            id: `plan-${index}`,
            label,
            status: "todo",
          })),
        });
      });
    }

    // Auto-title the session from the user's first prompt so the
    // sidebar stops showing "Untitled Session" for every new chat.
    // Only fires when the session still has the default label — once
    // titled (auto or manual) we leave it alone.
    if (activeSession && activeSession.label === "Untitled Session") {
      const overrides = getActiveProviderOverrides();
      const sessionToRename = activeSession;
      void summarizeSessionTitle(prompt, {
        provider: activeProviderId,
        ...(overrides.model ? { model: overrides.model } : {}),
        ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      }).then((title) => {
        if (!title) return;
        // Guard against a stale closure: the user may have renamed or
        // switched sessions while the LLM probe was in flight.
        if (activeSessionRef.current?.id !== sessionToRename.id) return;
        renameSession(sessionToRename, title);
      });
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Snapshot the chat at dispatch time so the history we send reflects
    // exactly what the user saw, even if a concurrent setter updates chat
    // while the await is in flight.
    const contextMessages = buildContextMessages(historySnapshot, compactFromId);
    // Build the outbound content for the user message. Image attachments
    // travel as multimodal blocks so the model can actually see them;
    // non-image file names are appended to the text prompt so the model
    // at least knows they exist (and can ask for bytes via `readFile`).
    const userOutboundContent = buildUserOutboundContent(prompt, attachmentSnapshot);

    // Project-aware context. When we have a cached config snapshot, prepend
    // a one-line description of the workspace so the model can answer
    // questions like "what's our test runner?" without a round-trip.
    const projectHint = projectConfig
      ? `\n\nActive workspace config: ${projectConfig.path}\n\`\`\`json\n${JSON.stringify(projectConfig.config, null, 2).slice(0, 2000)}\n\`\`\``
      : "";

    // Auto-compaction gate: if the outgoing prompt would exceed the
    // active model's 40% threshold, compact the chat history *before*
    // sending. This is a no-op for short prompts; for long ones it
    // keeps the model from running out of headroom mid-turn.
    const activeModelId = (() => {
      switch (activeProviderId) {
        case "openai": return providerKeysStatus.openaiModel ?? providers.find((p) => p.id === "openai")?.defaultModel ?? "";
        case "anthropic": return providerKeysStatus.anthropicModel ?? providers.find((p) => p.id === "anthropic")?.defaultModel ?? "";
        case "minimax":
        default: return providerKeysStatus.minimaxModel ?? providers.find((p) => p.id === "minimax")?.defaultModel ?? "";
      }
    })();
    const providerModel = activeModelId;
    const triggerRatio = DEFAULT_COMPACT_TRIGGER_RATIO;
    const projectedMessages: ChatRequestMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + projectHint },
      ...contextMessages,
      { role: "user", content: userOutboundContent },
    ];
    const decision = decideAutoCompact(projectedMessages, providerModel, activeProviderId, triggerRatio);
    if (decision.shouldCompact) {
      // Persist a copy of the chat so we can mention what we lost in
      // the notice, then call compactContext (which already mutates
      // `chat` and `compactFromId` and re-saves the session).
      const droppedCount = chat.filter((entry) => entry.thinking !== true && (compactFromId === null || entry.id < compactFromId)).length;
      compactContext();
      // Build the auto-compact notice after the state has settled so
      // the user sees what just happened. We do this through a setTimeout
      // to keep the order of side-effects predictable (the actual
      // compact already queued its own persistActiveSession).
      setTimeout(() => {
        appendZeusMessage(`${formatCompactNotice(decision)} Dropped ${droppedCount} earlier turn(s).`);
      }, 0);
      // Re-build contextMessages from the freshly-compacted chat.
      const freshSnapshot = [...chatRef.current, userMessage, thinkingMessage] as UiChatBubble[];
      const freshContext = buildContextMessages(freshSnapshot, compactFromIdRef.current);
      projectedMessages.length = 0;
      projectedMessages.push(
        { role: "system", content: SYSTEM_PROMPT + projectHint },
        ...freshContext,
        { role: "user", content: userOutboundContent },
      );
    }
    // Build the final system prompt by appending the active terse and
    // minimal-code skill bodies. The terse skill is on by default
    // (Spec 04); the minimal-code skill is on by default (Spec 05).
    const terseBlock = getTerseOutputInstructions(terseLevel);
    const minimalBlock = getMinimalCodeInstructions(minimalLevel);
    const augmentedSystem = [SYSTEM_PROMPT, terseBlock, minimalBlock, projectHint].filter((s) => s && s.trim().length > 0).join("\n\n");

    // Seed messages: system prompt + compact context + the user's prompt.
    // The recursive runChatTurn appends the model's last reply and any tool
    // results, so subsequent iterations see the full picture.
    const seedMessages: ChatRequestMessage[] = [
      { role: "system", content: augmentedSystem },
      ...buildContextMessages([...chat, userMessage, thinkingMessage] as UiChatBubble[], compactFromId),
      { role: "user", content: userOutboundContent },
    ];

    await runChatTurn(seedMessages, thinkingMessage.id, controller.signal, 0, prompt);

    if (!controller.signal.aborted) setRunState("idle");
    abortRef.current = null;
    return;
  }

  // Recursive multi-turn chat driver. After each model response, scans for
  // a fenced `tool` block. If found, runs the steps through runAgentTask,
  // appends the result to the chat, then re-prompts the model with the
  // updated history so it can either chain another tool call or produce
  // a final answer. Bounded by MAX_TOOL_TURNS to prevent runaway loops.
  async function runChatTurn(
    seedMessages: ChatRequestMessage[],
    thinkingBubbleId: number,
    signal: AbortSignal,
    depth: number,
    originalPrompt: string,
  ): Promise<void> {
    if (signal.aborted) return;
    const skillForTurn = activeSkillId;
    const providerOverrides = getActiveProviderOverrides();
    // Error recovery: classify errors and retry transient ones with
    // exponential backoff. Network blips, 5xx, and timeouts retry up
    // to 3 times. Missing API keys, 4xx auth errors, and malformed
    // requests fail fast so the user sees the real problem.
    const isTransient = (message: string): boolean =>
      /timeout|timed out|network|fetch failed|econnreset|econnrefused|503|502|500|504|429/i.test(message);
    let response: { content: string; model: string; usage?: unknown } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await dispatchChat({
          provider,
          skillId: skillForTurn ?? undefined,
          messages: seedMessages,
          ...(providerOverrides.model ? { model: providerOverrides.model } : {}),
          ...(providerOverrides.baseUrl ? { baseUrl: providerOverrides.baseUrl } : {}),
        });
        break;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransient(message) || attempt === 2) throw err;
        const backoffMs = 500 * Math.pow(2, attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        if (signal.aborted) return;
      }
    }
    if (!response) throw lastError ?? new Error("Chat failed without a response.");
    if (signal.aborted) return;
    try {
      // Token accounting. `usage` is provider-specific (OpenAI returns
      // {prompt_tokens, completion_tokens, total_tokens}; Anthropic
      // returns {input_tokens, output_tokens}; MiniMax mirrors OpenAI).
      // The cost estimate uses a conservative blended rate so the totals
      // are directionally useful without being a billing source of truth.
      const usage = response.usage as {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } | undefined;
      let turnTokens: { in: number; out: number; cached?: number } | undefined;
      if (usage) {
        const prompt = usage.prompt_tokens ?? usage.input_tokens ?? 0;
        const completion = usage.completion_tokens ?? usage.output_tokens ?? 0;
        const cached = usage.prompt_tokens_details?.cached_tokens;
        if (prompt > 0 || completion > 0) {
          const cost = (prompt * 0.000_000_3) + (completion * 0.000_001_2);
          setTokenTotals((current) => ({
            prompt: current.prompt + prompt,
            completion: current.completion + completion,
            costUsd: current.costUsd + cost,
          }));
          turnTokens = { in: prompt, out: completion, ...(cached !== undefined ? { cached } : {}) };
        }
      }
      const clean = stripThinkingTags(response.content);
      let nextChat: ChatMessage[] = [];
      setChat((entries) => {
        nextChat = entries.map((entry) =>
          entry.id === thinkingBubbleId
            ? { ...entry, text: clean, thinking: false, ...(turnTokens ? { tokens: turnTokens } : {}) }
            : entry,
        );
        return nextChat;
      });
      setAttachedFiles((current) => { revokeAttachmentUrls(current); return []; });
      setTimeout(() => persistActiveSession({ chat: nextChat }), 0);

      // No tool block: the model gave a final answer. Done.
      const steps = parseToolBlock(clean);
      if (!steps || steps.length === 0) return;

      // Bound recursion. If the model keeps asking for tools past the cap,
      // surface a clear message instead of silently stopping.
      if (depth >= MAX_TOOL_TURNS) {
        appendZeusMessage(`Stopped after ${MAX_TOOL_TURNS} tool turns. The model kept requesting workspace actions without producing a final answer.`);
        return;
      }

      if (!isTauri) {
        appendZeusMessage("Workspace tool steps require the Zeus desktop runtime.");
        return;
      }

      // Run the requested steps. Show progress and the result in the chat.
      appendZeusMessage(`running ${steps.length} agent step${steps.length === 1 ? "" : "s"}...`);
      let agentResult: AgentRunResult | null = null;
      let agentError: string | null = null;
      try {
        const result = await runAgentTask({
          objective: originalPrompt,
          steps,
          stopOnError: false,
        });
        agentResult = result;
        // Build the per-step progress bubble from the agent's log.
        const stepsForBubble: AgentProgressStep[] = result.logs.map((entry) => {
          const mapped = mapStepResult(entry.result);
          const step: AgentProgressStep = { index: entry.index, label: entry.label, status: mapped.status };
          if (mapped.message !== undefined) step.result = mapped.message;
          return step;
        });
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
        appendZeusMessage(summarizeAgentRun(result));
        setChat((entries) => [...entries, progressMessage]);
        if (result.proposedHarnessRule) adoptProposedHarnessRule(result.proposedHarnessRule);
      } catch (err) {
        agentError = err instanceof Error ? err.message : String(err);
        appendZeusMessage(`Agent run failed: ${agentError}`);
      }

      if (signal.aborted) return;

      // Build the next-turn messages: prior history + model reply + tool
      // result. The model sees the result and can chain another tool call
      // or emit a final summary.
      const toolSummary = agentResult
        ? `Tool result for the \`tool\` block you just emitted:\n\n${summarizeAgentRun(agentResult)}\n\nFiles touched: ${agentResult.filesTouched.join(", ") || "(none)"}\nDiff:\n\`\`\`\n${agentResult.diff || "(no diff)"}\n\`\`\`\n\nNow either emit another \`tool\` block if more steps are needed, or respond to the user with a plain-text summary.`
        : `Tool result for the \`tool\` block you just emitted:\n\nFAILED: ${agentError}\n\nEither retry with a corrected \`tool\` block or respond to the user explaining what went wrong.`;

      // Append a fresh thinking bubble for the next turn.
      const nextThinkingId = nextMessageId();
      setChat((entries) => [...entries, { id: nextThinkingId, role: "zeus", text: "", thinking: true }]);
      // Snapshot the latest chat into a fresh context for the recursive call.
      const nextHistorySnapshot = nextChat as UiChatBubble[];
      const nextContextMessages = buildContextMessages(nextHistorySnapshot, compactFromId);
      // Use the same augmented system prompt (terse + minimal-code) on
      // every recursive turn so a multi-step tool run doesn't drop the
      // output-discipline instructions.
      const terseBlockRec = getTerseOutputInstructions(terseLevel);
      const minimalBlockRec = getMinimalCodeInstructions(minimalLevel);
      const augmentedSystemRec = [SYSTEM_PROMPT, terseBlockRec, minimalBlockRec].filter((s) => s && s.trim().length > 0).join("\n\n");
      const nextMessages: ChatRequestMessage[] = [
        { role: "system", content: augmentedSystemRec },
        ...nextContextMessages,
      ];

      // Transition the harness proposal from "implementing" to a terminal
      // state based on the agent run outcome. Only fire when the proposal
      // is currently "implementing" — the user may have applied multiple
      // proposals back-to-back and we don't want to retroactively mark
      // an already-applied one as failed.
      if (proposal.status === "implementing" && agentResult) {
        const target: HarnessProposal["status"] = agentResult.completed ? "applied" : "failed";
        const proposalAfter = { ...proposal, status: target };
        setProposal(proposalAfter);
        setHistory((entries) => [
          { proposalId: proposal.id, action: target, at: new Date().toISOString(), sessionId: activeSession?.id },
          ...entries,
        ].slice(0, 4));
      }

      await runChatTurn(nextMessages, nextThinkingId, signal, depth + 1, originalPrompt);
    } catch (error) {
      if (signal.aborted) return;
      if (signal.aborted) return;
      const rawText = error instanceof Error ? error.message : "Chat request failed.";
      // If the error looks like a missing/invalid provider key, append a
      // clear hint pointing the user at the Settings panel.
      const looksLikeKeyIssue = /api[_\s-]?key|missing\s+api|unauthor/i.test(rawText);
      const text = looksLikeKeyIssue
        ? `${rawText}\n\nSet your provider key in Settings (provider API keys section) to enable chat.`
        : rawText;
      let nextChat: ChatMessage[] = [];
      setChat((entries) => {
        nextChat = entries.map((entry) => entry.id === thinkingBubbleId ? { ...entry, text, thinking: false } : entry);
        return nextChat;
      });
      setRunState("error");
      setTimeout(() => persistActiveSession({ chat: nextChat }), 0);
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
    } else if (item.id === "ls" || item.id === "test" || item.id === "git" || item.id === "run" || item.id === "read" || item.id === "config") {
      // Prefill the composer with the command and a trailing space so
      // the user can keep typing without re-typing the slash.
      const label = `/${item.id} `;
      setMessage(label);
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        if (composerRef.current) {
          composerRef.current.selectionStart = label.length;
          composerRef.current.selectionEnd = label.length;
        }
      });
    } else if (item.id === "write" || item.id === "edit") {
      // Prefill with the full template so the user can fill in the
      // path/contents without remembering the separator syntax.
      const template = item.id === "write" ? "/write path :: content" : "/edit path :: find => replace";
      setMessage(template);
      requestAnimationFrame(() => composerRef.current?.focus());
    } else if (item.id === "websearch") {
      // Prefill with a fenced `tool` block the model can execute
      // directly. The user types their query after the colon.
      const template = "Run a web search and summarize the findings.\n\n```tool\nwebSearch {\"query\":\"\"}\n```";
      setMessage(template);
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
          lastSeenAt: row.lastSeenAt,
        }));
        setRecentSessions(
          refs
            .slice()
            .sort((a, b) => {
              const ta = a.lastSeenAt ? Date.parse(a.lastSeenAt) : 0;
              const tb = b.lastSeenAt ? Date.parse(b.lastSeenAt) : 0;
              return tb - ta;
            })
            .slice(0, 20),
        );
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

  // Load provider API key status (which providers have a key configured)
  // whenever the Settings view opens. We never see the actual key values
  // — just a boolean per provider.
useEffect(() => {
    if (activeView !== "Settings") return;
    if (!isTauri) {
      setProviderKeysStatus({ minimax: false, openai: false, anthropic: false, minimaxBaseUrl: null, openaiBaseUrl: null, anthropicBaseUrl: null, minimaxModel: null, openaiModel: null, anthropicModel: null });
      return;
    }
    let cancelled = false;
    getProviderKeys().then((status) => {
      if (cancelled) return;
      setProviderKeysStatus(status);
      // Pre-populate the baseUrl / model drafts from the saved values
      // so the Settings form reflects the current effective config.
      setProviderKeyDrafts((current) => ({
        ...current,
        minimaxBaseUrl: status.minimaxBaseUrl ?? "",
        openaiBaseUrl: status.openaiBaseUrl ?? "",
        anthropicBaseUrl: status.anthropicBaseUrl ?? "",
        minimaxModel: status.minimaxModel ?? "",
        openaiModel: status.openaiModel ?? "",
        anthropicModel: status.anthropicModel ?? "",
      }));
    })
      .catch((err) => { if (cancelled) return; console.warn("get_provider_keys failed", err); });
    return () => { cancelled = true; };
  }, [activeView, isTauri]);

  async function handleSaveProviderKey(provider: "minimax" | "openai" | "anthropic", value: string) {
    if (!isTauri) return;
    const payload = { [provider]: value } as { minimax?: string; openai?: string; anthropic?: string };
    try {
      await setProviderKeys(payload);
      setProviderKeysStatus((current) => ({ ...current, [provider]: value.trim().length > 0 }));
      setProviderKeyDrafts((current) => ({ ...current, [provider]: "" }));
    } catch (err) {
      console.warn("set_provider_keys failed", err);
    }
  }

  async function handleClearProviderKey(provider: "minimax" | "openai" | "anthropic") {
    if (!isTauri) return;
    try {
      await setProviderKeys({ [provider]: "" });
      setProviderKeysStatus((current) => ({ ...current, [provider]: false }));
      setProviderKeyDrafts((current) => ({ ...current, [provider]: "" }));
    } catch (err) {
      console.warn("clear provider key failed", err);
    }
  }

  /** Save per-provider base URL / model overrides (separate from the API key). */
  async function handleSaveProviderOverrides(provider: "minimax" | "openai" | "anthropic", baseUrl: string, model: string) {
    if (!isTauri) return;
    const payload: Record<string, string> = {};
    payload[`${provider}BaseUrl`] = baseUrl;
    payload[`${provider}Model`] = model;
    try {
      await setProviderKeys(payload as { minimax?: string; openai?: string; anthropic?: string; minimaxBaseUrl?: string; openaiBaseUrl?: string; anthropicBaseUrl?: string; minimaxModel?: string; openaiModel?: string; anthropicModel?: string });
      setProviderKeysStatus((current) => ({
        ...current,
        [`${provider}BaseUrl`]: baseUrl.trim() ? baseUrl.trim() : null,
        [`${provider}Model`]: model.trim() ? model.trim() : null,
      }) as ProviderKeysStatus);
    } catch (err) {
      console.warn("save provider overrides failed", err);
    }
  }

  /** Issue a trivial chat call to verify the configured key + base URL + model. */
  async function handleTestProvider(provider: "minimax" | "openai" | "anthropic") {
    if (!isTauri) return;
    const savedBaseUrl = (providerKeysStatus as unknown as Record<string, string | null>)[`${provider}BaseUrl`] ?? null;
    const savedModel = (providerKeysStatus as unknown as Record<string, string | null>)[`${provider}Model`] ?? null;
    setTestResults((current) => ({ ...current, [provider]: { status: "running", message: "Testing…" } }));
    try {
      const result = await testProvider(provider, savedBaseUrl ?? undefined, savedModel ?? undefined);
      setTestResults((current) => ({
        ...current,
        [provider]: result.ok
          ? { status: "ok", message: result.message, baseUrl: result.baseUrl, model: result.model, preview: result.preview ?? undefined }
          : { status: "error", message: result.message, baseUrl: result.baseUrl, model: result.model },
      }));
      // Refresh status so the user sees the saved values reflected immediately.
      const refreshed = await getProviderKeys();
      setProviderKeysStatus(refreshed);
    } catch (err) {
      setTestResults((current) => ({
        ...current,
        [provider]: { status: "error", message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  /** Read the saved baseUrl / model override for the active provider. */
  function getActiveProviderOverrides(): { model?: string; baseUrl?: string } {
    const status = providerKeysStatus;
    switch (activeProviderId) {
      case "openai":
        return { baseUrl: status.openaiBaseUrl ?? undefined, model: status.openaiModel ?? undefined };
      case "anthropic":
        return { baseUrl: status.anthropicBaseUrl ?? undefined, model: status.anthropicModel ?? undefined };
      case "minimax":
      default:
        return { baseUrl: status.minimaxBaseUrl ?? undefined, model: status.minimaxModel ?? undefined };
    }
  }

  // Derive the inputs PlanProgressPanel needs from current chat + tool run state.
  // The plan mirrors what the runtime driver would do, so the inspector panel
  // stays in sync with the agent loop without a side-loaded DOM hijack.
  const latestUserObjective = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      if (chat[i].role === "user" && chat[i].text.trim().length > 0) return chat[i].text;
    }
    return message.trim();
  }, [chat, message]);
  const lastAgentRun = useMemo(() => {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const ap = chat[i].agentProgress;
      if (ap) return { steps: ap.steps, partial: ap.partial };
    }
    return null;
  }, [chat]);
  const lastToolFailed = useMemo(() => {
    if (lastAgentRun?.partial) return true;
    if (history.length === 0) return false;
    const first = history[0];
    return /agent run failed|failed:|status:\s*failed/i.test(`${first.action} ${first.at}`);
  }, [lastAgentRun, history]);

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
        <button className="new-session" type="button" onClick={() => startNewSession()}>
          <MessageSquare size={16} />New Session<kbd>⌘ N</kbd>
        </button>
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
                      <span>{session.label}<small>{session.projectName}</small></span><time>{relativeTimeLabel(session.lastSeenAt)}</time>
                    </button>
                    <button
                      aria-label={`Rename ${session.label}`}
                      className="recent-rename"
                      type="button"
                      onClick={() => { setEditingSessionId(session.id); setEditingSessionName(session.label); }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      aria-label={`Delete ${session.label}`}
                      className="recent-delete"
                      type="button"
                      onClick={() => removeSession(session)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </section>
        <div className="profile-row">
          <div className="avatar">B</div><span>benclawbot</span><ChevronDown size={14} />
        </div>
      </aside>

      <section className="workspace" aria-label="Task execution">
        {activeView === "Skills" ? (
          <SkillsView
            skills={skills}
            skillsStatus={skillsStatus}
            skillsError={skillsError}
            selectedSkillId={selectedSkillId}
            setSelectedSkillId={setSelectedSkillId}
            skillDetail={skillDetail}
            skillDetailStatus={skillDetailStatus}
          />
        ) : activeView === "Home" ? (
          <HomeView
            chat={chat}
            conversationRef={conversationRef}
            message={message}
            setMessage={setMessage}
            composerRef={composerRef}
            resizeComposer={resizeComposer}
            handleComposerKeyDown={handleComposerKeyDown}
            handleComposerPaste={handleComposerPaste}
            fileInputRef={fileInputRef}
            attachedFiles={attachedFiles}
            handleFileSelection={handleFileSelection}
            revokeAttachmentUrls={revokeAttachmentUrls}
            setAttachedFiles={setAttachedFiles}
            slash={slash}
            applySlashPick={applySlashPick}
            activeSkillId={activeSkillId}
            detachSkill={detachSkill}
            accessMode={accessMode}
            setAccessMode={setAccessMode}
            persistAccess={persistAccess}
            runState={runState}
            handleSend={handleSend}
            stopRun={stopRun}
            activeSession={activeSession}
            activeProviderId={activeProviderId}
            providers={providers}
            providerKeysStatus={providerKeysStatus}
            livePromptTokens={livePromptTokens}
            onOpenSettings={() => setActiveView("Settings")}
          />
        ) : (
          <section className="utility-view" aria-label={`${activeView} view`}>
            <div className="skills-header">
              <div><p className="section-label">{activeView}</p><h2>{activeView === "Harness Evolution" ? proposal.title : activeView}</h2></div>
              <span>{activeView === "Projects" ? (activeSession?.label ?? "none") : "state-backed"}</span>
            </div>
            {activeView === "Projects" && (
              <ProjectsView
                projects={projects}
                activeProjectId={activeProjectId}
                defaultProjectId={DEFAULT_PROJECT.id}
                projectNameDraft={projectNameDraft}
                onProjectNameDraftChange={setProjectNameDraft}
                onCreateProject={createProject}
                onSelectProject={setActiveProjectId}
                onDeleteProject={deleteProject}
                projectSessionGroups={projectSessionGroups}
                activeSession={activeSession}
                onSelectSession={selectSession}
                formatRelativeTime={relativeTimeLabel}
              />
            )}
            {activeView === "Memory" && (
              <MemoryView
                projectName={PROJECT_NAME}
                activeSession={activeSession}
                messageCount={chat.length}
                activeGoal={activeGoal}
                activeProviderLabel={activeProviderLabel}
                accessMode={accessMode}
                accessSummary={accessSummary}
                skillsCount={skills.length}
                skillsStatus={skillsStatus}
                activeSkillId={activeSkillId}
                compactFromId={compactFromId}
              />
            )}
            {activeView === "Harness Evolution" && (
              <HarnessEvolutionView
                proposal={proposal}
                history={history}
                recentSessions={recentSessions}
                onApply={applyProposal}
                onDiscard={discardProposal}
                onSelectSession={selectSession}
              />
            )}
            {activeView === "Settings" && (
              <SettingsView
                terseLevel={terseLevel}
                setTerseLevel={setTerseLevel}
                minimalLevel={minimalLevel}
                setMinimalLevel={setMinimalLevel}
                providerKeysStatus={providerKeysStatus}
                providerKeyDrafts={providerKeyDrafts}
                setProviderKeyDrafts={setProviderKeyDrafts}
                testResults={testResults}
                handleSaveProviderKey={handleSaveProviderKey}
                handleClearProviderKey={handleClearProviderKey}
                handleTestProvider={handleTestProvider}
                handleSaveProviderOverrides={handleSaveProviderOverrides}
              />
            )}
          </section>
        )}
      </section>

      <InspectorPanel
        latestUserObjective={latestUserObjective}
        lastAgentRun={lastAgentRun}
        lastToolFailed={lastToolFailed}
        runtimePlan={runtimePlan}
        latestTurnTokens={latestTurnTokens}
        runState={runState}
        messageCount={chat.length}
        onOpenSettings={() => setActiveView("Settings")}
      />
    </main>
  );
}
