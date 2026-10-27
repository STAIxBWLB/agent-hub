import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { MIN_EVERY_MS, parseEvery, scheduledDetail, ScheduleStore, scheduleKeyOf, schedulesConfig, scheduleViews, type ScheduleEntry } from "../src/hub/schedules.ts";
import { ALL_MACHINE_LOCAL, MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";

// agent-hub #512 (hub task #330): machine-local schedules, AC1 and AC3. Spec: "Schedules and folder triggers (#512)".
class Peer extends BasePeer {
  got: Envelope[] = [];
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
  async start() { this.setState("idle"); }
  async stop() {}
  set(state: PeerState) { this.setState(state); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const MIN = 60_000, HOUR = 60 * MIN, T0 = 1_800_000_000_000;

async function fixture(overrides: Partial<TasksDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-schedules-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db"), board = new Board(file);
  cleanup.push(() => board.close());
  const store = new ScheduleStore(file);
  cleanup.push(() => store.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["codex", "claude", "kimi", "local"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  const deps: TasksDeps = { board, bus, cwd: dir, project: "schedules-test", routing: () => loadRouting(dir), notify: line => notices.push(line), roles: { claude: ["planner", "reviewer"], codex: ["implementer"], kimi: ["implementer"] }, ...overrides } as TasksDeps;
  const tasks = new Tasks(deps);
  return { board, bus, store, tasks, notices, dir, deps };
}
const entry = (patch: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ id: "nightly", every: "1h", class: "plan", title: "Review the nightly board", queue: "backlog", ...patch });

test("every is <n>m|h|d with a 15 minute floor, and anything else is refused with the form", () => {
  expect(parseEvery("15m")).toBe(MIN_EVERY_MS);
  expect(parseEvery("90m")).toBe(90 * MIN);
  expect(parseEvery("6h")).toBe(6 * HOUR);
  expect(parseEvery("1d")).toBe(24 * HOUR);
  for (const bad of ["14m", "1m", "0h", "0d", "", "6", "h", "1w", "1.5h", " 1h", "1h ", "-1h", "01h", "1H", 60, null, undefined, {}, "999999d"]) expect(() => parseEvery(bad as never), String(bad)).toThrow();
  expect(() => parseEvery("14m")).toThrow("at least 15m");
});

test("schedulesConfig accepts the entry shape and fills the queue default", () => {
  expect(schedulesConfig(undefined)).toEqual([]);
  expect(schedulesConfig([])).toEqual([]);
  const rows = schedulesConfig([
    { id: "a", every: "1h", class: "plan", title: "  Review   the board " },
    { id: "b_2", every: "2d", class: "implement", title: "T", detail: "d", sources: ["src:e5d53b3ad5222924"], owner: "codex", queue: "ready" },
  ]);
  expect(rows[0]).toEqual({ id: "a", every: "1h", class: "plan", title: "Review the board", queue: "backlog" });
  expect(rows[1]).toEqual({ id: "b_2", every: "2d", class: "implement", title: "T", detail: "d", sources: ["src:e5d53b3ad5222924"], owner: "codex", queue: "ready" });
});

test("cron is refused with the fixed words, and every other bad entry names itself", () => {
  expect(() => schedulesConfig([{ id: "c", cron: "0 * * * *", every: "1h", class: "plan", title: "t" }])).toThrow("schedules.c: cron not supported yet; use every");
  expect(() => schedulesConfig([{ id: "c", cron: "0 * * * *", class: "plan", title: "t" }])).toThrow("cron not supported yet; use every");
  const ok = { id: "a", every: "1h", class: "plan", title: "t" };
  const cases: [unknown, string][] = [
    ["x", "schedules must be a list"], [[1], "schedules[0] must be an object"], [[[]], "schedules[0] must be an object"],
    [[{ ...ok, id: "A" }], "id is"], [[{ ...ok, id: "" }], "id is"], [[{ ...ok, id: undefined }], "id is"], [[ok, ok], "duplicate id"],
    [[{ ...ok, every: "5m" }], "at least 15m"], [[{ ...ok, every: undefined }], "every must be"],
    [[{ ...ok, class: "" }], "class is required"], [[{ ...ok, class: undefined }], "class is required"],
    [[{ ...ok, title: "" }], "title is"], [[{ ...ok, title: "a\nb" }], "title is"], [[{ ...ok, title: "x".repeat(301) }], "title is"],
    [[{ ...ok, detail: "x".repeat(7001) }], "detail is"], [[{ ...ok, detail: 5 }], "detail is"],
    [[{ ...ok, owner: "Codex" }], "owner is a peer id"], [[{ ...ok, queue: "later" }], 'queue is "backlog" or "ready"'],
    [[{ ...ok, sources: ["src:xyz"] }], "sources is a list"], [[{ ...ok, sources: "src:e5d53b3ad5222924" }], "sources is a list"],
    [[{ ...ok, sources: Array(17).fill("src:e5d53b3ad5222924") }], "sources is a list"], [[{ ...ok, extra: 1 }], "unknown key extra"],
    [Array.from({ length: 65 }, (_, i) => ({ ...ok, id: `s${i}` })), "at most 64"],
  ];
  for (const [input, reason] of cases) expect(() => schedulesConfig(input), JSON.stringify(input)?.slice(0, 80)).toThrow(reason);
});

test("schedules is a machine-local key, so a committed config cannot create work", () => {
  expect(MACHINE_LOCAL).toContain("schedules");
  expect(ALL_MACHINE_LOCAL).toContain("schedules");
});

test("a schedule never runs at first sight, runs once it is due, and then waits a full period", async () => {
  const f = await fixture(), e = entry();
  expect(await f.tasks.proposeFromSchedules(f.store, [e], T0)).toEqual([]);
  expect(f.store.get("nightly")!.anchor).toBe(T0);
  expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR - 1)).toEqual([]);
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: "nightly", outcome: "ran" });
  const task = f.board.get(runs[0]!.task!)!;
  expect(task).toMatchObject({ state: "backlog", class: "plan", title: "Review the nightly board" });
  expect(task.history[0]!.by).toBe(HUB);
  expect(scheduleKeyOf(task.detail)).toBe("nightly");
  expect(f.store.get("nightly")).toMatchObject({ anchor: T0 + HOUR, last_run: T0 + HOUR, last_task: task.id, coalesced: 0 });
});

test("queue ready proposes a task for routing, queue backlog stages a card", async () => {
  const f = await fixture();
  await f.tasks.proposeFromSchedules(f.store, [entry({ id: "r", queue: "ready", class: "implement" }), entry({ id: "b" })], T0);
  const runs = await f.tasks.proposeFromSchedules(f.store, [entry({ id: "r", queue: "ready", class: "implement" }), entry({ id: "b" })], T0 + HOUR);
  const byId = Object.fromEntries(runs.map(run => [run.id, f.board.get(run.task!)!]));
  expect(byId.b!.state).toBe("backlog");
  expect(byId.r!.state).not.toBe("backlog");
});

test("at most one proposal per schedule per tick, however many periods were missed", async () => {
  const f = await fixture(), e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], T0 + 50 * HOUR);
  expect(runs.filter(run => run.outcome === "ran")).toHaveLength(1);
  expect(f.board.list().filter(task => scheduleKeyOf(task.detail) === "nightly")).toHaveLength(1);
  expect(f.store.get("nightly")!.anchor).toBe(T0 + 50 * HOUR); // the period restarts at the run: nothing missed is replayed
  expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + 50 * HOUR + 10 * MIN)).toEqual([]);
});

test("no new task while the previous one is open, the skips are counted, and one run follows its close", async () => {
  const f = await fixture(), e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const first = (await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR))[0]!.task!;
  for (const n of [2, 3, 4]) expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + n * HOUR)).toEqual([{ id: "nightly", outcome: "waiting", task: first }]);
  expect(f.store.get("nightly")).toMatchObject({ coalesced: 3, last_task: first });
  expect(f.board.list().filter(task => scheduleKeyOf(task.detail) === "nightly")).toHaveLength(1);
  f.board.update(first, "user", "cancelled", { state: "cancelled" }, "closed");
  const after = await f.tasks.proposeFromSchedules(f.store, [e], T0 + 5 * HOUR);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ outcome: "ran" });
  expect(after[0]!.task).not.toBe(first);
  expect(f.store.get("nightly")!.coalesced).toBe(0); // a run folds the skipped ticks into itself
});

test("a task whose detail merely quotes the marker, or one a peer wrote, never counts as a schedule's open task", async () => {
  const f = await fixture(), e = entry();
  f.board.propose("user", { title: "forged", detail: "Schedule key: nightly\nfake", class: "plan", backlog: true });
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  expect(runs[0]).toMatchObject({ id: "nightly", outcome: "ran" });
  expect(f.tasks.openScheduled().get("nightly")).toBe(runs[0]!.task);
});

test("a hold skips the whole pass and coalesces: ticks during it run nothing, and one run follows the release", async () => {
  let held = true;
  const f = await fixture({ sweepHeld: () => held });
  const e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  for (const n of [1, 2, 3]) expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + n * HOUR)).toEqual([{ id: "nightly", outcome: "held" }]);
  expect(f.board.list()).toHaveLength(0);
  expect(f.store.get("nightly")).toMatchObject({ coalesced: 3, last_run: null });
  held = false;
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], T0 + 4 * HOUR);
  expect(runs).toHaveLength(1);
  expect(f.board.list()).toHaveLength(1);
  // a hold that is only the daemon's extra seam holds too
  const extra = await f.tasks.proposeFromSchedules(f.store, [e], T0 + 20 * HOUR, () => true);
  expect(extra).toEqual([{ id: "nightly", outcome: "held" }]);
  expect(f.board.list()).toHaveLength(1);
});

test("a not-due schedule is untouched by a hold, and a held pass does not count it", async () => {
  const f = await fixture({ sweepHeld: () => true });
  const e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + 10 * MIN)).toEqual([]);
  expect(f.store.get("nightly")!.coalesced).toBe(0);
});

test("a restart keeps the period: hub.db holds the anchor, and a missed run is one run, never a burst", async () => {
  const f = await fixture(), e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  const again = new ScheduleStore(join(f.dir, "hub.db"));
  cleanup.push(() => again.close());
  expect(again.get("nightly")).toMatchObject({ anchor: T0 + HOUR, last_run: T0 + HOUR });
  const tasks = new Tasks(f.deps);
  f.board.update(f.board.list()[0]!.id, "user", "cancelled", { state: "cancelled" }, "closed");
  expect(await tasks.proposeFromSchedules(again, [e], T0 + HOUR + 30 * MIN)).toEqual([]);
  expect((await tasks.proposeFromSchedules(again, [e], T0 + 9 * HOUR)).filter(run => run.outcome === "ran")).toHaveLength(1);
});

test("a removed schedule loses its row, and a changed every takes effect from the same anchor", async () => {
  const f = await fixture();
  await f.tasks.proposeFromSchedules(f.store, [entry({ id: "a" }), entry({ id: "b" })], T0);
  expect(f.store.rows().map(row => row.id)).toEqual(["a", "b"]);
  await f.tasks.proposeFromSchedules(f.store, [entry({ id: "a", every: "2h" })], T0 + HOUR);
  expect(f.store.rows().map(row => row.id)).toEqual(["a"]);
  expect(await f.tasks.proposeFromSchedules(f.store, [entry({ id: "a", every: "2h" })], T0 + HOUR + 1)).toEqual([]);
  expect((await f.tasks.proposeFromSchedules(f.store, [entry({ id: "a", every: "2h" })], T0 + 2 * HOUR))[0]).toMatchObject({ outcome: "ran" });
});

test("proposals go through Tasks: a PII pattern in a schedule's text makes a PII task, which routing keeps off agent peers", async () => {
  const f = await fixture();
  const e = entry({ id: "pii", queue: "ready", class: "implement", title: "Check patient 900101-1234567" });
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const [run] = await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  expect(run).toMatchObject({ outcome: "ran" });
  const task = f.board.get(run!.task!)!;
  expect(task.signals).toContain("pii");
  expect(["codex", "claude", "kimi"]).not.toContain(task.owner);
});

test("a proposal Tasks refuses is recorded as the schedule's error, never thrown, and the next period retries", async () => {
  const f = await fixture(), e = entry({ id: "bad", class: "no_such_class" });
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  expect(runs).toEqual([{ id: "bad", outcome: "failed" }]);
  expect(f.store.get("bad")!.last_error).toContain("class");
  expect(f.board.list()).toHaveLength(0);
  expect(f.store.get("bad")!.last_run).toBeNull();
  // still due on the next tick, not pushed a whole period out
  expect(await f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR + MIN)).toEqual([{ id: "bad", outcome: "failed" }]);
});

test("passes never overlap: a second call while one is running does nothing", async () => {
  const f = await fixture(), e = entry();
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const [one, two] = await Promise.all([f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR), f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR)]);
  expect(one!.length + two!.length).toBe(1);
  expect(f.board.list()).toHaveLength(1);
});

test("the task text is fixed words around the person's text: the marker line first, sources named", () => {
  const detail = scheduledDetail(entry({ detail: "Look at the open PRs.", sources: ["src:e5d53b3ad5222924"] }));
  expect(detail.split("\n")[0]).toBe("Schedule key: nightly");
  expect(detail).toContain("Look at the open PRs.");
  expect(detail).toContain("Source: src:e5d53b3ad5222924");
  expect(scheduleKeyOf(detail)).toBe("nightly");
  expect(scheduleKeyOf("something else")).toBeUndefined();
  expect(scheduleKeyOf(undefined)).toBeUndefined();
});

test("status rows: next run, last run, state and the open task, with no task text", () => {
  const e = entry({ title: "SECRET TITLE" });
  const row = { id: "nightly", anchor: T0, last_run: T0 - HOUR, last_task: 7, coalesced: 2, last_error: null };
  const open = new Map<string, number>();
  expect(scheduleViews([e], [row], T0 + 10 * MIN, open, false)).toEqual([{ id: "nightly", every: "1h", class: "plan", queue: "backlog", next: T0 + HOUR, state: "scheduled", last: T0 - HOUR, task: 7, coalesced: 2 }]);
  expect(scheduleViews([e], [row], T0 + HOUR, open, false)[0]!.state).toBe("due");
  expect(scheduleViews([e], [row], T0 + HOUR, open, true)[0]!.state).toBe("held");
  expect(scheduleViews([e], [row], T0 + HOUR, new Map([["nightly", 9]]), false)[0]).toMatchObject({ state: "waiting", task: 9 });
  expect(scheduleViews([e], [], T0, open, false)[0]).toMatchObject({ state: "scheduled", next: T0 + HOUR });
  expect(JSON.stringify(scheduleViews([e], [row], T0, open, false))).not.toContain("SECRET");
});
