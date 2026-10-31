import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { validSourceId } from "../src/hub/sources.ts";
import { MIN_EVERY_MS, SOURCE_ID, parseCron, cronNext, cronMinGapMinutes, scheduleNext, scheduleWhen, schedulePeriodText, checkZone, parseEvery, scheduledDetail, ScheduleStore, scheduleKeyOf, schedulesConfig, scheduleViews, type ScheduleEntry } from "../src/hub/schedules.ts";
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

test("every and cron are exclusive, one is required, and the refusal names the entry", () => {
  expect(() => schedulesConfig([{ id: "c", cron: "0 * * * *", every: "1h", class: "plan", title: "t" }])).toThrow("schedules.c: give every or cron, not both");
  expect(() => schedulesConfig([{ id: "c", class: "plan", title: "t" }])).toThrow("schedules.c: every must be <n>m, <n>h or <n>d, or give cron (five fields)");
  expect(() => schedulesConfig([{ id: "c", every: "1h", tz: "UTC", class: "plan", title: "t" }])).toThrow("schedules.c: tz applies to cron only");
  expect(schedulesConfig([{ id: "c", cron: "  30  7 * *   1-5 ", tz: "asia/seoul", class: "plan", title: "t" }])[0]).toEqual({ id: "c", cron: "30 7 * * 1-5", tz: "Asia/Seoul", class: "plan", title: "t", queue: "backlog" });
  expect(schedulesConfig([{ id: "c", cron: "0 7 * * *", class: "plan", title: "t" }])[0]).toEqual({ id: "c", cron: "0 7 * * *", class: "plan", title: "t", queue: "backlog" });
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

test("the schedule source id form is the registry's: both accept and refuse the same ids", () => {
  for (const id of ["src:e5d53b3ad5222924", "src:0000000000000000", "src:E5D53B3AD5222924", "src:e5d53b3ad522292", "src:e5d53b3ad52229244", "e5d53b3ad5222924", "src:../../etc/pass", "", "src:e5d53b3ad5222924\n"]) {
    expect(SOURCE_ID.test(id), id).toBe(validSourceId(id));
  }
});

/** A fixture whose PII screen the test holds open: the screen is a model call in production, and that await is where a hold can begin. */
async function screened() {
  const screen: { entered: number; release?: () => void } = { entered: 0 };
  const hold = { on: false };
  const f = await fixture({
    sweepHeld: () => hold.on,
    routing: () => { const routing = loadRouting(join(tmpdir(), "no-such-routing-dir")); return { ...routing, signals: { ...routing.signals, pii_screen: "local" as const }, constraints: { ...routing.constraints, pii: "local_only" as const } }; },
    piiScreen: () => new Promise(resolve => { screen.entered++; screen.release = () => resolve({ label: "clear", ms: 0 }); }),
  });
  return { ...f, screen, hold };
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(condition()).toBe(true); };

test("a hold that begins while the PII screen is awaited stops the write: nothing is proposed, the tick counts as a skip, and the next one runs", async () => {
  const f = await screened(), e = entry({ id: "late" });
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const pass = f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  await until(() => f.screen.entered === 1); // admitted: not held, the screen is now pending
  f.hold.on = true; // recovery, shutdown or a storage error begins during the screen
  f.screen.release!();
  expect(await pass).toEqual([{ id: "late", outcome: "held" }]);
  expect(f.board.list()).toHaveLength(0);
  expect(f.store.get("late")).toMatchObject({ coalesced: 1, last_run: null, last_error: null });
  f.hold.on = false;
  const next = f.tasks.proposeFromSchedules(f.store, [e], T0 + 2 * HOUR);
  await until(() => f.screen.entered === 2);
  f.screen.release!();
  expect(await next).toMatchObject([{ id: "late", outcome: "ran" }]);
  expect(f.board.list()).toHaveLength(1);
  expect(f.store.get("late")!.coalesced).toBe(0);
});

test("the extra hold (the daemon's test seam) is fenced at the write too", async () => {
  const f = await screened(), e = entry({ id: "late" });
  let extra = false;
  await f.tasks.proposeFromSchedules(f.store, [e], T0, () => extra);
  const pass = f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR, () => extra);
  await until(() => f.screen.entered === 1);
  extra = true;
  f.screen.release!();
  expect(await pass).toEqual([{ id: "late", outcome: "held" }]);
  expect(f.board.list()).toHaveLength(0);
});

test("a hold that begins during the screen is not recorded as the schedule's error", async () => {
  const f = await screened(), e = entry({ id: "late" });
  await f.tasks.proposeFromSchedules(f.store, [e], T0);
  const pass = f.tasks.proposeFromSchedules(f.store, [e], T0 + HOUR);
  await until(() => f.screen.entered === 1);
  f.hold.on = true;
  f.screen.release!();
  await pass;
  expect(f.store.get("late")!.last_error).toBeNull();
});

test("an ordinary propose is not fenced by the schedules hold: only a scheduled run asks it", async () => {
  const f = await screened();
  f.hold.on = true;
  const made = f.tasks.propose("user", { title: "by a person", class: "plan", backlog: true });
  await until(() => f.screen.entered === 1);
  f.screen.release!();
  expect((await made).title).toBe("by a person");
});

// agent-hub #1017: calendar-anchored schedules. Every instant below is fixed; nothing reads the clock or the machine's zone.
const at = (iso: string) => Date.parse(iso);
const next = (expression: string, zone: string, after: string) => { const found = cronNext(parseCron(expression), zone, at(after)); return found === undefined ? undefined : new Date(found).toISOString(); };

test("cron is the five standard fields, with lists, ranges and steps, and nothing else", () => {
  expect(parseCron("*/15 0,12 1-5 */3 1-5/2")).toMatchObject({ minutes: [0, 15, 30, 45], hours: [0, 12], doms: [1, 2, 3, 4, 5], months: [1, 4, 7, 10], dows: [1, 3, 5] });
  expect(parseCron("0 0 * * 7").dows).toEqual([0]);   // 7 is Sunday
  for (const bad of ["", " ", "* * * *", "* * * * * *", "@daily", "@hourly", "61 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1/5 * * * *",
    "* * * MON *", "* * * jan *", "0 0 * * MON-FRI", "1,,2 * * * *", "1- * * * *", "? * * * *", "L * * * *", "0 0 1W * *", `${"1,".repeat(60)}1 * * * *`, 5, null, undefined, {}])
    expect(() => parseCron(bad as never), JSON.stringify(bad)).toThrow();
});

test("weekday-only: 07:30 on Monday to Friday, in the zone's own clock, never on a weekend", () => {
  // Thu 2026-10-29 09:00 KST: the next fire is Friday 07:30 KST (22:30Z the day before). Friday's has then fired, so Saturday and Sunday are skipped and Monday 2026-11-02 07:30 KST follows.
  expect(next("30 7 * * 1-5", "Asia/Seoul", "2026-10-29T00:00:00Z")).toBe("2026-10-29T22:30:00.000Z");
  expect(next("30 7 * * 1-5", "Asia/Seoul", "2026-10-29T22:30:00Z")).toBe("2026-11-01T22:30:00.000Z");   // strictly after: the instant itself is not the next fire
  expect(next("30 7 * * 1-5", "Asia/Seoul", "2026-10-30T00:00:00Z")).toBe("2026-11-01T22:30:00.000Z");   // Friday 09:00 KST: this week's has passed
  expect(next("30 7 * * 1-5", "Asia/Seoul", "2026-11-01T22:30:00Z")).toBe("2026-11-02T22:30:00.000Z");   // Monday's fired; Tuesday 07:30 KST
  // The same expression in another zone is another instant: 07:30 in New York.
  expect(next("30 7 * * 1-5", "America/New_York", "2026-10-30T12:00:00Z")).toBe("2026-11-02T12:30:00.000Z");
  // The zone's weekday is the one that counts: 23:30Z Sunday is already Monday in Seoul.
  expect(next("0 8 * * 1", "Asia/Seoul", "2026-11-01T14:00:00Z")).toBe("2026-11-01T23:00:00.000Z");
});

test("monthly: the first and fifteenth, a 31st that skips short months, and the day rule when both day fields are set", () => {
  expect(next("0 9 1,15 * *", "UTC", "2026-01-15T09:00:00Z")).toBe("2026-02-01T09:00:00.000Z");
  expect(next("0 0 31 * *", "UTC", "2026-04-01T00:00:00Z")).toBe("2026-05-31T00:00:00.000Z");   // April has no 31st
  expect(next("0 0 29 2 *", "UTC", "2026-01-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");   // a leap day waits for the leap year
  // Both day fields restricted: either matches (13th, or any Friday); a field that begins with * leaves the other to decide.
  expect(next("0 0 13 * 5", "UTC", "2026-11-01T00:00:00Z")).toBe("2026-11-06T00:00:00.000Z");
  expect(next("0 0 */2 * 1", "UTC", "2026-11-01T00:00:00Z")).toBe("2026-11-09T00:00:00.000Z");   // odd days AND Monday: Mon 2026-11-09 is the 9th
  expect(next("0 0 1 1 *", "UTC", "2026-01-01T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
});

test("daylight saving forward: a skipped local time runs at the next valid minute, once", () => {
  // New York, 2026-03-08: 02:00 became 03:00. 02:30 does not exist; the fire is the first valid minute, 03:00 EDT = 07:00Z.
  expect(next("30 2 * * *", "America/New_York", "2026-03-07T17:00:00Z")).toBe("2026-03-08T07:00:00.000Z");
  expect(next("30 2 * * *", "America/New_York", "2026-03-08T07:00:00Z")).toBe("2026-03-09T06:30:00.000Z");   // the day after it is 02:30 EDT again, once
  expect(next("0 3 * * *", "America/New_York", "2026-03-07T17:00:00Z")).toBe("2026-03-08T07:00:00.000Z");   // 03:00 itself exists and is the same instant: no second fire
  // Europe/London, 2026-03-29: 01:00 became 02:00; a 01:15 fire runs at 02:00 BST = 01:00Z.
  expect(next("15 1 * * *", "Europe/London", "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:00:00.000Z");
});

test("daylight saving backward: a repeated local time runs once, at its first occurrence", () => {
  // New York, 2026-11-01: 01:00 to 02:00 happened twice. 01:30 EDT (05:30Z) is the fire; 01:30 EST (06:30Z) is not.
  expect(next("30 1 * * *", "America/New_York", "2026-10-31T16:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
  expect(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z");
  expect(next("30 1 * * *", "America/New_York", "2026-11-01T06:00:00Z")).toBe("2026-11-02T06:30:00.000Z");   // inside the repeated hour, still one fire that day
  // An hourly expression across the repeat: wall hours 00 01 02 each fire once, so the repeated 01:00 EST is skipped.
  const hourly = [] as string[];
  for (let after = "2026-11-01T03:30:00Z", n = 0; n < 4; n++) { const found = next("0 * * * *", "America/New_York", after)!; hourly.push(found); after = found; }
  expect(hourly).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
  // A zone with no daylight saving never moves.
  expect(next("0 0 * * *", "Asia/Seoul", "2026-11-01T00:00:00Z")).toBe("2026-11-01T15:00:00.000Z");
});

test("an expression that can fire more often than every 15 minutes is refused with the entry named", () => {
  const gap = (expression: string) => cronMinGapMinutes(parseCron(expression));
  expect([gap("* * * * *"), gap("*/10 * * * *"), gap("*/15 * * * *"), gap("0 * * * *"), gap("0,10 7 * * *"), gap("0 7,8 * * *"), gap("0 7 * * 1-5"), gap("45 23 * * *"), gap("0 23,0 * * *")])
    .toEqual([1, 10, 15, 60, 10, 60, 1440, 1440, 60]);
  expect(gap("0 0 31 2 *")).toBeUndefined();
  for (const [cron, text] of [["* * * * *", "every 1 minute"], ["*/5 * * * *", "every 5 minutes"], ["0,10 7 * * *", "every 10 minutes"], ["0 0 31 2 *", "never fires"]] as const)
    expect(() => schedulesConfig([{ id: "fast", cron, class: "plan", title: "t" }]), cron).toThrow(`schedules.fast: cron can fire ${text.replace("every ", "every ")}`.replace("cron can fire never fires", "cron never fires"));
  expect(() => schedulesConfig([{ id: "ok", cron: "*/15 * * * *", class: "plan", title: "t" }])).not.toThrow();
});

test("tz is an IANA name this machine knows, normalized, and applies to cron only", () => {
  expect(checkZone("utc")).toBe("UTC");
  expect(checkZone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
  for (const bad of ["", "Mars/Base", "KST", "+09:00", "Asia/Seoul; rm", "../etc", " Asia/Seoul", 9, null]) expect(() => checkZone(bad as never), String(bad)).toThrow();
  expect(() => schedulesConfig([{ id: "z", cron: "0 7 * * *", tz: "Mars/Base", class: "plan", title: "t" }])).toThrow("schedules.z: tz is not a zone this machine knows");
});

test("scheduleNext: every is the anchor plus the period, cron is the next calendar fire after the anchor", () => {
  expect(scheduleNext({ every: "6h" }, at("2026-11-01T00:00:00Z"))).toBe(at("2026-11-01T06:00:00Z"));
  expect(scheduleNext({ cron: "30 7 * * 1-5", tz: "Asia/Seoul" }, at("2026-10-30T22:30:00Z"))).toBe(at("2026-11-01T22:30:00Z"));
  expect(scheduleNext({ cron: "0 0 31 2 *" as string, tz: "UTC" }, 0)).toBe(Number.MAX_SAFE_INTEGER);
});

test("a view of a cron schedule carries the expression and the zone, and its next run reads in that zone", () => {
  const e = entry({ id: "digest", every: undefined, cron: "30 7 * * 1-5", tz: "Asia/Seoul" });
  const [view] = scheduleViews([e], [], at("2026-10-30T00:00:00Z"), new Map(), false);
  expect(view).toMatchObject({ id: "digest", cron: "30 7 * * 1-5", zone: "Asia/Seoul", state: "scheduled", next: at("2026-11-01T22:30:00Z") });
  expect(view).not.toHaveProperty("every");
  expect(scheduleWhen(view!, view!.next)).toBe("2026-11-02 07:30 Asia/Seoul");
  expect(schedulePeriodText(view!)).toBe("cron 30 7 * * 1-5 (Asia/Seoul)");
  const [plain] = scheduleViews([entry()], [], at("2026-10-30T00:00:00Z"), new Map(), false);
  expect(plain).toMatchObject({ every: "1h" }); expect(plain).not.toHaveProperty("cron"); expect(plain).not.toHaveProperty("zone");
  expect(schedulePeriodText(plain!)).toBe("every 1h");
  expect(scheduleWhen({}, at("2026-10-30T22:30:00Z"))).toBe("2026-10-30 22:30 UTC");
  expect(scheduledDetail(e)).toContain('Scheduled on the calendar "30 7 * * 1-5" (Asia/Seoul)');
  expect(scheduledDetail(entry())).toContain("Scheduled every 1h");
});

test("a cron schedule never runs at first sight, runs at its fire time, and a long downtime is one run, not a burst", async () => {
  const f = await fixture(), e = entry({ id: "digest", every: undefined, cron: "30 7 * * 1-5", tz: "Asia/Seoul" });
  const first = at("2026-10-30T00:00:00Z");   // Fri 09:00 KST: today's 07:30 has passed
  expect(await f.tasks.proposeFromSchedules(f.store, [e], first)).toEqual([]);
  expect(f.store.get("digest")!.anchor).toBe(first);
  expect(await f.tasks.proposeFromSchedules(f.store, [e], at("2026-10-30T22:29:00Z"))).toEqual([]);   // Sat 07:29 KST, but Saturday is no weekday; the next fire is Monday
  expect(await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-01T22:29:00Z"))).toEqual([]);   // one minute before Monday 07:30 KST
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-01T22:30:00Z"));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: "digest", outcome: "ran" });
  expect(scheduleKeyOf(f.board.get(runs[0]!.task!)!.detail)).toBe("digest");
  expect(f.board.get(runs[0]!.task!)!.detail).toContain('"30 7 * * 1-5" (Asia/Seoul)');
  expect(f.store.get("digest")).toMatchObject({ anchor: at("2026-11-01T22:30:00Z"), last_run: at("2026-11-01T22:30:00Z"), coalesced: 0 });
  // The task closes; the hub was down for nine days. One pass is one run, and the period restarts at that pass: nothing missed is replayed.
  f.board.update(runs[0]!.task!, "user", "cancelled", { state: "cancelled" }, "closed");
  const late = await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-10T03:00:00Z"));
  expect(late.filter(run => run.outcome === "ran")).toHaveLength(1);
  expect(f.board.list().filter(task => scheduleKeyOf(task.detail) === "digest")).toHaveLength(2);
  expect(f.store.get("digest")!.anchor).toBe(at("2026-11-10T03:00:00Z"));
  expect(await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-10T03:30:00Z"))).toEqual([]);
  expect(scheduleNext(e, at("2026-11-10T03:00:00Z"))).toBe(at("2026-11-10T22:30:00Z"));   // Tue 07:30 KST
});

test("a cron schedule is held and coalesced like every: a hold counts the due tick and one run follows its release", async () => {
  let held = true;
  const f = await fixture({ sweepHeld: () => held }), e = entry({ id: "digest", every: undefined, cron: "0 9 * * *", tz: "UTC" });
  await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-01T00:00:00Z"));
  for (const day of ["2026-11-01T09:00:00Z", "2026-11-02T09:00:00Z", "2026-11-03T09:00:00Z"]) expect(await f.tasks.proposeFromSchedules(f.store, [e], at(day))).toEqual([{ id: "digest", outcome: "held" }]);
  expect(f.store.get("digest")).toMatchObject({ coalesced: 3, last_run: null });
  held = false;
  const runs = await f.tasks.proposeFromSchedules(f.store, [e], at("2026-11-04T09:00:00Z"));
  expect(runs.filter(run => run.outcome === "ran")).toHaveLength(1);
  expect(f.store.get("digest")!.coalesced).toBe(0);
});
