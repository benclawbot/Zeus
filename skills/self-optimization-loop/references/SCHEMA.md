# Self-Optimization Loop Schemas

## Run Log (`data/run_log.jsonl`)

Each line is one JSON object.

```json
{
  "run_id": "run-20260704120000-abcd1234",
  "timestamp": "2026-07-04T12:00:00Z",
  "skill_used": "auto-test",
  "task_summary": "run related tests for changed Python file",
  "tool_calls": [
    {"tool": "auto-test", "operation": "test-loop", "result_ok": true}
  ],
  "tests_passed": 12,
  "tests_failed": 0,
  "human_override": false,
  "explicit_rating": 0.9,
  "latency_ms": 42000,
  "cost_usd": 0.02,
  "files_touched": ["src/example.py"],
  "error": null,
  "metadata": {},
  "outcome": null
}
```

## Outcome

`score_outcome.py` fills the `outcome` field.

```json
{
  "passed": true,
  "score": 0.91,
  "confidence": 0.86,
  "signals": {
    "tests": 1.0,
    "tool_success": 1.0,
    "human_override": 1.0,
    "explicit_rating": 0.9,
    "cost_latency": 0.65
  },
  "root_cause": "none",
  "explanation": "score=0.91; root_cause=none",
  "scored_at": "2026-07-04T12:01:00Z"
}
```

## Pattern Report (`data/pattern_report.json`)

```json
{
  "generated_at": "2026-07-04T12:10:00Z",
  "rows_analyzed": 100,
  "patterns": [
    {
      "pattern_id": "auto-test:test_failure",
      "skill_used": "auto-test",
      "root_cause": "test_failure",
      "run_count": 12,
      "failure_count": 5,
      "average_score": 0.61,
      "confidence": 0.82,
      "top_tool_sequences": [["auto-test:test-loop:False", 5]],
      "example_run_ids": ["run-..."],
      "recommendation": "Add validation and evidence capture for test_failure."
    }
  ]
}
```

## Proposal (`data/proposals/*.json`)

```json
{
  "proposal_id": "proposal-auto-test-20260704121000-abcd1234",
  "created_at": "2026-07-04T12:10:00Z",
  "target_skill": "auto-test",
  "target_path": "skills/auto-test/SKILL.md",
  "pattern": {},
  "risk": "medium",
  "auto_apply_eligible": false,
  "rationale": "Added structured telemetry and root-cause guardrails.",
  "original_sha256": "...",
  "proposed_sha256": "...",
  "diff": "--- a/...",
  "proposed_content": "...",
  "status": "proposed",
  "rollback": {"strategy": "restore pre-apply version snapshot"}
}
```

## Validation Record

```json
{
  "status": "validated",
  "validated_at": "2026-07-04T12:15:00Z",
  "held_out_cases": 7,
  "baseline_score": 0.62,
  "proposed_score": 0.86,
  "delta": 0.24,
  "min_delta": 0.03,
  "regressions": 0,
  "max_regressions": 0,
  "passed": true
}
```

## Version Metadata (`data/versions/<version-id>/metadata.json`)

```json
{
  "version_id": "version-auto-test-20260704122000-abcd1234",
  "skill": "auto-test",
  "created_at": "2026-07-04T12:20:00Z",
  "reason": "pre-apply snapshot",
  "proposal_id": "proposal-auto-test-...",
  "sha256": "..."
}
```
