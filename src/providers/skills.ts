import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  hasReferences: boolean;
  hasScripts: boolean;
  hasAssets: boolean;
  hasAgentsMetadata: boolean;
}

export interface SkillDetail {
  summary: SkillSummary;
  body: string;
}

export async function listSkills(): Promise<SkillSummary[]> {
  if (!isTauriRuntime()) {
    throw new Error("Skill discovery is available inside the Zeus desktop runtime.");
  }
  return invoke<SkillSummary[]>("list_skills");
}

export async function loadSkill(id: string): Promise<SkillDetail> {
  if (!isTauriRuntime()) {
    throw new Error("Skill loading is available inside the Zeus desktop runtime.");
  }
  return invoke<SkillDetail>("load_skill", { id });
}
