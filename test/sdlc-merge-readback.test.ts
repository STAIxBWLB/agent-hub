import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { ciRunCounts, cleanMergeCost, mergeCostFrom } from "../src/hub/cost-governance.ts";
import { sdlcMetrics, taskSample, type MetricTask } from "../src/hub/sdlc-metrics.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub #481 S7 (hub task #442): review rounds, CI runs and reruns per merged PR, read from the PR once at merge and recorded on the receipt.
const A = "a".repeat(40), BASE = "c".repeat(40), MERGED = "d".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
// The PR merges after the task was accepted (the board stamps real time), so acceptance-to-merge is a known duration.
const MERGED_AT = new Date(Date.now() + 3_600_000).toISOString();

type CostReply = "ok" | "partial" | "fail" | "open";
/** A PR that merges when `gh pr merge` runs, with a fake cost query (the GraphQL read `readPrCostHistory` makes) and a fake workflow-run list. */
function fixture(cost: CostReply) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-merge-readback-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  let state: "OPEN" | "MERGED" = "OPEN"; const calls: string[][] = [];
  const view = () => ({ headRefOid: A, headRefName: "feat/x", isDraft: false, baseRefName: "main", baseRefOid: BASE, state, changedFiles: 1, statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }],
    reviewDecision: null, reviewRequests: [], files: [{ path: "src/a.ts", changeType: "MODIFIED" }], ...(state === "MERGED" ? { mergeCommit: { oid: MERGED } } : {}) });
  const pageInfo = { hasNextPage: false };
  const run: SdlcGh = async args => {
    calls.push(args);
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    if (args[0] === "pr" && args[1] === "merge") { state = "MERGED"; return { code: 0, stdout: "" }; }
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(state === "OPEN" ? [{ number: 1, headRefOid: A, baseRefName: "main", baseRefOid: BASE }] : []) };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(view()) };
    if (query.includes("mergedAt")) {
      if (cost === "fail") return { code: 1, stdout: "" };
      const nodes = [{ commit: { oid: A } }];
      return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { number: 1, state: cost === "open" ? "OPEN" : "MERGED", headRefOid: A, mergedAt: MERGED_AT,
        commits: { nodes, pageInfo }, reviews: { nodes: [{ databaseId: 11, commit: { oid: A } }, { databaseId: 12, commit: { oid: A } }, { databaseId: 12, commit: { oid: A } }], pageInfo } } } } }) };
    }
    if (args[0] === "api" && args[1]?.includes("/actions/workflows/check.yml/runs")) {
      if (cost === "partial") return { code: 0, stdout: JSON.stringify({ total_count: 5, workflow_runs: [{ id: 1, run_attempt: 1, head_sha: A, pull_requests: [1] }] }) };
      return { code: 0, stdout: JSON.stringify({ total_count: 3, workflow_runs: [{ id: 901, run_attempt: 1, head_sha: A, pull_requests: [1] }, { id: 902, run_attempt: 3, head_sha: A, pull_requests: [1] }, { id: 903, run_attempt: 1, head_sha: "e".repeat(40), pull_requests: [2] }] }) };
    }
    if (query.includes("queue_p")) {
      const repository: Record<string, unknown> = { pullRequests: { nodes: state === "OPEN" ? [{ number: 1, headRefOid: A, baseRefName: "main", baseRefOid: BASE }] : [], pageInfo },
        queue_p1: { ...view(), reviewRequests: { nodes: [], pageInfo }, reviewThreads: { nodes: [], pageInfo }, statusCheckRollup: { contexts: { nodes: [{ name: "gate", conclusion: "SUCCESS" }], pageInfo } } } };
      for (const match of query.matchAll(/(queue_i\d+):issue\(number:(\d+)\)/g)) repository[match[1]!] = { number: Number(match[2]), labels: { nodes: [], pageInfo } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }) };
    }
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: A, reviewThreads: { nodes: [], pageInfo } }, issue: { number: 1, labels: { nodes: [], pageInfo } } } } }) };
  };
  const tasks = new Tasks({ board, bus, roles: { claude: ["conductor"] }, cwd: dir, project: "fixture", repository: "owner/repo", routing: () => loadRouting(dir), notify: () => {},
    sdlc: { config: () => sdlcConfig({ mode: "off", required_checks: ["gate"], auto_merge: "on" }), gh: run } });
  const t = board.propose(USER, { title: "work", class: "implement" });
  board.update(t.id, USER, "accepted", { owner: USER, reviewer: USER, state: "in_progress" });
  board.update(t.id, USER, "done", { state: "in_review" });
  board.update(t.id, USER, "changes_requested", { state: "changes_requested" });
  board.update(t.id, USER, "accepted", { state: "in_progress" });
  board.update(t.id, USER, "done", { state: "in_review" });
  board.update(t.id, USER, "approved", { state: "approved" });
  tasks.recordLifecycle(USER, t.id, { repo: "owner/repo", pr: 1, stage: "merge", reviewedHead: A, localHead: A, localResult: "passed" });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board, id: t.id, calls };
}

test("the merge records the merged PR's review and CI figures once, from the PR at merge", async () => {
  const f = fixture("ok");
  const result = await f.tasks.guardedMerge(USER, f.id);
  expect(result.result).toMatchObject({ state: "merged" });
  const merge = f.board.get(f.id)!.sdlc!.merge!;
  // Runs 901 and 902 belong to this PR (902 was attempted three times: two reruns); run 903 is another PR's and is not counted. Review 12 appears twice and counts once.
  expect(merge.cost).toEqual({ mergedAt: Date.parse(MERGED_AT), ciRuns: 2, ciReruns: 2, reviews: 2 });
  expect(f.calls.filter(args => args.join(" ").includes("mergedAt"))).toHaveLength(1);
  expect(f.calls.filter(args => args[1]?.includes("/actions/workflows/check.yml/runs"))).toHaveLength(1);
  // The cost is read after the merge is observed, never before it: the PR is merged by the time the cost query is answered.
  const mergeAt = f.calls.findIndex(args => args[0] === "pr" && args[1] === "merge"), costAt = f.calls.findIndex(args => args.join(" ").includes("mergedAt"));
  expect(mergeAt).toBeGreaterThan(-1);
  expect(costAt).toBeGreaterThan(mergeAt);
  // A repeat invocation reads and writes nothing more.
  const reads = f.calls.length;
  await f.tasks.guardedMerge(USER, f.id);
  expect(f.calls.length).toBe(reads);
});

test("an incomplete PR cost read records unknown, never a zero; a failed read records no cost at all", async () => {
  const partial = fixture("partial");
  await partial.tasks.guardedMerge(USER, partial.id);
  expect(partial.board.get(partial.id)!.sdlc!.merge!.cost).toEqual({ mergedAt: Date.parse(MERGED_AT), ciRuns: null, ciReruns: null, reviews: 2 });
  const failed = fixture("fail");
  expect((await failed.tasks.guardedMerge(USER, failed.id)).result).toMatchObject({ state: "merged" }); // the merge result never depends on the cost read
  expect(failed.board.get(failed.id)!.sdlc!.merge).toBeDefined();
  expect(failed.board.get(failed.id)!.sdlc!.merge!.cost).toBeUndefined();
  const open = fixture("open");
  await open.tasks.guardedMerge(USER, open.id);
  expect(open.board.get(open.id)!.sdlc!.merge!.cost).toBeUndefined(); // a PR GitHub still reports open has no merge-time figures
});

test("the metrics report reads the recorded merge cost: review rounds at merge, CI runs, reruns and acceptance to merge", async () => {
  const f = fixture("ok");
  await f.tasks.guardedMerge(USER, f.id);
  const report = f.tasks.sdlcMetrics(USER);
  expect(report.merged).toEqual({ read: 1, unknown: 0 });
  expect(report.metrics.same_head_ci_reruns).toMatchObject({ n: 1, mean: 2 });
  expect(report.metrics.ci_runs_at_merge).toMatchObject({ n: 1, mean: 2 });
  expect(report.metrics.github_reviews_at_merge).toMatchObject({ n: 1, mean: 2 });
  expect(report.metrics.review_rounds_at_merge).toMatchObject({ n: 1 });
  expect(report.metrics.acceptance_to_merge_ms.n).toBe(1);
  expect(report.metrics.review_rounds_at_merge.mean).toBe(2); // two review handoffs (dones) before the merge
  const failed = fixture("fail");
  await failed.tasks.guardedMerge(USER, failed.id);
  const unknown = failed.tasks.sdlcMetrics(USER);
  expect(unknown.merged).toEqual({ read: 0, unknown: 1 });
  expect(unknown.metrics.ci_runs_at_merge).toMatchObject({ n: 0, unknown: 1, mean: null });
  expect(unknown.metrics.same_head_ci_reruns).toMatchObject({ n: 0, unknown: 1 });
});

test("pure helpers: CI attempts share a run id, bounds and bad shapes are unknown, and a stored record is re-validated", () => {
  expect(ciRunCounts([{ id: 1, attempt: 1 }, { id: 1, attempt: 2 }, { id: 2, attempt: 1 }])).toEqual({ runs: 2, reruns: 1 });
  expect(ciRunCounts([])).toEqual({ runs: 0, reruns: 0 });
  expect(ciRunCounts(undefined)).toBeNull();
  expect(ciRunCounts([{ id: 0, attempt: 1 }])).toBeNull();
  expect(ciRunCounts([{ id: 1, attempt: 0 }])).toBeNull();
  expect(ciRunCounts(Array.from({ length: 101 }, (_, i) => ({ id: i + 1, attempt: 1 })))).toBeNull();
  expect(mergeCostFrom(undefined)).toBeUndefined();
  expect(mergeCostFrom({ repo: "o/r", pr: 1, state: "OPEN", complete: false })).toBeUndefined();
  expect(mergeCostFrom({ repo: "o/r", pr: 1, state: "MERGED", complete: false, mergedAt: 5, ciRuns: [{ id: 1, attempt: 2 }], reviews: 1 })).toEqual({ mergedAt: 5, ciRuns: null, ciReruns: null, reviews: 1 });
  expect(cleanMergeCost({ mergedAt: 5, ciRuns: -1, ciReruns: 1.5, reviews: "3", extra: "text" })).toEqual({ mergedAt: 5, ciRuns: null, ciReruns: null, reviews: null });
  expect(cleanMergeCost("x")).toBeUndefined();
  const task: MetricTask = { id: 1, history: [{ at: 1, event: "accepted" }, { at: 2, event: "done" }, { at: 3, event: "changes_requested" }, { at: 4, event: "done" }, { at: 5, event: "approved" }, { at: 9, event: "done" }] };
  expect(taskSample(task, { mergedAt: 6, ciRuns: 3, ciReruns: 1, reviews: 2 })).toMatchObject({ review_rounds_at_merge: 2, ci_runs_at_merge: 3, same_head_ci_reruns: 1, github_reviews_at_merge: 2, acceptance_to_merge_ms: 5 });
  expect(taskSample(task)).toMatchObject({ review_rounds_at_merge: null, ci_runs_at_merge: null, github_reviews_at_merge: null, same_head_ci_reruns: null });
  expect(sdlcMetrics([task], { mergedAt: { 1: 6 }, ciRuns: { 1: null }, ciReruns: { 1: null } }).merged).toEqual({ read: 0, unknown: 1 });
});
