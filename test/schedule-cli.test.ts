import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Database } from "bun:sqlite";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { scheduleKeyOf, scheduleViews, ScheduleStore } from "../src/hub/schedules.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { renderScheduleChange, renderScheduleList, renderScheduleRun } from "../src/cli/schedule-output.ts";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";
import { HELP, helpCommands, renderHelp } from "../src/cli/help.ts";

// agent-hub #512 AC3 (UI) and AC4 (hub task #335): `ahub schedule list|run|pause|resume`, person-only, and each schedule's next run on the dashboard.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await condition(), label).toBe(true);
};
const HOUR = 3_600_000, T0 = 1_800_000_000_000;
const SHARED = {
  batch_ms: 0, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false }, roles: { codex: ["implementer"] },
  memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, research: { enabled: false },
  snapshots: { enabled: false }, approvals: { notify: false }, pi: { enabled: false, auto_start: false }, coordination: "advisory",
  task_sweep: { enabled: false, interval_s: 3600 },
};
const SCHEDULES = [{ id: "nightly", every: "1h", class: "plan", title: "Review the nightly board" }, { id: "weekly", every: "24h", class: "plan", title: "Weekly cleanup", queue: "ready" }];

function project(local: Record<string, unknown> = { schedules: SCHEDULES }, screen = false) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-schedule-cli-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify(SHARED));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(dir, ".agenthub/routing.toml"), screen ? routing.replace(/^pii_screen = "off"/m, 'pii_screen = "local"') : routing);
  writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(local));
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "baseline");
  return { dir, state };
}
async function start(clock: { now: number }, extra: Record<string, unknown> = {}, local?: Record<string, unknown>, screen = false) {
  const p = project(local, screen);
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => clock.now, schedulesEveryMs: 15, ...extra });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(p.state, { role: "console" }); cleanup.push(() => person.close());
  const agent = await ControlClient.connect(p.state, { role: "tools", peer: "codex" }); cleanup.push(() => agent.close());
  const op = async (client: ControlClient, name: string, args: Record<string, unknown> = {}) => client.request({ t: "task", op: name, args });
  const db = new Database(join(p.state, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const tasks = () => (db.query("SELECT id, title, detail, class, state FROM tasks ORDER BY id").all() as { id: number; title: string; detail: string; class: string; state: string }[]).filter(task => scheduleKeyOf(task.detail) !== undefined);
  const row = (id: string) => db.query("SELECT * FROM schedule_runs WHERE id = ?").get(id) as { anchor: number; last_run: number | null; coalesced: number; paused: number } | null;
  if (local === undefined || "schedules" in local) await until(() => row("nightly") !== null && row("weekly") !== null, "the timer recorded both anchors");
  const dbRow = (id: string) => { const d = new Database(join(p.state, "hub.db"), { readonly: true }); try { return d.query("SELECT * FROM schedule_runs WHERE id = ?").get(id) as { last_run: number | null } | null; } finally { d.close(); } };
  return { daemon, person, agent, op, tasks, row, dbRow, dir: p.dir };
}
const list = async (h: Awaited<ReturnType<typeof start>>) => JSON.parse((await h.op(h.person, "schedule_list")).text) as any[];

test("list shows each schedule's next run and never a title or detail", async () => {
  const clock = { now: T0 }, h = await start(clock);
  const rows = await list(h);
  expect(rows.map(row => row.id)).toEqual(["nightly", "weekly"]);
  expect(rows[0]).toMatchObject({ every: "1h", class: "plan", queue: "backlog", state: "scheduled", next: T0 + HOUR });
  expect(rows[1]).toMatchObject({ every: "24h", queue: "ready", state: "scheduled", next: T0 + 24 * HOUR });
  expect(JSON.stringify(rows)).not.toContain("nightly board");
  expect(JSON.stringify(rows)).not.toContain("Weekly cleanup");
});

test("run proposes one task now through the timer's path and restarts that schedule's period", async () => {
  const clock = { now: T0 }, h = await start(clock);
  expect(h.tasks()).toHaveLength(0);
  const ran = await h.op(h.person, "schedule_run", { id: "nightly" });
  expect(ran.ok, String(ran.error)).toBe(true);
  const result = JSON.parse(ran.text);
  expect(result).toMatchObject({ id: "nightly", outcome: "ran" });
  expect(h.tasks()).toHaveLength(1);
  expect(h.tasks()[0]).toMatchObject({ id: result.task, title: "Review the nightly board", state: "backlog", class: "plan" });
  expect(h.row("nightly")).toMatchObject({ last_run: T0, anchor: T0 });
  expect((await list(h))[0]).toMatchObject({ last: T0, task: result.task, next: T0 + HOUR, state: "scheduled" });
  expect(h.row("weekly")!.last_run).toBeNull(); // the other schedule is untouched
});

test("a second run while the first task is open is refused as waiting and writes nothing, and a manual refusal is not a skipped tick", async () => {
  const clock = { now: T0 }, h = await start(clock);
  const first = JSON.parse((await h.op(h.person, "schedule_run", { id: "nightly" })).text);
  const second = JSON.parse((await h.op(h.person, "schedule_run", { id: "nightly" })).text);
  expect(second).toEqual({ id: "nightly", outcome: "waiting", task: first.task });
  expect(h.tasks()).toHaveLength(1);
  expect(h.row("nightly")!.coalesced).toBe(0);
});

test("run refuses while the hub is held and writes nothing", async () => {
  const clock = { now: T0 };
  let held = false;
  const h = await start(clock, { schedulesHeld: () => held });
  held = true;
  expect(JSON.parse((await h.op(h.person, "schedule_run", { id: "nightly" })).text)).toEqual({ id: "nightly", outcome: "held" });
  expect(h.tasks()).toHaveLength(0);
  expect(h.row("nightly")!.coalesced).toBe(0);
  held = false;
  expect(JSON.parse((await h.op(h.person, "schedule_run", { id: "nightly" })).text).outcome).toBe("ran");
});

test("pause stops the timer proposing it without counting a skip, and resume starts a fresh period instead of replaying the pause", async () => {
  const clock = { now: T0 }, h = await start(clock);
  const paused = await h.op(h.person, "schedule_pause", { id: "nightly" });
  expect(paused.ok, String(paused.error)).toBe(true);
  expect(JSON.parse(paused.text)).toEqual([expect.objectContaining({ id: "nightly", state: "paused", next: T0 + HOUR })]);
  expect(h.row("nightly")!.paused).toBe(1);
  clock.now = T0 + 5 * HOUR; // five periods pass while it is paused; the other schedule is not due yet
  await Bun.sleep(150);
  expect(h.tasks()).toHaveLength(0);
  expect(h.row("nightly")!.coalesced).toBe(0);
  expect((await list(h)).find(row => row.id === "nightly")).toMatchObject({ state: "paused" });
  const resumed = JSON.parse((await h.op(h.person, "schedule_resume", { id: "nightly" })).text);
  expect(resumed).toEqual([expect.objectContaining({ id: "nightly", state: "scheduled", next: T0 + 6 * HOUR })]);
  expect(h.row("nightly")).toMatchObject({ paused: 0, anchor: T0 + 5 * HOUR });
  await Bun.sleep(150);
  expect(h.tasks(), "a pause is never replayed as a run on resume").toHaveLength(0);
  clock.now = T0 + 6 * HOUR;
  await until(() => h.tasks().length === 1, "the next period runs once");
});

test("a paused schedule still runs when the person says so, and the period restarts", async () => {
  const clock = { now: T0 }, h = await start(clock);
  await h.op(h.person, "schedule_pause", { id: "nightly" });
  const ran = JSON.parse((await h.op(h.person, "schedule_run", { id: "nightly" })).text);
  expect(ran.outcome).toBe("ran");
  expect(h.tasks()).toHaveLength(1);
  expect((await list(h)).find(row => row.id === "nightly")).toMatchObject({ state: "paused", last: T0 });
});

test("pause survives a restart", async () => {
  const clock = { now: T0 }, h = await start(clock);
  await h.op(h.person, "schedule_pause", { id: "nightly" });
  const db = new Database(join(h.dir, ".agenthub/state/hub.db"), { readonly: true });
  try { expect((db.query("SELECT paused FROM schedule_runs WHERE id = 'nightly'").get() as { paused: number }).paused).toBe(1); } finally { db.close(); }
  await h.daemon.stop();
  const again = await startDaemon({ cwd: h.dir, stateDir: join(h.dir, ".agenthub/state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => clock.now, schedulesEveryMs: 15 });
  cleanup.push(() => again.stop());
  const client = await ControlClient.connect(join(h.dir, ".agenthub/state"), { role: "console" }); cleanup.push(() => client.close());
  const rows = JSON.parse((await client.request({ t: "task", op: "schedule_list", args: {} })).text) as any[];
  expect(rows.find(row => row.id === "nightly")).toMatchObject({ state: "paused" });
  expect(rows.find(row => row.id === "weekly")).toMatchObject({ state: "scheduled" });
});

test("unknown, missing and malformed ids are refused and change nothing", async () => {
  const clock = { now: T0 }, h = await start(clock);
  for (const op of ["schedule_run", "schedule_pause", "schedule_resume"]) for (const id of ["nope", "", undefined, 3, { toString: "x" }]) {
    const reply = await h.op(h.person, op, id === undefined ? {} : { id });
    expect(reply.ok, `${op} ${JSON.stringify(id)}`).toBe(false);
    expect(String(reply.error)).toContain("no schedule");
  }
  expect(h.tasks()).toHaveLength(0);
  expect(h.row("nightly")).toMatchObject({ paused: 0 });
});

test("an agent is refused every schedule op, and nothing changes", async () => {
  const clock = { now: T0 }, h = await start(clock);
  for (const op of ["schedule_list", "schedule_run", "schedule_pause", "schedule_resume"]) {
    const reply = await h.op(h.agent, op, { id: "nightly" });
    expect(reply.ok, op).toBe(false);
    expect(String(reply.error), op).toContain("console command");
  }
  expect(h.tasks()).toHaveLength(0);
  expect(h.row("nightly")).toMatchObject({ paused: 0, last_run: null });
});

test("the dashboard snapshot carries each schedule's next run, ids and times only, and none when none is configured", async () => {
  const clock = { now: T0 }, h = await start(clock);
  const snapshot = (await h.person.request({ t: "ui_snapshot", after: 0 }));
  const rows = snapshot.schedules as any[];
  expect(rows.map(row => [row.id, row.state, row.next])).toEqual([["nightly", "scheduled", T0 + HOUR], ["weekly", "scheduled", T0 + 24 * HOUR]]);
  expect(JSON.stringify(rows)).not.toContain("nightly board");
  await h.op(h.person, "schedule_pause", { id: "weekly" });
  expect(((await h.person.request({ t: "ui_snapshot", after: 0 })).schedules as any[]).find(row => row.id === "weekly").state).toBe("paused");
  const none = await start(clock, {}, {});
  expect((await none.person.request({ t: "ui_snapshot", after: 0 })).schedules).toBeUndefined();
});

test("ahub status shows a paused schedule as paused with the command to resume it", async () => {
  const clock = { now: T0 }, h = await start(clock);
  await h.op(h.person, "schedule_pause", { id: "nightly" });
  const status = (await h.person.request({ t: "status" })).status;
  const shown = renderStatus({ ...status, peers: {} }, 200, T0).map(line => paint(line, false)).filter(line => line.includes("schedule nightly"));
  expect(shown).toHaveLength(1);
  expect(shown[0]).toContain("paused (ahub schedule resume nightly)");
});

// ---- the Tasks layer on its own: the daemon refuses a non-person op first, so these hold the second layer and the pass guard

function tasksRig(options: { screen?: () => Promise<{ label: "clear"; ms: number }> } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-schedule-tasks-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd, board, bus, roles: {}, project: "fixture", routing: () => {
    const routing = loadRouting(cwd);
    return options.screen ? { ...routing, signals: { ...routing.signals, pii_screen: "local" } } : routing;
  }, notify: () => {}, ...(options.screen ? { piiScreen: options.screen } : {}) });
  const store = new ScheduleStore(join(cwd, "hub.db"));
  cleanup.push(() => { store.close(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const entries = [{ id: "a", every: "1h", class: "plan", title: "Scheduled work", queue: "backlog" as const }];
  return { tasks, store, entries, board };
}
const refusal = async (call: () => unknown) => { let e: unknown; try { await call(); } catch (caught) { e = caught; } expect(e).toBeInstanceOf(PreEffectToolRefusal); return (e as Error).message; };

test("run, pause and resume refuse every actor but the person, before anything is written", async () => {
  const r = tasksRig();
  for (const by of ["codex", "claude", "hub"]) {
    expect(await refusal(() => r.tasks.runScheduleNow(by, r.store, r.entries, "a", T0))).toContain("console command");
    expect(await refusal(() => r.tasks.setSchedulePaused(by, r.store, r.entries, "a", true, T0))).toContain("console command");
    expect(await refusal(() => r.tasks.setSchedulePaused(by, r.store, r.entries, "a", false, T0))).toContain("console command");
  }
  expect(r.board.list()).toHaveLength(0);
  expect(r.store.rows()).toEqual([]);
  expect((await r.tasks.runScheduleNow(USER, r.store, r.entries, "a", T0)).outcome).toBe("ran");
});

test("a manual run never overlaps a schedules pass, and the pass guard is released whatever happens", async () => {
  let release: (() => void) | undefined, entered = 0;
  const r = tasksRig({ screen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) });
  r.store.ensure("a", T0); // anchored at T0, so a pass two periods later finds it due
  const running = r.tasks.proposeFromSchedules(r.store, r.entries, T0 + 2 * HOUR);
  await until(() => entered >= 1, "the pass is inside its PII screen");
  expect(r.tasks.schedulesPending()).toBe(1);
  expect(await refusal(() => r.tasks.runScheduleNow(USER, r.store, r.entries, "a", T0 + 2 * HOUR))).toContain("pass is running");
  release!(); await running;
  expect(r.tasks.schedulesPending()).toBe(0);
  expect(r.board.list().filter(task => scheduleKeyOf(task.detail) === "a")).toHaveLength(1);
  // a refused id releases nothing it never took, and a later run still works
  expect(await refusal(() => r.tasks.runScheduleNow(USER, r.store, r.entries, "missing", T0))).toContain("no schedule");
  expect(r.tasks.schedulesPending()).toBe(0);
});

test("a pause or resume that lands while a timer run awaits its PII screen cancels that run instead of being overtaken by it", async () => {
  for (const action of ["pause", "resume"] as const) {
    let release: (() => void) | undefined, entered = 0;
    const r = tasksRig({ screen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) });
    r.store.ensure("a", T0);
    if (action === "resume") r.store.setPaused("a", true, T0 + HOUR / 2);
    const pass = action === "pause"
      ? r.tasks.proposeFromSchedules(r.store, r.entries, T0 + 2 * HOUR)
      : (() => { r.store.setPaused("a", false, T0 + 2 * HOUR); return r.tasks.proposeFromSchedules(r.store, r.entries, T0 + 5 * HOUR); })();
    await until(() => entered >= 1, "the run is inside its PII screen");
    // the person acts while the run is admitted and waiting
    if (action === "pause") r.tasks.setSchedulePaused(USER, r.store, r.entries, "a", true, T0 + 3 * HOUR);
    else { r.tasks.setSchedulePaused(USER, r.store, r.entries, "a", true, T0 + 3 * HOUR); r.tasks.setSchedulePaused(USER, r.store, r.entries, "a", false, T0 + 4 * HOUR); }
    release!();
    const outcomes = await pass;
    expect(outcomes, action).toEqual([{ id: "a", outcome: "changed" }]);
    expect(r.board.list().filter(task => scheduleKeyOf(task.detail) === "a"), `${action}: the acknowledged command wins, no task is written`).toHaveLength(0);
    expect(r.store.get("a")!.coalesced).toBe(0);
    expect(r.store.get("a")!.last_run).toBeNull();
    expect(r.store.get("a")!.anchor, `${action}: the fresh period is not overwritten by the older pass`).toBe(action === "pause" ? T0 : T0 + 4 * HOUR);
  }
});

test("the anchor never moves back: a run that finishes after a later resume keeps the later period", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-schedule-anchor-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ScheduleStore(join(dir, "hub.db")); cleanup.push(() => store.close());
  store.ensure("a", 100);
  store.setPaused("a", true, 150); store.setPaused("a", false, 400);
  store.ran("a", 300, 9); // an older pass finishing late
  expect(store.get("a")).toMatchObject({ anchor: 400, last_run: 300, last_task: 9 });
  store.ran("a", 500, 10);
  expect(store.get("a")).toMatchObject({ anchor: 500, last_run: 500 });
});

test("a manual run is outside the timer's epoch: a pause during it does not cancel the person's own run", async () => {
  let release: (() => void) | undefined, entered = 0;
  const r = tasksRig({ screen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) });
  const running = r.tasks.runScheduleNow(USER, r.store, r.entries, "a", T0);
  await until(() => entered >= 1, "the manual run is inside its PII screen");
  r.tasks.setSchedulePaused(USER, r.store, r.entries, "a", true, T0 + 1);
  release!();
  expect((await running).outcome).toBe("ran");
  expect(r.board.list().filter(task => scheduleKeyOf(task.detail) === "a")).toHaveLength(1);
});

test("stop waits for a manual run in flight and the run's bookkeeping lands before the store closes", async () => {
  let release: (() => void) | undefined, entered = 0;
  const clock = { now: T0 };
  const h = await start(clock, { piiScreen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) }, undefined, true);
  const run = h.op(h.person, "schedule_run", { id: "nightly" });
  await until(() => entered >= 1, "the manual run is inside its PII screen");
  let stopped = false;
  const stopping = h.daemon.stop().then(() => { stopped = true; });
  await Bun.sleep(150);
  expect(stopped, "stop waits for the manual run in flight").toBe(false);
  release!();
  await stopping;
  const reply = await run;
  expect(stopped).toBe(true);
  expect(reply.ok === false || JSON.parse(reply.text ?? "{}").outcome !== "ran" || h.dbRow("nightly")?.last_run === T0, "a run that ran left its bookkeeping").toBe(true);
  const ran = reply.ok && JSON.parse(reply.text).outcome === "ran";
  if (ran) expect(h.dbRow("nightly")).toMatchObject({ last_run: T0 });
  else expect(h.tasks()).toHaveLength(0);
});

test("a manual run is refused once the hub is stopping", async () => {
  const clock = { now: T0 }, h = await start(clock);
  const stopping = h.daemon.stop();
  const reply = await h.op(h.person, "schedule_run", { id: "nightly" }).catch(error => ({ ok: false, error: String(error) }));
  await stopping;
  expect(reply.ok).toBe(false);
  expect(h.tasks()).toHaveLength(0);
});

// ---- the store and the view, without a daemon

test("the store gains the paused column on an older database and keeps older rows unpaused", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-schedule-store-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.db"), old = new Database(path, { create: true });
  old.run("CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, anchor INTEGER NOT NULL, last_run INTEGER, last_task INTEGER, coalesced INTEGER NOT NULL DEFAULT 0, last_error TEXT)");
  old.run("INSERT INTO schedule_runs(id, anchor) VALUES('legacy', 5)"); old.close();
  const store = new ScheduleStore(path); cleanup.push(() => store.close());
  expect(store.get("legacy")).toMatchObject({ id: "legacy", anchor: 5, paused: 0 });
  store.setPaused("legacy", true, 10);
  expect(store.get("legacy")).toMatchObject({ paused: 1, anchor: 5 });
  store.setPaused("legacy", false, 99);
  expect(store.get("legacy")).toMatchObject({ paused: 0, anchor: 99, coalesced: 0 });
  store.setPaused("fresh", true, 7); // pausing a schedule never seen yet records it, paused, anchored now
  expect(store.get("fresh")).toMatchObject({ paused: 1, anchor: 7 });
  new ScheduleStore(path).close(); // reopening an upgraded database changes nothing
});

test("scheduleViews: a pause wins over every other state, and an unpaused row is unchanged", () => {
  const entry = { id: "a", every: "1h", class: "plan", title: "t", queue: "backlog" as const };
  const row = (paused: number) => ({ id: "a", anchor: 0, last_run: null, last_task: null, coalesced: 0, last_error: null, paused });
  expect(scheduleViews([entry], [row(1)], 5 * HOUR, new Map([["a", 4]]), true)[0]!.state).toBe("paused");
  expect(scheduleViews([entry], [row(0)], 5 * HOUR, new Map([["a", 4]]), true)[0]!.state).toBe("held");
  expect(scheduleViews([entry], [row(0)], 5 * HOUR, new Map([["a", 4]]), false)[0]!.state).toBe("waiting");
  expect(scheduleViews([entry], [row(0)], 5 * HOUR, new Map(), false)[0]!.state).toBe("due");
  expect(scheduleViews([entry], [row(0)], HOUR / 2, new Map(), false)[0]).toMatchObject({ state: "scheduled", next: HOUR });
});

// ---- the command

test("schedule is person-only: an agent shell is refused, live-test cannot write it, and the audit never names an id", () => {
  for (const args of [["list"], ["run", "nightly"], ["pause", "nightly"], ["resume", "nightly"], []]) expect(classifyPeerCommand("schedule", args)).toBe("console");
  expect(liveTestRefusal("schedule", ["run", "nightly"])).toBe(true);
  for (const sub of ["list", "run", "pause", "resume"]) expect(cliCommandLabel("schedule", [sub, "nightly"])).toBe(`schedule ${sub}`);
  expect(cliCommandLabel("schedule", ["secret-id"])).toBe("schedule");
});

test("ahub help documents schedule and the command is in the dispatch table", () => {
  const entry = HELP.find(item => helpCommands(item).includes("schedule"));
  expect(entry).toBeDefined();
  expect(entry!.usage).toBe("ahub schedule list | run <id> | pause <id> | resume <id> [--json] [--color=auto|always|never]");
  for (const word of ["person only", "next run", "same hold", "pause", "fresh period"]) expect(entry!.description, word).toContain(word);
  expect(renderHelp(100, false, "schedule").replace(/\s+/g, " ")).toContain("ahub schedule list");
  const src = readFileSync(join(import.meta.dir, "../src/cli/main.ts"), "utf8"), at = src.indexOf("const commands: Record<");
  expect(src.slice(at, src.indexOf("\n};\n", at))).toMatch(/^  schedule: /m);
});

test("the human output shows next run, state, last run and task, and never a title", () => {
  const text = (lines: { text: string }[][]) => lines.map(line => line.map(span => span.text).join("")).join("\n");
  const rows = [
    { id: "nightly", every: "1h", class: "plan", queue: "backlog", next: T0 + HOUR, state: "scheduled", last: T0 - HOUR, task: 4 },
    { id: "weekly", every: "24h", class: "plan", queue: "ready", next: T0 + HOUR, state: "paused", coalesced: 2, error: "could not propose" },
    { id: "late", every: "1h", class: "plan", queue: "backlog", next: T0, state: "waiting", task: 9 },
  ];
  const out = text(renderScheduleList(rows, 160, T0));
  expect(out).toContain("Schedules (3)"); expect(out).toContain("nightly"); expect(out).toContain("paused (would be"); expect(out).toContain("#4");
  expect(out).toContain("2 due ticks skipped"); expect(out).toContain("last run failed: could not propose"); expect(out).toContain("waiting for its task to close");
  expect(text(renderScheduleList([], 100, T0))).toContain("no schedules configured");
  expect(text(renderScheduleRun({ id: "nightly", outcome: "ran", task: 12 }, 100))).toContain("Schedule nightly: ran");
  expect(text(renderScheduleRun({ id: "nightly", outcome: "waiting", task: 12 }, 100))).toContain("still open");
  expect(text(renderScheduleRun({ id: "nightly", outcome: "held" }, 100))).toContain("the hub is held");
  expect(text(renderScheduleRun({ id: "nightly", outcome: "failed", reason: "no class" }, 100))).toContain("no class");
  expect(text(renderScheduleChange("pause", [{ id: "nightly", state: "paused", next: T0 + HOUR }], 100, T0))).toContain("Schedule nightly paused");
  expect(text(renderScheduleChange("resume", [{ id: "nightly", state: "scheduled", next: T0 + HOUR }], 100, T0))).toContain("Schedule nightly resumed");
});

// ---- the dashboard page

function page() {
  const html = readFileSync(new URL("../src/ui/index.html", import.meta.url), "utf8");
  const start = html.indexOf("function scheduleNextLabel("), end = html.indexOf("function renderUsage(");
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  class Node {
    children: Node[] = []; textContent = ""; className = ""; attrs: Record<string, string> = {}; dataset: Record<string, string> = {};
    constructor(readonly tag: string) {}
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Node[]) { this.children = nodes; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    text(): string { return [this.textContent, ...this.children.map(child => child.text())].join(" "); }
  }
  const nodes: Record<string, Node> = { "schedules-section": new Node("section"), schedules: new Node("div"), "schedule-count": new Node("span") };
  const api = runInNewContext(`${html.slice(start, end)};({ scheduleNextLabel, renderSchedules })`, {
    $: (id: string) => nodes[id], el: (tag: string, text?: string, cls?: string) => { const n = new Node(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; },
    empty: (target: Node, text: string) => { const n = new Node("p"); n.textContent = text; target.append(n); },
  }) as { scheduleNextLabel(row: unknown): string; renderSchedules(rows: unknown): void };
  return { api, nodes, html };
}

test("the dashboard words each state's next run and invents no time", () => {
  const { api } = page();
  const at = new Date(T0 + HOUR).toLocaleString();
  expect(api.scheduleNextLabel({ state: "scheduled", next: T0 + HOUR })).toBe(at);
  expect(api.scheduleNextLabel({ state: "paused", next: T0 + HOUR })).toBe(`Paused (would be ${at})`);
  expect(api.scheduleNextLabel({ state: "due", next: T0 })).toBe("Due now");
  expect(api.scheduleNextLabel({ state: "waiting", next: T0, task: 9 })).toBe("Due, waiting for task #9 to close");
  expect(api.scheduleNextLabel({ state: "held", next: T0 })).toContain("held");
  expect(api.scheduleNextLabel({ state: "scheduled", next: "soon" })).toBe("unknown");
  expect(api.scheduleNextLabel({ state: "mystery", next: T0 })).toBe("unknown");
  expect(api.scheduleNextLabel(undefined)).toBe("unknown");
});

test("the Schedules panel lists each schedule with its next run, shows an explicit empty state, and drops stale rows", () => {
  const { api, nodes } = page();
  api.renderSchedules([{ id: "nightly", every: "1h", class: "plan", queue: "backlog", state: "scheduled", next: T0 + HOUR, last: T0, task: 4 }, { id: "weekly", every: "24h", class: "plan", queue: "ready", state: "paused", next: T0 + 24 * HOUR }]);
  const text = nodes.schedules!.text();
  for (const word of ["nightly", "1h", "plan / backlog", new Date(T0 + HOUR).toLocaleString(), "#4", "weekly", "Paused (would be"]) expect(text, word).toContain(word);
  expect(nodes["schedule-count"]!.textContent).toBe("2 schedules");
  expect(nodes["schedules-section"]!.dataset.empty).toBe("false");
  api.renderSchedules(undefined);
  expect(nodes.schedules!.text()).toContain("No schedules configured.");
  expect(nodes.schedules!.text()).not.toContain("nightly");
  expect(nodes["schedule-count"]!.textContent).toBe("");
  expect(nodes["schedules-section"]!.dataset.empty).toBe("true");
});

test("the page is wired: the Schedules section sits in the Agents view and render() draws it from the snapshot", () => {
  const { html } = page();
  expect(html).toMatch(/<section id="schedules-section"[^>]*data-view="agents"[^>]*hidden>/);
  expect(html).toContain("renderSchedules(snapshot.schedules);");
  expect(html).toContain("usage-table"); // reuses the existing table classes: no new CSS, so the CSP style hash is unchanged by styles
});
