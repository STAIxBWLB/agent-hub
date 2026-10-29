import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OPERATIONAL_NUMBERS, operationalNumber, taskOperationalReaders } from "../src/hub/operational-settings.ts";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { configApply, validateOperationalConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { checkSettingValue, settingDef, settingRefusal, SETTINGS, writeConfigSetting, undoSetting } from "../src/hub/settings.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, CONTRADICTION_WINDOW_MS, DEMOTE_AT, DEMOTION_HALF_LIFE_MS, RESCREEN_MAX } from "../src/hub/tasks.ts";
import { loadRouting, predictSplit, SPLIT_FAILURE_SHARE, SPLIT_MIN, type SplitInput } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER } from "../src/hub/envelope.ts";
import type { PiiVerdict } from "../src/hub/inference.ts";

// #489 H2 (hub task 441), group 1: the tasks and routing constants classified operational in the H0 inventory become settings through the H1 mechanism (src/hub/operational-settings.ts) and nothing else.
// The constants stay exported as the defaults. Every value below is read at its one use site, so a settings change applies at the next use and an unset value is the old constant.
const KEYS = ["tasks.demote_at", "tasks.demotion_half_life_h", "tasks.contradiction_window_days", "tasks.rescreen_max", "tasks.split_min_observations", "tasks.split_max_failure_share"] as const;
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const def = (key: string) => { const d = settingDef(key); if (typeof d === "string") throw new Error(d); return d; };
const tasksBlock = (key: string, value: unknown) => ({ tasks: { [key.slice("tasks.".length)]: value } });

test("#489 H2 the six rows exist, are config-store live numbers in the Routing group and carry the H0 operational source", () => {
  expect(OPERATIONAL_NUMBERS.map(d => d.key)).toEqual(["tasks.groom_fyi_window_min", ...KEYS]);
  for (const key of KEYS) {
    const row = operationalNumber(key)!;
    expect(row).toMatchObject({ group: "Routing", store: "config", risk: "raises", applies: "live", path: ["tasks", key.slice(6)] });
    expect(SETTINGS.filter(s => s.key === key)).toHaveLength(1);
    expect(configApply(key)).toEqual({ applies: "live" });
    expect(def(key)).toMatchObject({ min: row.min, max: row.max, type: row.type, applies: "live" });
    // inventory, default and unit are metadata of the row and never reach the settings table
    expect((SETTINGS.find(s => s.key === key) as unknown as Record<string, unknown>).defaultValue).toBeUndefined();
  }
});

// the bounds each value may take: [key, accepted, refused]
const BOUNDS: [(typeof KEYS)[number], number[], unknown[]][] = [
  ["tasks.demote_at", [0.5, 1.5, 20], [0, 0.49, 20.1, -1, NaN, Infinity, "1.5", true, null, []]],
  ["tasks.demotion_half_life_h", [1, 24, 168], [0, 0.5, 169, -1, NaN, "24", true, null]],
  ["tasks.contradiction_window_days", [1, 7, 90], [0, 0.9, 91, -1, NaN, "7", true, null]],
  ["tasks.rescreen_max", [1, 10, 100], [0, 1.5, 101, -1, NaN, "10", true, null]],
  ["tasks.split_min_observations", [3, 5, 100], [0, 2, 3.5, 101, -1, NaN, "5", true, null]],
  ["tasks.split_max_failure_share", [0, 0.3, 1], [-0.01, 1.01, NaN, Infinity, "0.3", true, null]],
];
for (const [key, accepted, refused] of BOUNDS) {
  test(`#489 H2 ${key}: schema, startup validation and the UI check share one set of bounds`, () => {
    const d = def(key);
    for (const value of accepted) {
      expect(checkSettingValue(d, value)).toBe(value);
      expect(() => validateRawConfig(tasksBlock(key, value))).not.toThrow();
      expect(() => validateOperationalConfig(tasksBlock(key, value))).not.toThrow();
    }
    for (const value of refused) {
      if (value !== null) expect(() => checkSettingValue(d, value), String(value)).toThrow();
      expect(() => validateRawConfig(tasksBlock(key, value)), String(value)).toThrow(key);
      expect(() => validateOperationalConfig(tasksBlock(key, value)), String(value)).toThrow(key);
    }
    expect(checkSettingValue(d, null)).toBeNull(); // UI inherit is not a raw JSON value
    expect(settingRefusal(d, accepted[0]!, "ordinary")).toContain("settings session");
    expect(settingRefusal(d, accepted[0]!, "settings")).toBeUndefined();
    expect(settingRefusal(d, accepted[0]!, "terminal")).toBeUndefined();
    expect(settingRefusal(d, accepted[0]!, "conductor")).toContain("not an operational conductor setting");
  });
}

function project() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-operational-tasks-")));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, ".agenthub"));
  return { cwd, file: join(cwd, ".agenthub/config.local.json"), shared: join(cwd, ".agenthub/config.json"), state: join(cwd, ".agenthub/state") };
}
test("#489 H2 unset keeps the default, startup rejects a bad value in either file, and inherit and undo go through the existing local file", () => {
  const f = project();
  for (const key of KEYS) expect(loadConfig(f.cwd).tasks[key.slice(6) as keyof typeof DEFAULT_CONFIG.tasks]).toBe(operationalNumber(key)!.defaultValue);
  for (const [key, accepted, refused] of BOUNDS) for (const filename of ["config.json", "config.local.json"]) {
    const target = join(f.cwd, ".agenthub", filename);
    for (const value of refused) { writeFileSync(target, JSON.stringify(tasksBlock(key, value))); expect(() => loadConfig(f.cwd), `${key} ${String(value)}`).toThrow(key); }
    writeFileSync(target, JSON.stringify(tasksBlock(key, accepted[1]))); expect(loadConfig(f.cwd).tasks[key.slice(6) as keyof typeof DEFAULT_CONFIG.tasks]).toBe(accepted[1]);
    rmSync(target);
  }
  const shared = JSON.stringify({ tasks: { demote_at: 3, rescreen_max: 4 } });
  writeFileSync(f.shared, shared);
  const d = def("tasks.demote_at");
  expect(writeConfigSetting(f.cwd, f.state, d, 2, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).tasks.demote_at).toBe(2);
  expect(writeConfigSetting(f.cwd, f.state, d, null, loadConfig)).toBe(true);
  expect(loadConfig(f.cwd).tasks.demote_at).toBe(3); // inherit: the shared value
  expect(undoSetting(f.cwd, f.state, loadConfig).key).toBe("tasks.demote_at");
  expect(loadConfig(f.cwd).tasks.demote_at).toBe(2);
  expect(loadConfig(f.cwd).tasks.rescreen_max).toBe(4); // the other shared value was never touched
  expect(readFileSync(f.shared, "utf8")).toBe(shared);
});

// ---- the real Tasks boundary ----
const DAY = 86_400_000, HOUR = 3_600_000;
class Idle extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }
async function rig(deps: Partial<ConstructorParameters<typeof Tasks>[0]> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-operational-tasks-rig-"));
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Idle(id); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ board, bus, cwd, project: "operational", routing: () => loadRouting(cwd), notify: () => {}, sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) }, ...deps });
  cleanup.push(() => { tasks.stopCiWatchers(); tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { board, bus, tasks };
}

test("#489 H2 demotion: unset is the 1.5 and 24 hour constants, and a changed threshold or half-life applies at the next call", async () => {
  expect(DEMOTE_AT).toBe(1.5);
  expect(DEMOTION_HALF_LIFE_MS).toBe(24 * HOUR);
  const now = Date.now();
  const seed = (board: Board) => { board.recordOutcome("codex", "implement", false, now - 60_000); board.recordOutcome("codex", "implement", false, now - 30_000); };
  // unset and the explicit defaults give the same answer, weights included
  const plain = await rig(), explicit = await rig({ demoteAt: () => 1.5, demotionHalfLifeH: () => 24 });
  seed(plain.board); seed(explicit.board);
  expect(explicit.tasks.demoted("implement", now)).toEqual(plain.tasks.demoted("implement", now));
  expect(Object.keys(plain.tasks.demoted("implement", now))).toEqual(["codex"]);
  expect(plain.tasks.demoted("implement", now + 3 * DAY)).toEqual({});
  // threshold: two near-fresh failures weigh about 2; 2.5 does not demote, and the live value is read at each call
  const live = { at: 1.5, half: 24 };
  const r = await rig({ demoteAt: () => live.at, demotionHalfLifeH: () => live.half });
  seed(r.board);
  expect(Object.keys(r.tasks.demoted("implement", now))).toEqual(["codex"]);
  live.at = 2.5; expect(r.tasks.demoted("implement", now)).toEqual({});
  live.at = 1.5; expect(Object.keys(r.tasks.demoted("implement", now))).toEqual(["codex"]);
  // half-life: each failure weighs 0.5 ** (age / half-life). Two failures three days later: 2 * 0.5 ** (72 / 24) = 0.25 at the default, 2 * 0.5 ** (72 / 168) = 1.486 at 168 hours, both under 1.5
  const late = now + 3 * DAY, ageH = (3 * DAY + 45_000) / HOUR; // the two failures are 60 s and 30 s old at `now`, 45 s on average
  expect(r.tasks.demoted("implement", late)).toEqual({});
  live.half = 168; live.at = 1.0;
  expect(r.tasks.demoted("implement", late)["codex"]).toBeCloseTo(2 * 0.5 ** (ageH / 168), 2);
  expect(r.tasks.demoted("implement", late)["codex"]).toBeGreaterThan(1.4);
  live.at = 1.5; expect(r.tasks.demoted("implement", late)).toEqual({}); // 1.486 is under the default threshold
  live.half = 12; live.at = 0.5; expect(r.tasks.demoted("implement", now + 12 * HOUR)["codex"]).toBeCloseTo(2 * 0.5 ** ((12 * HOUR + 45_000) / (12 * HOUR)), 2);
  live.half = 24; expect(r.tasks.demoted("implement", now + 12 * HOUR)["codex"]).toBeCloseTo(2 * 0.5 ** ((12 * HOUR + 45_000) / (24 * HOUR)), 2); // the same call, a different half-life, a different weight
});

test("#489 H2 demotion threshold is inclusive: a weight exactly at the threshold demotes, a hair under it does not", async () => {
  const now = Date.now();
  const r = await rig({ demoteAt: () => 2 });
  for (let i = 0; i < 2; i++) r.board.recordOutcome("codex", "implement", false, now); // age 0: each weighs exactly 1, so the sum is exactly 2
  expect(r.tasks.demoted("implement", now)).toEqual({ codex: 2 });
  const above = await rig({ demoteAt: () => 2.0001 });
  for (let i = 0; i < 2; i++) above.board.recordOutcome("codex", "implement", false, now);
  expect(above.tasks.demoted("implement", now)).toEqual({});
  // the default 1.5 is inclusive in the same way: a lone fresh failure is 1.0 and two are 2.0, no weight lands on 1.5 at age 0
  const plain = await rig();
  plain.board.recordOutcome("codex", "implement", false, now);
  expect(plain.tasks.demoted("implement", now)).toEqual({});
});

test("#489 H2 contradiction window: unset is seven days, and a changed window decides whether an old approval is blamed", async () => {
  expect(CONTRADICTION_WINDOW_MS).toBe(7 * DAY);
  const run = async (days: number | undefined, ageDays: number) => {
    const r = await rig({ ...(days === undefined ? {} : { contradictionWindowDays: () => days }) });
    const a = await r.tasks.propose("codex", { title: "a", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
    await r.tasks.done("codex", a.id, "done"); await r.tasks.review("claude", a.id, "approved");
    const approved = r.board.get(a.id)!;
    // age the approval entry: the board stores history as written, so move its timestamp back
    const history = approved.history.map(h => (h.event === "approved" ? { ...h, at: Date.now() - ageDays * DAY } : h));
    (r.board as unknown as { db: { query: (q: string) => { run: (...a: unknown[]) => void } } }).db.query("UPDATE tasks SET history = ? WHERE id = ?").run(JSON.stringify(history), a.id);
    const b = await r.tasks.propose("kimi", { title: "b", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
    await r.tasks.done("kimi", b.id, "x"); await r.tasks.review(r.board.get(b.id)!.reviewer!, b.id, "changes_requested", "no");
    return r.board.reviews({ task: a.id }).map(x => x.kind);
  };
  expect(await run(undefined, 6)).toEqual(["approved", "contradicted"]); // inside seven days
  expect(await run(undefined, 8)).toEqual(["approved"]); // outside it
  expect(await run(7, 6)).toEqual(await run(undefined, 6));
  expect(await run(7, 8)).toEqual(await run(undefined, 8));
  expect(await run(10, 8)).toEqual(["approved", "contradicted"]); // a longer window reaches it
  expect(await run(1, 6)).toEqual(["approved"]); // a shorter one does not
});

test("#489 H2 split prediction thresholds: unset is 5 observations and a 0.3 failed share, and a changed value moves the verdict", () => {
  expect(SPLIT_MIN).toBe(5);
  expect(SPLIT_FAILURE_SHARE).toBe(0.3);
  const approved = (n: number, work = 25_000) => Array.from({ length: n }, () => ({ outcome: "approved" as const, orient: 10_000, work }));
  const failed = (n: number) => Array.from({ length: n }, () => ({ outcome: "failed" as const }));
  const input = (codex: SplitInput["observations"][string], extra: Partial<SplitInput> = {}): SplitInput => ({
    peers: ["codex", "kimi"], observations: { codex, kimi: approved(5, 60_000) }, units: [1, 1], profiles: { codex: "p", kimi: "p" }, backlog: { codex: 0, kimi: 0 }, available: { codex: true, kimi: true }, ...extra,
  });
  const verdict = (codex: SplitInput["observations"][string], extra: Partial<SplitInput> = {}) => predictSplit(input(codex, extra));
  // minimum observations: four is too few at the default, enough at 3, and 5 with an explicit default is the same trace
  expect(verdict(approved(4)).verdict).toBe("unknown");
  expect(verdict(approved(4)).trace.join("\n")).toContain("have 4 measured task(s) with this profile; 5 are needed".replace("have", "codex has"));
  expect(verdict(approved(4), { minObservations: 3 }).verdict).not.toBe("unknown");
  expect(verdict(approved(4), { minObservations: 3 }).trace.join("\n")).not.toContain("are needed");
  expect(verdict(approved(5))).toEqual(verdict(approved(5), { minObservations: 5, maxFailureShare: 0.3 }));
  expect(verdict(approved(5), { minObservations: 6 }).trace.join("\n")).toContain("codex has 5 measured task(s) with this profile; 6 are needed");
  // failed share: 3 of 10 (exactly 0.3) is allowed, 4 of 10 is not, unless the share allows it
  const history = (bad: number) => [...approved(10 - bad), ...failed(bad)];
  expect(verdict(history(3)).trace.join("\n")).not.toContain("recorded tasks failed");
  expect(verdict(history(4)).verdict).toBe("unknown");
  expect(verdict(history(4)).trace.join("\n")).toContain("4 of 10 of codex's recorded tasks failed");
  expect(verdict(history(4), { maxFailureShare: 0.4 }).trace.join("\n")).not.toContain("recorded tasks failed");
  expect(verdict(history(3), { maxFailureShare: 0.2 }).trace.join("\n")).toContain("3 of 10 of codex's recorded tasks failed");
});

/** The real Tasks flow with a turn-free overlap, as test/tasks.test.ts drives the shadow prediction: explain() names the threshold the prediction used. */
async function splitTrace(extra: Partial<ConstructorParameters<typeof Tasks>[0]>): Promise<string> {
  class Idle extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }
  const dir = mkdtempSync(join(tmpdir(), "ahub-operational-split-"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Idle(id); bus.add(peer); await peer.start(); }
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, tell: () => {}, turnFree: () => true, wipLimit: () => 5,
    splitProfile: p => `hub 0.12.5; ${p} 1.0.0; turn-free`, sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) }, ...extra });
  cleanup.push(() => { tasks.stopCiWatchers(); tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  await tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
  const routed = await tasks.propose("claude", { title: "routed part", class: "implement", refs: { paths: ["src/a.ts"] } });
  return tasks.explain(routed.id).join("\n");
}
test("#489 H2 the shadow split prediction in a real Tasks flow reads both settings at the call, and unset prints the old thresholds", async () => {
  const unset = await splitTrace({});
  expect(unset).toContain(`unknown: codex has 0 measured task(s) with this profile; ${SPLIT_MIN} are needed`);
  expect(await splitTrace({ splitMinObservations: () => 5, splitMaxFailureShare: () => 0.3 })).toBe(unset);
  expect(await splitTrace({ splitMinObservations: () => 8 })).toContain("codex has 0 measured task(s) with this profile; 8 are needed");
  expect(await splitTrace({ splitMinObservations: () => 3 })).toContain("codex has 0 measured task(s) with this profile; 3 are needed");
  const live = { min: 4 };
  const trace = await splitTrace({ splitMinObservations: () => live.min });
  expect(trace).toContain("; 4 are needed");
});

/**
 * Real measured history for one peer: `approved` tasks it took through accept and done, and `failed` ones it was handed and lost to a changes_requested. Then a routed task that overlaps another peer's open one, whose
 * explain() carries the prediction trace. The clock is held so the work times are exact.
 */
async function splitHistoryTrace(approved: number, failed: number, extra: Partial<ConstructorParameters<typeof Tasks>[0]>): Promise<string> {
  class Taking extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }
  const dir = mkdtempSync(join(tmpdir(), "ahub-operational-split-history-"));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Taking(id); bus.add(peer); await peer.start(); }
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, tell: () => {}, turnFree: () => true, wipLimit: () => 32,
    splitProfile: p => `hub 0.12.5; ${p} 1.0.0; turn-free`, sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) }, ...extra });
  cleanup.push(() => { tasks.stopCiWatchers(); tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  let now = 1_800_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    for (let i = 0; i < approved; i++) {
      const t = await tasks.propose("claude", { title: `ok ${i}`, class: "implement", owner: "codex" });
      now += 10_000; tasks.accept("codex", t.id); now += 40_000;
      await tasks.done("codex", t.id, "done"); await tasks.review(board.get(t.id)!.reviewer!, t.id, "approved");
    }
    for (let i = 0; i < failed; i++) {
      const t = await tasks.propose("claude", { title: `bad ${i}`, class: "implement", owner: "codex" });
      await tasks.done("codex", t.id, "done"); await tasks.review(board.get(t.id)!.reviewer!, t.id, "changes_requested", "no");
      await tasks.cancel(t.id, USER, { reason: "close the failed card" }); // closed, so it is not open work for the pair; its failed handover stays in the record
    }
    await tasks.propose("claude", { title: "kimi's part", class: "implement", owner: "kimi", refs: { paths: ["src/a.ts"] } });
    const routed = await tasks.propose("claude", { title: "routed part", class: "implement", owner: "codex", refs: { paths: ["src/a.ts"] } });
    return tasks.explain(routed.id).join("\n");
  } finally { Date.now = realNow; }
}
test("#489 H2 the failed-share setting changes the real prediction: 1 failed of 6 (0.167) is allowed at 0.3 and refused at 0.1, and unset is 0.3", async () => {
  // five approved is the minimum, and the minimum is checked first, so the history needs five measured tasks to reach the failed-share rule
  const unset = await splitHistoryTrace(5, 1, {});
  expect(unset).not.toContain("recorded tasks failed");
  expect(unset).not.toContain("codex has"); // codex passes both rules; the prediction moves on to kimi, who has no history (the pair is only as measured as its weaker peer)
  expect(unset).toContain("unknown: kimi has 0 measured task(s) with this profile; 5 are needed");
  expect(await splitHistoryTrace(5, 1, { splitMaxFailureShare: () => 0.3 })).toBe(unset);
  const strict = await splitHistoryTrace(5, 1, { splitMaxFailureShare: () => 0.1 });
  expect(strict).toContain("1 of 6 of codex's recorded tasks failed");
  expect(strict).not.toBe(unset);
  // and the minimum setting reaches it too: the same history is too short for 6
  expect(await splitHistoryTrace(5, 1, { splitMinObservations: () => 6 })).toContain("codex has 5 measured task(s) with this profile; 6 are needed");
});

test("#489 H2 rescreen: unset is ten attempts, an explicit ten is identical, and a live value bounds how often one unknown task is screened again", async () => {
  expect(RESCREEN_MAX).toBe(10);
  const attempts = async (max?: () => number): Promise<number> => {
    const r = await piiRig(async () => ({ label: "unknown", miss: "off campus", ms: 1 }), max ? { rescreenMax: max } : {});
    const task = await r.tasks.propose("claude", { title: "fix the printer", class: "implement" });
    expect(r.board.get(task.id)).toMatchObject({ owner: null, signals: ["pii"] });
    const before = r.screened.length;
    for (let i = 0; i < 25; i++) await r.tasks.rescreen();
    return r.screened.length - before;
  };
  expect(await attempts()).toBe(10);
  expect(await attempts(() => 10)).toBe(10);
  expect(await attempts(() => 3)).toBe(3);
  expect(await attempts(() => 1)).toBe(1);
  expect(await attempts(() => 20)).toBe(20);
  // read at each call: raising the limit after the task used its tries lets it be screened again
  const live = { max: 2 };
  const r = await piiRig(async () => ({ label: "unknown", miss: "off campus", ms: 1 }), { rescreenMax: () => live.max });
  await r.tasks.propose("claude", { title: "fix the printer", class: "implement" });
  const base = r.screened.length;
  for (let i = 0; i < 6; i++) await r.tasks.rescreen();
  expect(r.screened.length - base).toBe(2);
  live.max = 4;
  for (let i = 0; i < 6; i++) await r.tasks.rescreen();
  expect(r.screened.length - base).toBe(4);
});

/** A Tasks with the PII screen on and a screener that always answers, the way test/pii-screen.test.ts builds it (no local peer, so nobody can take a PII task). */
async function piiRig(screener: (text: string) => Promise<PiiVerdict>, extra: Partial<ConstructorParameters<typeof Tasks>[0]>) {
  class Idle extends BasePeer { async deliver() {} async start() { this.setState("idle"); } async stop() {} }
  const dir = mkdtempSync(join(tmpdir(), "ahub-operational-rescreen-"));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace('pii_screen = "off"', 'pii_screen = "local"'));
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Idle(id); bus.add(peer); await peer.start(); }
  const screened: string[] = [];
  const board = new Board(join(dir, "hub.db"));
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "agent-hub", notify: () => {}, triage: { classify: async () => "implement", onCampus: async () => true },
    piiScreen: (text: string) => (screened.push(text), screener(text)), sdlc: { config: () => sdlcConfig({ mode: "advise" }), gh: async () => ({ code: 1, stdout: "" }) }, ...extra });
  cleanup.push(() => { tasks.stopCiWatchers(); tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { board, tasks, screened };
}

test("#489 H2 the readers the daemon hands Tasks give the default when unset, the configured value when set, and read the CURRENT config at every call", () => {
  const live: { tasks: Record<string, number | undefined> } = { tasks: {} };
  const read = taskOperationalReaders(() => live as never);
  const defaults = { demoteAt: 1.5, demotionHalfLifeH: 24, contradictionWindowDays: 7, rescreenMax: 10, splitMinObservations: 5, splitMaxFailureShare: 0.3 };
  const values = () => Object.fromEntries(Object.entries(read).map(([k, f]) => [k, f()]));
  expect(values()).toEqual(defaults); // independent literals: the constants these six replaced
  expect(Object.keys(read).sort()).toEqual(Object.keys(defaults).sort());
  const keys = { demoteAt: "demote_at", demotionHalfLifeH: "demotion_half_life_h", contradictionWindowDays: "contradiction_window_days", rescreenMax: "rescreen_max", splitMinObservations: "split_min_observations", splitMaxFailureShare: "split_max_failure_share" } as const;
  // each reader reads ITS OWN leaf: setting one changes exactly that one, to exactly that value
  for (const [reader, leaf] of Object.entries(keys)) {
    live.tasks = { [leaf]: 77 };
    expect(values()).toEqual({ ...defaults, [reader]: 77 });
  }
  live.tasks = { demote_at: 2 }; expect(read.demoteAt()).toBe(2);
  live.tasks = { demote_at: 3 }; expect(read.demoteAt()).toBe(3); // not cached
  live.tasks = {}; expect(read.demoteAt()).toBe(1.5);
});

test("#489 H2 a real daemon: the six values start at their defaults and a settings write reaches the Tasks the daemon built, live and without a restart", async () => {
  const f = project();
  writeFileSync(f.shared, JSON.stringify({ memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { auto_start: false }, research: { enabled: false }, snapshots: { enabled: false } }));
  // implement goes to codex or kimi only, both attached below as idle fakes, so route_explain has candidates to demote
  writeFileSync(join(f.cwd, ".agenthub/routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"').replace('[classes.implement]\npeers = ["pi", "local", "codex", "kimi"]', '[classes.implement]\npeers = ["codex", "kimi"]'));
  const daemon = await startDaemon({ cwd: f.cwd, stateDir: f.state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0 });
  cleanup.push(() => daemon.stop());
  for (const id of ["codex", "kimi"]) { const peer = new Idle(id); daemon.bus.add(peer); await peer.start(); }
  const client = await ControlClient.connect(f.state, { role: "console", projectRoot: f.cwd });
  cleanup.push(() => client.close());
  const rows = async () => Object.fromEntries((await client.request({ t: "settings_get" })).rows.filter((r: { key: string }) => KEYS.includes(r.key as never)).map((r: { key: string; value: number; applies: string; min: number; max: number }) => [r.key, r]));
  const initial = await rows();
  expect(Object.fromEntries(Object.entries(initial).map(([k, r]) => [k, (r as { value: number }).value]))).toEqual({ "tasks.demote_at": 1.5, "tasks.demotion_half_life_h": 24, "tasks.contradiction_window_days": 7, "tasks.rescreen_max": 10, "tasks.split_min_observations": 5, "tasks.split_max_failure_share": 0.3 });
  for (const key of KEYS) expect(initial[key]).toMatchObject({ applies: "live", min: operationalNumber(key)!.min, max: operationalNumber(key)!.max });
  const instance = (await client.request({ t: "status" })).status.instanceId;
  // a demotion the explain trace names: two fresh failures demote codex at the default 1.5, and not at 5
  const db = new (await import("bun:sqlite")).Database(join(f.state, "hub.db"));
  const now = Date.now();
  for (const at of [now - 60_000, now - 30_000]) db.query("INSERT INTO outcomes (peer, class, ok, at) VALUES ('codex', 'implement', 0, ?)").run(at);
  db.close();
  const explain = async () => (await client.request({ t: "task", op: "route_explain", args: { title: "next piece", class: "implement" } })).text as string;
  expect(await explain()).toContain("demoted for implement: codex");
  expect((await client.request({ t: "settings_set", key: "tasks.demote_at", value: 5, reason: "operational H2 regression" })).ok).toBe(true);
  expect(await explain()).not.toContain("demoted for implement: codex"); // the very next read, no restart
  expect((await client.request({ t: "settings_set", key: "tasks.demote_at", value: null, reason: "inherit" })).ok).toBe(true);
  expect(await explain()).toContain("demoted for implement: codex");
  expect((await client.request({ t: "settings_set", key: "tasks.demote_at", value: 0, reason: "below the bound" })).ok).toBe(false);
  expect((await client.request({ t: "status" })).status.instanceId).toBe(instance);
}, 30_000);
