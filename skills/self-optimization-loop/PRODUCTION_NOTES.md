# Production Notes

## What this skill adds

`self-optimization-loop` upgrades the current harness from manual skill learning to evidence-based improvement:

1. Logs every relevant agent run as JSONL.
2. Scores outcomes from multiple signals instead of one proxy.
3. Tags likely root causes such as test failures, tool failures, rework, low ratings, runtime errors, and slow/expensive runs.
4. Extracts repeated patterns by skill and root cause.
5. Generates concrete `SKILL.md` diffs rather than vague suggestions.
6. Validates proposed edits against held-out cases not used to derive the pattern.
7. Classifies edit risk and blocks medium/high-risk changes unless explicitly approved.
8. Snapshots the previous skill version before apply.
9. Supports rollback by version id.

## Production boundaries

The held-out evaluator is deterministic and dependency-free. It is deliberately conservative and checks whether the proposed skill text adds operational guidance mapped to the observed failure cause. For full LLM replay, connect provider-backed transcript replay later; the current design avoids requiring API keys or model-specific dependencies during install.

## Recommended harness integration

Call `log_run.py` at the end of each task from `task-continuity`, `decision-tracker`, `auto-test`, `project-health`, and `ci-watcher`.

Nightly:

```bash
python ~/.pi/agent/skills/self-optimization-loop/scripts/score_outcome.py
python ~/.pi/agent/skills/self-optimization-loop/scripts/extract_patterns.py --min-runs 5
python ~/.pi/agent/skills/self-optimization-loop/scripts/propose_edit.py --all-skills
```

Manual apply flow:

```bash
python ~/.pi/agent/skills/self-optimization-loop/scripts/validate_edit.py --proposal data/proposals/<id>.json
python ~/.pi/agent/skills/self-optimization-loop/scripts/apply_edit.py --proposal data/validated/<id>.json --approve
```

Rollback:

```bash
python ~/.pi/agent/skills/self-optimization-loop/scripts/apply_edit.py --rollback <version-id>
```
