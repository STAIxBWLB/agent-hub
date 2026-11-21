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

test("issue export applies only an exact preview and preserves the screened body", async () => {
  const { Board } = await import("../src/hub/board.ts");
  const { Bus } = await import("../src/hub/bus.ts");
  const { Tasks } = await import("../src/hub/tasks.ts");
  const { loadRouting } = await import("../src/hub/routing.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "roadmap-export-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const writes: string[][] = [];
  const tasks = new Tasks({ cwd: dir, board, bus, project: "project", repository: "example/repo", routing: () => loadRouting(dir), notify: () => {},
    roadmapGh: async args => { writes.push(args); return { code: 0, stdout: "{}" }; }, roadmapOrigin: () => "example/repo", roadmapConfig: () => ({ github_mirror: false, github_write: "off" }) });
  try {
    board.newMilestone({ title: "Public", outcome: "Outcome" }, "user");
    const preview = await tasks.roadmapExport("user", { issue: 1145 });
    expect(preview.call?.[1]).toBe("repos/example/repo/issues/1145");
    await expect(tasks.roadmapExport("user", { issue: 1145, apply: true })).rejects.toThrow("preview changed");
    await expect(tasks.roadmapExport("codex", { issue: 1145, apply: true, confirm: preview.fingerprint })).rejects.toThrow("require the person");
    expect(writes).toHaveLength(0);
    expect((await tasks.roadmapExport("user", { issue: 1145, apply: true, confirm: preview.fingerprint })).applied).toBe(true);
    expect(writes[0]).toContain(`body=${preview.markdown}`);
  } finally { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("R4 command forms keep read previews separate from confirmed writes", async () => {
  const { parseRoadmapArgs } = await import("../src/cli/roadmap.ts");
  const fingerprint = "a".repeat(64);
  expect(parseRoadmapArgs(["check", "--json"])).toEqual({ op: "hub_roadmap_check", args: {}, json: true });
  expect(parseRoadmapArgs(["sync"])).toEqual({ op: "roadmap_sync", args: {}, json: false });
  expect(parseRoadmapArgs(["sync", "--apply", "--confirm", fingerprint])).toEqual({ op: "roadmap_sync_apply", args: { apply: true, confirm: fingerprint }, json: false });
  expect(parseRoadmapArgs(["export", "--write"]).write).toBe(true);
  expect(parseRoadmapArgs(["export", "--issue", "1145", "--apply", "--confirm", fingerprint]).op).toBe("roadmap_export_apply");
  for (const bad of [["sync", "--apply"], ["export", "--apply", "--confirm", fingerprint], ["export", "--write", "--issue", "1"], ["check", "--apply"]]) expect(() => parseRoadmapArgs(bad)).toThrow();
});
