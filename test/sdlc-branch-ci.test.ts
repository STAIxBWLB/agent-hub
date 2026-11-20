import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { taskSample } from "../src/hub/sdlc-metrics.ts";

const HEAD = "a".repeat(40), MERGED = "b".repeat(40), cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
type Mode = "pass" | "fail-rerun" | "post-merge-rerun" | "straddling" | "invalid-time" | "same-second" | "nohead" | "cancelled" | "no-runner" | "draft" | "missing" | "overlap" | "truncated" | "timeline-error" | "job-error";
function rig(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), "ahub-branch-cost-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  const start = new Date(Date.now() - 10_000).toISOString(), ready = new Date(Date.now() - 8_000).toISOString();
  const runAt = new Date(Date.now() - (mode === "draft" ? 9_000 : 5_000)).toISOString(), mergedAt = new Date(Date.now() + 1_000).toISOString();
  const attempt = mode === "fail-rerun" || mode === "post-merge-rerun" ? 2 : 1, conclusion = mode === "cancelled" ? "cancelled" : "success";
  const row = { id: 11, path: ".github/workflows/check.yml", created_at: runAt, head_sha: HEAD, status: "completed", conclusion, run_attempt: attempt, pull_requests: [] };
  const calls: string[][] = [];
  const reply = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value) });
  const gh: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "pr") return reply({ headRefOid: HEAD, state: "MERGED", mergeCommit: { oid: MERGED }, reviewDecision: "APPROVED", reviewRequests: [], files: [], changedFiles: 0, statusCheckRollup: [] });
    if (args.includes("graphql")) return reply({ data: { repository: { pullRequest: { number: 7, headRefOid: HEAD, state: "MERGED", mergedAt, commits: { nodes: [{ commit: { oid: HEAD } }], pageInfo: { hasNextPage: false } }, reviews: { nodes: [], pageInfo: { hasNextPage: false } } } } } });
    const endpoint = args.find(value => value.startsWith("repos/")) ?? "";
    if (endpoint.includes("actions/workflows/check.yml/runs")) return reply({ total_count: 101, workflow_runs: [row] });
    if (endpoint.endsWith("/pulls/7")) return reply({ number: 7, state: "closed", created_at: start, merged_at: mergedAt, head: { ref: "task/7", repo: { full_name: mode === "missing" ? null : "owner/repo" } }, base: { repo: { full_name: "owner/repo" } } });
    if (endpoint.endsWith("/pulls")) return reply([{ number: 7, created_at: start, closed_at: mergedAt }, ...(mode === "overlap" ? [{ number: 8, created_at: start, closed_at: mergedAt }] : [])]);
    if (endpoint.endsWith("/actions/runs")) return reply({ total_count: mode === "truncated" ? 2 : 1, workflow_runs: [row] });
    if (endpoint.endsWith("/issues/7/timeline")) return mode === "timeline-error" ? { code: 1, stdout: "" } : reply([{ event: "ready_for_review", created_at: mode === "same-second" ? runAt : ready }]);
    if (endpoint.endsWith("/jobs")) return mode === "job-error" ? { code: 1, stdout: "" } : reply({ total_count: 1, jobs: [{ name: "check (macos-latest) shard 1/4", status: "completed", conclusion: mode === "draft" ? "skipped" : mode === "no-runner" ? "cancelled" : "success", runner_id: mode === "draft" || mode === "no-runner" ? null : 1 }] });
    const attemptNumber = endpoint.match(/\/attempts\/(\d+)$/)?.[1];
    if (attemptNumber) {
      const n = Number(attemptNumber), after = mode === "post-merge-rerun" && n === 2;
      const at = after ? new Date(Date.parse(mergedAt) + 2_000).toISOString() : runAt;
      return reply({ id: 11, run_attempt: n, status: "completed", created_at: at, updated_at: mode === "straddling" ? new Date(Date.parse(mergedAt) + 2_000).toISOString() : mode === "invalid-time" ? start : at, conclusion: mode === "fail-rerun" && n === 1 ? "failure" : conclusion });
    }
    return { code: 1, stdout: "" };
  };
  const config = sdlcConfig({ mode: "advise", auto_merge: "off" });
  const tasks = new Tasks({ cwd: root, board, bus, roles: { claude: ["planner"] }, project: "fixture", repository: "owner/repo", routing: () => loadRouting(root), notify: () => {}, sdlc: { config: () => config, gh } });
  const task = board.propose("user", { title: "fixture", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress", refs: { commit: HEAD }, sdlc: { repo: "owner/repo", pr: 7, stage: "build" } });
  board.update(task.id, "codex", "done", { state: "in_review" }, undefined, mode === "nohead" ? {} : { requestHead: HEAD });
  board.update(task.id, "user", "approved", { state: "approved" });
  return { tasks, board, id: task.id, calls };
}

test("#1579 an unmatched hub check keeps its unknown result instead of a GitHub fallback", () => {
  const history = [{ at: 1, event: "accepted" }, { at: 2, event: "check run passed", requestHead: MERGED }, { at: 3, event: "done", requestHead: HEAD }];
  expect(taskSample({ id: 1, history }, { firstPass: 1 }).first_pass_check).toBeNull();
});

for (const mode of ["pass", "fail-rerun", "post-merge-rerun", "straddling", "invalid-time", "same-second", "nohead", "cancelled", "no-runner", "draft", "missing", "overlap", "truncated", "timeline-error", "job-error"] as const) {
  test(`#1579 reviewer merge branch evidence: ${mode}`, async () => {
    const f = rig(mode);
    expect(await f.tasks.captureExternalMerge(f.id)).toBe("merged");
    const metrics = f.tasks.sdlcMetrics("user").metrics;
    if (["missing", "overlap", "truncated", "timeline-error", "job-error", "straddling", "invalid-time", "same-second"].includes(mode)) {
      expect(metrics.ci_runs_at_merge.n).toBe(0);
      expect(metrics.first_pass_check.n).toBe(0);
      expect(metrics.acceptance_to_merge_ms.n).toBe(0);
    } else {
      expect(metrics.ci_runs_at_merge.n).toBe(1);
      expect(metrics.acceptance_to_merge_ms.n).toBe(1);
      expect(metrics.full_gate_runs.mean).toBe(1);
      if (mode === "pass") { expect(metrics.first_pass_check.rate).toBe(1); expect(metrics.macos_shard_runs.mean).toBe(1); expect(metrics.successful_gate_runs.mean).toBe(1); }
      if (mode === "fail-rerun") { expect(metrics.first_pass_check.rate).toBe(0); expect(metrics.macos_shard_runs.mean).toBe(2); expect(f.calls.some(args => args.some(arg => arg.endsWith("/attempts/1")))).toBe(true); }
      if (mode === "post-merge-rerun") { expect(metrics.first_pass_check.rate).toBe(1); expect(metrics.same_head_ci_reruns.mean).toBe(0); expect(metrics.macos_shard_runs.mean).toBe(1); expect(f.calls.some(args => args.some(arg => arg.endsWith("/attempts/2/jobs")))).toBe(false); }
      if (mode === "nohead") expect(metrics.first_pass_check.n).toBe(0);
      if (mode === "no-runner") { expect(metrics.first_pass_check.n).toBe(0); expect(metrics.macos_shard_runs.mean).toBe(0); }
      if (mode === "cancelled" || mode === "draft") { expect(metrics.first_pass_check.n).toBe(0); expect(metrics.cancelled_gate_runs.mean).toBe(mode === "cancelled" ? 1 : 0); }
    }
  });
}
