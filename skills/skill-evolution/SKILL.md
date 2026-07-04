---
name: skill-evolution
description: Captures usage feedback and improves skills based on experience. Use when "learn from this", "improve this skill", "capture this pattern", "remember what worked", or after discovering effective approaches. Monitors skill effectiveness, stores lessons, and suggests updates.
allowed-tools: Read,Bash,execute_command,write,todo
disable-model-invocation: true
---

# Skill Evolution

Captures lessons learned during work and improves skills over time through structured feedback.

## Core Concept

Skills improve through a **feedback loop**:
```
Work → Observe → Capture → Review → Update
```

This skill makes that loop explicit and low-friction.

## Usage

| Trigger | Action |
|---------|--------|
| "learn from this" | Capture current session insights |
| "improve this skill" | Analyze and suggest skill updates |
| "remember what worked" | Store successful pattern |
| "capture this" | Quick note to memory |
| End of session | Automatic improvement summary |

## Memory Structure

All learned patterns go to `.pi/skill-memory.json`:

```json
{
  "lessons": [
    {
      "id": "uuid",
      "skill": "context-memory",
      "pattern": "Store 'why' with every architectural decision",
      "context": "User kept forgetting why certain choices were made",
      "success": true,
      "timestamp": "2026-04-25T10:00:00Z"
    }
  ],
  "gaps": [
    {
      "id": "uuid",
      "skill": "frontend-design",
      "gap": "No guidance on responsive breakpoints",
      "suggestion": "Add reference for common breakpoint values",
      "priority": "medium"
    }
  ],
  "patterns": [
    {
      "id": "uuid",
      "skill": "commit",
      "pattern": "Use present tense in commit subject",
      "example": "Add login validation" not "Added login validation",
      "confidence": "high"
    }
  ]
}
```

## Commands

### Capture Learning

When you say "learn from this" or similar:

1. Create/update `.pi/skill-memory.json`
2. Determine category: `lessons`, `gaps`, or `patterns`
3. Extract key insight with context
4. Update the relevant section

Example flow:
```
User: "learn from this - when doing async work, always chain promises explicitly"
→ Add to patterns:
{
  "skill": "general",
  "pattern": "Chain promises explicitly for async operations",
  "example": "doThing().then(doNext).catch(handleError)",
  "confidence": "high"
}
```

### Suggest Improvements

When you say "improve this skill" or "what should change":

1. Read `.pi/skill-memory.json`
2. Group entries by target skill
3. For each skill with lessons/patterns:
   - Summarize accumulated wisdom
   - Identify missing coverage (gaps)
   - Suggest specific updates to SKILL.md or references
4. Output formatted suggestions

Output format:
```markdown
## Skill: <name>

### Lessons Learned
- <lesson 1>
- <lesson 2>

### Patterns to Codify
| Pattern | When to Use |
|---------|-------------|
| <pattern> | <trigger> |

### Gaps to Fill
- <gap> → <suggestion>

### Recommended Changes
1. Add to SKILL.md: ...
2. Create references/<topic>.md: ...
```

### Review for Updates

Run weekly or when you want to refresh skills:

```bash
# List skills with accumulated learning
# Read skill-memory.json and cross-reference with actual skills
```

## Improvement Criteria

| Category | Criteria | Action |
|----------|----------|--------|
| Lesson | Confirmed success in 3+ contexts | Add to skill patterns |
| Gap | Mentioned twice | Suggest documentation |
| Gap | Hindering work | Prioritize fix |
| Pattern | High confidence + repeated | Codify in skill |
| Anti-pattern | Discovered failure | Add to "Gotchas" section |

## Skill Self-Reference

This skill evolves itself:
- When it works well → capture the pattern
- When it misses context → log a gap
- When it confuses you → note the confusion

The feedback loop applies to this skill too.

## Validation

Before closing a session where you learned something:
1. Check for `.pi/skill-memory.json`
2. Add any new insights
3. If significant progress on a skill, suggest improvements

This keeps memory current without end-of-session crunch.
