import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = join(import.meta.dir, "../../scripts/benchmarks/runner.py");
const fixture = () => mkdtempSync(join(tmpdir(), "ahub-bench-test-"));

describe("benchmark runner contracts", () => {
  test("rejects archive members that escape the fixture directory", () => {
    const root = fixture();
    try {
      const archive = join(root, "escape.tar");
      const result = spawnSync("python3", ["-c", `import tarfile,io; t=tarfile.open(${JSON.stringify(archive)},'w'); i=tarfile.TarInfo('../outside'); b=b'x'; i.size=1; t.addfile(i,io.BytesIO(b)); t.close()`]);
      expect(result.status).toBe(0);
      const py = `import importlib.util,pathlib; s=importlib.util.spec_from_file_location('runner',${JSON.stringify(script)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.safe_extract(pathlib.Path(${JSON.stringify(archive)}),pathlib.Path(${JSON.stringify(join(root,"dest"))}))`;
      const rejected = spawnSync("python3", ["-c", py], { encoding: "utf8" });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("escaping path");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("uses path-qualified feature identity when reporting equal feature numbers", () => {
    const root=fixture();
    try {
      const manifest={schema:"agent-hub.cooperbench-run/v1",upstream:{commit:"63b9d44d9f39a02fccf5bf0052db48a917a011fd"},arms:["solo-codex","solo-claude","hub-codex-claude"],cases:[
        {repo:"repo_a",task:1,features:[2,3],archive_sha256:"a".repeat(64),prompt_sha256:["b".repeat(64),"c".repeat(64)],image_digest:"image@sha256:"+"d".repeat(64),base_commit:"e".repeat(40)},
        {repo:"repo_b",task:2,features:[2,4],archive_sha256:"a".repeat(64),prompt_sha256:["b".repeat(64),"c".repeat(64)],image_digest:"image@sha256:"+"d".repeat(64),base_commit:"e".repeat(40)}]};
      writeFileSync(join(root,"manifest.json"),JSON.stringify(manifest));
      const manifestBytes=JSON.stringify(manifest);
      writeFileSync(join(root,"manifest.json"),manifestBytes);
      const manifestHash=createHash("sha256").update(manifestBytes).digest("hex");
      const arms=["solo-codex","solo-claude","hub-codex-claude"];
      writeFileSync(join(root,"cohort.json"),JSON.stringify({manifest_sha256:manifestHash,cases:[0,1],arms,runner_sha256:"r",native_runner_sha256:"n"}));
      const rows=[0,1].flatMap((caseIndex:number)=>arms.map((arm:string)=>({case:caseIndex,arm,status:"missing",pass:null})));
      writeFileSync(join(root,"grade.json"),JSON.stringify({manifest_sha256:manifestHash,runner_sha256:"r",native_runner_sha256:"n",cohort:[0,1],controls:{},rows}));
      const run=spawnSync("python3",[script,"report","--run",root],{encoding:"utf8"});
      expect(run.status).toBe(0);
      const report=JSON.parse(run.stdout);
      expect(report.features.map((x:any)=>x.id)).toEqual(["repo_a:1:2","repo_a:1:3","repo_b:2:2","repo_b:2:4"]);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  test("rejects an evaluation whose current bytes differ from the bound hash", () => {
    const root=fixture();
    try {
      const manifest={schema:"agent-hub.cooperbench-run/v1",upstream:{commit:"63b9d44d9f39a02fccf5bf0052db48a917a011fd"},arms:["solo-codex","solo-claude","hub-codex-claude"],cases:[]};
      const bytes=JSON.stringify(manifest);writeFileSync(join(root,"manifest.json"),bytes);
      const patch=join(root,"patch.diff"),evaluation=join(root,"evaluation.json");writeFileSync(patch,"first");writeFileSync(evaluation,"{}\n");
      const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
      const arms=["solo-codex","solo-claude","hub-codex-claude"];
      writeFileSync(join(root,"cohort.json"),JSON.stringify({manifest_sha256:hash(bytes),cases:[0],arms,runner_sha256:"r",native_runner_sha256:"n"}));
      const rows=[{case:0,arm:"solo-codex",status:"scored",pass:true,patch_path:patch,evaluation_path:evaluation,input_sha256:hash("first"),evaluation_sha256:hash("{}\n")},...arms.slice(1).map((arm:string)=>({case:0,arm,status:"unavailable",pass:null}))];
      writeFileSync(join(root,"grade.json"),JSON.stringify({manifest_sha256:hash(bytes),runner_sha256:"r",native_runner_sha256:"n",cohort:[0],controls:{},rows}));
      writeFileSync(evaluation,"{\"both_passed\":false}\n");
      const run=spawnSync("python3",[script,"report","--run",root],{encoding:"utf8"});
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("stale evaluation");
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  test("prepares a fresh baseline with archive files that were untracked", () => {
    const root=fixture();
    try {
      const archive=join(root,"sample_repo-7.tar");
      const pack=spawnSync("python3",["-c",`import tarfile,io; t=tarfile.open(${JSON.stringify(archive)},'w'); [(lambda n,b:(lambda i:(setattr(i,'size',len(b)),t.addfile(i,io.BytesIO(b))))(tarfile.TarInfo(n)))(n,b) for n,b in [('tracked.py',b'a'),('new-module.py',b'b')]]; t.close()`]);
      expect(pack.status).toBe(0);
      const archiveHash=createHash("sha256").update(readFileSync(archive)).digest("hex");
      const manifest={schema:"agent-hub.cooperbench-run/v1",upstream:{commit:"63b9d44d9f39a02fccf5bf0052db48a917a011fd"},arms:["solo-codex","solo-claude","hub-codex-claude"],cases:[{repo:"sample_repo",task:7,features:[1,2],image_digest:"sample@sha256:"+"d".repeat(64),base_commit:"e".repeat(40),archive_sha256:archiveHash,prompt_sha256:["a".repeat(64),"b".repeat(64)]}]};
      const manifestPath=join(root,"manifest.json");writeFileSync(manifestPath,JSON.stringify(manifest));
      const run=spawnSync("python3",[script,"prepare","--manifest",manifestPath,"--archives",root,"--output",join(root,"output")],{encoding:"utf8"});
      if(run.status!==0) throw new Error(run.stderr);
      const prepared=JSON.parse(readFileSync(join(root,"output","prepared.json"),"utf8"));
      expect(prepared.fixtures).toHaveLength(3);
      expect(prepared.fixtures[0].baseline_paths).toBe(2);
      expect(prepared.fixtures[0].qualified_feature_ids).toEqual(["sample_repo:7:1","sample_repo:7:2"]);
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  test("restores exact protected path modes from a crash ledger", () => {
    const root=fixture();
    try {
      const protectedRoot=join(root,"hidden");mkdirSync(protectedRoot);const protectedFile=join(protectedRoot,"source.json");
      writeFileSync(protectedFile,"private");chmodSync(protectedFile,0);chmodSync(protectedRoot,0);
      writeFileSync(join(root,"restoration-ledger.json"),JSON.stringify({protected:{paths:{[protectedRoot]:0o700,[protectedFile]:0o600},restored:false},siblings:{},trust:null}));
      const recovered=spawnSync("python3",[script,"restore","--run",root],{encoding:"utf8"});
      expect(recovered.status).toBe(0);
      expect(statSync(protectedRoot).mode&0o777).toBe(0o700);
      expect(statSync(protectedFile).mode&0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(root,"restoration.json"),"utf8")).recovered).toBe(true);
    } finally { if(existsSync(join(root,"hidden")))chmodSync(join(root,"hidden"),0o700);if(existsSync(join(root,"hidden","source.json")))chmodSync(join(root,"hidden","source.json"),0o600);rmSync(root,{recursive:true,force:true}); }
  });
});

test("case binding rejects a different pair on the same task image and changed input bytes", () => {
  const root=fixture();
  try {
    const path=join(root,"case.json");
    const code = `import importlib.util,pathlib,json,hashlib
spec=importlib.util.spec_from_file_location('bench',${JSON.stringify(script)})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
p=pathlib.Path(${JSON.stringify(path)})
expected={'repo':'click','task':2068,'features':[1,6]}
p.write_text(json.dumps(expected));pin=m.file_sha(p)
assert m.validate_private_case(p,expected,pin)==expected
p.write_text(json.dumps({'repo':'click','task':2068,'features':[2,10]}))
try: m.validate_private_case(p,expected,m.file_sha(p));raise AssertionError('swapped pair accepted')
except m.BenchError as e: assert 'identity' in str(e)
p.write_text(json.dumps(expected)+' ')
try: m.validate_private_case(p,expected,pin);raise AssertionError('changed bytes accepted')
except m.BenchError as e: assert 'changed' in str(e)
`;
    const r=spawnSync("python3",["-B","-c",code],{encoding:"utf8"});expect(r.status).toBe(0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("crash trust restoration preserves native updates to unrelated project fields", () => {
  const root=fixture();
  try {
    const trust=join(root,"trust.json"),project=join(root,"project");mkdirSync(project);
    writeFileSync(trust,JSON.stringify({projects:{[project]:{hasTrustDialogAccepted:true,lastCost:2},other:{untouched:true}}}));
    writeFileSync(join(root,"restoration-ledger.json"),JSON.stringify({protected:{paths:{},restored:false},siblings:{},trust:{file:trust,project,previous:{hasTrustDialogAccepted:false,lastCost:1},written:{hasTrustDialogAccepted:true,lastCost:1},restored:false,hadProjects:true,mode:384}}));
    const r=spawnSync("python3",["-B",script,"restore","--run",root],{encoding:"utf8"});expect(r.status).toBe(0);
    const value=JSON.parse(readFileSync(trust,"utf8"));expect(value.projects[project]).toEqual({hasTrustDialogAccepted:false,lastCost:2});expect(value.projects.other).toEqual({untouched:true});
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("a v2 manifest prepares the turn-free arm too, and an arm list that matches no protocol is refused", () => {
  const root=fixture();
  try {
    const archive=join(root,"sample_repo-7.tar");
    const pack=spawnSync("python3",["-c",`import tarfile,io; t=tarfile.open(${JSON.stringify(archive)},'w'); i=tarfile.TarInfo('tracked.py'); i.size=1; t.addfile(i,io.BytesIO(b'a')); t.close()`]);
    expect(pack.status).toBe(0);
    const archiveHash=createHash("sha256").update(readFileSync(archive)).digest("hex");
    const manifest=(arms:string[])=>({schema:"agent-hub.cooperbench-run/v1",upstream:{commit:"63b9d44d9f39a02fccf5bf0052db48a917a011fd"},arms,cases:[{repo:"sample_repo",task:7,features:[1,2],image_digest:"sample@sha256:"+"d".repeat(64),base_commit:"e".repeat(40),archive_sha256:archiveHash,prompt_sha256:["a".repeat(64),"b".repeat(64)]}]});
    const prepare=(arms:string[],out:string)=>{const path=join(root,`${out}.json`);writeFileSync(path,JSON.stringify(manifest(arms)));return spawnSync("python3",[script,"prepare","--manifest",path,"--archives",root,"--output",join(root,out)],{encoding:"utf8"});};
    const v2=prepare(["solo-codex","solo-claude","hub-codex-claude","hub-turnfree-codex-claude"],"v2");
    if(v2.status!==0) throw new Error(v2.stderr);
    expect(JSON.parse(readFileSync(join(root,"v2","prepared.json"),"utf8")).fixtures.map((f:any)=>f.arm)).toEqual(["solo-codex","solo-claude","hub-codex-claude","hub-turnfree-codex-claude"]);
    const odd=prepare(["solo-codex","hub-turnfree-codex-claude"],"odd");
    expect(odd.status).not.toBe(0);
    expect(odd.stderr).toContain("versioned protocol");
  } finally {rmSync(root,{recursive:true,force:true});}
});

// issue #110: grading binds the actors of every v2 arm, applies one validity gate to every run record, and a manifest's
// planned attempts match its arms, cases and repeats.
test("grading names the actors of every arm and grades only valid attempts (graded ends, treatment, hook isolation); a plan that does not add up is refused", () => {
  const code = `import importlib.util,json,os,tempfile
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert [m.required_actors(a) for a in ['solo-codex','solo-claude','hub-codex-claude','hub-turnfree-codex-claude']]==[['codex'],['claude'],['codex','claude'],['codex','claude']]
v2=json.load(open(${JSON.stringify(join(import.meta.dir, "../../scripts/benchmarks/manifest-v2.json"))}))
m.validate_manifest(v2)
assert v2['plan']['pilot']['attempts']==12 and v2['plan']['study']['attempts']==80 and v2['plan']['study']['active_ceiling_s']==24000
v2['plan']['study']['attempts']=60
try: m.validate_manifest(v2); raise AssertionError('a wrong plan was accepted')
except m.BenchError as e: assert 'do not match 80 attempts' in str(e)
v2['plan']['study']['attempts']=80
for bad,why in (({'cases':[0,99],'repeats':1,'attempts':8,'active_ceiling_s':2400},'distinct indices'),({'cases':[0],'repeats':1.5,'attempts':4,'active_ceiling_s':1200},'whole number'),({'cases':[0],'repeats':1,'attempt':4},'no attempts')):
    v2['plan']['bad']=bad
    try: m.validate_manifest(v2); raise AssertionError('a malformed plan was accepted')
    except m.BenchError as e: assert why in str(e), str(e)
del v2['plan']['bad']
ab=json.load(open(${JSON.stringify(join(import.meta.dir, "../../scripts/benchmarks/manifest-v2-ablation-106.json"))}))
m.validate_manifest(ab)
assert ab['arms']==['hub-codex-claude','hub-staleoff-codex-claude'] and m.required_actors('hub-staleoff-codex-claude')==['codex','claude']
# The gate grade() applies to every run record that passed the identity checks.
tf='hub-turnfree-codex-claude'
run={'end_reason':'completed','taskStates':[{'id':1},{'id':2}],'events':[],'codexMessages':[]}
assert m.unavailable_reason(tf,run)=='turn-free treatment absent: the tasks never formed a silent cohort'
assert m.unavailable_reason('hub-codex-claude',run) is None
run['events']=[{'type':'cohort','id':1,'event':'formed','silent':True,'tasks':[1,2]}]
assert m.unavailable_reason(tf,run) is None
run['events'].append({'type':'cohort','id':1,'event':'lifted','silent':False,'tasks':[1,2]})
assert m.unavailable_reason(tf,run)=="turn-free treatment lost: the cohort's silence was lifted"
run['events'].pop()
run['end_reason']='timeout'; run['end_reason_detail']='wall-timeout'
assert m.unavailable_reason(tf,run) is None  # a timed-out attempt's final artifact is graded
run['end_reason']='interrupted'; run['end_reason_detail']='needs-review'
assert m.unavailable_reason(tf,run)=='needs-review'
run['end_reason']='completed'
run['codexMessages']=[{'method':'hook/started'}]
assert m.unavailable_reason('solo-codex',run)=='hook isolation failed: Codex ran hooks'
run['codexMessages']=[]
t=tempfile.NamedTemporaryFile('w',suffix='.jsonl',delete=False)
t.write(json.dumps({'type':'attachment','attachment':{'type':'hook_success','command':"bun '/x/src/cli/facts-hook.ts'"}})+'\\n'); t.close()
run['readiness']={'claude':{'transcriptPath':t.name}}
assert m.unavailable_reason(tf,run) is None
with open(t.name,'a') as f: f.write(json.dumps({'type':'system','subtype':'stop_hook_summary','hookInfos':[{'command':'~/.claude/hooks/notify.sh'}]})+'\\n')
assert m.unavailable_reason(tf,run)=="hook isolation failed: Claude ran a hook that is not the hub's"
os.unlink(t.name)
`;
  const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
});
