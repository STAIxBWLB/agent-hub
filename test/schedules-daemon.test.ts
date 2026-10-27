import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";
import { Database } from "bun:sqlite";
import { ControlClient } from "../src/hub/control-client.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { scheduleKeyOf } from "../src/hub/schedules.ts";

// agent-hub #512 (hub task #330): the schedules timer in a real daemon. Spec: "Schedules and folder triggers (#512)".
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await condition(), label).toBe(true);
};
const HOUR = 3_600_000, T0 = 1_800_000_000_000;
const SHARED = {
  batch_ms: 0, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
  memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, research: { enabled: false },
  snapshots: { enabled: false }, approvals: { notify: false }, pi: { enabled: false, auto_start: false }, coordination: "advisory",
  task_sweep: { enabled: false, interval_s: 3600 },
};
const SCHEDULES = [{ id: "nightly", every: "1h", class: "plan", title: "Review the nightly board" }];

/** A git project whose config.json is committed (trusted for nothing machine-local) and whose config.local.json is not tracked. */
function project(config: { shared?: Record<string, unknown>; local?: Record<string, unknown>; commitLocal?: boolean; screen?: boolean }) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-schedules-daemon-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ ...SHARED, ...config.shared }));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(dir, ".agenthub/routing.toml"), config.screen ? routing.replace(/^pii_screen = "off"/m, 'pii_screen = "local"') : routing);
  if (config.local) writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(config.local));
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml");
  if (config.commitLocal) git("add", "-f", ".agenthub/config.local.json");
  git("commit", "-qm", "baseline");
  return { dir, state };
}
async function start(p: { dir: string; state: string }, clock: { now: number }, extra: Record<string, unknown> = {}) {
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => clock.now, schedulesEveryMs: 15, ...extra });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(p.state, { role: "console" }); cleanup.push(() => client.close());
  const status = async () => (await client.request({ t: "status" })).status;
  const db = new Database(join(p.state, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const scheduled = () => (db.query("SELECT id, title, detail, class, state FROM tasks ORDER BY id").all() as { id: number; title: string; detail: string; class: string; state: string }[]).filter(task => scheduleKeyOf(task.detail) === "nightly");
  /** The timer has seen the schedule and recorded its anchor: only then does moving the clock mean "a period passed". */
  const anchored = () => (db.query("SELECT id FROM schedule_runs").all() as { id: string }[]).some(row => row.id === "nightly");
  return { daemon, client, status, scheduled, anchored };
}

test("the timer runs with task_sweep off: nothing at first sight, one backlog card when due, and status shows the next run", async () => {
  const p = project({ local: { schedules: SCHEDULES } }), clock = { now: T0 };
  const h = await start(p, clock);
  await until(async () => (await h.status()).schedules?.length === 1, "status lists the schedule");
  await until(() => h.anchored(), "the timer recorded the anchor");
  const first = (await h.status()).schedules[0];
  expect(first).toMatchObject({ id: "nightly", every: "1h", class: "plan", queue: "backlog", state: "scheduled", next: T0 + HOUR });
  expect(JSON.stringify(first)).not.toContain("Review the nightly board"); // task text is never in status
  await Bun.sleep(80);
  expect(h.scheduled()).toHaveLength(0);
  clock.now = T0 + HOUR;
  await until(() => h.scheduled().length === 1, "a due schedule proposes a card");
  const task = h.scheduled()[0]!;
  expect(task).toMatchObject({ state: "backlog", class: "plan", title: "Review the nightly board" });
  await until(async () => (await h.status()).schedules[0].task === task.id, "status names the task");
  const after = (await h.status()).schedules[0];
  expect(after).toMatchObject({ last: T0 + HOUR, next: T0 + 2 * HOUR, state: "scheduled" });
  const shown = renderStatus({ ...(await h.status()), peers: {} }, 200, T0).map(line => paint(line, false)).filter(line => line.includes("schedule nightly"));
  expect(shown).toHaveLength(1);
  expect(shown[0]).toContain("next 2027-01-15");
  expect(shown[0]).toContain(`as task #${task.id}`);
  expect(shown[0]).not.toContain("Review the nightly board");
  // the open card blocks a second one, however long the timer keeps ticking
  clock.now = T0 + 5 * HOUR;
  await until(async () => (await h.status()).schedules[0].coalesced >= 1, "a skipped tick is counted");
  expect(h.scheduled()).toHaveLength(1);
  expect((await h.status()).schedules[0]).toMatchObject({ state: "waiting", task: task.id });
});

test("a hub held by the test seam skips due ticks and coalesces them, then runs once on release", async () => {
  const p = project({ local: { schedules: SCHEDULES } }), clock = { now: T0 };
  let held = true;
  const h = await start(p, clock, { schedulesHeld: () => held });
  await until(async () => (await h.status()).schedules?.length === 1, "listed");
  await until(() => h.anchored(), "anchored");
  clock.now = T0 + 3 * HOUR;
  await until(async () => (await h.status()).schedules[0].coalesced >= 2, "ticks coalesced while held");
  expect((await h.status()).schedules[0].state).toBe("held");
  expect(h.scheduled()).toHaveLength(0);
  held = false;
  await until(() => h.scheduled().length === 1, "one run after release");
  await Bun.sleep(80);
  expect(h.scheduled()).toHaveLength(1);
});

test("a committed config cannot set schedules: the entry is ignored, no timer runs and status lists none", async () => {
  const p = project({ shared: { schedules: SCHEDULES } }), clock = { now: T0 };
  expect(loadConfig(p.dir).schedules).toEqual([]);
  expect(loadConfig(p.dir).ignored?.join(" ")).toContain("schedules in .agenthub/config.json ignored");
  const h = await start(p, clock);
  clock.now = T0 + 3 * HOUR;
  await Bun.sleep(120);
  expect(h.scheduled()).toHaveLength(0);
  expect((await h.status()).schedules).toBeUndefined();
});

test("a tracked config.local.json is not trusted either", async () => {
  const p = project({ local: { schedules: SCHEDULES }, commitLocal: true });
  expect(loadConfig(p.dir).schedules).toEqual([]);
});

test("an invalid entry (cron, a 5 minute period) is refused by the loader with the fixed reason", () => {
  const cron = project({ local: { schedules: [{ id: "c", cron: "* * * * *", class: "plan", title: "t" }] } });
  expect(() => loadConfig(cron.dir)).toThrow("cron not supported yet; use every");
  const fast = project({ local: { schedules: [{ id: "f", every: "5m", class: "plan", title: "t" }] } });
  expect(() => loadConfig(fast.dir)).toThrow("at least 15m");
});

test("a restart keeps the period in hub.db: the run before the stop is not repeated, and the next one is a period after it", async () => {
  const p = project({ local: { schedules: SCHEDULES } }), clock = { now: T0 };
  let h = await start(p, clock);
  await until(async () => (await h.status()).schedules?.length === 1, "listed");
  await until(() => h.anchored(), "anchored");
  clock.now = T0 + HOUR;
  await until(() => h.scheduled().length === 1, "first run");
  const id = h.scheduled()[0]!.id;
  await h.daemon.stop();
  clock.now = T0 + HOUR + 10 * 60_000;
  h = await start(p, clock);
  await until(async () => (await h.status()).schedules?.length === 1, "listed again");
  expect((await h.status()).schedules[0]).toMatchObject({ last: T0 + HOUR, next: T0 + 2 * HOUR, task: id });
  await Bun.sleep(80);
  expect(h.scheduled()).toHaveLength(1);
});

test("a reload that adds schedules arms the timer, and removing them stops it and clears the status rows", async () => {
  const p = project({}), clock = { now: T0 };
  const h = await start(p, clock);
  expect((await h.status()).schedules).toBeUndefined();
  writeFileSync(join(p.dir, ".agenthub/config.local.json"), JSON.stringify({ schedules: SCHEDULES }));
  const preview = await h.client.request({ t: "settings_reload" });
  expect(preview.ok, String(preview.error)).toBe(true);
  if (preview.confirmation) expect((await h.client.request({ t: "settings_reload", confirm: preview.confirmation.token })).ok).toBe(true);
  await until(async () => (await h.status()).schedules?.length === 1, "the reload armed the schedule");
  await until(() => h.anchored(), "the new timer recorded the anchor");
  clock.now = T0 + HOUR;
  await until(() => h.scheduled().length === 1, "the new timer ran it");
  writeFileSync(join(p.dir, ".agenthub/config.local.json"), JSON.stringify({}));
  const preview2 = await h.client.request({ t: "settings_reload" });
  expect(preview2.ok, String(preview2.error)).toBe(true);
  if (preview2.confirmation) expect((await h.client.request({ t: "settings_reload", confirm: preview2.confirmation.token })).ok).toBe(true);
  await until(async () => (await h.status()).schedules === undefined, "removed schedules leave status");
});

test("a stop during a pending PII screen waits for the pass, writes no task, and closes the store before the board", async () => {
  const p = project({ local: { schedules: SCHEDULES }, screen: true }), clock = { now: T0 };
  let entered = 0, release: (() => void) | undefined;
  const h = await start(p, clock, { piiScreen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) });
  await until(async () => (await h.status()).schedules?.length === 1, "listed");
  await until(() => h.anchored(), "anchored");
  clock.now = T0 + HOUR;
  await until(() => entered === 1, "the pass is inside the screen");
  let stopped = false;
  const stopping = h.daemon.stop().then(() => { stopped = true; });
  await Bun.sleep(100);
  expect(stopped, "stop waits for the pass in flight").toBe(false);
  release!();
  await stopping;
  expect(stopped).toBe(true);
  expect(h.scheduled()).toHaveLength(0); // the hold began during the screen, so nothing was written
  expect(entered).toBe(1);
});

test("a stop clears the schedules timer: no pass starts after it (the pass reads the clock first, so reads are counted)", async () => {
  const p = project({ local: { schedules: SCHEDULES } }), clock = { now: T0 };
  let reads = 0;
  const h = await start(p, clock, { schedulesNow: () => { reads++; return clock.now; } });
  await until(async () => (await h.status()).schedules?.length === 1, "listed");
  await until(() => h.anchored(), "anchored");
  const running = reads;
  await until(() => reads > running, "the timer is ticking before the stop");
  await h.daemon.stop();
  await Bun.sleep(40); // a tick already past its guard settles
  const after = reads;
  clock.now = T0 + 5 * HOUR;
  await Bun.sleep(150); // ten periods of the 15 ms timer
  expect(reads, "no pass starts once the hub has stopped").toBe(after);
  expect(h.scheduled()).toHaveLength(0);
});

test("recovery waits for a scheduled proposal that is inside its PII screen, and the hold refuses its write", async () => {
  const p = project({ local: { schedules: SCHEDULES }, screen: true }), clock = { now: T0 };
  let entered = 0, release: (() => void) | undefined;
  const h = await start(p, clock, { piiScreen: () => new Promise(resolve => { entered++; release = () => resolve({ label: "clear", ms: 0 }); }) });
  await until(async () => (await h.status()).schedules?.length === 1, "listed");
  await until(() => h.anchored(), "anchored");
  clock.now = T0 + HOUR;
  await until(() => entered === 1, "the pass is inside the screen");
  const operationId = "schedules-recovery", expectedInstanceId = (await h.status()).instanceId;
  const inspect = async () => (await h.client.request({ t: "recovery", op: "inspect", expectedInstanceId })).recovery;
  expect((await h.client.request({ t: "recovery", op: "prepare", operationId, expectedInstanceId, targetFeatures: (await h.status()).features })).ok).toBe(true);
  // the hold has begun, and the proposal that was admitted before it is still in flight
  const during = await inspect();
  expect(during.ready, "a commit must not run while a scheduled proposal can still write").toBe(false);
  expect(during.blockers).toContain("a scheduled task proposal in flight");
  release!();
  await until(async () => (await inspect()).ready === true, "ready once the pass has ended");
  expect(h.scheduled(), "the hold refused the write").toHaveLength(0);
  expect((await h.client.request({ t: "recovery", op: "abort", operationId, expectedInstanceId })).ok).toBe(true);
  expect((await h.status()).schedules[0].coalesced, "the overtaken tick and the ticks held after it are counted, never replayed").toBeGreaterThanOrEqual(1);
  expect((await h.status()).schedules[0].error).toBeUndefined();
  clock.now = T0 + 2 * HOUR; // after the abort the next tick runs it
  await until(() => entered === 2, "the next tick proposes again");
  release!();
  await until(() => h.scheduled().length === 1, "one run after the hold ended");
});
