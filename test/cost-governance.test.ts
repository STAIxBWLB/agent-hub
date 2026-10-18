import { expect, test } from "bun:test";
import { costMetrics, costBandProposals, cleanCostPlan } from "../src/hub/cost-governance.ts";

const head = "a".repeat(40);
test("cost scopes are typed and bounded, and legacy plans stay unknown (#481 S10)", () => {
  expect(cleanCostPlan({})).toEqual({});
  expect(cleanCostPlan({ review: { scope: "delta", reviewers: 2 }, ci: "reuse" })).toEqual({ review: { scope: "delta", reviewers: 2 }, ci: "reuse" });
  for (const value of [{ review: { scope: "none", reviewers: 1 } }, { review: { scope: "full", reviewers: 0 } }, { review: { scope: "full", reviewers: 9 } }, { ci: "skip" }, { review: { scope: "full", reviewers: 1, prompt: "untrusted" } }]) {
    expect(() => cleanCostPlan(value)).toThrow("cost scope");
  }
});

test("merged-PR costs deduplicate CI attempts, count redo scopes and measure review intervals (#481 S10)", () => {
  const tasks = [{ repo: "Org/Repo", pr: 10, history: [
    { event: "done", at: 100, reviewCost: { review: { scope: "full" as const, reviewers: 1 }, ci: "full" as const, head } },
    { event: "changes_requested", at: 160 },
    { event: "done", at: 200, reviewCost: { review: { scope: "delta" as const, reviewers: 1 }, ci: "reuse" as const, head } },
    { event: "approved", at: 240 },
  ] }];
  const prs = [{ repo: "org/repo", pr: 10, state: "MERGED" as const, mergedAt: 300, complete: true, ciRuns: [
    { id: 1, attempt: 1 }, { id: 1, attempt: 2 }, { id: 2, attempt: 1 },
  ], reviews: 2 }];
  const result = costMetrics(tasks, prs);
  expect(result.rows).toEqual([{ repo: "org/repo", pr: 10, reviewRounds: 2, ciRuns: 2, ciReruns: 1, fullReReviews: 0, deltaReviews: 1, reviewMs: 100, unknownReviewScopes: 0, githubReviews: 2, complete: true }]);
  expect(result.truncated).toBe(false);
  expect(costBandProposals(result, { reviewRounds: 1 })).toEqual([{ repo: "org/repo", pr: 10, metric: "reviewRounds", observed: 2, upper: 1 }]);
  expect(costBandProposals(result, { reviewRounds: 2 })).toEqual([]);
});

test("cost reports withhold private counterparts and preserve unknown or incomplete evidence (#481 S10)", () => {
  const result = costMetrics([
    { repo: "o/r", pr: 1, private: true, history: [] },
    { repo: "o/r", pr: 2, history: [{ event: "done", at: 10 }, { event: "approved", at: 20 }] },
  ], [
    { repo: "o/r", pr: 1, state: "MERGED", mergedAt: 30, complete: true, ciRuns: [], reviews: 0 },
    { repo: "o/r", pr: 2, state: "MERGED", mergedAt: 30, complete: false },
    { repo: "o/r", pr: 3, state: "OPEN", complete: true, ciRuns: [], reviews: 0 },
  ]);
  expect(result.rows.map(row => row.pr)).toEqual([2]);
  expect(result.rows[0]).toMatchObject({ ciRuns: null, ciReruns: null, reviewRounds: 1, reviewMs: 10, unknownReviewScopes: 1, complete: false });
  expect(costBandProposals(result, { reviewRounds: 0 })).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('"pr":1');
});

import { readReviewReadiness } from "../src/hub/sdlc.ts";
const readinessReply = (state = "SUCCESS", answered = true) => ({ data: { repository: { pullRequest: {
  headRefOid: head, state: "OPEN", commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) },
    statusCheckRollup: { contexts: { nodes: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, status: "COMPLETED", conclusion: state })), pageInfo: { hasNextPage: false } } },
  } }] },
  reviewThreads: { nodes: [{ comments: { nodes: [
    { author: { __typename: "Bot" }, createdAt: "2026-10-18T01:00:00Z" },
    ...(answered ? [{ author: { __typename: "User" }, createdAt: "2026-10-18T02:00:00Z" }] : []),
  ], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } },
} } } });
test("review admission is head-bound, checks full CI and bot replies without fetching bodies (#481 S10)", async () => {
  const calls: string[][] = [];
  const read = async (reply: unknown) => readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async args => {
    calls.push(args); return { code: 0, stdout: JSON.stringify(reply) };
  });
  expect(await read(readinessReply())).toMatchObject({ head, ready: true, blockers: [] });
  expect((await read(readinessReply("IN_PROGRESS"))).blockers).toContain("exact-head full CI is not green");
  expect((await read(readinessReply("SUCCESS", false))).blockers).toContain("bot review threads unanswered");
  const moved = readinessReply(); moved.data.repository.pullRequest.headRefOid = "c".repeat(40);
  expect((await read(moved)).blockers).toContain("review head changed");
  expect(calls.every(args => !args.join(" ").match(/\bbody\b/))).toBe(true);
});

import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function scopeRig(mode: "off" | "advise" | "enforce", gh?: SdlcGh) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-cost-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const notices: string[] = [];
  const roles: Record<string, string[]> = { claude: ["planner"], codex: ["implementer"] }, privacy = { active: false };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles, privateTurn: () => privacy.active, routing: () => loadRouting(cwd), notify: text => notices.push(text), repository: "o/r", sdlc: { config: () => sdlcConfig({ mode }), ...(gh ? { gh } : {}) } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, board, bus, roles, privacy, notices };
}
test("task plan scopes survive normalization and bind the planner receipt (#481 S10)", async () => {
  const r = scopeRig("enforce"), scope = { review: { scope: "delta" as const, reviewers: 2 }, ci: "reuse" as const };
  const task = await r.tasks.propose("user", { title: "bounded scope", class: "summarize", backlog: true, plan: { paths: ["a.ts"], ...scope } });
  expect(task.plan).toMatchObject(scope);
  const recorded = await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "cost planned" });
  expect(recorded.sdlc?.planReview).toMatchObject({ scope });
  r.board.update(task.id, "user", "plan changed", { plan: { ...recorded.plan, ci: "full" } });
  expect(await r.tasks.planReviewGap(r.board.get(task.id)!)).toContain("cost scope");
});
test("legacy scopes stay unspecified, while enforce requires explicit scope for a new receipt (#481 S10)", async () => {
  const r = scopeRig("enforce"), task = r.board.propose("user", { title: "legacy scope", class: "summarize", backlog: true });
  r.board.update(task.id, "user", "plan reviewed", { sdlc: { stage: "plan", planReview: { planner: "claude", planningRevision: 0, recordedAt: 1 } } });
  expect(await r.tasks.planReviewGap(r.board.get(task.id)!)).toBeUndefined();
  const before = r.board.get(task.id);
  await expect(r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "new receipt" })).rejects.toThrow("cost scope");
  expect(r.board.get(task.id)).toEqual(before);
  const scope = { review: { scope: "full", reviewers: 1 }, ci: "full" };
  const saved = await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "explicit scope", ...scope });
  expect(saved.plan).toMatchObject(scope);
  expect(saved.sdlc?.planReview).toMatchObject({ scope });
});
test("advise records an unspecified scope as unknown and reports the gap (#481 S10)", async () => {
  const r = scopeRig("advise"), task = r.board.propose("user", { title: "legacy advice", class: "summarize", backlog: true });
  const saved = await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "review legacy" });
  expect(saved.sdlc?.planReview).not.toHaveProperty("scope");
  expect(r.notices.join("\n")).toContain("cost scope unspecified");
});

import type { SdlcGh } from "../src/hub/sdlc.ts";
function admissionRig(mode: "off" | "advise" | "enforce", ready = true, answered = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-admission-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  let reads = 0;
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], director: ["conductor"] }, hooks: { onRead?: (args: string[]) => void; reply?: unknown } = {};
  const notices: string[] = [];
  const gh: SdlcGh = async args => {
    reads++; hooks.onRead?.(args);
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify(hooks.reply ?? readinessReply(ready ? "SUCCESS" : "PENDING", answered)) };
  };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: text => notices.push(text), sdlc: { config: () => sdlcConfig({ mode }), gh } });
  const task = board.propose("user", { title: "finished implementation", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress", refs: { commit: head }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, board, bus, task, roles, hooks, notices, reads: () => reads };
}
for (const condition of ["CI", "bot reply"] as const) test(`enforce refuses premature review before a done write: ${condition} (#481 S10)`, async () => {
  const r = admissionRig("enforce", condition !== "CI", condition !== "bot reply"), before = r.board.get(r.task.id);
  await expect(r.tasks.done("codex", r.task.id, "ready")).rejects.toThrow("premature review");
  expect(r.board.get(r.task.id)).toEqual(before);
});
test("advise reports premature review while off does no admission read (#481 S10)", async () => {
  const r = admissionRig("advise", false);
  expect((await r.tasks.done("codex", r.task.id, "ready")).state).toBe("in_review");
  expect(r.notices.join("\n")).toContain("premature review");
  const off = admissionRig("off", false);
  expect((await off.tasks.done("codex", off.task.id, "ready")).state).toBe("in_review");
  expect(off.reads()).toBe(0);
});

test("review admission honours a successful full gate of the identical tree, never skipped jobs alone (#481 S10)", async () => {
  const response = readinessReply("SKIPPED");
  const run: SdlcGh = async args => {
    if (args.includes("graphql")) return { code: 0, stdout: JSON.stringify(response) };
    if (args[1]?.includes("/runs?")) return { code: 0, stdout: JSON.stringify({ total_count: 1, workflow_runs: [{ id: 7, event: "pull_request", conclusion: "success", head_sha: "d".repeat(40) }] }) };
    if (args[1]?.includes("git/commits")) return { code: 0, stdout: JSON.stringify({ tree: { sha: "b".repeat(40) } }) };
    return { code: 0, stdout: JSON.stringify({ total_count: 3, jobs: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: "success" })) }) };
  };
  expect(await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, run)).toMatchObject({ ready: true, reusedRun: 7 });
  expect((await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async args => args.includes("graphql") ? run(args) : { code: 1, stdout: "" })).ready).toBe(false);
});

import { readPrCostHistory } from "../src/hub/sdlc.ts";
const costPrReply = (pr: number) => ({ data: { repository: { pullRequest: { number: pr, state: "MERGED", mergedAt: "2026-10-18T02:00:00Z", headRefOid: head,
  commits: { nodes: [{ commit: { oid: head } }], pageInfo: { hasNextPage: false } },
  reviews: { nodes: [{ databaseId: 1, commit: { oid: head } }], pageInfo: { hasNextPage: false } },
} } } });
test("cost history uses metadata and preserves incomplete CI coverage (#481 S10)", async () => {
  const calls: string[][] = [];
  const read: SdlcGh = async args => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(args.includes("graphql") ? costPrReply(10) : { total_count: 2, workflow_runs: [{ id: 1, run_attempt: 2, head_sha: head, pull_requests: [] }] }) };
  };
  expect(await readPrCostHistory("o/r", 10, read)).toMatchObject({ state: "MERGED", complete: false, ciRuns: [{ id: 1, attempt: 2 }], reviews: 1 });
  expect(calls.every(args => !args.join(" ").match(/\bbody\b/))).toBe(true);
});
test("planner cost report is read-only and rechecks private counterparts before external reads (#481 S10)", async () => {
  const requested: number[] = [];
  const r = scopeRig("advise", async args => {
    if (args.includes("graphql")) {
      const pr = Number(args.find(arg => arg.startsWith("number="))?.slice(7)); requested.push(pr);
      r.board.update(secret.id, "user", "screened", { signals: ["pii"] });
      return { code: 0, stdout: JSON.stringify(costPrReply(pr)) };
    }
    return { code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) };
  });
  const first = r.board.propose("user", { title: "public text not copied", class: "summarize" });
  const secret = r.board.propose("user", { title: "PRIVATE-SENTINEL", class: "summarize" });
  for (const [task, pr] of [[first, 1], [secret, 2]] as const) r.board.update(task.id, "user", "lifecycle", { sdlc: { stage: "merge", repo: "o/r", pr } });
  await expect(r.tasks.costReport("codex", "o/r")).rejects.toThrow("planner");
  const before = r.board.get(first.id);
  const report = await r.tasks.costReport("claude", "o/r");
  expect(requested).toEqual([1]);
  expect(report.privateTasks).toBe("withheld");
  expect(JSON.stringify(report)).not.toContain("PRIVATE-SENTINEL");
  expect(JSON.stringify(report)).not.toContain('"pr":2');
  expect(r.board.get(first.id)).toEqual(before);
});

import { BasePeer } from "../src/hub/peers.ts";
class ReadyReviewer extends BasePeer { received: import("../src/hub/envelope.ts").Envelope[] = []; async start() { this.setState("idle"); } async stop() {} async deliver(envs: import("../src/hub/envelope.ts").Envelope[]) { this.received.push(...envs); } }
test("admitted review publishes once and a premature reviewer resend changes nothing (#481 S10)", async () => {
  const r = admissionRig("enforce");
  const peer = new ReadyReviewer("claude"); r.bus.add(peer); await peer.start();
  r.board.update(r.task.id, "user", "reviewer changed", { reviewer: "claude" });
  await r.tasks.done("codex", r.task.id, "ready");
  expect(peer.received.filter(env => env.kind === "review")).toHaveLength(1);
  const pending = admissionRig("enforce", false);
  const other = new ReadyReviewer("claude"); pending.bus.add(other); await other.start();
  pending.board.update(pending.task.id, "codex", "done", { state: "in_review" });
  const before = pending.board.get(pending.task.id);
  await expect(pending.tasks.assignTo(pending.task.id, "claude", "user", true, "reviewer")).rejects.toThrow("premature review");
  expect(pending.board.get(pending.task.id)).toEqual(before);
  expect(pending.bus.pendingEnvelopes("claude").filter(env => env.kind === "review")).toHaveLength(0);
});

test("accept retains reviewed scope for path-only changes and refuses an explicit scope replacement (#481 S10)", async () => {
  const edited = "2026-10-18T01:00:00Z";
  const r = scopeRig("enforce", async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 1, state: "OPEN", createdAt: edited, lastEditedAt: edited, updatedAt: edited } } } }) }));
  const task = r.board.propose("user", { title: "reviewed budget", class: "implement" });
  r.board.update(task.id, "user", "assigned", { owner: "codex", sdlc: { stage: "build", repo: "o/r", issue: 1 } });
  r.tasks.acceptSpec("user", task.id, { issue: 1, edit: { lastEditedAt: edited, updatedAt: edited } });
  const scope = { review: { scope: "full", reviewers: 1 }, ci: "full" };
  await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "budget checked", ...scope });
  expect((await r.tasks.acceptReviewed("codex", task.id, { paths: ["a.ts"] })).plan).toMatchObject(scope);
  const before = r.board.get(task.id);
  await expect(r.tasks.acceptReviewed("codex", task.id, { paths: ["b.ts"], review: { scope: "delta", reviewers: 1 }, ci: "reuse" })).rejects.toThrow("cost scope");
  expect(r.board.get(task.id)).toEqual(before);
});

for (const revoked of ["private", "planner", "private turn"] as const) test(`cost report rechecks ${revoked} between its metadata calls (#481 S10)`, async () => {
  let calls = 0;
  const r = scopeRig("advise", async args => {
    calls++;
    if (args.includes("graphql")) {
      if (revoked === "private") r.board.update(task.id, "user", "screened", { signals: ["pii"] });
      if (revoked === "planner") r.roles.claude = [];
      if (revoked === "private turn") r.privacy.active = true;
      return { code: 0, stdout: JSON.stringify(costPrReply(1)) };
    }
    return { code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) };
  });
  const task = r.board.propose("user", { title: "private during read", class: "summarize" });
  r.board.update(task.id, "user", "lifecycle", { sdlc: { stage: "merge", repo: "o/r", pr: 1 } });
  if (revoked === "private") expect((await r.tasks.costReport("claude", "o/r")).rows).toEqual([]);
  else await expect(r.tasks.costReport("claude", "o/r")).rejects.toThrow();
  expect(calls).toBe(1);
});

test("a relink during cost readback never emits the old PR as a complete zero-cost row (#481 S10)", async () => {
  const r = scopeRig("advise", async args => {
    if (args.includes("graphql")) { r.board.update(task.id, "user", "lifecycle", { sdlc: { stage: "merge", repo: "o/r", pr: 2 } }); return { code: 0, stdout: JSON.stringify(costPrReply(1)) }; }
    return { code: 0, stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) };
  });
  const task = r.board.propose("user", { title: "relinked", class: "summarize" });
  r.board.update(task.id, "user", "lifecycle", { sdlc: { stage: "merge", repo: "o/r", pr: 1 } });
  const report = await r.tasks.costReport("claude", "o/r");
  expect(report.rows).toEqual([]);
  expect(report.truncated).toBe(true);
});

for (const revoked of ["conductor", "roster"] as const) test(`reviewer assignment rechecks ${revoked} after admission awaits (#481 S10)`, async () => {
  const r = admissionRig("enforce"), peer = new ReadyReviewer("claude"); r.bus.add(peer); await peer.start();
  r.board.update(r.task.id, "codex", "done", { state: "in_review" });
  const before = r.board.get(r.task.id);
  r.hooks.onRead = () => { if (revoked === "conductor") r.roles.director = []; else r.bus.isRostered = name => name !== "claude"; };
  await expect(r.tasks.assignTo(r.task.id, "claude", "director", true, "reviewer")).rejects.toThrow();
  expect(r.board.get(r.task.id)).toEqual(before);
});

test("concurrent done without an SDLC dependency still writes one review request (#481 S10)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-cost-off-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", routing: () => loadRouting(cwd), notify: () => {} });
  const task = board.propose("user", { title: "legacy off", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress" });
  const results = await Promise.allSettled([tasks.done("codex", task.id, "one"), tasks.done("codex", task.id, "two")]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(board.get(task.id)?.history.filter(entry => entry.event === "done")).toHaveLength(1);
});

test("a private transition during review metadata stops later reuse-proof reads (#481 S10)", async () => {
  const r = admissionRig("enforce");
  r.hooks.onRead = args => {
    if (args.join(" ").includes("commits(last:1)")) {
      r.board.update(r.task.id, "user", "screened", { signals: ["pii"] });
      r.hooks.reply = readinessReply("SKIPPED");
    }
  };
  await expect(r.tasks.done("codex", r.task.id, "ready")).rejects.toThrow("changed during review admission");
  expect(r.reads()).toBe(3); // lifecycle view + thread snapshot + review admission; no Actions proof read
  expect(r.board.get(r.task.id)?.history.filter(entry => entry.event === "done")).toHaveLength(0);
});
