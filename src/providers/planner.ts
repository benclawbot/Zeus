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

const PLANNING_PROMPT = `You are a planning assistant. The user gave an objective to an autonomous coding agent. Break it into 3-7 short subtasks the agent should execute, in execution order.

Rules:
- Each step is a TIGHT LABEL of 2-5 words. Imperative verb + object. No explanations, no clauses, no punctuation at the end.
- Examples of good labels: "Read package.json", "Add SettingsPanel.tsx", "Wire into sidebar", "Run tsc + vitest", "Commit with feat()".
- Do NOT include generic steps like "Understand objective" or "Verify output". Only steps specific to THIS objective.
- Return ONLY a JSON array of strings. No prose, no markdown fences, no commentary.

Example response:
["Read package.json","Add SettingsPanel.tsx","Wire into sidebar","Run tsc + vitest","Commit feat(settings)"]

Objective: `;

const SUBSTANTIVE_MIN_LEN = 24;

/**
 * Produce a compact display label for the Plan panel without changing the
 * full objective sent to the agent. Long specifications are reduced to their
 * opening clause and capped at 13 words / 80 characters.
 */
export function summarizeObjectiveLine(objective: string): string {
  const normalized = objective.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80 && normalized.split(" ").length <= 13) return normalized;
  const openingClause = normalized.split(/[:\n]|\s[—–]\s/)[0]?.trim() || normalized;
  const words = openingClause.split(" ").filter(Boolean);
  let summary = words.slice(0, 13).join(" ");
  if (summary.length > 79) summary = summary.slice(0, 79).replace(/\s+\S*$/, "");
  const wasShortened = summary.length < normalized.length;
  return `${summary.replace(/[.,;:!?]+$/, "")}${wasShortened ? "…" : ""}`;
}

/**
 * Clamp a single step label to ≤5 words and ≤40 chars so the plan
 * panel never ships prose-length bullets. Strips trailing punctuation,
 * collapses internal whitespace, and capitalizes the first letter.
 */
function tightenStep(raw: string): string {
  const cleaned = raw
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:!?]+$/g, "")
    .trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 5);
  let out = words.join(" ");
  if (out.length > 40) out = out.slice(0, 40).replace(/\s+\S*$/, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

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
        return parsed.map((s) => s.trim()).filter((s) => s.length > 0).map(tightenStep);
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
      return parsed.map((s) => s.trim()).filter((s) => s.length > 0).map(tightenStep);
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

const TITLE_SUMMARIZER_PROMPT = `You name coding-agent sessions. Given the user's first message, return a 2-4 word title that captures what they're trying to do.

Rules:
- Imperative or noun-phrase. 2-4 words. No quotes, no period, no preamble.
- Examples: "Fix paste bug", "Add settings panel", "Refactor auth module", "Wire DDG search".
- Return ONLY the title text, nothing else.

User message: `;

/**
 * Clamp the LLM's title to 4 words / 40 chars so the sidebar never
 * ships a sentence-length label. Falls through to a fallback derived
 * from the prompt if the model returns something unusable.
 */
function clampTitle(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[`*_~"']+/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:!?]+$/g, "")
    .trim();
  if (!cleaned) return fallback;
  const words = cleaned.split(" ").filter(Boolean).slice(0, 4);
  let out = words.join(" ");
  if (out.length > 40) out = out.slice(0, 40).replace(/\s+\S*$/, "");
  return out || fallback;
}

/**
 * Summarize the user's first prompt into a short session title. Cheap
 * probe — same model, low temperature, single short reply. Returns
 * null on any failure so the caller can leave the default label alone.
 */
export async function summarizeSessionTitle(
  prompt: string,
  options: Pick<ChatOptions, "provider" | "model" | "baseUrl" | "temperature">,
): Promise<string | null> {
  const trimmed = prompt.trim();
  if (trimmed.length < 4) return null;
  // Fallback derived locally so we always have something sensible even
  // when the LLM probe fails. First meaningful words, capped.
  const fallback = clampTitle(trimmed.split(/\r?\n/)[0], "New session");
  const messages: ChatMessage[] = [
    { role: "system", content: "You name sessions in 2-4 words. Return only the title." },
    { role: "user", content: `${TITLE_SUMMARIZER_PROMPT}"${trimmed.replace(/"/g, '\\"')}"` },
  ];
  try {
    const response = await dispatchChat({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      temperature: options.temperature ?? 0.2,
      messages,
    });
    const text = response.content.trim();
    if (!text) return fallback;
    return clampTitle(text, fallback);
  } catch {
    return fallback;
  }
}
