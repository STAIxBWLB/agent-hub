import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_TASK_SWEEP, nextSweep, taskSweepConfig } from "../src/hub/task-sweep.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

class Peer extends BasePeer {
  got: Envelope[] = [];
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
  async start() { this.setState("idle"); }
  async stop() {}
  set(state: PeerState) { this.setState(state); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const drain = () => new Promise((resolve) => setTimeout(resolve, 5));
async function fixture(overrides: Partial<TasksDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-sweep-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db");
  let board = new Board(file);
  cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  const peers = Object.fromEntries(["codex", "claude", "kimi", "local"].map((id) => [id, new Peer(id)]));
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  const deps: TasksDeps = { board, bus, cwd: dir, project: "sweep-test", routing: () => loadRouting(dir), notify: (line) => notices.push(line), roles: { claude: ["planner"] }, sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, unaccepted_min: 1, idle_min: 2, review_min: 3, ladder_min: 1 }, ...overrides };
  let tasks = new Tasks(deps);
  const make = (state: TaskState = "proposed", signals: string[] = []) => {
    const made = board.propose("user", { title: signals.length ? "patient 900101-1234567" : "work", class: "implement", refs: { paths: ["a.ts"] }, signals });
    let task = board.update(made.id, HUB, "assigned", { owner: signals.length ? "local" : "codex", reviewer: "claude" });
    if (state !== "proposed") task = board.update(task.id, task.owner!, "accepted", { state: "in_progress" });
    if (state === "in_review") task = board.update(task.id, task.owner!, "done", { state: "in_review" });
    return task;
  };
  const reopen = () => { board.close(); board = new Board(file); deps.board = board; tasks = new Tasks(deps); return tasks; };
  return { board, bus, peers, notices, tasks, make, deps, reopen };
}

for (const [state, kind, minutes] of [["proposed", "unaccepted-assignment", 1], ["in_progress", "idle-owner", 2], ["in_review", "review-pending", 3]] as const) {
  test(`sweep: ${kind} respects its threshold and responsible peer`, async () => {
    const f = await fixture();
    const task = f.make(state);
    const at = task.history.at(-1)!.at;
    expect(await f.tasks.sweep(at + minutes * 60_000 - 1)).toEqual([]);
    expect(await f.tasks.sweep(at + minutes * 60_000)).toMatchObject([{ task: task.id, finding: { kind, step: 1 } }]);
    await drain();
    const got = f.peers[state === "in_review" ? "claude" : "codex"]!.got;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "task", refs: { task: String(task.id) } });
    expect(got[0]!.body).toContain(kind);
  });
}

test("sweep: ladder persists through restart, planner escalation and default suggestion never reassign", async () => {
  const f = await fixture();
  const task = f.make();
  const at = task.history.at(-1)!.at + 60_000;
  await f.tasks.sweep(at);
  await drain();
  const again = f.reopen();
  expect(await again.sweep(at)).toEqual([]);
  expect(await again.sweep(at + 59_999)).toEqual([]);
  expect(await again.sweep(at + 60_000)).toMatchObject([{ finding: { step: 2 } }]);
  await drain();
  expect(f.peers.claude!.got[0]!.body).toContain("idle escalation 2/3");
  expect(await again.sweep(at + 120_000)).toMatchObject([{ finding: { step: 3 } }]);
  expect(await again.sweep(at + 180_000)).toEqual([]);
  expect(f.deps.board.get(task.id)!.owner).toBe("codex");
  expect(f.notices.at(-1)).toContain("reassignment suggestion: local");
  expect(f.deps.board.get(task.id)!.history.filter((h) => h.sweep).map((h) => h.sweep!.step)).toEqual([1, 2, 3]);
});

test("sweep: same-millisecond real activity resets ladder, its own history does not", async () => {
  const f = await fixture();
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  cleanup.push(() => clock.mockRestore());
  const task = f.make();
  await f.tasks.sweep(61_000);
  await drain();
  expect(nextSweep(f.board.get(task.id)!, f.deps.sweep!, 121_000)).toMatchObject({ step: 2, activity: 1 });
  f.board.update(task.id, "codex", "plan updated", {});
  expect(await f.tasks.sweep(61_000)).toMatchObject([{ finding: { step: 1, activity: 3 } }]);
});

test("sweep: PII notices and history carry only stub and structural identifiers", async () => {
  const f = await fixture();
  const task = f.make("proposed", ["pii"]);
  const at = task.history.at(-1)!.at + 60_000;
  for (let step = 0; step < 3; step++) { await f.tasks.sweep(at + step * 60_000); await drain(); }
  const emitted = JSON.stringify({ notices: f.notices, messages: Object.values(f.peers).flatMap((p) => p.got), events: f.board.get(task.id)!.history.filter((h) => h.sweep) });
  expect(emitted).not.toContain("900101");
  expect(emitted).not.toContain("a.ts");
  expect(f.peers.local!.got[0]!.body).toContain(`#${task.id} [pii]`);
});

test("sweep: disabled and malformed config cannot activate automation", async () => {
  const f = await fixture({ sweep: DEFAULT_TASK_SWEEP });
  const task = f.make();
  expect(await f.tasks.sweep(task.created + 100_000_000)).toEqual([]);
  for (const input of [null, [], { enabled: "true" }, { auto_reassign: "false" }, { interval_s: 0 }, { idle_min: NaN }, { ladder_min: -1 }, { review_min: Infinity }]) expect(() => taskSweepConfig(input)).toThrow();
  expect(taskSweepConfig(undefined)).toMatchObject({ enabled: false, auto_reassign: false });
});

test("sweep: busy, paused, offline, native-active, dependency, check, cohort and queue/recovery holds", async () => {
  let held = false;
  let nativeIdle = true;
  const f = await fixture({ sweepHeld: () => held, idle: () => nativeIdle, turnFree: () => true, capable: () => true });
  const task = f.make("in_progress");
  const at = task.created + 1_000_000;
  for (const state of ["busy", "paused", "offline"] as const) {
    f.peers.codex!.set(state);
    expect(await f.tasks.sweep(at)).toEqual([]);
  }
  f.peers.codex!.set("idle");
  nativeIdle = false; expect(await f.tasks.sweep(at)).toEqual([]); nativeIdle = true;
  held = true; expect(await f.tasks.sweep(at)).toEqual([]); held = false;
  f.bus.setRecoveryHold(true); expect(await f.tasks.sweep(at)).toEqual([]); f.bus.setRecoveryHold(false);
  f.deps.held = () => ({ codex: "needs_review" }); expect(await f.tasks.sweep(at)).toEqual([]); delete f.deps.held;
  f.bus.storageError = "unavailable"; expect(await f.tasks.sweep(at)).toEqual([]); f.bus.storageError = undefined;
  f.bus.pause("codex"); expect(await f.tasks.sweep(at)).toEqual([]); f.bus.resume("codex");
  const queued = spyOn(f.bus, "queued").mockReturnValue(1); expect(await f.tasks.sweep(at)).toEqual([]); queued.mockRestore();
  const inFlight = spyOn(f.bus, "hasInFlight").mockReturnValue(true); expect(await f.tasks.sweep(at)).toEqual([]); inFlight.mockRestore();
  const checking = spyOn(f.tasks, "isChecking").mockReturnValue(true); expect(await f.tasks.sweep(at)).toEqual([]); checking.mockRestore();
  const waits = spyOn(f.tasks, "waitsFor").mockReturnValue([99]); expect(await f.tasks.sweep(at)).toEqual([]); waits.mockRestore();
  const other = f.make("in_progress");
  f.board.update(other.id, HUB, "reassigned", { owner: "kimi" });
  f.tasks.cohorts.join(f.board.get(task.id)!, [f.board.get(other.id)!], () => 1, () => task.created);
  expect(f.tasks.silentFor(task.id)).toBe(true);
  expect(await f.tasks.sweep(at)).toEqual([]);
});

test("sweep: explicit opt-in reassigns owner within routing constraints, reviewer remains suggestion", async () => {
  const f = await fixture({ sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, unaccepted_min: 1, review_min: 1, ladder_min: 1, auto_reassign: true } });
  const task = f.make();
  const at = task.created + 60_001;
  for (let step = 0; step < 3; step++) { await f.tasks.sweep(at + step * 60_000); await drain(); }
  expect(f.board.get(task.id)!.owner).toBe("local");
  f.board.update(task.id, "local", "accepted", { state: "in_progress" });
  f.board.update(task.id, "local", "done", { state: "in_review" });
  const review = f.board.get(task.id)!;
  for (let step = 0; step < 3; step++) { await f.tasks.sweep(review.history.at(-1)!.at + 60_000 + step * 60_000); await drain(); }
  expect(f.board.get(task.id)!.reviewer).toBe(review.reviewer);
  expect(f.board.get(task.id)!.owner).toBe("local");
  expect(f.notices.at(-1)).toContain("Reviewer reassignment suggestion");
});
