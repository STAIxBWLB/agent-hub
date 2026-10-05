"""Focused stdlib tests; synthetic metadata only, no evaluator or native processes."""
import copy, importlib.util, json, sys, tempfile, unittest
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

    def test_export_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "safe.json"
            audit.write_new(path, {"verified": True})
            with self.assertRaises(FileExistsError): audit.write_new(path, {"verified": False})
            self.assertEqual(runner.load(path), {"verified": True})


if __name__ == "__main__":
    unittest.main()
