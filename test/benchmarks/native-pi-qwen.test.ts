import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { v3ArmOrder, jointAssignment, isSourcePath, ProtectedReadProbe, qualifyRequests, effectiveBuild, parseVersion, claimExclusive, collectSubmissionPatch, disposeAll, writeRecordFresh } from "../../scripts/benchmarks/native-pi-qwen.ts";
import type { RelayRequestRecord } from "../../src/models/relay.ts";

const script = join(import.meta.dir, "../../scripts/benchmarks/runner.py");
const fixture = () => mkdtempSync(join(tmpdir(), "ahub-bench-v3-test-"));
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};

const record = (partial: Partial<RelayRequestRecord>): RelayRequestRecord => ({
  id: partial.id ?? Math.random().toString(36).slice(2),
  at: new Date().toISOString(),
  alias: "dgx/coding",
  requestedModel: "flashnext/qwen3.8-flash-next",
  provider: "provider-a",
  actualModel: "qwen3.8-flash-next",
  identitySource: "stream",
  role: "unknown",
  outcome: "completed",
  identified: true,
  durationMs: 100,
  ...partial,
});
const expected = { backend: "flashnext/qwen3.8-flash-next", servedModel: "qwen3.8-flash-next", provider: "provider-a" };

describe("Qwen protected read evidence bound to one native call (#140)", () => {
  const target = "/private/protected/tests.patch";
  const announce = (id: string, kind = "read") => ({ sessionUpdate: "tool_call", toolCallId: id, kind, status: "pending", rawInput: {} });
  const input = (id: string, path = target) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput: { file_path: path } });
  const failed = (id: string) => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text: `EACCES: permission denied, open '${target}'` } }] });
  const cases = [
    { name: "same read id, exact input and kernel denial", updates: [announce("a"), input("a"), failed("a")], denied: true },
    { name: "protected write failure plus unrelated read failure", updates: [announce("w", "edit"), input("w"), failed("w"), announce("r"), input("r", "/project/source.py"), failed("r")], denied: false },
    { name: "wrong target even when error mentions protected file", updates: [announce("a"), input("a", target + ".other"), failed("a")], denied: false },
    { name: "model marker without native read", updates: [{ text: "AHUB_PROBE_DENIED" }], denied: false },
    { name: "late failure after completion", updates: [announce("a"), input("a"), { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }, failed("a")], denied: false },
    { name: "failure without announcement", updates: [input("a"), failed("a")], denied: false },
    { name: "mutable kind cannot turn announced edit into read", updates: [announce("a", "edit"), { ...input("a"), kind: "read" }, failed("a")], denied: false },
    { name: "reused id clears the old protected path", updates: [announce("a"), input("a"), announce("a"), input("a", "/project/source.py"), failed("a")], denied: false },
    { name: "conflicting input path cannot recover", updates: [announce("a"), input("a", "/project/source.py"), input("a"), failed("a")], denied: false },
    { name: "read failure without permission denial", updates: [announce("a"), input("a"), { ...failed("a"), content: [{ text: "ENOENT" }] }], denied: false },
  ];
  for (const item of cases) test(item.name, () => {
    const probe = new ProtectedReadProbe(target);
    for (const update of item.updates) probe.observe(update);
    expect(probe.denied).toBe(item.denied);
  });
});

describe("manifest v3 plan arithmetic and joint ownership (#140)", () => {
  test("arm order is the preregistered six-row odd-n Williams layout", () => {
    const arms = ["solo-pi", "solo-qwen", "joint-pi-qwen"];
    const rows: string[][] = [];
    for (let repeat = 0; repeat < 2; repeat++) for (let caseIndex = 0; caseIndex < 10; caseIndex++) rows.push(v3ArmOrder(arms, caseIndex, repeat, 10));
    // The first three rows are the shifted [0,1,2] rows, the next three their reverses, then the pattern repeats.
    expect(rows.slice(0, 6)).toEqual([
      ["solo-pi", "solo-qwen", "joint-pi-qwen"],
      ["solo-qwen", "joint-pi-qwen", "solo-pi"],
      ["joint-pi-qwen", "solo-pi", "solo-qwen"],
      ["joint-pi-qwen", "solo-qwen", "solo-pi"],
      ["solo-pi", "joint-pi-qwen", "solo-qwen"],
      ["solo-qwen", "solo-pi", "joint-pi-qwen"],
    ]);
    expect(rows[10]).toEqual(rows[4]); // the layout repeats every six rows: rows 6-11 equal rows 0-5
    expect(rows.slice(6, 12)).toEqual(rows.slice(0, 6));
    for (const row of rows) expect([...row].sort()).toEqual([...arms].sort());
  });

  test("joint ownership is fixed before inference as (caseIndex+repeat)%2", () => {
    expect(jointAssignment(0, 0)).toEqual({ pi: 0, qwen: 1 });
    expect(jointAssignment(1, 0)).toEqual({ pi: 1, qwen: 0 });
    expect(jointAssignment(0, 1)).toEqual({ pi: 1, qwen: 0 });
    expect(jointAssignment(9, 1)).toEqual({ pi: 0, qwen: 1 });
  });

  test("source guards follow the per-case repository layout", () => {
    expect(isSourcePath(["src"], "src/click/core.py")).toBe(true);
    expect(isSourcePath(["src"], "tests/test_core.py")).toBe(false);
    expect(isSourcePath(["dirty_equals"], "dirty_equals/_boolean.py")).toBe(true);
    expect(isSourcePath(["dirty_equals"], "src/anything.py")).toBe(false);
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../scripts/benchmarks/manifest-v3-pi-qwen.json"), "utf8"));
    for (const c of manifest.cases) {
      const want = c.repo.startsWith("samuelcolvin_") ? ["dirty_equals"] : ["src"];
      expect(c.source_dirs).toEqual(want);
    }
  });
});

describe("request-linkage qualification over RelayRequestRecord (#139, #140)", () => {
  test("a completed, identified request with the expected served model and provider verifies", () => {
    const q = qualifyRequests([record({})], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage).toEqual({ requests: 1, completed: 1, identified: 1, cancelledUnidentified: 0, mismatches: 0, providerMissing: 0 });
  });

  test("a request cancelled before identification stays explicit and never certifies", () => {
    const cancelled = record({ outcome: "cancelled", identified: false, identitySource: "none", actualModel: undefined, provider: undefined });
    const alone = qualifyRequests([cancelled], expected);
    expect(alone.verified).toBe(false);
    expect(alone.reasons[0]).toContain("no completed generation request");
    expect(alone.coverage.cancelledUnidentified).toBe(1);
    const beside = qualifyRequests([record({}), cancelled], expected);
    expect(beside.verified).toBe(true); // the cancelled record certifies nothing; the completed one stands on its own
    expect(beside.coverage.cancelledUnidentified).toBe(1);
  });

  test("a mismatch on a request cancelled after identification still fails the gate (review #146)", () => {
    // Cancelled after its header/generation event identified the served model: the mismatch is confirmed evidence.
    const bad = record({ outcome: "cancelled", mismatch: true, actualModel: "qwen3.8-other" });
    const q = qualifyRequests([record({}), bad], expected);
    expect(q.verified).toBe(false);
    expect(q.reasons.some((r) => r.includes("mismatch"))).toBe(true);
    expect(q.coverage.mismatches).toBe(1);
    const wrong = record({ outcome: "cancelled", actualModel: "qwen3.8-other" });
    expect(qualifyRequests([record({}), wrong], expected).verified).toBe(false);
    const wrongProvider = record({ outcome: "cancelled", provider: "provider-b" });
    expect(qualifyRequests([record({}), wrongProvider], expected).verified).toBe(false);
  });

  test("a cleanly identified cancellation certifies nothing and fails nothing", () => {
    const clean = record({ outcome: "cancelled" }); // identified, with the expected model and provider
    const q = qualifyRequests([record({}), clean], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage.cancelledUnidentified).toBe(0);
  });

  test("a heartbeat-only record (never identified) fails even with HTTP-level completion", () => {
    const q = qualifyRequests([record({ identified: false, identitySource: "none", actualModel: undefined })], expected);
    expect(q.verified).toBe(false);
    expect(q.reasons.some((r) => r.includes("heartbeat"))).toBe(true);
  });

  test("a mismatch or a different served model or provider is flagged", () => {
    expect(qualifyRequests([record({ mismatch: true })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ actualModel: "qwen3.8-other" })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ provider: "provider-b" })], expected).verified).toBe(false);
    expect(qualifyRequests([record({ requestedModel: "flashnext/other" })], expected).verified).toBe(false);
  });

  test("a missing provider header is coverage, not a failure; an absent journal is", () => {
    const q = qualifyRequests([record({ provider: undefined })], expected);
    expect(q.verified).toBe(true);
    expect(q.coverage.providerMissing).toBe(1);
    expect(qualifyRequests([], expected).verified).toBe(false);
  });
});

describe("effective-build pinning (correction 1)", () => {
  test("the version is read under the isolation environment, not the outer one", async () => {
    const root = fixture();
    try {
      // Qwen's bootstrap failure mode: the managed build in the normal home, the base build under isolation.
      const out = await effectiveBuild(["/bin/sh", "-c", "printf %s \"$FAKE_VERSION\""], { cwd: root, env: { FAKE_VERSION: "0.24.1" } });
      expect(out).toBe("0.24.1");
      expect(parseVersion(out)).toBe("0.24.1");
      expect(parseVersion(await effectiveBuild(["/bin/sh", "-c", "printf %s \"$FAKE_VERSION\""], { cwd: root, env: { FAKE_VERSION: "0.24.7" } }))).toBe("0.24.7");
      expect(parseVersion("qwen code version 0.24.7 (managed)")).toBe("0.24.7");
      expect(parseVersion("no version here")).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // macOS-only: /usr/bin/sandbox-exec does not exist on the ubuntu CI leg (review #146).
  test.skipIf(process.platform !== "darwin")("a seatbelt profile wraps the version command when one is given", async () => {
    const root = fixture();
    try {
      const profile = join(root, "p.sb");
      writeFileSync(profile, "(version 1)(allow default)");
      expect(await effectiveBuild(["/bin/echo", "ok"], { sandboxProfile: profile })).toBe("ok");
      // A profile that denies execution proves the wrapper is really applied.
      writeFileSync(profile, "(version 1)(deny default)");
      await expect(effectiveBuild(["/bin/echo", "ok"], { sandboxProfile: profile })).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("attempt evidence claims (correction 6)", () => {
  test("an exclusive claim is written once and never overwritten", () => {
    const root = fixture();
    try {
      const claim = join(root, "native-owner.json");
      claimExclusive(claim, JSON.stringify({ pid: 1 }));
      expect(() => claimExclusive(claim, JSON.stringify({ pid: 2 }))).toThrow();
      expect(JSON.parse(readFileSync(claim, "utf8")).pid).toBe(1);
      const rec = join(root, "00-solo-pi.json");
      writeRecordFresh(rec, "{}");
      expect(() => writeRecordFresh(rec, "{}")).toThrow(/attempt evidence already exists/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("submission patch capture (correction 4)", () => {
  test("new source files enter the binary patch; files outside the source dirs stay out", async () => {
    const root = fixture();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/tracked.py"), "a\n");
      writeFileSync(join(root, "README.md"), "r\n");
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
      const base = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, "src/tracked.py"), "a\nb\n");
      writeFileSync(join(root, "src/new_module.py"), "new\n"); // a source file the agents created
      writeFileSync(join(root, "scratch.txt"), "outside\n"); // outside the guarded layout: not in the patch
      const patch = await collectSubmissionPatch(root, base, ["src"]);
      expect(patch).toContain("new_module.py");
      expect(patch).toContain("tracked.py");
      expect(patch).not.toContain("scratch.txt");
      // The patch applies cleanly against the baseline: it is a complete submission.
      const work = mkdtempSync(join(tmpdir(), "ahub-bench-v3-apply-"));
      try {
        git(work, "init", "-q");
        mkdirSync(join(work, "src"));
        writeFileSync(join(work, "src/tracked.py"), "a\n");
        git(work, "add", "-A");
        git(work, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
        const apply = spawnSync("git", ["apply", "--whitespace=nowarn"], { cwd: work, input: patch, encoding: "utf8" });
        expect(apply.status).toBe(0);
        expect(readFileSync(join(work, "src/new_module.py"), "utf8")).toBe("new\n");
      } finally { rmSync(work, { recursive: true, force: true }); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("disposal ordering (correction 5)", () => {
  test("a failing closer neither stops the others nor erases the record captured before disposal", async () => {
    const root = fixture();
    try {
      const order: string[] = [];
      const errors = await disposeAll([
        () => { order.push("first"); },
        () => { throw new Error("closer failed"); },
        () => { order.push("last"); },
      ]);
      expect(order).toEqual(["first", "last"]); // every closer ran
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("closer failed");
      // The active-window record, captured before disposal, is written afterwards, intact.
      const record = join(root, "active-window.json");
      writeRecordFresh(record, JSON.stringify({ elapsedMs: 10, disposalErrors: errors }));
      expect(JSON.parse(readFileSync(record, "utf8")).elapsedMs).toBe(10);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// runner.py's v3 gates: manifest validation, prepare provenance, request gate, outside-changes and the report's
// separate quality/model/request-linkage coverage (no Docker, no live agents).
describe("runner.py v3 gates (#140)", () => {
  test("manifest v3 validates, its plan adds up, and malformed v3 fields are refused", () => {
    const code = `import importlib.util,json
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
v3=json.load(open(${JSON.stringify(join(import.meta.dir, "../../scripts/benchmarks/manifest-v3-pi-qwen.json"))}))
m.validate_manifest(v3)
assert v3['plan']['study']['attempts']==60 and v3['plan']['study']['active_ceiling_s']==18000
assert [m.required_actors(a) for a in v3['arms']]==[['pi'],['qwen'],['pi','qwen']]
import copy
bad=copy.deepcopy(v3); bad['cases'][0]['source_dirs']=['lib']
try: m.validate_manifest(bad); raise AssertionError('bogus source_dirs accepted')
except m.BenchError as e: assert 'source_dirs' in str(e)
bad=copy.deepcopy(v3); bad['versions']['qwen']='managed'
try: m.validate_manifest(bad); raise AssertionError('unpinned build accepted')
except m.BenchError as e: assert 'qwen build' in str(e)
bad=copy.deepcopy(v3); del bad['expected_provider']
try: m.validate_manifest(bad); raise AssertionError('missing provider pin accepted')
except m.BenchError as e: assert 'expected_provider' in str(e)
bad=copy.deepcopy(v3); bad['plan']['study']['attempts']=59
try: m.validate_manifest(bad); raise AssertionError('wrong plan accepted')
except m.BenchError as e: assert 'do not match 60 attempts' in str(e)
`;
    const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  });

  test("prepare writes the sealed instruction and pins the driver, peer bus and candidate sources", () => {
    const root = fixture();
    try {
      const archive = join(root, "sample_repo-7.tar");
      const pack = spawnSync("python3", ["-c", `import tarfile,io; t=tarfile.open(${JSON.stringify(archive)},'w'); i=tarfile.TarInfo('src/tracked.py'); b=b'a'; i.size=1; t.addfile(i,io.BytesIO(b)); t.close()`]);
      expect(pack.status).toBe(0);
      const manifest = { schema: "agent-hub.cooperbench-run/v1", headless: true, upstream: { commit: "63b9d44d9f39a02fccf5bf0052db48a917a011fd" }, arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], versions: { pi: "1.0.1", qwen: "0.24.7" }, models: { pi: "dgx/coding", qwen: "dgx/coding" }, fixed_backend: "b", expected_served_model: "s", expected_provider: "p", cases: [{ repo: "sample_repo", task: 7, features: [1, 2], image_digest: "sample@sha256:" + "d".repeat(64), base_commit: "e".repeat(40), archive_sha256: sha(readFileSync(archive)), prompt_sha256: ["a".repeat(64), "b".repeat(64)], source_dirs: ["src"] }] };
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const run = spawnSync("python3", [script, "prepare", "--manifest", manifestPath, "--archives", root, "--output", join(root, "output")], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
      const prepared = JSON.parse(readFileSync(join(root, "output", "prepared.json"), "utf8"));
      expect(prepared.fixtures).toHaveLength(3);
      expect(prepared.fixtures[0].source_dirs).toEqual(["src"]);
      const rel = (f: string) => createHash("sha256").update(readFileSync(join(import.meta.dir, f))).digest("hex");
      expect(prepared.pi_qwen_runner_sha256).toBe(rel("../../scripts/benchmarks/native-pi-qwen.ts"));
      expect(prepared.peer_bus_sha256).toBe(rel("../../scripts/benchmarks/peer-bus-mcp.py"));
      expect(prepared.source_pins["src/models/relay.ts"]).toBe(rel("../../src/models/relay.ts"));
      const agents = readFileSync(join(root, "output", "fixtures", "00-solo-pi", "AGENTS.md"), "utf8");
      expect(agents).toContain("Source edits only under src/");
      // The instruction is part of the sealed baseline: grading's metadata hash binds it.
      expect(prepared.fixtures[0].baseline_paths).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the v3 request gate and outside-change check qualify attempts like the TS qualification", () => {
    const root = fixture();
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/a.py"), "a\n");
      git(root, "init", "-q");
      git(root, "add", "-A");
      git(root, "-c", "user.name=B", "-c", "user.email=b@localhost", "commit", "-qm", "base");
      const code = `import importlib.util,json,pathlib,subprocess
s=importlib.util.spec_from_file_location('r',${JSON.stringify(script)});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
man={'fixed_backend':'b','expected_served_model':'s','expected_provider':'p'}
rec=lambda **kw: {'id':'1','requestedModel':'b','provider':'p','actualModel':'s','identitySource':'stream','outcome':'completed','identified':True,'durationMs':1,**kw}
assert m.v3_request_gate({'requests':[rec()]},man) is None
assert m.v3_request_gate({'requests':[]},man)=='generation requests unverified'
assert m.v3_request_gate(None,man)=='generation model identity missing'
can=rec(outcome='cancelled',identified=False,actualModel=None,provider=None)
assert m.v3_request_gate({'requests':[can]},man).startswith('no completed generation request')
assert m.v3_request_gate({'requests':[rec(),can]},man) is None  # cancelled-before-identification certifies nothing
canbad=rec(outcome='cancelled',mismatch=True,actualModel='other')
assert m.v3_request_gate({'requests':[rec(),canbad]},man)=='generation served model mismatch flagged'  # identified before the cancel: the mismatch stands (#146)
canwrong=rec(outcome='cancelled',actualModel='other')
assert m.v3_request_gate({'requests':[rec(),canwrong]},man)=='generation model identity unverified'
canprov=rec(outcome='cancelled',provider='q')
assert m.v3_request_gate({'requests':[rec(),canprov]},man)=='generation provider mismatch'
canok=rec(outcome='cancelled')
assert m.v3_request_gate({'requests':[rec(),canok]},man) is None  # a cleanly identified cancellation fails nothing
hb=rec(identified=False,actualModel=None)
assert m.v3_request_gate({'requests':[hb]},man)=='generation model identity unverified'
assert m.v3_request_gate({'requests':[rec(mismatch=True)]},man)=='generation served model mismatch flagged'
assert m.v3_request_gate({'requests':[rec(actualModel='other')]},man)=='generation model identity unverified'
assert m.v3_request_gate({'requests':[rec(provider='q')]},man)=='generation provider mismatch'
assert m.v3_request_gate({'requests':[rec(provider=None)]},man) is None
link=m.v3_linkage({'requests':[rec(),can]})
assert link=={'requests':2,'completed':1,'identified':1,'cancelledUnidentified':1,'mismatches':0,'providerMissing':0}
cwd=pathlib.Path(${JSON.stringify(root)})
assert m.v3_outside_changes(cwd,['src'])==[]
(cwd/'src'/'new.py').write_text('n')
assert m.v3_outside_changes(cwd,['src'])==[]  # a new file inside the guarded layout is the patch's business
(cwd/'notes.txt').write_text('x')
assert m.v3_outside_changes(cwd,['src'])==['notes.txt']
patch=m.collect_patch_v3(cwd,'HEAD',['src'])
assert b'new.py' in patch and b'notes.txt' not in patch
`;
      const r = spawnSync("python3", ["-B", "-c", code], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the v3 report keeps quality, model and request-linkage coverage separate with unavailable in the denominator", () => {
    const root = fixture();
    try {
      const manifest = { schema: "agent-hub.cooperbench-run/v1", headless: true, upstream: { commit: "63b9d44d9f39a02fccf5bf0052db48a917a011fd" }, arms: ["solo-pi", "solo-qwen", "joint-pi-qwen"], cases: [{ repo: "r", task: 1, features: [1, 2], image_digest: "i@sha256:" + "d".repeat(64), base_commit: "e".repeat(40), archive_sha256: "a".repeat(64), prompt_sha256: ["a".repeat(64), "b".repeat(64)], source_dirs: ["src"] }] };
      const bytes = JSON.stringify(manifest);
      writeFileSync(join(root, "manifest.json"), bytes);
      const arms = manifest.arms;
      writeFileSync(join(root, "cohort.json"), JSON.stringify({ manifest_sha256: sha(bytes), cases: [0], arms, runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t" }));
      const linkage = { requests: 3, completed: 2, identified: 2, cancelledUnidentified: 1, mismatches: 0, providerMissing: 0 };
      const patch = join(root, "00-solo-pi.patch"), evaluation = join(root, "00-solo-pi.json");
      writeFileSync(patch, "diff\n");
      writeFileSync(evaluation, "{}\n");
      const rows = [
        { case: 0, arm: "solo-pi", status: "scored", pass: true, input_sha256: sha("diff\n"), patch_path: patch, evaluation_path: evaluation, evaluation_sha256: sha("{}\n"), native_usage: { pi: 100, qwen: null }, request_linkage: linkage, model_identity: { verified: true } },
        { case: 0, arm: "solo-qwen", status: "unavailable", reason: "generation model identity unverified", pass: null, request_linkage: linkage, model_identity: { verified: false } },
        { case: 0, arm: "joint-pi-qwen", status: "missing", pass: null },
      ];
      writeFileSync(join(root, "grade.json"), JSON.stringify({ manifest_sha256: sha(bytes), runner_sha256: "r", native_runner_sha256: "n", teardown_sha256: "t", cohort: [0], controls: {}, rows }));
      const run = spawnSync("python3", [script, "report", "--run", root], { encoding: "utf8" });
      if (run.status !== 0) throw new Error(run.stderr);
      const report = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
      const solo = report.arms["solo-pi"];
      expect(solo.planned).toBe(1);
      expect(solo.scored).toBe(1);
      expect(solo.both_passed).toBe(1);
      expect(solo.native_usage.pi_tokens).toBe(100);
      expect(solo.model_identity).toEqual({ verified: 1, attempts: 1 });
      expect(solo.request_linkage.completed).toBe(2);
      const qwen = report.arms["solo-qwen"];
      expect(qwen.unavailable).toBe(1); // unavailable stays in the planned denominator
      expect(qwen.scored).toBe(0);
      expect(qwen.model_identity.verified).toBe(0);
      expect(qwen.request_linkage.cancelledUnidentified).toBe(1);
      expect(report.arms["joint-pi-qwen"].request_linkage.attempts).toBe(0); // missing record: no evidence, never imputed
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
