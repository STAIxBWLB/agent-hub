"""Focused stdlib tests for the sealed-study summary export (#171); synthetic metadata only, no evaluator or native processes."""
import csv, io, json, os, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "benchmarks"
sys.path.insert(0, str(SCRIPTS))
import runner
import ledger
import study_audit as audit
import study_supervisor as supervisor


class StudyExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        templates = tempfile.TemporaryDirectory()
        cls.addClassCleanup(templates.cleanup)
        base = Path(templates.name)
        fixture = cls()
        cls.source_template = fixture.build_source_repo(base / "source")
        cls.source_head = fixture.git(cls.source_template, "rev-parse", "HEAD")
        cls.arm_template = base / "arm"
        (cls.arm_template / "src").mkdir(parents=True)
        source = cls.arm_template / "src/example.py"
        source.write_text("original = True\n")
        fixture.git(cls.arm_template, "init", "-q")
        fixture.git(cls.arm_template, "add", "-A")
        fixture.git(cls.arm_template, "commit", "-qm", "sealed fixture")
        cls.sealed_commit = fixture.git(cls.arm_template, "rev-parse", "HEAD")
        source.write_text("original = False\n")
        cls.patchbytes = subprocess.check_output(["git", "-C", str(cls.arm_template), "diff", "--binary",
                                                cls.sealed_commit, "--", "src"])
        source.write_text("original = True\n")

    def manifest(self):
        m = runner.load(SCRIPTS / "manifest-v3-pi-qwen.json")
        m["cases"] = m["cases"][:1]
        m["plan"]["study"].update(cases=[0], repeats=2, attempts=6, active_ceiling_s=1800)
        return m

    def git(self, cwd, *args):
        return subprocess.check_output(["git", "-C", str(cwd), "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost",
                                        "-c", "commit.gpgsign=false", *args], text=True, stderr=subprocess.PIPE).strip()

    def build_source_repo(self, root):
        root.mkdir()
        for path in set(audit.SOURCE_FILES.values()) | set(runner.SOURCE_PIN_PATHS):
            p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text("sealed source " + path)
        self.git(root, "init", "-q"); self.git(root, "add", "-A"); self.git(root, "commit", "-qm", "source provenance")
        return root

    def request(self, m, outcome, identified, provider=None, usage=None, note=None):
        r = {"outcome": outcome, "identified": identified, "requestedModel": m["fixed_backend"],
             "actualModel": m["expected_served_model"], "provider": provider}
        if usage is not None: r["requestUsage"] = usage
        if note is not None: r["note"] = note
        return r

    def cell_params(self, m, rep, arm):
        provider = m["expected_provider"]
        full = lambda a, b, c: {"source": "openai-stream-usage", "promptTokens": a, "completionTokens": b,
                                "totalTokens": c, "evil-key": "PRIVATE USAGE KEY"}
        table = {
            (0, "solo-pi"): {"status": "scored", "end": "completed", "setup": 5000, "elapsed": 41000,
                             "usage": {"pi": 0}, "passed": True, "cleanup": {"outcome": "clean"},
                             "requests": [self.request(m, "completed", True, provider, full(10, 5, 15), "PRIVATE REQUEST NOTE")]},
            (0, "solo-qwen"): {"status": "scored", "end": "completed", "setup": 6000, "elapsed": 40000,
                               "usage": {"qwen": 100}, "passed": True,
                               "requests": [self.request(m, "completed", True)]},  # provider absent on a completed request
            (0, "joint-pi-qwen"): {"status": "scored", "end": "completed", "setup": 7000, "elapsed": 80000,
                                   "usage": {"pi": 7, "qwen": 9}, "passed": False,
                                   "requests": [self.request(m, "completed", True, provider, full(20, 10, 30))]},
            (1, "solo-pi"): {"status": "scored", "end": "completed", "setup": 5600, "elapsed": 43000,
                             "usage": {"pi": None}, "passed": True,  # participant whose native reading is unknown
                             "requests": [self.request(m, "completed", True, provider, {"source": "openai-stream-usage", "promptTokens": 5}),
                                          {"outcome": "cancelled", "identified": False}]},
            (1, "solo-qwen"): {"status": "unavailable", "end": "interrupted", "setup": 6500, "elapsed": 99000,
                               "usage": {"qwen": None},
                               "requests": [self.request(m, "failed", True, provider)]},
            (1, "joint-pi-qwen"): {"status": "missing"},  # the attempt wrote no record
        }
        return table[(rep, arm)]

    def cohort(self, root, rep, repository):
        root = root.resolve()  # records carry canonical paths on macOS
        root.mkdir()
        m = self.manifest(); case = m["cases"][0]
        runner.dump(root / "manifest.json", m)
        h = runner.file_sha(root / "manifest.json")
        prep = {key: runner.file_sha(repository / path) for key, path in audit.SOURCE_FILES.items()}
        prep["source_pins"] = {path: runner.file_sha(repository / path) for path in runner.SOURCE_PIN_PATHS}
        prep["manifest_sha256"] = h
        prep["fixtures"] = []
        cohort = {"manifest_sha256": h, "repeat": rep, "cases": [0], "arms": list(m["arms"]),
                  **{k: prep[k] for k in ("runner_sha256", "native_runner_sha256", "pi_qwen_runner_sha256", "peer_bus_sha256", "teardown_sha256")},
                  "private_case_sha256": {"0": "c" * 64}}
        grade = {"schema": m["schema"], "manifest_sha256": h, "cohort": [0],
                 **{k: prep[k] for k in ("runner_sha256", "native_runner_sha256", "teardown_sha256", "evaluator_sha256")},
                 "rows": [], "controls": {"0": []}}
        evbase = {"repo": case["repo"], "task": case["task"], "features": case["features"],
                  "upstream_commit": m["upstream"]["commit"], "image_digest": case["image_digest"],
                  "evaluator_sha256": prep["evaluator_sha256"], "case_sha256": "c" * 64}
        for mode in ("base", "oracle"):
            ev = root / "evaluations" / (mode + ".json")
            runner.dump(ev, {**evbase, "input_sha256": "d" * 64, "both_passed": mode == "oracle",
                             "valid_negative": mode == "base", "valid_oracle": mode == "oracle",
                             "feature1": {"test_output": "PRIVATE TEST OUTPUT"}})
            grade["controls"]["0"].append({"mode": mode, "check_passed": True, "observed": mode == "oracle",
                                           "input_sha256": "d" * 64, "evaluation_path": str(ev),
                                           "evaluation_sha256": runner.file_sha(ev)})
        (root / "runs").mkdir()
        for arm in m["arms"]:
            params = self.cell_params(m, rep, arm)
            # The fixture was prepared for every arm, including an attempt that never wrote a record.
            cwd = root / "fixtures" / f"00-{arm}"
            shutil.copytree(self.arm_template, cwd)
            sealed_commit = self.sealed_commit
            (cwd / "src/example.py").write_text("original = False\n")
            patchbytes = self.patchbytes
            prep["fixtures"].append({"case": 0, "arm": arm, "cwd": str(cwd), "base_commit": sealed_commit, "source_dirs": ["src"]})
            if params["status"] == "missing":
                grade["rows"].append({"case": 0, "arm": arm, "status": "missing", "pass": None})
                continue
            patchhash = runner.sha(patchbytes)
            nativepatch = root / "attempts" / (arm + ".patch"); nativepatch.parent.mkdir(exist_ok=True)
            nativepatch.write_bytes(patchbytes)
            actors = runner.required_actors(arm)
            run = {"protocol": ledger.V3_PROTOCOL, "index": 0, "kind": arm, "repeat": rep,
                   "cleanup_complete": True, "metadata_clean": True,
                   "end_reason": params["end"], "end_reason_detail": params["end"],
                   "setupMs": params["setup"], "elapsedMs": params["elapsed"], "usage": params["usage"],
                   "modelIdentity": {"requested": m["fixed_backend"], "expectedServedModel": m["expected_served_model"],
                                     "expectedProvider": m["expected_provider"], "requests": params["requests"]},
                   "answers": {"pi": ["PRIVATE ANSWER /private/SECRET"]},
                   "events": [{"text": "PRIVATE EVENT", "tool_arguments": {"path": "/private/SECRET"}}],
                   "error": "PRIVATE ERROR", "adversarial-key": "PRIVATE VALUE",
                   "cwd": str(cwd), "sealedCommit": sealed_commit, "sourceDirs": ["src"],
                   "patchFile": str(nativepatch), "patchSHA256": patchhash,
                   "nativeVersions": {a: {"version": m["versions"][a]} for a in actors},
                   "readiness": {a: {"cwd": str(cwd), "sessionId": "session", "requestedModel": m["models"][a],
                                     "sandboxProbe": {"checked": True, "result": "denied"}} for a in actors},
                   "metadata_sha256": runner.fixture_metadata_sha256(cwd)}
            if "cleanup" in params: run["cleanup"] = params["cleanup"]
            runner.dump(root / "runs" / f"00-{arm}.json", run)
            if params["status"] == "unavailable":
                grade["rows"].append({"case": 0, "arm": arm, "status": "unavailable", "pass": None, "reason": "PRIVATE ERROR"})
                continue
            patchfile = root / "patches" / (arm + ".patch"); patchfile.parent.mkdir(exist_ok=True)
            patchfile.write_bytes(patchbytes)
            ev = root / "evaluations" / (arm + ".json")
            runner.dump(ev, {**evbase, "input_sha256": patchhash, "both_passed": params["passed"]})
            grade["rows"].append({"case": 0, "arm": arm, "status": "scored", "pass": params["passed"],
                                  "input_sha256": patchhash, "patch_path": str(patchfile),
                                  "evaluation_path": str(ev), "evaluation_sha256": runner.file_sha(ev)})
        runner.dump(root / "prepared.json", prep)
        runner.dump(root / "cohort.json", cohort)
        runner.dump(root / "restoration.json", {"restored": True})
        runner.dump(root / "restoration-ledger.json", {"runner": {"pid": 10}, "protected": {"restored": True, "paths": {}}, "actors": {}})
        runner.dump(root / "grade.json", grade)
        return root

    def study(self, base):
        """A sealed supervisor-shaped study root (#173): the raw source manifest bytes differ from the
        supervisor's serialized copy of equal contents, the runtime manifest is that copy plus the recorded
        hub-version amendments, and provenance pins each of them separately; two graded cohorts, the verified
        safe aggregate and the pooled ledger."""
        repo = Path(shutil.copytree(self.source_template, base / "source"))
        root = base / "study"
        root.mkdir()
        m = self.manifest()
        # The supervisor parses the raw source and serializes the copy through write_new, so a compact unsorted
        # raw source hashes differently from the sealed copy while their parsed contents are equal.
        source = base / "manifest-source.json"
        source.write_text(json.dumps(m, separators=(",", ":")) + "\n", encoding="utf-8")
        audit.write_new(root / "original-manifest.json", m)
        runtime, amendments = supervisor.bind_manifest(m, "0.12.12", allowed=True)
        audit.write_new(root / "runtime-manifest.json", runtime)
        cohorts = [self.cohort(root / f"r{rep}", rep, repo) for rep in range(2)]
        runner.dump(root / "provenance.json", {
            "source_head": self.source_head, "source_repository": str(repo.resolve()),
            "original_sha256": runner.file_sha(source),
            "original_copy_sha256": runner.file_sha(root / "original-manifest.json"),
            "runtime_sha256": runner.file_sha(root / "runtime-manifest.json"), "amendments": amendments})
        result = audit.audit(cohorts, live=set())
        self.assertTrue(result["verified"], json.dumps(result["checks"]))  # the fixture must seal before every test
        audit.write_new(root / "safe-aggregate.json", result)
        pooled = ledger.pool(cohorts, "study")
        (root / "pooled-ledger.log").write_text(json.dumps(pooled, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        runner.dump(root / "study.json", {"schema": "agent-hub.native-study/v1", "phase": "sealed", "outcome": "complete"})
        self.seal_index(root)
        return root

    def test_counts_reconcile_and_unavailable_and_missing_stay_visible(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            s = audit.study_summary(root)
            self.assertEqual(s["schema"], "agent-hub.native-study-summary/v1")
            self.assertEqual((s["planned"], s["retained"], s["scored"], s["passed"], s["unavailable"], s["missing"]),
                             (6, 6, 4, 3, 1, 1))
            pi, qw, jt = (s["arms"][a] for a in ("solo-pi", "solo-qwen", "joint-pi-qwen"))
            self.assertEqual(pi["counts"], {"planned": 2, "retained": 2, "scored": 2, "passed": 2, "unavailable": 0, "missing": 0})
            self.assertEqual(qw["counts"], {"planned": 2, "retained": 2, "scored": 1, "passed": 1, "unavailable": 1, "missing": 0})
            self.assertEqual(jt["counts"], {"planned": 2, "retained": 2, "scored": 1, "passed": 0, "unavailable": 0, "missing": 1})
            for entry in s["arms"].values():
                c = entry["counts"]
                self.assertEqual(c["planned"], c["scored"] + c["unavailable"] + c["missing"])
                self.assertEqual(sum(entry["end_reasons"].values()), c["scored"] + c["unavailable"])
                self.assertEqual(sum(entry["cleanup"]["outcomes"].values()), entry["cleanup"]["records"])
            self.assertEqual((s["end_reasons"]["completed"], s["end_reasons"]["interrupted"]), (4, 1))
            self.assertEqual(qw["end_reasons"]["interrupted"], 1)
            self.assertEqual(s["cleanup"], {"records": 5, "cleanup_complete": 5, "metadata_clean": 5})
            self.assertEqual((pi["cleanup"]["outcomes"]["clean"], pi["cleanup"]["outcomes"]["unrecorded"]), (1, 1))
            self.assertEqual(jt["cleanup"]["records"], 1)
            b = s["bindings"]
            self.assertRegex(b["source_head"], r"^[0-9a-f]{40}$")
            self.assertEqual(b["audit_sha256"], runner.file_sha(root / "safe-aggregate.json"))
            self.assertEqual(set(b["grades_sha256"]), {"0", "1"})
            self.assertEqual(b["grades_sha256"]["0"], runner.file_sha(root / "r0" / "grade.json"))
            self.assertEqual(b["ledger_sha256"], runner.file_sha(root / "pooled-ledger.log"))
            self.assertEqual(b["runtime_manifest_sha256"], runner.file_sha(root / "runtime-manifest.json"))

    def test_timing_medians_common_pairs_and_denominators(self):
        with tempfile.TemporaryDirectory() as d:
            s = audit.study_summary(self.study(Path(d)))
            self.assertEqual(s["common_pairs"], 1)  # only repeat 0 was validly completed by every arm
            pi, qw, jt = (s["arms"][a]["timing"] for a in ("solo-pi", "solo-qwen", "joint-pi-qwen"))
            self.assertEqual(pi, {"valid_completed": 2, "setup_s_median": 5.3, "setup_s_values": 2,
                                  "active_s_median": 42.0, "active_s_values": 2,
                                  "paired": {"pairs": 1, "setup_s_median": 5.0, "active_s_median": 41.0, "active_s_values": 1}})
            self.assertEqual(qw["active_s_median"], 40.0)  # the interrupted attempt is no valid completion
            self.assertEqual(qw["valid_completed"], 1)
            self.assertEqual(jt["active_s_median"], 80.0)
            self.assertEqual(qw["paired"]["active_s_median"], 40.0)
            self.assertEqual(jt["paired"]["active_s_median"], 80.0)
            # Active time is never labeled as setup/teardown-inclusive runtime.
            for entry in s["arms"].values():
                self.assertIn("active_s_median", entry["timing"])
                self.assertNotIn("runtime", json.dumps(entry["timing"]).lower())

    def test_usage_units_and_provider_outcomes_stay_separate(self):
        with tempfile.TemporaryDirectory() as d:
            s = audit.study_summary(self.study(Path(d)))
            pi, qw, jt = (s["arms"][a] for a in ("solo-pi", "solo-qwen", "joint-pi-qwen"))
            # A measured zero is known and sums to 0, never null; a started native without a reading is unknown.
            self.assertEqual(pi["native_usage"]["pi"], {"participating": 2, "absent": 0, "tokens_known": 1,
                                                        "tokens_unknown": 1, "tokens_total": 0})
            self.assertEqual(qw["native_usage"]["qwen"], {"participating": 2, "absent": 0, "tokens_known": 1,
                                                          "tokens_unknown": 1, "tokens_total": 100})
            self.assertEqual(jt["native_usage"]["pi"]["tokens_total"], 7)
            self.assertEqual(jt["native_usage"]["qwen"]["tokens_total"], 9)
            self.assertNotIn("pi", qw["native_usage"])  # a solo-qwen arm reports no Pi actor at all
            self.assertEqual(pi["relay_usage"]["dispatches"], 3)
            self.assertEqual((pi["relay_usage"]["known"], pi["relay_usage"]["partial"], pi["relay_usage"]["unknown"]), (1, 1, 1))
            self.assertEqual(pi["relay_usage"]["counters"]["promptTokens"], {"known": 2, "total": 15})
            self.assertEqual(pi["relay_usage"]["counters"]["completionTokens"], {"known": 1, "total": 5})
            self.assertEqual(qw["relay_usage"]["known"], 0)
            self.assertEqual(jt["relay_usage"]["known"], 1)
            self.assertEqual(pi["provider_availability"]["completed"], {"dispatches": 2, "provider_known": 2, "provider_missing": 0})
            self.assertEqual(pi["provider_availability"]["cancelled"], {"dispatches": 1, "provider_known": 0, "provider_missing": 1})
            self.assertEqual(pi["provider_availability"]["failed"], {"dispatches": 0, "provider_known": 0, "provider_missing": 0})
            # Provider availability is split by outcome and stays separate from model qualification.
            self.assertEqual(qw["provider_availability"]["completed"], {"dispatches": 1, "provider_known": 0, "provider_missing": 1})
            self.assertEqual(qw["provider_availability"]["failed"], {"dispatches": 1, "provider_known": 1, "provider_missing": 0})
            self.assertEqual(qw["model_identity"], {"verified": 1, "attempts": 2})
            self.assertEqual(pi["model_identity"], {"verified": 2, "attempts": 2})
            self.assertEqual(pi["request_linkage"]["cancelledUnidentified"], 1)
            self.assertEqual(qw["request_linkage"]["providerMissing"], 1)
            self.assertNotEqual(pi["native_usage"]["units"], pi["relay_usage"]["units"])
            for entry in (pi, qw, jt):
                d = entry["relay_usage"]
                self.assertEqual(d["known"] + d["partial"] + d["unknown"], d["dispatches"])

    def test_null_preserved_when_no_valid_completed(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            for rep in range(2):
                for f in sorted((root / f"r{rep}" / "runs").glob("*.json")):
                    run = runner.load(f); run["end_reason"] = run["end_reason_detail"] = "timeout"
                    runner.dump(f, run)
            cohorts = [root / "r0", root / "r1"]
            pooled = ledger.pool(cohorts, "study")
            (root / "pooled-ledger.log").write_text(json.dumps(pooled, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            s = audit.study_summary(root)
            self.assertEqual(s["common_pairs"], 0)
            self.assertEqual(s["end_reasons"]["timeout"], 5)
            self.assertEqual(s["scored"], 4)  # the audited cells are untouched by the end-class change
            for entry in s["arms"].values():
                t = entry["timing"]
                self.assertEqual(t["valid_completed"], 0)
                self.assertIsNone(t["setup_s_median"]); self.assertIsNone(t["active_s_median"])
                self.assertEqual(t["paired"]["pairs"], 0)
                self.assertIsNone(t["paired"]["setup_s_median"]); self.assertIsNone(t["paired"]["active_s_median"])

    def test_allowlist_blocks_private_and_adversarial_content(self):
        with tempfile.TemporaryDirectory() as d:
            s = audit.study_summary(self.study(Path(d)))
            text = json.dumps(s)
            for secret in ("PRIVATE", "/private", "adversarial-key", "evil-key", "answers", "events",
                           str(Path(d).resolve()), d):
                self.assertNotIn(secret, text)
            table = audit.summary_csv(s)
            for secret in ("PRIVATE", "/private", d):
                self.assertNotIn(secret, table)

    def test_export_refuses_unsealed_unverified_and_inconsistent_bindings(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))

            def refused():
                with self.assertRaises(runner.BenchError):
                    audit.study_summary(root)

            state = runner.load(root / "study.json")
            state.update(phase="graded", outcome="incomplete"); runner.dump(root / "study.json", state)
            refused()  # an unsealed study never exports
            state.update(phase="sealed", outcome="complete"); runner.dump(root / "study.json", state)
            self.assertEqual(audit.study_summary(root)["schema"], audit.SUMMARY_SCHEMA)

            sealed_path = root / "safe-aggregate.json"
            sealed = runner.load(sealed_path)
            bad = {**sealed, "verified": False}
            sealed_path.write_text(json.dumps(bad, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            refused()  # an unverified audit never exports
            sealed_path.write_text(json.dumps(sealed, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            grade_path = root / "r0" / "grade.json"
            original = grade_path.read_text(encoding="utf-8")
            g = runner.load(grade_path); g["rows"][0]["pass"] = False; runner.dump(grade_path, g)
            refused()  # a grade that changed after sealing breaks the evidence binding
            grade_path.write_text(original, encoding="utf-8")

            ledger_path = root / "pooled-ledger.log"
            original = ledger_path.read_text(encoding="utf-8")
            log = json.loads(original); log["summary"]["solo-pi"]["attempts"] = 99
            ledger_path.write_text(json.dumps(log, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            refused()  # a recorded ledger that differs from the cohort records never exports
            ledger_path.write_text(original, encoding="utf-8")

            run_path = root / "r1" / "runs" / "00-solo-pi.json"
            original = run_path.read_text(encoding="utf-8")
            run = runner.load(run_path); run["elapsedMs"] = 1; runner.dump(run_path, run)
            refused()  # a changed record recomputes to a different ledger
            run_path.write_text(original, encoding="utf-8")

            om_path = root / "original-manifest.json"
            original = om_path.read_text(encoding="utf-8")
            om = runner.load(om_path); om["hub_version"] = "0.0.0"; runner.dump(om_path, om)
            refused()  # the sealed manifest copy must match its pin
            om_path.write_text(original, encoding="utf-8")
            self.assertEqual(audit.study_summary(root)["planned"], 6)

    def test_supervisor_shaped_root_with_distinct_source_and_copy_pins_exports(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            provenance = runner.load(root / "provenance.json")
            # The fixture exercises the real binding contract: distinct raw/copy pins and a recorded amendment.
            self.assertNotEqual(provenance["original_sha256"], provenance["original_copy_sha256"])
            self.assertEqual(provenance["original_sha256"], runner.file_sha(Path(d) / "manifest-source.json"))
            self.assertEqual(provenance["original_copy_sha256"], runner.file_sha(root / "original-manifest.json"))
            self.assertEqual([a["field"] for a in provenance["amendments"]], ["hub_version", "versions.hub"])
            self.assertEqual(runner.load(root / "original-manifest.json"), self.manifest())
            out, table = Path(d) / "summary.json", Path(d) / "summary.csv"
            p = subprocess.run([sys.executable, "-B", str(SCRIPTS / "study_audit.py"), "--summary", str(root),
                                "--export", str(out), "--csv", str(table)], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
            s = runner.load(out)
            self.assertEqual((s["schema"], s["planned"], s["retained"]), (audit.SUMMARY_SCHEMA, 6, 6))
            b = s["bindings"]
            self.assertEqual(b["original_manifest_sha256"], provenance["original_sha256"])
            self.assertEqual(b["original_copy_sha256"], provenance["original_copy_sha256"])
            self.assertTrue(table.read_text(encoding="utf-8").startswith("arm,planned,"))

    def test_export_refuses_copy_pin_and_amendment_violations(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))

            def refused():
                with self.assertRaises(runner.BenchError):
                    audit.study_summary(root)

            provenance_path = root / "provenance.json"
            provenance = runner.load(provenance_path)

            legacy = {k: v for k, v in provenance.items() if k != "original_copy_sha256"}
            runner.dump(provenance_path, legacy)
            refused()  # legacy provenance without the copy pin is unsupported, never given an invented pin
            for pins in ({"original_copy_sha256": "0" * 64}, {"runtime_sha256": "0" * 64},
                         {"original_sha256": "not-a-digest"}):
                runner.dump(provenance_path, {**provenance, **pins})
                refused()  # a pin that is malformed or does not match the sealed bytes refuses
            runner.dump(provenance_path, provenance)
            self.assertEqual(audit.study_summary(root)["planned"], 6)

            copy_path = root / "original-manifest.json"
            original = copy_path.read_text(encoding="utf-8")
            copy_path.write_text(json.dumps(runner.load(copy_path)) + "\n", encoding="utf-8")
            runner.dump(provenance_path, {**provenance, "original_copy_sha256": runner.file_sha(copy_path)})
            refused()  # a re-pinned copy that is not the supervisor's serialization refuses
            copy_path.write_text(original, encoding="utf-8")
            runner.dump(provenance_path, provenance)
            self.assertEqual(audit.study_summary(root)["planned"], 6)

            runtime_path = root / "runtime-manifest.json"
            original = runtime_path.read_text(encoding="utf-8")
            runtime = runner.load(runtime_path); runtime["hub_version"] = "9.9.9"; runner.dump(runtime_path, runtime)
            runner.dump(provenance_path, {**provenance, "runtime_sha256": runner.file_sha(runtime_path)})
            refused()  # a runtime manifest beyond the recorded amendments refuses even when re-pinned
            runtime_path.write_text(original, encoding="utf-8")

            bad = [{"field": "upstream.commit", "from": "a" * 40, "to": "b" * 40}]
            runner.dump(provenance_path, {**provenance, "amendments": bad})
            refused()  # an amendment outside the hub-version binding refuses
            bad = [{"field": "hub_version", "from": "0.0.0", "to": "0.12.12"},
                   {"field": "versions.hub", "from": "0.12.9", "to": "0.12.12"}]
            runner.dump(provenance_path, {**provenance, "amendments": bad})
            refused()  # an amendment whose recorded source value does not match the copy refuses
            missing = {k: v for k, v in provenance.items() if k != "amendments"}
            runner.dump(provenance_path, missing)
            refused()  # provenance without recorded amendments is unsupported
            runner.dump(provenance_path, provenance)
            self.assertEqual(audit.study_summary(root)["planned"], 6)

    @staticmethod
    def seal_index(root):
        runner.dump(root / "private-evidence-hashes.json", [
            {"artifact": name, "sha256": runner.file_sha(root / name)}
            for name in ("safe-aggregate.json", "pooled-ledger.log", "runtime-manifest.json")])

    def test_terminal_coverage_refuses_inconsistent_or_unbound_seal(self):
        mutations = [
            ("safe-aggregate.json", lambda s: s.pop("checks"), "final-audit-unverified"),
            ("safe-aggregate.json", lambda s: s["checks"].pop("matrix"), "final-audit-unverified"),
            ("safe-aggregate.json", lambda s: s.update(passed=s["scored"] + 1), "coverage-inconsistent"),
            ("safe-aggregate.json", lambda s: s.update(live_owned_matches=1), "coverage-inconsistent"),
            ("safe-aggregate.json", lambda s: s.update(controls_verified=0), "coverage-inconsistent"),
            ("pooled-ledger.log", lambda s: s["rows"].__setitem__(0, s["rows"][1]), "coverage-inconsistent"),
            ("pooled-ledger.log", lambda s: s["rows"][0].update(case=999), "coverage-inconsistent"),
            ("pooled-ledger.log", lambda s: s["rows"][0].update(end_reason=[]), "ledger-malformed"),
            ("study.json", lambda s: s.update(phase="graded"), "study-not-sealed"),
        ]
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            for artifact, change, reason in mutations:
                with self.subTest(artifact=artifact, reason=reason):
                    baseline = audit.terminal_coverage(root)
                    self.assertTrue(baseline["available"], baseline)
                    path = root / artifact
                    original = path.read_bytes()
                    try:
                        value = runner.load(path)
                        change(value)
                        runner.dump(path, value)
                        # A changed artifact is rejected before interpreting its alleged recorded status.
                        if artifact != "study.json":
                            self.assertEqual(audit.terminal_coverage(root)["reason"], "seal-binding-mismatch")
                        self.seal_index(root)
                        self.assertEqual(audit.terminal_coverage(root), {"available": False, "reason": reason})
                    finally:
                        path.write_bytes(original)
                        self.seal_index(root)
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            (root / "private-evidence-hashes.json").unlink()
            self.assertEqual(audit.terminal_coverage(root)["reason"], "seal-index-missing")
            ledger_path = root / "pooled-ledger.log"
            ledger_path.unlink()
            os.mkfifo(ledger_path)
            self.assertEqual(audit.terminal_coverage(root)["reason"], "ledger-unreadable")
            ledger_path.unlink()
            ledger_path.symlink_to(root / "safe-aggregate.json")
            self.assertEqual(audit.terminal_coverage(root)["reason"], "ledger-unreadable")
            # Oversized metadata is refused before JSON parsing; no native log/evaluation scan occurs.
            (root / "safe-aggregate.json").write_bytes(b" " * (4 * 1024 * 1024 + 1))
            self.assertEqual(audit.terminal_coverage(root)["reason"], "final-audit-unreadable")

    def test_terminal_coverage_composes_sealed_evidence_without_fresh_verification(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            s = audit.study_summary(root)
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["phase"], report["outcome"]),
                             ("completed", "sealed", "complete"))
            coverage = report["coverage"]
            self.assertTrue(coverage["available"])
            self.assertEqual((coverage["provenance"], coverage["fresh_verification"]),
                             ("recorded-at-seal", False))
            # The terminal counts and native end classes are exactly the verified summary's.
            for key in ("planned", "retained", "scored", "passed", "unavailable", "missing"):
                self.assertEqual(coverage[key], s[key])
            self.assertEqual(coverage["end_reasons"], s["end_reasons"])
            self.assertEqual((coverage["end_reasons"]["completed"], coverage["end_reasons"]["interrupted"]),
                             (4, 1))
            self.assertEqual(coverage["audit"]["controls_verified"], 4)
            self.assertEqual(coverage["restoration"],
                             {"verified": True, "owned_identities": 2, "live_owned_matches": 0})
            text = json.dumps(coverage)
            for secret in ("PRIVATE", "/private", "adversarial-key", str(Path(d).resolve()), d):
                self.assertNotIn(secret, text)
            # Tampered or absent sealed evidence degrades to an explicit unavailable coverage.
            (root / "pooled-ledger.log").unlink()
            self.assertEqual(supervisor.status_report(root)["coverage"],
                             {"available": False, "reason": "ledger-missing"})
            pooled = ledger.pool([root / "r0", root / "r1"], "study")
            pooled["rows"] = pooled["rows"][:-1]
            (root / "pooled-ledger.log").write_text(json.dumps(pooled, indent=2, sort_keys=True) + "\n",
                                                    encoding="utf-8")
            self.assertEqual(supervisor.status_report(root)["coverage"],
                             {"available": False, "reason": "seal-binding-mismatch"})

    def test_csv_matches_json_counts(self):
        with tempfile.TemporaryDirectory() as d:
            s = audit.study_summary(self.study(Path(d)))
            rows = list(csv.reader(io.StringIO(audit.summary_csv(s))))
            header, data = rows[0], {r[0]: r for r in rows[1:]}
            self.assertEqual(sorted(data), ["TOTAL", "joint-pi-qwen", "solo-pi", "solo-qwen"])
            idx = {name: i for i, name in enumerate(header)}
            self.assertEqual(data["TOTAL"][idx["planned"]], "6")
            self.assertEqual(data["TOTAL"][idx["passed"]], "3")
            self.assertEqual(data["TOTAL"][idx["paired_pairs"]], "1")
            self.assertEqual(data["TOTAL"][idx["active_s_median"]], "")  # no pooled median
            self.assertEqual(data["solo-qwen"][idx["unavailable"]], "1")
            self.assertEqual(data["joint-pi-qwen"][idx["missing"]], "1")
            self.assertEqual(data["joint-pi-qwen"][idx["end_completed"]], "1")
            self.assertEqual(data["solo-qwen"][idx["end_interrupted"]], "1")
            self.assertEqual(data["solo-pi"][idx["active_s_median"]], "42.0")
            self.assertEqual(data["solo-pi"][idx["valid_completed"]], "2")

    def test_cli_exports_and_refuses_overwrite_and_unsealed(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study(Path(d))
            out, table = Path(d) / "summary.json", Path(d) / "summary.csv"
            cmd = [sys.executable, "-B", str(SCRIPTS / "study_audit.py"), "--summary", str(root),
                   "--export", str(out), "--csv", str(table)]
            p = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr + p.stdout)
            self.assertEqual(runner.load(out)["schema"], audit.SUMMARY_SCHEMA)
            self.assertTrue(table.read_text(encoding="utf-8").startswith("arm,planned,"))
            again = subprocess.run(cmd, capture_output=True, text=True)
            self.assertEqual(again.returncode, 1)  # an existing export is never overwritten
            state = runner.load(root / "study.json"); state["phase"] = "generated"; runner.dump(root / "study.json", state)
            refused = subprocess.run([sys.executable, "-B", str(SCRIPTS / "study_audit.py"), "--summary", str(root)],
                                     capture_output=True, text=True)
            self.assertEqual(refused.returncode, 1)
            self.assertIn("summary_refused", refused.stdout)


if __name__ == "__main__":
    unittest.main()
