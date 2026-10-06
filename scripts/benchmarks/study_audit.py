#!/usr/bin/env python3
"""Read-only v3 metadata audit. Output is constructed from fixed keys, never raw evidence."""
from __future__ import annotations
import argparse, csv, io, json, math, os, re, subprocess, sys
from pathlib import Path
import runner
import ledger

SCHEMA = "agent-hub.native-study-audit/v1"
SUMMARY_SCHEMA = "agent-hub.native-study-summary/v1"
# The v3 driver's own end classes (endReasonOf in teardown.ts). Any other class is still counted, under "other":
# the buckets always reconcile with the retained records and no record string becomes a key.
SUMMARY_END_REASONS = ("completed", "delivery-unsettled", "timeout", "peer-failure", "interrupted",
                       "infrastructure-error", "provider-quota", "budget-paused", "other")
CLEANUP_OUTCOMES = ("clean", "clean_with_fallback", "incomplete_or_unknown", "unrecorded")
COHORT_ARTIFACTS = ("manifest.json", "prepared.json", "cohort.json", "restoration.json",
                    "restoration-ledger.json", "grade.json")


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
    actors = [ledger["runner"], *[a for group in ledger.get("actors", {}).values() for a in group]]
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


SOURCE_FILES = {
    "runner_sha256": "scripts/benchmarks/runner.py",
    "native_runner_sha256": "scripts/benchmarks/native.ts",
    "pi_qwen_runner_sha256": "scripts/benchmarks/native-pi-qwen.ts",
    "peer_bus_sha256": "scripts/benchmarks/peer-bus-mcp.py",
    "teardown_sha256": "scripts/benchmarks/teardown.ts",
    "process_table_sha256": "src/hub/child-process.ts",
    "evaluator_sha256": "scripts/benchmarks/evaluate.py",
}
_VERIFIED_SOURCE_TREES = {}


def source_provenance(root, prepared):
    """Verify pinned bytes from the recorded immutable Git tree, including old studies."""
    path = next((p for p in (root.parent / "provenance.json", root.parent / "summary.json") if p.is_file()), None)
    if path is None:
        return False
    provenance = runner.load(path)
    head = provenance.get("source_head")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        return False
    repository = Path(provenance.get("source_repository", Path(__file__).resolve().parents[2]))
    pins = prepared.get("source_pins")
    if not isinstance(pins, dict) or set(pins) != set(runner.SOURCE_PIN_PATHS):
        return False
    expected = {name: prepared.get(field) for field, name in SOURCE_FILES.items()}
    for name, value in pins.items():
        if name in expected and expected[name] != value:
            return False
        expected[name] = value
    if any(not digest(value) for value in expected.values()):
        return False
    # Successful byte verification can be reused only for this immutable commit and exact pin map.
    # Fixture, patch, metadata and grade checks below are always read back on each audit.
    cache_key = (str(repository.resolve()), head, tuple(sorted(expected.items())))
    if cache_key in _VERIFIED_SOURCE_TREES:
        return True
    # Query raw immutable blobs in two bounded batches, not one Git process per pin.
    # Unlike git archive, cat-file does not apply export-ignore or export-subst attributes.
    queries = "".join(f"{head}:{name}\n" for name in expected).encode()
    command = ["git", "--no-replace-objects", "-C", str(repository), "cat-file"]
    sizes = subprocess.run(command + ["--batch-check=%(objecttype) %(objectsize)"],
                           input=queries, capture_output=True, timeout=30)
    if sizes.returncode:
        return False
    rows = sizes.stdout.splitlines()
    if len(rows) != len(expected):
        return False
    lengths = []
    for row in rows:
        fields = row.split()
        if len(fields) != 2 or fields[0] != b"blob" or not fields[1].isdigit():
            return False
        length = int(fields[1])
        if length > 16 * 1024 * 1024:
            return False
        lengths.append(length)
    if sum(lengths) > 64 * 1024 * 1024:
        return False
    blobs = subprocess.run(command + ["--batch"], input=queries, capture_output=True, timeout=30)
    if blobs.returncode:
        return False
    offset = 0
    for value, length in zip(expected.values(), lengths):
        end = blobs.stdout.find(b"\n", offset)
        fields = blobs.stdout[offset:end].split()
        if end < 0 or len(fields) != 3 or fields[1] != b"blob" or fields[2] != str(length).encode():
            return False
        offset = end + 1
        content = blobs.stdout[offset:offset + length]
        if len(content) != length or runner.sha(content) != value:
            return False
        offset += length
        if blobs.stdout[offset:offset + 1] != b"\n":
            return False
        offset += 1
    if offset != len(blobs.stdout):
        return False
    if len(_VERIFIED_SOURCE_TREES) >= 64:
        del _VERIFIED_SOURCE_TREES[next(iter(_VERIFIED_SOURCE_TREES))]
    _VERIFIED_SOURCE_TREES[cache_key] = True
    return True


def native_fixture_binding(root, manifest, prepared, run, case, arm):
    """Grade-independent readback of the actual retained fixture and native patch."""
    if not bound_file(root, run.get("patchFile"), run.get("patchSHA256")):
        return False
    entries = [f for f in prepared.get("fixtures", []) if (f.get("case"), f.get("arm")) == (case, arm)]
    if len(entries) != 1:
        return False
    fixture = entries[0]
    cwd = root.resolve() / "fixtures" / f"{case:02d}-{arm}"
    if (run.get("cwd") != str(cwd) or fixture.get("cwd") != str(cwd) or not cwd.is_dir() or
        run.get("sourceDirs") != manifest["cases"][case]["source_dirs"] or
        fixture.get("source_dirs") != run.get("sourceDirs")):
        return False
    if runner.fixture_metadata_sha256(cwd) != run.get("metadata_sha256"):
        return False
    sealed = run.get("sealedCommit")
    base = fixture.get("base_commit")
    if any(not isinstance(x, str) or not re.fullmatch(r"[0-9a-f]{40}", x) for x in (sealed, base)):
        return False
    relation = subprocess.run(["git", "-C", str(cwd), "merge-base", "--is-ancestor", base, sealed], capture_output=True)
    if relation.returncode or runner.v3_outside_changes(cwd, run["sourceDirs"]):
        return False
    status = subprocess.run(["git", "-C", str(cwd), "status", "--porcelain", "-uall"], capture_output=True, text=True)
    if status.returncode or any(line.startswith("??") for line in status.stdout.splitlines()):
        return False
    diff = subprocess.run(["git", "-C", str(cwd), "diff", "--binary", sealed, "--", *run["sourceDirs"]], capture_output=True)
    return (diff.returncode == 0 and diff.stdout == Path(run["patchFile"]).read_bytes() and
            runner.sha(diff.stdout) == run["patchSHA256"])


def submission_binding(root, run, row):
    """Scoring additionally binds the grade patch to the verified native bytes."""
    return (run.get("patchSHA256") == row.get("input_sha256") and
            bound_file(root, row.get("patch_path"), row.get("input_sha256")) and
            Path(run["patchFile"]).read_bytes() == Path(row["patch_path"]).read_bytes())


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
        checks["bindings"] &= source_provenance(root, prep)
        grade = runner.load(root / "grade.json") if require_grades else {"rows": []}
        rows = {(x.get("case"), x.get("arm")): x for x in grade.get("rows", [])}
        if require_grades:
            checks["bindings"] &= grade.get("manifest_sha256") == mh
            checks["bindings"] &= grade.get("schema") == manifest["schema"]
            for field in ("runner_sha256", "native_runner_sha256", "teardown_sha256"):
                checks["bindings"] &= grade.get(field) == prep.get(field) == cohort.get(field)
            checks["bindings"] &= grade.get("evaluator_sha256") == prep.get("evaluator_sha256")
            checks["matrix"] &= grade.get("cohort") == cohort.get("cases")
            checks["matrix"] &= [(r.get("case"), r.get("arm")) for r in grade.get("rows", [])] == [
                (c, a) for c in spec["cases"] for a in manifest["arms"]]
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
                    if good:
                        hashes.append({"cohort": rep, "case": c, "artifact": "control-oracle" if control.get("mode") == "oracle" else "control-base",
                                       "sha256": digest(control.get("evaluation_sha256"))})
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
                native_bound = False
                if path.is_file():
                    run = runner.load(path)
                    checks["matrix"] &= (run.get("index"), run.get("kind"), run.get("repeat")) == key
                    ident = run.get("modelIdentity", {})
                    gate = runner.v3_request_gate(ident, manifest) is None
                    actors = runner.required_actors(arm)
                    native = run.get("nativeVersions", {})
                    ready = run.get("readiness", {})
                    isolation = all(isinstance(native.get(a), dict) and native[a].get("version") == manifest["versions"][a] and
                                    isinstance(ready.get(a), dict) and
                                    ready[a].get("sandboxProbe", {}).get("checked") is True and
                                    ready[a].get("sandboxProbe", {}).get("result") == "denied" and
                                    isinstance(ready[a].get("sessionId"), str) and bool(ready[a]["sessionId"]) and
                                    ready[a].get("requestedModel") == manifest["models"][a] and
                                    ready[a].get("cwd") == run.get("cwd") for a in actors)
                    checks["model_gates"] &= (gate and isolation) or status in ("unavailable", "missing")
                    participating = runner.v3_participants(run)
                    cell.update({"record_sha256": runner.file_sha(path), "cleanup_complete": run.get("cleanup_complete") is True,
                                 "metadata_clean": run.get("metadata_clean") is True, "model_gate": gate,
                                 "elapsed_ms": number(run.get("elapsedMs")),
                                 "usage_pi": number(run.get("usage", {}).get("pi")) if "pi" in participating else None,
                                 "usage_qwen": number(run.get("usage", {}).get("qwen")) if "qwen" in participating else None})
                    checks["restoration"] &= cell["cleanup_complete"] and cell["metadata_clean"]
                    native_bound = native_fixture_binding(root, manifest, prep, run, c, arm)
                    checks["bindings"] &= native_bound
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
                    good = good and native_bound and path.is_file() and submission_binding(root, run, row)
                    checks["bindings"] &= good
                    cell.update({"input_sha256": digest(row.get("input_sha256")) if good else None,
                                 "evaluation_sha256": digest(row.get("evaluation_sha256")) if good else None})
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


# ---- sealed-study summary export (#171) ---------------------------------------------------------------------------
# Allowlist-only projection of the sealed safe aggregate and the pooled ledger aggregates. Every value below is a
# fixed key with a count, a non-negative number, a boolean, null, a verified hash or one of this file's own fixed
# strings: no record string, dynamic key, answer, tool argument, nested evaluation or path can enter the export.

def _count(value, field):
    if type(value) is not int or value < 0:
        raise runner.BenchError(f"ledger aggregate {field} is not a count")
    return value


def _measure(value, field):
    if value is None:
        return None
    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
        return value
    raise runner.BenchError(f"ledger aggregate {field} is not a non-negative number or null")


def _summary_cells(sealed, cases, repeats):
    cells = []
    for c in sealed.get("cells", []):
        if not isinstance(c, dict):
            raise runner.BenchError("audit cell is malformed")
        case, arm, rep, status = c.get("case"), c.get("arm"), c.get("repeat"), c.get("status")
        passed, record = c.get("passed"), c.get("record_sha256")
        if (type(case) is not int or case not in cases or arm not in runner.ARMS_V3 or
            type(rep) is not int or not 0 <= rep < repeats or
            status not in ("scored", "unavailable", "missing") or
            (passed is not None and type(passed) is not bool) or
            (record is not None and not digest(record))):
            raise runner.BenchError("audit cell is malformed")
        cells.append({"case": case, "arm": arm, "repeat": rep, "status": status, "passed": passed,
                      "record": record, "cleanup_complete": c.get("cleanup_complete") is True,
                      "metadata_clean": c.get("metadata_clean") is True})
    return cells


def study_summary(root, plan="study"):
    """The safe human-facing summary of a sealed study (#171): audited per-arm quality, timing and coverage,
    hash-bound to the immutable source/runtime manifests, the final audit, the grades and the pooled ledger.
    Refuses an unsealed or ungraded study and any binding that no longer matches the audited bytes."""
    root = Path(root).resolve()
    state = runner.load(root / "study.json")
    if state.get("phase") != "sealed" or state.get("outcome") != "complete":
        raise runner.BenchError("study is not sealed and complete")
    provenance = runner.load(root / "provenance.json")
    head = provenance.get("source_head")
    original = provenance.get("original_sha256")
    runtime_hash = provenance.get("runtime_sha256")
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise runner.BenchError("immutable source head is not pinned")
    if not digest(original) or not digest(runtime_hash):
        raise runner.BenchError("sealed manifest hashes are not pinned")
    if (runner.file_sha(root / "original-manifest.json") != original or
        runner.file_sha(root / "runtime-manifest.json") != runtime_hash):
        raise runner.BenchError("sealed manifest copies differ from their pins")
    manifest = runner.load(root / "runtime-manifest.json")
    runner.validate_manifest(manifest)
    if tuple(manifest["arms"]) != runner.ARMS_V3:
        raise runner.BenchError("study requires native v3")
    spec = manifest["plan"][plan]  # validate_manifest/check_plan guarantee its shape
    arms, repeats, cases = runner.ARMS_V3, spec["repeats"], spec["cases"]
    cohorts = [root / f"r{rep}" for rep in range(repeats)]

    audit_path = root / "safe-aggregate.json"
    sealed = runner.load(audit_path)
    if sealed.get("schema") != SCHEMA or sealed.get("verified") is not True:
        raise runner.BenchError("the final audit is absent or unverified")
    # ponytail: the export rebinds the audited artifact bytes by hash instead of re-running the full audit;
    # the sealed audit already verified them and any later change fails closed here.
    grades, rebound = {}, set()
    for entry in sealed.get("evidence_hashes", []):
        if not isinstance(entry, dict):
            raise runner.BenchError("audit evidence index is malformed")
        rep, artifact, expect = entry.get("cohort"), entry.get("artifact"), entry.get("sha256")
        if artifact not in COHORT_ARTIFACTS:
            continue  # control evaluations carry no path here; grade.json binds them
        if type(rep) is not int or not 0 <= rep < repeats or not digest(expect):
            raise runner.BenchError("audit evidence index is malformed")
        path = cohorts[rep] / artifact
        if not path.is_file() or runner.file_sha(path) != expect:
            raise runner.BenchError("an audited cohort artifact changed after sealing")
        rebound.add((rep, artifact))
        if artifact == "grade.json":
            grades[str(rep)] = expect
    if rebound != {(rep, name) for rep in range(repeats) for name in COHORT_ARTIFACTS}:
        raise runner.BenchError("the audit evidence index does not cover every cohort artifact")

    ledger_path = root / "pooled-ledger.log"
    try:
        recorded = runner.load(ledger_path)
    except (OSError, ValueError):
        raise runner.BenchError("the recorded pooled ledger is unavailable")
    try:
        recomputed = ledger.pool(cohorts, plan)
    except SystemExit:
        raise runner.BenchError("the pooled ledger cannot be recomputed")
    if recorded != recomputed:
        raise runner.BenchError("the recorded pooled ledger differs from the cohort records")

    cells = _summary_cells(sealed, set(cases), repeats)
    rows = recomputed["rows"]
    missing_cells = {(c["case"], c["arm"], c["repeat"]) for c in cells if c["status"] == "missing"}
    ledger_missing = {(m.get("case"), m.get("arm"), m.get("repeat")) for m in recomputed["missing"]
                      if isinstance(m, dict)}
    if missing_cells != ledger_missing:
        raise runner.BenchError("the ledger and the audit disagree on missing attempts")

    arm_out, common = {}, None
    for arm in arms:
        mine = [c for c in cells if c["arm"] == arm]
        planned_n = len(cases) * repeats
        scored = sum(c["status"] == "scored" for c in mine)
        unavailable = sum(c["status"] == "unavailable" for c in mine)
        missing = sum(c["status"] == "missing" for c in mine)
        if len(mine) != planned_n or scored + unavailable + missing != planned_n:
            raise runner.BenchError("audited cells do not reconcile with the plan")
        records = [c for c in mine if c["record"]]
        agg = recomputed["summary"].get(arm)
        if not isinstance(agg, dict):
            raise runner.BenchError("the ledger summary misses an arm")
        arm_rows = [r for r in rows if isinstance(r, dict) and r.get("arm") == arm]
        if len(arm_rows) != len(records) or _count(agg.get("attempts"), "attempts") != len(records):
            raise runner.BenchError("the ledger and the audit disagree on retained records")
        end = {key: 0 for key in SUMMARY_END_REASONS}
        for r in arm_rows:
            reason = r.get("end_reason")
            end[reason if reason in end and reason != "other" else "other"] += 1
        outcomes = {key: 0 for key in CLEANUP_OUTCOMES}
        for r in arm_rows:
            teardown = r.get("teardown") if isinstance(r.get("teardown"), dict) else {}
            outcome = teardown.get("cleanup")
            outcomes[outcome if outcome in outcomes and outcome != "unrecorded" else "unrecorded"] += 1
        usage = agg.get("native_usage") if isinstance(agg.get("native_usage"), dict) else {}
        if not isinstance(usage.get("units"), str):
            raise runner.BenchError("native usage units are not recorded")
        native = {}
        for actor in runner.required_actors(arm):
            participating = _count(usage.get(f"{actor}_participating"), "participating")
            absent = _count(usage.get(f"{actor}_not_participating"), "not_participating")
            known = _count(usage.get(f"{actor}_tokens_known"), "tokens_known")
            unknown = _count(usage.get(f"{actor}_tokens_unknown"), "tokens_unknown")
            # Absent (never started) is not unknown (started, no reading), and a measured zero is neither:
            # participation reconciles with the retained records, readings with the participants.
            if participating + absent != len(arm_rows) or known + unknown != participating:
                raise runner.BenchError("native usage participation does not reconcile")
            native[actor] = {"participating": participating, "absent": absent, "tokens_known": known,
                             "tokens_unknown": unknown,
                             "tokens_total": _measure(usage.get(f"{actor}_tokens_total"), "tokens_total")}
        native["units"] = usage["units"]
        obs = agg.get("request_observability")
        relay = provider = None
        if obs is not None:
            ru = obs.get("requestUsage") if isinstance(obs.get("requestUsage"), dict) else None
            prov = obs.get("provider") if isinstance(obs.get("provider"), dict) else None
            if ru is None or prov is None or not isinstance(ru.get("units"), str):
                raise runner.BenchError("relay usage aggregate is malformed")
            counters = ru.get("counters") if isinstance(ru.get("counters"), dict) else {}
            relay = {"attempts": _count(obs.get("attempts"), "observability.attempts"),
                     "dispatches": _count(ru.get("dispatches"), "dispatches"),
                     "known": _count(ru.get("known"), "known"),
                     "partial": _count(ru.get("partial"), "partial"),
                     "unknown": _count(ru.get("unknown"), "unknown"),
                     "counters": {}, "units": ru["units"]}
            if relay["known"] + relay["partial"] + relay["unknown"] != relay["dispatches"]:
                raise runner.BenchError("relay usage coverage does not reconcile")
            for key in ("promptTokens", "completionTokens", "totalTokens"):
                c = counters.get(key) if isinstance(counters.get(key), dict) else {}
                relay["counters"][key] = {"known": _count(c.get("known"), f"{key}.known"),
                                          "total": _measure(c.get("total"), f"{key}.total")}
            provider = {}
            for outcome in ("completed", "cancelled", "failed"):
                o = prov.get(outcome) if isinstance(prov.get(outcome), dict) else None
                if o is None:
                    raise runner.BenchError("provider availability aggregate is malformed")
                d = _count(o.get("dispatches"), "provider.dispatches")
                k = _count(o.get("providerKnown"), "providerKnown")
                m = _count(o.get("providerMissing"), "providerMissing")
                if k + m != d:
                    raise runner.BenchError("provider availability does not reconcile")
                provider[outcome] = {"dispatches": d, "provider_known": k, "provider_missing": m}
            if sum(p["dispatches"] for p in provider.values()) != relay["dispatches"]:
                raise runner.BenchError("provider outcomes do not cover every dispatch")
        link = agg.get("request_linkage") if isinstance(agg.get("request_linkage"), dict) else None
        if link is None:
            raise runner.BenchError("request linkage aggregate is missing")
        linkage = {key: _count(link.get(key), key) for key in
                   ("attempts", "requests", "completed", "identified", "cancelledUnidentified",
                    "mismatches", "providerMissing")}
        paired = _count(agg.get("common_pairs"), "common_pairs")
        if common is None:
            common = paired
        elif common != paired:
            raise runner.BenchError("arms disagree on the common pairs")
        arm_out[arm] = {
            "counts": {"planned": planned_n, "retained": len(mine), "scored": scored,
                       "passed": sum(c["passed"] is True for c in mine),
                       "unavailable": unavailable, "missing": missing},
            "end_reasons": end,
            "cleanup": {"records": len(records),
                        "cleanup_complete": sum(c["cleanup_complete"] for c in records),
                        "metadata_clean": sum(c["metadata_clean"] for c in records),
                        "outcomes": outcomes},
            # Active time is the runner's active-work window only; setup and teardown are never folded in.
            "timing": {"valid_completed": _count(agg.get("valid_completed"), "valid_completed"),
                       "setup_s_median": _measure(agg.get("setup_s_median"), "setup_s_median"),
                       "setup_s_values": _count(agg.get("setup_s_values"), "setup_s_values"),
                       "active_s_median": _measure(agg.get("elapsed_s_median"), "elapsed_s_median"),
                       "active_s_values": _count(agg.get("elapsed_s_values"), "elapsed_s_values"),
                       "paired": {"pairs": paired,
                                  "setup_s_median": _measure(agg.get("setup_s_median_common"), "setup_s_median_common"),
                                  "active_s_median": _measure(agg.get("elapsed_s_median_common"), "elapsed_s_median_common"),
                                  "active_s_values": _count(agg.get("elapsed_s_common_values"), "elapsed_s_common_values")}},
            "model_identity": {"verified": _count(agg.get("model_identity_verified"), "model_identity_verified"),
                               "attempts": len(arm_rows)},
            "native_usage": native,
            "relay_usage": relay,
            "provider_availability": provider,
            "request_linkage": linkage,
        }
    total = {key: sum(arm_out[a]["counts"][key] for a in arms)
             for key in ("planned", "retained", "scored", "passed", "unavailable", "missing")}
    if total["planned"] != total["scored"] + total["unavailable"] + total["missing"]:
        raise runner.BenchError("global counts do not reconcile")
    return {
        "schema": SUMMARY_SCHEMA,
        "plan": plan,
        "bindings": {"source_head": head, "original_manifest_sha256": original,
                     "runtime_manifest_sha256": runtime_hash, "audit_sha256": runner.file_sha(audit_path),
                     "grades_sha256": grades, "ledger_sha256": runner.file_sha(ledger_path)},
        **total,
        "end_reasons": {key: sum(arm_out[a]["end_reasons"][key] for a in arms) for key in SUMMARY_END_REASONS},
        "cleanup": {"records": sum(arm_out[a]["cleanup"]["records"] for a in arms),
                    "cleanup_complete": sum(arm_out[a]["cleanup"]["cleanup_complete"] for a in arms),
                    "metadata_clean": sum(arm_out[a]["cleanup"]["metadata_clean"] for a in arms)},
        "common_pairs": common,
        "units": {
            "timing": "seconds; active is the runner's active-work window only (setup and teardown excluded); "
                      "medians are over valid completed attempts, paired medians over the case-repeat pairs every "
                      "arm validly completed",
            "native_usage": "each native's own cumulative session counters over the whole attempt, setup probes "
                            "included; never substituted for or added to relay counters",
            "relay_usage": "upstream per-request token counters of the relay's journaled requests; never "
                           "substituted for or added to native counters",
        },
        "arms": arm_out,
    }


def summary_csv(summary):
    """The compact per-arm count and timing table of a study summary, with a TOTAL row; null renders empty."""
    end_columns = [f"end_{key.replace('-', '_')}" for key in SUMMARY_END_REASONS]
    columns = ["arm", "planned", "retained", "scored", "passed", "unavailable", "missing", *end_columns,
               "records", "cleanup_complete", "metadata_clean", "valid_completed",
               "setup_s_median", "active_s_median", "paired_pairs", "paired_active_s_median",
               "model_identity_verified", "model_identity_attempts"]

    def row(name, counts, end, cleanup, timing, identity):
        values = [name, counts["planned"], counts["retained"], counts["scored"], counts["passed"],
                  counts["unavailable"], counts["missing"], *[end[k] for k in SUMMARY_END_REASONS],
                  cleanup["records"], cleanup["cleanup_complete"], cleanup["metadata_clean"],
                  timing["valid_completed"], timing["setup_s_median"], timing["active_s_median"],
                  timing["paired"]["pairs"], timing["paired"]["active_s_median"],
                  identity["verified"], identity["attempts"]]
        return ["" if v is None else v for v in values]

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(columns)
    for arm, entry in summary["arms"].items():
        writer.writerow(row(arm, entry["counts"], entry["end_reasons"], entry["cleanup"], entry["timing"],
                            entry["model_identity"]))
    arms = summary["arms"]
    total_end = {key: sum(arms[a]["end_reasons"][key] for a in arms) for key in SUMMARY_END_REASONS}
    total_cleanup = {"records": sum(arms[a]["cleanup"]["records"] for a in arms),
                     "cleanup_complete": sum(arms[a]["cleanup"]["cleanup_complete"] for a in arms),
                     "metadata_clean": sum(arms[a]["cleanup"]["metadata_clean"] for a in arms)}
    # ponytail: a TOTAL row has no pooled median (pooling medians is not a median); those cells stay empty.
    total_timing = {"valid_completed": sum(arms[a]["timing"]["valid_completed"] for a in arms),
                    "setup_s_median": None, "active_s_median": None,
                    "paired": {"pairs": summary["common_pairs"], "active_s_median": None}}
    total_identity = {"verified": sum(arms[a]["model_identity"]["verified"] for a in arms),
                      "attempts": sum(arms[a]["model_identity"]["attempts"] for a in arms)}
    writer.writerow(row("TOTAL", {k: summary[k] for k in
                                  ("planned", "retained", "scored", "passed", "unavailable", "missing")},
                        total_end, total_cleanup, total_timing, total_identity))
    return out.getvalue()


def write_new(path, value):
    with path.open("x", encoding="utf-8") as out:
        os.chmod(path, 0o600)
        out.write(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n")


def write_new_text(path, text):
    with path.open("x", encoding="utf-8") as out:
        os.chmod(path, 0o600)
        out.write(text)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", type=Path, action="append")
    p.add_argument("--summary", type=Path, help="export the safe human-facing summary of a sealed study root (#171)")
    p.add_argument("--csv", type=Path, help="with --summary, also write the per-arm table as CSV")
    p.add_argument("--plan", default="study")
    p.add_argument("--export", type=Path)
    a = p.parse_args()
    if a.csv and not a.summary:
        p.error("--csv requires --summary")
    try:
        if a.summary:
            result = study_summary(a.summary, a.plan)
            if a.export: write_new(a.export, result)
            if a.csv: write_new_text(a.csv, summary_csv(result))
            print(json.dumps(result, sort_keys=True, allow_nan=False))
            return 0
        if not a.run:
            p.error("--run or --summary is required")
        result = audit(a.run, a.plan)
        if a.export: write_new(a.export, result)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0 if result["verified"] else 1
    except (Exception, KeyboardInterrupt):
        if a.summary:
            print('{"schema":"agent-hub.native-study-summary/v1","exported":false,"error":"summary_refused"}')
        else:
            print('{"schema":"agent-hub.native-study-audit/v1","verified":false,"error":"audit_failed"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
