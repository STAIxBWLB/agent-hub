import { expect, test } from "bun:test";
import { roadmapExport } from "../src/hub/roadmap-export.ts";
import { milestoneViews, type MilestoneView } from "../src/hub/roadmap-view.ts";
import type { Task } from "../src/hub/board.ts";

const progress = { tasks: { approved: 1, total: 2 }, issues: { closed: 0, total: 1, unknown: 1 },
  specs: { fresh: 0, stale: 0, unverified: 0, unknown: 0, total: 0 }, releases: { shipped: 0, total: 0, unknown: 0 } };
function view(id: number, horizon: "now" | "next" | "later"): MilestoneView {
  return { id, title: `Milestone ${id}`, outcome: "Outcome", state: "active", horizon, order: 0, target: null, parent: null,
    issues: [{ ref: "example/repo#3", state: "unknown" }], specs: [], rollup: progress, withheld: 1,
    tasks: [{ id: 8, title: "visible but not exported", state: "in_progress", placement: { rule: "explicit" } }],
    links: [], releases: [], children: [], history: [], revision: 1, created: 1, updated: 1 };
}

test("roadmap export is deterministic and contains only selected public view fields", () => {
  const a = view(2, "later"), b = view(1, "now");
  const first = roadmapExport([a, b]);
  expect(roadmapExport([b, a])).toEqual(first);
  expect(JSON.parse(first.json).milestones.map((row: { id: number }) => row.id)).toEqual([1, 2]);
  expect(first.json).not.toContain("visible but not exported");
  expect(first.markdown).not.toContain("visible but not exported");
  expect(first.markdown).toContain("example/repo#3: unknown");
});

test("a private task never reaches either export", () => {
  const source = view(1, "now");
  const task = { id: 8, title: "PRIVATE_CANARY", state: "in_progress" } as Task;
  const [projected] = milestoneViews({ milestones: [source], links: [{ milestone: 1, kind: "task", ref: "8", by: "user", at: 1 }],
    tasks: [task], releases: [], freshness: undefined, issueOf: () => undefined,
    privateTask: () => true, publicText: () => true });
  expect(projected?.withheld).toBe(1);
  const result = roadmapExport([projected!]);
  expect(result.json).not.toContain("PRIVATE_CANARY");
  expect(result.markdown).not.toContain("PRIVATE_CANARY");
});
