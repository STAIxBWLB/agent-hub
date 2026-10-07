#!/usr/bin/env python3
"""Bounded native v3 study. Fresh durable roots only; no resume or quality-selected retry.

Interruption contract (#168). Every study child runs in its own process group with its verified identity recorded
(pid, start time, pgid). On SIGINT/SIGTERM the supervisor forwards the signal to that identity only when it still
matches at signal time — a reused or exited pid is never signalled, and neither is any process the supervisor did
not spawn — then waits bounded for the child's own finally-block restoration. A cohort counts as restored only
when restoration.json says restored AND restoration-ledger.json agrees and no recorded actor still runs, never
from process absence alone. A child that ignores cancellation is SIGKILLed only after its identity is re-verified;
the maintained restore.ts recovery then runs once, and cleanup that cannot be proven is recorded as an explicit
restoration failure. The interruption (phase, cause classification, signal, per-cohort restoration) is persisted
to study.json before the supervisor exits incomplete. Outcomes by phase: an interrupted preparation needs no
restoration (nothing is locked yet), an interrupted generation restores its cohort or records the failure, and an
interrupted grading re-verifies the already-restored cohort. Grading never starts after interrupted or incomplete
generation; there is no resume, no retry and no root reuse, and recorded cells are never modified.

Operational progress (#170). progress.json is a sidecar separate from the verified milestone phase in study.json
and carries fixed scalars only: command kind (prepare/generate/grade), repeat ordinal, retained vs planned
committed run records, an updated timestamp and the verified current child identity. It never advances a
milestone. `status --output ROOT` prints those scalars from recorded artifacts: completed and failed studies
report their recorded outcome; a running study reports live only while its progress update is fresh and the
child's pid and start time still match. A crash (no or stalled progress), a stalled update, a reused pid and an
unreadable observation all report explicit unknown/stalled, never claimed liveness or completion. Status launches
nothing, recovers nothing and reads no model or evaluator output.

Terminal coverage (#180). A completed study additionally reports bounded coverage composed from the sealed
evidence (the recorded final audit and pooled ledger): planned/retained/scored/passed/unavailable/missing over
the planned denominator, the fixed native end-class counts and the recorded audit/restoration result, marked
recorded-at-seal with no fresh verification performed. Lifecycle completion, quality availability and test
passing stay separate; missing, unreadable or inconsistent final evidence reports an explicit unavailable
coverage, never a fabricated zero.
"""
from __future__ import annotations
import argparse, copy, json, math, os, re, shutil, signal, subprocess, sys, tempfile, time, uuid
from pathlib import Path
import runner
import study_audit

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PHASES = ("claimed", "prepared", "generated", "restored", "graded", "sealed")

PROGRESS_SCHEMA = "agent-hub.native-study-progress/v1"
STATUS_SCHEMA = "agent-hub.native-study-status/v1"
COMMAND_KINDS = ("prepare", "generate", "grade")
PROGRESS_INTERVAL_S = 15.0   # progress.json refresh while a child runs; also the liveness cadence
STALE_AFTER_S = 120.0        # status: a running study whose progress is older is stalled, never live
CANCEL_SETTLE_S = 900.0      # a native child's finally-block restoration may outlast one attempt's teardown
FALLBACK_SETTLE_S = 10.0     # a SIGKILLed group dies at once
RECOVERY_TIMEOUT_S = 300.0   # one bounded restore.ts attempt per unrestored cohort

_INTERRUPT = []              # signal numbers received, in order; the handlers only record


class StudyInterrupted(Exception):
    """An operator signal stopped the study; the incomplete state was persisted before this is raised."""


def _note_interrupt(signum, frame):
    _INTERRUPT.append(signum)


class interrupt_handlers:
    """SIGINT/SIGTERM only record the signal: the command loop chooses when cancellation is safe to run."""

    def __enter__(self):
        self.previous = {}
        for sig in (signal.SIGINT, signal.SIGTERM):
            self.previous[sig] = signal.signal(sig, _note_interrupt)
        return self

    def __exit__(self, *exc):
        for sig, handler in self.previous.items():
            signal.signal(sig, handler)
        return False


def check_interrupt():
    if _INTERRUPT:
        raise StudyInterrupted(f"study interrupted by {signal.Signals(_INTERRUPT[0]).name}")


_PS_ROW = re.compile(r"^\s*(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\d+)\s*$")


def ps_fields(pid):
    """(start time, process group) of a live process, or None; bounded and never raises."""
    try:
        p = subprocess.run(["ps", "-o", "lstart=,pgid=", "-p", str(pid)], capture_output=True, text=True,
                           env={**os.environ, "LC_ALL": "C", "TZ": "UTC"}, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if p.returncode:
        return None
    match = _PS_ROW.match(p.stdout)
    return (match[1], int(match[2])) if match else None


class Child:
    """One spawned study command and the identity that proves a later signal reaches exactly that process."""

    def __init__(self, cmd, log):
        self.cmd = [str(x) for x in cmd]
        self.log = Path(log)
        self.proc = None
        self.out = None
        self.pid = None
        self.started = None
        self.pgid = None

    def spawn(self):
        self.out = self.log.open("xb")
        os.chmod(self.log, 0o600)
        try:
            self.proc = subprocess.Popen(self.cmd, cwd=REPO, stdout=self.out, stderr=subprocess.STDOUT,
                                         start_new_session=True)
        except Exception:
            self.out.close()
            raise
        self.pid = self.proc.pid
        ident = ps_fields(self.pid)
        if ident is None:
            # Without a verified identity no later signal can be safe. The unreaped child still holds its pid,
            # so killing it by the Popen handle cannot reach a recycled process.
            try:
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.out.close()
            raise runner.BenchError("spawned child identity unreadable")
        self.started, self.pgid = ident

    def identity(self):
        return {"pid": self.pid, "started": self.started, "pgid": self.pgid}

    def current(self):
        """The recorded identity still names a live process; verified again at every signal time."""
        return ps_fields(self.pid) == (self.started, self.pgid)

    def signal_group(self, sig):
        """Signal only the verified current identity, with its group when it leads one. A reused pid, an exited
        child and anything the supervisor did not spawn return False and are never signalled.
        ponytail: the identity re-read and the signal are two syscalls, so a group recycled in that window
        cannot be excluded; teardown.ts accepts the same 'identities read again just before' ceiling. Upgrade
        path: descriptor-rooted process handles if the platform gains a portable one."""
        if not self.current():
            return False
        try:
            if self.pgid == self.pid:
                os.killpg(self.pgid, sig)
            else:
                os.kill(self.pid, sig)
            return True
        except OSError:
            return False

    def wait_bounded(self, seconds):
        """The exit code, or None when the child is still running after the bound."""
        deadline = time.monotonic() + seconds
        while True:
            try:
                return self.proc.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                if time.monotonic() >= deadline:
                    return None

    def close(self):
        if self.out is not None:
            self.out.close()
            self.out = None


def committed_records(cohort):
    """Only fully committed run records count: a record the native runner is still writing never does."""
    if cohort is None:
        return 0
    try:
        names = sorted((Path(cohort) / "runs").glob("*.json"))
    except OSError:
        return 0
    count = 0
    for name in names:
        try:
            if isinstance(runner.load(name), dict):
                count += 1
        except (OSError, ValueError):
            continue
    return count


def verify_restoration(cohort):
    """A cohort is restored only when restoration.json says so AND the ledger agrees AND no recorded actor runs."""
    try:
        live = study_audit.process_identities()
        ok, owned, matches = study_audit.restoration_ok(cohort, live)
    except (OSError, ValueError, runner.BenchError) as e:
        return {"state": "unknown", "detail": f"restoration state unreadable: {type(e).__name__}"}
    state = "restored" if ok else "unrestored"
    return {"state": state, "owned_identities": owned, "live_matches": matches}


def recover_cohort(cohort, log):
    """The maintained #113 recovery, once, bounded; never --runner-exited: the ledger names the runner and the
    recovery itself refuses to act while anything recorded still runs."""
    try:
        with log.open("xb") as out:
            os.chmod(log, 0o600)
            p = subprocess.run(["bun", HERE / "restore.ts", "--run", cohort], cwd=REPO,
                               stdout=out, stderr=subprocess.STDOUT, timeout=RECOVERY_TIMEOUT_S)
        return {"attempted": True, "recovered": p.returncode == 0}
    except (OSError, subprocess.SubprocessError) as e:
        return {"attempted": True, "recovered": False, "detail": type(e).__name__}


def settle_after_exit(cohort, kind, root, proven_dead):
    """One cohort's restoration status after its child ended: the verified marker+ledger, one bounded recovery,
    or an explicit failure. Process absence alone never counts as restored."""
    if cohort is None or kind == "prepare":
        return {"state": "not-applicable"}
    state = verify_restoration(cohort)
    if state["state"] == "restored":
        return state
    if not proven_dead:
        return {"state": "restoration_failed", "detail": "the child is not proven dead; recovery was not attempted",
                "verification": state, "recovery": {"attempted": False}}
    recovery = recover_cohort(cohort, Path(root) / f"recovery-{cohort.name}.log")
    final = verify_restoration(cohort)
    if final["state"] == "restored":
        final["recovery"] = recovery
        return final
    return {"state": "restoration_failed",
            "detail": "restoration state unreadable" if final["state"] == "unknown"
                      else "marker and ledger still disagree or a recorded actor still runs",
            "verification": final, "recovery": recovery}


def settle_cohorts(cohorts, root):
    """Except-path interruption: no child is running here, so every cohort that owes restoration is verified,
    with one bounded recovery each. A cohort without a runner marker locked nothing (#120)."""
    states = {}
    for cohort in cohorts:
        if not (cohort / "restoration.json").exists() and not (cohort / "restoration-ledger.json").exists():
            continue
        states[cohort.name] = settle_after_exit(cohort, "generate", root, proven_dead=True)
    if not states:
        return {"state": "not-applicable", "cohorts": {}}
    restored = all(s["state"] == "restored" for s in states.values())
    return {"state": "restored" if restored else "restoration_failed", "cohorts": states}


def interruption_record(study, kind, repeat, cohort, signum, child):
    return {"phase": study.state["phase"], "command": kind, "repeat": repeat,
            "cohort": cohort.name if cohort is not None else None,
            "cause": "operator-signal", "signal": signal.Signals(signum).name, "at": time.time(),
            "child": child.identity() if child is not None else None}


def interrupt_protocol(child, signum, study, kind, repeat, cohort):
    """Cancel the verified current child, wait bounded for its own restoration, then prove it (#168)."""
    record = interruption_record(study, kind, repeat, cohort, signum, child)
    record["cancellation_requested"] = child.signal_group(signum)
    code = child.wait_bounded(CANCEL_SETTLE_S)
    if code is None:
        # The child ignored cancellation: the fallback re-verifies the identity inside signal_group and kills
        # only what is proven current and owned.
        record["fallback"] = "sigkill-after-cancel-timeout"
        record["fallback_kill_sent"] = child.signal_group(signal.SIGKILL)
        code = child.wait_bounded(FALLBACK_SETTLE_S)
    else:
        record["fallback"] = None
    record["child_exited"] = code is not None
    record["exit_code"] = code
    record["restoration"] = settle_after_exit(cohort, kind, study.root, proven_dead=code is not None)
    return record


def tracked_command(cmd, log, study, kind, repeat, cohort, planned, timeout=None):
    """Run one study command with progress updates and the #168 interruption contract."""
    check_interrupt()
    child = Child(cmd, log)
    child.spawn()
    try:
        def note():
            study.progress(kind, repeat, planned, committed_records(cohort), child.identity())
        note()
        deadline = None if timeout is None else time.monotonic() + timeout
        code = None
        while code is None:
            try:
                code = child.proc.wait(timeout=PROGRESS_INTERVAL_S)
            except subprocess.TimeoutExpired:
                note()
                if _INTERRUPT:
                    record = interrupt_protocol(child, _INTERRUPT[0], study, kind, repeat, cohort)
                    study.fail(record)
                    raise StudyInterrupted(f"study interrupted by {record['signal']}")
                if deadline is not None and time.monotonic() >= deadline:
                    child.signal_group(signal.SIGKILL)
                    child.wait_bounded(FALLBACK_SETTLE_S)
                    raise runner.BenchError("study command timed out; private log retained")
        if _INTERRUPT:
            # The signal landed as the child settled on its own: no cancellation was needed, and the study still
            # exits incomplete — an interrupted study never continues to the next command.
            record = interruption_record(study, kind, repeat, cohort, _INTERRUPT[0], child)
            record.update(cancellation_requested=False, fallback=None, child_exited=True, exit_code=code,
                          restoration=settle_after_exit(cohort, kind, study.root, proven_dead=True))
            study.fail(record)
            raise StudyInterrupted(f"study interrupted by {record['signal']}")
        if code:
            raise runner.BenchError("study command failed; private log retained")
    finally:
        child.close()


def run_command(cmd, log, timeout=None, study=None, kind=None, repeat=None, cohort=None, planned=None):
    """Native/evaluator output belongs only to the private bundle."""
    if study is not None:
        return tracked_command(cmd, log, study, kind, repeat, cohort, planned, timeout)
    with log.open("xb") as out:
        os.chmod(log, 0o600)
        completed = subprocess.run([str(x) for x in cmd], cwd=REPO, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
    if completed.returncode:
        raise runner.BenchError("study command failed; private log retained")


def bind_manifest(original, version, allowed=False):
    runtime = copy.deepcopy(original)
    mismatch = runtime.get("hub_version") != version or runtime.get("versions", {}).get("hub") != version
    if mismatch and not allowed:
        raise runner.BenchError("hub version mismatch requires explicit binding")
    amendments = []
    if mismatch:
        for key in ("hub_version", "versions.hub"):
            previous = runtime.get("hub_version") if key == "hub_version" else runtime.get("versions", {}).get("hub")
            amendments.append({"field": key, "from": previous, "to": version})
        runtime["hub_version"] = version
        runtime.setdefault("versions", {})["hub"] = version
    runner.validate_manifest(runtime)
    return runtime, amendments


def read_command(cmd, env=None):
    p = subprocess.run([str(x) for x in cmd], cwd=REPO, capture_output=True, text=True, env=env, timeout=60)
    if p.returncode:
        raise runner.BenchError("prerequisite command unavailable")
    return p.stdout.strip()


def preflight(a):
    """No fixtures, output roots, services or model calls are mutated here."""
    for key, value in vars(a).items():
        # A virtualenv interpreter is often a symlink; resolving its target loses that environment.
        if isinstance(value, Path): setattr(a, key, Path(os.path.abspath(value)) if key == "python" else value.resolve())
        elif isinstance(value, list) and all(isinstance(x, Path) for x in value):
            setattr(a, key, [x.resolve() for x in value])
    original = runner.load(a.manifest)
    version = runner.load(REPO / "package.json")["version"]
    m, amendments = bind_manifest(original, version, a.bind_current_hub)
    study_audit.matrix(m, a.plan)
    output = a.output.resolve()
    if output == REPO or REPO in output.parents or output.exists():
        raise runner.BenchError("durable output must be fresh and outside repository")
    temp = Path(tempfile.gettempdir()).resolve()
    if output == temp or temp in output.parents:
        raise runner.BenchError("study output cannot be temporary")
    if not output.parent.is_dir():
        raise runner.BenchError("durable parent must already exist")
    for binary in ("bun", "git", "node", "docker", "ps"):
        if not shutil.which(binary): raise runner.BenchError("required executable missing")
    for path in (a.upstream_root, a.private_inputs, a.archives, a.qwen_package):
        if not path.is_dir(): raise runner.BenchError("required directory missing")
    if not (a.qwen_package / "cli.js").is_file() or not a.probe_target.is_file():
        raise runner.BenchError("required package or probe missing")
    protect = [p.resolve() for p in a.protect]
    if not protect or any(not p.exists() for p in protect):
        raise runner.BenchError("required protected root missing")
    optional = [{"path": str(p.resolve()), "present": p.exists()} for p in a.optional_protect]
    protect += [p.resolve() for p in a.optional_protect if p.exists()]
    all_protected = protect + [a.private_inputs.resolve(), a.upstream_root.resolve()]
    probe = a.probe_target.resolve()
    if not any(probe == p or p in probe.parents for p in all_protected):
        raise runner.BenchError("probe must belong to a protected input")
    if any(output == p or p in output.parents or output in p.parents for p in all_protected):
        raise runner.BenchError("study output and protected roots overlap")
    if read_command(["git", "-C", a.upstream_root, "rev-parse", "HEAD"]) != m["upstream"]["commit"]:
        raise runner.BenchError("upstream pin mismatch")
    for i, c in enumerate(m["cases"]):
        archive = a.archives / f"{c['repo']}-{c['task']}.tar"
        if runner.file_sha(archive) != c["archive_sha256"]: raise runner.BenchError("archive pin mismatch")
        private_case = a.private_inputs / f"case-{i:02d}.json"
        d = runner.load(private_case)
        if (d.get("repo"), d.get("task"), d.get("features")) != (c["repo"], c["task"], c["features"]):
            raise runner.BenchError("private case identity mismatch")
        if [runner.sha(x.encode()) for x in d.get("prompts", [])] != c["prompt_sha256"]:
            raise runner.BenchError("private prompt pin mismatch")
        image = json.loads(read_command(["docker", "image", "inspect", c["image_digest"]]))
        if c["image_digest"] not in image[0].get("RepoDigests", []):
            raise runner.BenchError("pinned evaluation image unavailable")
    # The final native driver repeats these checks in the actual isolation profile per arm.
    config = read_command(["bun", "-e", "import {loadConfig} from './src/hub/daemon.ts'; console.log(JSON.stringify(loadConfig(process.cwd()).pi.cmd))"])
    pi_cmd = json.loads(config)
    pv = read_command([*pi_cmd, "--version"])
    with tempfile.TemporaryDirectory(prefix="ahub-study-version-") as home:
        env = {**os.environ, "QWEN_HOME": home, "QWEN_RUNTIME_DIR": home, "TMPDIR": home}
        qv = read_command(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "node", "--expose-gc", a.qwen_package / "cli.js", "--version"], env)
    for actor, value in (("pi", pv), ("qwen", qv)):
        found = re.search(r"\b\d+\.\d+\.\d+\b", value)
        if not found or found[0] != m["versions"][actor]: raise runner.BenchError("effective native version mismatch")
    # Require live evaluator runtime and service; this command never starts shared services.
    probe_python = "import sys,types,pathlib; p=pathlib.Path(sys.argv[1])/'src'/'cooperbench'; "
    probe_python += "[(sys.modules.setdefault(n,types.ModuleType(n)), setattr(sys.modules[n],'__path__',[str(q)])) for n,q in [('cooperbench',p),('cooperbench.eval',p/'eval'),('cooperbench.runner',p/'runner')]]; "
    probe_python += "from cooperbench.eval.sandbox import test_solo"
    if not a.python.is_file(): raise runner.BenchError("evaluator Python runtime unavailable")
    read_command([a.python, "-B", "-c", probe_python, a.upstream_root.resolve()])
    study_audit.process_identities()
    return original, m, amendments, protect, optional


class Study:
    def __init__(self, root, expected, plan="study"):
        root.mkdir(mode=0o700)  # atomic claim; an existing incomplete root is never reused
        self.root = root
        self.state = {"schema": "agent-hub.native-study/v1", "owner": {"pid": os.getpid(), "id": str(uuid.uuid4())},
                      "phase": "claimed", "outcome": "running", "expected": expected, "plan": plan, "history": []}
        self.save()

    def save(self):
        runner.dump(self.root / "study.json", self.state)
        os.chmod(self.root / "study.json", 0o600)

    def advance(self, phase):
        if PHASES.index(phase) != PHASES.index(self.state["phase"]) + 1:
            raise runner.BenchError("invalid study phase transition")
        self.state["phase"] = phase
        self.state["history"].append({"phase": phase, "at": time.time()})
        self.save()

    def fail(self, record=None):
        if record is not None:
            self.state["interrupted"] = record
        self.state["outcome"] = "incomplete"
        self.save()

    def progress(self, command, repeat, planned, retained, child):
        """Operational scalars only (#170); the verified milestone phase in study.json never reads this."""
        record = {"schema": PROGRESS_SCHEMA, "command": command, "repeat": repeat, "planned": planned,
                  "retained": retained, "updated": time.time(), "child": child, "supervisor": self.state["owner"]}
        runner.dump(self.root / "progress.json", record)
        os.chmod(self.root / "progress.json", 0o600)


def execute(a):
    original, runtime, amendments, protect, optional = preflight(a)
    spec = runtime["plan"][a.plan]
    root = a.output.resolve()
    cohorts = [root / f"r{r}" for r in range(spec["repeats"])]
    planned = len(spec["cases"]) * len(runtime["arms"])
    study = Study(root, spec["attempts"], a.plan)
    with interrupt_handlers():
        try:
            study_audit.write_new(root / "original-manifest.json", original)
            study_audit.write_new(root / "runtime-manifest.json", runtime)
            provenance = {"original_sha256": runner.file_sha(a.manifest),
                          "original_copy_sha256": runner.file_sha(root / "original-manifest.json"),
                          "runtime_sha256": runner.file_sha(root / "runtime-manifest.json"), "amendments": amendments,
                          "source_head": read_command(["git", "rev-parse", "HEAD"]),
                          "supervisor_sha256": runner.file_sha(Path(__file__)), "auditor_sha256": runner.file_sha(HERE / "study_audit.py"),
                          "optional_protections": optional, "services": {"policy": "require-existing", "started": False},
                          "preparation_additions": {"cases.archive": "resolved pinned archive paths only"},
                          "invocation": vars(a)}
            provenance["invocation"] = {k: str(v) if isinstance(v, Path) else [str(x) for x in v] if isinstance(v, list) else v for k, v in vars(a).items()}
            study_audit.write_new(root / "provenance.json", provenance)
            for rep, cohort in enumerate(cohorts):
                run_command([sys.executable, "-B", HERE / "runner.py", "prepare", "--manifest", root / "runtime-manifest.json",
                             "--output", cohort, "--archives", a.archives, "--upstream-root", a.upstream_root], root / f"prepare-{rep}.log",
                            study=study, kind="prepare", repeat=rep, cohort=cohort, planned=planned)
            check_interrupt()
            study.advance("prepared")
            for rep, cohort in enumerate(cohorts):
                cmd = ["bun", HERE / "native-pi-qwen.ts", "--run", cohort, "--private-inputs", a.private_inputs,
                       "--upstream-root", a.upstream_root, "--probe-target", a.probe_target, "--qwen-package", a.qwen_package,
                       "--cases", ",".join(map(str, spec["cases"])), "--repeat", rep]
                for path in protect: cmd += ["--protect", path]
                run_command(cmd, root / f"generation-{rep}.log",
                            study=study, kind="generate", repeat=rep, cohort=cohort, planned=planned)
            check_interrupt()
            study.advance("generated")
            native = study_audit.audit(cohorts, a.plan, require_grades=False)
            if not native["checks"]["restoration"] or not native["checks"]["matrix"] or not native["checks"]["bindings"]:
                raise runner.BenchError("generation restoration/matrix gates failed")
            study_audit.write_new(root / "generation-audit.json", native)
            check_interrupt()
            study.advance("restored")
            if a.generation_only:
                study.state["outcome"] = "generation-only"; study.save()
                print(json.dumps({"phase": "restored", "planned": native["planned"], "retained": native["retained"], "graded": False}))
                return
            for rep, cohort in enumerate(cohorts):
                run_command([sys.executable, "-B", HERE / "runner.py", "grade", "--run", cohort,
                             "--private-inputs", a.private_inputs, "--upstream-root", a.upstream_root, "--python", a.python], root / f"grade-{rep}.log",
                            study=study, kind="grade", repeat=rep, cohort=cohort, planned=planned)
                run_command([sys.executable, "-B", HERE / "runner.py", "report", "--run", cohort], root / f"report-{rep}.log",
                            study=study, kind="grade", repeat=rep, cohort=cohort, planned=planned)
            check_interrupt()
            study.advance("graded")
            cmd = [sys.executable, "-B", HERE / "ledger.py", "--plan", a.plan, "--json"]
            for cohort in cohorts: cmd += ["--run", cohort]
            run_command(cmd, root / "pooled-ledger.log")
            check_interrupt()
            result = study_audit.audit(cohorts, a.plan)
            if not result["verified"]: raise runner.BenchError("final audit failed")
            study_audit.write_new(root / "safe-aggregate.json", result)
            evidence = [{"artifact": p.relative_to(root).as_posix(), "sha256": runner.file_sha(p)}
                        for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts and "fixtures" not in p.parts and p.name != "study.json"]
            study_audit.write_new(root / "private-evidence-hashes.json", evidence)
            check_interrupt()
            study.advance("sealed")
            study.state["outcome"] = "complete"; study.save()
            print(json.dumps({"phase": "sealed", "planned": result["planned"], "retained": result["retained"], "verified": True}))
        except BaseException:
            if _INTERRUPT and "interrupted" not in study.state:
                # The signal landed between commands; no child is running on this path.
                study.fail({"phase": study.state["phase"], "command": None, "cohort": None,
                            "cause": "operator-signal", "signal": signal.Signals(_INTERRUPT[0]).name,
                            "at": time.time(), "restoration": settle_cohorts(cohorts, root)})
            else:
                study.fail()
            raise


def status_report(root, stale_after=STALE_AFTER_S):
    """Fixed scalar fields from recorded artifacts (#170). Launches and recovers nothing; reads no model or
    evaluator output. Stale or unknown observation is always explicit, never claimed liveness or completion."""
    root = Path(root)
    report = {"schema": STATUS_SCHEMA}
    try:
        state, _ = study_audit._coverage_read(root / "study.json")
        if not isinstance(state, dict):
            raise ValueError("study state is not an object")
    except (OSError, ValueError, RecursionError):
        return {**report, "observation": "unknown", "reason": "study-state-unreadable"}
    phase, outcome = state.get("phase"), state.get("outcome")
    if (not isinstance(phase, str) or phase not in PHASES or
            not isinstance(outcome, str) or outcome not in ("running", "complete", "generation-only", "incomplete")):
        return {**report, "observation": "unknown", "reason": "study-state-malformed"}
    report.update(phase=phase, outcome=outcome)
    if outcome == "complete":
        # Terminal coverage (#180): bounded sealed-evidence counts alongside the lifecycle outcome, so a
        # completed lifecycle never reads as every attempt scoreable or passed. Recorded, never freshly
        # verified; missing or inconsistent evidence is explicit, never a fabricated zero.
        return {**report, "observation": "completed", "coverage": study_audit.terminal_coverage(root)}
    if outcome == "generation-only":
        return {**report, "observation": "completed",
                "coverage": {"available": False, "reason": "study-not-sealed"}}
    if outcome == "incomplete":
        report["observation"] = "failed"
        record = state.get("interrupted")
        if isinstance(record, dict):
            recorded_phase, cause = record.get("phase"), record.get("cause")
            report["interrupted_phase"] = recorded_phase if isinstance(recorded_phase, str) and recorded_phase in PHASES else "unknown"
            report["cause"] = cause if cause == "operator-signal" else "unknown"
            restoration = record.get("restoration")
            restored = restoration.get("state") if isinstance(restoration, dict) else None
            report["restoration"] = restored if isinstance(restored, str) and restored in ("restored", "unrestored", "unknown", "not-applicable", "restoration_failed") else "unknown"
        return report
    if outcome != "running":
        return {**report, "observation": "unknown", "reason": "study-state-malformed"}
    try:
        progress, _ = study_audit._coverage_read(root / "progress.json")
        if not isinstance(progress, dict):
            raise ValueError("progress is not an object")
    except FileNotFoundError:
        return {**report, "observation": "unknown", "reason": "no-progress-record"}
    except (OSError, ValueError, RecursionError):
        return {**report, "observation": "unknown", "reason": "progress-unreadable"}
    command, repeat = progress.get("command"), progress.get("repeat")
    planned, retained, updated = progress.get("planned"), progress.get("retained"), progress.get("updated")
    child = progress.get("child")
    if (command not in COMMAND_KINDS or type(repeat) is not int or type(planned) is not int or
            type(retained) is not int or not isinstance(updated, (int, float)) or isinstance(updated, bool) or
            not (child is None or isinstance(child, dict))):
        return {**report, "observation": "unknown", "reason": "progress-malformed"}
    if (not 0 <= repeat <= 2 ** 53 or not 0 <= planned <= 2 ** 53 or
            not 0 <= retained <= planned or not 0 <= updated <= 2 ** 53 or not math.isfinite(updated)):
        return {**report, "observation": "unknown", "reason": "progress-malformed"}
    supervisor, owner = progress.get("supervisor"), state.get("owner")
    if (not isinstance(supervisor, dict) or not isinstance(owner, dict) or
            supervisor.get("id") != owner.get("id")):
        return {**report, "observation": "unknown", "reason": "progress-owner-mismatch"}
    age = time.time() - updated
    report.update(command=command, cohort=f"r{repeat}", repeat=repeat, planned=planned, retained=retained,
                  updated=updated, age_s=round(age, 3))
    if age > stale_after:
        return {**report, "observation": "stalled", "reason": "progress-stalled"}
    if child is None:
        return {**report, "observation": "unknown", "reason": "no-child-recorded"}
    pid, started = child.get("pid"), child.get("started")
    if type(pid) is not int or not isinstance(started, str):
        return {**report, "observation": "unknown", "reason": "progress-malformed"}
    report["child_pid"] = pid
    ident = ps_fields(pid)
    if ident is None:
        return {**report, "observation": "unknown", "reason": "child-not-running"}
    if ident[0] != started:
        return {**report, "observation": "unknown", "reason": "child-identity-mismatch"}
    return {**report, "observation": "live"}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["status"]:
        p = argparse.ArgumentParser(prog="study_supervisor.py status",
                                    description="Bounded read-only study status from recorded artifacts; never launches, retries or recovers anything.")
        p.add_argument("--output", type=Path, required=True)
        p.add_argument("--stale-after", type=float, default=STALE_AFTER_S)
        a = p.parse_args(argv[1:])
        print(json.dumps(status_report(a.output.resolve(), a.stale_after), sort_keys=True, allow_nan=False))
        return 0
    p = argparse.ArgumentParser(description=__doc__)
    for key in ("manifest", "output", "archives", "private-inputs", "upstream-root", "probe-target", "qwen-package"):
        p.add_argument("--" + key, type=Path, required=True)
    p.add_argument("--protect", type=Path, action="append", default=[])
    p.add_argument("--optional-protect", type=Path, action="append", default=[])
    p.add_argument("--plan", default="study")
    p.add_argument("--python", type=Path, default=Path(sys.executable), help="official evaluator Python with pinned upstream dependencies")
    p.add_argument("--bind-current-hub", action="store_true")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--generation-only", action="store_true", help="stop after restored generation; never evaluate or seal")
    a = p.parse_args(argv)
    try:
        if a.preflight_only:
            preflight(a); print('{"preflight":true}')
        else: execute(a)
        return 0
    except (Exception, KeyboardInterrupt):
        print('{"verified":false,"error":"study_failed","detail":"inspect private study state and logs"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
