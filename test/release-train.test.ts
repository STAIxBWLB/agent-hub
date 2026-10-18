import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig(window?: TasksDeps["releaseWindow"], extra: Partial<TasksDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-train-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({ board, bus, cwd: dir, project: "train", routing: () => loadRouting(dir), roles: { claude: ["planner"] }, notify: () => {}, releaseWindow: window ?? (async () => ({ at: Date.now(), host: true, quota: true, idle: true, reasons: [] })), ...extra });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board };
}

test("a release-only assignment preserves approved/in-flight execution and cut requires approved scope", async () => {
  const { tasks, board } = rig();
  const release = await tasks.newRelease(USER, { name: "0.13.0", goal: "Train", order: 1 });
  const task = await tasks.propose(USER, { title: "fix", class: "implement", backlog: true });
  board.update(task.id, USER, "backlog pulled", { state: "proposed" });
  const active = board.update(task.id, USER, "accepted", { state: "in_progress", owner: "codex" });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "ship together" });
  expect(board.get(task.id)).toMatchObject({ state: active.state, owner: "codex", release: release.id });
  tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" });
  await expect(tasks.cutRelease("claude", { id: release.id, revision: 1 })).rejects.toThrow("approved");
  expect(board.release(release.id)?.state).toBe("active");
  board.update(task.id, USER, "approved", { state: "approved" });
  const cut = await tasks.cutRelease("claude", { id: release.id, revision: 1 });
  expect(cut).toMatchObject({ state: "frozen", train: { scope: [task.id] } });
  await expect(tasks.assignRelease("claude", { id: task.id, revision: 1, release: null, reason: "late" })).rejects.toThrow("frozen");
});

test("a date triggers due work but unfinished scope must move with a reason", async () => {
  const { tasks, board } = rig();
  const one = await tasks.newRelease(USER, { name: "one", goal: "Train", order: 1 });
  const two = await tasks.newRelease(USER, { name: "two", goal: "Next", order: 2 });
  const task = await tasks.propose(USER, { title: "late", class: "implement", backlog: true });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: one.id, reason: "scope" });
  tasks.changeRelease(USER, { id: one.id, revision: 0, state: "active", cut: 1 });
  expect(tasks.releaseReport("claude", one.id).readiness.trigger).toBe("planned_date");
  await expect(tasks.cutRelease("claude", { id: one.id, revision: 1 })).rejects.toThrow("approved");
  await expect(tasks.assignRelease("claude", { id: task.id, revision: 1, release: two.id, reason: "" })).rejects.toThrow("reason");
  await tasks.assignRelease("claude", { id: task.id, revision: 1, release: two.id, reason: "missed cut, next train" });
  expect(board.get(task.id)?.history.at(-1)?.note).toBe("missed cut, next train");
});

test("cut defers on unknown host/quota and pins scope across admission awaits", async () => {
  let releaseRead: (() => void) | undefined;
  const { tasks, board } = rig(async () => { releaseRead?.(); return { at: Date.now(), host: true, quota: false, idle: true, reasons: ["quota unknown"] }; });
  const release = await tasks.newRelease(USER, { name: "train", goal: "Train", order: 1 });
  const task = await tasks.propose(USER, { title: "done", class: "implement", backlog: true });
  board.update(task.id, USER, "backlog pulled", { state: "proposed" });
  board.update(task.id, USER, "accepted", { state: "in_progress" });
  board.update(task.id, USER, "done", { state: "approved" });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" });
  await expect(tasks.cutRelease("claude", { id: release.id, revision: 1 })).rejects.toThrow("quota unknown");
  releaseRead = () => { board.plan(task.id, USER, { release: null }, 1, "changed during admission"); };
  await expect(tasks.cutRelease("claude", { id: release.id, revision: 1 })).rejects.toThrow("changed");
  expect(board.release(release.id)?.state).toBe("active");
});

test("hotfix causes are enumerated, recorded, and never waive cut gates", async () => {
  const { tasks, board } = rig();
  const release = await tasks.newRelease(USER, { name: "hotfix", goal: "Restore delivery", order: 1 });
  await expect(tasks.configureRelease("claude", { id: release.id, revision: 0, hotfix: { cause: "small_fix", reason: "quick" } })).rejects.toThrow("hotfix");
  await tasks.configureRelease("claude", { id: release.id, revision: 0, hotfix: { cause: "loss", reason: "messages lost before delivery" } });
  expect(board.release(release.id)?.train?.hotfix?.cause).toBe("loss");
  await expect(tasks.cutRelease("claude", { id: release.id, revision: 1 })).rejects.toThrow();
  await expect(tasks.configureRelease("codex", { id: release.id, revision: 1 })).rejects.toThrow("planner");
});


test("real train transitions record shipment metrics and legacy activation cannot open a second configured train", async () => {
  const { tasks, board } = rig();
  const first = await tasks.newRelease(USER, { name: "first", goal: "Train", order: 1 });
  const second = await tasks.newRelease(USER, { name: "next", goal: "Future", order: 2 });
  const legacy = await tasks.newRelease(USER, { name: "legacy-future", goal: "Future", order: 3 });
  const configured = await tasks.configureRelease("claude", { id: first.id, revision: 0, state: "active" });
  await tasks.configureRelease("claude", { id: second.id, revision: 0 });
  expect(() => tasks.changeRelease(USER, { id: second.id, revision: 1, state: "active" })).toThrow("one open");
  expect(() => tasks.changeRelease(USER, { id: legacy.id, revision: 0, state: "active" })).toThrow("one open");
  const task = await tasks.propose(USER, { title: "fix", class: "implement", backlog: true });
  board.update(task.id, USER, "backlog pulled", { state: "proposed" });
  board.update(task.id, USER, "accepted", { state: "in_progress" });
  board.update(task.id, USER, "approved", { state: "approved", sdlc: { repo: "owner/repo", pr: 1, stage: "review" } });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: first.id, reason: "scope" });
  tasks.costReport = async () => ({ rows: [{ repo: "owner/repo", pr: 1, ciRuns: 2, ciReruns: 1 }], truncated: false });
  expect(() => tasks.changeRelease(USER, { id: first.id, revision: configured.revision, state: "frozen" })).toThrow("resource-admitted");
  const cut = await tasks.cutRelease("claude", { id: first.id, revision: configured.revision });
  const shipped = tasks.changeRelease(USER, { id: first.id, revision: cut.revision, state: "shipped" });
  expect(shipped.train?.history.at(-1)).toMatchObject({ event: "shipped", by: USER, at: shipped.shippedAt });
  expect(tasks.releaseReport(USER, first.id).metrics).toMatchObject({ ciRuns: 3, reviews: 1, unknown: [] });
  expect(tasks.releaseReport(USER, first.id).metrics.approvalToReleaseMs[0]?.ms).toBeNumber();
});

test("public release creation rechecks a private turn after its screening await", async () => {
  let privateTurn = false;
  const { tasks, board } = rig(undefined, { routing: () => { const routing = loadRouting(process.cwd()); return { ...routing, signals: { ...routing.signals, pii_screen: "local" }, constraints: { ...routing.constraints, pii: "local_only" } }; }, privateTurn: () => privateTurn, piiScreen: async () => { privateTurn = true; return { label: "clear", ms: 0 }; } });
  await expect(tasks.newRelease("claude", { name: "train", goal: "Public plan", order: 1 })).rejects.toThrow("private turn");
  expect(board.releases()).toEqual([]);
});

test("admission lease is closed when final host evidence is revoked", async () => {
  let closed = 0;
  const { tasks, board } = rig(async () => ({ at: Date.now(), host: true, quota: true, idle: true, reasons: [], current: () => false, close: async () => { closed++; } }));
  const release = await tasks.newRelease(USER, { name: "train", goal: "Train", order: 1 });
  const task = await tasks.propose(USER, { title: "fix", class: "implement", backlog: true });
  board.update(task.id, USER, "backlog pulled", { state: "proposed" }); board.update(task.id, USER, "accepted", { state: "in_progress" }); board.update(task.id, USER, "done", { state: "approved" });
  await tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "scope" });
  tasks.changeRelease(USER, { id: release.id, revision: 0, state: "active" });
  await expect(tasks.cutRelease("claude", { id: release.id, revision: 1 })).rejects.toThrow("deferred");
  expect(board.release(release.id)?.state).toBe("active"); expect(closed).toBe(1);
});

test("train cut dates reject malformed direct inputs before any board write", async () => {
  const { tasks, board } = rig();
  const release = await tasks.newRelease(USER, { name: "dated", goal: "Train", order: 1 });
  const dated = await tasks.configureRelease("claude", { id: release.id, revision: 0, cut: 1234 });
  for (const cut of [null, false, "2000", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 8_640_000_000_000_001]) {
    const invalid = { id: release.id, revision: dated.revision, cut } as unknown as Parameters<Tasks["configureRelease"]>[1];
    const error = await tasks.configureRelease("claude", invalid).catch(error => error);
    expect(error).toBeInstanceOf(PreEffectToolRefusal);
    expect(board.release(release.id)).toEqual(dated);
  }
});
