---
name: self-optimization-loop
description: Production self-optimization loop for Pi Agent Optimus. Logs run outcomes, scores them, detects failure patterns, proposes skill edits, validates edits against held-out cases, versions accepted changes, and applies only low-risk validated edits automatically. Use when optimizing skills, reviewing agent performance, detecting repeated failures, validating skill edits, approving proposals, or rolling back a skill version.
allowed-tools: Read,Bash,write,edit,execute_command
---

# Self-Optimization Loop

This skill closes the agent improvement loop without blind self-editing:

```
run event -> outcome score -> pattern extraction -> concrete proposal
-> held-out A/B validation -> risk gate -> apply or approval queue
-> versioned rollback record
```

## Core Rules

1. **Log first, change later.** Every improvement must be traceable to run evidence.
2. **Never optimize from one signal.** Combine tests, tool failures, human correction, explicit rating, latency, and cost when available.
3. **Diagnose likely cause before editing.** A proposal must name the suspected failure mode, not just the symptom.
4. **Use held-out validation.** Do not apply a proposal unless it beats the baseline on examples not used to derive the pattern.
5. **Version every applied edit.** Every changed `SKILL.md` gets a restorable snapshot and metric record.
6. **Auto-apply only low-risk edits.** Routing, permissions, structural flow, tool access, and safety changes require explicit approval.

## Commands

Run these from the repository root or from the installed skill directory.

### Log a run

```bash
python skills/self-optimization-loop/scripts/log_run.py \
  --skill auto-test \
  --task "run related tests for changed Python file" \
  --tool auto-test:test-loop:ok \
  --tests-passed 12 \
  --tests-failed 0
```

### Score pending unscored runs

```bash
python skills/self-optimization-loop/scripts/score_outcome.py
```

### Extract patterns

```bash
python skills/self-optimization-loop/scripts/extract_patterns.py --min-runs 5
```

### Propose an edit

```bash
python skills/self-optimization-loop/scripts/propose_edit.py --skill auto-test
```

### Validate a proposal

```bash
python skills/self-optimization-loop/scripts/validate_edit.py --proposal data/proposals/<proposal-id>.json
```

### Apply approved/low-risk edit

```bash
python skills/self-optimization-loop/scripts/apply_edit.py --proposal data/validated/<proposal-id>.json --approve
```

### Roll back an applied edit

```bash
python skills/self-optimization-loop/scripts/apply_edit.py --rollback <version-id>
```

## Data Files

```
skills/self-optimization-loop/
├── SKILL.md
├── scripts/
│   ├── core.py
│   ├── log_run.py
│   ├── score_outcome.py
│   ├── extract_patterns.py
│   ├── propose_edit.py
│   ├── validate_edit.py
│   └── apply_edit.py
├── data/
│   ├── run_log.jsonl
│   ├── pattern_report.json
│   ├── proposals/
│   ├── validated/
│   └── versions/
└── references/
    └── SCHEMA.md
```

## Outcome Model

The scorer emits this normalized outcome:

```json
{
  "passed": true,
  "score": 0.91,
  "confidence": 0.86,
  "signals": {
    "tests": 1.0,
    "tool_success": 1.0,
    "human_override": 1.0,
    "explicit_rating": null,
    "cost_latency": 0.65
  },
  "root_cause": "none",
  "explanation": "Tests passed and no override was recorded."
}
```

## Risk Model

| Risk | Examples | Apply behavior |
|---|---|---|
| low | wording clarification, extra checklist item, better example, tighter output contract | auto-apply only after held-out pass |
| medium | step ordering, new validation command, changed scoring thresholds | approval required |
| high | allowed-tools, routing, auto-execution, safety boundaries, deletion behavior | approval required and should be reviewed manually |

## Validation Gate

A proposal must pass all gates:

1. Proposed skill content parses.
2. Target `SKILL.md` stays within size limit.
3. Risk classifier does not label auto-apply edits as medium/high.
4. Held-out score improves over baseline by `--min-delta` (default `0.03`).
5. Regression rate does not exceed `--max-regressions` (default `0`).
6. The proposal includes rollback metadata.

## Integration Points

- `skill-evolution`: consumes validated proposals instead of editing blindly.
- `improvement-tracker`: consumes `data/pattern_report.json`.
- `task-continuity` and `decision-tracker`: should call `log_run.py` after task completion.
- `scheduler`: should call `extract_patterns.py` nightly.
- `auto-test`, `ci-watcher`, and `project-health`: can pass test/CI outcomes directly to `log_run.py`.

## Recommended Nightly Job

```bash
python skills/self-optimization-loop/scripts/score_outcome.py
python skills/self-optimization-loop/scripts/extract_patterns.py --min-runs 5
python skills/self-optimization-loop/scripts/propose_edit.py --all-skills
```

Do not schedule `apply_edit.py` without a separate approval policy.
