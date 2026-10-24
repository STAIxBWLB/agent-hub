import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { planningPatch } from "../src/hub/planning.ts";
import { sdlcConfig, type SdlcReceipt } from "../src/hub/sdlc.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const root = mkdtempSync(join(tmpdir(), "ahub-planning759-")), board = new Board(join(root, "hub.db"));
  const bus = new Bus({ batchMs: 0, rostered: peer => ["claude", "codex", "kimi"].includes(peer) });
  const config = sdlcConfig({ mode: "enforce", required_checks: [] }), screen = { enabled: false, run: async () => {} };
  const tasks = new Tasks({ board, bus, cwd: root, project: "owner/repo", repository: "owner/repo",
    roles: { claude: ["planner"], codex: ["planner"], kimi: ["implementer"] }, notify: () => {}, sdlc: { config: () => config },
    routing: () => { const routing = loadRouting(root); return { ...routing, signals: { ...routing.signals, pii_screen: screen.enabled ? "local" : "off" } }; },
    piiScreen: async () => { await screen.run(); return { label: "clear", ms: 0 }; } });
  const old: SdlcReceipt = { stage: config.stages[0]!, repo: "owner/repo", issue: 450 };
  const task = board.propose(USER, { title: "card", class: "implement", backlog: true, planner: "claude", refs: { repo: "owner/repo" } });
  board.update(task.id, USER, "fixture identity", { sdlc: old });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(root, { recursive: true, force: true }); });
  return { board, tasks, id: task.id, old, screen };
}
async function refused(r: ReturnType<typeof rig>, call: () => unknown | Promise<unknown>) {
  const before = JSON.stringify(r.board.get(r.id));
  let error: unknown; try { await call(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(PreEffectToolRefusal); expect(JSON.stringify(r.board.get(r.id))).toBe(before);
}

test("#759 omitted and empty planning fields record reason-only revisions without changing task fields", async () => {
  const r = rig(), before = r.board.get(r.id)!;
  const first = await r.tasks.planBacklog("claude", { id: r.id, revision: 0, reason: "record the grooming decision" });
  expect(first.planningRevision).toBe(1); expect(first.history.at(-1)).toMatchObject({ note: "record the grooming decision", planning: { fields: [], previous: {}, revision: 1 } });
  const second = await r.tasks.planBacklog("claude", { id: r.id, revision: 1, fields: {}, reason: "another note" });
  expect(second.planningRevision).toBe(2); expect(second.sdlc).toEqual(before.sdlc); expect(second.deps).toEqual(before.deps);
  expect(second.owner).toBe(before.owner); expect(second.planner).toBe(before.planner);
  expect((await r.tasks.undoPlanning("claude", r.id, 2)).planningRevision).toBe(3);
});

test("#759 only the effective planner or person relinks backlog issue identity in an atomic planning revision", async () => {
  const r = rig(), fields = { sdlc: { repo: "owner/repo", issue: 525 } };
  await refused(r, () => r.tasks.planBacklog("kimi", { id: r.id, revision: 0, fields, reason: "nonplanner" }));
  await refused(r, () => r.tasks.planBacklog("codex", { id: r.id, revision: 0, fields, reason: "wrong holder" }));
  const observed: unknown[] = []; r.board.onChange = task => { observed.push({ revision: task.planningRevision, issue: task.sdlc?.issue }); };
  const changed = await r.tasks.planBacklog("claude", { id: r.id, revision: 0, fields, reason: "spec consolidated" });
  expect(changed.sdlc).toMatchObject({ repo: "owner/repo", issue: 525, stage: r.old.stage });
  expect(changed.history.at(-1)).toMatchObject({ event: "planned", by: "claude", planning: { revision: 1, fields: ["sdlc"], previous: { sdlc: { repo: "owner/repo", issue: 450 } } } });
  expect(observed).toEqual([{ revision: 1, issue: 525 }]);
  expect((await r.tasks.planBacklog(USER, { id: r.id, revision: 1, fields: { sdlc: { issue: 754 } }, reason: "person relink" })).sdlc?.issue).toBe(754);
});

test("#759 relink drops spec acceptance and undo restores only identity without reviving consent", async () => {
  const r = rig();
  const acceptance = { repo: "owner/repo", issue: 450, createdAt: "2026-10-01T00:00:00.000Z", lastEditedAt: null, acceptedAt: 1 };
  r.board.update(r.id, USER, "fixture acceptance", { sdlc: { ...r.old, acceptance } });
  const changed = await r.tasks.planBacklog("claude", { id: r.id, revision: 0, fields: { sdlc: { issue: 525 } }, reason: "new spec" });
  expect(changed.sdlc?.acceptance).toBeUndefined();
  const undone = await r.tasks.undoPlanning("claude", r.id, 1);
  expect(undone.sdlc?.issue).toBe(450); expect(undone.sdlc?.acceptance).toBeUndefined();
});

test("#759 relink cannot change stage/evidence and generic lifecycle receipts still refuse backlog", async () => {
  const r = rig();
  for (const sdlc of [{ stage: "build" }, { reviewedHead: "a".repeat(40) }, { repo: "bad" }, { issue: 0 }, { issue: 2, acceptance: {} }]) {
    await refused(r, () => r.tasks.planBacklog("claude", { id: r.id, revision: 0, fields: { sdlc }, reason: "invalid identity" }));
  }
  expect(() => r.tasks.recordLifecycle(USER, r.id, { repo: "owner/repo", issue: 525 })).toThrow("backlog");
  await refused(r, () => r.tasks.planBacklog("claude", { id: r.id, revision: 0, fields: { startedAt: 1 }, reason: "invalid field" }));
  r.board.update(r.id, USER, "fixture proposed", { state: "proposed" });
  await refused(r, () => r.tasks.planBacklog(USER, { id: r.id, revision: 0, fields: { sdlc: { issue: 525 } }, reason: "outside backlog" }));
});

test("#759 relink rechecks the task planner after asynchronous screening", async () => {
  const r = rig(); let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { resume = resolve; });
  r.screen.enabled = true; r.screen.run = async () => { enter(); await barrier; };
  const pending = r.tasks.planBacklog("claude", { id: r.id, revision: 0, fields: { sdlc: { issue: 525 } }, reason: "screened relink" });
  const caught = pending.then(value => ({ value }), error => ({ error }));
  await entered; r.board.update(r.id, USER, "planner changed", { planner: "codex" }); const before = JSON.stringify(r.board.get(r.id)); resume();
  const result = await caught; expect("error" in result && result.error instanceof PreEffectToolRefusal).toBe(true); expect(JSON.stringify(r.board.get(r.id))).toBe(before);
});

test("#759 planning identity is strict and nullable absence can be represented for undo", () => {
  expect(planningPatch({ sdlc: { repo: null, issue: null } })).toEqual({ sdlc: { repo: null, issue: null } });
  expect(planningPatch()).toEqual({}); expect(planningPatch({})).toEqual({});
  for (const value of [null, [], { sdlc: {} }, { sdlc: { issue: Number.MAX_SAFE_INTEGER + 1 } }]) expect(() => planningPatch(value)).toThrow();
});


test("#759 historically accepted work cannot use the unstarted-backlog relink exception after untouched return", async () => {
  const r = rig();
  r.board.update(r.id, USER, "accepted", { state: "in_progress", owner: "kimi" });
  await r.tasks.returnUntouchedToBacklog(USER, { id: r.id, revision: 0, reason: "no work happened" });
  const revision = r.board.get(r.id)!.planningRevision!;
  await refused(r, () => r.tasks.planBacklog(USER, { id: r.id, revision, fields: { sdlc: { issue: 525 } }, reason: "historically started" }));
});
