---
name: 5-why
description: Drill down from symptom to root cause by asking "why" 5 times. Use when "root cause", "5 why", "why is this happening", or troubleshooting issues. Always implement fixes after the analysis.
disable-model-invocation: true
---

# 5 Why Root Cause Analysis

Ask "why" 5 times to drill down from a symptom to its root cause. Each answer becomes the next question.

## Process

1. **State the problem** — The observable issue or bug
2. **Ask Why #1** — Why does this happen?
3. **Ask Why #2** — Why does that happen?
4. **Ask Why #3** — Why does that happen?
5. **Ask Why #4** — Why does that happen?
6. **Ask Why #5** — Why does that happen?
7. **Identify root cause** — The final "why" that, if fixed, eliminates the symptom

## Output Format

```
## Problem Statement
[Clear, specific description of the issue]

## 5 Why Chain

**Why #1:** [Cause identified]
→ **Why #2:** [What causes that]
→ **Why #3:** [What causes that]
→ **Why #4:** [What causes that]
→ **Why #5:** [Root cause]

## Root Cause
[Final root cause statement]

## Recommended Fixes
1. [Actionable fix for root cause]
2. [Additional fixes if multiple root causes found]
```

## Guidelines

- Each "why" should build on the previous answer, not restart the analysis
- Root causes are often process, configuration, or design issues — not people mistakes
- If you reach the same answer twice before Why #5, you've hit a pattern — push deeper
- The fix should address the root cause, not just the symptom

## Implement Step (Required)

**After completing the 5 Why analysis, always implement the fixes identified.**

1. **Create todos** for each fix using the `todo` tool
2. **Execute fixes** — edit files, update config, run commands
3. **Verify** — confirm the fix works before closing the analysis
4. **Update this skill** if the process needs adjustment based on what worked

## When to Stop

Stop at Why #5 even if not fully resolved — we've gone deep enough to identify systemic issues. Further drilling may be analysis paralysis.
