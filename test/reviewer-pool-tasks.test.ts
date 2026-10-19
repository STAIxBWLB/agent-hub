import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { parseRouting } from "../src/hub/routing.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const close: (() => void)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
class Reviewer extends BasePeer {
  readonly seen: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.seen.push(...envs); }
}
async function rig(extra: Partial<TasksDeps> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-pool-tasks-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const instances = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const }, "claude-two": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const }, "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const } };
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", instances: () => instances, roles: { "claude-review": ["reviewer"], "claude-two": ["reviewer"], "codex-review": ["reviewer"] }, notify: () => {}, review: { adaptive: false, min_reviews: 5, pool: ["claude", "codex"] }, routing: () => parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude", "codex"]\n'), reviewOnly: () => true, ...extra });
  const peers = Object.fromEntries(await Promise.all(["codex", "claude-review", "claude-two", "codex-review"].map(async id => { const peer = new Reviewer(id); bus.add(peer); await peer.start(); return [id, peer] as const; })));
  const task = board.propose("user", { title: "Review implementation", class: "summarize" });
  board.update(task.id, "codex", "accepted", { owner: "codex", state: "in_progress", refs: { commit: "a".repeat(40) } });
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, board, bus, task, peers };
}

test("done reselects a fresh pool reviewer and binds assignment metadata and request revision", async () => {
  const { tasks, board, task, peers } = await rig();
  const done = await tasks.done("codex", task.id, "BUILDER-NARRATIVE");
  expect(done).toMatchObject({ state: "in_review", reviewer: "claude-review" });
  expect(done.history.at(-1)).toMatchObject({ reviewerFamily: "claude", reviewerReason: "implementer skip" });
  await Bun.sleep(1);
  const request = peers["claude-review"]!.seen.find(env => env.kind === "review");
  expect(request?.refs?.reviewRevision).toBe(String(board.get(task.id)!.history.length));
  expect(request?.body).not.toContain("BUILDER-NARRATIVE");
  expect(tasks.explain(task.id).some(line => line.includes("reviewer pool"))).toBe(true);
});

test("pool exhaustion retains human review instead of approving unreviewed work", async () => {
  const { tasks, task, peers } = await rig();
  for (const id of ["claude-review", "claude-two", "codex-review"]) await peers[id]!.stop();
  const done = await tasks.done("codex", task.id, "ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: "user" });
  expect(done.history.at(-1)?.reviewBlocked).toBe(true);
  expect(tasks.resultLine(done)).toContain("blocked: no reviewer can run");
});

test("manual named reviewer survives complete-time automatic pool selection", async () => {
  const { tasks, task } = await rig();
  await tasks.assignTo(task.id, "claude-two", "user", true, "reviewer");
  expect((await tasks.done("codex", task.id, "ready")).reviewer).toBe("claude-two");
});

test("current same-head reviewer failure records evidence and reroutes once without approving", async () => {
  const { tasks, board, task } = await rig();
  const done = await tasks.done("codex", task.id, "ready");
  const failure = { head: done.refs.commit, flowRevision: done.history.length, cause: "no_verdict" as const };
  const moved = await tasks.retryReviewer(task.id, "claude-review", failure, () => true);
  expect(moved).toMatchObject({ state: "in_review", owner: "codex", reviewer: "claude-two" });
  expect(moved.history.at(-1)?.reviewerFailure).toMatchObject({ peer: "claude-review", cause: "no_verdict", head: done.refs.commit });
  const before = board.get(task.id);
  await expect(tasks.retryReviewer(task.id, "claude-review", failure, () => true)).rejects.toThrow();
  expect(board.get(task.id)).toEqual(before);
});

test("failure callbacks cannot mutate a changed head, revision, authority or private task", async () => {
  for (const change of ["head", "revision", "authority", "private", "after-await"] as const) {
    const { tasks, board, task } = await rig();
    const done = await tasks.done("codex", task.id, "ready");
    if (change === "head") board.update(task.id, "user", "lifecycle", { refs: { commit: "b".repeat(40) } });
    if (change === "revision") board.update(task.id, "user", "reviewer changed", { reviewer: done.reviewer });
    if (change === "private") board.update(task.id, "user", "screened", { signals: ["pii"] });
    let calls = 0;
    const current = () => change !== "authority" && (change !== "after-await" || ++calls === 1);
    const before = board.get(task.id);
    await expect(tasks.retryReviewer(task.id, "claude-review", { head: done.refs.commit, flowRevision: done.history.length, cause: "start_failed" }, current)).rejects.toThrow();
    expect(board.get(task.id)).toEqual(before);
  }
});

test("verdict family and rotation reason come from host assignment history", async () => {
  const { tasks, task } = await rig({ reviewContext: () => "fresh" });
  await tasks.done("codex", task.id, "ready");
  const approved = await tasks.review("claude-review", task.id, "approved", "checked");
  expect(approved.history.findLast(row => row.event === "approved")).toMatchObject({ reviewerFamily: "claude", reviewerReason: "implementer skip", reviewContext: "fresh" });
});

test("a new same-head review round may retry a recovered reviewer", async () => {
  const { tasks, task } = await rig();
  const done = await tasks.done("codex", task.id, "ready");
  await tasks.retryReviewer(task.id, "claude-review", { head: done.refs.commit, flowRevision: done.history.length, cause: "start_failed" }, () => true);
  await tasks.review("claude-two", task.id, "changes_requested", "fix the item", ["fix the item"]);
  expect((await tasks.done("codex", task.id, "fixed")).reviewer).toBe("claude-review");
});

test("public history exposes bounded host selection data and private tasks omit it", async () => {
  const { tasks, board, task } = await rig();
  const done = await tasks.done("codex", task.id, "ready");
  expect((tasks.publicView(done).history as { reviewerFamily?: string }[]).at(-1)?.reviewerFamily).toBe("claude");
  const before = board.get(task.id);
  expect(() => board.update(task.id, "user", "invalid", {}, undefined, { reviewerFamily: "a".repeat(65) })).toThrow("reviewer metadata");
  expect(board.get(task.id)).toEqual(before);
  const privateTask = board.update(task.id, "user", "screened", { signals: ["pii"] });
  expect(tasks.publicView(privateTask).history).toBeUndefined();
});

test("each failed candidate is attempted once per round and final exhaustion remains human review", async () => {
  const { tasks, task } = await rig();
  let current = await tasks.done("codex", task.id, "ready");
  for (const peer of ["claude-review", "claude-two", "codex-review"]) {
    expect(current.reviewer).toBe(peer);
    current = await tasks.retryReviewer(task.id, peer, { head: current.refs.commit, flowRevision: current.history.length, cause: "start_failed" }, () => true);
  }
  expect(current).toMatchObject({ state: "in_review", reviewer: "user" });
  expect(current.history.filter(entry => entry.reviewerFailure)).toHaveLength(3);
  expect(tasks.resultLine(current)).toContain("blocked: no reviewer can run");
});

test("unavailable-only declarations keep done in human review with an omitted pool setting", async () => {
  const { tasks, task, bus } = await rig({ instances: () => ({ "agy-review": { kind: "agy", roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" } }), roles: { "agy-review": ["reviewer"] }, review: { adaptive: false, min_reviews: 5 } });
  const unavailable = new Reviewer("agy-review"); bus.add(unavailable); await unavailable.start();
  const done = await tasks.done("codex", task.id, "ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: "user" });
  expect(done.history.at(-1)?.reviewBlocked).toBe(true);
  expect(tasks.explain(task.id).join("\n")).toContain("agy is an implementer peer (#485)");
});

test("retry accepts bounded free-text commit refs and ignores unrelated bookkeeping", async () => {
  const { tasks, board, task } = await rig();
  const done = await tasks.done("codex", task.id, "ready", { commit: "release candidate for review" });
  board.update(task.id, "user", "answer", {}, "bookkeeping");
  const moved = await tasks.retryReviewer(task.id, "claude-review", { head: done.refs.commit, flowRevision: done.history.length, cause: "no_verdict" }, () => true);
  expect(moved).toMatchObject({ reviewer: "claude-two", state: "in_review" });
  expect(moved.history.at(-1)?.reviewerFailure?.head).toBe("release candidate for review");
});

test("retry is bound to its actual review request even when the reviewer and head are unchanged", async () => {
  const { tasks, board, task } = await rig();
  const done = await tasks.done("codex", task.id, "ready");
  board.update(task.id, "user", "reviewer changed", { reviewer: done.reviewer });
  const before = board.get(task.id);
  await expect(tasks.retryReviewer(task.id, "claude-review", { head: done.refs.commit, flowRevision: done.history.length, cause: "start_failed" }, () => true)).rejects.toThrow();
  expect(board.get(task.id)).toEqual(before);
});

test("optional pool fallback records its blocked walk and planner identity without marking the task blocked", async () => {
  const { tasks, task, peers, bus } = await rig({ review: { adaptive: false, min_reviews: 5 }, roles: { claude: ["planner", "reviewer"], "claude-review": ["reviewer"], "claude-two": ["reviewer"], "codex-review": ["reviewer"] } });
  const planner = new Reviewer("claude"); bus.add(planner); await planner.start();
  for (const id of ["claude-review", "claude-two", "codex-review"]) await peers[id]!.stop();
  const done = await tasks.done("codex", task.id, "ready");
  expect(done).toMatchObject({ reviewer: "claude", state: "in_review" });
  expect(done.history.at(-1)).toMatchObject({ reviewerFamily: "claude", reviewerReason: "unavailable skip" });
  expect(done.history.at(-1)?.reviewBlocked).toBeUndefined();
  expect(done.history.at(-1)?.note).toContain("no reviewer can run");
  expect(done.history.at(-1)?.note).toContain("claude-review");
});


test("same-family planner fallback records the same reason in history and note", async () => {
  const { tasks, task, peers, bus } = await rig({ review: { adaptive: false, min_reviews: 5 }, roles: { codex: ["implementer"], "claude-review": ["reviewer"], "claude-two": ["reviewer"], "codex-review": ["reviewer"], "codex-planner": ["planner", "reviewer"] }, instances: () => ({ "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" }, "codex-planner": { kind: "codex", roles: ["planner", "reviewer"], start_mode: "headless" } }) });
  for (const id of ["claude-review", "claude-two", "codex-review"]) await peers[id]!.stop();
  const planner = new Reviewer("codex-planner");
  bus.add(planner); await planner.start();
  const done = await tasks.done("codex", task.id, "ready");
  expect(done).toMatchObject({ reviewer: "codex-planner", state: "in_review" });
  expect(done.history.at(-1)).toMatchObject({ reviewerFamily: "codex", reviewerReason: "same-family fallback" });
  expect(done.history.at(-1)?.note).toContain("sameFamilyFallback=true");
});
