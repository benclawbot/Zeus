#!/usr/bin/env python3
"""Production self-optimization engine for Pi Agent Optimus.

Dependency-free CLI engine for: run logging, outcome scoring, pattern extraction,
proposal generation, held-out validation, safe application, version snapshots, and rollback.
"""
from __future__ import annotations

import argparse, collections, datetime as dt, difflib, hashlib, json, uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ISO = "%Y-%m-%dT%H:%M:%SZ"
MAX_SKILL_BYTES = 16 * 1024


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime(ISO)


def new_id(prefix: str) -> str:
    return f"{prefix}-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:8]}"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def root(start: Optional[Path] = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    for p in [cur, *cur.parents]:
        if (p / "settings.json").exists() and (p / "skills").exists():
            return p
    return cur


def safe(r: Path, *parts: str) -> Path:
    p = r.joinpath(*parts).resolve()
    try:
        p.relative_to(r.resolve())
    except ValueError as exc:
        raise SystemExit(f"Unsafe path: {p}") from exc
    return p


def self_dir(r: Path) -> Path:
    return safe(r, "skills", "self-optimization-loop")


def data(r: Path) -> Path:
    d = self_dir(r) / "data"
    for x in [d, d / "proposals", d / "validated", d / "versions"]:
        x.mkdir(parents=True, exist_ok=True)
    return d


def run_log(r: Path) -> Path:
    return data(r) / "run_log.jsonl"


def txt(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def write(p: Path, s: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    t = p.with_suffix(p.suffix + ".tmp")
    t.write_text(s, encoding="utf-8")
    t.replace(p)


def read_json(p: Path, default=None):
    return json.loads(txt(p)) if p.exists() else default


def write_json(p: Path, obj: Any) -> None:
    write(p, json.dumps(obj, indent=2, sort_keys=True) + "\n")


def read_jsonl(p: Path) -> List[Dict[str, Any]]:
    if not p.exists():
        return []
    out = []
    for i, line in enumerate(txt(p).splitlines(), 1):
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Invalid JSONL {p}:{i}: {exc}") from exc
    return out


def write_jsonl(p: Path, rows: Iterable[Dict[str, Any]]) -> None:
    write(p, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))


def append_jsonl(p: Path, row: Dict[str, Any]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")


def parse_tool(s: str) -> Dict[str, Any]:
    parts = s.split(":")
    ok = True
    if parts[-1].lower() in {"fail", "failed", "false", "error"}: ok = False
    if parts[-1].lower() in {"ok", "pass", "true", "success"}: ok = True
    return {"tool": parts[0], "operation": parts[1] if len(parts) > 1 else None, "result_ok": ok}


def norm(v):
    if v is None: return None
    return max(0.0, min(1.0, float(v)))


def weighted(items: Sequence[Tuple[Optional[float], float]]) -> Tuple[float, float]:
    total = weight = 0.0
    for val, w in items:
        if val is not None:
            total += val * w; weight += w
    if not weight: return 0.5, 0.2
    return total / weight, min(1.0, 0.2 + weight / sum(w for _, w in items))


def score_row(row: Dict[str, Any]) -> Dict[str, Any]:
    tp, tf = row.get("tests_passed"), row.get("tests_failed")
    tests = None
    if tp is not None or tf is not None:
        tp, tf = int(tp or 0), int(tf or 0); tests = tp / max(tp + tf, 1)
    tools = row.get("tool_calls") or []
    tool_signal = sum(1 for t in tools if t.get("result_ok") is True) / len(tools) if tools else None
    override = 0.0 if row.get("human_override") else 1.0 if row.get("human_override") is not None else None
    rating = row.get("explicit_rating")
    rating = norm(float(rating) / 5.0 if rating is not None and float(rating) > 1 else rating)
    penalties = []
    if row.get("latency_ms") is not None: penalties.append(max(0.0, 1 - float(row["latency_ms"]) / 600000.0))
    if row.get("cost_usd") is not None: penalties.append(max(0.0, 1 - float(row["cost_usd"]) / 1.0))
    budget = sum(penalties) / len(penalties) if penalties else None
    signals = {"tests": tests, "tool_success": tool_signal, "human_override": override, "explicit_rating": rating, "cost_latency": budget}
    score, confidence = weighted([(tests,.35),(tool_signal,.20),(override,.25),(rating,.15),(budget,.05)])
    cause = "none"
    if tests is not None and tests < 1: cause = "test_failure"
    elif tool_signal is not None and tool_signal < 1: cause = "tool_failure"
    elif override == 0: cause = "user_correction_or_rework"
    elif rating is not None and rating < .6: cause = "low_user_rating"
    elif budget is not None and budget < .5: cause = "slow_or_expensive_run"
    elif row.get("error"): cause = "runtime_error"
    return {"passed": bool(score >= .75 and cause == "none"), "score": round(score,4), "confidence": round(confidence,4), "signals": signals, "root_cause": cause, "explanation": f"score={score:.2f}; root_cause={cause}", "scored_at": now()}


def skill_md(r: Path, skill: str) -> Path:
    p = safe(r, "skills", skill, "SKILL.md")
    if not p.exists(): raise SystemExit(f"Missing target skill: {p}")
    return p


def diff(old: str, new: str, path: str) -> str:
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"a/{path}", f"b/{path}"))


def risk(diff_text: str) -> str:
    added = "\n".join(line[1:] for line in diff_text.splitlines() if line.startswith("+") and not line.startswith("+++")) .lower()
    if any(x in added for x in ["allowed-tools", "credential", "secret", "rm -rf", "delete", "permission", "safety", "security"]): return "high"
    if any(x in added for x in ["routing", "trigger", "scheduler", "execute", "approval", "threshold", "tool"]): return "medium"
    return "low"


def proposal_text(original: str, pattern: Dict[str, Any]) -> Tuple[str, str]:
    heading = "## Self-Optimization Guardrails"
    cause = pattern.get("root_cause", "unknown")
    skill = pattern.get("skill_used", "unknown")
    block = f"""
{heading}

When this skill participates in a run, emit structured evidence for `self-optimization-loop`.

Required evidence:
1. Record task summary, files touched, tool calls, test/build/lint result, and user correction/rejection status.
2. If a failure resembles `{cause}`, tag that likely root cause instead of recording a generic failure.
3. Include the command or check that validates the result.
4. Prefer small reversible changes and keep rollback obvious.
5. Do not treat silence as success; increase confidence only from tests, explicit approval, or lack of immediate correction.

Observed insertion context:
- skill: `{skill}`
- likely root cause: `{cause}`
- failed/low-confidence runs: {pattern.get('failure_count', 0)}
- average score: {pattern.get('average_score', 'unknown')}
"""
    if heading.lower() in original.lower():
        return original.rstrip() + f"\n\n- Self-optimization note ({now()}): repeated `{cause}` outcomes observed; validate future edits against held-out cases.\n", "Added targeted self-optimization note for repeated failure mode."
    return original.rstrip() + "\n\n" + block.strip() + "\n", "Added structured telemetry and root-cause guardrails."


def proxy_eval(text: str, cases: Sequence[Dict[str, Any]]) -> float:
    if not cases: return 0.0
    lower = text.lower(); total = 0.0
    for case in cases:
        cause = str((case.get("outcome") or {}).get("root_cause") or "").lower().replace("_", " ")
        s = .45
        if "outcome" in lower or "self-optimization" in lower: s += .1
        if "root cause" in lower or "root-cause" in lower: s += .15
        if "test" in lower or "validation" in lower or "held-out" in lower: s += .1
        if cause and cause in lower.replace("_", " "): s += .15
        if "rollback" in lower or "reversible" in lower: s += .05
        total += min(1.0, s)
    return round(total / len(cases), 4)


def snapshot(r: Path, skill: str, content: str, meta: Dict[str, Any]) -> Dict[str, Any]:
    vid = new_id(f"version-{skill}")
    d = data(r) / "versions" / vid; d.mkdir(parents=True, exist_ok=True)
    write(d / "SKILL.md", content)
    m = {**meta, "version_id": vid, "skill": skill, "created_at": now(), "sha256": sha(content)}
    write_json(d / "metadata.json", m)
    return m


def cmd_log(args) -> int:
    r = root(Path(args.root)) if args.root else root()
    row = {"run_id": args.run_id or new_id("run"), "timestamp": now(), "skill_used": args.skill, "task_summary": args.task, "tool_calls": [parse_tool(t) for t in args.tool], "tests_passed": args.tests_passed, "tests_failed": args.tests_failed, "human_override": bool(args.human_override), "explicit_rating": args.explicit_rating, "latency_ms": args.latency_ms, "cost_usd": args.cost_usd, "files_touched": args.files_touched, "error": args.error, "metadata": json.loads(args.metadata_json) if args.metadata_json else {}, "outcome": None}
    append_jsonl(run_log(r), row)
    print(json.dumps({"ok": True, "run_id": row["run_id"], "path": str(run_log(r))}, indent=2)); return 0


def cmd_score(args) -> int:
    r = root(Path(args.root)) if args.root else root(); rows = read_jsonl(run_log(r)); n = 0
    for row in rows:
        if args.all or row.get("outcome") is None: row["outcome"] = score_row(row); n += 1
    write_jsonl(run_log(r), rows)
    avg = sum((x.get("outcome") or {}).get("score",0) for x in rows) / max(len(rows),1)
    print(json.dumps({"ok": True, "rows": len(rows), "scored": n, "average_score": round(avg,4), "path": str(run_log(r))}, indent=2)); return 0


def cmd_patterns(args) -> int:
    r = root(Path(args.root)) if args.root else root(); rows = [x for x in read_jsonl(run_log(r)) if x.get("outcome")]
    groups = collections.defaultdict(list)
    for row in rows: groups[(row.get("skill_used","unknown"), row["outcome"].get("root_cause","unknown"))].append(row)
    pats = []
    for (skill,cause), items in groups.items():
        if len(items) < args.min_runs: continue
        avg = sum(i["outcome"].get("score",0) for i in items)/len(items); fails=[i for i in items if not i["outcome"].get("passed")]
        if not fails and avg >= .85: continue
        tools = collections.Counter()
        for it in fails or items:
            for t in it.get("tool_calls") or []: tools[f"{t.get('tool')}:{t.get('operation')}:{t.get('result_ok')}"] += 1
        pats.append({"pattern_id": f"{skill}:{cause}", "skill_used": skill, "root_cause": cause, "run_count": len(items), "failure_count": len(fails), "average_score": round(avg,4), "confidence": round(sum(i["outcome"].get("confidence",0) for i in items)/len(items),4), "top_tool_sequences": tools.most_common(5), "example_run_ids": [i.get("run_id") for i in items[:5]], "recommendation": f"Add validation and evidence capture for {cause}."})
    pats.sort(key=lambda p: (p["failure_count"], -p["average_score"]), reverse=True)
    out = data(r) / "pattern_report.json"; write_json(out, {"generated_at": now(), "rows_analyzed": len(rows), "patterns": pats[:args.max_patterns]})
    print(json.dumps({"ok": True, "patterns": len(pats[:args.max_patterns]), "path": str(out)}, indent=2)); return 0


def cmd_propose(args) -> int:
    r = root(Path(args.root)) if args.root else root(); report = read_json(data(r)/"pattern_report.json", {"patterns": []}); pats = report.get("patterns", [])
    if args.skill: pats = [p for p in pats if p.get("skill_used") == args.skill]
    made=[]
    for pat in pats[:args.max]:
        path = skill_md(r, pat["skill_used"]); orig = txt(path); proposed, rationale = proposal_text(orig, pat)
        if len(proposed.encode()) > MAX_SKILL_BYTES: raise SystemExit("Proposed SKILL.md exceeds size limit")
        d = diff(orig, proposed, str(path.relative_to(r)))
        if not d.strip(): continue
        rid = risk(d); pid = new_id(f"proposal-{pat['skill_used']}")
        obj={"proposal_id": pid, "created_at": now(), "target_skill": pat["skill_used"], "target_path": str(path.relative_to(r)), "pattern": pat, "risk": rid, "auto_apply_eligible": rid == "low", "rationale": rationale, "original_sha256": sha(orig), "proposed_sha256": sha(proposed), "diff": d, "proposed_content": proposed, "status": "proposed", "rollback": {"strategy": "restore pre-apply version snapshot"}}
        out=data(r)/"proposals"/f"{pid}.json"; write_json(out,obj); made.append(str(out))
    print(json.dumps({"ok": True, "count": len(made), "created": made}, indent=2)); return 0


def cmd_validate(args) -> int:
    r = root(Path(args.root)) if args.root else root(); pp = Path(args.proposal); pp = pp if pp.is_absolute() else (r/pp).resolve(); prop = read_json(pp)
    if not prop: raise SystemExit(f"Missing proposal: {pp}")
    path = skill_md(r, prop["target_skill"]); current = txt(path)
    if sha(current) != prop.get("original_sha256"): raise SystemExit("Target changed since proposal creation; regenerate.")
    rows=[x for x in read_jsonl(run_log(r)) if x.get("skill_used") == prop["target_skill"] and x.get("outcome")]
    used=set(prop.get("pattern",{}).get("example_run_ids") or []); held=[x for x in rows if x.get("run_id") not in used] or rows
    base=proxy_eval(current, held); new=proxy_eval(prop["proposed_content"], held); delta=round(new-base,4); regress=1 if delta < 0 else 0
    passed = delta >= args.min_delta and regress <= args.max_regressions
    val={"status": "validated" if passed else "rejected", "validated_at": now(), "held_out_cases": len(held), "baseline_score": base, "proposed_score": new, "delta": delta, "min_delta": args.min_delta, "regressions": regress, "max_regressions": args.max_regressions, "passed": passed}
    prop["validation"] = val; prop["status"] = val["status"]
    out = data(r)/("validated" if passed else "proposals")/pp.name; write_json(out, prop)
    print(json.dumps({"ok": passed, "path": str(out), "validation": val}, indent=2)); return 0 if passed else 2


def cmd_apply(args) -> int:
    r = root(Path(args.root)) if args.root else root()
    if args.rollback:
        vd=data(r)/"versions"/args.rollback; meta=read_json(vd/"metadata.json")
        if not meta: raise SystemExit(f"Version not found: {args.rollback}")
        target=skill_md(r, meta["skill"]); snapshot(r, meta["skill"], txt(target), {"reason":"pre-rollback snapshot", "rollback_to":args.rollback}); write(target, txt(vd/"SKILL.md")); print(json.dumps({"ok": True, "rolled_back": meta["skill"], "restored_version": args.rollback}, indent=2)); return 0
    pp=Path(args.proposal); pp=pp if pp.is_absolute() else (r/pp).resolve(); prop=read_json(pp)
    if prop.get("status") != "validated" or not prop.get("validation",{}).get("passed"): raise SystemExit("Proposal is not validated")
    if prop.get("risk") != "low" and not args.approve: raise SystemExit("Medium/high risk proposal requires --approve")
    target=skill_md(r, prop["target_skill"]); cur=txt(target)
    if sha(cur) != prop.get("original_sha256"): raise SystemExit("Target changed since validation; regenerate.")
    meta=snapshot(r, prop["target_skill"], cur, {"reason":"pre-apply snapshot", "proposal_id":prop["proposal_id"]}); write(target, prop["proposed_content"])
    rec={"applied_at": now(), "proposal_id": prop["proposal_id"], "skill": prop["target_skill"], "target_path": prop["target_path"], "risk": prop["risk"], "backup_version_id": meta["version_id"], "new_sha256": sha(prop["proposed_content"])}
    prop["status"]="applied"; prop["apply_record"]=rec; write_json(pp, prop); print(json.dumps({"ok": True, "applied": rec}, indent=2)); return 0


def build_parser(mode: Optional[str] = None) -> argparse.ArgumentParser:
    p=argparse.ArgumentParser(description="Self-optimization loop engine"); p.add_argument("--root", default=None)
    sub = None if mode else p.add_subparsers(dest="cmd", required=True)
    def add(name): return p if mode == name else (None if mode else sub.add_parser(name))
    q=add("log")
    if q: q.add_argument("--skill", required=True); q.add_argument("--task", required=True); q.add_argument("--run-id"); q.add_argument("--tool", action="append", default=[]); q.add_argument("--tests-passed", type=int); q.add_argument("--tests-failed", type=int); q.add_argument("--human-override", action="store_true"); q.add_argument("--explicit-rating", type=float); q.add_argument("--latency-ms", type=float); q.add_argument("--cost-usd", type=float); q.add_argument("--files-touched", action="append", default=[]); q.add_argument("--error"); q.add_argument("--metadata-json")
    q=add("score")
    if q: q.add_argument("--all", action="store_true")
    q=add("patterns")
    if q: q.add_argument("--min-runs", type=int, default=3); q.add_argument("--max-patterns", type=int, default=30)
    q=add("propose")
    if q: q.add_argument("--skill"); q.add_argument("--all-skills", action="store_true"); q.add_argument("--max", type=int, default=10)
    q=add("validate")
    if q: q.add_argument("--proposal", required=True); q.add_argument("--min-delta", type=float, default=.03); q.add_argument("--max-regressions", type=int, default=0)
    q=add("apply")
    if q: g=q.add_mutually_exclusive_group(required=True); g.add_argument("--proposal"); g.add_argument("--rollback"); q.add_argument("--approve", action="store_true")
    return p


def main(forced_mode: Optional[str] = None) -> int:
    args = build_parser(forced_mode).parse_args()
    cmd = forced_mode or args.cmd
    return {"log":cmd_log,"score":cmd_score,"patterns":cmd_patterns,"propose":cmd_propose,"validate":cmd_validate,"apply":cmd_apply}[cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
