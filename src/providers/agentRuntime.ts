import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export type PlanStatus = "todo" | "inProgress" | "done" | "failed";
export type RiskClass = "readOnly" | "localWrite" | "shell" | "network" | "dependency" | "browser" | "destructive";
export type ApprovalStatus = "pending" | "approvedOnce" | "rejected" | "approvedForSession";

export interface RuntimePlanStep {
  id: string;
  label: string;
  status: PlanStatus;
  dependsOn: string[];
  updatedAt: string;
}

export interface RuntimePlan {
  objective: string;
  status: PlanStatus;
  steps: RuntimePlanStep[];
  updatedAt: string;
}

export interface RuntimeSession {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  currentPlan: RuntimePlan | null;
  readFiles: string[];
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  objective: string;
  riskClass: RiskClass;
  actionLabels: string[];
  affectedFiles: string[];
  diffPreview?: string | null;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
}

export interface BrowserToolRequest {
  action: "status" | "open" | "snapshot" | "click" | "type" | "screenshot" | "eval" | "run_test";
  sessionId?: string;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  testCommand?: string;
}

export interface BrowserToolResult {
  provider: string;
  sessionId: string;
  action: string;
  ok: boolean;
  snapshot?: string | null;
  artifact?: string | null;
  message: string;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  source: string;
  content: string;
  tags: string[];
  stale: boolean;
  supersededBy?: string | null;
  createdAt: string;
}

export interface MemoryHit {
  memory: ProjectMemory;
  score: number;
  reason: string;
}

export interface CodeSearchHit {
  path: string;
  line: number;
  snippet: string;
  symbol?: string | null;
  alreadyRead: boolean;
}

export interface AgentRuntimeStatus {
  serverId: string;
  startedAt: string;
  sessions: number;
  toolRuns: number;
  pendingApprovals: number;
  memories: number;
  browserSessions: number;
}

function requireRuntime(feature: string): void {
  if (!isTauriRuntime()) throw new Error(`${feature} is available inside the Zeus desktop runtime.`);
}

export async function agentRuntimeStatus(): Promise<AgentRuntimeStatus> {
  requireRuntime("Agent runtime status");
  return invoke<AgentRuntimeStatus>("agent_runtime_status");
}

export async function openRuntimeSession(args: { id: string; projectId: string; label: string }): Promise<RuntimeSession> {
  requireRuntime("Agent runtime sessions");
  return invoke<RuntimeSession>("agent_runtime_open_session", { request: args });
}

export async function defineRuntimePlan(args: { sessionId: string; objective: string; steps: string[] }): Promise<RuntimePlan> {
  requireRuntime("Agent runtime plans");
  return invoke<RuntimePlan>("agent_runtime_define_plan", { request: args });
}

export async function listPendingApprovals(sessionId?: string): Promise<PendingApproval[]> {
  requireRuntime("Approval queue");
  return invoke<PendingApproval[]>("agent_runtime_list_approvals", { sessionId });
}

export async function resolveApproval(id: string, status: ApprovalStatus, note?: string): Promise<PendingApproval> {
  requireRuntime("Approval queue");
  return invoke<PendingApproval>("agent_runtime_resolve_approval", { id, status, note });
}

export async function browserTool(request: BrowserToolRequest): Promise<BrowserToolResult> {
  requireRuntime("Semantic browser tool");
  return invoke<BrowserToolResult>("agent_runtime_browser_tool", { request });
}

export async function retrieveProjectMemories(projectId: string, query: string, limit = 5): Promise<MemoryHit[]> {
  requireRuntime("Project memory retrieval");
  return invoke<MemoryHit[]>("agent_runtime_retrieve_memories", { projectId, query, limit });
}

export async function searchCode(args: { root: string; query: string; maxResults?: number; seenFiles?: string[] }): Promise<CodeSearchHit[]> {
  requireRuntime("Structured code search");
  return invoke<CodeSearchHit[]>("agent_runtime_search_code", {
    request: {
      root: args.root,
      query: args.query,
      maxResults: args.maxResults ?? 25,
      seenFiles: args.seenFiles ?? [],
    },
  });
}

export function summarizeMemoryHits(hits: MemoryHit[]): string {
  if (hits.length === 0) return "No project memories were injected.";
  return hits.map((hit) => `- ${hit.memory.source}: ${hit.reason}; ${hit.memory.content}`).join("\n");
}
