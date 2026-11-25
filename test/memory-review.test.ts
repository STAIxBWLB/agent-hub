import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ControlClient } from "../src/hub/control-client.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { MEMORY_REVIEW_SCHEDULE_ID, memoryReviewConfig, memoryReviewEntry } from "../src/hub/memory-review.ts";
import { realPath } from "../src/hub/project.ts";
import { scheduleKeyOf, scheduledDetail } from "../src/hub/schedules.ts";

// agent-hub #1329 part 1 (hub task 1132): memory.review, its person-only switch and the scheduled review card.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const until = async (condition: () => boolean | Promise<boolean>, label: string, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (!(await condition()) && Date.now() < deadline) await Bun.sleep(10);
  expect(await condition(), label).toBe(true);
};
const HOUR = 3_600_000, T0 = 1_800_000_000_000;
const CAPS = { max_tokens_run: 4000, max_tokens_week: 20_000 };
const SHARED = {
  batch_ms: 0, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
  memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, research: { enabled: false },
  snapshots: { enabled: false }, approvals: { notify: false }, pi: { enabled: false, auto_start: false }, coordination: "advisory",
  task_sweep: { enabled: false, interval_s: 3600 },
};

test("enabling needs both caps, and a block the validator would refuse schedules nothing", () => {
  expect(memoryReviewConfig(undefined)).toMatchObject({ enabled: false, every: "1d", projects: [], max_notes: 20 });
  for (const review of [{ enabled: true }, { enabled: true, max_tokens_run: 1000 }, { enabled: true, max_tokens_week: 1000 }]) {
    expect(() => memoryReviewConfig(review)).toThrow("memory.review.enabled needs both caps: set memory.review.max_tokens_run and memory.review.max_tokens_week, then run ahub memory review on");
  }
  expect(memoryReviewConfig({ enabled: true, ...CAPS })).toMatchObject({ enabled: true, ...CAPS, max_notes: 20 });
  expect(() => memoryReviewConfig({ ...CAPS, max_tokens_week: 100 })).toThrow("memory.review.max_tokens_week must be at least memory.review.max_tokens_run");
  expect(() => memoryReviewConfig({ every: "5m" })).toThrow("memory.review.every must be at least 15m");
  expect(() => memoryReviewConfig({ max_notes: 0 })).toThrow("memory.review.max_notes must be a whole number of notes from 1 to 200");
  expect(() => memoryReviewConfig({ peer: "Reviewer" })).toThrow("memory.review.peer is a peer id");
  expect(() => memoryReviewConfig({ enabled: false, worker_url: "x" })).toThrow("memory.review has no key worker_url");
  // A reload applies one key at a time, so a live block can hold `enabled` with no caps: the entry must stay absent, which is
  // the last place the AC1 decision is made.
  expect(memoryReviewEntry({ enabled: true } as never, "/tmp/project")).toBeUndefined();
  expect(memoryReviewEntry({ enabled: true, max_tokens_run: 10, max_tokens_week: 20, every: "5m" } as never, "/tmp/project")).toBeUndefined();
});

test("the entry exists only for a selected project, and its card carries the schedule marker and the caps", () => {
  const config = memoryReviewConfig({ enabled: true, every: "6h", projects: ["/work/alpha", "beta"], ...CAPS });
  // A selected project matches by its path or by its directory name, and one it does not select gets no entry.
  expect(memoryReviewEntry(config, "/work/alpha")?.id).toBe(MEMORY_REVIEW_SCHEDULE_ID);
  expect(memoryReviewEntry(config, "/work/beta")?.id).toBe(MEMORY_REVIEW_SCHEDULE_ID);
  expect(memoryReviewEntry(memoryReviewConfig({ enabled: false, ...CAPS }), "/work/alpha")).toBeUndefined();
  const entry = memoryReviewEntry(config, "/work/beta")!;
  expect(entry).toMatchObject({ id: MEMORY_REVIEW_SCHEDULE_ID, every: "6h", class: "review", queue: "backlog" });
  expect(entry.owner).toBeUndefined();
  expect(memoryReviewEntry(config, "/work/gamma")).toBeUndefined();
  const detail = scheduledDetail(entry);
  expect(scheduleKeyOf(detail)).toBe(MEMORY_REVIEW_SCHEDULE_ID);
  expect(detail).toContain("ahub memory stale-anchors --json");
  expect(detail).toContain(`${CAPS.max_tokens_run} per run, ${CAPS.max_tokens_week} per week`);
  expect(detail).toContain("at most 20");
  expect(memoryReviewEntry(memoryReviewConfig({ enabled: true, peer: "claude", ...CAPS }), "/work/alpha")!.owner).toBe("claude");
});

/** A git project whose config.json is committed (trusted for nothing machine-local) and whose config.local.json is not tracked. */
function project(config: { local?: Record<string, unknown> }) {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-memory-review-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const git = (...args: string[]) => { const r = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };
  writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify(SHARED));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(dir, ".agenthub/routing.toml"), routing);
  if (config.local) writeFileSync(join(dir, ".agenthub/config.local.json"), JSON.stringify(config.local));
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "baseline");
  return { dir, state };
}
async function start(p: { dir: string; state: string }, clock: { now: number }) {
  const daemon = await startDaemon({ cwd: p.dir, stateDir: p.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, schedulesNow: () => clock.now, schedulesEveryMs: 15 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(p.state, { role: "console" }); cleanup.push(() => client.close());
  const status = async () => (await client.request({ t: "status" })).status;
  const db = new Database(join(p.state, "hub.db"), { readonly: true }); cleanup.push(() => db.close());
  const cards = () => (db.query("SELECT id, title, detail, class, state FROM tasks ORDER BY id").all() as { id: number; title: string; detail: string; class: string; state: string }[]).filter(task => scheduleKeyOf(task.detail) === MEMORY_REVIEW_SCHEDULE_ID);
  const reviewRow = async () => (await status()).schedules?.find((row: { id: string }) => row.id === MEMORY_REVIEW_SCHEDULE_ID);
  const anchored = () => (db.query("SELECT id FROM schedule_runs").all() as { id: string }[]).some(row => row.id === MEMORY_REVIEW_SCHEDULE_ID);
  const op = (action: string) => client.request({ t: "task", op: "memory_review", args: { action } });
  const local = () => JSON.parse(readFileSync(join(p.dir, ".agenthub/config.local.json"), "utf8")) as { memory?: { review?: Record<string, unknown> } };
  return { client, status, cards, reviewRow, anchored, op, local };
}

test("a due run proposes one review card, and the switch stops and restarts it from either writer", async () => {
  // A configured schedule of the person's own sits beside the review: an empty list would let the store prune the review's
  // pause row when its entry disappears, which hides whether the fence follows the key (`off` below would look self-healing).
  const p = project({ local: { schedules: [{ id: "nightly", every: "1d", class: "implement", title: "Nightly check" }], memory: { review: { enabled: true, every: "1h", ...CAPS } } } }), clock = { now: T0 };
  const h = await start(p, clock);
  // The review is a schedule the person never wrote out: it has to appear in status beside the one they did.
  await until(async () => (await h.reviewRow()) !== undefined, "status lists the review schedule");
  await until(() => h.anchored(), "the timer recorded the review anchor");
  expect(await h.reviewRow()).toMatchObject({ id: MEMORY_REVIEW_SCHEDULE_ID, every: "1h", class: "review", queue: "backlog", state: "scheduled", next: T0 + HOUR });
  expect(JSON.stringify(await h.status())).not.toContain("stale anchors");
  await Bun.sleep(80);
  expect(h.cards()).toHaveLength(0);

  clock.now = T0 + HOUR;
  await until(() => h.cards().length === 1, "a due review proposes one card");
  const card = h.cards()[0]!;
  expect(card).toMatchObject({ state: "backlog", class: "review", title: "Memory review: notes whose code anchors no longer resolve" });
  expect(card.detail).toContain(`Schedule key: ${MEMORY_REVIEW_SCHEDULE_ID}`);
  expect(card.detail).toContain("ahub memory stale-anchors --json");

  const off = await h.op("off");
  if (!off.ok) throw new Error(off.error);
  const answered = JSON.parse(off.text!) as { action: string; enabled: boolean; cancelled?: number; schedule?: { state: string } };
  expect(answered).toMatchObject({ action: "off", enabled: false, cancelled: card.id });
  expect((h.cards()[0]!).state).toBe("cancelled");
  expect(h.local().memory?.review?.enabled).toBe(false);
  expect(await h.reviewRow()).toBeUndefined();

  // With the entry gone the timer proposes nothing more, and the row goes with the entry, so a restart reads only the key and
  // nothing `off` recorded survives to block it (docs/memory.md says so, and the restart below depends on it).
  clock.now = T0 + 3 * HOUR;
  await Bun.sleep(120);
  expect(h.cards()).toHaveLength(1);
  expect((await h.cards()[0]!).state).toBe("cancelled");
  expect(h.anchored()).toBe(false);

  // The console's switch row writes the same key, and the fence follows the key whichever writer moved it: without that,
  // enabling from the dashboard would leave the pause `off` recorded, so the row would read on and schedule nothing.
  const row = await h.client.request({ t: "settings_set", key: "memory.review.enabled", value: true });
  expect(row.ok, String(row.error)).toBe(true);
  // The view's own state is the fence's witness: while the pause `off` recorded stands, the row reads `paused`. Its `next`
  // is the other witness: the timer re-registered the entry and anchored it at this clock, so the jump below is what makes a
  // period pass. Waiting only for the row would let the jump land first and anchor the entry at the jumped clock, and no
  // further period would ever arrive (`test/schedules-daemon.test.ts` waits for its `anchored()` for the same reason).
  // The store row is the witness, not the view: `scheduleViews` uses `row?.anchor ?? now`, so a view read reports the right
  // `next` before the timer has ever seen the entry. Waiting for the row (as `test/schedules-daemon.test.ts` waits for its
  // `anchored()`) makes the jump below mean "a period passed" rather than "a period starts here"; the row's own `next` then
  // pins that the timer anchored it at this clock, not at the jumped one.
  await until(() => h.anchored(), "the timer re-registered the schedule and recorded its anchor");
  expect((await h.reviewRow())?.next).toBe(T0 + 4 * HOUR);
  clock.now = T0 + 4 * HOUR;
  await until(() => h.cards().length === 2, "the restarted schedule proposes again");
  expect(h.cards()[1]).toMatchObject({ state: "backlog", class: "review" });

  // A key that is already `true` changes nothing, so there is no reload to carry the fence: `on` has to clear a pause a
  // person set by hand itself, or the switch would read on and schedule nothing.
  const paused = await h.client.request({ t: "task", op: "schedule_pause", args: { id: MEMORY_REVIEW_SCHEDULE_ID } });
  expect(paused.ok, String(paused.error)).toBe(true);
  expect((await h.reviewRow())?.state).toBe("paused");
  const resumed = await h.op("on");
  if (!resumed.ok) throw new Error(resumed.error);
  await until(async () => (await h.reviewRow())?.state !== "paused", "on clears a hand-set pause with no config change");
});

test("`memory review on` without both caps is refused by the config and writes nothing", async () => {
  const p = project({ local: { memory: { review: { every: "1h" } } } }), clock = { now: T0 };
  const h = await start(p, clock);
  expect(await h.reviewRow()).toBeUndefined();
  const status = await h.op("status");
  if (!status.ok) throw new Error(status.error);
  expect(JSON.parse(status.text!)).toMatchObject({ action: "status", enabled: false });

  const on = await h.op("on");
  expect(on.ok).toBe(false);
  expect(String(on.error)).toContain("memory.review.enabled needs both caps");
  expect(String(on.error)).toContain("ahub memory review on");
  expect(h.local().memory?.review?.enabled).toBeUndefined();
  expect(await h.reviewRow()).toBeUndefined();
  clock.now = T0 + HOUR;
  await Bun.sleep(120);
  expect(h.cards()).toHaveLength(0);
});
