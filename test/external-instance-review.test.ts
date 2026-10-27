import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore } from "@staix/agent-mem";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { deliverableHooks, hashDeliverables } from "../src/hub/deliverable-files.ts";

const OWNER = "fixture-writer", REVIEWER = "fixture-reviewer", PROJECT = "synthetic/external-review";
const REFUSAL = "external instance launch or execution root changed";
const cleanup: (() => void)[] = [];
afterEach(() => {
  delete deliverableHooks.beforeOpen;
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-external-review-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const home = join(cwd, "isolated-home"), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const store = new MemoryStore({ home, screen: () => "skip" }), candidates = new CandidateStore({ home });
  cleanup.push(() => board.close(), () => bus.closeJournal(), () => store.close(), () => candidates.close());
  const routing = loadRouting(cwd); routing.signals.pii_screen = "local"; routing.constraints.pii = "local_only";
  let live = true, screens = 0, autoMerges = 0, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  cleanup.push(() => release());
  const notices: string[] = [], shares: string[] = [], tells: string[] = [];
  const tasks = new Tasks({ board, bus, cwd, project: PROJECT, routing: () => routing,
    store: { store, project: PROJECT, repo: PROJECT }, candidates,
    // A continuing external reviewer has no builtin reviewAuthority backend.
    requestAuthority: by => by === OWNER || by === REVIEWER ? () => live ? undefined : REFUSAL : undefined,
    piiScreen: async () => { screens++; entered(); await barrier; return { label: "clear", ms: 0 }; },
    notify: text => notices.push(text), share: (_by, text) => shares.push(text), tell: (_peer, text) => tells.push(text),
  });
  // Observe the real post-verdict callback without replacing its policy or its effects.
  const observed = tasks as unknown as { autoMerge(task: Task, after?: Promise<void>): void };
  const autoMerge = observed.autoMerge;
  observed.autoMerge = (task, after) => { autoMerges++; autoMerge.call(tasks, task, after); };
  const proposed = board.propose(OWNER, { title: "public boundary fixture", class: "implement", refs: {} });
  board.update(proposed.id, OWNER, "accepted", { state: "in_progress", owner: OWNER, reviewer: REVIEWER });
  const task = board.update(proposed.id, OWNER, "done", { state: "in_review" }, "public fixture completion");
  const dependent = board.propose(OWNER, { title: "public dependent fixture", class: "implement", refs: {}, deps: [task.id] });
  const snapshot = () => JSON.stringify(board.list());
  const effects = () => ({ outcomes: board.outcomes("implement", 0), reviews: board.reviews({ task: task.id }), candidates: candidates.list({ project: PROJECT, status: "all" }), autoMerges, notices, shares, tells });
  return { cwd, board, bus, store, tasks, task, dependent, snapshot, effects, reached, release,
    revoke: () => { live = false; }, screens: () => screens };
}

for (const verdict of ["approved", "changes_requested"] as const) test(`#754 a revoked continuing review cannot save ${verdict} after privacy screening`, async () => {
  const f = fixture(), before = f.snapshot(), memory = f.store.dump();
  const outcome = f.tasks.review(REVIEWER, f.task.id, verdict, "public review assessment", ["retain the strict request boundary"])
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const reached = await Promise.race([f.reached.then(() => true), outcome.then(() => false)]);
  try {
    expect(reached).toBe(true);
    expect(f.screens()).toBe(1);
    f.revoke();
  } finally { f.release(); }
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain(REFUSAL);
  expect(f.snapshot()).toBe(before); // Includes the dependent's state and complete history.
  expect(f.store.dump()).toBe(memory);
  expect(f.effects()).toEqual({ outcomes: [], reviews: [], candidates: [], autoMerges: 0, notices: [], shares: [], tells: [] });
});

test("#754 a current continuing reviewer can save an approval after screening", async () => {
  const f = fixture();
  const outcome = f.tasks.review(REVIEWER, f.task.id, "approved", "public review assessment");
  await f.reached; f.release();
  expect((await outcome).state).toBe("approved");
  expect(f.board.get(f.task.id)!.history.some(entry => entry.event === "approved" && entry.by === REVIEWER)).toBe(true);
  expect(f.effects().outcomes).toMatchObject([{ peer: OWNER, ok: 1 }]);
  expect(f.effects().reviews).toMatchObject([{ implementer: OWNER, reviewer: REVIEWER, kind: "approved", task: f.task.id }]);
  expect(f.effects().autoMerges).toBe(1);
});

test("#754 an already revoked continuing reviewer refuses before screening or verdict effects", async () => {
  const f = fixture(), before = f.snapshot(); f.revoke();
  await expect(f.tasks.review(REVIEWER, f.task.id, "approved", "public review assessment")).rejects.toThrow(REFUSAL);
  expect(f.screens()).toBe(0); expect(f.snapshot()).toBe(before);
  expect(f.effects()).toEqual({ outcomes: [], reviews: [], candidates: [], autoMerges: 0, notices: [], shares: [], tells: [] });
});

test("#754 review approval cannot survive authority loss during real deliverable hashing", async () => {
  const f = fixture(), path = "report.md";
  writeFileSync(join(f.cwd, path), "public report bytes");
  const records = await hashDeliverables([{ path, format: "md" }], { cwd: f.cwd, deny: [], private: () => false });
  f.board.update(f.task.id, OWNER, "done", {}, "public delivered report", { deliverables: records });
  const before = f.snapshot(), memory = f.store.dump();
  let reads = 0;
  deliverableHooks.beforeOpen = () => { reads++; f.revoke(); };
  f.release(); // This case reaches the later hash await rather than stopping at the privacy screen.
  await expect(f.tasks.review(REVIEWER, f.task.id, "approved", "public review assessment")).rejects.toThrow(REFUSAL);
  expect(reads).toBe(1); expect(f.snapshot()).toBe(before); expect(f.store.dump()).toBe(memory);
  expect(f.effects()).toEqual({ outcomes: [], reviews: [], candidates: [], autoMerges: 0, notices: [], shares: [], tells: [] });
});

for (const by of [OWNER, REVIEWER]) test(`#754 ${by} cannot record lifecycle deliverables after authority loss during the real hash`, async () => {
  const f = fixture(), before = f.snapshot();
  writeFileSync(join(f.cwd, "report.md"), "public report bytes");
  let reads = 0;
  // This host seam runs after entry admission and immediately before the asynchronous real file open/read.
  deliverableHooks.beforeOpen = () => { reads++; f.revoke(); };
  await expect(f.tasks.recordSdlc(by, f.task.id, { stage: "implement", deliverables: [{ path: "report.md", format: "md" }] })).rejects.toThrow(REFUSAL);
  expect(reads).toBe(1); expect(f.snapshot()).toBe(before);
  expect(f.effects()).toEqual({ outcomes: [], reviews: [], candidates: [], autoMerges: 0, notices: [], shares: [], tells: [] });
});

test("#754 current lifecycle authority records the actual deliverable bytes", async () => {
  const f = fixture(), text = "public report bytes";
  writeFileSync(join(f.cwd, "report.md"), text);
  const recorded = await f.tasks.recordSdlc(OWNER, f.task.id, { stage: "implement", deliverables: [{ path: "report.md", format: "md" }] });
  expect(recorded.history.findLast(entry => entry.event === "lifecycle")?.deliverables).toMatchObject([{ path: "report.md", format: "md", bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") }]);
});

test("#754 revoked lifecycle authority refuses before opening deliverables", async () => {
  const f = fixture(), before = f.snapshot();
  writeFileSync(join(f.cwd, "report.md"), "public report bytes");
  let reads = 0; deliverableHooks.beforeOpen = () => { reads++; };
  f.revoke();
  await expect(f.tasks.recordSdlc(REVIEWER, f.task.id, { stage: "implement", deliverables: [{ path: "report.md", format: "md" }] })).rejects.toThrow(REFUSAL);
  expect(reads).toBe(0); expect(f.snapshot()).toBe(before);
});

test("#754 revoked lifecycle authority cannot record a receipt without deliverables", async () => {
  const f = fixture(), before = f.snapshot(); f.revoke();
  await expect(f.tasks.recordSdlc(REVIEWER, f.task.id, { stage: "implement" })).rejects.toThrow(REFUSAL);
  expect(f.snapshot()).toBe(before);
});
