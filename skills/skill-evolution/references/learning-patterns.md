# Learning Capture Patterns

## When to Capture

### High-Value Moments
- A workaround that saved time
- An unexpected behavior discovered
- A pattern that worked better than expected
- A mistake that caused confusion
- A gap in current skills revealed

### Low-Value Moments
- Routine actions with no insight
- Standard patterns already documented
- Unsuccessful experiments (unless instructive as anti-patterns)

## What to Capture

### Good Entry
```json
{
  "skill": "commit",
  "pattern": "Use imperative mood in commit subject",
  "example": "Fix login validation" not "Fixes login validation",
  "confidence": "high"
}
```

### Poor Entry
```json
{
  "skill": "git",
  "pattern": "Use git",
  "confidence": "low"
}
```

## Capturing Context

Context makes patterns reusable:

| Without Context | With Context |
|-----------------|--------------|
| "Use Effect for async" | "Use Effect for service layer, not for simple state" |
| "Avoid default exports" | "Avoid default exports for better refactoring" |
| "Test early" | "Test before first commit, not after" |

## Confidence Levels

| Level | When to Use | Action |
|-------|-------------|--------|
| high | 3+ successful uses | Codify in skill |
| medium | 1-2 uses | Store, monitor |
| low | Single observation | Note, verify later |

## Gap Priority

| Priority | Trigger | Action |
|----------|---------|--------|
| high | Blocking work | Fix immediately |
| medium | Mentioned 2+ times | Add to skill soon |
| low | Single mention | Document when time allows |

## Skill Categories

Default skill assignments:

| Task | Default Skill |
|------|---------------|
| Code patterns | `general` |
| Git practices | `commit` |
| Project conventions | `context-memory` |
| Workflow tips | `skill-evolution` (this skill) |
| Testing approaches | `test-runner` |
| Frontend choices | `frontend-design` |
| Tooling setup | `cmux` |

Create new skill entries as needed — don't force everything into existing categories.
