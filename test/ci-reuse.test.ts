import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hubGitSync } from "../src/hub/git.ts";

test("CI reuse reader requires exact tree, eligible event and both platform gates plus seeded guards", async () => {
  const runs = [1, 2, 3, 4].map(id => ({ id, head_sha: String(id), conclusion: "success", event: id === 1 ? "workflow_dispatch" : "pull_request" }));
  const queried: string[] = [];
  const api = async (path: string) => {
    queried.push(path);
    if (path.includes("status=success")) return { total_count: runs.length, workflow_runs: runs };
    if (path.includes("status=in_progress")) return { total_count: 0, workflow_runs: [] };
    if (path.startsWith("git/commits/")) return { tree: { sha: path.endsWith("2") ? "different" : "expected" } };
    return { total_count: 3, jobs: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: path.includes("/3/") && name === "seeded guards" ? "skipped" : "success" })) };
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "reuse", run: { id: 4 } });
  expect(queried).not.toContain("git/commits/1");
  expect(queried).not.toContain("actions/runs/2/jobs?per_page=100");
});

import * as gates from "../scripts/ci-gates.mjs";
const fullJobs = () => ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: "success" }));
const gateRun = (id: number, tree = "expected", status = "in_progress", scope = "full") => ({ id, tree, status, scope, event: "pull_request", conclusion: status === "completed" ? "success" : null, jobs: fullJobs(), jobsComplete: true });
const admission = (runs: unknown[], complete = true, currentRunId = 99) => {
  const fn = (gates as Record<string, unknown>).fullGateAdmission;
  expect(typeof fn).toBe("function");
  return (fn as Function)("expected", runs, { complete, currentRunId });
};

test("full gate admission reuses exact complete proof before considering running duplicates", () => {
  expect(admission([gateRun(1), gateRun(2, "expected", "completed")])).toMatchObject({ kind: "reuse", run: { id: 2 } });
  expect(admission([gateRun(2, "expected", "completed")], false)).toMatchObject({ kind: "reuse", run: { id: 2 } });
  expect(admission([gateRun(99, "expected", "completed")])).toEqual({ kind: "run" });
});

test("full gate admission refuses running and queued identical trees but ignores current or unrelated work", () => {
  for (const status of ["in_progress", "queued"]) expect(admission([gateRun(1, "expected", status)])).toMatchObject({ kind: "duplicate", run: { id: 1 } });
  expect(admission([gateRun(99), gateRun(1, "different")])).toEqual({ kind: "run" });
  expect(admission([{ ...gateRun(1), event: "workflow_dispatch", scope: "other" }])).toEqual({ kind: "run" });
});

test("full gate admission never reuses skipped or incomplete gates and preserves unknown active evidence", () => {
  const incomplete = gateRun(1, "expected", "completed");
  incomplete.jobs = fullJobs().filter(job => job.name !== "seeded guards");
  expect(admission([incomplete])).toEqual({ kind: "run" });
  const skipped = gateRun(2, "expected", "completed"); skipped.jobs[2]!.conclusion = "skipped";
  expect(admission([skipped])).toEqual({ kind: "run" });
  expect(admission([{ ...gateRun(3), tree: undefined }])).toMatchObject({ kind: "unknown" });
  expect(admission([{ ...gateRun(3), scope: "unknown" }])).toMatchObject({ kind: "unknown" });
  expect(admission([], false)).toMatchObject({ kind: "unknown" });
});

test("full gate API admission is fail closed on API failure and scopes timing or bundle dispatch separately", async () => {
  const fn = (gates as Record<string, unknown>).readFullGateAdmission;
  expect(typeof fn).toBe("function");
  expect(await (fn as Function)(async () => { throw new Error("API unavailable secret diagnostic"); }, "expected", { currentRunId: 99 })).toMatchObject({ kind: "unknown" });
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.startsWith("actions/workflows/")) return { total_count: path.includes("status=in_progress") ? 2 : 0, workflow_runs: path.includes("status=in_progress") ? [
      { id: 1, head_sha: "one", status: "in_progress", conclusion: null, event: "workflow_dispatch" },
      { id: 2, head_sha: "two", status: "in_progress", conclusion: null, event: "workflow_dispatch" },
    ] : [] };
    if (path.startsWith("git/commits/")) return { tree: { sha: "expected" } };
    return { total_count: 1, jobs: [{ name: path.includes("/1/") ? "macos-timing" : "prepare-bundle", status: "in_progress", conclusion: null }] };
  };
  expect(await (fn as Function)(api, "expected", { currentRunId: 99 })).toEqual({ kind: "run" });
  expect(calls.length).toBeLessThan(20);
});

test("API admission distinguishes launched gate jobs from serialized pending controllers and decision-only work", async () => {
  const fn = (gates as Record<string, unknown>).readFullGateAdmission as Function;
  for (const kind of ["gate", "queued-gate", "decision", "pending", "different", "current"]) {
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path.startsWith("actions/workflows/")) {
        const visible = path.includes(kind === "pending" ? "status=queued" : "status=in_progress");
        return { total_count: visible ? 1 : 0, workflow_runs: visible ? [{ id: kind === "current" ? 99 : 1, head_sha: "one", event: "pull_request", status: kind === "pending" ? "queued" : "in_progress" }] : [] };
      }
      if (kind === "pending" || kind === "current") throw new Error("a pending/self controller should not be read as another gate");
      if (path.startsWith("git/")) return { tree: { sha: kind === "different" ? "different" : "expected" } };
      const jobs = kind === "decision" ? [{ name: "decision", status: "in_progress", conclusion: null }]
        : [{ name: "decision", status: "completed", conclusion: "success" }, { name: "check (ubuntu-latest)", status: kind === "queued-gate" ? "queued" : "in_progress", conclusion: null }];
      return { total_count: jobs.length, jobs };
    };
    expect(await fn(api, "expected", { currentRunId: 99 })).toMatchObject({ kind: ["gate", "queued-gate"].includes(kind) ? "duplicate" : "run" });
    if (kind === "pending" || kind === "current") expect(calls.some(path => path.startsWith("git/") || path.startsWith("actions/runs/"))).toBe(false);
  }
});

test("API admission reuses full success without querying running work and refuses truncated active coverage", async () => {
  const fn = (gates as Record<string, unknown>).readFullGateAdmission as Function;
  const api = async (path: string) => {
    if (path.startsWith("actions/workflows/")) {
      if (!path.includes("status=success")) throw new Error("reuse should win first");
      return { total_count: 1, workflow_runs: [{ id: 1, head_sha: "one", event: "push", conclusion: "success" }] };
    }
    return path.startsWith("git/") ? { tree: { sha: "expected" } } : { total_count: 3, jobs: fullJobs() };
  };
  expect(await fn(api, "expected", { currentRunId: 99 })).toMatchObject({ kind: "reuse", run: { id: 1 } });
  const truncated = async (path: string) => ({ total_count: path.includes("status=in_progress") ? 101 : 0, workflow_runs: [] });
  expect(await fn(truncated, "expected", { currentRunId: 99 })).toMatchObject({ kind: "unknown" });
});

test("successful reused required checks cannot become a fresh full-gate proof", async () => {
  const marker = "Reuse verified identical-tree full gate";
  const reused = fullJobs().map(job => ({ ...job, steps: [{ name: marker, conclusion: "success" }] }));
  const genuine = fullJobs().map(job => ({ ...job, steps: [{ name: marker, conclusion: "skipped" }] }));
  expect(admission([{ ...gateRun(1, "expected", "completed"), jobs: reused }])).toEqual({ kind: "run" });
  expect(admission([{ ...gateRun(2, "expected", "completed"), jobs: genuine }])).toMatchObject({ kind: "reuse", run: { id: 2 } });
  const api = async (path: string) => {
    if (path.startsWith("actions/workflows/")) return { workflow_runs: [1, 2].map(id => ({ id, head_sha: String(id), conclusion: "success", event: "pull_request" })) };
    if (path.startsWith("git/")) return { tree: { sha: "expected" } };
    return { jobs: path.includes("/1/") ? reused : genuine };
  };
  const read = gates.readFullGateAdmission;
  const boundedApi = async (path: string) => {
    const value = await api(path);
    return "workflow_runs" in value ? { ...value, total_count: value.workflow_runs!.length } : "jobs" in value ? { ...value, total_count: value.jobs!.length } : value;
  };
  expect(await read(boundedApi, "expected", { currentRunId: 99 })).toMatchObject({ kind: "reuse", run: { id: 2 } });
});

test("#609 PR checks run in a group per PR where a newer pending run replaces the older; main and dispatch keep queue max", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/check.yml", import.meta.url)).text();
  expect(workflow).toContain("github.event_name == 'pull_request' && format('check-pr-{0}', github.event.pull_request.number) || 'check-main'");
  expect(workflow).toContain("cancel-in-progress: false"); // GitHub refuses queue max with cancel-in-progress true
  expect(workflow).toContain("queue: ${{ github.event_name == 'pull_request' && 'single' || 'max' }}");
  expect(workflow).toContain("inputs.timing_runs == '20' && 'macos-timing'");
  for (const job of ["check:", "seeded:", "decision:"]) expect(workflow).toContain(`\n  ${job}`);
});

type ProofLoss = "404" | "timeout" | "malformed" | "missing" | "invalid-json";
const proofLosses: ProofLoss[] = ["404", "timeout", "malformed", "missing", "invalid-json"];
function lostProof(kind: ProofLoss): unknown {
  if (kind === "404") throw Object.assign(new Error("fixture unavailable"), { status: 404 });
  if (kind === "timeout") throw Object.assign(new Error("fixture request elapsed"), { name: "TimeoutError" });
  if (kind === "invalid-json") throw new SyntaxError("fixture unreadable JSON");
  return kind === "missing" ? undefined : { unexpected: true };
}
const successRow = (id: number) => ({ id, head_sha: "success-" + id, status: "completed", conclusion: "success", event: "push" });
const successPage = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });
const emptyRuns = () => successPage([]);
const verifiedJobs = () => ({ total_count: 3, jobs: fullJobs() });

for (const phase of ["commit", "jobs"] as const) for (const loss of proofLosses) test("F1a lost " + phase + " proof (" + loss + ") does not hide a later verified reusable run", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return successPage([successRow(1), successRow(2)]);
    if (path.includes("status=in_progress")) throw new Error("later verified proof should avoid active scan");
    if (phase === "commit" && path === "git/commits/success-1" || phase === "jobs" && path.includes("actions/runs/1/")) return lostProof(loss);
    return path.startsWith("git/") ? { tree: { sha: "expected" } } : verifiedJobs();
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "reuse", run: { id: 2 } });
  expect(calls).toContain("actions/runs/2/jobs?per_page=100");
  expect(calls.some(path => path.includes("status=in_progress"))).toBe(false);
});

for (const loss of proofLosses) test("F1b lost success list (" + loss + ") still reads active coverage and requests a fresh gate", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return lostProof(loss);
    if (path.includes("status=in_progress")) return emptyRuns();
    throw new Error("lost success list must not invent a candidate");
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toEqual({ kind: "run" });
  expect(calls).toContain("actions/workflows/check.yml/runs?status=in_progress&per_page=100");
});

for (const phase of ["commit", "jobs"] as const) for (const loss of proofLosses) test("F1b only lost " + phase + " proof (" + loss + ") plus empty active coverage requests a fresh gate", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return successPage([successRow(1)]);
    if (path.includes("status=in_progress")) return emptyRuns();
    if (phase === "commit" && path.startsWith("git/") || phase === "jobs" && path.startsWith("actions/runs/")) return lostProof(loss);
    return { tree: { sha: "expected" } };
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toEqual({ kind: "run" });
  expect(calls.some(path => path.includes("status=in_progress"))).toBe(true);
});

test("F1a malformed successful rows are dropped individually rather than hiding later proof", async () => {
  const api = async (path: string) => path.includes("status=success")
    ? successPage([null, { ...successRow(1), id: "not-a-run-id" }, successRow(2)])
    : path.startsWith("git/") ? { tree: { sha: "expected" } } : verifiedJobs();
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "reuse", run: { id: 2 } });
});

for (const phase of ["inventory", "jobs", "commit"] as const) for (const loss of ["404", "timeout", "malformed", "missing"] as const) test("F1c unreadable active " + phase + " (" + loss + ") stays unknown after lost success proof", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return lostProof("404");
    if (path.includes("status=in_progress")) return phase === "inventory" ? lostProof(loss) : successPage([{ id: 10, head_sha: "active", status: "in_progress" }]);
    if (path.startsWith("actions/runs/")) return phase === "jobs" ? lostProof(loss) : { total_count: 1, jobs: [{ name: "check (ubuntu-latest)", status: "in_progress" }] };
    return lostProof(loss);
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "unknown" });
  expect(calls.some(path => path.includes("status=in_progress"))).toBe(true);
});

for (const kind of ["truncated", "unidentifiable"] as const) test("F1c " + kind + " active inventory stays unknown after a lost success list", async () => {
  const api = async (path: string) => {
    if (path.includes("status=success")) return lostProof("404");
    if (path.includes("status=in_progress")) return kind === "truncated"
      ? { total_count: 101, workflow_runs: [] }
      : successPage([{ head_sha: "active", status: "in_progress" }]);
    throw new Error("active inventory cannot be identified");
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "unknown" });
});

test("F1d global request budget remains unknown even when every unsuccessful proof read is lost", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return successPage(Array.from({ length: 100 }, (_, index) => successRow(index + 1)));
    if (path.includes("status=in_progress")) return successPage(Array.from({ length: 25 }, (_, index) => ({ id: 1000 + index, head_sha: "active-" + index, status: "in_progress" })));
    if (path.startsWith("git/")) return { tree: { sha: path.includes("success-") ? "expected" : "different" } };
    if (/actions\/runs\/[1-9][0-9]?\//.test(path) || path.includes("/100/")) return lostProof("404");
    return { total_count: 1, jobs: [{ name: "check (ubuntu-latest)", status: "in_progress" }] };
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "unknown" });
  expect(calls).toHaveLength(240);
});

for (const outcome of ["reject", "valid-proof"] as const) test("F1d shared deadline wins when an in-flight proof read ends at the global deadline: " + outcome, async () => {
  let now = 0;
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return successPage([successRow(1)]);
    if (path.startsWith("git/")) return { tree: { sha: "expected" } };
    if (path.startsWith("actions/runs/")) { now = 100; return outcome === "reject" ? lostProof("timeout") : verifiedJobs(); }
    return emptyRuns();
  };
  // Host-only clock/deadline ports make the global 60-second ceiling deterministic; no wall-clock sleep.
  expect(await gates.readFullGateAdmission(api, "expected", { deadline: 100, now: () => now })).toMatchObject({ kind: "unknown" });
  expect(calls.some(path => path.includes("status=in_progress"))).toBe(false);
});

test("F1c truncated active jobs remain unknown after lost proof", async () => {
  const api = async (path: string) => {
    if (path.includes("status=success")) return lostProof("404");
    if (path.includes("status=in_progress")) return successPage([{ id: 10, head_sha: "active", status: "in_progress" }]);
    if (path.startsWith("git/")) return { tree: { sha: "expected" } };
    return { total_count: 101, jobs: [{ name: "check (ubuntu-latest)", status: "in_progress" }] };
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "unknown" });
});

test("F1d already-exhausted shared deadline grants no API reads", async () => {
  let reads = 0;
  const api = async () => { reads++; return emptyRuns(); };
  expect(await gates.readFullGateAdmission(api, "expected", { deadline: 0, now: () => 1 })).toMatchObject({ kind: "unknown" });
  expect(reads).toBe(0);
});

test("F1e --require still refuses release when lost proof allows only a fresh admission", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-ci-require-"));
  try {
    expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { encoding: "utf8" }).status).toBe(0);
    const preload = join(root, "github-fixture.mjs"), output = join(root, "github-output");
    writeFileSync(preload, [
      "globalThis.fetch = async (url) => {",
      '  const value = String(url);',
      '  if (value.includes("status=success")) return Response.json({total_count:1,workflow_runs:[{id:1,head_sha:"lost-proof",conclusion:"success",event:"push"}]});',
      '  if (value.includes("git/commits/")) return new Response("fixture gone", {status:404});',
      '  if (value.includes("status=in_progress")) return Response.json({total_count:0,workflow_runs:[]});',
      '  throw new Error("unexpected fixture GitHub request");',
      "};",
    ].join("\n"));
    const result = spawnSync(process.execPath, ["--preload", preload, join(import.meta.dir, "../scripts/ci-reuse.mjs"), "--require"], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: "fixture/repo", GITHUB_TOKEN: "fixture-token", GITHUB_RUN_ID: "99", GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No successful full CI gate for this exact tree; release refused");
    expect(readFileSync(output, "utf8")).toBe("run_gate=false\nverified_run=\nadmission=run\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);

const unknownProofFailures: [string, () => never][] = [
  ...[403, 429, 500, 503].map(status => [String(status), () => { throw Object.assign(new Error("fixture HTTP failure"), { status }); }] as [string, () => never]),
  ["response-size", () => { throw Object.assign(new Error("CI admission response exceeded bound"), { code: "CI_RESPONSE_SIZE" }); }],
  ["authentication", () => { throw new Error("CI admission requires repository and scoped Actions read access"); }],
  ["other", () => { throw new Error("fixture transport failure"); }],
  ["type-error", () => { throw new TypeError("fixture transport implementation failed"); }],
  ["limit-looking-error", () => { throw new Error("gate read budget exhausted"); }],
];
for (const phase of ["success-list", "commit", "jobs"] as const) for (const [failure, fail] of unknownProofFailures) test("bounded proof taxonomy keeps " + phase + " " + failure + " unknown even with later valid proof", async () => {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    if (path.includes("status=success")) return phase === "success-list" ? fail() : successPage([successRow(1), successRow(2)]);
    if (path.includes("status=in_progress")) return emptyRuns();
    if (phase === "commit" && path === "git/commits/success-1" || phase === "jobs" && path.includes("actions/runs/1/")) return fail();
    return path.startsWith("git/") ? { tree: { sha: "expected" } } : verifiedJobs();
  };
  expect(await gates.readFullGateAdmission(api, "expected")).toMatchObject({ kind: "unknown" });
  expect(calls).toHaveLength(phase === "success-list" ? 1 : phase === "commit" ? 2 : 3);
});

test("CLI HTTP failures retain their status: 503 proof failure refuses fresh admission", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-ci-status-"));
  try {
    expect(hubGitSync(["init", "-q", root], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { encoding: "utf8" }).status).toBe(0);
    const preload = join(root, "github-fixture.mjs"), output = join(root, "github-output");
    writeFileSync(preload, [
      "globalThis.fetch = async (url) => {",
      '  const value = String(url);',
      '  if (value.includes("status=success")) return Response.json({total_count:1,workflow_runs:[{id:1,head_sha:"lost-proof",conclusion:"success",event:"push"}]});',
      '  if (value.includes("git/commits/")) return new Response("fixture unavailable", {status:503});',
      '  if (value.includes("status=in_progress")) return Response.json({total_count:0,workflow_runs:[]});',
      '  throw new Error("unexpected fixture request");',
      "};",
    ].join("\n"));
    const result = spawnSync(process.execPath, ["--preload", preload, join(import.meta.dir, "../scripts/ci-reuse.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, GITHUB_REPOSITORY: "fixture/repo", GITHUB_TOKEN: "fixture-token", GITHUB_RUN_ID: "99", GITHUB_OUTPUT: output },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI admission refused");
    expect(readFileSync(output, "utf8")).toBe("run_gate=false\nverified_run=\nadmission=unknown\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
