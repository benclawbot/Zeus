/**
 * Spec 05 — Minimal-Code-Generation Skill.
 *
 * A system-prompt block that forces a deliberate minimality check
 * before code generation. The ladder and exemption list come from
 * Spec 05 §3 and §4 verbatim.
 *
 * Critical design choice: the instruction never says "minimize tokens"
 * — only "minimize necessary code". The former produces golfed,
 * unreadable output; the latter produces genuinely smaller diffs.
 *
 * Intensity levels:
 *   - off: no minimality instruction
 *   - lite: ladder steps 1–3 only (safe default for unfamiliar code)
 *   - full: full ladder + exemption list + audit comments
 *   - strict: full + every deviation requires a justification
 */

export type MinimalLevel = "off" | "lite" | "full" | "strict";

/** Exemption list — Spec 05 §4. Never authorize removing these. */
export const MINIMAL_EXEMPTIONS: ReadonlyArray<string> = [
  "input_validation",
  "input_sanitization",
  "authentication",
  "authorization",
  "error_handling",
  "accessibility_attributes",
  "encoding_escaping",
  "secrets_handling",
  "crypto",
  "logging_observability",
  "audit_logging",
];

const OFF_BLOCK = "";

/**
 * `lite` — first three steps of the decision ladder. Skips
 * dependency-reuse and audit comments. Safe for unfamiliar code.
 */
const LITE_BLOCK = `Code-generation discipline — minimal (lite):
Before writing new code, work through these checks in order. Stop at the first "yes":
1. Does this need to exist at all? If the task can be satisfied without new code (a config change, an existing flag, deleting something instead of adding), do that instead.
2. Does the codebase already solve this? Search the codebase first. Reuse an existing utility / component / pattern rather than reimplementing it, even partially.
3. Does the platform / language / runtime already solve this natively? (e.g. a native <input type="date">, a stdlib function, a built-in language feature) — before reaching for a dependency.`;

/**
 * `full` — full ladder + exemption list + audit comments on.
 */
const FULL_BLOCK = `${LITE_BLOCK}
4. Is there an already-installed dependency that solves this? Don't add a new dependency if one already in the project does the job, even if a more specialized package exists.
5. What is the minimal correct implementation? Only past this point should the assistant write new code, and the smallest version that fully satisfies the requirement — not the smallest version that merely looks like it does.

Exemptions — never remove or shortcut:
${MINIMAL_EXEMPTIONS.map((e) => `- ${e}`).join("\n")}

If a minimality check would remove any of the above, keep that code and only minimize the parts around it.

Auditability — when a minimality check causes the assistant to choose a smaller implementation than an unconstrained model might have, leave a one-line trace comment:
// minimal: <reason this is the minimal correct choice>

The comment costs a small number of tokens per instance but pays for itself in review trust.`;

/**
 * `strict` — full + any deviation from the minimal path requires an
 * explicit one-line justification comment, not just the minimal choice.
 */
const STRICT_BLOCK = `${FULL_BLOCK}

Strict mode: any deviation from the minimal correct implementation (choosing a heavier approach, adding a dependency, writing a wrapper around an existing utility) requires an explicit one-line justification:
// heavy: <reason this heavier choice is justified for this case>`;

export function getMinimalCodeInstructions(level: MinimalLevel | string | null | undefined): string {
  switch (level) {
    case "strict":
      return STRICT_BLOCK;
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
      return OFF_BLOCK;
  }
}

export const DEFAULT_MINIMAL_LEVEL: MinimalLevel = "full";
