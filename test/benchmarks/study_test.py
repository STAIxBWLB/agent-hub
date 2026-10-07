"""Focused stdlib tests; synthetic metadata and deterministic fake native children only, never real evaluator or native processes."""
import contextlib, copy, importlib.util, io, json, os, signal, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "benchmarks"
sys.path.insert(0, str(SCRIPTS))
import runner
import study_audit as audit
import study_supervisor as supervisor


def manifest():
    m = runner.load(SCRIPTS / "manifest-v3-pi-qwen.json")
    m["cases"] = m["cases"][:1]
    m["plan"]["study"].update(cases=[0], repeats=2, attempts=6, active_ceiling_s=1800)
    return m


class StudyTests(unittest.TestCase):
    def manifest(self):
        return manifest()

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
            def command(cmd, log, timeout=None, **_):
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
            def command(cmd, log, timeout=None, **_): log.write_text("private output")
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

# A deterministic fake native child (#168): it records the same restoration marker/ledger pair the real native
# runner does, commits run records slowly, and answers or ignores cancellation by mode. It never touches real
# protected state: its cohort is a synthetic temp directory and its ledger locks nothing.
FAKE_NATIVE = """
import json, os, signal, subprocess, sys, time
from pathlib import Path

cohort = Path(sys.argv[1]); mode = sys.argv[2]
records = int(sys.argv[3]); signal_after = int(sys.argv[4])
delay = float(sys.argv[5])

def started_of(pid):
    p = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True,
                       env={**os.environ, "LC_ALL": "C", "TZ": "UTC"})
    return p.stdout.strip()

cohort.mkdir(parents=True, exist_ok=True)
(cohort / "runs").mkdir(exist_ok=True)
ident = {"pid": os.getpid(), "started": started_of(os.getpid())}
(cohort / "restoration-ledger.json").write_text(json.dumps(
    {"runner": ident, "protected": {"paths": {}, "restored": True}, "siblings": {}, "actors": {}, "trust": None}))
(cohort / "restoration.json").write_text(json.dumps({"restored": False, "runner": ident}))

stop = []
def on_signal(signum, frame):
    stop.append(signum)

if mode.startswith("ignores"):
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
else:
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
if mode == "ignores-corrupt-ledger":
    (cohort / "restoration-ledger.json").write_text("not json")

for i in range(records):
    if stop:
        break
    (cohort / "runs" / ("%02d-arm.json" % i)).write_text(json.dumps({"index": i, "kind": "fake", "repeat": 0}))
    if i + 1 == signal_after:
        os.kill(os.getppid(), signal.SIGINT)
        time.sleep(max(delay, 0.4))  # the operator's signal must reach the supervisor before this child settles
    time.sleep(delay)

if mode.startswith("ignores"):
    while True:
        time.sleep(1)

# Cooperative mode settles its own restoration in cleanup, then exits nonzero when interrupted, like the native runner.
(cohort / "restoration.json").write_text(json.dumps({"restored": True, "interrupted": bool(stop)}))
sys.exit(1 if stop else 0)
"""


class InterruptionTests(unittest.TestCase):
    """The #168 supervisor interruption contract, driven through the real signal path with a fake native child."""

    def setUp(self):
        supervisor._INTERRUPT.clear()

    def tearDown(self):
        supervisor._INTERRUPT.clear()

    def fake_native(self, root):
        path = Path(root) / "fake-native.py"
        path.write_text(FAKE_NATIVE)
        return path

    def study(self, root, phase):
        study = supervisor.Study(Path(root) / "study", 3)
        for target in ("prepared", "generated", "restored"):
            if supervisor.PHASES.index(target) <= supervisor.PHASES.index(phase):
                study.advance(target)
        return study

    def run_fake(self, study, cohort, mode, records, signal_after, kind="generate", repeat=0, planned=3):
        supervisor._INTERRUPT.clear()
        log = study.root / f"{kind}-{repeat}.log"
        with supervisor.interrupt_handlers(), \
             patch.object(supervisor, "PROGRESS_INTERVAL_S", 0.05), \
             patch.object(supervisor, "CANCEL_SETTLE_S", 5.0 if mode == "cooperative" else 0.6), \
             patch.object(supervisor, "FALLBACK_SETTLE_S", 5.0), \
             patch.object(supervisor, "RECOVERY_TIMEOUT_S", 120.0):
            with self.assertRaises(supervisor.StudyInterrupted):
                supervisor.run_command([sys.executable, "-B", self.fake, cohort, mode, str(records), str(signal_after), "0.05"],
                                       log, study=study, kind=kind, repeat=repeat, cohort=cohort, planned=planned)
        state = runner.load(study.root / "study.json")
        self.assertEqual(state["outcome"], "incomplete")
        return state["interrupted"]

    def assert_records_byte_identical(self, cohort, count):
        written = sorted((Path(cohort) / "runs").glob("*.json"))
        self.assertEqual(len(written), count)
        for path in written:
            i = int(path.name[:2])
            self.assertEqual(path.read_text(), json.dumps({"index": i, "kind": "fake", "repeat": 0}))

    def test_cooperative_child_settles_restoration_before_incomplete_exit(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            study = self.study(root, "prepared")
            cohort = study.root / "r0"
            record = self.run_fake(study, cohort, "cooperative", 3, 2)
            self.assertEqual((record["phase"], record["command"], record["repeat"], record["cohort"]),
                             ("prepared", "generate", 0, "r0"))
            self.assertEqual((record["cause"], record["signal"]), ("operator-signal", "SIGINT"))
            self.assertEqual(record["child"]["pid"] and isinstance(record["child"]["started"], str), True)
            self.assertTrue(record["cancellation_requested"])
            self.assertIsNone(record["fallback"])
            self.assertTrue(record["child_exited"])
            self.assertEqual(record["exit_code"], 1)
            self.assertEqual(record["restoration"]["state"], "restored")
            # The milestone phase never advanced on progress or interruption.
            self.assertEqual(runner.load(study.root / "study.json")["phase"], "prepared")
            marker = runner.load(cohort / "restoration.json")
            self.assertTrue(marker["restored"])
            self.assertTrue(marker["interrupted"])
            self.assert_records_byte_identical(cohort, 2)
            # Nothing was left to recover, so the recovery never ran.
            self.assertFalse((study.root / "recovery-r0.log").exists())

    def test_child_ignoring_cancellation_reaches_verified_bounded_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            study = self.study(root, "prepared")
            cohort = study.root / "r0"
            record = self.run_fake(study, cohort, "ignores", 1, 1)
            self.assertTrue(record["cancellation_requested"])
            self.assertEqual(record["fallback"], "sigkill-after-cancel-timeout")
            self.assertTrue(record["fallback_kill_sent"])
            self.assertTrue(record["child_exited"])
            # The killed identity is gone (or, under heavy pid churn, no longer matches it), the bounded
            # restore.ts recovery ran once, and marker plus ledger agree.
            self.assertNotEqual(supervisor.ps_fields(record["child"]["pid"]),
                                (record["child"]["started"], record["child"]["pgid"]))
            self.assertEqual(record["restoration"]["state"], "restored")
            self.assertEqual(record["restoration"]["recovery"], {"attempted": True, "recovered": True})
            self.assertTrue(runner.load(cohort / "restoration.json")["restored"])

    def test_unprovable_cleanup_records_explicit_restoration_failure(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            study = self.study(root, "prepared")
            cohort = study.root / "r0"
            record = self.run_fake(study, cohort, "ignores-corrupt-ledger", 1, 1)
            self.assertTrue(record["fallback_kill_sent"])
            self.assertTrue(record["child_exited"])
            self.assertEqual(record["restoration"]["state"], "restoration_failed")
            self.assertEqual(record["restoration"]["verification"]["state"], "unknown")
            self.assertEqual(record["restoration"]["recovery"]["attempted"], True)
            self.assertEqual(record["restoration"]["recovery"]["recovered"], False)

    def test_interrupted_preparation_and_grading_have_their_documented_outcomes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            # Preparation: nothing is locked yet, so there is nothing to restore.
            study = self.study(root, "claimed")
            record = self.run_fake(study, study.root / "r0", "cooperative", 1, 1, kind="prepare", planned=3)
            self.assertEqual((record["phase"], record["command"]), ("claimed", "prepare"))
            self.assertEqual(record["restoration"], {"state": "not-applicable"})
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            # Grading: the cohort was already restored; interruption re-verifies exactly that.
            study = self.study(root, "restored")
            record = self.run_fake(study, study.root / "r0", "cooperative", 1, 1, kind="grade")
            self.assertEqual((record["phase"], record["command"]), ("restored", "grade"))
            self.assertEqual(record["restoration"]["state"], "restored")

    def test_reused_pid_and_unknown_identity_are_never_signalled(self):
        with tempfile.TemporaryDirectory() as d:
            child = supervisor.Child(["true"], Path(d) / "log")
            # A live pid whose start time does not match: a reused identity, never signalled.
            child.pid, child.started, child.pgid = os.getpid(), "definitely-not-the-start-time", os.getpid()
            self.assertFalse(child.signal_group(signal.SIGTERM))
            # An exited pid: no live identity to verify, never signalled.
            gone = subprocess.Popen(["true"]); gone.wait()
            child.pid, child.started, child.pgid = gone.pid, "Mon Jan  1 00:00:00 1990", gone.pid
            self.assertFalse(child.signal_group(signal.SIGKILL))

    def test_execute_interrupted_generation_restores_and_never_grades(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); self.fake = self.fake_native(root)
            m = manifest(); runner.dump(root / "manifest.json", m)
            a = type("Args", (), {})()
            a.manifest = root / "manifest.json"; a.output = root / "study"
            a.plan = "study"; a.generation_only = False; a.python = Path(sys.executable)
            for key in ("archives", "upstream_root", "private_inputs", "probe_target", "qwen_package"):
                setattr(a, key, root)
            calls = []
            result = {"checks": {"restoration": True, "matrix": True, "bindings": True}, "verified": True, "planned": 6, "retained": 6}
            real_run_command = supervisor.run_command
            def command(cmd, log, timeout=None, study=None, kind=None, repeat=None, cohort=None, planned=None):
                calls.append([str(x) for x in cmd])
                if kind == "generate":
                    return real_run_command([sys.executable, "-B", self.fake, cohort, "cooperative", "3", "2", "0.05"],
                                            log, study=study, kind=kind, repeat=repeat, cohort=cohort, planned=planned)
                log.write_text("private output")
            observed = {}
            def watch():
                deadline = time.time() + 15
                while time.time() < deadline:
                    try:
                        progress = runner.load(a.output / "progress.json")
                    except Exception:
                        time.sleep(0.02); continue
                    if progress.get("command") == "generate" and progress.get("retained", 0) >= 1 and isinstance(progress.get("child"), dict):
                        report = supervisor.status_report(a.output, stale_after=60)
                        committed = supervisor.committed_records(a.output / "r0")
                        observed.update(progress=progress, report=report, committed=committed)
                        return
                    time.sleep(0.02)
            watcher = threading.Thread(target=watch); watcher.start()
            try:
                with patch.object(supervisor, "preflight", return_value=(m, m, [], [root], [])), \
                     patch.object(supervisor, "run_command", side_effect=command), \
                     patch.object(supervisor, "read_command", return_value="a" * 40), \
                     patch.object(audit, "audit", return_value=result), \
                     patch.object(supervisor, "PROGRESS_INTERVAL_S", 0.05), \
                     patch.object(supervisor, "CANCEL_SETTLE_S", 5.0):
                    with self.assertRaises(supervisor.StudyInterrupted):
                        supervisor.execute(a)
            finally:
                watcher.join()
            # r1 generation never started and grading never started after interrupted generation.
            self.assertEqual(sum(any(x.endswith("native-pi-qwen.ts") for x in c) for c in calls), 1)
            self.assertFalse(any("grade" in c for c in calls))
            # While the fake child ran, status identified generation and cohort and counted only committed records.
            self.assertTrue(observed)
            self.assertEqual(observed["report"]["observation"], "live")
            self.assertEqual((observed["report"]["command"], observed["report"]["repeat"], observed["report"]["cohort"]),
                             ("generate", 0, "r0"))
            self.assertGreaterEqual(observed["report"]["retained"], 1)
            self.assertLessEqual(observed["report"]["retained"], observed["committed"])
            self.assertEqual(observed["report"]["child_pid"], observed["progress"]["child"]["pid"])
            state = runner.load(a.output / "study.json")
            self.assertEqual(state["outcome"], "incomplete")
            self.assertEqual(state["phase"], "prepared")  # the milestone never advanced on progress or interruption
            self.assertEqual(state["interrupted"]["restoration"]["state"], "restored")
            final = supervisor.status_report(a.output, stale_after=60)
            self.assertEqual((final["observation"], final["cause"], final["restoration"]),
                             ("failed", "operator-signal", "restored"))
            self.assert_records_byte_identical(a.output / "r0", 2)


class StatusTests(unittest.TestCase):
    """The #170 bounded status observation: fixed scalars, explicit stale/unknown, never claimed liveness."""

    def setUp(self):
        supervisor._INTERRUPT.clear()

    def tearDown(self):
        supervisor._INTERRUPT.clear()

    def study_root(self, root, outcome="running", interrupted=None, phase="prepared"):
        directory = Path(root) / "study"
        directory.mkdir(parents=True)
        state = {"schema": "agent-hub.native-study/v1", "owner": {"pid": os.getpid(), "id": "test-owner"},
                 "phase": phase, "outcome": outcome, "expected": 6, "history": []}
        if interrupted:
            state["interrupted"] = interrupted
        runner.dump(directory / "study.json", state)
        return directory

    def progress(self, root, **over):
        started = supervisor.ps_fields(os.getpid())[0]
        record = {"schema": "agent-hub.native-study-progress/v1", "command": "generate", "repeat": 0,
                  "planned": 3, "retained": 1, "updated": time.time(),
                  "child": {"pid": os.getpid(), "started": started, "pgid": os.getpid()},
                  "supervisor": {"pid": os.getpid(), "id": "test-owner"}}
        record.update(over)
        runner.dump(Path(root) / "progress.json", record)
        return record

    def test_live_observation_and_status_cli(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study_root(Path(d))
            record = self.progress(root)
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "live")
            self.assertEqual((report["command"], report["repeat"], report["cohort"]), ("generate", 0, "r0"))
            self.assertEqual((report["retained"], report["planned"]), (1, 3))
            self.assertEqual(report["child_pid"], os.getpid())
            self.assertLess(report["age_s"], 5)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(supervisor.main(["status", "--output", str(root)]), 0)
            cli = json.loads(out.getvalue())
            self.assertEqual(cli["observation"], "live")
            # Fixed scalar fields only; nothing parsed from model or evaluator output.
            self.assertEqual(set(cli), {"schema", "phase", "outcome", "observation", "command", "cohort",
                                        "repeat", "planned", "retained", "updated", "age_s", "child_pid"})

    def test_grading_is_identified_without_exposing_scores(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study_root(Path(d), outcome="running")
            self.progress(root, command="grade", repeat=1)
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "live")
            self.assertEqual((report["command"], report["cohort"]), ("grade", "r1"))
            self.assertNotIn("score", json.dumps(report))
            self.assertNotIn("pass", json.dumps(report))

    def test_crash_stall_pid_reuse_and_unreadable_are_explicit_unknown_or_stale(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            # Crash: the study claims to run but no progress was ever recorded.
            root = self.study_root(base / "crash")
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "no-progress-record"))
            # Unreadable observation.
            root = self.study_root(base / "unreadable")
            (root / "progress.json").write_text("not json")
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "progress-unreadable"))
            # Malformed scalars.
            root = self.study_root(base / "malformed")
            self.progress(root, retained="lots")
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "progress-malformed"))
            # A sidecar left by another study.
            root = self.study_root(base / "owner")
            self.progress(root, supervisor={"pid": os.getpid(), "id": "someone-else"})
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "progress-owner-mismatch"))
            # Stalled update: the progress timestamp is too old to mean liveness.
            root = self.study_root(base / "stalled")
            self.progress(root, updated=time.time() - 1000)
            report = supervisor.status_report(root, stale_after=10)
            self.assertEqual((report["observation"], report["reason"]), ("stalled", "progress-stalled"))
            # Pid reuse: the recorded pid lives again under a different start time.
            root = self.study_root(base / "reused")
            self.progress(root, child={"pid": os.getpid(), "started": "Mon Jan  1 00:00:00 1990", "pgid": os.getpid()})
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "child-identity-mismatch"))
            # The recorded child is gone while the study still claims to run: never completion.
            root = self.study_root(base / "gone")
            gone = subprocess.Popen(["true"]); gone.wait()
            self.progress(root, child={"pid": gone.pid, "started": "Mon Jan  1 00:00:00 1990", "pgid": gone.pid})
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "unknown")
            self.assertIn(report["reason"], ("child-not-running", "child-identity-mismatch"))
            # Between commands the fresh sidecar has no child: still not liveness.
            root = self.study_root(base / "between")
            self.progress(root, child=None)
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "no-child-recorded"))

    def test_completed_and_failed_work_are_distinguished_from_observation(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            root = self.study_root(base / "done", outcome="complete", phase="sealed")
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "completed")
            self.assertEqual(report["coverage"], {"available": False, "reason": "final-audit-missing"})
            root = self.study_root(base / "genonly", outcome="generation-only")
            self.assertEqual(supervisor.status_report(root)["observation"], "completed")
            record = {"phase": "generated", "command": "generate", "repeat": 1, "cause": "operator-signal",
                      "signal": "SIGTERM", "restoration": {"state": "restoration_failed"}}
            root = self.study_root(base / "failed", outcome="incomplete", interrupted=record)
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "failed")
            self.assertEqual((report["cause"], report["interrupted_phase"], report["restoration"]),
                             ("operator-signal", "generated", "restoration_failed"))
            root = self.study_root(base / "weird", outcome="running")
            runner.dump(root / "study.json", {"schema": "agent-hub.native-study/v1", "owner": {"id": "x"}, "outcome": "mystery"})
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "study-state-malformed"))
            missing = Path(d) / "missing"
            report = supervisor.status_report(missing)
            self.assertEqual((report["observation"], report["reason"]), ("unknown", "study-state-unreadable"))

    def test_status_metadata_is_fixed_and_deep_json_returns_unknown(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.study_root(Path(d), outcome="complete", phase="sealed")
            for field in ("phase", "outcome"):
                for private in ("/private/SECRET", {"PRIVATE": ["hidden"]}):
                    state = {"phase": "sealed", "outcome": "complete", field: private}
                    runner.dump(root / "study.json", state)
                    report = supervisor.status_report(root)
                    self.assertEqual(report, {"schema": supervisor.STATUS_SCHEMA,
                                              "observation": "unknown", "reason": "study-state-malformed"})
            with patch.object(audit, "_coverage_read", side_effect=RecursionError("PRIVATE")):
                self.assertEqual(supervisor.status_report(root)["reason"], "study-state-unreadable")
            runner.dump(root / "study.json", {"phase": "generated", "outcome": "incomplete",
                        "interrupted": {"phase": {"PRIVATE": "hidden"}, "cause": "/private/SECRET",
                                        "restoration": {"state": ["hidden"]}}})
            report = supervisor.status_report(root)
            self.assertEqual((report["interrupted_phase"], report["cause"], report["restoration"]),
                             ("unknown", "unknown", "unknown"))
            (root / "study.json").write_text("[" * 2000 + "0" + "]" * 2000)
            self.assertEqual(supervisor.status_report(root)["reason"], "study-state-unreadable")
            runner.dump(root / "study.json", {"phase": "prepared", "outcome": "running", "owner": {"id": "test-owner"}})
            (root / "progress.json").write_text("[" * 2000 + "0" + "]" * 2000)
            self.assertEqual(supervisor.status_report(root)["reason"], "progress-unreadable")
            for update in ({"updated": float("nan")}, {"updated": float("inf")},
                           {"updated": 10 ** 1000}, {"repeat": 10 ** 1000}, {"supervisor": []}):
                self.progress(root, **update)
                report = supervisor.status_report(root)
                self.assertEqual(report["observation"], "unknown")
                self.assertNotIn("PRIVATE", json.dumps(report, allow_nan=False))

    def sealed_root(self, root, **counts):
        """A complete synthetic seal, including unique planned cells and bound metadata."""
        directory = self.study_root(root, outcome="complete")
        state = runner.load(directory / "study.json")
        state["phase"] = "sealed"
        runner.dump(directory / "study.json", state)
        audit_counts = {"planned": 60, "retained": 60, "scored": 59, "passed": 32, "unavailable": 1,
                        "missing": 0, "controls_verified": 40, "owned_identities": 3, "live_owned_matches": 0}
        audit_counts.update(counts)
        manifest = runner.load(SCRIPTS / "manifest-v3-pi-qwen.json")
        runner.dump(directory / "runtime-manifest.json", manifest)
        cells = [{"case": case, "arm": arm, "repeat": rep,
                  "status": "scored" if n < 59 else "unavailable", "passed": n < 32,
                  "record_sha256": "a" * 64} for n, (case, arm, rep) in enumerate(sorted(audit.matrix(manifest)))]
        runner.dump(directory / "safe-aggregate.json",
                    {"schema": audit.SCHEMA, "verified": True,
                     "checks": {key: True for key in audit.COVERAGE_AUDIT_CHECKS}, "cells": cells, **audit_counts})
        self.ledger(directory, ["completed"] * 60)
        return directory

    @staticmethod
    def seal_index(root):
        runner.dump(Path(root) / "private-evidence-hashes.json", [
            {"artifact": name, "sha256": runner.file_sha(Path(root) / name)}
            for name in ("safe-aggregate.json", "runtime-manifest.json", "pooled-ledger.log")
            if (Path(root) / name).is_file()])

    def ledger(self, root, reasons):
        keys = sorted(audit.matrix(runner.load(Path(root) / "runtime-manifest.json")))
        rows = [{"case": case, "arm": arm, "repeat": rep, "end_reason": reason}
                for (case, arm, rep), reason in zip(keys, reasons)]
        runner.dump(Path(root) / "pooled-ledger.log", {"rows": rows})
        self.seal_index(root)

    def test_sealed_completion_reports_recorded_coverage_independent_of_lifecycle(self):
        with tempfile.TemporaryDirectory() as d:
            root = self.sealed_root(Path(d))
            self.ledger(root, ["completed"] * 52 + ["peer-failure"] * 7 + ["infrastructure-error"])
            report = supervisor.status_report(root)
            self.assertEqual((report["observation"], report["phase"], report["outcome"]),
                             ("completed", "sealed", "complete"))
            coverage = report["coverage"]
            self.assertTrue(coverage["available"])
            # Recorded at seal; status performed no fresh audit, recompute or process check for these counts.
            self.assertEqual((coverage["provenance"], coverage["fresh_verification"]),
                             ("recorded-at-seal", False))
            # The availability denominator is reported independently of lifecycle completion.
            self.assertEqual((coverage["planned"], coverage["retained"], coverage["scored"],
                              coverage["unavailable"], coverage["missing"], coverage["passed"]),
                             (60, 60, 59, 1, 0, 32))
            # Native end classes reconcile with the retained records; a partial peer-failure keeps its class.
            self.assertEqual(sum(coverage["end_reasons"].values()), 60)
            self.assertEqual((coverage["end_reasons"]["completed"], coverage["end_reasons"]["peer-failure"],
                              coverage["end_reasons"]["infrastructure-error"]), (52, 7, 1))
            self.assertEqual(coverage["audit"], {"verified": True, "controls_verified": 40,
                                                 "checks": {key: True for key in audit.COVERAGE_AUDIT_CHECKS}})
            self.assertEqual(coverage["restoration"], {"verified": True, "owned_identities": 3,
                                                       "live_owned_matches": 0})
            self.assertEqual(set(coverage), {"available", "provenance", "fresh_verification", "planned",
                                             "retained", "scored", "passed", "unavailable", "missing",
                                             "end_reasons", "audit", "restoration"})
            self.assertEqual(set(coverage["end_reasons"]), set(audit.SUMMARY_END_REASONS))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(supervisor.main(["status", "--output", str(root)]), 0)
            cli = json.loads(out.getvalue())
            self.assertEqual(set(cli), {"schema", "phase", "outcome", "observation", "coverage"})
            self.assertNotIn("PRIVATE", json.dumps(cli))
            # An end class outside the fixed summary classes stays visible under "other", never relabelled.
            self.ledger(root, ["completed"] * 58 + ["peer-failure", "unrecorded-novel-class"])
            coverage = supervisor.status_report(root)["coverage"]
            self.assertEqual((coverage["end_reasons"]["completed"], coverage["end_reasons"]["peer-failure"],
                              coverage["end_reasons"]["other"]), (58, 1, 1))

    def test_terminal_coverage_is_explicit_unavailable_never_fabricated(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)

            def reason(root):
                # These fixtures declare malformed data at seal; post-seal tampering is tested separately.
                self.seal_index(root)
                coverage = supervisor.status_report(root)["coverage"]
                self.assertEqual(set(coverage), {"available", "reason"})  # no count is ever fabricated
                self.assertFalse(coverage["available"])
                return coverage["reason"]

            root = self.sealed_root(base / "missing")
            (root / "safe-aggregate.json").unlink()
            self.assertEqual(reason(root), "final-audit-missing")
            root = self.sealed_root(base / "unreadable")
            (root / "safe-aggregate.json").write_text("not json")
            self.assertEqual(reason(root), "final-audit-unreadable")
            root = self.sealed_root(base / "schema")
            sealed = runner.load(root / "safe-aggregate.json")
            sealed["schema"] = "other-schema"
            runner.dump(root / "safe-aggregate.json", sealed)
            self.assertEqual(reason(root), "final-audit-malformed")
            root = self.sealed_root(base / "unverified")
            sealed = runner.load(root / "safe-aggregate.json")
            sealed["verified"] = False
            runner.dump(root / "safe-aggregate.json", sealed)
            self.assertEqual(reason(root), "final-audit-unverified")
            root = self.sealed_root(base / "check")
            sealed = runner.load(root / "safe-aggregate.json")
            sealed["checks"]["restoration"] = False  # a failed recorded check is never claimed as success
            runner.dump(root / "safe-aggregate.json", sealed)
            self.assertEqual(reason(root), "final-audit-unverified")
            root = self.sealed_root(base / "counts", scored=60)  # 60 + 1 + 0 != 60 planned
            self.assertEqual(reason(root), "coverage-inconsistent")
            root = self.sealed_root(base / "shape", scored="59")
            self.assertEqual(reason(root), "final-audit-malformed")
            root = self.sealed_root(base / "noledger")
            (root / "pooled-ledger.log").unlink()
            self.assertEqual(reason(root), "ledger-missing")
            root = self.sealed_root(base / "badledger")
            (root / "pooled-ledger.log").write_text("not json")
            self.assertEqual(reason(root), "ledger-unreadable")
            root = self.sealed_root(base / "rowsledger")
            runner.dump(root / "pooled-ledger.log", {"rows": "lots"})
            self.assertEqual(reason(root), "ledger-malformed")
            root = self.sealed_root(base / "shortledger")
            self.ledger(root, ["completed"] * 59)  # 59 rows != 60 retained - 0 missing
            self.assertEqual(reason(root), "coverage-inconsistent")

    def test_pending_and_unsealed_work_never_infers_final_coverage(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            root = self.study_root(base / "genonly", outcome="generation-only")
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "completed")
            self.assertEqual(report["coverage"], {"available": False, "reason": "study-not-sealed"})
            # Pending generation/evaluation: no final score, qualification or coverage is inferred.
            root = self.study_root(base / "running")
            self.progress(root)
            report = supervisor.status_report(root)
            self.assertEqual(report["observation"], "live")
            self.assertNotIn("coverage", report)
            record = {"phase": "generated", "command": "generate", "repeat": 1, "cause": "operator-signal",
                      "signal": "SIGTERM", "restoration": {"state": "restored"}}
            root = self.study_root(base / "failed", outcome="incomplete", interrupted=record)
            self.assertNotIn("coverage", supervisor.status_report(root))


if __name__ == "__main__":
    unittest.main()

