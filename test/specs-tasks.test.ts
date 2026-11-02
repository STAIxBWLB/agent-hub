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
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(condition()).toBe(true);
};

function fixture(review: "report" | "require" | "off" = "report", options: { complete?: boolean; hasHead?: boolean; piiTask?: boolean; enabled?: boolean; noConfig?: boolean; noInspector?: boolean; privateTurn?: (peer: string) => boolean; specsRead?: TasksDeps["specsRead"]; specNotice?: TasksDeps["specNotice"]; inspectSpecs?: TasksDeps["inspectSpecs"]; check?: TasksDeps["check"]; runCheck?: TasksDeps["runCheck"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-specs-tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const board = new Board(join(dir, "hub.db"));
  cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  const config = { ...DEFAULT_SPECS_CONFIG, review, ...(options.enabled === undefined ? {} : { enabled: options.enabled }) };
  let inspected: { head: string; changed: readonly unknown[] | undefined; acks: readonly { id: string; reason: string }[] }[] = [];
  const report = { ...baseReport(), ...(options.complete === false ? { complete: false, reason: "verified changed-file inventory unavailable" } : {}) };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", routing: () => loadRouting(dir), notify: () => {},
    piiScreen: async () => ({ label: "clear", ms: 0 }),
    ...(options.noConfig ? {} : { specsConfig: () => config }),
    ...(options.privateTurn ? { privateTurn: options.privateTurn } : {}),
    ...(options.specNotice ? { specNotice: options.specNotice } : {}),
    reviewBrief: task => ({ head: task.refs.commit ?? "", base: "origin/main", mergeBase: "b".repeat(40), reviewable: [{ path: "src/hub/bus.ts", status: "M" }], excluded: [], withheld: 0, rules: [], rulesMissing: [], ruleGroups: [], unlisted: [] }),
    ...(options.noInspector ? {} : { inspectSpecs: options.inspectSpecs ?? (async (_task, head, changed, acks) => { inspected.push({ head, changed, acks }); return { ...report, head }; }) }),
    ...(options.check ? { check: options.check } : {}),
    ...(options.runCheck ? { runCheck: options.runCheck } : {}),
    ...(options.specsRead ? { specsRead: options.specsRead } : {}),
  });
  const task = () => {
    const proposed = board.propose(USER, { title: "change bus", class: "implement", refs: { paths: ["src/hub/bus.ts"] }, ...(options.piiTask ? { signals: ["pii_path"] } : {}) });
    return board.update(proposed.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress", refs: { repo: "fixture/project", branch: "feature/specs", paths: ["src/hub/bus.ts"], ...(options.hasHead === false ? {} : { commit: HEAD }) } });
  };
  return { dir, board, bus, tasks, task, config, inspected: () => inspected };
}

test("report mode returns the unchanged covering spec and includes it in the review brief", async () => {
  const f = fixture();
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  expect(f.inspected()[0]).toMatchObject({ head: HEAD, changed: [{ path: "src/hub/bus.ts" }] });
  expect(done.refs).toMatchObject({ repo: "fixture/project", branch: "feature/specs", commit: HEAD });
  expect(f.tasks.resultLine(done)).toContain("spec not updated: bus (docs/design/bus.md)");
  expect(f.tasks.briefText(done)).toContain("spec not updated: bus (docs/design/bus.md)");
  const publicTask = f.tasks.publicView(done) as { specReport: { head: string; unchanged: unknown[] }; history: Record<string, unknown>[] };
  expect(publicTask.specReport).toMatchObject({ head: HEAD, unchanged: [{ id: "bus" }] });
  expect(publicTask.history.at(-1)).not.toHaveProperty("specRefBinding");
});

test("proposal and acceptance notice lists only covering specs, and off suppresses it", () => {
  const notice = { specs: [{ id: "bus", path: "docs/design/bus.md", title: "Bus" }], errors: 0, truncated: false, items: [] };
  const f = fixture("report", { specNotice: () => notice });
  expect(f.tasks.specNotice(f.task(), "codex")).toBe("Specs covering these paths: bus (docs/design/bus.md)");
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

test("an off-mode same-head re-review does not resurrect an older report when reporting returns", async () => {
  const f = fixture();
  const source = f.task();
  const firstDone = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  f.board.update(source.id, USER, "changes_requested", { state: "changes_requested", rejections: 1 }, "review requests one change");
  f.config.review = "off";
  const refiled = await f.tasks.done("codex", source.id, "updated the bus again", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  expect(refiled.history.findLast(entry => entry.event === "done")?.specReport).toBeUndefined();
  f.config.review = "report";
  expect(f.tasks.resultLine(refiled)).not.toContain("spec not updated");
  expect(f.tasks.publicView(refiled).specReport).toBeUndefined();
  expect(firstDone.history.findLast(entry => entry.event === "done")?.specReport).toBeDefined();
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
  const f = fixture("require", { complete: false, hasHead: false });
  const source = f.task();
  await expect(f.tasks.done("codex", source.id, "updated the bus", { paths: ["src/hub/bus.ts"] })).rejects.toThrow(/spec coverage is unknown/);
  expect(f.board.get(source.id)?.state).toBe("in_progress");
  expect(f.inspected()[0]).toMatchObject({ head: "", changed: undefined });
});

test("missing inspector preserves report/off/disabled/PII compatibility but fails closed for public require", async () => {
  const legacy = fixture("report", { noConfig: true, noInspector: true });
  const legacyTask = legacy.task();
  const legacyDone = await legacy.tasks.done("codex", legacyTask.id, "finished", { commit: HEAD });
  expect(legacy.tasks.resultLine(legacyDone)).not.toContain("Design specs at");

  const report = fixture("report", { noInspector: true });
  const reportTask = report.task();
  await expect(report.tasks.done("codex", reportTask.id, "finished", { commit: HEAD })).resolves.toBeDefined();

  const required = fixture("require", { noInspector: true });
  const publicTask = required.task();
  await expect(required.tasks.done("codex", publicTask.id, "finished", { commit: HEAD })).rejects.toThrow(/spec inspector is unavailable/);
  expect(required.board.get(publicTask.id)?.state).toBe("in_progress");

  const off = fixture("off", { noInspector: true });
  const offTask = off.task();
  await expect(off.tasks.done("codex", offTask.id, "finished", { commit: HEAD })).resolves.toBeDefined();

  const disabled = fixture("require", { noInspector: true, enabled: false });
  const disabledTask = disabled.task();
  await expect(disabled.tasks.done("codex", disabledTask.id, "finished", { commit: HEAD })).resolves.toBeDefined();

  const pii = fixture("require", { noInspector: true, piiTask: true });
  const piiTask = pii.task();
  const piiDone = await pii.tasks.done("codex", piiTask.id, "finished", { commit: HEAD });
  expect(pii.tasks.resultLine(piiDone)).not.toContain("Design specs at");
});

test("an asynchronous class check carries the verified spec report into the final done entry", async () => {
  let release!: (result: { code: number; timedOut: boolean; interrupted: boolean; tail: string }) => void;
  const gate = new Promise<{ code: number; timedOut: boolean; interrupted: boolean; tail: string }>(resolve => { release = resolve; });
  const f = fixture("report", { check: () => "fixture check", runCheck: async () => gate });
  const source = f.task();
  const pending = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  expect(pending.history.at(-1)).toMatchObject({ event: "done (checking)", specReport: { head: HEAD } });
  release({ code: 0, timedOut: false, interrupted: false, tail: "fixture ok" });
  await until(() => f.tasks.checksPending() === 0);
  const completed = f.board.get(source.id)!;
  expect(completed.history.findLast(entry => entry.event === "done")?.specReport).toMatchObject({ head: HEAD, unchanged: [{ id: "bus" }] });
});

test("a privacy-context change during spec inspection refuses before the done write", async () => {
  let privateTurn = false, started!: () => void, release!: (report: ReturnType<typeof baseReport>) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise<ReturnType<typeof baseReport>>(resolve => { release = resolve; });
  const f = fixture("report", { privateTurn: () => privateTurn, inspectSpecs: async (_task, head) => { started(); return { ...await result, head }; } });
  const source = f.task();
  const pending = f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  await waiting;
  privateTurn = true;
  release(baseReport());
  await expect(pending).rejects.toThrow(/privacy context changed/);
  expect(f.board.get(source.id)?.state).toBe("in_progress");
});

test("a policy change during spec inspection cannot admit under the new review mode", async () => {
  let started!: () => void, release!: (report: ReturnType<typeof baseReport>) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const result = new Promise<ReturnType<typeof baseReport>>(resolve => { release = resolve; });
  const f = fixture("report", { inspectSpecs: async (_task, head) => { started(); return { ...await result, head }; } });
  const source = f.task();
  const pending = f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  await waiting;
  f.config.review = "require";
  release(baseReport());
  await expect(pending).rejects.toThrow(/specs policy, task head or privacy context changed/);
  expect(f.board.get(source.id)?.state).toBe("in_progress");
});

test("a new task head invalidates a previous spec report", async () => {
  const f = fixture();
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus", { commit: HEAD, paths: ["src/hub/bus.ts"] });
  const refilled = f.board.update(done.id, USER, "head changed", { refs: { commit: "c".repeat(40) } });
  expect(f.tasks.resultLine(refilled)).not.toContain("spec not updated: bus");
  expect(f.tasks.publicView(refilled).specReport).toBeUndefined();
});

test("a mismatched host report cannot replace the task head or display foreign-head paths", async () => {
  const foreign = "b".repeat(40);
  const f = fixture("report", { inspectSpecs: async () => ({ ...baseReport(foreign) }) });
  const source = f.task();
  const done = await f.tasks.done("codex", source.id, "updated the bus");
  expect(done.refs).toMatchObject({ repo: "fixture/project", branch: "feature/specs", commit: HEAD });
  expect(f.tasks.resultLine(done)).toContain("Design specs at unknown:");
  expect(f.tasks.resultLine(done)).not.toContain(foreign);
  expect(f.tasks.resultLine(done)).not.toContain("docs/design/bus.md");
});

test("spec notices and reads suppress output if the privacy context changes during host inspection", () => {
  let calls = 0, privateTurn = false;
  const cover = { specs: [{ id: "bus", path: "docs/design/bus.md", title: "Bus" }], errors: 0, truncated: false, items: [] };
  const f = fixture("report", { privateTurn: () => privateTurn,
    specNotice: () => { privateTurn = true; return cover; },
    specsRead: () => { calls++; privateTurn = true; return { specs: [], errors: 0, truncated: false, items: [] }; } });
  expect(f.tasks.specNotice(f.task(), "codex")).toBe("");
  privateTurn = false;
  expect(() => f.tasks.specsRead("codex", "check")).toThrow(/private turn/);
  expect(calls).toBe(1);
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
    ? { specs: Array.from({ length: 10 }, (_, index) => index === 0 ? { id: "bus", path: "docs/design/bus.md", title: "Bus" } : ({ id: `spec-${index}`, path: `docs/spec-${index}.md`, title: `Spec ${index}` })), errors: 0, truncated: false, items: items.slice(0, 15) }
    : report });
  const covered = covers.tasks.specsRead("codex", "covers", ["src/hub/bus.ts"]);
  expect((covered.items as unknown[]).length + (covered.specs as unknown[]).length).toBe(20);
  expect((covered.specs as { id: string }[]).map(spec => spec.id)).toContain("bus");
  expect(covered.truncated).toBe(true);
  expect(() => f.tasks.specsRead("codex", "covers", ["../outside.md"])).toThrow(/repository-relative/);
  expect(() => f.tasks.specsRead("codex", "covers", ["src\\hub\\bus.ts"])).toThrow(/forward slashes/);
  expect(() => f.tasks.specsRead("codex", "covers")).toThrow(/needs at least one/);
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

test("Board persists the head-bound spec report and internal ref binding across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-specs-board-")), file = join(dir, "hub.db");
  let board = new Board(file);
  const proposed = board.propose(USER, { title: "change bus", class: "implement" });
  const accepted = board.update(proposed.id, "codex", "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
  const report = { ...baseReport(), unchanged: [{ id: "bus", path: "docs/design/bus.md", title: "Bus", reason: "The contract is unchanged." }] };
  const binding = "d".repeat(64);
  board.update(accepted.id, "codex", "done", { state: "in_review" }, "done", { specReport: report, specRefBinding: binding });
  board.close();
  board = new Board(file);
  try {
    expect(board.get(accepted.id)?.history.at(-1)).toMatchObject({ specReport: report, specRefBinding: binding });
  } finally {
    board.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
