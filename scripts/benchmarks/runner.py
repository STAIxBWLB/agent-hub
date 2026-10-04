#!/usr/bin/env python3
"""Opt-in, fail-closed CooperBench fixture and evidence runner (stdlib only)."""
from __future__ import annotations
import argparse, hashlib, json, os, re, shutil, subprocess, sys, tarfile
from pathlib import Path, PurePosixPath

PROCESS_TABLE=Path(__file__).resolve().parents[2]/"src"/"hub"/"child-process.ts"  # the teardown decides on its process table
SCHEMA = "agent-hub.cooperbench-run/v1"
ARMS_V1 = ("solo-codex", "solo-claude", "hub-codex-claude")
# Issue #110: manifest v2 adds the turn-free collaboration arm; a v1 manifest keeps its three arms for earlier cohorts;
# the #106 ablation compares the advisory arm with the same arm with stale-notice dropping off. Issue #140: manifest v3
# is the headless Pi/Qwen protocol (solo-pi, solo-qwen, joint-pi-qwen).
ARMS_V3 = ("solo-pi", "solo-qwen", "joint-pi-qwen")
PROTOCOL_ARMS = (ARMS_V1, ARMS_V1 + ("hub-turnfree-codex-claude",), ("hub-codex-claude", "hub-staleoff-codex-claude"), ARMS_V3)
# The candidate sources a v3 cohort's attempts ran with (#138 tool-identity binding, #139 per-request journal).
SOURCE_PIN_PATHS = ("src/adapters/pi.ts", "src/adapters/acp.ts", "src/models/relay.ts")

class BenchError(RuntimeError): pass

def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def file_sha(path: Path) -> str: return sha(path.read_bytes())
def load(path: Path): return json.loads(path.read_text(encoding="utf-8"))
def dump(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)
def git(cwd: Path, *args: str):
    p = subprocess.run(["git", *args], cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode: raise BenchError(p.stderr.strip() or "git operation failed")
    return p.stdout.strip()
def arms_of(m):
    arms=tuple(m.get("arms") or ())
    if arms not in PROTOCOL_ARMS: raise BenchError("arms must match a versioned protocol")
    return arms

def required_actors(arm):
    """The native actors an arm's run record must show: both for a joint arm, one for a solo arm."""
    if arm == "joint-pi-qwen": return ["pi", "qwen"]
    if arm in ("solo-pi", "solo-qwen"): return [arm.removeprefix("solo-")]
    return ["codex","claude"] if arm.startswith("hub-") else [arm.removeprefix("solo-")]

def check_plan(m):
    """Issue #110: a manifest's planned attempts and active-time ceilings are what its arms, cases and repeats make."""
    for name,plan in (m.get("plan") or {}).items():
        if not isinstance(plan,dict): continue
        if "attempts" not in plan: raise BenchError(f"plan {name}: no attempts")
        cases,repeats=plan.get("cases"),plan.get("repeats")
        if not isinstance(cases,list) or not cases or any(not isinstance(c,int) or isinstance(c,bool) or not 0<=c<len(m.get("cases",[])) for c in cases) or len(set(cases))!=len(cases):
            raise BenchError(f"plan {name}: cases must be distinct indices of the manifest's cases")
        if not isinstance(repeats,int) or isinstance(repeats,bool) or repeats<1: raise BenchError(f"plan {name}: repeats must be a whole number of at least 1")
        attempts=len(m["arms"])*len(cases)*repeats
        if plan["attempts"]!=attempts or plan.get("active_ceiling_s")!=attempts*m.get("wall_limit_s",0):
            raise BenchError(f"plan {name}: {plan['attempts']} attempts / {plan.get('active_ceiling_s')} s do not match {attempts} attempts of {m.get('wall_limit_s')} s")

TURN_FREE="hub-turnfree-codex-claude"

def at_ms(value):
    """Milliseconds since the epoch of a record's time: a number already, or an ISO string."""
    if isinstance(value,(int,float)) and not isinstance(value,bool): return float(value)
    from datetime import datetime
    return datetime.fromisoformat(str(value).replace("Z","+00:00")).timestamp()*1000

def active_window(run):
    """(start, end) of an attempt's work in ms: from its first task proposal to the end of its active time, before
    teardown. Either is None when the record cannot say."""
    proposals=[h.get("at") for t in run.get("taskStates") or [] for h in t.get("history",[]) if h.get("event")=="proposed" and h.get("at") is not None]
    start=min(map(at_ms,proposals)) if proposals else None
    began,elapsed=run.get("startedAt"),run.get("elapsedMs")
    end=at_ms(began)+elapsed if isinstance(began,(int,float)) and isinstance(elapsed,(int,float)) else None
    return start,end

def treatment_failure(arm, run):
    """Issue #110: a turn-free attempt is valid only with its context paths working, which is decided before the
    agents start and must hold while they work: both paths verified before the first task, none lost and no cohort lifted
    or formed not silent until the work ended. Teardown comes after and does not count. Whether the agents' plans
    overlapped, so that a cohort formed at all, is their doing after assignment and never makes an attempt invalid: the
    ledger reports it as the treatment received."""
    if arm!=TURN_FREE: return None
    t0,end=active_window(run)
    if t0 is None: return None
    events=[e for e in run.get("events") or [] if e.get("at") is not None]
    state={}  # each peer's capability as of the first task: its latest event by then
    for e in sorted((e for e in events if e.get("type")=="capability" and at_ms(e["at"])<=t0),key=lambda e: at_ms(e["at"])): state[e.get("peer")]=e.get("state")
    missing=sorted(p for p in ("claude","codex") if state.get(p)!="verified")
    if missing: return f"turn-free context path not verified before the tasks: {', '.join(missing)}"
    work=[e for e in events if at_ms(e["at"])>t0 and (end is None or at_ms(e["at"])<=end)]
    lost=sorted({str(e.get("peer")) for e in work if e.get("type")=="capability" and e.get("state")=="lost"})
    if lost: return f"turn-free context path lost while the agents worked: {', '.join(lost)}"
    if any(e.get("type")=="cohort" and (e.get("event")=="lifted" or not e.get("silent")) for e in work): return "turn-free cohort not silent while the agents worked"
    return None

def hook_rows(rows):
    """(hook, command, durationMs) of every hook row in a Claude transcript: hook attachments (Claude Code writes them for
    hooks that printed something) and Stop hook summaries. A hook that printed nothing leaves no row."""
    out=[]
    for row in rows:
        a=row.get("attachment") or {}
        kind=str(a.get("type",""))
        if kind.startswith("hook") and kind!="hook_additional_context": out.append((a.get("hookName") or a.get("hookEvent"),a.get("command"),a.get("durationMs")))
        if row.get("type")=="system" and row.get("subtype")=="stop_hook_summary":
            out+=[("Stop",h.get("command"),h.get("durationMs")) for h in row.get("hookInfos") or [] if isinstance(h,dict)]
    return out

def transcript(run):
    """The rows of the attempt's Claude transcript, or (None, why)."""
    claude=(run.get("readiness") or {}).get("claude") or {}
    path=claude.get("transcriptPath")
    if not path: return None,"no transcript path"
    try: data=Path(path).read_bytes()
    except OSError as e: return None,f"transcript unreadable ({e.__class__.__name__})"
    if claude.get("transcriptSha256"):
        # Claude Code may append rows after it exits: the attempt is the prefix recorded when it ended, and only that.
        size=claude.get("transcriptBytes")
        if isinstance(size,int) and not isinstance(size,bool): data=data[:size] if len(data)>=size else b""
        if sha(data)!=claude["transcriptSha256"]: return None,"transcript changed since the attempt"
    lines=data.decode("utf-8",errors="replace").splitlines()
    rows=[]
    for line in lines:
        try: rows.append(json.loads(line))
        except ValueError: continue
    return rows,None

def isolation_failure(run):
    """Issue #110: no arm may run a foreign hook or MCP server. Codex runs no hooks and starts no MCP server but the hub's;
    Claude's transcript may show only the hub's facts hook. Without the transcript isolation cannot be shown."""
    msgs=run.get("codexMessages") or []
    if any(m.get("method")=="hook/started" for m in msgs): return "hook isolation failed: Codex ran hooks"
    started=sorted({str((m.get("params") or {}).get("name")) for m in msgs if m.get("method")=="mcpServer/startupStatus/updated" and (m.get("params") or {}).get("name")!="agent-hub" and (m.get("params") or {}).get("status")!="disabled"})
    if started: return f"MCP isolation failed: Codex started {', '.join(started)}"
    if "claude" not in str(run.get("kind") or ""): return None
    rows,why=transcript(run)
    if rows is None: return f"hook isolation unknown: {why}"
    if any(c and "facts-hook.ts" not in c for _,c,_ in hook_rows(rows)): return "hook isolation failed: Claude ran a hook that is not the hub's"
    return None

GRADED_ENDS=("completed","timeout")

def teardown_failure(run):
    """Issue #113: an attempt whose processes are not known to be gone, whose evidence could not be taken, or whose
    trust entry was not taken back is unavailable, for grading and the ledger alike. The end reason stays as it was."""
    if run.get("teardown_errors"): return ("teardown errors: "+"; ".join(map(str,run["teardown_errors"])))[:300]
    if not isinstance(run.get("cleanup"), dict):
        # Before 0.12.5 (#113) an attempt is judged as it was then, by what it recorded: cleanup_complete meant the shutdown
        # steps reported success (no process readback), not that the processes were seen gone; the ledger shows it as unverified.
        if "cleanup_complete" in run and run["cleanup_complete"] is not True: return "cleanup incomplete, as recorded before 0.12.5"
        if "claude" in str(run.get("kind") or "") and "trust_restored" in run and run["trust_restored"] is not True: return "the Claude trust entry was not taken back"
        return None
    if run.get("cleanup_complete") is not True: return ("cleanup incomplete or unknown: "+"; ".join(map(str,(run.get("cleanup") or {}).get("reasons") or [])))[:300]
    if "claude" in str(run.get("kind") or "") and run.get("trust_restored") is not True: return "the Claude trust entry was not taken back"
    return None

def end_story(run):
    """How an attempt ended, with what flagged it beside (#113): `completed, then tree-changed-after-active-time`."""
    story=str(run.get("end_reason_detail") or run.get("end_reason") or "no end reason")
    return story+(", then "+", ".join(map(str,run["end_flags"])) if run.get("end_flags") else "")

def unavailable_reason(arm, run):
    """Why an attempt with a run record is not graded, or None. Completed and timed-out attempts are graded."""
    if run.get("end_reason") not in GRADED_ENDS: return end_story(run)
    return treatment_failure(arm,run) or isolation_failure(run)

def validate_manifest(m):
    if m.get("schema") != SCHEMA or m.get("upstream", {}).get("commit") != "63b9d44d9f39a02fccf5bf0052db48a917a011fd":
        raise BenchError("unsupported schema or upstream commit")
    arms_of(m)
    check_plan(m)
    cases=m.get("cases")
    if not isinstance(cases,list) or not cases: raise BenchError("manifest has no cases")
    seen=set()
    for c in cases:
        key=(c.get("repo"),c.get("task"),tuple(c.get("features",[])))
        if not isinstance(key[0],str) or not isinstance(key[1],int) or len(key[2]) != 2 or key in seen: raise BenchError("invalid or duplicate qualified case")
        seen.add(key)
        if not re.fullmatch(r"[0-9a-f]{64}",str(c.get("archive_sha256",""))): raise BenchError("missing archive digest")
        prompts=c.get("prompt_sha256")
        if not isinstance(prompts,list) or len(prompts)!=2 or any(not re.fullmatch(r"[0-9a-f]{64}",str(x)) for x in prompts): raise BenchError("missing feature prompt digests")
        if not re.search(r"@sha256:[0-9a-f]{64}$",str(c.get("image_digest",""))): raise BenchError("container image is not digest-pinned")
        if not re.fullmatch(r"[0-9a-f]{40}",str(c.get("base_commit",""))): raise BenchError("base commit is not pinned")
    if tuple(m.get("arms") or ())==ARMS_V3:
        # Issue #140: the v3 protocol pins the effective native builds, the fixed backend and its expected served
        # identity, and each case's guarded source layout (src/ for Click/Jinja, dirty_equals/ for dirty_equals).
        if m.get("headless") is not True: raise BenchError("a v3 manifest is the headless protocol")
        versions=m.get("versions") or {}
        for a in ("pi","qwen"):
            if not re.fullmatch(r"\d+\.\d+\.\d+",str(versions.get(a,""))): raise BenchError(f"v3 pins no effective {a} build version")
        models=m.get("models") or {}
        if any(not isinstance(models.get(a),str) or not models[a] for a in ("pi","qwen")): raise BenchError("v3 pins no pi/qwen model alias")
        for k in ("fixed_backend","expected_served_model","expected_provider"):
            if not isinstance(m.get(k),str) or not m[k]: raise BenchError(f"v3 pins no {k}")
        for c in cases:
            dirs=c.get("source_dirs")
            if not isinstance(dirs,list) or not dirs or any(d not in ("src","dirty_equals") for d in dirs): raise BenchError("v3 case has no valid source_dirs")

def safe_extract(archive: Path, dest: Path):
    with tarfile.open(archive,"r:*") as tf:
        for member in tf.getmembers():
            raw=member.name.replace("\\","/")
            while raw.startswith("./"): raw=raw[2:]
            p=PurePosixPath(raw)
            if p.is_absolute() or ".." in p.parts: raise BenchError("archive contains an escaping path")
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()): raise BenchError("archive contains a link or special file")
        for member in tf.getmembers():
            raw=member.name.replace("\\","/")
            while raw.startswith("./"): raw=raw[2:]
            target=dest.joinpath(*PurePosixPath(raw).parts)
            if member.isdir(): target.mkdir(parents=True,exist_ok=True,mode=0o755)
            else:
                target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
                stream=tf.extractfile(member)
                if stream is None: raise BenchError("archive file has no payload")
                with stream,target.open("wb") as output: shutil.copyfileobj(stream,output)
                os.chmod(target,0o755 if member.mode & 0o111 else 0o644)

def tree_digest(root: Path):
    result={}
    for p in sorted(root.rglob("*")):
        if p.is_symlink(): raise BenchError(f"symlink in pinned source tree: {p.relative_to(root)}")
        if p.is_file() and ".git" not in p.relative_to(root).parts:
            result[p.relative_to(root).as_posix()]=file_sha(p)
    return result

def fixture_metadata_sha256(root: Path) -> str:
    names=("AGENTS.md", ".gitignore", ".claude/settings.json", ".agenthub/config.json", ".agenthub/routing.toml")
    values={name:file_sha(root/name) if (root/name).is_file() else None for name in names}
    return sha(json.dumps(values,separators=(",", ":")).encode())

def check_orca_context(repo: Path):
    try:
        raw=subprocess.run(["orca","worktree","current","--json"],cwd=repo,capture_output=True,text=True,check=True).stdout
        envelope=json.loads(raw)
        wt=envelope.get("result",{}).get("worktree",{})
        canonical=Path(wt.get("path","")).resolve()
        repo=repo.resolve()
        if not wt.get("id") or not canonical.is_dir() or repo!=canonical and canonical not in repo.parents:
            raise BenchError("Orca current context does not own the canonical repository path")
    except (OSError,subprocess.CalledProcessError,json.JSONDecodeError) as e:
        raise BenchError(f"cannot verify canonical Orca context: {type(e).__name__}") from e

def prepare(args):
    repo=Path(__file__).resolve().parents[2]
    # Preparation is a pure fixture operation; native.ts proves Orca ownership before launch.
    m=load(args.manifest); validate_manifest(m); root=args.output.resolve()
    for c in m["cases"]:
        c["archive"] = str((args.archives / f"{c['repo']}-{c['task']}.tar").resolve())
    if root.exists() and any(root.iterdir()): raise BenchError("output directory must be new and empty")
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.chmod(root,0o700)
    dump(root/"manifest.json",m)
    prepared=[]
    for i,c in enumerate(m["cases"]):
        archive=Path(c["archive"]).resolve()
        if file_sha(archive)!=c["archive_sha256"]: raise BenchError(f"archive hash mismatch for case {i}")
        for arm in arms_of(m):
            dest=root/"fixtures"/f"{i:02d}-{arm}"
            if dest.exists(): raise BenchError("fixture already exists")
            dest.mkdir(parents=True,mode=0o700)
            safe_extract(archive,dest)
            if m.get("headless") is True:
                # Issue #140: the v3 fixture's standing instruction is part of the sealed baseline; the headless
                # driver mutates no fixture metadata at run time.
                allowed=", ".join(c.get("source_dirs") or ["src"])
                (dest/"AGENTS.md").write_text(f"# CooperBench native study\nImplement only assigned feature descriptions. Source edits only under {allowed}/. Do not edit tests or metadata. No shell, network, installs, history lookup, external apps, subagents, or hidden tests. Inspect existing repository with file tools. For a shared checkout coordinate overlapping changes through hub_send; FYI messages require no reply. Final answer starts [FYI].\n",encoding="utf-8")
            # Git's index captures every path, including untracked files from the source archive.
            git(dest,"init","-q"); git(dest,"add","-A")
            git(dest,"-c","user.name=Benchmark","-c","user.email=benchmark@localhost","commit","-qm","sealed benchmark baseline")
            baseline=tree_digest(dest)
            prepared.append({"case":i,"qualified_feature_ids":[f"{c['repo']}:{c['task']}:{f}" for f in c["features"]],"arm":arm,"cwd":str(dest),"base_commit":git(dest,"rev-parse","HEAD"),"baseline_sha256":sha(json.dumps(baseline,sort_keys=True,separators=(",", ":")).encode()),"baseline_paths":len(baseline),"source_dirs":c.get("source_dirs")})
    native_runner=Path(__file__).with_name("native.ts")
    repo_root=Path(__file__).resolve().parents[2]
    provenance={"schema":SCHEMA,"manifest_sha256":file_sha(root/"manifest.json"),"runner_sha256":file_sha(Path(__file__)),"native_runner_sha256":file_sha(native_runner),"teardown_sha256":file_sha(native_runner.with_name("teardown.ts")),"process_table_sha256":file_sha(PROCESS_TABLE),"fixtures":prepared,"pi_qwen_runner_sha256":file_sha(native_runner.with_name("native-pi-qwen.ts")),"peer_bus_sha256":file_sha(native_runner.with_name("peer-bus-mcp.py")),"source_pins":{p:file_sha(repo_root/p) for p in SOURCE_PIN_PATHS}}
    if args.upstream_root:
        upstream=args.upstream_root.resolve()
        if git(upstream,"rev-parse","HEAD")!=m["upstream"]["commit"]: raise BenchError("CooperBench source commit differs from manifest")
        provenance["upstream_root"]=str(upstream)
        provenance["upstream_source_sha256"]=sha(json.dumps(tree_digest(upstream),sort_keys=True,separators=(",", ":")).encode())
    provenance["evaluator_sha256"]=file_sha(Path(__file__).with_name("evaluate.py"))
    dump(root/"prepared.json",provenance)
    print(f"prepared {len(prepared)} fresh fixtures at {root}")

def collect_patch(cwd: Path, base: str = "HEAD"):
    # -N exposes new untracked files; --binary preserves an exact patch for later grading.
    git(cwd,"add","-N","--all")
    p=subprocess.run(["git","diff","--binary",base,"--"],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise BenchError("cannot collect fixture diff")
    return p.stdout

def collect_patch_v3(cwd: Path, base: str, source_dirs: list):
    """Issue #140: the submission patch over exactly the guarded source layout, new source files bound in by
    intent-to-add (calibration correction 4)."""
    git(cwd,"add","-N","--",*source_dirs)
    p=subprocess.run(["git","diff","--binary",base,"--",*source_dirs],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise BenchError("cannot collect fixture diff")
    return p.stdout

def v3_outside_changes(cwd: Path, source_dirs: list):
    """Modified or untracked paths outside the guarded source dirs. The v3 patch binds only source_dirs, so anything
    the agents changed elsewhere must be absent, not merely excluded from the patch."""
    p=subprocess.run(["git","status","--porcelain","-uall","--","."],cwd=cwd,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode: raise BenchError("cannot verify fixture tree")
    bad=[]
    for line in p.stdout.splitlines():
        rel=line[3:]
        if " -> " in rel: rel=rel.split(" -> ",1)[1]
        if not any(rel==d or rel.startswith(d+"/") for d in source_dirs): bad.append(rel)
    return bad

def v3_request_gate(identity, m):
    """Issue #140: per-request served-model qualification over the relay's journaled RelayRequestRecords (#139).
    Every identified record is evidence, whatever its outcome: a request cancelled after identification still
    flags a confirmed mismatch; only cancelled-before-identification is non-evidence. A completed request that
    was never identified (a heartbeat-only stream identifies nothing) fails the attempt."""
    if not isinstance(identity,dict): return "generation model identity missing"
    reqs=identity.get("requests")
    if not isinstance(reqs,list) or not reqs or any(not isinstance(r,dict) for r in reqs): return "generation requests unverified"
    completed=[r for r in reqs if r.get("outcome")=="completed"]
    if not completed: return "no completed generation request; cancelled or failed requests identify nothing"
    served,provider,backend=m.get("expected_served_model"),m.get("expected_provider"),m.get("fixed_backend")
    for r in reqs:
        if r.get("identified") is not True:
            if r.get("outcome")=="completed": return "generation model identity unverified"
            continue
        if r.get("requestedModel")!=backend: return "generation request model mismatch"
        if r.get("mismatch"): return "generation served model mismatch flagged"
        if r.get("actualModel")!=served: return "generation model identity unverified"
        if r.get("provider") is not None and provider is not None and r.get("provider")!=provider: return "generation provider mismatch"
    return None

def v3_linkage(identity):
    """Request-linkage coverage of one attempt's journaled records, for rows and summaries."""
    reqs=(identity or {}).get("requests") if isinstance(identity,dict) else None
    reqs=[r for r in reqs or [] if isinstance(r,dict)]
    completed=[r for r in reqs if r.get("outcome")=="completed"]
    return {"requests":len(reqs),"completed":len(completed),"identified":sum(r.get("identified") is True for r in completed),"cancelledUnidentified":sum(r.get("outcome")=="cancelled" and r.get("identified") is not True for r in reqs),"mismatches":sum(r.get("mismatch") is True for r in reqs),"providerMissing":sum(r.get("identified") is True and r.get("provider") is None for r in completed)}

def v3_participants(run):
    """Issue #152: the native actors that actually took part in a v3 attempt. The arm bounds the candidates (a
    solo-qwen attempt has no Pi peer at all); among them, a peer participated only once it started, which its
    readiness entry proves by the sessionId the adapter reports after a successful start. A peer that was
    constructed but never started (a setup failure: elapsedMs 0, no active start) keeps a readiness entry without
    a sessionId, or none, and is absent — the initial 0 of its token counter is not an observation. The record's
    answers are no signal: both keys exist on every attempt, empty or not."""
    ready=run.get("readiness") if isinstance(run.get("readiness"),dict) else {}
    return [a for a in required_actors(str(run.get("kind") or "")) if a in ("pi","qwen") and isinstance(ready.get(a),dict) and bool(ready[a].get("sessionId"))]

def validate_private_case(path:Path, expected:dict, pinned_hash:str|None):
    data=load(path)
    if (data.get("repo"),data.get("task"),data.get("features"))!=(expected["repo"],expected["task"],expected["features"]): raise BenchError("private case identity differs from the selected feature pair")
    if pinned_hash!=file_sha(path): raise BenchError("private case changed after native execution")
    return data

def grade(args):
    root=args.run.resolve(); prep=load(root/"prepared.json"); m=load(root/"manifest.json"); cohort=load(root/"cohort.json")
    if prep["manifest_sha256"]!=file_sha(root/"manifest.json") or cohort.get("manifest_sha256")!=prep["manifest_sha256"]: raise BenchError("prepared manifest changed")
    if prep.get("runner_sha256")!=file_sha(Path(__file__)) or prep.get("native_runner_sha256")!=file_sha(Path(__file__).with_name("native.ts")) or prep.get("teardown_sha256")!=file_sha(Path(__file__).with_name("teardown.ts")) or prep.get("process_table_sha256")!=file_sha(PROCESS_TABLE) or prep.get("evaluator_sha256")!=file_sha(args.evaluator): raise BenchError("benchmark runner/evaluator changed after fixture preparation")
    if cohort.get("runner_sha256")!=prep.get("runner_sha256") or cohort.get("native_runner_sha256")!=prep.get("native_runner_sha256") or cohort.get("teardown_sha256")!=prep.get("teardown_sha256"): raise BenchError("run source pins differ from prepared fixture")
    v3=tuple(m.get("arms") or ())==ARMS_V3
    if v3:
        # Issue #140: a v3 cohort is graded only with the exact headless driver, peer bus and candidate sources it ran with.
        if prep.get("pi_qwen_runner_sha256")!=file_sha(Path(__file__).with_name("native-pi-qwen.ts")) or prep.get("peer_bus_sha256")!=file_sha(Path(__file__).with_name("peer-bus-mcp.py")): raise BenchError("benchmark runner changed after fixture preparation")
        if cohort.get("pi_qwen_runner_sha256")!=prep.get("pi_qwen_runner_sha256") or cohort.get("peer_bus_sha256")!=prep.get("peer_bus_sha256"): raise BenchError("run source pins differ from prepared fixture")
        pins=prep.get("source_pins") or {}
        repo_root=Path(__file__).resolve().parents[2]
        if set(pins)!=set(SOURCE_PIN_PATHS) or any(file_sha(repo_root/p)!=h for p,h in pins.items()): raise BenchError("candidate source pins changed after fixture preparation")
    if cohort.get("calibration"): raise BenchError("setup calibration is never graded")
    arms=arms_of(m)
    if cohort.get("arms")!=list(arms): raise BenchError("run cohort does not contain every predeclared arm")
    prepared_keys=[(int(x["case"]),x["arm"]) for x in prep.get("fixtures",[])]
    if len(prepared_keys)!=len(m["cases"])*len(arms) or len(set(prepared_keys))!=len(prepared_keys) or set(prepared_keys)!={(i,arm) for i in range(len(m["cases"])) for arm in arms}: raise BenchError("prepared fixture matrix is incomplete or duplicated")
    try: restored=load(root/"restoration.json")
    except Exception as e: raise BenchError("protected inputs were not restored") from e
    if restored.get("restored") is not True: raise BenchError("protected inputs were not restored")
    if not args.evaluator.is_file(): raise BenchError("versioned official evaluator adapter is unavailable")
    if not args.python.is_file(): raise BenchError("official evaluator Python runtime is unavailable")
    eval_hash=file_sha(args.evaluator); rows=[]; controls={}; selected=[int(x) for x in cohort["cases"]]
    if not selected or len(set(selected))!=len(selected) or any(i<0 or i>=len(m["cases"]) for i in selected): raise BenchError("invalid fixed run cohort")
    private_inputs=args.private_inputs.resolve(); upstream=args.upstream_root.resolve()
    if not prep.get("upstream_root") or not prep.get("upstream_source_sha256"): raise BenchError("prepare must pin an upstream root and source tree")
    if upstream!=Path(prep["upstream_root"]).resolve() or git(upstream,"rev-parse","HEAD")!=m["upstream"]["commit"]: raise BenchError("upstream CooperBench checkout differs from prepared provenance")
    if sha(json.dumps(tree_digest(upstream),sort_keys=True,separators=(",", ":")).encode())!=prep["upstream_source_sha256"]: raise BenchError("upstream evaluator/data tree changed after prepare")

    def evaluate(case_index:int,mode:str,patch:Path|None,label:str):
        case=m["cases"][case_index]
        actual=subprocess.run(["docker","image","inspect",case["image_digest"]],capture_output=True,text=True)
        if actual.returncode: raise BenchError(f"pinned evaluation image is unavailable for case {case_index}")
        images=json.loads(actual.stdout); digests=images[0].get("RepoDigests") or []
        if case["image_digest"] not in digests: raise BenchError(f"evaluation image digest differs from manifest for case {case_index}")
        private_case=private_inputs/f"case-{case_index:02d}.json"
        if not private_case.is_file(): raise BenchError(f"private evaluator case is missing for case {case_index}")
        validate_private_case(private_case,case,cohort.get("private_case_sha256",{}).get(str(case_index)))
        output=root/"evaluations"/f"{case_index:02d}-{label}.json"; output.parent.mkdir(exist_ok=True); output.unlink(missing_ok=True)
        p=subprocess.run([str(args.python),"-B",str(args.evaluator),str(upstream),prep["upstream_source_sha256"],str(private_case),mode,str(patch) if patch else "-",str(output)],capture_output=True,text=True)
        if p.returncode or not output.is_file(): raise BenchError(f"official evaluation failed for {label}")
        ev=load(output)
        if ev.get("schema")!=SCHEMA or ev.get("upstream_commit")!=m["upstream"]["commit"] or ev.get("case_sha256")!=file_sha(private_case) or ev.get("image_digest")!=case["image_digest"] or ev.get("evaluator_sha256")!=eval_hash: raise BenchError(f"evaluator provenance mismatch for {label}")
        if (ev.get("repo"),ev.get("task"),ev.get("features"))!=(case["repo"],case["task"],case["features"]): raise BenchError("evaluator returned a different qualified feature pair")
        return output,ev

    for case_index in selected:
        base_output,base_ev=evaluate(case_index,"base",None,f"control-{case_index:02d}-base")
        oracle_output,oracle_ev=evaluate(case_index,"oracle",None,f"control-{case_index:02d}-oracle")
        if base_ev.get("valid_negative") is not True or base_ev.get("both_passed") is not False: raise BenchError(f"base-fail control failed for case {case_index}")
        if oracle_ev.get("valid_oracle") is not True or oracle_ev.get("both_passed") is not True: raise BenchError(f"oracle-pass control failed for case {case_index}")
        controls[str(case_index)]=[{"mode":"base","observed":False,"expected":False,"check_passed":True,"input_sha256":base_ev["input_sha256"],"evaluation_sha256":file_sha(base_output),"evaluation_path":str(base_output)},{"mode":"oracle","observed":True,"expected":True,"check_passed":True,"input_sha256":oracle_ev["input_sha256"],"evaluation_sha256":file_sha(oracle_output),"evaluation_path":str(oracle_output)}]

    fixture_map={(int(x["case"]),x["arm"]):x for x in prep["fixtures"]}
    for case in selected:
      for arm in arms:
        fixture=fixture_map[(case,arm)]
        cwd=Path(fixture["cwd"])
        if not cwd.is_dir() or cwd.resolve().parent!=(root/"fixtures").resolve(): raise BenchError("fixture cwd identity mismatch")
        run_path=root/"runs"/f"{case:02d}-{arm}.json"
        if not run_path.is_file(): rows.append({"case":case,"arm":arm,"status":"missing","pass":None}); continue
        run=load(run_path); actors=required_actors(arm)
        teardown=teardown_failure(run)
        mid=run.get("modelIdentity")
        v3extra={"request_linkage":v3_linkage(mid),"model_identity":{"verified":isinstance(mid,dict) and mid.get("generationVerified") is True},"native_participants":v3_participants(run)} if v3 else {}
        if teardown:
            rows.append({"case":case,"arm":arm,"status":"unavailable","reason":teardown,"pass":None,**v3extra}); continue
        if v3:
            # Issue #140: identity, effective-build, probe-evidence and request-linkage gates for a headless attempt.
            ready=run.get("readiness") if isinstance(run.get("readiness"),dict) else {}
            def actor_ok(a):
                r=ready.get(a); probe=r.get("sandboxProbe") if isinstance(r,dict) else None
                # The probe counts only with structured denial evidence (a guard denial or a failed native read),
                # never with a model-written marker alone (calibration correction 2).
                return isinstance(r,dict) and r.get("cwd")==str(cwd) and r.get("requestedModel")==m.get("models",{}).get(a) and r.get("sessionId") and isinstance(probe,dict) and probe.get("checked") is True and probe.get("result")=="denied" and probe.get("evidence") in ("guard-denial","tool-failure")
            builds=run.get("nativeVersions") if isinstance(run.get("nativeVersions"),dict) else {}
            builds_ok=all(isinstance(builds.get(a),dict) and builds[a].get("version")==m.get("versions",{}).get(a) and builds[a].get("binary") for a in actors)
            if run.get("cwd")!=str(cwd) or not all(actor_ok(a) for a in actors) or not builds_ok or run.get("cleanup_complete") is not True or run.get("metadata_clean") is not True or run.get("metadata_sha256")!=fixture_metadata_sha256(cwd):
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"native identity/model/readiness/cleanup gate failed","pass":None,**v3extra}); continue
            failure=unavailable_reason(arm,run)
            if failure:
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":failure,"pass":None,**v3extra}); continue
            linkage=v3_request_gate(run.get("modelIdentity"),m)
            if linkage:
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":linkage,"pass":None,**v3extra}); continue
            sealed=run.get("sealedCommit")
            if not isinstance(sealed,str) or not sealed:
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"sealed baseline identity mismatch","pass":None,**v3extra}); continue
            try: git(cwd,"merge-base","--is-ancestor",fixture["base_commit"],sealed)
            except BenchError:
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"sealed baseline is not a descendant of the prepared source baseline","pass":None,**v3extra}); continue
            source_dirs=fixture.get("source_dirs") or m["cases"][case]["source_dirs"]
            outside=v3_outside_changes(cwd,source_dirs)
            if outside:
                rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"changes outside the guarded source dirs: "+", ".join(outside[:5]),"pass":None,**v3extra}); continue
            recorded_patch=Path(str(run.get("patchFile",""))).resolve()
            if not recorded_patch.is_file(): raise BenchError(f"native patch record is missing for case {case} {arm}")
            patch=collect_patch_v3(cwd,sealed,source_dirs)
            if patch!=recorded_patch.read_bytes(): raise BenchError(f"fixture changed after native run for case {case} {arm}")
            patch_path=root/"patches"/f"{case:02d}-{arm}.patch"; patch_path.parent.mkdir(exist_ok=True); patch_path.write_bytes(patch)
            output,ev=evaluate(case,"scored",patch_path,f"{case:02d}-{arm}")
            input_hash=sha(patch)
            if ev.get("input_sha256")!=input_hash: raise BenchError("evaluator output is not bound to the exact submission patch")
            result=ev.get("both_passed")
            rows.append({"case":case,"arm":arm,"status":"scored" if isinstance(result,bool) else "unavailable","pass":result if isinstance(result,bool) else None,"input_sha256":input_hash,"patch_path":str(patch_path),"evaluation_path":str(output),"evaluation_sha256":file_sha(output),"evaluator_sha256":eval_hash,"native_usage":run.get("usage"),**v3extra})
            continue
        ready=run.get("readiness") if isinstance(run.get("readiness"),dict) else {}
        identities=all(isinstance(ready.get(actor),dict) and ready[actor].get("cwd")==str(cwd) and ready[actor].get("requestedModel",ready[actor].get("model"))==m.get("models",{}).get(actor) and (ready[actor].get("sessionId") if actor=="claude" else ready[actor].get("threadId")) and isinstance(ready[actor].get("sandboxProbe"),dict) and ready[actor]["sandboxProbe"].get("checked") is True and ready[actor]["sandboxProbe"].get("result")=="denied" for actor in actors)
        claude_ready=ready.get("claude",{}) if "claude" in actors else {}
        if claude_ready and claude_ready.get("modelVerified") is not True: identities=False
        if run.get("cwd")!=str(cwd) or not identities or run.get("cleanup_complete") is not True or run.get("metadata_clean") is not True or run.get("metadata_sha256")!=fixture_metadata_sha256(cwd) or ("claude" in actors and run.get("trust_restored") is not True):
            rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"native identity/model/readiness/cleanup gate failed","pass":None}); continue
        failure=unavailable_reason(arm,run)
        if failure:
            rows.append({"case":case,"arm":arm,"status":"unavailable","reason":failure,"pass":None}); continue
        sealed=run.get("sealedCommit")
        if not isinstance(sealed,str):
            rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"sealed baseline identity mismatch","pass":None}); continue
        try: git(cwd,"merge-base","--is-ancestor",fixture["base_commit"],sealed)
        except BenchError:
            rows.append({"case":case,"arm":arm,"status":"unavailable","reason":"sealed baseline is not a descendant of the prepared source baseline","pass":None}); continue
        recorded_patch=Path(str(run.get("patchFile",""))).resolve()
        if not recorded_patch.is_file(): raise BenchError(f"native patch record is missing for case {case} {arm}")
        patch=collect_patch(cwd,sealed)
        if patch!=recorded_patch.read_bytes(): raise BenchError(f"fixture changed after native run for case {case} {arm}")
        patch_path=root/"patches"/f"{case:02d}-{arm}.patch"; patch_path.parent.mkdir(exist_ok=True); patch_path.write_bytes(patch)
        output,ev=evaluate(case,"scored",patch_path,f"{case:02d}-{arm}")
        input_hash=sha(patch)
        if ev.get("input_sha256")!=input_hash: raise BenchError("evaluator output is not bound to the exact submission patch")
        result=ev.get("both_passed")
        claude_usage=run.get("readiness",{}).get("claude",{}).get("nativeUsage")
        claude_quota=run.get("claudeUsage")  # #134: pre/post quota readings; may be absent in older records
        if isinstance(claude_quota,dict): claude_usage={"pre":claude_quota.get("pre"),"post":claude_quota.get("post"),**(claude_usage or {})}
        rows.append({"case":case,"arm":arm,"status":"scored" if isinstance(result,bool) else "unavailable","pass":result if isinstance(result,bool) else None,"input_sha256":input_hash,"patch_path":str(patch_path),"evaluation_path":str(output),"evaluation_sha256":file_sha(output),"evaluator_sha256":eval_hash,"native_usage":{"codex":run.get("codexUsage"),"claude":claude_usage}})
    expected_rows=[(case,arm) for case in selected for arm in arms]
    actual_rows=[(row["case"],row["arm"]) for row in rows]
    if actual_rows!=expected_rows or len(set(actual_rows))!=len(actual_rows): raise BenchError("grade rows do not exactly cover the fixed cohort")
    dump(root/"grade.json",{"schema":SCHEMA,"manifest_sha256":prep["manifest_sha256"],"runner_sha256":prep["runner_sha256"],"native_runner_sha256":prep["native_runner_sha256"],"teardown_sha256":prep.get("teardown_sha256"),"evaluator_sha256":eval_hash,"cohort":selected,"controls":controls,"rows":rows})
    print(f"graded {sum(r['status']=='scored' for r in rows)}/{len(rows)} cohort fixtures; unavailable remain unscored")

def report(args):
    root=args.run.resolve(); m=load(root/"manifest.json"); grade=load(root/"grade.json");cohort=load(root/"cohort.json")
    if grade.get("manifest_sha256")!=file_sha(root/"manifest.json") or cohort.get("manifest_sha256")!=grade.get("manifest_sha256"): raise BenchError("stale grade: manifest hash differs")
    if grade.get("runner_sha256")!=cohort.get("runner_sha256") or grade.get("native_runner_sha256")!=cohort.get("native_runner_sha256") or grade.get("teardown_sha256")!=cohort.get("teardown_sha256"): raise BenchError("stale grade: runner source hashes differ")
    arms=arms_of(m)
    expected_rows=[(case,arm) for case in cohort["cases"] for arm in arms]
    actual_rows=[(row.get("case"),row.get("arm")) for row in grade.get("rows",[])]
    if grade.get("cohort")!=cohort["cases"] or actual_rows!=expected_rows or len(set(actual_rows))!=len(actual_rows): raise BenchError("stale grade: row coverage differs from the fixed cohort")
    for row in grade.get("rows",[]):
        if row.get("status")!="scored": continue
        patch=Path(row.get("patch_path","")); evaluation=Path(row.get("evaluation_path",""))
        if not patch.is_file() or not evaluation.is_file() or file_sha(patch)!=row.get("input_sha256") or file_sha(evaluation)!=row.get("evaluation_sha256"):
            raise BenchError("stale evaluation: input or evaluator output hash differs")
    for controls in grade.get("controls",{}).values():
        for item in controls:
            evaluation=Path(item.get("evaluation_path",""))
            if not evaluation.is_file() or file_sha(evaluation)!=item.get("evaluation_sha256") or load(evaluation).get("input_sha256")!=item.get("input_sha256"):
                raise BenchError("stale evaluation control: input or output hash differs")
    by_arm={}
    for arm in arms:
        rows=[x for x in grade["rows"] if x["arm"]==arm]; scored=[x for x in rows if x["status"]=="scored"]
        if tuple(arms)==ARMS_V3:
            # Issue #140: quality, model-identity and request-linkage coverage are reported separately; unavailable
            # attempts stay in the planned denominator, and Pi and Qwen usage units are never added together.
            # Issue #152: an actor's usage counts only in attempts where that actor participated (the row's
            # native_participants, taken from the run record's arm and per-peer sessions). An absent actor — a
            # solo arm's other native, or a peer that never started — contributes zero known observations, and its
            # token counter's initial 0 is never read as a measurement; a participant with no native reading
            # stays unknown, never zero.
            def participants_of(r):
                p=r.get("native_participants")
                if isinstance(p,list): return [a for a in p if a in ("pi","qwen")]
                # Grade rows from before #152 name no participants; their native_usage was attached only to scored
                # attempts, whose readiness gate had proved every required actor's session, so the arm's actors
                # are exactly the participants.
                return required_actors(r.get("arm")) if isinstance(r.get("native_usage"),dict) else []
            def actor_usage(actor):
                took=[r for r in rows if actor in participants_of(r)]
                vals=[r["native_usage"].get(actor) for r in took if isinstance(r.get("native_usage"),dict) and isinstance(r["native_usage"].get(actor),(int,float)) and not isinstance(r["native_usage"].get(actor),bool)]
                return took,vals
            pi_took,pi=actor_usage("pi"); qw_took,qw=actor_usage("qwen")
            links=[r.get("request_linkage") for r in rows if isinstance(r.get("request_linkage"),dict)]
            agg=lambda k: sum(l.get(k,0) for l in links)
            by_arm[arm]={"planned":len(cohort["cases"]),"scored":len(scored),"both_passed":sum(x["pass"] is True for x in scored),"unavailable":len(rows)-len(scored),
                "native_usage":{"pi_tokens_known":len(pi),"pi_tokens":sum(pi) if pi else None,"pi_participating":len(pi_took),"qwen_session_tokens_known":len(qw),"qwen_session_tokens":sum(qw) if qw else None,"qwen_participating":len(qw_took),"units":"pi: incremental onTokens counter; qwen: session usage_update running total; whole attempt including setup probes; counted only where the actor participated (#152); never added together"},
                "model_identity":{"verified":sum(r.get("model_identity",{}).get("verified") is True for r in rows if isinstance(r.get("model_identity"),dict)),"attempts":len(rows)},
                "request_linkage":{"attempts":len(links),"requests":agg("requests"),"completed":agg("completed"),"identified":agg("identified"),"cancelledUnidentified":agg("cancelledUnidentified"),"mismatches":agg("mismatches"),"providerMissing":agg("providerMissing")}}
            continue
        codex_known=[r["native_usage"]["codex"].get("total_tokens") for r in scored if isinstance(r.get("native_usage",{}).get("codex"),dict) and r["native_usage"]["codex"].get("total_tokens") is not None]
        claude_known=[r["native_usage"]["claude"].get("output_tokens") for r in scored if isinstance(r.get("native_usage",{}).get("claude"),dict) and r["native_usage"]["claude"].get("output_tokens") is not None]
        by_arm[arm]={"planned":len(cohort["cases"]),"scored":len(scored),"both_passed":sum(x["pass"] is True for x in scored),"unavailable":len(rows)-len(scored),"native_usage":{"codex_total_tokens_known":len(codex_known),"codex_total_tokens":sum(codex_known) if codex_known else None,"claude_output_tokens_known":len(claude_known),"claude_output_tokens":sum(claude_known) if claude_known else None}}
    control_rows=[x for values in grade.get("controls",{}).values() for x in values]
    out={"schema":SCHEMA,"manifest_sha256":grade["manifest_sha256"],"cohort":cohort["cases"],"controls_passed":len(control_rows)==2*len(cohort["cases"]) and all(x.get("check_passed") is True and x.get("observed")==x.get("expected") for x in control_rows),"arms":by_arm,"features":[{"id":f"{c['repo']}:{c['task']}:{f}","repo":c["repo"],"task":c["task"],"feature":f} for i in cohort["cases"] for c in [m["cases"][i]] for f in c["features"]],"claims":"convenience sample only; no leaderboard or isolated-coop parity claim"}
    dump(root/"report.json",out);print(json.dumps(out,indent=2))

def restore(args):
    """One recovery path (#113): restore.ts restores only once the runner, every recorded process and anything in a
    fixture are gone, and returns the records it kept to runs/."""
    cmd=["bun",str(Path(__file__).with_name("restore.ts")),"--run",str(args.run.resolve())]+(["--runner-exited"] if args.runner_exited else [])
    sys.exit(subprocess.run(cmd).returncode)

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest="cmd",required=True)
    p=sub.add_parser("prepare");p.add_argument("--manifest",type=Path,required=True);p.add_argument("--output",type=Path,required=True);p.add_argument("--archives",type=Path,required=True);p.set_defaults(fn=prepare)
    sub.choices["prepare"].add_argument("--upstream-root",type=Path)
    p=sub.add_parser("grade");p.add_argument("--run",type=Path,required=True);p.add_argument("--private-inputs",type=Path,required=True);p.add_argument("--upstream-root",type=Path,required=True);p.add_argument("--evaluator",type=Path,default=Path(__file__).with_name("evaluate.py"));p.add_argument("--python",type=Path,default=Path(sys.executable));p.set_defaults(fn=grade)
    p=sub.add_parser("report");p.add_argument("--run",type=Path,required=True);p.set_defaults(fn=report)
    p=sub.add_parser("restore");p.add_argument("--run",type=Path,required=True);p.add_argument("--runner-exited",action="store_true",help="the ledger predates runner identities: the operator states the runner is gone");p.set_defaults(fn=restore)
    args=ap.parse_args()
    try: args.fn(args)
    except (BenchError,OSError,KeyError,ValueError,json.JSONDecodeError) as e: print(f"benchmark: {e}",file=sys.stderr);return 2
    return 0
if __name__=="__main__": raise SystemExit(main())
