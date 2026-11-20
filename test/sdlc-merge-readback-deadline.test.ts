import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig, sdlcReceipt, type SdlcGh } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { evidenceTask } from "../src/hub/research-record.ts";
import { renderSdlcMetrics, renderSdlcStatus } from "../src/cli/sdlc-output.ts";

const cleanups: (() => void)[] = [], HEAD = "a".repeat(40), MERGED = "b".repeat(40);
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function rig(mode: "ok" | "cost-unreadable" | "state-unreadable" = "ok") {
  const root = mkdtempSync(join(tmpdir(), "ahub-merge-readback-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  const config = sdlcConfig({ mode: "advise", required_checks: ["gate"], auto_merge: "off", security_scan: { sources: ["dependabot", "secret_scanning"] } });
  const mergedAt = Date.now() + 1_000;
  const world = { slow: true, timeout: 0, state: "MERGED", reads: 0, costHead: HEAD, seen: [] as number[] };
  const gh: SdlcGh = async (args, timeout) => {
    if (mode === "state-unreadable") return { code: 1, stdout: "" };
    if (args[0] === "pr") { world.reads++; world.seen.push(Number(args[2])); return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD, state: world.state, mergeCommit: { oid: MERGED }, reviewDecision: "APPROVED", reviewRequests: [], files: [], changedFiles: 0, statusCheckRollup: [] }) }; }
    if (args[1] !== "graphql" && world.slow) { world.timeout = timeout ?? 0; await Bun.sleep(20); return { code: 1, stdout: "" }; }
    if (args[1] !== "graphql") return mode === "cost-unreadable" ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, run_attempt: 2, head_sha: HEAD, pull_requests: [7] }] }) };
    const query = args.find(x => x.startsWith("query=")) ?? "";
    if (query.includes("reviewThreads") && !query.includes("costCommits")) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
    const cost = { number: 7, headRefOid: world.costHead, state: "MERGED", mergedAt: new Date(mergedAt).toISOString(), reviews: { nodes: [{ databaseId: 3, commit: { oid: HEAD } }], pageInfo: { hasNextPage: false } }, costCommits: { nodes: [{ commit: { oid: HEAD } }], pageInfo: { hasNextPage: false } } };
    const pr = query.includes("costCommits") ? { ...cost, reviewDecision: "APPROVED", mergeCommit: { oid: MERGED }, reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { nodes: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], pageInfo: { hasNextPage: false } } } } }] } } : { ...cost, commits: cost.costCommits };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) };
  };
  const tasks = new Tasks({ cwd: root, board, bus, roles: { claude: ["planner"] }, project: "fixture", repository: "owner/repo", routing: () => loadRouting(root), notify: () => {}, sdlc: { config: () => config, gh } });
  const task = board.propose("user", { title: "work", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress", refs: { commit: HEAD }, sdlc: { repo: "owner/repo", pr: 7, stage: "build" } });
  return { board, tasks, id: task.id, config, world };
}

test("adoption records a merge after a bounded slow cost read and the periodic pass fills it", async () => {
  const r = rig();
  const result = await r.tasks.adoptMerge("user", r.id, 7);
  expect(result.state).toBe("approved");
  expect(r.world.timeout).toBeGreaterThan(0);
  expect(r.world.timeout).toBeLessThanOrEqual(8_000);
  expect(r.board.get(r.id)?.sdlc?.mergeReadback).toMatchObject({ state: "merged" });
  expect(r.board.get(r.id)?.sdlc?.mergeReadback?.cost).toBeUndefined();
  r.world.slow = false;
  await r.tasks.settleMergeReadbacks(Date.now() + 1_000);
  expect(r.board.get(r.id)?.sdlc?.mergeReadback?.cost).toMatchObject({ ciRuns: 1, ciReruns: 1 });
});

const A = "a".repeat(40), BASE = "c".repeat(40), MERGED_AT = new Date(Date.now() + 3_600_000).toISOString();
const USER = "user";
type CostReply = "ok" | "partial" | "fail" | "open";
/** A PR that merges when `gh pr merge` runs, with a fake cost query (the GraphQL read `readPrCostHistory` makes) and a fake workflow-run list. */
function mergeRig(cost: CostReply) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-merge-readback-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  let state: "OPEN" | "MERGED" = "OPEN", slow = true, seenTimeout = 0; const calls: string[][] = [];
  const view = () => ({ headRefOid: A, headRefName: "feat/x", isDraft: false, baseRefName: "main", baseRefOid: BASE, state, changedFiles: 1, statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }],
    reviewDecision: null, reviewRequests: [], files: [{ path: "src/a.ts", changeType: "MODIFIED" }], ...(state === "MERGED" ? { mergeCommit: { oid: MERGED } } : {}) });
  const pageInfo = { hasNextPage: false };
  const run: SdlcGh = async (args, timeout) => {
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
      if (slow) { seenTimeout = timeout ?? 0; await Bun.sleep(20); return { code: 1, stdout: "" }; }
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
  return { tasks, board, id: t.id, calls, timeout: () => seenTimeout, resume: () => { slow = false; } };
}

test("guarded merge records after a bounded slow cost read and the periodic pass fills it", async () => {
  const r = mergeRig("ok");
  const result = await r.tasks.guardedMerge(USER, r.id);
  expect(result.result?.state).toBe("merged");
  expect(r.timeout()).toBeGreaterThan(0);
  expect(r.timeout()).toBeLessThanOrEqual(8_000);
  expect(r.board.get(r.id)?.sdlc?.merge?.state).toBe("merged");
  expect(r.board.get(r.id)?.sdlc?.merge?.cost?.ciRuns).toBeNull();
  r.resume();
  await r.tasks.settleMergeReadbacks(Date.now() + 1_000);
  expect(r.board.get(r.id)?.sdlc?.merge?.cost).toMatchObject({ ciRuns: 2, ciReruns: 2 });
});
