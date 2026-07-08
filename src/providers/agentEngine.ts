import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export type EnginePhase = "idle" | "turn" | "approvalBlocked" | "settled";
export type ToolExecutionMode = "sequential" | "parallel";

export interface EngineToolManifest {
  name: string;
  label: string;
  riskClass: string;
  executionMode: ToolExecutionMode;
  description: string;
}

export interface FollowUpMilestone {
  id: string;
  title: string;
  outcome: string;
  files: string[];
}

export interface AgentEngineHealth {
  ok: boolean;
  version: string;
  phase: EnginePhase;
  workspaceLimitsDisabled: boolean;
  filesystemScope: string;
  legacyLoopPreserved: boolean;
  events: string[];
  tools: EngineToolManifest[];
  nextImplementation: FollowUpMilestone[];
}

export interface AgentEngineToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface AgentEngineToolBatchRequest {
  objective: string;
  workspaceDir?: string;
  calls: AgentEngineToolCall[];
  approved?: boolean;
  approvalId?: string;
  stopOnError?: boolean;
}

export interface AgentEngineToolResult {
  id: string;
  name: string;
  ok: boolean;
  content: string;
  details: unknown;
  isError: boolean;
}

export interface AgentEngineToolBatchResult {
  version: string;
  objective: string;
  completed: boolean;
  workspaceLimitsDisabled: boolean;
  results: AgentEngineToolResult[];
  filesTouched: string[];
  diff: string;
  summary: string;
}

function ensureRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} is available inside the Zeus desktop runtime.`);
  }
}

export async function getAgentEngineHealth(): Promise<AgentEngineHealth> {
  ensureRuntime("Agent engine health");
  return invoke<AgentEngineHealth>("agent_engine_health");
}

export async function getAgentEngineFollowUpPlan(): Promise<FollowUpMilestone[]> {
  ensureRuntime("Agent engine follow-up plan");
  return invoke<FollowUpMilestone[]>("agent_engine_follow_up_plan");
}

export async function executeAgentEngineTools(request: AgentEngineToolBatchRequest): Promise<AgentEngineToolBatchResult> {
  ensureRuntime("Agent engine tool execution");
  return invoke<AgentEngineToolBatchResult>("agent_engine_execute_tools", { request });
}
