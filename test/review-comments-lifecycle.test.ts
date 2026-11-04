import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { isReviewObserverExcluded } from "../src/hub/memory-policy.ts";
import { redactBusEvent } from "../src/hub/operational-view.ts";
import type { ReviewAnchor } from "@staix/agent-console/contract";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

class FixturePeer extends BasePeer {
  received: Envelope[] = [];
  private waiters: { match: (envelope: Envelope) => boolean; resolve: (envelope: Envelope) => void }[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envelopes: Envelope[]) {
    this.received.push(...envelopes);
    for (const envelope of envelopes) for (const waiter of [...this.waiters]) if (waiter.match(envelope)) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.resolve(envelope);
    }
  }
  waitFor(match: (envelope: Envelope) => boolean): Promise<Envelope> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => this.waiters.push({ match, resolve }));
  }
}

async function fixture(checking = false, screened = false, durable = false, heldPeer?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-review-lifecycle-"));
  const database = join(cwd, "hub.db"), journal = durable ? new DeliveryJournal({ file: join(cwd, "journal.db"), projectRoot: cwd, projectId: "review-lifecycle", instanceId: "test" }) : undefined;
  let board = new Board(database);
  const bus = new Bus({ batchMs: 0, ...(journal ? { journal, deliveryHeld: (peer: string) => peer === heldPeer } : {}) });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const owner = new FixturePeer("codex"), observer = new FixturePeer("claude");
  bus.add(owner); bus.add(observer); await owner.start(); await observer.start();
  const text = "First line\nQuoted line\nLast line\n", hash = createHash("sha256").update(text).digest("hex");
  const checkResolvers: ((result: { code: number; timedOut: boolean; tail: string }) => void)[] = [];
  const checkWaiters: (() => void)[] = [];
  const screenedTexts: string[] = [], routing = loadRouting(cwd);
  if (screened) { routing.signals.pii_screen = "local"; routing.constraints.pii = "local_only"; }
  const deps: TasksDeps = {
    cwd, board, bus, project: "fixture", roles: { codex: ["implementer"], claude: ["implementer", "reviewer"] },
    routing: () => routing, piiPaths: [], wipLimit: () => 3, notify: () => {},
    ...(screened ? { piiScreen: async (value: string) => { screenedTexts.push(value); return { label: value.includes("SUMMARY_WITHHELD_CANARY") ? "pii" as const : "clear" as const, ms: 1 }; } } : {}),
    reviewMaterials: async (_task, requests) => ({ head: "a".repeat(40), materials: requests.map(request => ({ state: "available" as const, path: request.path, side: request.side ?? "head", text, rawHash: hash, contentHash: hash })) }),
    ...(checking ? { check: () => "fixture-check", runCheck: () => new Promise<{ code: number; timedOut: boolean; tail: string }>(resolve => { checkResolvers.push(resolve); checkWaiters.shift()?.(); }) } : {}),
  };
  const tasks = new Tasks(deps), task = await tasks.propose("codex", { owner: "codex", title: "Review lifecycle fixture", class: "implement", refs: { commit: "a".repeat(40), paths: ["notes/report.md"] } });
  const anchor: ReviewAnchor = { path: "notes/report.md", side: "head", contentHash: hash, selectors: [{ kind: "lineRange", startLine: 2, endLine: 2 }] };
  const draft = await tasks.reviewCommentPut("user", { task: task.id, commit: "a".repeat(40), anchor, body: "Please address this review comment" });
  return { cwd, board, reopenBoard: () => { board.close(); board = new Board(database); return board; }, bus, owner, observer, tasks, task, draft, screenedTexts, nextCheck: () => new Promise<void>(resolve => checkWaiters.push(resolve)), finishCheck: (result: { code: number; timedOut: boolean; tail: string }) => { const resolve = checkResolvers.shift(); if (!resolve) throw new Error("no check is waiting"); resolve(result); } };
}

async function fileAnchoredFinding(f: Awaited<ReturnType<typeof fixture>>, taskId = f.task.id) {
  const current = f.board.get(taskId)!;
  if (current.state !== "in_review") {
    f.board.update(taskId, "user", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    f.board.update(taskId, "codex", "done", { state: "in_review" });
  }
  return f.tasks.review("claude", taskId, "changes_requested", "Anchored finding", undefined, "a".repeat(40), undefined, [{
    id: "durable-anchor", pass: "bugs", severity: "important", disposition: "open", anchor: {
      path: "notes/report.md", side: "head", contentHash: createHash("sha256").update("First line\nQuoted line\nLast line\n").digest("hex"),
      selectors: [{ kind: "lineRange", startLine: 2, endLine: 2 }],
    },
  }]);
}

test("open review scope survives intervening chat, blocks memory, and leaves owner done text visible", async () => {
  const f = await fixture();
  await f.tasks.reviewCommentSend("user", { task: f.task.id });
  f.bus.publish(newEnvelope("hub", "ordinary intervening chat", { to: ["codex"], kind: "task" }));
  let refusal: unknown;
  try { await f.tasks.remember("codex", { task: f.task.id, text: "memory attempt" }); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(PreEffectToolRefusal);
  expect((refusal as Error).message).toContain("open review scope (sent comments, anchored findings, unsettled delivery or current review input)");

  const done = await f.tasks.done("codex", f.task.id, "Addressed review summary", undefined, undefined, undefined, [f.draft.id]);
  const completion = done.history.findLast(entry => entry.event === "done")!;
  expect(completion.note).toContain("Addressed review summary");
  expect(completion.withheld).toBeUndefined();
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("resolved");
  expect(await f.tasks.remember("codex", { task: f.task.id, text: "after resolution" })).toContain("memory is disabled");
});

test("review input remains excluded from memory through the completion call until ordinary input arrives", async () => {
  const f = await fixture();
  await f.tasks.reviewCommentSend("user", { task: f.task.id });
  const quote = "REVIEW_SUMMARY_QUOTE_CANARY";
  const done = await f.tasks.done("codex", f.task.id, `Addressed review in the review turn ${quote}`, undefined, undefined, undefined, [f.draft.id]);
  expect(done.reviewer).toBe("claude");
  expect(done.history.findLast(entry => entry.event === "done")?.note).toContain(`Addressed review in the review turn ${quote}`);
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("resolved");
  const reviewEnvelope = f.observer.received.find(envelope => envelope.kind === "review" && envelope.refs?.task === String(f.task.id));
  expect(reviewEnvelope?.refs?.reviewPackage).toMatch(/^review-/);
  expect(reviewEnvelope && isReviewObserverExcluded(reviewEnvelope)).toBe(true);
  expect(reviewEnvelope?.body).toContain(quote); // the assigned reviewer still receives the owner's summary
  expect(JSON.stringify(redactBusEvent({ t: "envelope", env: reviewEnvelope! }))).not.toContain(quote);

  let refusal: unknown;
  try { await f.tasks.remember("codex", { task: f.task.id, text: "same review turn memory" }); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(PreEffectToolRefusal);
  expect((refusal as Error).message).toContain("current review input");

  const ordinary = "ordinary input after review completion";
  const delivered = f.owner.waitFor(envelope => envelope.body === ordinary);
  f.bus.publish(newEnvelope("hub", ordinary, { to: ["codex"], kind: "task" }));
  await delivered;
  expect(await f.tasks.remember("codex", { task: f.task.id, text: "after ordinary input" })).toContain("memory is disabled");
  expect(f.board.hasReviewObserverScope("claude", f.task.id)).toBe(true);
  expect(f.reopenBoard().hasReviewObserverScope("claude", f.task.id)).toBe(true);
});

test("an owner's unrelated task remains visible while another task has open review comments", async () => {
  const f = await fixture();
  await f.tasks.reviewCommentSend("user", { task: f.task.id });
  const unrelated = await f.tasks.propose("codex", { owner: "codex", title: "Unrelated work", class: "implement", refs: { paths: ["src/unrelated.ts"] } });
  const observerTask = await f.tasks.propose("claude", { owner: "claude", title: "Observe unrelated work", class: "implement", refs: { paths: ["src/unrelated.ts"] } });
  f.tasks.accept("claude", observerTask.id);
  expect(f.board.get(observerTask.id)).toMatchObject({ owner: "claude", state: "in_progress" });
  expect(f.tasks.ownerWriteAcceptance(f.board.get(observerTask.id)!)).toBeDefined();
  expect(f.tasks.overlapTasks(f.board.get(unrelated.id)!)).toContain(observerTask.id);
  const done = await f.tasks.done("codex", unrelated.id, "Unrelated completion summary");
  const completion = done.history.findLast(entry => entry.event === "done")!;
  expect(completion.note).toContain("Unrelated completion summary");
  expect(completion.withheld).toBeUndefined();
  expect(f.observer.received.some(envelope => envelope.kind === "task" && envelope.body.includes("Summary: Unrelated completion summary"))).toBe(true);
});

test("a former owner keeps review observer scope for a journaled package until it is delivered", async () => {
  const f = await fixture(false, false, true, "codex");
  await f.tasks.reviewCommentSend("user", { task: f.task.id });
  expect(f.bus.hasUnsettledReviewScope("codex", f.task.id)).toBe(true);
  const reassigned = await f.tasks.assignTo(f.task.id, "claude", "user");
  expect(reassigned.owner).toBe("claude");
  expect(f.bus.hasUnsettledReviewScope("codex", f.task.id)).toBe(true);
  let refusal: unknown;
  try { await f.tasks.remember("codex", { task: f.task.id, text: "former owner memory attempt" }); } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(PreEffectToolRefusal);
  expect((refusal as Error).message).toContain("open review scope (sent comments, anchored findings, unsettled delivery or current review input)");
});

test("anchored finding scope survives restart and intervening reviewer chat", async () => {
  const f = await fixture();
  await fileAnchoredFinding(f);
  expect(f.board.hasReviewObserverScope("claude", f.task.id)).toBe(true);
  f.bus.publish(newEnvelope("hub", "ordinary intervening chat", { to: ["claude"], kind: "task" }));
  const reopened = f.reopenBoard();
  expect(reopened.hasReviewObserverScope("claude", f.task.id)).toBe(true);
  expect(reopened.hasReviewObserverScope("codex", f.task.id)).toBe(true);
  expect(reopened.hasReviewObserverScope("claude", 987654)).toBe(false);
});

test("an anchored finding on another task does not hide the owner's unrelated completion", async () => {
  const f = await fixture();
  await fileAnchoredFinding(f);
  const unrelated = await f.tasks.propose("codex", { owner: "codex", title: "Unrelated anchored work", class: "implement", refs: { paths: ["src/unrelated.ts"] } });
  const observerTask = await f.tasks.propose("claude", { owner: "claude", title: "Observe unrelated anchored work", class: "implement", refs: { paths: ["src/unrelated.ts"] } });
  f.tasks.accept("claude", observerTask.id);
  expect(f.tasks.overlapTasks(f.board.get(unrelated.id)!)).toContain(observerTask.id);
  const done = await f.tasks.done("codex", unrelated.id, "Unrelated completion summary");
  const completion = done.history.findLast(entry => entry.event === "done")!;
  expect(completion.note).toContain("Unrelated completion summary");
  expect(completion.withheld).toBeUndefined();
  expect(f.observer.received.some(envelope => envelope.kind === "task" && envelope.body.includes("Summary: Unrelated completion summary"))).toBe(true);
  expect(f.board.hasReviewObserverScope("codex", unrelated.id)).toBe(false);
});

test("a failed configured check shows its tail to the owner when the summary is screened", async () => {
  const f = await fixture(true, true);
  const waiting = f.nextCheck();
  await f.tasks.done("codex", f.task.id, "SUMMARY_WITHHELD_CANARY");
  await waiting;
  f.finishCheck({ code: 1, timedOut: false, tail: "OWNER_CHECK_TAIL_CANARY" });
  await (f.tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  const history = f.board.get(f.task.id)!.history;
  expect(f.screenedTexts).toContain("SUMMARY_WITHHELD_CANARY");
  expect(history.findLast(entry => entry.event === "done (checking)")?.withheld).toBe(true);
  expect(f.owner.received.some(envelope => envelope.body.includes("OWNER_CHECK_TAIL_CANARY"))).toBe(true);
});

test("sent comment ids resolve only after a successful check and remain retryable after failure", async () => {
  const f = await fixture(true);
  await f.tasks.reviewCommentSend("user", { task: f.task.id });
  const waitingForFailure = f.nextCheck();
  await f.tasks.done("codex", f.task.id, "Addressed review", undefined, undefined, undefined, [f.draft.id]);
  await waitingForFailure;
  f.finishCheck({ code: 1, timedOut: false, tail: "fixture failure" });
  await (f.tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("sent");

  const waitingForSuccess = f.nextCheck();
  await f.tasks.done("codex", f.task.id, "Addressed review after retry", undefined, undefined, undefined, [f.draft.id]);
  await waitingForSuccess;
  f.finishCheck({ code: 0, timedOut: false, tail: "fixture passed" });
  await (f.tasks as unknown as { checkQueue: Promise<void> }).checkQueue;
  expect(f.board.reviewComments(f.task.id, f.task.created)[0]?.lifecycle).toBe("resolved");
  const completion = f.board.get(f.task.id)!.history.findLast(entry => entry.event === "done")!;
  expect(completion.note).toContain("Addressed review after retry");
  expect(completion.note).toContain("fixture-check -> exit 0");
  expect(completion.withheld).toBeUndefined();
});
