import { expect, test } from "bun:test";
import { overviewModel, type OverviewTask } from "../src/ui/overview-model.ts";
import { sdlcMetrics, taskSample } from "../src/hub/sdlc-metrics.ts";
import { DASHBOARD_VIEWS, dashboardView } from "../src/hub/ui.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 12);
type Hist = OverviewTask["history"];
const task = (id: number, owner: string | null, state: string, history: Hist, extra: Partial<OverviewTask> = {}): OverviewTask => {
  const sample = taskSample({ id, history: history.map(({ at, event }) => ({ at, event })) });
  return { id, title: `task ${id}`, state, owner, created: history[0]?.at ?? 0, history, firstPass: sample.first_pass_approval, sampleAt: sample.at, ...extra };
};
const fixture = (): OverviewTask[] => [
  task(1, "codex", "approved", [{ at: NOW - 2 * DAY, event: "accepted" }, { at: NOW - 2 * DAY + 1000, event: "plan reviewed" }, { at: NOW - DAY, event: "approved" }]),
  task(2, "codex", "in_progress", [{ at: NOW - 3 * DAY, event: "accepted" }, { at: NOW - DAY, event: "changes_requested" }, { at: NOW - 3600_000, event: "check failed" }]),
  task(3, "jcode", "in_review", [{ at: NOW - 5 * DAY, event: "accepted" }]),
  task(4, null, "proposed", [{ at: NOW - DAY, event: "proposed" }]),
  { id: 5, private: true, title: "SECRET patient", state: "in_progress", owner: "secretpeer", created: NOW, history: [{ at: NOW, event: "check failed" }] },
];

test("overview is a dashboard view", () => {
  expect(DASHBOARD_VIEWS).toContain("overview");
  expect(dashboardView("overview")).toBe("overview");
});

test("widgets have their windows and order", () => {
  const view = overviewModel({ tasks: fixture(), now: NOW });
  expect(view.throughput).toHaveLength(8);
  expect(view.pulse).toHaveLength(84);
  expect(view.throughput.at(-1)!.done).toBe(1);
  expect(view.throughput.reduce((sum, week) => sum + week.proposed, 0)).toBe(4);
  expect(view.pulse.reduce((sum, day) => sum + day.events, 0)).toBe(8);
  expect(view.workload).toEqual([{ peer: "codex", states: { in_progress: 1 }, open: 1 }, { peer: "jcode", states: { in_review: 1 }, open: 1 }]);
});

test("recent trouble is newest first, capped at 20, with stalls", () => {
  const view = overviewModel({ tasks: fixture(), stalls: [{ task: 3, kind: "no-writes" }], now: NOW });
  expect(view.trouble.map(row => row.kind)).toEqual(["check failed", "changes_requested", "stall"]);
  const many = Array.from({ length: 30 }, (_, i) => task(100 + i, "codex", "in_progress", [{ at: NOW - i * 1000, event: "check failed" }]));
  expect(overviewModel({ tasks: many, now: NOW }).trouble).toHaveLength(20);
});

test("an unknown figure is null and never 0", () => {
  const view = overviewModel({ tasks: fixture(), now: NOW });
  const jcode = view.health.find(row => row.peer === "jcode")!;
  expect(jcode.firstPass).toEqual({ n: 0, unknown: 1, rate: null });
  expect(view.health.every(row => row.turnErrors === null)).toBe(true);
  expect(overviewModel({ tasks: [], now: NOW }).health).toEqual([]);
});

test("a private task is counted and leaks nothing", () => {
  const view = overviewModel({ tasks: fixture(), stalls: [{ task: 5, kind: "no-writes" }], now: NOW });
  expect(view.withheld).toBe(1);
  const text = JSON.stringify(view);
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain("secretpeer");
  expect(view.trouble.some(row => row.task === 5)).toBe(false);
});

test("first-pass rate equals ahub sdlc metrics on the same fixture", () => {
  const tasks = fixture().filter(row => !row.private);
  const view = overviewModel({ tasks, now: NOW });
  const metrics = sdlcMetrics(tasks.map(row => ({ id: row.id, history: row.history })), { since: NOW - 30 * DAY });
  const n = view.health.reduce((sum, row) => sum + row.firstPass.n, 0);
  const known = view.health.flatMap(row => row.firstPass.rate === null ? [] : [row.firstPass.rate * row.firstPass.n]).reduce((a, b) => a + b, 0);
  expect(n).toBe(metrics.metrics.first_pass_approval.n);
  expect(n ? known / n : null).toBe(metrics.metrics.first_pass_approval.rate);
});
