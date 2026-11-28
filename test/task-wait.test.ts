import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type TaskState } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { TASK_TOOLS, TASK_TOOL_NAMES, WAIT_TOOL, profileTaskTools } from "../src/hub/hub-tools.ts";
import { DEFAULT_TASK_SWEEP, TASK_WAIT_MAX_MS, nextSweep, taskWait } from "../src/hub/task-sweep.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { QuestionStore } from "../src/hub/questions.ts";

// #1454: a bounded wait on an in_progress task suspends the idle-owner ladder and the ladder restarts from `until`.
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
const MIN = 60_000, HOUR = 60 * MIN, T0 = Date.UTC(2026, 10, 14, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

async function fixture(overrides: Partial<TasksDeps> = {}, sweep: Partial<typeof DEFAULT_TASK_SWEEP> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-wait-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Board(join(dir, "hub.db"));
  cleanup.push(() => board.close());
  // Board stamps history with Date.now(); pin it so every time in these tests is exact.
  let clock = T0;
  const spy = spyOn(Date, "now").mockImplementation(() => clock);
  cleanup.push(() => spy.mockRestore());
  const bus = new Bus({ batchMs: 0 });
  const peers = Object.fromEntries(["codex", "claude", "kimi", "local"].map((id) => [id, new Peer(id)]));
  for (const peer of Object.values(peers)) { bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  const deps: TasksDeps = { board, bus, cwd: dir, project: "wait-test", routing: () => loadRouting(dir), notify: (line) => notices.push(line), roles: { claude: ["planner"] },
    sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, unaccepted_min: 1, idle_min: 120, review_min: 3, ladder_min: 30, ...sweep }, ...overrides };
  const tasks = new Tasks(deps);
  const at = (ms: number) => { clock = ms; };
  const make = (state: TaskState = "in_progress", signals: string[] = []) => {
    const made = board.propose("user", { title: signals.length ? "patient 900101-1234567" : "work", class: "implement", refs: { paths: ["a.ts"] }, signals });
    let task = board.update(made.id, HUB, "assigned", { owner: signals.length ? "local" : "codex", reviewer: "claude" });
    if (state !== "proposed") task = board.update(task.id, task.owner!, "accepted", { state: "in_progress" });
    if (state === "in_review") task = board.update(task.id, task.owner!, "done", { state: "in_review" });
    return task;
  };
  return { board, bus, peers, notices, tasks, make, deps, at };
}
const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(PreEffectToolRefusal); return (error as Error).message; }
  throw new Error("expected a refusal");
};

test("an owner's open question suspends idle-owner and settlement restarts the ladder", async () => {
  const f = await fixture({}, { idle_min: 1, ladder_min: 1 });
  const store = new QuestionStore(join(f.deps.cwd, "hub.db")); cleanup.push(() => store.close());
  f.deps.ownerQuestionWait = (id, peer) => store.ownerWait(id, peer);
  const task = f.make();
  f.at(T0 + MIN); expect(await f.tasks.sweep(T0 + MIN)).toMatchObject([{ task: task.id, finding: { step: 1 } }]);
  const asked = store.ask({ peer: "codex", session: "", task: task.id, private: false, questions: [{ id: "q", prompt: "Choose", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }, T0 + MIN + 1);
  if ("error" in asked) throw new Error(asked.error);
  f.at(T0 + 5 * MIN); expect(await f.tasks.sweep(T0 + 5 * MIN)).toEqual([]);
  const settled = T0 + 6 * MIN;
  expect(store.answer(asked.set, [{ questionId: "q", optionIds: ["a"] }], "console", settled, false).ok).toBe(true);
  f.at(settled + MIN - 1); expect(await f.tasks.sweep(settled + MIN - 1)).toEqual([]);
  f.at(settled + MIN); expect(await f.tasks.sweep(settled + MIN)).toMatchObject([{ task: task.id, finding: { kind: "idle-owner", step: 1 } }]);
  const proposed = f.make("proposed"), review = f.make("in_review");
  expect(nextSweep(proposed, f.deps.sweep!, settled + 10 * MIN, true, { open: true })).toMatchObject({ kind: "unaccepted-assignment" });
  expect(nextSweep(review, f.deps.sweep!, settled + 10 * MIN, true, { open: true })).toMatchObject({ kind: "review-pending" });
  const ready = f.board.propose("user", { title: "ready", class: "implement" });
  expect(nextSweep(ready, { ...f.deps.sweep!, ready_min: 1 }, settled + 10 * MIN, true, { open: true })).toMatchObject({ kind: "ready-unassigned" });
  expect(store.ownerWait(task.id, "kimi").open).toBe(false);
  const other = store.ask({ peer: "kimi", session: "", task: task.id, private: false, questions: asked.questions }, settled + 1);
  if ("error" in other) throw new Error(other.error);
  expect(store.ownerWait(task.id, "codex").open).toBe(false);
  expect(store.ownerWait(task.id + 100, "kimi").open).toBe(false);
  expect(store.settle(other.set, "expired", "expired", settled + 2)).toBeDefined();
  expect(store.ownerWait(task.id, "kimi")).toEqual({ open: false, settled: settled + 2 });
  const prunedAt = settled + 8 * 24 * HOUR;
  expect(store.prune(prunedAt, 7 * 24 * HOUR)).toBe(2);
  expect(store.ownerWait(task.id, "codex")).toEqual({ open: false });
  expect(nextSweep(f.board.get(task.id)!, f.deps.sweep!, prunedAt, true, store.ownerWait(task.id, "codex"))).toMatchObject({ kind: "idle-owner", step: 2 });
});

test("a pending wait gives no idle-owner finding at 2, 4 and 24 hours; step 1 fires idle_min after until and step 3 still reassigns", async () => {
  const f = await fixture({}, { auto_reassign: true });
  const task = f.make();
  const until = T0 + 20 * HOUR;
  await f.tasks.wait("codex", { id: task.id, until: iso(until), reason: "shadow wave runs until the 18th" });
  for (const hours of [2, 4, 19]) { f.at(T0 + hours * HOUR); expect(await f.tasks.sweep(T0 + hours * HOUR)).toEqual([]); }
  // The same task without the wait would have been found at 2 hours.
  const control = await fixture({}, { auto_reassign: true });
  const plain = control.make();
  expect(nextSweep(control.board.get(plain.id)!, control.deps.sweep!, T0 + 2 * HOUR)).toMatchObject({ kind: "idle-owner", step: 1 });
  // At until the wait is over, but the ladder restarts from until: nothing yet, then step 1 idle_min later.
  f.at(until); expect(await f.tasks.sweep(until)).toEqual([]);
  f.at(until + 120 * MIN - 1); expect(await f.tasks.sweep(until + 120 * MIN - 1)).toEqual([]);
  f.at(until + 120 * MIN); expect(await f.tasks.sweep(until + 120 * MIN)).toMatchObject([{ task: task.id, finding: { kind: "idle-owner", step: 1 } }]);
  await drain();
  f.at(until + 150 * MIN); expect(await f.tasks.sweep(until + 150 * MIN)).toMatchObject([{ finding: { step: 2 } }]);
  f.at(until + 180 * MIN); expect(await f.tasks.sweep(until + 180 * MIN)).toMatchObject([{ finding: { step: 3 } }]);
  await drain();
  expect(f.board.get(task.id)!.owner).not.toBe("codex");
  expect(f.board.get(task.id)!.history.some(h => h.event === "reassigned" && h.reason === "idle")).toBe(true);
});

test("an owner's own activity after a wait ends it: done, decline and a hub reassignment clear the wait", async () => {
  const f = await fixture();
  const done = f.make();
  await f.tasks.wait("codex", { id: done.id, until: iso(T0 + 5 * HOUR), reason: "waiting for the release window" });
  expect(taskWait(f.board.get(done.id)!)).toMatchObject({ until: T0 + 5 * HOUR, by: "codex", owner: "codex" });
  f.board.update(done.id, "codex", "done", { state: "in_review" });
  expect(taskWait(f.board.get(done.id)!)).toBeUndefined();
  f.board.update(done.id, "claude", "changes_requested", { state: "changes_requested" });
  f.board.update(done.id, "codex", "accepted", { state: "in_progress" });
  expect(taskWait(f.board.get(done.id)!)).toBeUndefined();

  const declined = f.make();
  await f.tasks.wait("codex", { id: declined.id, until: iso(T0 + 5 * HOUR), reason: "waiting for the release window" });
  await f.tasks.decline("codex", declined.id, "cannot run it");
  expect(taskWait(f.board.get(declined.id)!)).toBeUndefined();
  expect(f.board.get(declined.id)!.history.at(-1)!.event).not.toBe("wait recorded");

  const moved = f.make();
  await f.tasks.wait("codex", { id: moved.id, until: iso(T0 + 5 * HOUR), reason: "waiting for the release window" });
  f.board.update(moved.id, HUB, "reassigned", { owner: "kimi" });
  // Same state, new owner: the wait was recorded for codex and ends with its ownership.
  expect(taskWait(f.board.get(moved.id)!)).toBeUndefined();
  f.board.update(moved.id, HUB, "reassigned", { owner: "codex" });
  expect(taskWait(f.board.get(moved.id)!)).toBeUndefined();
});

test("isolated check results keep a wait until the task moves", async () => {
  const f = await fixture();
  for (const ending of ["done", "decline"] as const) {
    const task = f.make(), until = T0 + 5 * HOUR;
    await f.tasks.wait("codex", { id: task.id, until: iso(until), reason: "waiting for the release window" });
    for (const event of ["check run passed", "check run failed"]) {
      f.board.update(task.id, HUB, event, {});
      expect(taskWait(f.board.get(task.id)!)).toMatchObject({ until });
    }
    if (ending === "done") f.board.update(task.id, "codex", "done", { state: "in_review" });
    else await f.tasks.decline("codex", task.id, "cannot run it");
    expect(taskWait(f.board.get(task.id)!)).toBeUndefined();
  }
});

test("bookkeeping entries leave a wait in force; a sweep notice from another ladder does not end it", async () => {
  const f = await fixture();
  const task = f.make();
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + 5 * HOUR), reason: "waiting for the release window" });
  f.board.update(task.id, "claude", "reviewer changed", { reviewer: "kimi" });
  f.board.update(task.id, HUB, "idle sweep", {}, undefined, { sweep: { kind: "review-pending", activity: 0, step: 1, at: T0 } });
  expect(taskWait(f.board.get(task.id)!)).toMatchObject({ until: T0 + 5 * HOUR });
});

test("a wait never changes review-pending, unaccepted-assignment or ready-unassigned findings", async () => {
  const f = await fixture();
  const task = f.make();
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + 10 * HOUR), reason: "waiting for the release window" });
  f.board.update(task.id, "codex", "done", { state: "in_review" });
  f.at(T0 + 3 * MIN);
  expect(await f.tasks.sweep(T0 + 3 * MIN)).toMatchObject([{ task: task.id, finding: { kind: "review-pending", step: 1 } }]);

  // A proposed (unaccepted) task and an unowned ready one keep their own thresholds even when an old wait entry is in their history.
  const proposed = f.make("proposed");
  f.at(T0 + 3 * MIN + 1 * MIN);
  expect(nextSweep(f.board.get(proposed.id)!, f.deps.sweep!, T0 + 4 * MIN)).toMatchObject({ kind: "unaccepted-assignment", step: 1 });
  const ready = f.board.propose("user", { title: "unowned", class: "implement", refs: { paths: ["b.ts"] } });
  const createdAt = f.board.get(ready.id)!.created;
  expect(nextSweep(f.board.get(ready.id)!, { ...f.deps.sweep!, ready_min: 60 }, createdAt + 60 * MIN - 1)).toBeUndefined();
  expect(nextSweep(f.board.get(ready.id)!, { ...f.deps.sweep!, ready_min: 60 }, createdAt + 60 * MIN)).toMatchObject({ kind: "ready-unassigned", step: 1 });
});

test("refusals name the cause and the next step: past until, beyond the cap, wrong caller, wrong state, missing reason", async () => {
  const f = await fixture();
  const task = f.make();
  const call = (by: string, input: Record<string, unknown>) => f.tasks.wait(by, { id: task.id, until: iso(T0 + 2 * HOUR), reason: "waiting for the release window", ...input });
  const past = await refusal(call("codex", { until: iso(T0 - HOUR) }));
  expect(past).toContain("not in the future"); expect(past).toContain("name a later time");
  const exactlyNow = await refusal(call("codex", { until: iso(T0) }));
  expect(exactlyNow).toContain("not in the future");
  const far = await refusal(call("codex", { until: iso(T0 + TASK_WAIT_MAX_MS + 1) }));
  expect(far).toContain("more than 14 days"); expect(far).toContain("record the wait again");
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + TASK_WAIT_MAX_MS), reason: "exactly at the cap is allowed" });
  const stranger = await refusal(call("kimi", {}));
  expect(stranger).toContain("only its owner (codex), its planner or the console user"); expect(stranger).toContain("hub_send the planner");
  const state = await refusal(f.tasks.wait("codex", { id: f.make("proposed").id, until: iso(T0 + HOUR), reason: "waiting for the release window" }));
  expect(state).toContain("is proposed"); expect(state).toContain("hub_task_accept");
  const review = f.make("in_review");
  expect(await refusal(f.tasks.wait("codex", { id: review.id, until: iso(T0 + HOUR), reason: "waiting" }))).toContain("only to in_progress work");
  expect(await refusal(call("codex", { until: "tomorrow" }))).toContain("absolute time with a zone");
  expect(await refusal(call("codex", { until: "2026-11-14T10:00:00" }))).toContain("absolute time with a zone");
  expect(await refusal(call("codex", { reason: "  " }))).toContain("short public sentence");
  expect(await refusal(call("codex", { reason: "x".repeat(201) }))).toContain("at most 200 characters");
  expect(await refusal(call("codex", { reason: "two\nlines" }))).toContain("one line");
  expect(await refusal(f.tasks.wait("codex", { id: 9999, until: iso(T0 + HOUR), reason: "waiting" }))).toContain("no task #9999");
  // A refused call wrote nothing beyond the one accepted wait.
  expect(f.board.get(task.id)!.history.filter(h => h.event === "wait recorded")).toHaveLength(1);
});

test("the task's planner and the person may record a wait; a planner who is not its planner may not", async () => {
  const f = await fixture();
  const task = f.make();
  await f.tasks.wait("claude", { id: task.id, until: iso(T0 + 3 * HOUR), reason: "planner: waiting on the release window" });
  expect(f.board.get(task.id)!.history.at(-1)).toMatchObject({ event: "wait recorded", by: "claude", wait: { until: T0 + 3 * HOUR, owner: "codex" } });
  await f.tasks.wait("user", { id: task.id, until: iso(T0 + 4 * HOUR), reason: "person: waiting on the live leg" });
  expect(taskWait(f.board.get(task.id)!)).toMatchObject({ until: T0 + 4 * HOUR, by: "user" });
  const other = await fixture({ roles: { claude: ["planner"], kimi: ["planner"] } });
  const mine = other.make();
  other.board.update(mine.id, HUB, "planner changed", { planner: "claude" });
  expect(await refusal(other.tasks.wait("kimi", { id: mine.id, until: iso(T0 + HOUR), reason: "waiting" }))).toContain("only its owner");
});

test("the reason goes through the privacy screen: an ordinary task refuses withheld text, a PII task keeps it withheld", async () => {
  const f = await fixture();
  const task = f.make();
  const secret = await refusal(f.tasks.wait("codex", { id: task.id, until: iso(T0 + HOUR), reason: "token sk-abcdefghijklmnopqrstuvwxyz0123456789 is rotated then" }));
  expect(secret).toContain("withheld by the privacy screen"); expect(secret).toContain("restate it");
  expect(f.board.get(task.id)!.history.some(h => h.event === "wait recorded")).toBe(false);

  const pii = f.make("in_progress", ["pii"]);
  const waited = await f.tasks.wait("local", { id: pii.id, until: iso(T0 + HOUR), reason: "patient 900101-1234567 follow-up" });
  expect(waited.history.at(-1)).toMatchObject({ event: "wait recorded", withheld: true });
  const view = JSON.stringify(f.tasks.publicView(f.board.get(pii.id)!));
  expect(view).not.toContain("900101");
  expect(f.notices.join("\n")).not.toContain("900101");
});

test("the wait is visible in the public view, with whether it has passed", async () => {
  const f = await fixture();
  const task = f.make();
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + 2 * HOUR), reason: "waiting for the release window" });
  const view = f.tasks.publicView(f.board.get(task.id)!) as { wait?: Record<string, unknown>; history: { event: string; wait?: unknown }[] };
  expect(view.wait).toMatchObject({ until: T0 + 2 * HOUR, by: "codex", passed: false, reason: "waiting for the release window" });
  expect(view.history.at(-1)).toMatchObject({ event: "wait recorded", wait: { until: T0 + 2 * HOUR, owner: "codex" } });
  f.at(T0 + 3 * HOUR);
  expect((f.tasks.publicView(f.board.get(task.id)!) as { wait: { passed: boolean } }).wait.passed).toBe(true);
  f.board.update(task.id, "codex", "done", { state: "in_review" });
  expect((f.tasks.publicView(f.board.get(task.id)!) as { wait?: unknown }).wait).toBeUndefined();
});

test("the planner groom view lists a task whose wait has passed, and only then", async () => {
  const f = await fixture({ roles: { claude: ["planner"] } });
  const task = f.make();
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + 2 * HOUR), reason: "waiting for the release window" });
  const items = async () => ((await f.tasks.groomingDigest("claude")).items as { kind: string; task: number }[]).filter(item => item.kind === "wait-passed");
  expect(await items()).toEqual([]);
  f.at(T0 + 2 * HOUR); expect(await items()).toEqual([{ kind: "wait-passed", task: task.id }]);
  f.board.update(task.id, "codex", "done", { state: "in_review" });
  expect(await items()).toEqual([]);
});

test("sweep off: no wait is accepted, the tool is not published and the tool lists are unchanged", async () => {
  const f = await fixture({ sweep: DEFAULT_TASK_SWEEP });
  const task = f.make();
  const off = await refusal(f.tasks.wait("codex", { id: task.id, until: iso(T0 + HOUR), reason: "waiting for the release window" }));
  expect(off).toContain("task_sweep is off"); expect(off).toContain("task_sweep.enabled");
  expect(f.board.get(task.id)!.history.some(h => h.event === "wait recorded")).toBe(false);
  // Publication: the default list is the very same array, and the tool appears only when asked for.
  expect(profileTaskTools()).toBe(TASK_TOOLS);
  expect(TASK_TOOLS.map(tool => tool.name)).not.toContain("hub_task_wait");
  expect(profileTaskTools("dev", undefined, false, false, false, true).map(tool => tool.name)).toContain("hub_task_wait");
  expect(profileTaskTools("dev", undefined, true, false, false, false).map(tool => tool.name)).not.toContain("hub_task_wait");
  expect(TASK_TOOL_NAMES.has(WAIT_TOOL.name)).toBe(true);
  expect(WAIT_TOOL.inputSchema.required).toEqual(["id", "until", "reason"]);
});

test("a wait only suspends idle-owner on its own task: an expired wait for a previous owner does not", async () => {
  const f = await fixture();
  const task = f.make();
  await f.tasks.wait("codex", { id: task.id, until: iso(T0 + 20 * HOUR), reason: "waiting for the release window" });
  f.board.update(task.id, HUB, "reassigned", { owner: "kimi" });
  f.board.update(task.id, "kimi", "accepted", { state: "in_progress" });
  f.at(T0 + 3 * HOUR);
  expect(await f.tasks.sweep(T0 + 3 * HOUR)).toMatchObject([{ task: task.id, finding: { kind: "idle-owner", step: 1 } }]);
});
