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

test("a none-scope handoff still counts an observed review and its elapsed time (#481 S10)", () => {
  const report = costMetrics([{ repo: "o/r", pr: 1, history: [
    { event: "done", at: 100, reviewCost: { review: { scope: "none", reviewers: 0 }, ci: "full", head } },
    { event: "approved", at: 160 },
  ] }], [{ repo: "o/r", pr: 1, state: "MERGED", mergedAt: 200, complete: true, ciRuns: [], reviews: 1 }]);
  expect(report.rows[0]).toMatchObject({ reviewRounds: 1, reviewMs: 60, complete: true });
});

import { readReviewReadiness } from "../src/hub/sdlc.ts";
const readinessReply = (state = "SUCCESS", answered = true) => ({ data: { repository: { pullRequest: {
  headRefOid: head, state: "OPEN", commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) },
    statusCheckRollup: { contexts: { nodes: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, status: "COMPLETED", conclusion: state })), pageInfo: { hasNextPage: false } } },
  } }] },
  reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [
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
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { loadRouting } from "../src/hub/routing.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function scopeRig(mode: "off" | "advise" | "enforce", gh?: SdlcGh, checks: Pick<TasksDeps, "check" | "runCheck"> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-cost-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const notices: string[] = [];
  const roles: Record<string, string[]> = { claude: ["planner"], codex: ["implementer"] }, privacy = { active: false }, policy = { mode };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles, privateTurn: () => privacy.active, routing: () => loadRouting(cwd), notify: text => notices.push(text), repository: "o/r", ...checks, sdlc: { config: () => sdlcConfig({ mode: policy.mode }), ...(gh ? { gh } : {}) } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, board, bus, roles, privacy, notices, policy };
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
test("an owner cannot add cost scope to a legacy enforce receipt at acceptance (#481 S10)", async () => {
  const r = scopeRig("enforce"), task = r.board.propose("user", { title: "legacy acceptance", class: "summarize" });
  r.board.update(task.id, "user", "assigned", { owner: "codex", sdlc: { stage: "plan", planReview: { planner: "claude", planningRevision: 0, recordedAt: 1 } } });
  const before = r.board.get(task.id);
  await expect(r.tasks.acceptReviewed("codex", task.id, { paths: ["a.ts"], review: { scope: "full", reviewers: 1 }, ci: "full" })).rejects.toThrow("cost scope");
  expect(r.board.get(task.id)).toEqual(before);
  const accepted = await r.tasks.acceptReviewed("codex", task.id, { paths: ["a.ts"] });
  expect(accepted.plan).not.toHaveProperty("review");
  expect(accepted.sdlc?.planReview).not.toHaveProperty("scope");
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
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], director: ["conductor"] }, hooks: { onRead?: (args: string[]) => void; reply?: unknown; prReply?: unknown; privateTurn?: boolean } = {};
  const notices: string[] = [];
  const gh: SdlcGh = async args => {
    reads++; hooks.onRead?.(args);
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify(hooks.prReply ?? { headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify(hooks.reply ?? readinessReply(ready ? "SUCCESS" : "PENDING", answered)) };
  };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), privateTurn: () => hooks.privateTurn === true, notify: text => notices.push(text), sdlc: { config: () => sdlcConfig({ mode }), gh } });
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

test("advise lets a private turn finish its own PII task without reading remote metadata (#481 S10)", async () => {
  const r = admissionRig("advise"); r.roles.local = ["implementer"]; r.hooks.privateTurn = true;
  r.board.update(r.task.id, "user", "assigned", { owner: "local", signals: ["pii"] });
  const done = await r.tasks.done("local", r.task.id, "PRIVATE_RESULT_CANARY");
  expect(done.state).toBe("in_review");
  expect(r.reads()).toBe(0);
  expect(r.notices.join("\n")).toContain("private review readiness unavailable");
  expect(r.notices.join("\n")).not.toContain(r.task.title);
  expect(r.notices.join("\n")).not.toContain("PRIVATE_RESULT_CANARY");
  const ordinary = admissionRig("advise"); ordinary.hooks.privateTurn = true;
  await expect(ordinary.tasks.done("codex", ordinary.task.id, "ordinary result")).rejects.toThrow("task or authority changed during review admission");
  expect(ordinary.board.get(ordinary.task.id)?.state).toBe("in_progress");
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

test("review readiness never treats successful reuse reporting jobs as a fresh full proof (#481 S10)", async () => {
  const response = readinessReply("SKIPPED");
  const run: SdlcGh = async args => {
    if (args.includes("graphql")) return { code: 0, stdout: JSON.stringify(response) };
    if (args[1]?.includes("/runs?")) return { code: 0, stdout: JSON.stringify({ workflow_runs: [{ id: 7, event: "pull_request", conclusion: "success", head_sha: "d".repeat(40) }] }) };
    if (args[1]?.includes("git/commits")) return { code: 0, stdout: JSON.stringify({ tree: { sha: "b".repeat(40) } }) };
    return { code: 0, stdout: JSON.stringify({ total_count: 3, jobs: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: "success", reused: true })) }) };
  };
  expect((await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, run)).ready).toBe(false);
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

import { profileTaskTools, PLANNER_REVIEW_TOOLS } from "../src/hub/hub-tools.ts";
import { PROFILE_NAMES } from "../src/hub/profiles.ts";
import { classifyPeerCommand, liveTestRefusal } from "../src/cli/identity.ts";
test("enabled managed plan schemas advertise cost scopes across profiles without widening plain off (#481 S10)", () => {
  for (const profile of PROFILE_NAMES) {
    const enabled = profileTaskTools(profile, undefined, true).find(tool => tool.name === "hub_task_propose")!;
    const schema = enabled.inputSchema.properties.plan as { properties: Record<string, unknown> };
    expect(schema.properties.review).toMatchObject({ type: "object", required: ["scope", "reviewers"] });
    expect(schema.properties.ci).toMatchObject({ enum: ["focused", "full", "reuse"] });
  }
  const off = profileTaskTools("dev").find(tool => tool.name === "hub_task_propose")!.inputSchema.properties.plan as { properties: Record<string, unknown> };
  expect(off.properties).not.toHaveProperty("review");
  expect(PLANNER_REVIEW_TOOLS.find(tool => tool.name === "hub_plan_review")!.inputSchema.properties.review).toBeDefined();
  expect(classifyPeerCommand("sdlc", ["plan-review", "1", "0", "scope", "--review", "full", "--reviewers", "1", "--ci", "full"])).toBe("console");
  expect(liveTestRefusal("sdlc", ["plan-review", "1", "0", "scope", "--review", "full", "--reviewers", "1", "--ci", "full"])).toBe(true);
});

import { mkdirSync, writeFileSync } from "node:fs";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
test("the real daemon exposes a read-only planner cost report and typed receipt scopes (#481 S10)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-cost-surface-")), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(join(cwd, ".agenthub")); writeFileSync(join(cwd, ".agenthub/sdlc.toml"), 'mode = "enforce"\n');
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  const clients: ControlClient[] = [];
  try {
    const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
    const person = await connect("console"), planner = await connect("tools", "claude"), other = await connect("tools", "codex");
    const request = (client: ControlClient, op: string, args: unknown) => client.request({ t: "task", op, args });
    expect(await request(other, "hub_sdlc_costs", { repo: "o/r" })).toMatchObject({ ok: false });
    const before = (await request(person, "hub_task_list", {})).text;
    const report = await request(planner, "hub_sdlc_costs", { repo: "o/r" });
    expect(report.ok).toBe(true); expect(JSON.parse(report.text)).toMatchObject({ rows: [], truncated: false });
    expect((await request(person, "hub_task_list", {})).text).toBe(before);
    const proposed = await request(person, "hub_task_propose", { title: "scoped task", class: "implement", backlog: true, plan: { review: { scope: "full", reviewers: 1 }, ci: "full" } });
    expect(proposed.ok).toBe(true);
    const task = JSON.parse((await request(person, "hub_task_list", {})).text)[0]!;
    const reviewed = await request(planner, "hub_plan_review", { id: task.id, revision: 0, reason: "scope checked" });
    expect(reviewed.ok).toBe(true);
    expect(JSON.parse(reviewed.text).sdlc.planReview.scope).toEqual({ review: { scope: "full", reviewers: 1 }, ci: "full" });
  } finally { for (const client of clients) client.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); }
});

test("review readiness honours explicit project check names instead of imposing the hub CI catalog (#481 S10)", async () => {
  const fixture = readinessReply();
  fixture.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes = [{ name: "project gate", status: "COMPLETED", conclusion: "SUCCESS" }];
  const result = await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(fixture) }), ["project gate"]);
  expect(result.ready).toBe(true);
});

test("a running check or unresolved bot follow-up cannot masquerade as review-ready (#481 S10)", async () => {
  const running = readinessReply();
  running.data.repository.pullRequest.commits.nodes[0]!.commit.statusCheckRollup.contexts.nodes[0]!.status = "IN_PROGRESS";
  expect((await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(running) }))).ready).toBe(false);
  const resolved = readinessReply("SUCCESS", false); resolved.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved = true;
  expect((await readReviewReadiness({ stage: "build", repo: "o/r", pr: 1 }, head, async () => ({ code: 0, stdout: JSON.stringify(resolved) }))).ready).toBe(true);
});

test("a privacy change during the reusable lifecycle snapshot stops its next external read (#481 S10)", async () => {
  const r = admissionRig("enforce");
  r.hooks.onRead = args => { if (args[0] === "pr") r.board.update(r.task.id, "user", "screened", { signals: ["pii"] }); };
  await expect(r.tasks.done("codex", r.task.id, "ready")).rejects.toThrow("changed during lifecycle readback");
  expect(r.reads()).toBe(1);
});

test("advise discards a clean lifecycle snapshot when the task relinks to another same-head PR (#481 S10)", async () => {
  const r = admissionRig("advise", true, false);
  r.hooks.prReply = { headRefOid: head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], files: [], changedFiles: 0, unresolvedThreads: 0,
    statusCheckRollup: ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].map(name => ({ name, conclusion: "SUCCESS" })) };
  let relinked = false;
  r.hooks.onRead = args => {
    if (!relinked && args[0] === "api") {
      relinked = true;
      const clean = readinessReply(); clean.data.repository.pullRequest.reviewThreads.nodes[0]!.isResolved = true;
      r.hooks.reply = clean;
      const task = r.board.get(r.task.id)!;
      r.board.update(task.id, "user", "relinked", { sdlc: { ...task.sdlc!, pr: 2 } });
    } else if (args[0] === "api") r.hooks.reply = readinessReply("SUCCESS", false);
  };
  const done = await r.tasks.done("codex", r.task.id, "ready");
  expect(done.state).toBe("in_review");
  expect(r.notices.join("\n")).toContain("bot review threads unanswered");
  expect(done.history.findLast(entry => entry.event === "done")?.reviewCost?.head).toBeUndefined();
  expect(r.reads()).toBeGreaterThan(2);
});


// #230 item4: isolate the admission readback, then exercise its delayed completion through done().
type CostRig = ReturnType<typeof scopeRig>;
const scopeTask = (r: CostRig) => {
  const task = r.board.propose("user", { title: "PRIVATE_TITLE_CANARY", class: "summarize" });
  return r.board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "user", state: "in_progress", refs: { commit: head },
    sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
};
const admitScope = (r: CostRig, task: ReturnType<typeof scopeTask>, actor = "codex") =>
  (r.tasks as unknown as { reviewRequestAdmission(snapshot: ReturnType<typeof scopeTask>, refs: undefined, preEffect: boolean, actor: string): Promise<import("../src/hub/sdlc.ts").ReviewReadiness | undefined> })
    .reviewRequestAdmission(task, undefined, true, actor);
const changedReadback = "review readiness unknown: task changed during readback";
for (const event of ["answer", "reviewer changed", "idle sweep", "memory reference started"]) test(`F4a advise discards ${event} drift and continues with one metadata read`, async () => {
  let calls = 0;
  const r = scopeRig("advise", async () => {
    calls++; r.board.update(task.id, "hub", event, event === "reviewer changed" ? { reviewer: "claude" } : {});
    return { code: 0, stdout: JSON.stringify(readinessReply()) };
  });
  const task = scopeTask(r);
  expect(await admitScope(r, task)).toEqual({ ready: false, blockers: [changedReadback] });
  expect(calls).toBe(1);
  expect(r.notices.join("\n")).toContain(changedReadback);
  expect(r.board.get(task.id)?.state).toBe("in_progress");
});

test("F4a advise quiet drift stops later identical-tree proof reads", async () => {
  let calls = 0;
  const r = scopeRig("advise", async () => {
    calls++; r.board.update(task.id, "hub", "answer", {});
    return { code: 0, stdout: JSON.stringify(readinessReply("SKIPPED")) };
  });
  const task = scopeTask(r);
  expect(await admitScope(r, task)).toEqual({ ready: false, blockers: [changedReadback] });
  expect(calls).toBe(1);
});

for (const drift of ["non-quiet", "mode", "owner", "privacy", "receipt", "conductor", "private turn"] as const) test(`F4b advise refuses ${drift} drift even alongside a quiet event`, async () => {
  let calls = 0;
  const r = scopeRig("advise", async () => {
    calls++;
    r.board.update(task.id, "hub", drift === "non-quiet" ? "plan changed" : "answer", {
      ...(drift === "owner" ? { owner: "kimi" } : {}),
      ...(drift === "privacy" ? { signals: ["pii"] } : {}),
      ...(drift === "receipt" ? { sdlc: { ...task.sdlc!, localHead: "d".repeat(40) } } : {}),
    });
    if (drift === "mode") r.policy.mode = "off";
    if (drift === "conductor") r.roles.director = [];
    if (drift === "private turn") r.privacy.active = true;
    return { code: 0, stdout: JSON.stringify(readinessReply()) };
  });
  r.roles.director = ["conductor"];
  const task = scopeTask(r);
  await expect(admitScope(r, task, drift === "conductor" ? "director" : "codex")).rejects.toThrow(/admission/);
  expect(calls).toBe(1);
  expect(r.board.get(task.id)?.history.some(entry => entry.event === "done")).toBe(false);
});

test("F4c enforce still refuses quiet readback drift", async () => {
  let calls = 0;
  const r = scopeRig("enforce", async () => {
    calls++; r.board.update(task.id, "hub", "answer", {});
    return { code: 0, stdout: JSON.stringify(readinessReply()) };
  });
  const task = scopeTask(r);
  await expect(admitScope(r, task)).rejects.toThrow("changed during review admission");
  expect(calls).toBe(1);
});

const waitCheck = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition()).toBe(true);
};
for (const scenario of ["advise quiet", "reviewer change", "enforce quiet", "enforce reviewer change", "owner change", "state change", "privacy change"] as const) test(`F4d delayed completion handles ${scenario} with the eligible owner notice`, async () => {
  const mode = scenario.startsWith("enforce") ? "enforce" : "advise";
  let finish!: (result: { code: number; timedOut: boolean; tail: string }) => void;
  const checked = new Promise<{ code: number; timedOut: boolean; tail: string }>(resolve => { finish = resolve; });
  let checkStarted!: () => void;
  const started = new Promise<void>(resolve => { checkStarted = resolve; });
  let afterCheck = false, admissionCalls = 0;
  const r = scopeRig(mode, async args => {
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    if (args.join(" ").includes("commits(last:1)")) {
      admissionCalls++;
      if (afterCheck) r.board.update(task.id, "hub", scenario.includes("reviewer change") ? "reviewer changed" : "answer", {
        ...(scenario === "owner change" ? { owner: "kimi" } : {}),
        ...(scenario === "privacy change" ? { signals: ["pii"] } : {}),
        ...(scenario.includes("reviewer change") ? { reviewer: "claude" } : {}),
        ...(scenario === "state change" ? { state: "cancelled" as const } : {}),
      });
    }
    return { code: 0, stdout: JSON.stringify(readinessReply()) };
  }, { check: () => "fixture check", runCheck: () => { checkStarted(); return checked; } });
  const task = scopeTask(r);
  // Owners are registered but offline, so the real bus retains their retry notices for inspection.
  for (const owner of ["codex", "kimi", "local", "claude"]) r.bus.add(new ReadyReviewer(owner));
  expect((await r.tasks.done("codex", task.id, "PRIVATE_SUMMARY_CANARY")).state).toBe("in_progress");
  await started;
  afterCheck = true; finish({ code: 0, timedOut: false, tail: "fixture passed" });
  await waitCheck(() => r.tasks.checksPending() === 0);
  expect(admissionCalls).toBe(2);
  const current = r.board.get(task.id)!;
  if (scenario === "advise quiet" || scenario === "reviewer change") {
    expect(current.state).toBe("in_review");
    expect(current.history.filter(entry => entry.event === "done")).toHaveLength(1);
    expect(r.notices.join("\n")).toContain(changedReadback);
    if (scenario === "reviewer change") {
      expect(current.reviewer).toBe("claude");
      expect(r.bus.pendingEnvelopes("claude").filter(env => env.kind === "review")).toHaveLength(1);
    }
  } else {
    expect(current.state).toBe(scenario === "state change" ? "cancelled" : "in_progress");
    expect(current.history.some(entry => entry.event === "done")).toBe(false);
    const recipient = scenario === "owner change" ? "kimi" : "codex";
    const retries = r.bus.pendingEnvelopes(recipient).filter(env => env.body.includes("hub_task_done again"));
    if (scenario === "owner change" || scenario === "state change") {
      expect(retries).toHaveLength(0);
      expect(r.bus.pendingEnvelopes("codex").filter(env => env.body.includes("hub_task_done again"))).toHaveLength(0);
      expect(r.notices.join("\n")).toContain("check result could not be recorded");
      return;
    }
    expect(retries).toHaveLength(1);
    expect(retries[0]?.refs?.taskRecipient).toBe("owner");
    if (scenario === "privacy change") expect(retries[0]?.private).toBe(true);
    expect(JSON.stringify(retries)).not.toContain("PRIVATE_SUMMARY_CANARY");
    expect(JSON.stringify(retries)).not.toContain("PRIVATE_TITLE_CANARY");
  }
});
