# Review Checklist

## What changed and why

Added a new `self-optimization-loop` skill that gives the harness a real improvement pipeline: logging, scoring, pattern mining, proposal generation, validation, safe apply, version snapshots, and rollback.

## Alternatives rejected

1. Only adding the original spec as documentation: rejected because it would not improve the harness at runtime.
2. A skeleton implementation: rejected because the goal is a usable production loop.
3. Auto-merging every generated edit: rejected because it risks behavior drift and hidden regressions.
4. LLM-only judging: rejected for the first production version because it requires provider credentials and can be gamed.
5. Editing existing skills immediately: rejected because the loop should first collect evidence and validate proposals.

## Tests run

See `TEST_OUTPUT.md` for the smoke flow and exact output.

## Risk level / blast radius

Risk: medium.

Blast radius is limited because this adds a new skill and registers it in `settings.json`. It does not mutate existing skills unless `apply_edit.py` is explicitly run against a validated proposal. Medium/high-risk proposals require `--approve`.

## Files touched and why each matters

- `settings.json`: registers the new skill so it installs/loads with the harness.
- `skills/self-optimization-loop/SKILL.md`: user-facing skill instructions and command contract.
- `skills/self-optimization-loop/scripts/core.py`: production engine implementing the loop.
- `skills/self-optimization-loop/scripts/*.py`: stable command entrypoints matching the spec.
- `skills/self-optimization-loop/references/SCHEMA.md`: data contract for logs, outcomes, patterns, proposals, validation, and versions.
- `skills/self-optimization-loop/PRODUCTION_NOTES.md`: operational guidance and integration boundaries.
- `skills/self-optimization-loop/TEST_OUTPUT.md`: smoke-test evidence.
- `skills/self-optimization-loop/data/**/.gitkeep`: keeps runtime queues/version directories present after install.

## Known uncertainty

The held-out evaluator is deterministic and dependency-free. It is useful immediately, but it is not a full model-provider replay engine. The next improvement would be to connect transcript replay through the existing provider layer once run transcripts are available.

## Rollback plan

1. Remove `~/.pi/agent/skills/self-optimization-loop` from installed skills, or remove the skill path from `settings.json`.
2. Revert the merge commit in GitHub if needed.
3. For any skill edited by `apply_edit.py`, run:

```bash
python ~/.pi/agent/skills/self-optimization-loop/scripts/apply_edit.py --rollback <version-id>
```
