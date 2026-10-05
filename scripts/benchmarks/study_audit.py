#!/usr/bin/env python3
"""Read-only v3 metadata audit. Output is constructed from fixed keys, never raw evidence."""
from __future__ import annotations
import argparse, json, math, os, re, subprocess, sys
from pathlib import Path
import runner

SCHEMA = "agent-hub.native-study-audit/v1"


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def digest(value):
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) else None


def matrix(manifest, plan="study"):
    runner.validate_manifest(manifest)
    if tuple(manifest["arms"]) != runner.ARMS_V3:
        raise runner.BenchError("study requires native v3")
    spec = manifest.get("plan", {}).get(plan)
    if not isinstance(spec, dict):
        raise runner.BenchError("study plan missing")
    return {(c, a, r) for r in range(spec["repeats"]) for c in spec["cases"] for a in manifest["arms"]}


def process_identities():
    p = subprocess.run(["ps", "-axo", "pid=,stat=,lstart="], capture_output=True, text=True,
                       env={**os.environ, "LC_ALL": "C", "TZ": "UTC"}, check=True)
    result = set()
    for line in p.stdout.splitlines():
        match = re.fullmatch(r"\s*(\d+)\s+(\S+)\s+(.+?)\s*", line)
        if not match:
            raise runner.BenchError("process telemetry unavailable")
        if not match[2].startswith("Z"):
            result.add((int(match[1]), match[3]))
    if not any(pid == os.getpid() for pid, _ in result):
        raise runner.BenchError("process telemetry unavailable")
    return result


def restoration_ok(root, live):
    marker = runner.load(root / "restoration.json")
    ledger = runner.load(root / "restoration-ledger.json")
    protected = ledger.get("protected", {})
    siblings = ledger.get("siblings", {})
    trust = ledger.get("trust")
    ok = marker.get("restored") is True and bool(ledger.get("runner"))
    ok = ok and not (protected.get("paths") and protected.get("restored") is not True)
    ok = ok and all(x.get("restored") is True for x in siblings.values())
    ok = ok and not (trust and not trust.get("restored") and trust.get("stage") != "changed_concurrently")
    actors = [a for group in ledger.get("actors", {}).values() for a in group]
    matches = sum((a.get("pid"), a.get("started")) in live for a in actors)
    return bool(ok and not matches), len(actors), matches


def bound_file(root, value, expected):
    """A hash binding grants byte reads only, and only within this cohort."""
    if not isinstance(value, str) or not digest(expected):
        return False
    path = Path(value).resolve()
    if root.resolve() not in path.parents or not path.is_file():
        return False
    return runner.file_sha(path) == expected


def audit(roots, plan="study", live=None, require_grades=True):
    if not roots:
        raise runner.BenchError("no cohorts")
    manifests = [runner.load(r / "manifest.json") for r in roots]
    # Preparation adds absolute archive paths; no other pin may differ between repeats.
    def pins(m):
        return {**m, "cases": [{k: v for k, v in c.items() if k != "archive"} for c in m["cases"]]}
    if any(pins(m) != pins(manifests[0]) for m in manifests[1:]):
        raise runner.BenchError("cohort pins disagree")
    expected = matrix(manifests[0], plan)
    live = process_identities() if live is None else live
    seen, cells, hashes = set(), [], []
    checks = {"restoration": True, "bindings": True, "controls": True, "model_gates": True, "matrix": True}
    owned = live_owned = controls = 0
    for root, manifest in zip(roots, manifests):
        prep = runner.load(root / "prepared.json")
        cohort = runner.load(root / "cohort.json")
        ok, count, matches = restoration_ok(root, live)
        checks["restoration"] &= ok
        owned += count; live_owned += matches
        rep = cohort.get("repeat")
        spec = manifest["plan"][plan]
        if type(rep) is not int or not 0 <= rep < spec["repeats"]:
            raise runner.BenchError("invalid repeat identity")
        checks["matrix"] &= (type(rep) is int and 0 <= rep < spec["repeats"] and
                              cohort.get("cases") == spec["cases"] and cohort.get("arms") == manifest["arms"])
        mh = runner.file_sha(root / "manifest.json")
        checks["bindings"] &= prep.get("manifest_sha256") == mh == cohort.get("manifest_sha256")
        for name in ("runner_sha256", "native_runner_sha256", "pi_qwen_runner_sha256", "peer_bus_sha256", "teardown_sha256"):
            checks["bindings"] &= bool(digest(prep.get(name))) and prep.get(name) == cohort.get(name)
        grade = runner.load(root / "grade.json") if require_grades else {"rows": []}
        rows = {(x.get("case"), x.get("arm")): x for x in grade.get("rows", [])}
        if require_grades:
            checks["bindings"] &= grade.get("manifest_sha256") == mh
            checks["matrix"] &= len(rows) == len(grade.get("rows", [])) == len(spec["cases"]) * len(manifest["arms"])
            for c in spec["cases"]:
                ctrl = grade.get("controls", {}).get(str(c), [])
                checks["controls"] &= len(ctrl) == 2 and {x.get("mode") for x in ctrl} == {"base", "oracle"}
                for control in ctrl:
                    good = (control.get("check_passed") is True and
                            control.get("observed") is (control.get("mode") == "oracle") and
                            bound_file(root, control.get("evaluation_path"), control.get("evaluation_sha256")))
                    if good:
                        ev = runner.load(Path(control["evaluation_path"]))
                        good = (ev.get("input_sha256") == control.get("input_sha256") and
                                ev.get("both_passed") is (control.get("mode") == "oracle") and
                                ev.get("valid_oracle" if control.get("mode") == "oracle" else "valid_negative") is True and
                                ev.get("evaluator_sha256") == grade.get("evaluator_sha256") and
                                ev.get("case_sha256") == cohort.get("private_case_sha256", {}).get(str(c)))
                    checks["controls"] &= good
                    controls += int(good)
        for c in spec["cases"]:
            for arm in manifest["arms"]:
                key = (c, arm, rep)
                if key in seen:
                    raise runner.BenchError("duplicate study cell")
                seen.add(key)
                path = root / "runs" / f"{c:02d}-{arm}.json"
                row = rows.get((c, arm), {})
                status = row.get("status") if row.get("status") in ("scored", "unavailable", "missing") else "missing"
                cell = {"case": c, "arm": arm, "repeat": rep, "status": status,
                        "passed": row.get("pass") if type(row.get("pass")) is bool else None}
                if path.is_file():
                    run = runner.load(path)
                    checks["matrix"] &= (run.get("index"), run.get("kind"), run.get("repeat")) == key
                    ident = run.get("modelIdentity", {})
                    gate = runner.v3_request_gate(ident, manifest) is None
                    actors = runner.required_actors(arm)
                    native = run.get("nativeVersions", {})
                    ready = run.get("readiness", {})
                    isolation = all(native.get(a) == manifest["versions"][a] and
                                    isinstance(ready.get(a), dict) and
                                    ready[a].get("sandboxProbe", {}).get("result") == "denied" for a in actors)
                    checks["model_gates"] &= (gate and isolation) or status in ("unavailable", "missing")
                    cell.update({"record_sha256": runner.file_sha(path), "cleanup_complete": run.get("cleanup_complete") is True,
                                 "metadata_clean": run.get("metadata_clean") is True, "model_gate": gate,
                                 "elapsed_ms": number(run.get("elapsedMs")),
                                 "usage_pi": number(run.get("usage", {}).get("pi")),
                                 "usage_qwen": number(run.get("usage", {}).get("qwen"))})
                    checks["restoration"] &= cell["cleanup_complete"] and cell["metadata_clean"]
                elif status != "missing" or not require_grades:
                    checks["matrix"] = False
                if status == "scored":
                    good = (bound_file(root, row.get("patch_path"), row.get("input_sha256")) and
                            bound_file(root, row.get("evaluation_path"), row.get("evaluation_sha256")))
                    if good:
                        ev = runner.load(Path(row["evaluation_path"]))
                        good = (ev.get("input_sha256") == row.get("input_sha256") and
                                ev.get("both_passed") is cell["passed"] and
                                ev.get("evaluator_sha256") == grade.get("evaluator_sha256") and
                                ev.get("case_sha256") == cohort.get("private_case_sha256", {}).get(str(c)) and
                                (ev.get("repo"), ev.get("task"), ev.get("features")) ==
                                (manifest["cases"][c]["repo"], manifest["cases"][c]["task"], manifest["cases"][c]["features"]) and
                                ev.get("upstream_commit") == manifest["upstream"]["commit"] and
                                ev.get("image_digest") == manifest["cases"][c]["image_digest"])
                    checks["bindings"] &= good
                    cell.update({"input_sha256": digest(row.get("input_sha256")),
                                 "evaluation_sha256": digest(row.get("evaluation_sha256"))})
                cells.append(cell)
        # Fixed file names become ordinal labels, so private names never enter the export.
        for name in ("manifest.json", "prepared.json", "cohort.json", "restoration.json", "restoration-ledger.json", "grade.json"):
            p = root / name
            if p.is_file(): hashes.append({"cohort": rep, "artifact": name, "sha256": runner.file_sha(p)})
    checks["matrix"] &= seen == expected
    cells.sort(key=lambda x: (x["repeat"] if type(x["repeat"]) is int else -1, x["case"], x["arm"]))
    # No raw strings, dynamic keys, errors, paths, answers or nested evaluations are copied.
    return {"schema": SCHEMA, "verified": all(checks.values()), "checks": checks,
            "planned": len(expected), "retained": len(cells), "scored": sum(x["status"] == "scored" for x in cells),
            "passed": sum(x["passed"] is True for x in cells), "missing": sum(x["status"] == "missing" for x in cells),
            "unavailable": sum(x["status"] == "unavailable" for x in cells), "controls_verified": controls,
            "owned_identities": owned, "live_owned_matches": live_owned, "cells": cells, "evidence_hashes": hashes}


def write_new(path, value):
    with path.open("x", encoding="utf-8") as out:
        os.chmod(path, 0o600)
        out.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", type=Path, action="append", required=True)
    p.add_argument("--plan", default="study")
    p.add_argument("--export", type=Path)
    a = p.parse_args()
    try:
        result = audit(a.run, a.plan)
        if a.export: write_new(a.export, result)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0 if result["verified"] else 1
    except (OSError, ValueError, TypeError, KeyError, runner.BenchError, subprocess.SubprocessError):
        print('{"schema":"agent-hub.native-study-audit/v1","verified":false,"error":"audit_failed"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
