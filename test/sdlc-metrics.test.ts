import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { bandsConfig, controlBands, DEFAULT_BAND, DEFAULT_MIN_DELTA, sdlcMetrics, series, summarize, taskSample, type BandConfig, type MetricTask } from "../src/hub/sdlc-metrics.ts";

const H = 3_600_000, T0 = Date.UTC(2026, 9, 1);
const hist = (...events: [number, string][]) => events.map(([at, event]) => ({ at: T0 + at * H, event }));
const task = (id: number, ...events: [number, string][]): MetricTask => ({ id, history: hist(...events) });

// A fixture board history: three tasks with every shape the metrics read.
const FIXTURE: MetricTask[] = [
  task(1, [0, "proposed"], [1, "spec accepted"], [3, "plan reviewed"], [4, "accepted"], [10, "done"], [12, "approved"], [12.5, "check passed"]),
  task(2, [0, "proposed"], [1, "accepted"], [5, "done"], [7, "changes_requested"], [9, "done"], [11, "approved"], [8, "check failed"]),
  task(3, [0, "proposed"], [2, "accepted"], [6, "done"], [8, "approved"], [20, "done"], [22, "approved"]),
  { id: 4, private: true, history: hist([0, "proposed"], [1, "accepted"], [2, "done"], [3, "approved"]) },
];

test("per-task values come from history and unknown stays null, never 0 (AC8)", () => {
  const one = taskSample(FIXTURE[0]!, { mergedAt: T0 + 30 * H });
  expect(one).toMatchObject({ acceptance_to_plan_ms: 2 * H, acceptance_to_first_review_ms: 8 * H, acceptance_to_merge_ms: 26 * H, first_pass_approval: 1, rework_rounds: 0, first_pass_ci: 1, stale_head_re_reviews: 0, same_head_ci_reruns: null });
  const two = taskSample(FIXTURE[1]!);
  expect(two).toMatchObject({ acceptance_to_plan_ms: null, acceptance_to_first_review_ms: 6 * H, acceptance_to_merge_ms: null, first_pass_approval: 0, rework_rounds: 1, first_pass_ci: 0 });
  // A done after an approval means the approval was voided and the work was reviewed again.
  expect(taskSample(FIXTURE[2]!)).toMatchObject({ stale_head_re_reviews: 1, rework_rounds: 0 });
  const bare = taskSample(task(9, [0, "proposed"]));
  expect(bare).toMatchObject({ acceptance_to_plan_ms: null, acceptance_to_first_review_ms: null, first_pass_approval: null, rework_rounds: null, first_pass_ci: null, stale_head_re_reviews: null });
});

test("the report summarises the visible tasks, withholds private ones and is reproducible (AC8)", () => {
  const a = sdlcMetrics(FIXTURE, { stalls: { open: 2, byKind: { reservation: 2 }, doneWithoutWrites: 1 } }), b = sdlcMetrics(structuredClone(FIXTURE), { stalls: { open: 2, byKind: { reservation: 2 }, doneWithoutWrites: 1 } });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(a.tasks).toBe(3);
  expect(a.withheldPrivate).toBe(1);
  expect(a.metrics.first_pass_approval).toEqual({ n: 3, unknown: 0, rate: 0.667 });
  expect(a.metrics.first_pass_ci).toEqual({ n: 2, unknown: 1, rate: 0.5 });
  expect(a.metrics.acceptance_to_plan_ms).toMatchObject({ n: 1, unknown: 2, mean: 2 * H, median: 2 * H });
  expect(a.metrics.acceptance_to_merge_ms).toMatchObject({ n: 0, unknown: 3, mean: null });
  expect(a.metrics.rework_rounds).toMatchObject({ n: 3, max: 1 });
  expect(a.stalls).toEqual({ open: 2, byKind: { reservation: 2 }, doneWithoutWrites: 1 });
  expect(a.bands).toBe("off");
  expect(JSON.stringify(a)).not.toContain("#4");
});

test("--since keeps only samples that count at or after it", () => {
  const all = sdlcMetrics(FIXTURE), later = sdlcMetrics(FIXTURE, { since: T0 + 9 * H });
  expect(all.tasks).toBe(3);
  expect(later.tasks).toBe(1);
  expect(later.since).toBe(T0 + 9 * H);
});

const config = (over: Partial<BandConfig> = {}): BandConfig => ({ ...DEFAULT_BAND, minDelta: 0, ...over });
const flat = (values: number[]) => values.map((value, i) => ({ value, task: i + 1 }));

test("band tiers fire deterministically at their sigma thresholds on the bad side only (AC8)", () => {
  const base = [10, 12, 10, 12, 10, 12, 10, 12, 10, 12];
  const run = (last: number, metric: "rework_rounds" | "first_pass_approval" = "rework_rounds") => controlBands(flat([...base, last]), metric, config());
  // mean 11, population sd 1
  expect(run(11).tier).toBe("ok");
  expect(run(12.9).tier).toBe("ok");
  expect(run(13).tier).toBe("log");
  expect(run(14).tier).toBe("diagnose");
  expect(run(15).tier).toBe("propose");
  expect(run(99).tier).toBe("propose");
  // The good side never fires: a faster time or a lower rework count is not a breach.
  expect(run(0).tier).toBe("ok");
  // A rate is worse when it falls.
  expect(run(8, "first_pass_approval").tier).toBe("diagnose"); // 3 deviations below the mean
  expect(run(7, "first_pass_approval").tier).toBe("propose"); // 4 deviations below
  expect(run(15, "first_pass_approval").tier).toBe("ok");
  // Same input, same answer.
  expect(JSON.stringify(run(15))).toBe(JSON.stringify(run(15)));
  expect(run(15)).toMatchObject({ metric: "rework_rounds", mean: 11, sd: 1, last: 15, z: 4, lastTask: 11, baseline: 10 });
});

test("a baseline that is too short, a flat baseline and the minimum delta do not fire", () => {
  expect(controlBands(flat([1, 1, 1, 1, 1, 1, 1, 9]), "rework_rounds", config()).tier).toBe("ok"); // 7 before the last, 8 needed
  expect(controlBands(flat([1, 1, 1, 1, 1, 1, 1, 1, 9]), "rework_rounds", config()).tier).toBe("propose"); // flat baseline, a real jump
  expect(controlBands(flat([1, 1, 1, 1, 1, 1, 1, 1, 1]), "rework_rounds", config()).tier).toBe("ok"); // no deviation at all
  expect(controlBands(flat([1, 1, 1, 1, 1, 1, 1, 1, 1.5]), "rework_rounds", config({ minDelta: DEFAULT_MIN_DELTA.rework_rounds })).tier).toBe("ok"); // a real but sub-minimum step
  const wobble = controlBands(flat([5, 5, 5, 5, 5, 5, 5, 5, 5.4]), "rework_rounds", config({ minDelta: 1 }));
  expect(wobble.tier).toBe("ok");
  expect(wobble.reason).toContain("deviations");
  expect(controlBands([], "rework_rounds", config()).tier).toBe("ok");
  expect(controlBands(flat([3]), "rework_rounds", config()).tier).toBe("ok");
});

test("a drift of several values all beyond one deviation is at least diagnose, even below the sigma tiers", () => {
  const stable = [10, 12, 10, 12, 10, 12, 10, 12, 10, 12, 10, 12, 10, 12, 10, 12];
  // Every drifting value is under the log tier on its own (z < 2), but all six sit more than one deviation above the mean.
  const result = controlBands(flat([...stable, 13.5, 13.6, 13.7, 13.8, 13.9, 13.95]), "rework_rounds", config());
  expect(result.tier).toBe("diagnose");
  expect(result.z!).toBeLessThan(2);
  expect(result.reason).toContain("last 6 values");
  // One value back inside the band breaks the run.
  expect(controlBands(flat([...stable, 13.5, 13.6, 13.7, 13.8, 13.9, 11]), "rework_rounds", config()).tier).toBe("ok");
});

test("unknown values are left out of a series and the order is by time then id", () => {
  const samples = [3, 1, 2].map(id => ({ ...taskSample(task(id, [id, "accepted"], [id + 1, "done"], [id + 2, "approved"])), rework_rounds: id === 1 ? null : id }));
  expect(series(samples, "rework_rounds")).toEqual([{ value: 3, task: 3 }, { value: 2, task: 2 }].reverse().sort((a, b) => a.task - b.task));
  expect(summarize([null, null])).toEqual({ n: 0, unknown: 2, mean: null, median: null, p90: null, max: null });
});

test("[bands] validates every field and refuses the unknown with its path (AC8)", () => {
  expect(bandsConfig(undefined)).toEqual({});
  const one = bandsConfig({ rework_rounds: { window: 12, log_sigma: 1.5 } }).rework_rounds!;
  expect(one).toMatchObject({ window: 12, minSamples: 8, logSigma: 1.5, diagnoseSigma: 3, proposeSigma: 4, minDelta: DEFAULT_MIN_DELTA.rework_rounds });
  const bad: [unknown, string][] = [
    [[], "sdlc.bands: expected a table"], [{ nope: {} }, "sdlc.bands.nope: unknown metric"], [{ rework_rounds: 3 }, "sdlc.bands.rework_rounds: expected a table"],
    [{ rework_rounds: { extra: 1 } }, "sdlc.bands.rework_rounds.extra: unknown field"], [{ rework_rounds: { window: 2 } }, "sdlc.bands.rework_rounds.window"],
    [{ rework_rounds: { window: 10.5 } }, "sdlc.bands.rework_rounds.window"], [{ rework_rounds: { log_sigma: "2" } }, "sdlc.bands.rework_rounds.log_sigma"],
    [{ rework_rounds: { min_samples: 30, window: 10 } }, "must not exceed window"], [{ rework_rounds: { log_sigma: 5, diagnose_sigma: 3 } }, "tiers must be ordered"],
    [{ rework_rounds: { min_delta: -1 } }, "sdlc.bands.rework_rounds.min_delta"],
  ];
  for (const [value, message] of bad) expect(() => bandsConfig(value), JSON.stringify(value)).toThrow(message);
  expect(sdlcConfig({ mode: "advise", bands: { rework_rounds: {} } }).bands?.rework_rounds).toBeDefined();
  expect(sdlcConfig({ mode: "advise" }).bands).toBeUndefined();
  expect(() => sdlcConfig({ mode: "advise", bands: { bogus: {} } })).toThrow("sdlc.bands.bogus");
});

// --- the Tasks boundary: one deduplicated card per breach, nothing else written ---
const close: (() => void)[] = [];
afterEach(() => { for (const fn of close.splice(0)) fn(); });
const DEFAULT_RIG_BANDS = { rework_rounds: { window: 10, min_samples: 8, min_delta: 0 } };
function rig(bands: object | null = DEFAULT_RIG_BANDS) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-metrics-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const roles = { claude: ["planner", "reviewer"], codex: ["implementer"] };
  const notices: string[] = [];
  const deps: TasksDeps = { cwd, board, bus, roles, project: "fixture", repository: "o/r", routing: () => loadRouting(cwd), notify: line => notices.push(line), sdlc: { config: () => sdlcConfig({ mode: "advise", ...(bands ? { bands } : {}) }), gh: async () => ({ code: 1, stdout: "" }) } };
  close.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, tasks: new Tasks(deps), notices };
}
/** A finished task with `rework` changes_requested rounds, written through the board like the flow does. */
function finished(board: Board, rework: number) {
  const t = board.propose("claude", { title: "work item", class: "implement" });
  board.update(t.id, "codex", "accepted", { state: "in_progress", owner: "codex" });
  for (let i = 0; i < rework; i++) { board.update(t.id, "codex", "done", { state: "in_review" }); board.update(t.id, "claude", "changes_requested", { state: "changes_requested" }); board.update(t.id, "codex", "accepted", { state: "in_progress" }); }
  board.update(t.id, "codex", "done", { state: "in_review" });
  board.update(t.id, "claude", "approved", { state: "approved" });
  return t.id;
}

test("a propose-tier breach writes one backlog plan card naming the metric and its evidence, and never a second for the same breach", () => {
  const { board, tasks } = rig();
  for (const rework of [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]) finished(board, rework);
  expect(tasks.proposeFromBands()).toEqual([]);
  const breach = finished(board, 9);
  const before = board.list().length;
  const created = tasks.proposeFromBands();
  expect(created).toHaveLength(1);
  const card = board.get(created[0]!)!;
  expect(card).toMatchObject({ state: "backlog", class: "plan" });
  expect(card.history[0]!.by).toBe("hub");
  expect(card.title).toContain("rework_rounds");
  expect(card.detail).toContain(`Band breach key: rework_rounds:propose:#${breach}`);
  expect(card.detail).toContain(`newest value 9 on task #${breach}`);
  expect(card.detail).toContain("opens no GitHub issue");
  expect(board.list().length).toBe(before + 1);
  // The same breach, evaluated again, writes nothing.
  expect(tasks.proposeFromBands()).toEqual([]);
  expect(tasks.proposeFromBands()).toEqual([]);
  expect(board.list().length).toBe(before + 1);
});

test("a diagnose-tier breach writes one read-only triage card; a log-tier breach writes only a notice", () => {
  const diagnose = rig({ rework_rounds: { window: 10, min_samples: 8, min_delta: 0, log_sigma: 1, diagnose_sigma: 2, propose_sigma: 20 } });
  for (const rework of [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]) finished(diagnose.board, rework);
  const id = finished(diagnose.board, 4);
  const made = diagnose.tasks.proposeFromBands();
  expect(made).toHaveLength(1);
  expect(diagnose.board.get(made[0]!)).toMatchObject({ state: "backlog", class: "triage" });
  expect(diagnose.board.get(made[0]!)!.detail).toContain(`rework_rounds:diagnose:#${id}`);
  expect(diagnose.board.get(made[0]!)!.detail).toContain("Do not edit files");
  const log = rig({ rework_rounds: { window: 10, min_samples: 8, min_delta: 0, log_sigma: 2, diagnose_sigma: 20, propose_sigma: 20 } });
  for (const rework of [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]) finished(log.board, rework);
  finished(log.board, 3.5 | 0);
  const before = log.board.list().length;
  expect(log.tasks.proposeFromBands()).toEqual([]);
  expect(log.board.list().length).toBe(before);
  expect(log.notices.some(line => line.includes("sdlc band: rework_rounds"))).toBe(true);
  const noticed = log.notices.length;
  log.tasks.proposeFromBands();
  expect(log.notices.length).toBe(noticed);
});

test("no bands, mode off, a baseline too short or private tasks create nothing", () => {
  const { board, tasks } = rig(null);
  for (const rework of [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 9]) finished(board, rework);
  expect(tasks.proposeFromBands()).toEqual([]);
  const short = rig();
  for (const rework of [1, 1, 9]) finished(short.board, rework);
  expect(short.tasks.proposeFromBands()).toEqual([]);
  const priv = rig();
  for (const rework of [1, 2, 1, 2, 1, 2, 1, 2, 1, 2]) finished(priv.board, rework);
  const id = finished(priv.board, 9);
  priv.board.update(id, "user", "screened", { signals: ["pii"] });
  expect(priv.tasks.proposeFromBands()).toEqual([]);
  expect(JSON.stringify(priv.tasks.sdlcMetrics("claude"))).not.toContain(`#${id}`);
});

test("the report is read-only, planner or person only, and refuses a bad since", () => {
  const { board, tasks } = rig();
  for (const rework of [1, 2, 3]) finished(board, rework);
  const before = JSON.stringify(board.list());
  const report = tasks.sdlcMetrics("claude");
  expect(report.tasks).toBe(3);
  expect(JSON.stringify(board.list())).toBe(before);
  expect(() => tasks.sdlcMetrics("codex")).toThrow("planning requires");
  expect(tasks.sdlcMetrics("user", "2026-01-01").since).toBe(Date.parse("2026-01-01"));
  expect(() => tasks.sdlcMetrics("claude", "not a date")).toThrow("since must be");
  expect(tasks.sdlcMetrics("claude", "9999999999999").tasks).toBe(0);
});

test("the real daemon serves hub_sdlc_metrics to a planner and a person, refuses others, writes nothing, and loads [bands] from sdlc.toml (#481 S7)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-metrics-daemon-")), stateDir = join(cwd, ".agenthub/state");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub/sdlc.toml"), 'mode = "advise"\n\n[bands.rework_rounds]\nwindow = 10\nmin_samples = 8\nmin_delta = 0\n');
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  const clients: ControlClient[] = [];
  try {
    const connect = async (role: "console" | "tools", peer?: string) => { const client = await ControlClient.connect(stateDir, { role, ...(peer ? { peer } : {}) }); clients.push(client); return client; };
    const person = await connect("console"), planner = await connect("tools", "claude"), other = await connect("tools", "codex");
    const request = (client: ControlClient, op: string, args: unknown) => client.request({ t: "task", op, args });
    expect(await request(other, "hub_sdlc_metrics", {})).toMatchObject({ ok: false });
    const before = (await request(person, "hub_task_list", {})).text;
    const reply = await request(planner, "hub_sdlc_metrics", {});
    expect(reply.ok).toBe(true);
    const report = JSON.parse(reply.text);
    expect(report).toMatchObject({ tasks: 0, withheldPrivate: 0 });
    expect(Array.isArray(report.bands)).toBe(true);
    expect(report.bands.map((band: { metric: string }) => band.metric)).toEqual(["rework_rounds"]);
    expect(report.bands[0].tier).toBe("ok");
    expect((await request(person, "hub_sdlc_metrics", { since: "2026-01-01" })).ok).toBe(true);
    expect(await request(planner, "hub_sdlc_metrics", { since: "garbage" })).toMatchObject({ ok: false });
    expect((await request(person, "hub_task_list", {})).text).toBe(before);
  } finally { for (const client of clients) client.close(); await daemon.stop(); rmSync(cwd, { recursive: true, force: true }); }
});
