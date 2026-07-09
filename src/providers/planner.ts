import { dispatchChat, type ChatMessage, type ChatOptions } from "./registry";

/**
 * Lightweight LLM-based planner. Codex-style: when the user submits a
 * substantive objective, ask the configured model to break it into 3-7
 * concrete subtasks before the agent loop starts. The result feeds the
 * `PlanProgressPanel` so the inspector surface shows task-specific
 * progress (not the generic 5-step boilerplate from
 * `derivePlanFromObjective`).
 *
 * Designed to fail soft: any error (provider missing, parse miss,
 * timeout, empty response) returns `null` and the caller falls back to
 * the heuristic plan. Never throws.
 */

const PLANNING_PROMPT = `You are a planning assistant. The user gave an objective to an autonomous coding agent. Break it into 3-7 concrete, ordered subtasks the agent should execute to satisfy the objective.

Rules:
- Each step is one concrete action ("Read package.json", "Add settings panel under src/components/", "Run npx tsc --noEmit", "Commit with message ...").
- Steps should be in execution order, not arbitrary.
- Do not include generic steps like "Understand objective" or "Verify output". Only steps specific to THIS objective.
- Return ONLY a JSON array of strings. No prose, no markdown fences, no commentary.

Example response:
["Read package.json to confirm dependencies","Add SettingsPanel.tsx under src/components/","Wire the panel into App.tsx sidebar","Run npx tsc --noEmit and npx vitest run","Commit with message 'feat(settings): add settings panel'"]

Objective: `;

const SUBSTANTIVE_MIN_LEN = 24;

/**
 * Heuristic: skip planning for short chit-chat, slash commands, and
 * pure diagnostic questions. Planning a 6-character "ok thanks"
 * wastes a round trip; planning "What does this function do?" produces
 * a fake TODO list when the user just wants an explanation. "Why is X
 * failing?" still gets a plan — the result is usually useful
 * (identify / check logs / fix / verify).
 */
export function isSubstantiveObjective(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < SUBSTANTIVE_MIN_LEN) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.endsWith("?")) {
    const hasActionVerb = /\b(fix|add|build|ship|refactor|migrate|implement|write|create|update|remove|delete|rename|debug|investigate|deploy|run|test|verify|commit|open|close|merge|rewrite|extend|wire|connect|configure|install|setup)\b/i.test(trimmed);
    if (!hasActionVerb) return false;
  }
  return true;
}

/**
 * Strip a JSON array out of a model response. Models occasionally wrap
 * the answer in prose or a markdown fence; tolerate either.
 */
function extractJsonArray(text: string): string[] | null {
  // First, try the strict parse: the response is exactly a JSON array.
  const strict = text.trim();
  if (strict.startsWith("[") && strict.endsWith("]")) {
    try {
      const parsed = JSON.parse(strict);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed.map((s) => s.trim()).filter((s) => s.length > 0);
      }
    } catch {
      // Fall through to the looser match below.
    }
  }
  // Otherwise, find the first JSON array in the response. Models that
  // add a leading "Here is the plan:" prefix still emit the array.
  const match = strict.match(/\[[\s\S]*?\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed.map((s) => s.trim()).filter((s) => s.length > 0);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Ask the configured provider for a 3-7 step plan for `objective`.
 * Returns `null` on any failure so the caller can fall back to the
 * heuristic `derivePlanFromObjective`.
 */
export async function generatePlanSteps(
  objective: string,
  options: Pick<ChatOptions, "provider" | "model" | "baseUrl" | "temperature">,
): Promise<string[] | null> {
  if (!isSubstantiveObjective(objective)) return null;
  const trimmed = objective.trim();
  const messages: ChatMessage[] = [
    { role: "system", content: "You generate concise task plans. Return only JSON arrays of strings, no prose." },
    { role: "user", content: `${PLANNING_PROMPT}"${trimmed.replace(/"/g, '\\"')}"` },
  ];
  try {
    const response = await dispatchChat({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      temperature: options.temperature ?? 0.2,
      messages,
    });
    return extractJsonArray(response.content);
  } catch {
    // Caller falls back to the heuristic plan.
    return null;
  }
}