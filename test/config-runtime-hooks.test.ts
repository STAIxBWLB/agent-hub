import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DEFAULT_TASK_SWEEP } from "../src/hub/task-sweep.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { Briefs } from "../src/memory/brief.ts";
import { SupervisionFeed, type SupervisionNotice } from "../src/hub/supervision.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
class IdlePeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
}
class WatchdogPeer extends IdlePeer {
  get currentLimit() { return this.watchdogMs; }
  begin() { this.setState("busy"); }
  activity() { this.touch(); }
  settle() { this.setState("idle"); }
}

function fixture(overrides: Partial<TasksDeps> = {}, before?: (board: Board) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-runtime-hooks-"));
  const board = new Board(join(cwd, "hub.db"));
  cleanup.push(() => { board.close(); rmSync(cwd, { recursive: true, force: true }); });
  before?.(board);
  const bus = new Bus({ batchMs: 0 });
  bus.setRecoveryHold(true);
  const deps: TasksDeps = { board, bus, cwd, project: "runtime-hooks", routing: () => loadRouting(cwd), notify: () => {}, turnFree: () => true, capable: () => true, ...overrides };
  const tasks = new Tasks(deps);
  const owned = (task: Task, owner: string) => board.update(task.id, HUB, "assigned", { owner, state: "proposed" });
  const joinTasks = (task: Task, others: Task[]) => (tasks as any).formCohort(task, others.map(other => ({ task: other })));
  return { board, bus, tasks, deps, owned, joinTasks };
}

test("#439 scheduling reload preserves queued work, prefaces, pauses and recovery holds", async () => {
  const bus = new Bus({ batchMs: 30_000, batchMax: 100, queueCap: 10 });
  const peer = new IdlePeer("codex"); bus.add(peer); await peer.start();
  bus.setRecoveryHold(true); bus.pause("codex"); bus.note("codex", "retained context");
  bus.publish(newEnvelope("claude", "queued work", { to: ["codex"] }));
  const snapshot = bus.snapshot();
  (bus as any).configureScheduling({ batchMs: 0, batchMax: 1, queueCap: 1 });
  expect(bus.snapshot()).toEqual(snapshot);
  expect(bus.isRecoveryHeld).toBe(true);
  expect(bus.isPaused("codex")).toBe(true);
  const latest = newEnvelope("claude", "new work", { to: ["codex"] }); bus.publish(latest);
  expect(bus.queueIds("codex")).toEqual([latest.id]);
});

test("#439 scheduling reload rejects an invalid batch atomically", () => {
  const bus = new Bus({ batchMs: 20, batchMax: 3, queueCap: 10 });
  const before = { ...(bus as any).opts };
  for (const invalid of [{ batchMs: NaN }, { batchMs: -1 }, { batchMax: 0 }, { queueCap: Infinity }, { batchMax: 1.5 }, { queueCap: 0 }, { batchMs: 2_147_483_648 }]) {
    expect(() => (bus as any).configureScheduling({ batchMs: 0, batchMax: 1, queueCap: 1, ...invalid })).toThrow("invalid bus scheduling configuration");
    expect((bus as any).opts).toEqual(before);
  }
});

test("#439 sweep reload validates before replacing the next-pass configuration", async () => {
  const f = fixture(); f.bus.setRecoveryHold(false);
  const task = f.board.propose("user", { title: "ready work", class: "implement" });
  const at = task.created + 61_000;
  expect(await f.tasks.sweep(at)).toEqual([]);
  const config = { ...DEFAULT_TASK_SWEEP, enabled: true, ready_min: 1 };
  (f.tasks as any).configureSweep(config);
  config.enabled = false; // caller mutation must not alter the validated snapshot
  expect(() => (f.tasks as any).configureSweep({ ...config, interval_s: NaN })).toThrow();
  expect((await f.tasks.sweep(at)).map(row => row.task)).toEqual([task.id]);
});

test("#439 a sweep pass keeps its configuration when a notice reloads the next pass", async () => {
  const f = fixture(); f.bus.setRecoveryHold(false);
  const a = f.board.propose("user", { title: "first ready work", class: "implement" });
  const b = f.board.propose("user", { title: "second ready work", class: "implement" });
  (f.tasks as any).configureSweep({ ...DEFAULT_TASK_SWEEP, enabled: true, ready_min: 1 });
  f.deps.notify = () => (f.tasks as any).configureSweep({ ...DEFAULT_TASK_SWEEP, enabled: false });
  const at = Math.max(a.created, b.created) + 61_000;
  expect((await f.tasks.sweep(at)).map(row => row.task)).toEqual([a.id, b.id]);
  expect(await f.tasks.sweep(at + 61_000)).toEqual([]);
});

test("#439 coordination enable applies only to new task rows", async () => {
  let coordination = false;
  const f = fixture({ coordination: () => coordination } as any, board => {
    const old = board.propose("user", { title: "existing row", class: "implement" });
    board.update(old.id, HUB, "assigned", { owner: "codex" });
  });
  const old = f.board.list()[0]!;
  coordination = true;
  const a = f.owned(await f.tasks.propose("user", { title: "new A", class: "implement", backlog: true }), "kimi");
  f.joinTasks(a, [old]);
  expect(f.tasks.cohorts.of(old.id)).toBeUndefined();
  expect(f.tasks.cohorts.of(a.id)).toBeUndefined();
  const b = f.owned(await f.tasks.propose("user", { title: "new B", class: "implement", backlog: true }), "claude");
  f.joinTasks(b, [old, a]);
  expect(f.tasks.silentFor(a.id)).toBe(true);
  expect([...f.tasks.cohorts.of(a.id)!.members.keys()].sort()).toEqual([a.id, b.id].sort());
  coordination = false;
  const c = f.owned(await f.tasks.propose("user", { title: "new C", class: "implement", backlog: true }), "codex");
  f.joinTasks(c, [a, b]);
  expect(f.tasks.cohorts.of(c.id)).toBeUndefined();
  expect(f.tasks.silentFor(a.id)).toBe(true);
});

test("#439 split children capture their creation coordination mode independently of the parent", async () => {
  let coordination = false;
  const f = fixture({ coordination: () => coordination } as any);
  const parent = await f.tasks.propose("user", { title: "advisory parent", class: "implement", backlog: true });
  coordination = true;
  const split = await f.tasks.splitBacklog("user", { id: parent.id, revision: 0, parts: [{ title: "part A" }, { title: "part B" }], reason: "separate changes" });
  coordination = false;
  const a = f.owned(split.children[0]!, "codex"), b = f.owned(split.children[1]!, "kimi");
  f.joinTasks(b, [a]);
  expect(f.tasks.silentFor(a.id)).toBe(true);
});

test("#439 native brief item limits reload between calls without resetting seen history", async () => {
  let maximum = 1, reads = 0;
  const items = [1, 2, 3].map(id => ({ id: `native-${id}`, line: `native item ${id}` }));
  const briefs = new Briefs(undefined, "runtime-hooks", (() => { reads++; return maximum; }) as any, () => items);
  const first = await briefs.forTask("codex", { title: "first", refs: {} });
  expect(first).toContain("native item 1");
  expect(first).not.toContain("native item 2");
  maximum = 2;
  const second = await briefs.forTask("codex", { title: "second", refs: {} });
  expect(second).not.toContain("native item 1");
  expect(second).toContain("native item 2");
  expect(second).toContain("native item 3");
  expect(reads).toBe(2);
});

test("#439 a brief snapshots its item limit before native selection", async () => {
  let maximum = 1, reads = 0;
  const briefs = new Briefs(undefined, "runtime-hooks", (() => { reads++; return maximum; }) as any, () => {
    maximum = 3;
    return [1, 2, 3].map(id => ({ id: `selection-${id}`, line: `selected item ${id}` }));
  });
  const brief = await briefs.forTask("codex", { title: "one decision", refs: {} });
  expect(brief).toContain("selected item 1");
  expect(brief).not.toContain("selected item 2");
  expect(reads).toBe(1);
});

test("#439 approval wait reload applies on the next decision and preserves notification latches", () => {
  let threshold = 90_000, reads = 0;
  const sent: SupervisionNotice[] = [];
  const feed = new SupervisionFeed({ conductor: () => "claude", scope: () => "all", tasks: () => [], publicTitle: task => task.title, isPrivate: () => false,
    emit: notice => { sent.push(notice); }, now: () => 60_000,
    approvalAgeMs: (() => { reads++; return threshold; }) as any });
  const request = { id: "permission-one", peer: "codex", tool: "write", createdAt: 0 };
  expect(feed.approvalWaiting(request)).toBe(false);
  threshold = 30_000;
  expect(feed.approvalWaiting(request)).toBe(true);
  expect(feed.approvalWaiting(request)).toBe(false);
  expect(sent).toHaveLength(1);
  expect(reads).toBe(3);
});

test("#439 watchdog reload takes effect on the next busy turn without rearming the current timer", () => {
  const peer = new WatchdogPeer("codex", 60_000);
  cleanup.push(() => peer.settle());
  (peer as any).configureWatchdog(120_000);
  expect(peer.currentLimit).toBe(60_000);
  expect((peer as any).timer).toBeUndefined();
  peer.begin();
  expect(peer.currentLimit).toBe(120_000);
  const timer = (peer as any).timer;
  (peer as any).configureWatchdog(180_000);
  expect(peer.currentLimit).toBe(120_000);
  expect((peer as any).timer).toBe(timer);
  peer.activity();
  expect(peer.currentLimit).toBe(120_000);
  peer.begin(); // repeated busy reports are activity in this same native turn
  expect(peer.currentLimit).toBe(120_000);
  peer.settle();
  peer.begin();
  expect(peer.currentLimit).toBe(180_000);
});

test("#439 watchdog reload rejects invalid values without changing its pending limit or timer", () => {
  const peer = new WatchdogPeer("claude", 60_000);
  cleanup.push(() => peer.settle());
  peer.begin();
  (peer as any).configureWatchdog(120_000);
  const timer = (peer as any).timer;
  for (const value of [0, -1, NaN, Infinity, 2_147_483_648]) {
    expect(() => (peer as any).configureWatchdog(value)).toThrow("invalid watchdog interval");
    expect((peer as any).timer).toBe(timer);
    expect(peer.currentLimit).toBe(60_000);
  }
  peer.settle(); peer.begin();
  expect(peer.currentLimit).toBe(120_000);
});
