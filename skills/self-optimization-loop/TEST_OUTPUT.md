# Smoke Test Evidence

Local smoke test was run against an equivalent working tree containing the new self-optimization skill and a minimal `auto-test` skill fixture.

## Command sequence

```bash
cd /mnt/data/selfopt
python skills/self-optimization-loop/scripts/log_run.py --skill auto-test --task 'failed related tests' --tool auto-test:test-loop:fail --tests-passed 2 --tests-failed 3 --human-override
python skills/self-optimization-loop/scripts/log_run.py --skill auto-test --task 'failed related tests again' --tool auto-test:test-loop:fail --tests-passed 1 --tests-failed 4
python skills/self-optimization-loop/scripts/log_run.py --skill auto-test --task 'heldout failed tests' --tool auto-test:test-loop:fail --tests-passed 0 --tests-failed 2
python skills/self-optimization-loop/scripts/score_outcome.py --all
python skills/self-optimization-loop/scripts/extract_patterns.py --min-runs 2
python skills/self-optimization-loop/scripts/propose_edit.py --skill auto-test
python skills/self-optimization-loop/scripts/validate_edit.py --proposal skills/self-optimization-loop/data/proposals/<proposal>.json
python skills/self-optimization-loop/scripts/apply_edit.py --proposal skills/self-optimization-loop/data/validated/<proposal>.json --approve
python skills/self-optimization-loop/scripts/apply_edit.py --rollback <version-id>
```

## Exact relevant output

```json
{
  "ok": true,
  "rows": 3,
  "scored": 3,
  "average_score": 0.2958
}
```

```json
{
  "ok": true,
  "patterns": 1
}
```

```json
{
  "ok": true,
  "count": 1
}
```

```json
{
  "ok": true,
  "validation": {
    "status": "validated",
    "held_out_cases": 3,
    "baseline_score": 0.55,
    "proposed_score": 1.0,
    "delta": 0.45,
    "min_delta": 0.03,
    "regressions": 0,
    "max_regressions": 0,
    "passed": true
  }
}
```

```json
{
  "ok": true,
  "applied": {
    "skill": "auto-test",
    "risk": "high",
    "backup_version_id": "version-auto-test-..."
  }
}
```

```json
{
  "ok": true,
  "rolled_back": "auto-test",
  "restored_version": "version-auto-test-..."
}
```

## Note

The first validation run exposed a datetime import bug in `validate_edit.py`; it was fixed and the full smoke cycle was rerun successfully.
