import { expect, test } from "bun:test";
import { checkRoadmap, type RoadmapDriftInput } from "../src/hub/roadmap-check.ts";

test("each drift family is detectable and clean evidence stays clean", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: false,
    milestones: [{ id: 1, state: "done", openItems: true, mergedCode: true, mirrorDiff: true,
      specs: [{ id: "sample", state: "stale" }], tasks: [
        { id: 1, state: "in_progress", issue: "example/repo#1", issueState: "closed", feature: true, specIssue: true, mergedAt: null, unchangedSpecs: [] },
        { id: 2, state: "approved", issue: "example/repo#2", issueState: "open", feature: true, specIssue: true, mergedAt: 1000, unchangedSpecs: ["sample"] },
        { id: 3, state: "in_progress", issue: null, issueState: "open", feature: true, specIssue: false, mergedAt: null, unchangedSpecs: [] },
      ] }] };
  expect([...new Set(checkRoadmap(input).findings.map(row => row.rule))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(checkRoadmap(input).findings.filter(row => row.rule === 6).map(row => row.cause)).toEqual(["feature task has no spec issue", "task has no issue"]);
  const clean: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: true,
    milestones: [{ id: 1, state: "active", openItems: true, mergedCode: true, mirrorDiff: false,
      specs: [{ id: "sample", state: "fresh" }], tasks: [{ id: 1, state: "approved", issue: "example/repo#1", issueState: "closed", feature: true, specIssue: true, mergedAt: 1000, unchangedSpecs: [] }] }] };
  expect(checkRoadmap(clean)).toEqual({ findings: [], unknown: [] });
});

test("unavailable evidence is unknown and merge close lag suppresses early findings", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: true, exportMatches: undefined,
    milestones: [{ id: 1, state: "active", openItems: undefined, mergedCode: undefined, mirrorDiff: undefined, specs: [], tasks: [
      { id: 1, state: "approved", issue: "example/repo#1", issueState: "open", feature: true, specIssue: true, mergedAt: 9500, unchangedSpecs: [] },
      { id: 2, state: "in_progress", issue: undefined, issueState: "unknown", feature: true, specIssue: undefined, mergedAt: undefined, unchangedSpecs: undefined },
    ] }] };
  expect(checkRoadmap(input)).toEqual({ findings: [], unknown: [1, 2, 3, 4, 5, 6, 7, 8] });
});

test("a task known to have no issue does not need issue state evidence", () => {
  const input: RoadmapDriftInput = { now: 10_000, closeLagMs: 1000, mirrorEnabled: false, exportMatches: true,
    milestones: [{ id: 1, state: "active", openItems: true, mergedCode: false, mirrorDiff: undefined, specs: [], tasks: [
      { id: 1, state: "in_progress", issue: null, issueState: "unknown", feature: false, specIssue: false, mergedAt: null, unchangedSpecs: [] },
    ] }] };
  const result = checkRoadmap(input);
  expect(result.unknown).toEqual([]);
  expect(result.findings.map(row => row.rule)).toEqual([6]);
});

test("drift output is bounded and reports truncation instead of claiming completeness", () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, state: "in_progress", issue: null, issueState: "unknown" as const, feature: false, specIssue: false, mergedAt: null, unchangedSpecs: [] }));
  const result = checkRoadmap({ now: 10_000, closeLagMs: 1000, mirrorEnabled: false, exportMatches: true, milestones: [{ id: 1, state: "active", tasks: rows, openItems: true, mergedCode: false, specs: [], mirrorDiff: undefined }] });
  expect(result.findings).toHaveLength(100); expect(result.truncated).toBe(true);
});

test("Tasks check uses screened board evidence and the generated JSON without exposing private tasks", async () => {
  const { Board } = await import("../src/hub/board.ts");
  const { Bus } = await import("../src/hub/bus.ts");
  const { Tasks } = await import("../src/hub/tasks.ts");
  const { roadmapExport } = await import("../src/hub/roadmap-export.ts");
  const { loadRouting } = await import("../src/hub/routing.ts");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "roadmap-check-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ cwd: root, board, bus, project: "project", repository: "example/repo", routing: () => loadRouting(root), notify: () => {} });
  try {
    const milestone = board.newMilestone({ title: "Public", outcome: "Outcome", state: "active" }, "user");
    const feature = board.propose("user", { title: "feat: public feature", class: "implement" });
    const hidden = board.propose("user", { title: "PRIVATE_CANARY", class: "implement", signals: ["pii"] });
    board.linkMilestone(milestone.id, "task", String(feature.id), "user", milestone.revision);
    board.linkMilestone(milestone.id, "task", String(hidden.id), "user", board.milestone(milestone.id)!.revision);
    mkdirSync(join(root, "docs")); const rendered = roadmapExport(tasks.milestoneList("user"));
    writeFileSync(join(root, "docs/roadmap.json"), rendered.json); writeFileSync(join(root, "docs/roadmap.md"), rendered.markdown);
    const result = await tasks.roadmapCheck("user");
    expect(result.findings.filter(row => row.rule === 6).map(row => row.cause)).toEqual(["feature task has no spec issue", "task has no issue"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
    expect(JSON.stringify(result)).not.toContain(`task:${hidden.id}`);
    expect(result.findings.some(row => row.rule === 8)).toBe(false);
    writeFileSync(join(root, "docs/roadmap.md"), "stale\n");
    expect((await tasks.roadmapCheck("user")).findings.some(row => row.rule === 8)).toBe(true);
    writeFileSync(join(root, "docs/roadmap.md"), rendered.markdown); writeFileSync(join(root, "docs/roadmap.json"), "{}\n");
    expect((await tasks.roadmapCheck("user")).findings.some(row => row.rule === 8)).toBe(true);
  } finally { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an old merged task with an open issue yields one ids-only notice across repeated checks", async () => {
  const { Board } = await import("../src/hub/board.ts"); const { Bus } = await import("../src/hub/bus.ts"); const { Tasks } = await import("../src/hub/tasks.ts");
  const { loadRouting } = await import("../src/hub/routing.ts"); const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "roadmap-notice-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 }), head = "a".repeat(40);
  const gh = async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 7, state: "OPEN", createdAt: "2026-01-01T00:00:00Z", lastEditedAt: null } } } }) });
  const tasks = new Tasks({ cwd: root, board, bus, project: "project", repository: "example/repo", routing: () => loadRouting(root), roadmapGh: gh, notify: () => {} });
  try {
    const milestone = board.newMilestone({ title: "Public", outcome: "Outcome", state: "active" }, "user");
    const task = board.propose("user", { title: "feat: public task", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex", refs: { commit: head }, sdlc: { stage: "build", repo: "example/repo", issue: 7, pr: 8 } });
    board.update(task.id, "codex", "done", { state: "in_review", sdlc: { stage: "review", repo: "example/repo", issue: 7, pr: 8, mergeReadback: { repo: "example/repo", pr: 8, head, at: Date.now(), state: "merged", cost: { mergedAt: Date.now() - 2 * 24 * 60 * 60_000, ciRuns: 1, ciReruns: 0, reviews: 0 } } } });
    board.update(task.id, "user", "approved", { state: "approved" });
    board.linkMilestone(milestone.id, "task", String(task.id), "user", milestone.revision);
    const notices: unknown[] = [], send = (id: number, m: number | null, rule: number) => { if (rule !== 2) return false; notices.push({ id, m, rule }); return true; };
    expect(await tasks.roadmapNotify([task.id], send)).toBe(1);
    expect(await tasks.roadmapNotify([task.id], send)).toBe(0);
    expect(notices).toEqual([{ id: task.id, m: milestone.id, rule: 2 }]);
  } finally { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unrelated task write during an issue read does not invalidate roadmap evidence", async () => {
  const { Board } = await import("../src/hub/board.ts"); const { Bus } = await import("../src/hub/bus.ts"); const { Tasks } = await import("../src/hub/tasks.ts");
  const { loadRouting } = await import("../src/hub/routing.ts"); const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "roadmap-fence-")), board = new Board(join(root, "hub.db")), bus = new Bus({ batchMs: 0 });
  const unrelated = board.propose("user", { title: "Unrelated", class: "implement" });
  const gh = async () => { board.update(unrelated.id, "user", "accepted", { state: "in_progress", owner: "codex" }); return { code: 0, stdout: JSON.stringify({ data: { repository: { issue: { number: 7, state: "OPEN", createdAt: "2026-01-01T00:00:00Z", lastEditedAt: null } } } }) }; };
  const tasks = new Tasks({ cwd: root, board, bus, project: "project", repository: "example/repo", routing: () => loadRouting(root), roadmapGh: gh, notify: () => {} });
  try {
    const milestone = board.newMilestone({ title: "Public", outcome: "Outcome", state: "active" }, "user");
    const task = board.propose("user", { title: "Member", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress", owner: "codex", sdlc: { stage: "build", repo: "example/repo", issue: 7 } });
    board.linkMilestone(milestone.id, "task", String(task.id), "user", milestone.revision);
    const result = await tasks.roadmapCheck("user");
    expect(board.get(unrelated.id)?.state).toBe("in_progress");
    expect(result.findings.some(row => row.rule === 1)).toBe(false);
  } finally { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); }
});
