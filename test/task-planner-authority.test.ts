import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

class FakePeer extends BasePeer {
  readonly received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
  busy() { this.setState("busy"); }
}
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function rig(trackPlans = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-task-planner-")), board = new Board(join(dir, "hub.db")), roster = new Set(["claude", "codex", "kimi"]);
  const bus = new Bus({ batchMs: 0, rostered: peer => roster.has(peer) });
  const roles: Record<string, string[]> = { claude: ["planner", "reviewer"], codex: ["planner", "reviewer"], kimi: ["implementer"] };
  const routing = loadRouting(dir), screen = { enabled: false, run: async () => {} };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture/task-planner", roles, notify: () => {}, wipLimit: () => 16,
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_patterns: [...routing.signals.pii_patterns, "PII_FIXTURE"], pii_screen: screen.enabled ? "local" : "off" } }),
    piiScreen: async () => { await screen.run(); return { label: "clear", ms: 0 }; },
    releaseWindow: async () => ({ at: Date.now(), host: true, quota: true, idle: true, reasons: [] }) });
  board.trackPlanRevisions = () => trackPlans;
  const peers = Object.fromEntries(await Promise.all(["claude", "codex", "kimi"].map(async id => { const peer = new FakePeer(id, 60_000); bus.add(peer); await peer.start(); return [id, peer] as const; })));
  cleanup.push(async () => { for (const peer of Object.values(peers)) await peer.stop(); bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  const bound = async (by = "claude", plan?: Task["plan"]) => {
    const task = await tasks.propose(by, { title: "future fixture work", class: "implement", backlog: true, ...(plan ? { plan } : {}) });
    return board.update(task.id, USER, "fixture bound planner", { planner: "claude" });
  };
  const snapshot = () => ({ tasks: board.list(), releases: board.releases() });
  return { dir, board, bus, tasks, roles, roster, peers, screen, bound, snapshot };
}
async function refusesWithoutWrite(r: Awaited<ReturnType<typeof rig>>, call: () => unknown | Promise<unknown>) {
  const before = r.snapshot(); let error: unknown;
  try { await call(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(PreEffectToolRefusal);
  expect(r.snapshot()).toEqual(before);
}

test("task-bound planner refuses another holder's plan, pull, undo, split, cancel and untouched return before writes", async () => {
  const r = await rig(), work = await r.bound();
  await refusesWithoutWrite(r, () => r.tasks.planBacklog("codex", { id: work.id, revision: 0, fields: { priority: 1 }, reason: "wrong holder" }));
  await refusesWithoutWrite(r, () => r.tasks.pullPlanned("codex", { id: work.id, revision: 0, reason: "wrong holder" }));
  const planned = r.board.plan(work.id, "codex", { priority: 1 }, 0, "fixture former planner");
  await refusesWithoutWrite(r, () => r.tasks.undoPlanning("codex", work.id, planned.planningRevision!));
  await refusesWithoutWrite(r, () => r.tasks.splitBacklog("codex", { id: work.id, revision: planned.planningRevision!, parts: [{ title: "first" }, { title: "second" }], reason: "wrong holder" }));
  const proposedByWrongHolder = await r.bound("codex");
  await refusesWithoutWrite(r, () => r.tasks.cancel(proposedByWrongHolder.id, "codex", { reason: "wrong holder" }));
  const untouched = r.board.update((await r.bound()).id, USER, "fixture proposed", { state: "proposed", owner: "kimi" });
  await refusesWithoutWrite(r, () => r.tasks.returnUntouchedToBacklog("codex", { id: untouched.id, revision: 0, reason: "wrong holder" }));
  const edited = await r.tasks.planBacklog("claude", { id: work.id, revision: planned.planningRevision!, fields: { due: 200 }, reason: "bound holder" });
  expect(edited.due).toBe(200);
  expect((await r.tasks.planBacklog(USER, { id: work.id, revision: edited.planningRevision!, fields: { due: 300 }, reason: "person override" })).due).toBe(300);
  expect((await r.tasks.pullPlanned("claude", { id: proposedByWrongHolder.id, revision: 0, reason: "bound holder pull" })).state).toBe("proposed");
});

test("null planner and removed/off-roster bindings fall back to holders, but offline alone retains authority", async () => {
  const r = await rig(), legacy = await r.bound(); r.board.update(legacy.id, USER, "fixture legacy", { planner: null });
  expect((await r.tasks.planBacklog("codex", { id: legacy.id, revision: 0, fields: { priority: 1 }, reason: "legacy holder" })).priority).toBe(1);
  const removed = await r.bound(); r.roles.claude = ["reviewer"];
  expect((await r.tasks.planBacklog("codex", { id: removed.id, revision: 0, fields: { priority: 1 }, reason: "removed holder fallback" })).priority).toBe(1);
  r.roles.claude = ["planner", "reviewer"];
  const offRoster = await r.bound(); r.roster.delete("claude");
  expect((await r.tasks.planBacklog("codex", { id: offRoster.id, revision: 0, fields: { priority: 1 }, reason: "off roster fallback" })).priority).toBe(1);
  r.roster.add("claude"); const offline = await r.bound(); await r.peers.claude!.stop();
  await refusesWithoutWrite(r, () => r.tasks.planBacklog("codex", { id: offline.id, revision: 0, fields: { priority: 1 }, reason: "offline is not reassignment" }));
  expect((await r.tasks.planBacklog("claude", { id: offline.id, revision: 0, fields: { priority: 2 }, reason: "retained authority" })).priority).toBe(2);
});

test("person-only planner assignment changes no owner, reviewer, delivery offer or task state", async () => {
  const r = await rig(); let task = await r.tasks.propose(USER, { title: "owned fixture", class: "implement", owner: "kimi" });
  task = r.board.update(task.id, USER, "fixture reviewer", { reviewer: "claude" });
  const before = r.board.get(task.id)!;
  await refusesWithoutWrite(r, () => r.tasks.assignTo(task.id, "codex", "claude", true, "planner"));
  const next = await r.tasks.assignTo(task.id, "codex", USER, true, "planner");
  expect(next.planner).toBe("codex");
  expect({ owner: next.owner, reviewer: next.reviewer, state: next.state, offer: next.offer, refs: next.refs, plan: next.plan }).toEqual({ owner: before.owner, reviewer: before.reviewer, state: before.state, offer: before.offer, refs: before.refs, plan: before.plan });
  expect(next.history.slice(0, -1)).toEqual(before.history);
  expect(next.history.at(-1)).toMatchObject({ event: "planner changed", by: USER, planner: "codex", plannerReason: "named" });
});

test("release planner owns configure, assignment, cut and changes; person-created releases retain null fallback", async () => {
  const r = await rig(), release = await r.tasks.newRelease("claude", { name: "bound", goal: "fixture release", order: 0 });
  expect(release.planner).toBe("claude");
  const legacy = await r.tasks.newRelease(USER, { name: "legacy", goal: "person release", order: 1 }); expect(legacy.planner).toBeNull();
  await refusesWithoutWrite(r, () => r.tasks.configureRelease("codex", { id: release.id, revision: 0, cut: 500 }));
  await refusesWithoutWrite(r, () => r.tasks.changeRelease("codex", { id: release.id, revision: 0, plannedStart: 100 }));
  const task = await r.bound();
  await refusesWithoutWrite(r, () => r.tasks.assignRelease("codex", { id: task.id, revision: 0, release: release.id, reason: "wrong holder" }));
  await r.tasks.assignRelease("claude", { id: task.id, revision: 0, release: release.id, reason: "bound scope" });
  r.board.update(task.id, USER, "backlog pulled", { state: "proposed", owner: "kimi", reviewer: "claude" });
  r.board.update(task.id, "kimi", "accepted", { state: "in_progress" });
  r.board.update(task.id, "kimi", "done", { state: "in_review" });
  r.board.update(task.id, "claude", "approved", { state: "approved" });
  const active = await r.tasks.configureRelease("claude", { id: release.id, revision: 0, state: "active" });
  await refusesWithoutWrite(r, () => r.tasks.cutRelease("codex", { id: release.id, revision: active.revision }));
  expect((await r.tasks.cutRelease("claude", { id: release.id, revision: active.revision })).state).toBe("frozen");
  expect((await r.tasks.configureRelease("codex", { id: legacy.id, revision: 0, cut: 500 })).cut).toBe(500);
  expect(r.tasks.changeRelease(USER, { id: legacy.id, revision: 1, plannedStart: 100 }).plannedStart).toBe(100);
});

test("I4 latest plan-content author cannot self-review while another planner is busy; independent holder may review", async () => {
  const r = await rig(true), task = await r.bound("claude", { paths: ["first.ts"] });
  const current = r.board.update(task.id, "codex", "fixture later plan", { plan: { paths: ["second.ts"] } });
  expect(current.history.findLast(entry => !!entry.planRevision)?.by).toBe("codex");
  r.peers.claude!.busy();
  await refusesWithoutWrite(r, () => r.tasks.recordPlanReview("codex", task.id, { revision: 0, reason: "own plan" }));
  const reviewed = await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "independent review" });
  expect(reviewed.sdlc?.planReview).toMatchObject({ planner: "claude", planAuthor: "codex" });
  expect(reviewed.sdlc?.planReview?.selfReview).not.toBe(true);
});

test("I4 off-mode first-history author gets explicit self-review only without another eligible holder; empty plan author stays unknown", async () => {
  const r = await rig(), task = await r.bound("claude", { paths: ["authored.ts"] }); await r.peers.codex!.stop();
  expect(task.history.some(entry => !!entry.planRevision)).toBe(false);
  const reviewed = await r.tasks.recordPlanReview("claude", task.id, { revision: 0, reason: "single available planner" });
  expect(reviewed.sdlc?.planReview).toMatchObject({ planner: "claude", planAuthor: "claude", selfReview: true });
  const unknown = await r.bound("claude");
  expect((await r.tasks.recordPlanReview("claude", unknown.id, { revision: 0, reason: "no authored plan" })).sdlc?.planReview?.planAuthor).toBeNull();
});

test("planner authority revoked during asynchronous policy screening cannot commit a delayed plan", async () => {
  const r = await rig(), task = await r.bound(); let entered!: () => void, resume!: () => void;
  const observed = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { resume = resolve; });
  r.screen.run = async () => { entered(); await barrier; }; r.screen.enabled = true;
  const pending = r.tasks.planBacklog("claude", { id: task.id, revision: 0, fields: { priority: 1 }, reason: "screened plan" });
  const caught = pending.then(value => ({ value }), error => ({ error }));
  await observed; r.board.update(task.id, USER, "fixture changed planner", { planner: "codex" }); const before = r.snapshot(); resume();
  const result = await caught; expect("error" in result && result.error instanceof PreEffectToolRefusal).toBe(true); expect(r.snapshot()).toEqual(before);
});

test("proposals bind the pure planner choice for backlog and unavailable owner, while PII remains person planned", async () => {
  const r = await rig();
  const backlog = await r.tasks.propose(USER, { title: "future rotation", class: "implement", backlog: true });
  expect(backlog.planner).toBe(["claude", "codex"][backlog.id % 2]);
  expect(backlog.history.some(entry => entry.planner === backlog.planner && entry.plannerReason === "rotation")).toBe(true);
  // All execution candidates are offline. Planner holders remain rostered, so the pure walk retains its seed fallback.
  for (const peer of Object.values(r.peers)) await peer.stop();
  const ownerless = await r.tasks.propose(USER, { title: "owner unavailable", class: "implement" });
  expect(ownerless.owner).toBeNull(); expect(ownerless.planner).toBe(["claude", "codex"][ownerless.id % 2]);
  const pii = await r.tasks.propose(USER, { title: "PII_FIXTURE private work", class: "implement", backlog: true });
  expect(pii.signals).toContain("pii"); expect(pii.planner).toBeNull();
});

test("split children bind their pure planner in initial history and immediate person undo remains valid", async () => {
  const r = await rig(), parent = await r.tasks.propose(USER, { title: "split parent", class: "implement", backlog: true });
  const split = await r.tasks.splitBacklog(USER, { id: parent.id, revision: 0, parts: [{ title: "first child" }, { title: "second child", afterParts: [0] }], reason: "two independent pieces" });
  expect(split.children).toHaveLength(2);
  for (const child of split.children) {
    const planner = ["claude", "codex"][child.id % 2];
    expect(child.planner).toBe(planner);
    expect(child.history).toHaveLength(1);
    expect(child.history[0]).toMatchObject({ event: "backlogged", planner, plannerReason: "rotation" });
    expect(r.board.get(child.id)).toEqual(child);
  }
  const undone = await r.tasks.undoPlanning(USER, parent.id, split.parent.planningRevision!);
  expect(undone.state).toBe("backlog"); expect(undone.deps ?? []).toEqual(parent.deps ?? []); expect(undone.planner).toBe(parent.planner);
  expect(r.board.list().map(task => task.id)).toEqual([parent.id]);
});

test("host Board proposals bind before their first onChange while explicit null bypasses planner selection", async () => {
  const r = await rig(), selected = r.board.proposalPlanner!, changes: Task[] = [];
  let calls = 0;
  r.board.proposalPlanner = task => { calls++; return selected(task); };
  r.board.onChange = task => { changes.push(task); };
  const chosen = r.board.propose(USER, { title: "direct host card", class: "plan", backlog: true });
  const planner = ["claude", "codex"][chosen.id % 2];
  expect(calls).toBe(1); expect(chosen.planner).toBe(planner);
  expect(chosen.history).toHaveLength(1); expect(chosen.history[0]).toMatchObject({ event: "backlogged", planner, plannerReason: "rotation" });
  expect(changes).toHaveLength(1); expect(changes[0]).toEqual(chosen); expect(r.board.get(chosen.id)).toEqual(chosen);
  const legacy = r.board.propose(USER, { title: "explicit legacy card", class: "plan", planner: null });
  expect(calls).toBe(1); expect(legacy.planner).toBeNull(); expect(legacy.history[0]?.planner).toBeNull();
  expect(changes).toEqual([chosen, legacy]);
});

test("a throwing proposal planner rolls back the row, revision and callbacks with no leaked inserted identity", async () => {
  const r = await rig(), before = r.snapshot(), revision = r.board.statusRevision(), selected = r.board.proposalPlanner!;
  const changes: number[] = []; let failedId: number | undefined;
  r.board.onChange = task => { changes.push(task.id); };
  r.board.proposalPlanner = task => { failedId = task.id; expect(r.board.get(task.id)?.title).toBe("failed host proposal"); throw new Error("fixture planner selection failed"); };
  expect(() => r.board.propose(USER, { title: "failed host proposal", class: "plan" })).toThrow("fixture planner selection failed");
  expect(failedId).toBeDefined(); expect(r.board.get(failedId!)).toBeUndefined(); expect(r.snapshot()).toEqual(before);
  expect(r.board.statusRevision()).toBe(revision); expect(changes).toEqual([]);
  r.board.proposalPlanner = selected;
  const retry = r.board.propose(USER, { title: "successful retry", class: "plan" });
  expect(retry.id).toBe(failedId); expect(retry.planner).toBe(["claude", "codex"][retry.id % 2]); expect(changes).toEqual([retry.id]);
});
