---
name: todo-update
description: Update and close todos with automatic summary. Use when "close todo", "done with todo", "mark complete", "update todo status", or finishing a todo task.
disable-model-invocation: true
---

# Todo Update

Close or update a todo with an automatic summary of work done.

## When to Use

- After completing a todo — generate a summary of what was done
- When a todo's status needs to change (open → closed, in-progress → blocked, etc.)
- When appending final notes or completion details to a todo

## Steps

### 1. Get Current Todo State

Use `todo(action: "get", id: "<todo-id>")` to read the current todo state before modifying it.

### 2. Generate Summary

If closing a todo, generate a concise summary of what was accomplished:

- What was the original goal?
- What changed?
- Any files created/modified? (use `git diff` if in a repo)
- Acceptance criteria met?

### 3. Update the Todo

**To close a todo:**
```
todo(action: "update", id: "<todo-id>", status: "closed", body: "<summary>")
```

**To update status or tags:**
```
todo(action: "update", id: "<todo-id>", status: "<new-status>", tags: ["tag1", "tag2"])
```

**To append additional notes:**
```
todo(action: "append", id: "<todo-id>", body: "<additional notes>")
```

### 4. Release Assignment (if claimed)

If the todo was claimed by your session, release it:
```
todo(action: "release", id: "<todo-id>")
```

## Summary Format

When closing, include in the body:

```markdown
## Summary
- Completed: <what was done>
- Files: <list relevant files>
- Result: <outcome>

## Acceptance Criteria
- [x] <criterion 1>
- [x] <criterion 2>
```

## Example

```
# Close todo with summary
todo(action: "get", id: "TODO-abc12345")
# → Review what was done from the todo body
todo(action: "update", id: "TODO-abc12345", status: "closed", body: "## Summary\n- Created new skill structure\n- Files: skills/new-skill/SKILL.md\n- Result: Skill validated and ready\n\n## Acceptance Criteria\n- [x] Skill follows conventions")
```