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
import { renderSdlcStatus } from "../src/cli/sdlc-output.ts";

const cleanups: (() => void)[] = [], HEAD = "a".repeat(40), MERGED = "b".repeat(40);
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function rig(mode: "ok" | "cost-unreadable" | "state-unreadable" = "ok") {
  const root = mkdtempSync(join(tmpdir(), "ahub-merge-readback-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  const config = sdlcConfig({ mode: "advise", required_checks: ["gate"], auto_merge: "off", security_scan: { sources: ["dependabot", "secret_scanning"] } });
  const mergedAt = Date.now() + 1_000;
  const world = { state: "MERGED", reads: 0 };
  const gh: SdlcGh = async args => {
    if (mode === "state-unreadable") return { code: 1, stdout: "" };
    if (args[0] === "pr") { world.reads++; return { code: 0, stdout: JSON.stringify({ headRefOid: HEAD, state: world.state, mergeCommit: { oid: MERGED }, reviewDecision: "APPROVED", reviewRequests: [], files: [], changedFiles: 0, statusCheckRollup: [] }) }; }
    if (args[1] !== "graphql") return mode === "cost-unreadable" ? { code: 1, stdout: "" } : { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, run_attempt: 2, head_sha: HEAD, pull_requests: [7] }] }) };
    const query = args.find(x => x.startsWith("query=")) ?? "";
    if (query.includes("reviewThreads") && !query.includes("costCommits")) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: HEAD, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
    const cost = { number: 7, headRefOid: HEAD, state: "MERGED", mergedAt: new Date(mergedAt).toISOString(), reviews: { nodes: [{ databaseId: 3, commit: { oid: HEAD } }], pageInfo: { hasNextPage: false } }, costCommits: { nodes: [{ commit: { oid: HEAD } }], pageInfo: { hasNextPage: false } } };
    const pr = query.includes("costCommits") ? { ...cost, reviewDecision: "APPROVED", mergeCommit: { oid: MERGED }, reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } }, commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { contexts: { nodes: [{ name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }], pageInfo: { hasNextPage: false } } } } }] } } : { ...cost, commits: cost.costCommits };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: pr } } }) };
  };
  const tasks = new Tasks({ cwd: root, board, bus, roles: { claude: ["planner"] }, project: "fixture", repository: "owner/repo", routing: () => loadRouting(root), notify: () => {}, sdlc: { config: () => config, gh } });
  const task = board.propose("user", { title: "work", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress", refs: { commit: HEAD }, sdlc: { repo: "owner/repo", pr: 7, stage: "build" } });
  return { board, tasks, id: task.id, config, world };
}

test("#1555 adoption stores readback cost without guarded command claims", async () => {
  const r = rig(); await r.tasks.adoptMerge("user", r.id, 7);
  const task = r.board.get(r.id)!, observed = task.sdlc!.mergeReadback!;
  expect(observed).toMatchObject({ repo: "owner/repo", pr: 7, head: HEAD, state: "merged", cost: { ciRuns: 1, ciReruns: 1, reviews: 1 } });
  expect(observed).not.toHaveProperty("exit"); expect(observed).not.toHaveProperty("cleanup"); expect(observed).not.toHaveProperty("ownerNotice");
  expect(r.tasks.sdlcMetrics("user").metrics).toMatchObject({ acceptance_to_merge_ms: { n: 1 }, ci_runs_at_merge: { n: 1 }, same_head_ci_reruns: { n: 1 }, github_reviews_at_merge: { n: 1 } });
  expect(evidenceTask(task).merge?.ciRuns).toBe(1);
});

test("#1555 unreadable cost remains unknown and tool inputs cannot forge readback", async () => {
  const r = rig("cost-unreadable"); await r.tasks.adoptMerge("user", r.id, 7);
  const report = r.tasks.sdlcMetrics("user");
  for (const key of ["acceptance_to_merge_ms", "ci_runs_at_merge", "same_head_ci_reruns", "github_reviews_at_merge", "review_rounds_at_merge"] as const) expect(report.metrics[key].n).toBe(0);
  expect(() => sdlcReceipt({ stage: "build", mergeReadback: {} }, undefined, r.config)).toThrow("unsupported");
});

test("#1555 status reports unreadable security sources as unknown", () => {
  const r = rig(); r.board.recordSecurityScan({ repo: "owner/repo", sources: "dependabot,secret_scanning", counts: { dependabot: null, secret_scanning: 0 }, total: null });
  expect(r.tasks.sdlcMetrics("user").securityScan).toEqual({ dependabot: null, secret_scanning: 0 });
  const lines = renderSdlcStatus({ mode: "advise", rows: [], securityScan: r.tasks.securityScanCounts() }, 120).flat().map(span => span.text).join(" ");
  expect(lines).toContain("dependabot: unknown"); expect(lines).toContain("secret_scanning: 0");
});

test("#1555 approved external merge is recorded only after current successful readback", async () => {
  const r = rig();
  r.board.update(r.id, "codex", "done", { state: "in_review" });
  r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.captureExternalMerge(r.id);
  const task = r.board.get(r.id)!;
  expect(task.sdlc?.merge).toBeUndefined();
  expect(task.sdlc?.mergeReadback).toMatchObject({ state: "merged", head: HEAD, cost: { ciRuns: 1, ciReruns: 1, reviews: 1 } });
  expect(r.tasks.sdlcMetrics("user").metrics).toMatchObject({ acceptance_to_merge_ms: { n: 1 }, ci_runs_at_merge: { n: 1 }, same_head_ci_reruns: { n: 1 }, github_reviews_at_merge: { n: 1 }, review_rounds_at_merge: { n: 1 } });
});

test("#1555 an unreadable external merge state leaves no readback", async () => {
  const r = rig("state-unreadable");
  r.board.update(r.id, "codex", "done", { state: "in_review" });
  r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.captureExternalMerge(r.id);
  expect(r.board.get(r.id)?.sdlc?.mergeReadback).toBeUndefined();
});

test("#1555 readback is not carried across an artifact relink", () => {
  const config = sdlcConfig({ mode: "advise" });
  const previous = { stage: "build", repo: "owner/repo", pr: 7, head: HEAD, mergeReadback: { repo: "owner/repo", pr: 7, head: HEAD, at: 1, state: "merged" as const } };
  expect(sdlcReceipt({ pr: 8 }, previous, config).mergeReadback).toBeUndefined();
});

test("#1555 unreadable approved-merge cost does not invent timing or counts", async () => {
  const r = rig("cost-unreadable");
  r.board.update(r.id, "codex", "done", { state: "in_review" });
  r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.captureExternalMerge(r.id);
  expect(r.board.get(r.id)?.sdlc?.mergeReadback).toMatchObject({ state: "merged" });
  const metrics = r.tasks.sdlcMetrics("user").metrics;
  for (const key of ["acceptance_to_merge_ms", "ci_runs_at_merge", "same_head_ci_reruns", "github_reviews_at_merge", "review_rounds_at_merge"] as const) expect(metrics[key].n).toBe(0);
});

test("#1555 settlement retries an open PR and records it after merge", async () => {
  const r = rig(), start = Date.now(); r.world.state = "OPEN";
  r.board.update(r.id, "codex", "done", { state: "in_review" }); r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.settleMergeReadbacks(start + 1_000); expect(r.world.reads).toBe(1); expect(r.board.get(r.id)?.sdlc?.mergeReadback).toBeUndefined();
  r.world.state = "MERGED"; await r.tasks.settleMergeReadbacks(start + 5 * 60_000); expect(r.world.reads).toBe(1);
  await r.tasks.settleMergeReadbacks(start + 11 * 60_000); expect(r.world.reads).toBe(2); expect(r.board.get(r.id)?.sdlc?.mergeReadback?.state).toBe("merged");
});

test("#1555 settlement stops at closed or expired tasks and bounds each pass", async () => {
  const r = rig(), start = Date.now(); r.world.state = "CLOSED";
  r.board.update(r.id, "codex", "done", { state: "in_review" }); r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.settleMergeReadbacks(start + 1_000); await r.tasks.settleMergeReadbacks(start + 11 * 60_000); expect(r.world.reads).toBe(1);
  const make = (pii = false) => {
    const t = r.board.propose("user", { title: "next", class: "implement", ...(pii ? { signals: ["pii"] } : {}) });
    r.board.update(t.id, "user", "accepted", { owner: "codex", state: "in_progress", refs: { commit: HEAD }, sdlc: { repo: "owner/repo", pr: 7, stage: "build" } });
    r.board.update(t.id, "codex", "done", { state: "in_review" }); r.board.update(t.id, "user", "approved", { state: "approved" }); return t.id;
  };
  make(true); for (let i = 0; i < 4; i++) make(); r.world.state = "OPEN";
  const before = r.world.reads; await r.tasks.settleMergeReadbacks(start + 12 * 60_000); expect(r.world.reads - before).toBe(3);
  const next = r.world.reads; await r.tasks.settleMergeReadbacks(start + 25 * 60 * 60_000); expect(r.world.reads).toBe(next);
});

test("#1555 a private approved task is never sent to merge readback", async () => {
  const r = rig(), start = Date.now();
  r.board.update(r.id, "user", "private", { signals: ["pii"] });
  r.board.update(r.id, "codex", "done", { state: "in_review" });
  r.board.update(r.id, "user", "approved", { state: "approved" });
  await r.tasks.settleMergeReadbacks(start + 1_000);
  expect(r.world.reads).toBe(0); expect(r.board.get(r.id)?.sdlc?.mergeReadback).toBeUndefined();
});

test("#1555 task tools cannot supply host merge readback", () => {
  const r = rig(), before = r.board.get(r.id);
  expect(() => r.tasks.recordLifecycle("codex", r.id, { mergeReadback: { repo: "owner/repo", pr: 7, head: HEAD, at: 1, state: "merged" } })).toThrow("unsupported");
  expect(r.board.get(r.id)).toEqual(before);
});
