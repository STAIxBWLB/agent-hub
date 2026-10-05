#!/usr/bin/env python3
"""Bounded native v3 study. Fresh durable roots only; no resume or quality-selected retry."""
from __future__ import annotations
import argparse, copy, json, os, re, shutil, subprocess, sys, tempfile, time, uuid
from pathlib import Path
import runner
import study_audit

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PHASES = ("claimed", "prepared", "generated", "restored", "graded", "sealed")


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


def run_command(cmd, log, timeout=None):
    """Native/evaluator output belongs only to the private bundle."""
    with log.open("xb") as out:
        os.chmod(log, 0o600)
        completed = subprocess.run([str(x) for x in cmd], cwd=REPO, stdout=out, stderr=subprocess.STDOUT, timeout=timeout)
    if completed.returncode:
        raise runner.BenchError("study command failed; private log retained")


def read_command(cmd, env=None):
    p = subprocess.run([str(x) for x in cmd], cwd=REPO, capture_output=True, text=True, env=env, timeout=60)
    if p.returncode:
        raise runner.BenchError("prerequisite command unavailable")
    return p.stdout.strip()


def preflight(a):
    """No fixtures, output roots, services or model calls are mutated here."""
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
    def __init__(self, root, expected):
        root.mkdir(mode=0o700)  # atomic claim; an existing incomplete root is never reused
        self.root = root
        self.state = {"schema": "agent-hub.native-study/v1", "owner": {"pid": os.getpid(), "id": str(uuid.uuid4())},
                      "phase": "claimed", "outcome": "running", "expected": expected, "history": []}
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

    def fail(self):
        self.state["outcome"] = "incomplete"
        self.save()


def execute(a):
    original, runtime, amendments, protect, optional = preflight(a)
    spec = runtime["plan"][a.plan]
    root = a.output.resolve()
    study = Study(root, spec["attempts"])
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
        cohorts = [root / f"r{r}" for r in range(spec["repeats"])]
        for rep, cohort in enumerate(cohorts):
            run_command([sys.executable, "-B", HERE / "runner.py", "prepare", "--manifest", root / "runtime-manifest.json",
                         "--output", cohort, "--archives", a.archives, "--upstream-root", a.upstream_root], root / f"prepare-{rep}.log")
        study.advance("prepared")
        for rep, cohort in enumerate(cohorts):
            cmd = ["bun", HERE / "native-pi-qwen.ts", "--run", cohort, "--private-inputs", a.private_inputs,
                   "--upstream-root", a.upstream_root, "--probe-target", a.probe_target, "--qwen-package", a.qwen_package,
                   "--cases", ",".join(map(str, spec["cases"])), "--repeat", rep]
            for path in protect: cmd += ["--protect", path]
            run_command(cmd, root / f"generation-{rep}.log")
        study.advance("generated")
        native = study_audit.audit(cohorts, a.plan, require_grades=False)
        if not native["checks"]["restoration"] or not native["checks"]["matrix"] or not native["checks"]["bindings"]:
            raise runner.BenchError("generation restoration/matrix gates failed")
        study_audit.write_new(root / "generation-audit.json", native)
        study.advance("restored")
        if a.generation_only:
            study.state["outcome"] = "generation-only"; study.save()
            print(json.dumps({"phase": "restored", "planned": native["planned"], "retained": native["retained"], "graded": False}))
            return
        for rep, cohort in enumerate(cohorts):
            run_command([sys.executable, "-B", HERE / "runner.py", "grade", "--run", cohort,
                         "--private-inputs", a.private_inputs, "--upstream-root", a.upstream_root, "--python", a.python], root / f"grade-{rep}.log")
            run_command([sys.executable, "-B", HERE / "runner.py", "report", "--run", cohort], root / f"report-{rep}.log")
        study.advance("graded")
        cmd = [sys.executable, "-B", HERE / "ledger.py", "--plan", a.plan, "--json"]
        for cohort in cohorts: cmd += ["--run", cohort]
        run_command(cmd, root / "pooled-ledger.log")
        result = study_audit.audit(cohorts, a.plan)
        if not result["verified"]: raise runner.BenchError("final audit failed")
        study_audit.write_new(root / "safe-aggregate.json", result)
        study.advance("sealed")
        study.state["outcome"] = "complete"; study.save()
        evidence = [{"artifact": p.relative_to(root).as_posix(), "sha256": runner.file_sha(p)}
                    for p in sorted(root.rglob("*")) if p.is_file() and ".git" not in p.parts and "fixtures" not in p.parts]
        study_audit.write_new(root / "private-evidence-hashes.json", evidence)
        print(json.dumps({"phase": "sealed", "planned": result["planned"], "retained": result["retained"], "verified": True}))
    except BaseException:
        study.fail()
        raise


def main():
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
    a = p.parse_args()
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
