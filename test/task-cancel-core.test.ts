import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, isClosedTaskState, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting, assign } from "../src/hub/routing.ts";
import { DEFAULT_TASK_SWEEP, nextSweep } from "../src/hub/task-sweep.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { supersededDeliveryReason } from "../src/hub/delivery-superseded.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
class Peer extends BasePeer { received: Envelope[] = []; async start() { this.setState("busy"); } async stop() {} async deliver(envs: Envelope[]) { this.received.push(...envs); } }
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-cancel-core-")), file = join(root, "hub.db");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let board = new Board(file); cleanup.push(() => board.close());
  const bus = new Bus({ batchMs: 0 });
  for (const id of ["pi", "planner", "reviewer"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const routing = loadRouting(root); routing.classes.implement!.peers = ["pi"];
  const caps = { pi: { tests: false, spec: false }, planner: { tests: true, spec: true } };
  const told: { peer: string; text: string }[] = [];
  const notices: string[] = [], stalls: number[] = [], offers = new Set<string>();
  const mem = startFakeMemWorker(); cleanup.push(mem.stop);
  let pullOnly = true, privateTurn = false, held = false, screenLabel: "clear" | "pii" = "clear", screen: (() => void) | undefined;
  const make = () => new Tasks({ board, bus, routing: () => routing, project: "fixture", cwd: root, capabilities: () => caps, repository: "owner/repo", memory: new MemoryClient(mem.url), roles: { planner: ["planner"] }, sweep: { ...DEFAULT_TASK_SWEEP, enabled: true, ready_min: 1, ladder_min: 1 },
    privateTurn: () => privateTurn, cancellationHeld: () => held, offerRead: (_peer, id) => offers.has(id), offerPullOnly: () => pullOnly, stallNotice: row => { stalls.push(row.task); },
    piiScreen: async () => { screen?.(); return { label: screenLabel, ms: 1 }; }, notify: text => { notices.push(text); }, tell: (peer, text) => { told.push({ peer, text }); }, share: () => {} });
  let tasks = make();
  const task = (state: Task["state"] = "proposed", by = "planner") => {
    let t = board.propose(by, { title: "original task", class: "implement", ...(state === "backlog" ? { backlog: true } : {}) });
    if (state !== "backlog") t = board.update(t.id, "user", "assigned", { owner: "pi", reviewer: "reviewer" });
    if (["in_progress", "in_review", "changes_requested", "approved"].includes(state)) t = board.update(t.id, "pi", "accepted", { state: "in_progress" });
    if (["in_review", "changes_requested", "approved"].includes(state)) t = board.update(t.id, "pi", "done", { state: "in_review" });
    if (state === "changes_requested" || state === "approved") t = board.update(t.id, "reviewer", state, { state });
    return t;
  };
  return { root, get board() { return board; }, get tasks() { return tasks; }, bus, caps, routing, notices, stalls, offers, told, task, saves: () => mem.calls.filter(call => call.path === "/api/memory/save"),
    pullOnly: (value: boolean) => { pullOnly = value; },
    privacy: () => { screenLabel = "pii"; routing.signals.pii_screen = "local"; },
    private: (value: boolean) => { privateTurn = value; },
    hold: (value: boolean) => { held = value; }, screen: (fn: () => void) => { screen = fn; routing.signals.pii_screen = "local"; },
    reopen: () => { board.close(); board = new Board(file); tasks = make(); } };
}

test("cancel is terminal from all allowed states, clears reservations, closes SQL and never releases dependents", async () => {
  const f = await fixture();
  for (const state of ["backlog", "proposed", "in_progress", "in_review", "changes_requested"] as const) {
    const t = f.task(state); const dependent = f.board.propose("planner", { title: "dependent", class: "implement", deps: [t.id] });
    const next = await f.tasks.cancel(t.id, "user", { reason: "obsolete", supersededBy: "owner/repo#2", expectedFlowRevision: t.history.length });
    expect(next).toMatchObject({ state: "cancelled", reserved: null, cancelled: { reason: "obsolete", supersededBy: "owner/repo#2" } });
    expect(isClosedTaskState(next.state)).toBe(true);
    expect(f.board.statusTasks().some(row => row.id === t.id)).toBe(false);
    expect(f.tasks.waitsFor(f.board.get(dependent.id)!)).toEqual([t.id]);
    expect(f.board.get(dependent.id)?.owner).toBeNull();
    expect(next.history.filter(row => row.event === "cancelled")).toHaveLength(1);
    expect(assign(next, {}, f.routing).owner).toBeUndefined();
    await expect(f.tasks.cancel(t.id, "user", { reason: "again" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  }
  const approved = f.task("approved"), before = f.board.get(approved.id);
  await expect(f.tasks.cancel(approved.id, "user", { reason: "obsolete" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.board.get(approved.id)).toEqual(before);
  expect(f.saves()).toEqual([]);
});

test("planner cancellation requires original authorship and no historical acceptance, revision and recovery guards precede writes", async () => {
  const f = await fixture();
  for (const t of [f.task("proposed", "other"), f.task("in_progress"), f.task("backlog", "other")]) {
    const before = f.board.get(t.id);
    await expect(f.tasks.cancel(t.id, "planner", { reason: "obsolete" })).rejects.toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.get(t.id)).toEqual(before);
  }
  const reverted = f.task("in_progress"); f.board.update(reverted.id, "user", "released", { state: "proposed", owner: null });
  await expect(f.tasks.cancel(reverted.id, "planner", { reason: "obsolete" })).rejects.toThrow("historically unaccepted");
  const t = f.task();
  await expect(f.tasks.cancel(t.id, "user", { reason: "obsolete", expectedFlowRevision: 0 })).rejects.toThrow("revision");
  f.screen(() => f.hold(true));
  await expect(f.tasks.cancel(t.id, "user", { reason: "obsolete" })).rejects.toThrow("holding cancellation");
  expect(f.board.get(t.id)?.state).toBe("proposed");
  f.hold(false); f.screen(() => {});
  expect((await f.tasks.cancel(t.id, "planner", { reason: "obsolete" })).state).toBe("cancelled");
});

test("cancel notices remain relevant while earlier assignment notices become moot", async () => {
  const f = await fixture(), t = f.task();
  const old = newEnvelope("hub", "old assignment", { kind: "task", refs: { task: String(t.id), taskRecipient: "owner" } });
  f.bus.publish({ ...old, to: ["pi"] });
  const next = await f.tasks.cancel(t.id, "user", { reason: "obsolete" });
  const notices = f.bus.snapshot(false).queues.pi ?? [];
  const stop = notices.find(env => env.refs?.taskCancelled === next.cancelled!.flowRevision)!;
  expect(stop).toBeDefined(); expect(f.tasks.relevant("pi", stop)).toBe(true);
  expect(f.tasks.relevant("pi", old)).toBe(false);
  expect(supersededDeliveryReason([old], f.board, "pi")).toContain("cancelled");
  expect(supersededDeliveryReason([stop], f.board, "pi")).toBeUndefined();
});

test("stalled causes dedupe across reopen and repeat only for changed cause or replanning", async () => {
  const f = await fixture(), dep = f.task();
  f.board.update(dep.id, "user", "accepted", { state: "in_progress" }); f.board.update(dep.id, "user", "approved", { state: "approved" });
  const t = f.board.propose("planner", { title: "ready work", class: "implement", deps: [dep.id], reserved: "pi" });
  const before = f.board.get(t.id);
  await f.tasks.releaseReady(); await f.tasks.releaseReady();
  expect(f.stalls).toEqual([t.id]); expect(f.tasks.stalled()[0]?.cause).toMatchObject({ kind: "reservation", code: "tests" });
  expect(f.board.get(t.id)).toEqual(before);
  f.reopen(); await f.tasks.releaseReady(); expect(f.stalls).toEqual([t.id]);
  f.caps.pi.tests = true; await f.tasks.releaseReady(); // No spec ref: pi is now eligible.
  expect(f.tasks.stalled()).toEqual([]);
});

test("exact offers persist before publication and read proof never applies to another offer", async () => {
  const f = await fixture(); f.caps.pi.tests = true; f.caps.pi.spec = true;
  const t = await f.tasks.propose("user", { title: "offer", class: "implement", owner: "pi" });
  const offer = f.board.get(t.id)!.offer!;
  expect(offer.envelopeId).toBeDefined(); expect(f.tasks.pendingOffers()).toMatchObject([{ task: t.id, peer: "pi", envelopeId: offer.envelopeId }]);
  f.reopen(); expect(f.tasks.pendingOffers()).toHaveLength(1);
  f.board.update(t.id, "user", "reviewer changed", { reviewer: "planner" });
  expect(f.tasks.pendingOffers()).toHaveLength(1);
  f.offers.add("unrelated"); expect(f.tasks.pendingOffers()).toHaveLength(1);
  f.offers.add(offer.envelopeId); expect(f.tasks.pendingOffers()).toEqual([]);
  const moved = await f.tasks.assignTo(t.id, "pi", "user");
  expect(f.board.get(moved.id)?.offer?.envelopeId).not.toBe(offer.envelopeId);
  expect(f.tasks.pendingOffers()).toHaveLength(1);
});

test("ready-unassigned sweep is deterministic restart-safe and never treats cancelled dependency as ready", async () => {
  const f = await fixture(), t = f.board.propose("planner", { title: "idle", class: "implement" });
  const config = { ...DEFAULT_TASK_SWEEP, enabled: true, ready_min: 1 };
  const first = nextSweep(t, config, t.created + 60_000)!;
  expect(first).toMatchObject({ kind: "ready-unassigned", step: 1 });
  f.board.update(t.id, "hub", "idle sweep", {}, undefined, { sweep: first }); f.reopen();
  expect(nextSweep(f.board.get(t.id)!, config, first.at + 1)).toBeUndefined();
  expect(nextSweep(f.board.get(t.id)!, config, first.at + 30 * 60_000)?.step).toBe(2);
  expect(nextSweep(t, config, first.at, false)).toBeUndefined();
});


test("cancellation privacy metadata is withheld from public views and notices and never becomes memory", async () => {
  const f = await fixture(), t = f.task(); f.privacy();
  const next = await f.tasks.cancel(t.id, "user", { reason: "private-marked-reason", supersededBy: "private-supersession" });
  expect(next.cancelled?.withheld).toBe(true);
  const view = JSON.stringify(f.tasks.publicView(next, true));
  expect(view).not.toContain("private-marked-reason"); expect(view).not.toContain("private-supersession");
  expect(JSON.stringify(f.bus.snapshot(false))).not.toContain("private-marked-reason");
  expect(f.saves()).toEqual([]);
});

test("stall cause changes and replanning each issue one new ids-only notice", async () => {
  const f = await fixture();
  const t = f.board.propose("planner", { title: "PRIVATE-title #1", class: "implement", reserved: "pi" });
  await f.tasks.releaseReady(); await f.tasks.releaseReady(); expect(f.stalls).toHaveLength(1);
  f.caps.pi.tests = true; await f.tasks.releaseReady(); expect(f.stalls).toHaveLength(2);
  expect(f.tasks.stalled()[0]?.cause.code).toBe("spec");
  f.board.plan(t.id, "user", { rank: 1 }, 0, "replan");
  await f.tasks.releaseReady(); await f.tasks.releaseReady(); expect(f.stalls).toHaveLength(3);
  expect(f.notices.join(" ")).not.toContain("PRIVATE-title");
});


test("ready-unassigned uses the planner then console/planner then suggestion ladder without assignment", async () => {
  const f = await fixture(), t = f.board.propose("planner", { title: "PRIVATE task", class: "implement" });
  const first = t.created + 60_000;
  expect((await f.tasks.sweep(first))[0]?.finding.step).toBe(1);
  expect(f.notices).toEqual([]);
  expect(f.bus.snapshot(false).queues.planner?.some(env => env.body.includes("idle escalation 1/3"))).toBe(true);
  f.reopen(); expect(await f.tasks.sweep(first + 1)).toEqual([]);
  expect((await f.tasks.sweep(first + 60_000))[0]?.finding.step).toBe(2);
  expect(f.notices.join(" ")).toContain("idle escalation 2/3");
  expect((await f.tasks.sweep(first + 120_000))[0]?.finding.step).toBe(3);
  expect(f.notices.join(" ")).toContain("Owner reassignment suggestion:");
  expect(f.board.get(t.id)?.owner).toBeNull();
  expect(f.notices.join(" ")).not.toContain("PRIVATE task");
});

test("a private-turn planner cannot attach its words to ordinary cancellation, even after screening", async () => {
  const f = await fixture(), t = f.task(); f.private(true);
  const before = f.board.get(t.id);
  await expect(f.tasks.cancel(t.id, "planner", { reason: "private-turn words" })).rejects.toThrow("private turn");
  expect(f.board.get(t.id)).toEqual(before);
  f.private(false); f.screen(() => f.private(true));
  await expect(f.tasks.cancel(t.id, "planner", { reason: "private-turn words" })).rejects.toThrow("private turn");
  expect(f.board.get(t.id)).toEqual(before); expect(f.saves()).toEqual([]);
});

test("persisted arbitrary stall codes and signatures never reach public metadata", async () => {
  const f = await fixture(), t = f.board.propose("planner", { title: "work", class: "implement" });
  // The board's writer API is trusted; simulate an old/corrupt record through the isolated fixture DB only.
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(f.root, "hub.db"));
  try { db.query("INSERT INTO task_stalls(task,payload) VALUES(?,?)").run(t.id, JSON.stringify({ task: t.id, signature: "PRIVATE", replanRevision: 0, cause: { kind: "no-eligible-peer", code: "PRIVATE" }, at: 1 })); }
  finally { db.close(); }
  expect(f.tasks.stalled()).toEqual([]);
});


test("stall planner advice is a once-per-cause preface, never an ordinary queued turn", async () => {
  const f = await fixture();
  const task = f.board.propose("planner", { title: "PRIVATE-title #1", class: "implement", reserved: "pi" });
  await f.tasks.releaseReady(); await f.tasks.releaseReady();
  expect(f.told).toHaveLength(1); expect(f.told[0]).toMatchObject({ peer: "planner" });
  expect(f.told[0]!.text).toStartWith("note from hub [finding]: ");
  expect(f.told[0]!.text).toContain(`Task #${task.id} stalled:`);
  expect(f.told[0]!.text).not.toContain("PRIVATE-title");
  expect(f.bus.queueIds("planner")).toEqual([]);
  f.caps.pi.tests = true;
  await f.tasks.releaseReady(); await f.tasks.releaseReady();
  expect(f.told).toHaveLength(2); expect(f.told[1]!.text).toContain("(spec)");
  expect(f.bus.queueIds("planner")).toEqual([]);
  expect(f.stalls).toEqual([task.id, task.id]);
});

test("cancelling a backlog prerequisite advises its retained backlog dependent with ids only", async () => {
  const f = await fixture();
  const parent = await f.tasks.propose("planner", { title: "PRIVATE-parent-title", class: "implement", backlog: true });
  const dependent = await f.tasks.propose("planner", { title: "PRIVATE-dependent-title", class: "implement", backlog: true, after: [parent.id] });
  const saved = f.board.get(dependent.id), noticeAt = f.notices.length, toldAt = f.told.length, savesBefore = f.saves();
  await f.tasks.cancel(parent.id, "user", { reason: "obsolete prerequisite" });
  expect(f.board.get(dependent.id)).toEqual(saved);
  expect(f.board.get(dependent.id)).toMatchObject({ state: "backlog", deps: [parent.id], owner: null });
  expect(f.tasks.waitsFor(f.board.get(dependent.id)!)).toEqual([parent.id]);
  const notices = f.notices.slice(noticeAt).join("\n"), advice = f.told.slice(toldAt);
  expect(notices).toContain(`Task #${dependent.id} stalled:`);
  expect(notices).toContain(`#${parent.id}`);
  expect(advice).toHaveLength(1);
  expect(advice[0]).toMatchObject({ peer: "planner" });
  expect(advice[0]!.text).toContain(`Task #${dependent.id} stalled:`);
  expect(advice[0]!.text).toContain(`#${parent.id}`);
  expect(notices + JSON.stringify(advice)).not.toContain("PRIVATE-parent-title");
  expect(notices + JSON.stringify(advice)).not.toContain("PRIVATE-dependent-title");
  expect(f.saves()).toEqual(savesBefore);
  expect(f.bus.queueIds("planner")).toEqual([]);
});


for (const failure of ["clearStall", "list", "recordStall"] as const) test(`committed cancellation survives post-write ${failure} advisory failure and still notifies roles`, async () => {
  const f = await fixture(), task = f.task();
  f.board.propose("planner", { title: "dependent", class: "implement", deps: [task.id] });
  const original = f.board[failure], list = f.board.list.bind(f.board);
  if (failure === "list") f.board.list = state => { if (f.board.get(task.id)?.state === "cancelled") throw new Error("post-write advisory read failed"); return list(state); };
  else if (failure === "clearStall") f.board.clearStall = () => { throw new Error("post-write clear failed"); };
  else f.board.recordStall = () => { throw new Error("post-write stall failed"); };
  try {
    const result = await f.tasks.cancel(task.id, "user", { reason: "replaced" });
    expect(result.state).toBe("cancelled"); expect(f.board.get(task.id)?.state).toBe("cancelled");
    for (const role of ["pi", "reviewer"]) expect((f.bus.snapshot(false).queues[role] ?? []).filter(env => env.refs?.taskCancelled)).toHaveLength(1);
    expect(f.saves()).toEqual([]);
  } finally { (f.board as any)[failure] = original; }
});

test("offer sampling survives peer detach and Tasks restart until fresh delivery evidence", async () => {
  const f = await fixture(); f.caps.pi.tests = true; f.caps.pi.spec = true;
  const task = await f.tasks.propose("user", { title: "offered work", class: "implement", owner: "pi" });
  const pending = f.tasks.pendingOffers(); expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ task: task.id, peer: "pi", pullOnly: true });
  f.pullOnly(false); f.reopen();
  expect(f.tasks.pendingOffers()[0]).toMatchObject({ task: task.id, pullOnly: true });
  f.offers.add(pending[0]!.envelopeId); expect(f.tasks.pendingOffers()).toEqual([]);
});

test("offer candidate cache avoids repeated history decode but observes quiet local and external offer writes", async () => {
  const f = await fixture(), task = f.task();
  const envelope = (body: string) => newEnvelope("hub", body, { to: ["pi"], kind: "task", refs: { task: String(task.id), taskOffer: task.history.length } });
  const first = envelope("first"); f.board.recordTaskOffer(task.id, { envelopeId: first.id, owner: "pi", assignmentFlowRevision: task.history.length }, task.history.length);
  let decodes = 0; const list = f.board.list.bind(f.board); f.board.list = state => { decodes++; return list(state); };
  expect(f.tasks.pendingOffers()[0]?.envelopeId).toBe(first.id); const afterFirst = decodes;
  expect(f.tasks.pendingOffers()[0]?.envelopeId).toBe(first.id); expect(decodes).toBe(afterFirst);
  const other = new Database(join(f.root, "hub.db")); cleanup.push(() => other.close());
  other.run("CREATE TABLE IF NOT EXISTS status_unrelated_probe (value INTEGER)");
  other.run("INSERT INTO status_unrelated_probe VALUES (1)");
  expect(f.tasks.pendingOffers()[0]?.envelopeId).toBe(first.id); expect(decodes).toBe(afterFirst);
  f.offers.add(first.id); expect(f.tasks.pendingOffers()).toEqual([]); // Journal proof is fresh despite cached candidates.
  const second = envelope("quiet local"); f.board.recordTaskOffer(task.id, { envelopeId: second.id, owner: "pi", assignmentFlowRevision: task.history.length }, task.history.length);
  expect(f.tasks.pendingOffers()[0]?.envelopeId).toBe(second.id); expect(decodes).toBeGreaterThan(afterFirst); const afterSecond = decodes;
  const external = new Board(join(f.root, "hub.db")); cleanup.push(() => external.close());
  const third = envelope("quiet external"); external.recordTaskOffer(task.id, { envelopeId: third.id, owner: "pi", assignmentFlowRevision: task.history.length }, task.history.length);
  expect(f.tasks.pendingOffers()[0]?.envelopeId).toBe(third.id); expect(decodes).toBeGreaterThan(afterSecond);
});

test("stall candidate cache avoids unchanged decoding and refreshes board and live eligibility", async () => {
  const f = await fixture();
  f.board.propose("planner", { title: "waiting for eligible worker", class: "implement" }); await f.tasks.releaseReady();
  let reads = 0; const get = f.board.get.bind(f.board), list = f.board.list.bind(f.board);
  f.board.get = id => { reads++; return get(id); }; f.board.list = state => { reads++; return list(state); };
  expect(f.tasks.stalled()).toHaveLength(1); const first = reads;
  expect(f.tasks.stalled()).toHaveLength(1); expect(reads).toBe(first);
  f.caps.pi.tests = true; f.caps.pi.spec = true; expect(f.tasks.stalled()).toEqual([]);
});

test("board status revision preserves planning CAS and rolls back a write if its generation cannot advance", async () => {
  const f = await fixture(), task = f.task();
  const before = f.board.statusRevision();
  const planned = f.board.plan(task.id, "user", { rank: 1 }, 0);
  expect(planned.planningRevision).toBe(1);
  expect(f.board.statusRevision()).toBeGreaterThan(before);
  const afterPlan = f.board.statusRevision();
  expect(() => f.board.plan(task.id, "user", { rank: 2 }, 0)).toThrow("planning revision changed");
  expect(f.board.get(task.id)).toEqual(planned); expect(f.board.statusRevision()).toBe(afterPlan);
  const connection = new Database(join(f.root, "hub.db")); cleanup.push(() => connection.close());
  connection.run("CREATE TRIGGER reject_status_generation BEFORE UPDATE ON board_status_revision BEGIN SELECT RAISE(ABORT, 'injected generation failure'); END");
  let notifications = 0; f.board.onChange = () => { notifications++; };
  expect(() => f.board.update(task.id, "user", "note", {}, "must roll back")).toThrow("injected generation failure");
  expect(f.board.get(task.id)).toEqual(planned); expect(f.board.statusRevision()).toBe(afterPlan); expect(notifications).toBe(0);
});
