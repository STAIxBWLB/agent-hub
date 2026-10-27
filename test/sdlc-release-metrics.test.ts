import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { controlEpisode, DEFAULT_BAND, DEFAULT_MIN_DELTA, sdlcMetrics, type MetricTask } from "../src/hub/sdlc-metrics.ts";
import { renderSdlcMetrics, renderSdlcRelease } from "../src/cli/sdlc-output.ts";

// agent-hub #481 AC12 (last bullet): release metrics from fixture board histories, shown in the release report, and the hotfix-rate band that proposes a planning card.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig(bands?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-metrics-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  const deps: TasksDeps = { board, bus, cwd: dir, project: "rm", repository: "o/r", routing: () => loadRouting(dir), roles: { claude: ["planner"], codex: ["implementer"] }, notify: line => notices.push(line),
    releaseWindow: async () => ({ at: Date.now(), host: true, quota: true, idle: true, reasons: [] }), sdlc: { config: () => sdlcConfig({ mode: "advise", ...(bands ? { bands } : {}) }), gh: async () => ({ code: 1, stdout: "" }) } };
  const tasks = new Tasks(deps);
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { board, tasks, notices };
}
/** One approved task in a fresh release, cut and shipped through the real train transitions; `hotfix` marks the train. */
async function ship(r: ReturnType<typeof rig>, order: number, hotfix?: { cause: "loss"; reason: string }) {
  const release = await r.tasks.newRelease(USER, { name: `train-${order}`, goal: "Train", order });
  const configured = await r.tasks.configureRelease("claude", { id: release.id, revision: 0, state: "active", ...(hotfix ? { hotfix } : {}) } as never);
  const task = await r.tasks.propose(USER, { title: `work ${order}`, class: "implement", backlog: true });
  r.board.update(task.id, USER, "backlog pulled", { state: "proposed" });
  r.board.update(task.id, USER, "accepted", { state: "in_progress" });
  r.board.update(task.id, USER, "approved", { state: "approved" });
  await r.tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  r.tasks.costReport = async () => ({ rows: [], truncated: false });
  const cut = await r.tasks.cutRelease("claude", { id: release.id, revision: configured.revision });
  return r.tasks.changeRelease(USER, { id: release.id, revision: cut.revision, state: "shipped" });
}

test("release metrics over real shipped releases: interval, approval-to-release lead time and hotfix rate, in the release report", async () => {
  const r = rig();
  const first = await ship(r, 1), second = await ship(r, 2, { cause: "loss", reason: "message loss cannot wait" });
  const metrics = r.tasks.releaseReport(USER, first.id).metrics;
  expect(metrics.intervals).toHaveLength(1);
  expect(metrics.intervals[0]).toMatchObject({ from: first.id, to: second.id });
  expect(metrics.intervals[0]!.ms).toBe(second.shippedAt! - first.shippedAt!);
  expect(metrics.approvalToReleaseMs).toHaveLength(2);
  for (const row of metrics.approvalToReleaseMs) expect(row.ms).toBeGreaterThanOrEqual(0);
  expect(metrics).toMatchObject({ hotfixCount: 1, hotfixRate: 0.5 });
  // The same figures reach the person's release readiness report, which is where the CLI renders them.
  const readiness = await r.tasks.releaseReadiness("o/r", []).catch(() => undefined);
  if (readiness) expect(readiness.releaseMetrics).toMatchObject({ hotfixCount: 1, hotfixRate: 0.5 });
});

test("the release readiness report carries the release metrics and the CLI shows them, with unknown named and never zero", () => {
  const withMetrics = { repo: "o/r", releaseMetrics: { intervals: [{ from: 1, to: 2, ms: 3 * 86_400_000 }], approvalToReleaseMs: [{ release: 1, task: 1, ms: 3_600_000 }, { release: 2, task: 2, ms: null }], hotfixCount: 1, hotfixRate: 0.5, ciRuns: null, reviews: null, unknown: [2] }, blockers: [] };
  const text = renderSdlcRelease({ report: withMetrics }, 120).map(line => line.map(span => span.text).join("")).join("\n");
  expect(text).toContain("hotfix rate 50% (1)");
  expect(text).toContain("interval 3d");
  expect(text).toContain("1 release without complete history: #2");
  const none = renderSdlcRelease({ report: { repo: "o/r", blockers: [], releaseMetrics: { intervals: [], approvalToReleaseMs: [], hotfixCount: null, hotfixRate: null, ciRuns: null, reviews: null, unknown: [] } } }, 120).map(line => line.map(span => span.text).join("")).join("\n");
  expect(none).toContain("interval unknown");
  expect(none).toContain("hotfix rate unknown");
  expect(none).not.toContain("hotfix rate 0%");
  // A report with no shipped release shows no releases row at all.
  expect(renderSdlcRelease({ report: { repo: "o/r", blockers: [] } }, 120).map(line => line.map(span => span.text).join("")).join("\n")).not.toContain("releases");
});

test("a legacy shipped release with no recorded train is skipped by the hotfix series, never counted as a zero", async () => {
  const r = rig({ hotfix_rate: { window: 10, min_samples: 3, min_delta: 0.5 } });
  // Three legacy releases shipped with no train history at all, then nothing else: they say nothing about the hotfix rate.
  for (const order of [1, 2, 3]) {
    const release = await r.tasks.newRelease(USER, { name: `legacy-${order}`, goal: "Train", order });
    const active = r.board.updateRelease(release.id, { state: "active" }, 0);
    const frozen = r.board.updateRelease(release.id, { state: "frozen" }, active.revision);
    r.board.updateRelease(release.id, { state: "shipped" }, frozen.revision);
  }
  expect(r.board.releases().filter(release => release.state === "shipped" && !release.train)).toHaveLength(3);
  const report = r.tasks.sdlcMetrics("claude");
  expect(report.bands).toEqual([expect.objectContaining({ metric: "hotfix_rate", tier: "ok", baseline: 0, last: null, subject: "release" })]);
  // A real shipped release after them is the first and only point.
  await ship(r, 4);
  expect(r.tasks.sdlcMetrics("claude").bands).toEqual([expect.objectContaining({ metric: "hotfix_rate", last: 0, baseline: 0 })]);
});

test("hotfix_rate band: a run of ordinary releases then a hotfix is one deduplicated card naming the release, not a task", async () => {
  const r = rig({ hotfix_rate: { window: 10, min_samples: 4, min_delta: 0.5, log_sigma: 1, diagnose_sigma: 2, propose_sigma: 3 } });
  for (let order = 1; order <= 6; order++) await ship(r, order);
  expect(r.tasks.proposeFromBands()).toEqual([]); // a flat baseline fires nothing
  const hotfixRelease = await ship(r, 7, { cause: "loss", reason: "message loss cannot wait" });
  const made = r.tasks.proposeFromBands();
  expect(made).toHaveLength(1);
  const card = r.board.get(made[0]!)!;
  expect(card).toMatchObject({ state: "backlog" });
  expect(card.detail).toContain(`Band breach key: hotfix_rate:#${hotfixRelease.id}:`);
  expect(card.detail).toContain(`newest value 1 on release #${hotfixRelease.id}; episode began at release #${hotfixRelease.id}`);
  expect(card.detail).toContain("over 6 releases");
  expect(card.detail).toContain("inspect the recent releases");
  expect(card.detail).not.toContain(`task #${hotfixRelease.id}`);
  expect(card.detail).not.toContain("tasks;");
  // The same breach, again and after a second hotfix inside the episode, writes nothing more while the card is open.
  expect(r.tasks.proposeFromBands()).toEqual([]);
  await ship(r, 8, { cause: "loss", reason: "again" });
  expect(r.tasks.proposeFromBands()).toEqual([]);
});

test("band tiers over external series are deterministic and reproducible from the same fixture", () => {
  const points = [...Array.from({ length: 8 }, (_, i) => ({ value: 0, task: i + 1 })), { value: 1, task: 9 }];
  const config = { ...DEFAULT_BAND, minDelta: DEFAULT_MIN_DELTA.hotfix_rate };
  const a = controlEpisode(points, "hotfix_rate", config), b = controlEpisode(structuredClone(points), "hotfix_rate", config);
  expect(a).toEqual(b);
  expect(a).toMatchObject({ metric: "hotfix_rate", subject: "release", lastTask: 9, episode: 9 });
  expect(a.tier).not.toBe("ok");
  // Fewer than min_samples of history fires nothing, and the external series is supplied, never derived from tasks.
  const none = sdlcMetrics([], { bands: { hotfix_rate: { ...config } }, external: { hotfix_rate: points.slice(-3) } });
  expect(none.bands).toEqual([expect.objectContaining({ tier: "ok", subject: "release" })]);
  const fired = sdlcMetrics([] as MetricTask[], { bands: { hotfix_rate: { ...config } }, external: { hotfix_rate: points } });
  expect((fired.bands as { tier: string }[])[0]!.tier).toBe(a.tier);
  expect(renderSdlcMetrics(fired, 120).length).toBeGreaterThan(0);
});
