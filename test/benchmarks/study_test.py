"""Focused stdlib tests; synthetic metadata only, no evaluator or native processes."""
import copy, importlib.util, json, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "benchmarks"
sys.path.insert(0, str(SCRIPTS))
import runner
import study_audit as audit
import study_supervisor as supervisor


class StudyTests(unittest.TestCase):
    def manifest(self):
        m = runner.load(SCRIPTS / "manifest-v3-pi-qwen.json")
        m["cases"] = m["cases"][:1]
        m["plan"]["study"].update(cases=[0], repeats=2, attempts=6, active_ceiling_s=1800)
        return m

    def fixture(self, root, rep):
        root.mkdir()
        m = self.manifest()
        runner.dump(root / "manifest.json", m)
        h = runner.file_sha(root / "manifest.json")
        pins = {key: "a" * 64 for key in ("runner_sha256", "native_runner_sha256", "pi_qwen_runner_sha256", "peer_bus_sha256", "teardown_sha256")}
        runner.dump(root / "prepared.json", {"manifest_sha256": h, **pins})
        runner.dump(root / "cohort.json", {"manifest_sha256": h, "repeat": rep, "cases": [0], "arms": m["arms"], **pins})
        runner.dump(root / "restoration.json", {"restored": True})
        runner.dump(root / "restoration-ledger.json", {"runner": {"pid": 10}, "protected": {"restored": True, "paths": {}}, "actors": {}})
        (root / "runs").mkdir()
        rows = []
        for arm in m["arms"]:
            run = {"index": 0, "kind": arm, "repeat": rep, "cleanup_complete": True, "metadata_clean": True,
                   "elapsedMs": 1000, "usage": {"pi": 3, "qwen": None}, "modelIdentity": {},
                   "answers": {"pi": ["PRIVATE ANSWER /private/SECRET"]}, "events": [{"text": "PRIVATE EVENT"}],
                   "error": "PRIVATE ERROR", "adversarial-key": "PRIVATE VALUE"}
            runner.dump(root / "runs" / f"00-{arm}.json", run)
            rows.append({"case": 0, "arm": arm, "status": "unavailable", "pass": None, "reason": "PRIVATE ERROR"})
        runner.dump(root / "grade.json", {"manifest_sha256": h, "rows": rows, "controls": {"0": []}})
        return root

    def scored_fixture(self, root, rep, repository):
        root = root.resolve()  # native runner records canonical paths on macOS
        self.fixture(root, rep)
        m = self.manifest(); case = m["cases"][0]
        head = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
        runner.dump(root.parent / "provenance.json", {"source_head": head, "source_repository": str(repository)})
        prep = runner.load(root / "prepared.json")
        prep.update({key: runner.file_sha(repository / path) for key, path in audit.SOURCE_FILES.items()})
        prep["source_pins"] = {path: runner.file_sha(repository / path) for path in runner.SOURCE_PIN_PATHS}
        prep["fixtures"] = []
        cohort = runner.load(root / "cohort.json")
        cohort.update({key: prep[key] for key in ("runner_sha256", "native_runner_sha256", "pi_qwen_runner_sha256", "peer_bus_sha256", "teardown_sha256")})
        cohort["private_case_sha256"] = {"0": "c" * 64}
        grade = {"schema": m["schema"], "manifest_sha256": prep["manifest_sha256"], "cohort": [0],
                 **{k: prep[k] for k in ("runner_sha256", "native_runner_sha256", "teardown_sha256", "evaluator_sha256")}, "rows": [], "controls": {"0": []}}
        evbase = {"repo": case["repo"], "task": case["task"], "features": case["features"],
                  "upstream_commit": m["upstream"]["commit"], "image_digest": case["image_digest"],
                  "evaluator_sha256": prep["evaluator_sha256"], "case_sha256": "c" * 64}
        for mode in ("base", "oracle"):
            ev = root / "evaluations" / (mode + ".json")
            runner.dump(ev, {**evbase, "input_sha256": "d" * 64, "both_passed": mode == "oracle",
                             "valid_negative": mode == "base", "valid_oracle": mode == "oracle", "feature1": {"test_output": "PRIVATE TEST"}})
            grade["controls"]["0"].append({"mode": mode, "check_passed": True, "observed": mode == "oracle",
                                         "input_sha256": "d" * 64, "evaluation_path": str(ev), "evaluation_sha256": runner.file_sha(ev)})
        for arm in m["arms"]:
            cwd = root / "fixtures" / f"00-{arm}"; (cwd / "src").mkdir(parents=True)
            (cwd / "src/example.py").write_text("original = True\n")
            self.git(cwd, "init", "-q"); self.git(cwd, "add", "-A"); self.git(cwd, "commit", "-qm", "sealed fixture")
            sealed = self.git(cwd, "rev-parse", "HEAD")
            (cwd / "src/example.py").write_text("original = False\n")
            patchbytes = subprocess.check_output(["git", "-C", str(cwd), "diff", "--binary", sealed, "--", "src"])
            patchfile = root / "patches" / (arm + ".patch"); patchfile.parent.mkdir(exist_ok=True); patchfile.write_bytes(patchbytes)
            nativepatch = root / "attempts" / (arm + ".patch"); nativepatch.parent.mkdir(exist_ok=True); nativepatch.write_bytes(patchbytes)
            patchhash = runner.sha(patchbytes)
            actors = runner.required_actors(arm)
            run = runner.load(root / "runs" / f"00-{arm}.json")
            run.update(cwd=str(cwd), sealedCommit=sealed, sourceDirs=["src"], patchFile=str(nativepatch), patchSHA256=patchhash,
                       nativeVersions={a: {"version": m["versions"][a]} for a in actors},
                       readiness={a: {"cwd": str(cwd), "sessionId": "session", "requestedModel": m["models"][a], "sandboxProbe": {"checked": True, "result": "denied"}} for a in actors},
                       modelIdentity={"requests": [{"outcome": "completed", "identified": True, "requestedModel": m["fixed_backend"], "actualModel": m["expected_served_model"], "provider": m["expected_provider"]}]},
                       usage={"pi": 0, "qwen": 0}, metadata_sha256=runner.fixture_metadata_sha256(cwd))
            runner.dump(root / "runs" / f"00-{arm}.json", run)
            prep["fixtures"].append({"case": 0, "arm": arm, "cwd": str(cwd), "base_commit": sealed, "source_dirs": ["src"]})
            ev = root / "evaluations" / (arm + ".json")
            runner.dump(ev, {**evbase, "input_sha256": patchhash, "both_passed": True})
            grade["rows"].append({"case": 0, "arm": arm, "status": "scored", "pass": True, "input_sha256": patchhash,
                                  "patch_path": str(patchfile), "evaluation_path": str(ev), "evaluation_sha256": runner.file_sha(ev)})
        for name, data in (("prepared.json", prep), ("cohort.json", cohort), ("grade.json", grade)): runner.dump(root / name, data)
        return root

    def git(self, cwd, *args):
        return subprocess.check_output(["git", "-C", str(cwd), "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost",
                                        "-c", "commit.gpgsign=false", *args], text=True, stderr=subprocess.PIPE).strip()

    def source_repo(self, root):
        root.mkdir()
        for path in set(audit.SOURCE_FILES.values()) | set(runner.SOURCE_PIN_PATHS):
            p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text("sealed source " + path)
        self.git(root, "init", "-q"); self.git(root, "add", "-A"); self.git(root, "commit", "-qm", "source provenance")
        return root

    def test_full_immutable_source_and_submission_chain_rejects_tampering(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d); repo = self.source_repo(base / "source")
            roots = [self.scored_fixture(base / f"r{i}", i, repo) for i in range(2)]
            self.assertTrue(audit.audit(roots, live=set())["verified"])
            # Current source changes do not invalidate a correctly sealed old Git tree.
            (repo / "scripts/benchmarks/runner.py").write_text("later unrelated source")
            self.assertTrue(audit.audit(roots, live=set())["verified"])
            for field in ("runner_sha256", "native_runner_sha256", "teardown_sha256", "evaluator_sha256"):
                with self.subTest(grade_field=field):
                    path = roots[0] / "grade.json"; original = runner.load(path); bad = copy.deepcopy(original)
                    bad[field] = "b" * 64; runner.dump(path, bad)
                    self.assertFalse(audit.audit(roots, live=set())["checks"]["bindings"])
                    runner.dump(path, original)
            for field in ("process_table_sha256", "evaluator_sha256", "source_pins"):
                with self.subTest(prepared_field=field):
                    path = roots[0] / "prepared.json"; original = runner.load(path); bad = copy.deepcopy(original)
                    if field == "source_pins": bad[field][runner.SOURCE_PIN_PATHS[0]] = "b" * 64
                    else: bad[field] = "b" * 64
                    runner.dump(path, bad)
                    self.assertFalse(audit.audit(roots, live=set())["checks"]["bindings"])
                    runner.dump(path, original)
            for field in ("patchSHA256", "sealedCommit", "patchFile"):
                with self.subTest(native_field=field):
                    path = roots[0] / "runs/00-solo-pi.json"; original = runner.load(path); bad = copy.deepcopy(original)
                    bad[field] = "b" * (40 if field == "sealedCommit" else 64) if field != "patchFile" else str(roots[0] / "missing.patch")
                    runner.dump(path, bad)
                    self.assertFalse(audit.audit(roots, live=set())["checks"]["bindings"])
                    runner.dump(path, original)
            cwd = roots[0] / "fixtures/00-solo-pi"
            (cwd / "src/new.py").write_text("untracked source added after the run")
            self.assertFalse(audit.audit(roots, live=set())["checks"]["bindings"])
            (cwd / "src/new.py").unlink()
            (cwd / "unauthorized.py").write_text("outside source")
            self.assertFalse(audit.audit(roots, live=set())["checks"]["bindings"])

    def test_generation_only_rechecks_metadata_source_and_native_patch_without_grades(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d); repo = self.source_repo(base / "source")
            roots = [self.scored_fixture(base / f"r{i}", i, repo) for i in range(2)]
            for root in roots:
                (root / "grade.json").unlink()  # this gate cannot depend on grading
            self.assertTrue(audit.audit(roots, live=set(), require_grades=False)["verified"])
            fixture = roots[0] / "fixtures/00-solo-pi"
            mutations = [(fixture / "AGENTS.md", "mutated instructions"),
                         (fixture / ".agenthub/config.json", "mutated configuration"),
                         (fixture / "src/example.py", "mutated source"),
                         (roots[0] / "attempts/solo-pi.patch", "mutated native patch")]
            for path, value in mutations:
                with self.subTest(tamper=path.name):
                    original = path.read_bytes() if path.exists() else None
                    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(value)
                    result = audit.audit(roots, live=set(), require_grades=False)
                    self.assertFalse(result["verified"]); self.assertFalse(result["checks"]["bindings"])
                    if original is None: path.unlink()
                    else: path.write_bytes(original)
                    self.assertTrue(audit.audit(roots, live=set(), require_grades=False)["verified"])

    def test_participation_preserves_observed_zero_and_excludes_absent_and_unstarted(self):
        with tempfile.TemporaryDirectory() as d:
            roots = [self.fixture(Path(d) / f"r{i}", i) for i in range(2)]
            path = roots[0] / "runs/00-solo-pi.json"; run = runner.load(path)
            run.update(usage={"pi": 0, "qwen": 0}, readiness={"pi": {"sessionId": "started"}})
            runner.dump(path, run)
            rows = audit.audit(roots, live=set())["cells"]
            observed = next(x for x in rows if x["repeat"] == 0 and x["arm"] == "solo-pi")
            self.assertEqual(observed["usage_pi"], 0); self.assertIsNone(observed["usage_qwen"])
            unstarted = next(x for x in rows if x["repeat"] == 0 and x["arm"] == "joint-pi-qwen")
            self.assertIsNone(unstarted["usage_pi"]); self.assertIsNone(unstarted["usage_qwen"])

    def test_matrix_and_version_binding_preserve_every_other_pin(self):
        m = runner.load(SCRIPTS / "manifest-v3-pi-qwen.json")
        self.assertEqual(len(audit.matrix(m)), 60)
        with self.assertRaises(runner.BenchError): supervisor.bind_manifest(m, "9.8.7")
        bound, changes = supervisor.bind_manifest(m, "9.8.7", True)
        self.assertEqual({c["field"] for c in changes}, {"hub_version", "versions.hub"})
        bound["hub_version"] = m["hub_version"]; bound["versions"]["hub"] = m["versions"]["hub"]
        self.assertEqual(bound, m)

    def test_claim_and_phases_refuse_reuse_and_skip(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "study"
            s = supervisor.Study(root, 6)
            with self.assertRaises(FileExistsError): supervisor.Study(root, 6)
            with self.assertRaises(runner.BenchError): s.advance("graded")
            s.advance("prepared"); s.fail()
            self.assertEqual(runner.load(root / "study.json")["outcome"], "incomplete")

    def test_nested_private_output_and_dynamic_keys_never_export(self):
        with tempfile.TemporaryDirectory() as d:
            roots = [self.fixture(Path(d) / f"r{i}", i) for i in range(2)]
            result = audit.audit(roots, live=set())
            output = json.dumps(result)
            for secret in ("PRIVATE", "/private", "answers", "events", "adversarial-key", str(Path(d))):
                self.assertNotIn(secret, output)
            self.assertEqual(result["retained"], 6)
            self.assertFalse(result["verified"])  # absent controls never count as success
            malicious = runner.load(roots[0] / "cohort.json"); malicious["repeat"] = "/private/SECRET"
            runner.dump(roots[0] / "cohort.json", malicious)
            with self.assertRaises(runner.BenchError): audit.audit(roots, live=set())

    def test_cleanup_failure_and_owned_live_process_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.fixture(Path(d) / "r0", 0)
            ledger = runner.load(root / "restoration-ledger.json")
            ledger["actors"] = {"attempt": [{"pid": 123, "started": "Mon Oct  5 04:00:00 2026"}]}
            runner.dump(root / "restoration-ledger.json", ledger)
            self.assertFalse(audit.restoration_ok(root, {(123, "Mon Oct  5 04:00:00 2026")})[0])
            self.assertTrue(audit.restoration_ok(root, {(123, "different process")})[0])
            ledger["siblings"] = {"arm": {"restored": False}}
            runner.dump(root / "restoration-ledger.json", ledger)
            self.assertFalse(audit.restoration_ok(root, set())[0])

    def test_duplicate_repeat_and_changed_manifest_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            roots = [self.fixture(Path(d) / f"r{i}", 0) for i in range(2)]
            with self.assertRaises(runner.BenchError): audit.audit(roots, live=set())
            m = runner.load(roots[1] / "manifest.json"); m["models"]["qwen"] = "weakened-model"
            runner.dump(roots[1] / "manifest.json", m)
            with self.assertRaises(runner.BenchError): audit.audit(roots, live=set())

    def test_missing_input_preflight_never_claims_output(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            m = self.manifest(); m["hub_version"] = runner.load(supervisor.REPO / "package.json")["version"]
            m["versions"]["hub"] = m["hub_version"]
            runner.dump(root / "manifest.json", m)
            a = type("Args", (), dict(manifest=root / "manifest.json", bind_current_hub=False, plan="study",
                  output=root / "study", upstream_root=root / "missing", private_inputs=root / "missing",
                  archives=root / "missing", qwen_package=root / "missing"))()
            with self.assertRaises(runner.BenchError): supervisor.preflight(a)
            self.assertFalse(a.output.exists())

    def test_all_generation_precedes_evaluation_and_cleanup_failure_blocks_grading(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            m = self.manifest(); runner.dump(root / "manifest.json", m)
            a = type("Args", (), {})()
            a.manifest = root / "manifest.json"; a.output = root / "study"
            a.plan = "study"; a.generation_only = False; a.python = Path(sys.executable)
            for key in ("archives", "upstream_root", "private_inputs", "probe_target", "qwen_package"):
                setattr(a, key, root)
            calls = []
            result = {"checks": {"restoration": True, "matrix": True, "bindings": True}, "verified": True, "planned": 6, "retained": 6}
            def command(cmd, log, timeout=None):
                calls.append([str(x) for x in cmd])
                log.write_text("private output")
            with patch.object(supervisor, "preflight", return_value=(m, m, [], [root], [])), \
                 patch.object(supervisor, "run_command", side_effect=command), \
                 patch.object(supervisor, "read_command", return_value="a" * 40), \
                 patch.object(audit, "audit", return_value=result):
                supervisor.execute(a)
            natives = [i for i, cmd in enumerate(calls) if any(x.endswith("native-pi-qwen.ts") for x in cmd)]
            grades = [i for i, cmd in enumerate(calls) if "grade" in cmd]
            self.assertEqual(len(natives), 2)
            self.assertLess(max(natives), min(grades))
            self.assertEqual(runner.load(a.output / "study.json")["phase"], "sealed")
            a.output = root / "failed-study"; calls.clear()
            failed = {**result, "checks": {**result["checks"], "restoration": False}}
            with patch.object(supervisor, "preflight", return_value=(m, m, [], [root], [])), \
                 patch.object(supervisor, "run_command", side_effect=command), \
                 patch.object(supervisor, "read_command", return_value="a" * 40), \
                 patch.object(audit, "audit", return_value=failed):
                with self.assertRaises(runner.BenchError): supervisor.execute(a)
            self.assertFalse(any("grade" in cmd for cmd in calls))
            self.assertEqual(runner.load(a.output / "study.json")["outcome"], "incomplete")

    def test_unverified_hash_shaped_adversarial_values_are_not_exported(self):
        with tempfile.TemporaryDirectory() as d:
            roots = [self.fixture(Path(d) / f"r{i}", i) for i in range(2)]
            secret = "0123456789abcdef" * 4
            grade = runner.load(roots[0] / "grade.json")
            grade["rows"][0].update(status="scored", input_sha256=secret, evaluation_sha256=secret,
                                     patch_path="/private/SECRET", evaluation_path="/private/SECRET")
            runner.dump(roots[0] / "grade.json", grade)
            result = audit.audit(roots, live=set())
            self.assertFalse(result["verified"])
            self.assertNotIn(secret, json.dumps(result))

    def test_relative_input_paths_are_resolved_before_repository_cwd_commands(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d).resolve(); m = self.manifest()
            m["hub_version"] = runner.load(supervisor.REPO / "package.json")["version"]
            m["versions"]["hub"] = m["hub_version"]
            runner.dump(root / "manifest.json", m)
            a = type("Args", (), {})()
            a.manifest = Path("manifest.json"); a.output = Path("study")
            a.upstream_root = Path("missing"); a.private_inputs = Path("private")
            a.archives = Path("archives"); a.qwen_package = Path("qwen")
            a.protect = [Path("prior")]; a.optional_protect = []
            a.python = Path(sys.executable); a.bind_current_hub = False; a.plan = "study"
            old = Path.cwd()
            try:
                import os
                os.chdir(root)
                with self.assertRaises(runner.BenchError): supervisor.preflight(a)
            finally:
                os.chdir(old)
            for key in ("manifest", "output", "upstream_root", "private_inputs", "archives", "qwen_package"):
                self.assertEqual(getattr(a, key), root / {"manifest": "manifest.json", "output": "study", "upstream_root": "missing", "private_inputs": "private", "archives": "archives", "qwen_package": "qwen"}[key])
            self.assertEqual(a.protect, [root / "prior"])
            self.assertFalse(a.output.exists())

    def test_failed_immutable_index_write_never_reports_sealed_complete(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); m = self.manifest(); runner.dump(root / "manifest.json", m)
            a = type("Args", (), {})()
            a.manifest = root / "manifest.json"; a.output = root / "study"
            a.plan = "study"; a.generation_only = False; a.python = Path(sys.executable)
            for key in ("archives", "upstream_root", "private_inputs", "probe_target", "qwen_package"):
                setattr(a, key, root)
            result = {"checks": {"restoration": True, "matrix": True, "bindings": True}, "verified": True, "planned": 6, "retained": 6}
            write = audit.write_new
            def fail_index(path, value):
                if path.name == "private-evidence-hashes.json": raise OSError("injected seal failure")
                write(path, value)
            def command(cmd, log, timeout=None): log.write_text("private output")
            with patch.object(supervisor, "preflight", return_value=(m, m, [], [root], [])), \
                 patch.object(supervisor, "run_command", side_effect=command), \
                 patch.object(supervisor, "read_command", return_value="a" * 40), \
                 patch.object(audit, "audit", return_value=result), \
                 patch.object(audit, "write_new", side_effect=fail_index):
                with self.assertRaises(OSError): supervisor.execute(a)
            state = runner.load(a.output / "study.json")
            self.assertEqual(state["phase"], "graded"); self.assertEqual(state["outcome"], "incomplete")
            self.assertNotIn("sealed", [x["phase"] for x in state["history"]])

    def test_export_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "safe.json"
            audit.write_new(path, {"verified": True})
            with self.assertRaises(FileExistsError): audit.write_new(path, {"verified": False})
            self.assertEqual(runner.load(path), {"verified": True})


if __name__ == "__main__":
    unittest.main()
