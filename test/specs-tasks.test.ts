import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_SPECS_CONFIG, type SpecsCheckReport } from "../src/hub/specs.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { TASK_TOOLS } from "../src/hub/hub-tools.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

const HEAD = "a".repeat(40);
const baseReport = (head = HEAD) => ({ head, complete: true, errors: 0, unchanged: [{ id: "bus", path: "docs/design/bus.md", title: "Bus" }], changed: [] });

function fixture(review: "report" | "require" | "off" = "report", options: { complete?: boolean; privateTurn?: (peer: string) => boolean; specsRead?: TasksDeps["specsRead"]; specNotice?: TasksDeps["specNotice"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-specs-tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Board(join(dir, "hub.db"));
  cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  const config = { ...DEFAULT_SPECS_CONFIG, review };
  let inspected: { head: string; changed: readonly unknown[] | undefined; acks: readonly { id: string; reason: string }[] }[] = [];
  const report = { ...baseReport(), ...(options.complete === false ? { complete: false, reason: "verified changed-file inventory unavailable" } : {}) };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {},
    piiScreen: async () => ({ label: "clear", ms: 0 }),
    specsConfig: () => config,
    ...(options.privateTurn ? { privateTurn: options.privateTurn } : {}),
    ...(options.specNotice ? { specNotice: options.specNotice } : {}),
    reviewBrief: task => ({ head: task.refs.commit ?? "", base: "origin/main", mergeBase: "b".repeat(40), reviewable: [{ path: "src/hub/bus.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [] }),
    inspectSpecs: async (_task, head, changed, acks) => { inspected.push({ head, changed, acks }); return { ...report, head }; },
    ...(options.specsRead ? { specsRead: options.specsRead } : {}),
  });
  const task = () => {
    const proposed = board.propose(USER, { title: "change bus", class: "implement", refs: { paths: ["src/hub/bus.ts"] } });
    return board.update(proposed.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress", refs: { paths: ["src/hub/bus.ts"], commit: HEAD } });
  };
  return { dir, board, bus, tasks, task, config, inspected: () => inspected };
}

test("report mode returns the unchanged covering spec and includes it in the review brief", async () => {
  const f = fixture();
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  expect(f.inspected()[0]).toMatchObject({ head: HEAD, changed: [{ path: "src/hub/bus.ts" }] });
  expect(f.tasks.resultLine(done)).toContain("spec not updated: bus (docs/design/bus.md)");
  expect(f.tasks.briefText(done)).toContain("spec not updated: bus (docs/design/bus.md)");
  expect(f.tasks.publicView(done).specReport).toMatchObject({ head: HEAD, unchanged: [{ id: "bus" }] });
});

test("proposal and acceptance notice lists only covering specs, and off suppresses it", () => {
  const notice = { specs: [{ id: "bus", path: "docs/design/bus.md", title: "Bus" }], errors: 0, truncated: false, items: [] };
  const f = fixture("report", { specNotice: () => notice });
  expect(f.tasks.specNotice(f.task(), "codex")).toContain("Spec: bus (docs/design/bus.md) - Bus");
  const disabled = fixture("off", { specNotice: () => notice });
  expect(disabled.tasks.specNotice(disabled.task(), "codex")).toBe("");
});

test("machine-local disable suppresses a stored report without changing task config", async () => {
  const f = fixture();
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  f.config.enabled = false;
  expect(f.tasks.resultLine(done)).not.toContain("spec not updated");
  expect(f.tasks.briefText(done)).not.toContain("spec not updated");
});

test("require refuses before a board write until every unchanged covering spec has a screened acknowledgement", async () => {
  const f = fixture("require");
  const source = f.task(), before = source.history.length;
  await expect(f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] })).rejects.toThrow(/spec not updated: bus/);
  expect(f.board.get(source.id)?.state).toBe("in_progress");
  expect(f.board.get(source.id)?.history.length).toBe(before);
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] }, undefined, [{ id: "bus", reason: "The contract is unchanged by this implementation." }]);
  expect(f.tasks.resultLine(done)).toContain("acknowledged: The contract is unchanged by this implementation.");
  expect(f.tasks.briefText(done)).toContain("acknowledged: The contract is unchanged by this implementation.");
});

test("require fails closed when the task head or changed-file inventory is not verified", async () => {
  const f = fixture("require", { complete: false });
  const source = f.task();
  await expect(f.tasks.done("codex", source.id, "updated the bus", { paths: ["src/hub/bus.ts"] })).rejects.toThrow(/spec coverage is unknown/);
  expect(f.board.get(source.id)?.state).toBe("in_progress");
  expect(f.inspected()[0]).toMatchObject({ head: "", changed: undefined });
});

test("a new task head invalidates a previous spec report", async () => {
  const f = fixture();
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  const refilled = f.board.update(done.id, USER, "head changed", { refs: { commit: "c".repeat(40) } });
  expect(f.tasks.resultLine(refilled)).not.toContain("spec not updated: bus");
  expect(f.tasks.publicView(refilled).specReport).toBeUndefined();
});

test("spec notices and read tools skip private context before calling the host", () => {
  let calls = 0;
  const f = fixture("report", { privateTurn: () => true, specsRead: () => { calls++; return { specs: [], errors: 0, truncated: false, items: [] }; } });
  expect(f.tasks.specNotice(f.task(), "codex")).toBe("");
  expect(() => f.tasks.specsRead("codex", "check")).toThrow(/private turn/);
  expect(calls).toBe(0);
});

test("hub_specs caps the combined diagnostic and summary projection at 20 items", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ severity: "warning" as const, code: `warning-${index}`, message: `message ${index}`, cause: "fixture cause", nextSteps: "inspect the spec" }));
  const report: SpecsCheckReport = { specCount: 25, errors: 0, warnings: 25, stale: 0, truncated: false, items: items.slice(0, 15),
    freshness: Array.from({ length: 10 }, (_, index) => ({ path: `docs/spec-${index}.md`, state: "fresh" as const, commitsSince: 0, dirty: false })) };
  const f = fixture("off", { specsRead: action => action === "check" ? report : { specs: [], errors: 0, truncated: false, items: [] } });
  const result = f.tasks.specsRead("codex", "check");
  expect(result).toMatchObject({ specCount: 25, warnings: 25, truncated: true });
  expect((result.items as unknown[]).length + (result.freshness as unknown[]).length).toBe(20);
  const covers = fixture("off", { specsRead: action => action === "covers"
    ? { specs: Array.from({ length: 10 }, (_, index) => ({ id: `spec-${index}`, path: `docs/spec-${index}.md`, title: `Spec ${index}` })), errors: 0, truncated: false, items: items.slice(0, 15) }
    : report });
  const covered = covers.tasks.specsRead("codex", "covers", ["src/hub/bus.ts"]);
  expect((covered.items as unknown[]).length + (covered.specs as unknown[]).length).toBe(20);
  expect(covered.truncated).toBe(true);
  expect(() => f.tasks.specsRead("codex", "covers", ["../outside.md"])).toThrow(/repository-relative/);
});

test("filtered private spec metadata makes a report incomplete instead of implying no coverage", async () => {
  const f = fixture("report");
  const source = f.task();
  const unsafe = { ...baseReport(), unchanged: [{ id: "bus", path: "private/design/bus.md", title: "Bus" }] };
  const tasks = new Tasks({ board: f.board, bus: f.bus, cwd: f.dir, project: "fixture", routing: () => loadRouting(f.dir), notify: () => {},
    piiPaths: ["private/**"], specsConfig: () => ({ ...DEFAULT_SPECS_CONFIG, review: "report" }),
    reviewBrief: task => ({ head: task.refs.commit ?? "", base: "origin/main", mergeBase: "b".repeat(40), reviewable: [{ path: "src/hub/bus.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [] }),
    inspectSpecs: async (_task, head) => ({ ...unsafe, head }),
  });
  const done = await tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  const publicReport = tasks.publicView(done).specReport as { complete: boolean; unchanged: unknown[]; reason?: string };
  expect(publicReport.complete).toBe(false);
  expect(publicReport.unchanged).toEqual([]);
  expect(publicReport.reason).toBe("some spec metadata could not be safely shown");
  expect(JSON.stringify(tasks.publicView(done))).not.toContain("private/design/bus.md");
});

test("tool schemas expose spec_ack and the read-only hub_specs operation", () => {
  const done = TASK_TOOLS.find(tool => tool.name === "hub_task_done")!;
  expect(done.inputSchema.properties).toHaveProperty("spec_ack");
  const specs = TASK_TOOLS.find(tool => tool.name === "hub_specs")!;
  expect(specs.inputSchema.required ?? []).toContain("action");
  expect((specs.inputSchema.properties.action as { enum?: string[] }).enum).toEqual(["check", "covers"]);
});
