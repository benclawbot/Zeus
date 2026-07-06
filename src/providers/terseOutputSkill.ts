/**
 * Spec 04 — Terse-Output Skill.
 *
 * A system-prompt block that materially shortens the model's *output*
 * while guaranteeing zero loss of technical fidelity (code, paths,
 * error text, and numbers must remain byte-exact).
 *
 * This module exposes the instruction text for each intensity level
 * (off / lite / full / ultra) plus the unified "never compress" list
 * shared across the whole token-efficiency toolkit (README principle
 * #2 in the spec set).
 *
 * The block is injected into the next chat call as part of the system
 * prompt — see `getTerseOutputInstructions(level)` for the entry point.
 */

export type TerseLevel = "off" | "lite" | "full" | "ultra";

/** Items that must NEVER be compressed at any level. */
export const NEVER_COMPRESS: ReadonlyArray<string> = [
  "code_blocks",
  "file_paths",
  "urls",
  "hashes",
  "version_strings",
  "error_messages",
  "stack_traces",
  "safety_warnings",
];

const OFF_BLOCK = "";

/**
 * `lite` — drop preamble and pleasantries only. Explanations still
 * allowed. Cheapest level that produces any savings; safe for any
 * context including user-facing chat.
 */
const LITE_BLOCK = `Response style — terse (lite):
- Skip preamble ("Great question!", "I'd be happy to help", "Let's dive in").
- No recap / summary at the end unless asked.
- State the answer first; explain only when the reasoning isn't obvious from the answer itself.`;

/**
 * `full` — the default. Full instruction set. The original Spec 04
 * §3 instruction set, verbatim and intact.
 */
const FULL_BLOCK = `Response style — terse mode:
- Answer the question. Do not restate it.
- No preamble ("Great question!", "I'd be happy to help", "Let's dive in").
- No summary/recap after the answer unless asked for one.
- State the fix/answer first; explain only if the reasoning isn't obvious from the fix itself.
- Prefer a single sentence over a paragraph. Prefer a fragment over a sentence, where grammatical completeness isn't needed for clarity.
- Do not offer alternative approaches unless asked, unless the direct answer to what was asked is unsafe or incorrect.
- Never invent or restate information that's byte-exact in what follows: code blocks, file paths, commands, error messages, numeric values, and identifiers must be reproduced exactly, with no compression applied to them.
- If the honest answer is long (a genuinely multi-step process, a nuanced tradeoff), say so and give the long answer — terseness is a default posture, not a hard cap that degrades correctness.`;

/**
 * `ultra` — full + no connective prose in non-code explanation text.
 * Best for high-frequency automated agent-to-agent turns rather than
 * user-facing chat.
 */
const ULTRA_BLOCK = `${FULL_BLOCK}
- In non-code explanation text, drop articles and connective prose where the meaning survives. Reduce answers to the minimum grammatically-necessary form.`;

/**
 * Look up the instruction block for a given intensity level. Returns
 * an empty string for "off" so the caller can simply concat it.
 */
export function getTerseOutputInstructions(level: TerseLevel | string | null | undefined): string {
  switch (level) {
    case "ultra":
      return ULTRA_BLOCK;
    case "full":
      return FULL_BLOCK;
    case "lite":
      return LITE_BLOCK;
    case "off":
    case "":
    case null:
    case undefined:
      return OFF_BLOCK;
    default:
      // Unknown level — fail open to a no-op rather than guessing the
      // caller's intent.
      return OFF_BLOCK;
  }
}

/** Default level if the user hasn't picked one. */
export const DEFAULT_TERSE_LEVEL: TerseLevel = "full";

/** Sub-skills (Spec 04 §5) — same principle, narrower scope. */
export const TERSE_SUB_SKILLS = {
  commitMessages: {
    id: "commit-messages",
    label: "Commit-message mode",
    body: `Commit-message mode: write a single-line conventional-commit subject under 50 chars. Body is optional and only included when the change genuinely needs explanation.`,
  },
  reviewComments: {
    id: "review-comments",
    label: "Review-comment mode",
    body: `Review-comment mode: one issue per comment, single line, no restating the code being commented on.`,
  },
  memoryFileCompression: {
    id: "memory-file-compression",
    label: "Memory-file compression mode",
    body: `Memory-file compression mode: rewrite a persistent instruction / memory file into a denser but still parseable form — remove connective prose while preserving every directive, constraint, and identifier. The savings compound because the file is read on every session start.`,
  },
} as const;
