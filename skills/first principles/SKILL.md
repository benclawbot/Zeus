---
name: first-principles
description: Gate for evaluating an architecture, protocol, or design decision before it gets locked into a spec. Use whenever a spec, ADR, or design doc is about to be finalized, whenever a pattern is being reused because "that's how it's done" rather than because it was re-derived, and whenever a design decision is inherited from a prior project without being re-checked against the current constraints. Do NOT use for routine implementation, bug fixes, or small refactors — this is for decisions with multi-week or architectural blast radius.
---

# First Principles Gate

A forcing function that separates hard constraints from inherited convention before a design gets written down as final.

## When to run this

- Before an ADR / spec section is marked "decided"
- When a pattern is copied from a previous project without re-justifying it in the new context
- When the reasoning for a choice is "it's the standard approach" and nothing more specific
- When a design feels expensive, slow, or awkward but is being kept because rewriting it feels risky

Skip this for anything reversible in under a day of work — the gate has a cost, only pay it for decisions that are expensive to undo.

## The method

1. **State the actual goal, stripped of implementation language.**
   Not "we need a message queue" — "agent A's output needs to be available to agent B before B's next step, with at-least-once delivery." Naming a component instead of a requirement is the first place assumptions hide.

2. **List every assumption the current/proposed design bakes in.**
   Be exhaustive even about things that feel obvious. For each one, tag it:
   - **Hard constraint** — physics, math, a protocol spec, a regulation (e.g. Swiss FINMA data residency, GDPR), a proven impossibility result.
   - **Soft constraint** — convention, "how the last project did it," a library's default, team familiarity, a framework's opinion.

   If you can't tell which bucket something belongs in, that's a signal to check rather than guess — inherited patterns often get treated as hard constraints they never were.

3. **Rebuild from the hard constraints only.**
   Ignore precedent entirely for this step. What is the simplest thing that satisfies only the hard constraints? This is deliberately naive — it's a reference point, not a final answer.

4. **Reintroduce soft constraints one at a time, and require a reason for each.**
   For every soft constraint you add back, name the concrete cost of dropping it (team velocity, operational risk, time-to-ship) — not just "it's standard." If you can't name a concrete cost, drop it.

5. **Compare the rebuilt design against the original.**
   Output a verdict:
   - **Keep as-is** — every soft constraint earned its place.
   - **Simplify** — some soft constraints didn't survive step 4; cut them.
   - **Rebuild** — the original design was carrying assumptions from a different context (different scale, different regulatory environment, different team) that don't hold here.

## Output format

Always render as a table, then a one-line verdict. Keep it short — this is a gate, not an essay.

| Assumption | Hard / Soft | Why it's held | If dropped |
|---|---|---|---|
| ... | ... | ... | ... |

**Verdict:** Keep / Simplify / Rebuild — one sentence why.

## Calibration notes

- The point isn't to always rebuild — most of the time step 5 says "keep as-is" and that's a good outcome, it just means the design was already sound and you now know *why*, which is worth having on record in the spec/ADR.
- Watch for the specific failure mode of re-deriving a justification for a decision you'd already emotionally committed to. If every soft constraint in step 4 "survives," be suspicious — go back and argue the other side for at least one of them before finalizing.
- Cross-project carryover is the highest-value place to apply this: patterns from existing projects were derived under a specific set of constraints (team size, deployment target, regulatory scope). Hermes and iAgent don't automatically share those constraints — on-prem regulated-industry deployment and an ambient Windows agent have different hard constraints from each other and from whatever came before.
