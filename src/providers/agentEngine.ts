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
  events: string[];
  tools: EngineToolManifest[];
  nextImplementation: FollowUpMilestone[];
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
