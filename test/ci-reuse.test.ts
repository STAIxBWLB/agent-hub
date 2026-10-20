import { expect, test } from "bun:test";
import { findVerifiedRun } from "../scripts/ci-gates.mjs";

test("CI reuse requires the exact tree and both platform gates plus seeded guards", async () => {
  const runs = [1, 2, 3, 4].map(id => ({ id, head_sha: String(id), conclusion: "success", event: id === 1 ? "workflow_dispatch" : "pull_request" }));
  const queried: string[] = [];
  const api = async (path: string) => {
    queried.push(path);
    if (path.startsWith("actions/workflows/")) return { workflow_runs: runs };
    if (path.startsWith("git/commits/")) return { tree: { sha: path.endsWith("2") ? "different" : "expected" } };
    return { jobs: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: path.includes("/3/") && name === "seeded guards" ? "skipped" : "success" })) };
  };
  expect((await findVerifiedRun(api, "expected"))?.id).toBe(4);
  expect(queried).not.toContain("git/commits/1");
  expect(queried).not.toContain("actions/runs/2/jobs?per_page=100");
});

test("CI reuse refuses incomplete runs and propagates unavailable evidence", async () => {
  const api = async (path: string) => path.startsWith("actions/workflows/")
    ? { workflow_runs: [{ id: 1, head_sha: "1", conclusion: "success", event: "push" }] }
    : path.startsWith("git/") ? { tree: { sha: "expected" } } : { jobs: [] };
  expect(await findVerifiedRun(api, "expected")).toBeUndefined();
  await expect(findVerifiedRun(async () => { throw new Error("API unavailable"); }, "expected")).rejects.toThrow("API unavailable");
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
  expect((await findVerifiedRun(api, "expected"))?.id).toBe(2);
  const read = gates.readFullGateAdmission;
  const boundedApi = async (path: string) => {
    const value = await api(path);
    return "workflow_runs" in value ? { ...value, total_count: value.workflow_runs!.length } : "jobs" in value ? { ...value, total_count: value.jobs!.length } : value;
  };
  expect(await read(boundedApi, "expected", { currentRunId: 99 })).toMatchObject({ kind: "reuse", run: { id: 2 } });
});

test("#609 PR checks run in a group per PR and cancel superseded heads; main and dispatch queue without cancel", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/check.yml", import.meta.url)).text();
  expect(workflow).toContain("github.event_name == 'pull_request' && format('check-pr-{0}', github.event.pull_request.number) || 'check-main'");
  expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  expect(workflow).toContain("inputs.timing_runs == '20' && 'macos-timing'");
  for (const job of ["check:", "seeded:", "decision:"]) expect(workflow).toContain(`\n  ${job}`);
});
