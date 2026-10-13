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
  const at = task.history.at(-1)!.at + 60_001; // assignment, not creation, begins the inactivity threshold
  for (let step = 0; step < 3; step++) { await f.tasks.sweep(at + step * 60_000); await drain(); }
  expect(f.board.get(task.id)!.history.flatMap(entry => entry.sweep ? [entry.sweep.step] : [])).toEqual([1, 2, 3]);
  expect(f.board.get(task.id)!.owner).toBe("local");
  f.board.update(task.id, "local", "accepted", { state: "in_progress" });
  f.board.update(task.id, "local", "done", { state: "in_review" });
  const review = f.board.get(task.id)!;
  for (let step = 0; step < 3; step++) { await f.tasks.sweep(review.history.at(-1)!.at + 60_000 + step * 60_000); await drain(); }
  expect(f.board.get(task.id)!.reviewer).toBe(review.reviewer);
  expect(f.board.get(task.id)!.owner).toBe("local");
  expect(f.notices.at(-1)).toContain("Reviewer reassignment suggestion");
});

test("sweep: an auto-reassign whose assignment cannot publish is noticed as saved-but-unconfirmed and the sweep goes on (#297)", async () => {
  const f = await fixture({ sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, unaccepted_min: 1, review_min: 1, ladder_min: 1, auto_reassign: true } });
  const first = f.make();
  // Its own path, or the overlap cohort silences the second task's sweep (turn-free coordination).
  const m2 = f.board.propose("user", { title: "other work", class: "implement", refs: { paths: ["b.ts"] } });
  const second = f.board.update(m2.id, HUB, "assigned", { owner: "codex", reviewer: "claude" });
  // 100 ms of slack: the two creation times can straddle a millisecond tick, and both ladders must align.
  const at = Math.max(first.history.at(-1)!.at, second.history.at(-1)!.at) + 60_100;
  for (let step = 0; step < 2; step++) { await f.tasks.sweep(at + step * 60_000); await drain(); }
  const publish = f.bus.publish.bind(f.bus);
  f.bus.publish = (env) => { if (env.kind === "task" && env.refs?.paths && env.refs?.task === String(first.id)) throw new Error("delivery journal unavailable"); return publish(env); };
  try {
    await f.tasks.sweep(at + 2 * 60_000); // first task's step 3: the assignment's write lands, the publish fails
  } finally {
    f.bus.publish = publish;
  }
  // Accept it for its new owner, or its restarted ladder keeps noticing local and a later reassignment in the same
  // pass reads the queue pressure.
  f.board.update(first.id, "local", "accepted", { state: "in_progress" });
  const recorded = await f.tasks.sweep(at + 3 * 60_000); // second task's step 3: delivers
  await drain();
  expect(recorded.map((x) => x.task)).toContain(second.id); // the sweep went on after the failure
  expect(f.board.get(first.id)!.owner).toBe("local"); // the failed one's write landed
  expect(f.board.get(second.id)!.owner).toBe("local"); // and the later one delivered
  expect(f.notices.filter((l) => l.includes("delivery is not confirmed"))).toHaveLength(1);
  expect(f.notices.some((l) => l.includes(`ahub task assign ${first.id} local`))).toBe(true);
  expect(f.peers.local!.got.filter((e) => e.kind === "task" && e.refs?.task === String(second.id))).toHaveLength(1);
});

test("planner idle sweep keeps its final attempt until owner capacity is available",async()=>{
 const f=await fixture({sweep:{...DEFAULT_TASK_SWEEP,enabled:true,unaccepted_min:1,idle_min:2,review_min:3,ladder_min:1,auto_reassign:true}});f.peers.local!.set("offline");f.peers.kimi!.set("offline");
 const task=await f.tasks.propose("user",{title:"planned idle",class:"implement",backlog:true});await f.tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await f.tasks.releaseReady();f.tasks.accept("codex",task.id);f.peers.local!.set("idle");
 const full=f.board.propose("user",{title:"occupied",class:"implement"});f.board.update(full.id,HUB,"assigned",{owner:"local",state:"in_progress"});f.peers.local!.set("busy");const at=f.board.get(task.id)!.history.at(-1)!.at+120000;
 await f.tasks.sweep(at);await f.tasks.sweep(at+60000);expect(await f.tasks.sweep(at+120000)).toEqual([]);expect(f.board.get(task.id)!.history.at(-1)?.sweep?.step).toBe(2);
 f.board.update(full.id,HUB,"finished",{state:"approved"});f.peers.local!.set("idle");await f.tasks.sweep(at+180000);expect(f.board.get(task.id)?.owner).toBe("local");
});


test("memory reference bookkeeping preserves sweep thresholds and ladder activity", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1000);
  cleanup.push(() => clock.mockRestore());
  for (const [state, minutes] of [["proposed", 1], ["in_progress", 2], ["in_review", 3]] as const) {
    clock.mockReturnValue(1000);
    const f = await fixture();
    const task = f.make(state), activity = task.history.length - 1;
    const due = 1000 + minutes * 60_000;
    clock.mockReturnValue(due - 1);
    f.board.update(task.id, HUB, "memory reference started", {});
    expect(await f.tasks.sweep(due)).toMatchObject([{ finding: { step: 1, activity } }]);
    clock.mockReturnValue(due + 59_999);
    f.board.update(task.id, HUB, "memory reference started", {});
    expect(await f.tasks.sweep(due + 60_000)).toMatchObject([{ finding: { step: 2, activity } }]);
    expect(await f.tasks.sweep(due + 120_000)).toMatchObject([{ finding: { step: 3, activity } }]);
    expect(await f.tasks.sweep(due + 180_000)).toEqual([]);
  }
});
