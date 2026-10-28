import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bus, type BusSnapshot } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import type { DeliveryReceipt, PeerAdapter } from "../src/hub/peers.ts";

class Peer implements PeerAdapter {
  readonly id = "worker";
  state: PeerState = "busy";
  onState?: (state: PeerState) => void;
  onDelivery?: (receipt: DeliveryReceipt) => void;
  onMessage?: (body: string) => unknown;
  onFailed?: (envs: Envelope[]) => void;
  batches: Envelope[][] = [];
  deliveryIds: string[] = [];
  admitted?: () => void;
  set(state: PeerState): void { this.state = state; this.onState?.(state); }
  async start(): Promise<void> { this.set("idle"); }
  async stop(): Promise<void> { this.set("offline"); }
  async deliver(envs: Envelope[], id?: string): Promise<void> {
    this.batches.push(envs); this.set("busy");
    if (id) { this.deliveryIds.push(id); this.onDelivery?.({ id, state: "accepted" }); }
    this.admitted?.();
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(tracked: () => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-queue-pressure-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "hub.db");
  const open = (instance: string) => new DeliveryJournal({ file, projectRoot: dir, projectId: "project", instanceId: instance });
  const journal = open("first"), bus = new Bus({ journal, batchMs: 0, batchMax: 3, trackQueuePressure: tracked });
  cleanup.push(() => bus.closeJournal());
  const peer = new Peer(); bus.add(peer);
  return { dir, file, open, journal, bus, peer };
}
function querySpy(journal: DeliveryJournal): { sql: string[]; restore: () => void } {
  const sql: string[] = [], db = (journal as any).db;
  (journal as any).db = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key);
    if (["query", "run", "exec"].includes(String(key))) return (query: string, ...args: unknown[]) => { sql.push(query); return value.call(target, query, ...args); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { sql, restore: () => { (journal as any).db = db; } };
}
function expectNoSummaryMutation(sql: readonly string[]): void {
  expect(sql.filter(query => /^(?:DELETE FROM|INSERT INTO) delivery_queue_meta(?:\b|_state\b)/.test(query))).toEqual([]);
  expect(sql.filter(query => /^UPDATE delivery_queue_meta_state SET revision=\?/.test(query))).toEqual([]);
}
const env = (text: string, priority: "status" | "important" = "status") => newEnvelope("user", text, { to: ["worker"], priority });
function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("queue metadata transport barrier timed out")), 3000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test("assignment queue metadata counts waiting envelopes, uses host arrival time and never reads payload/history", () => {
  const f = fixture(), first = { ...env("PRIVATE_BODY_CANARY"), ts: 1 }, second = { ...env("second"), ts: Number.MAX_SAFE_INTEGER };
  const before = Date.now(); f.bus.publish(first); f.bus.publish(second); const after = Date.now();
  expect(f.journal.list()).toHaveLength(0); // These ordinary queues have not become delivery batches.
  const sql: string[] = [], db = (f.journal as any).db;
  (f.journal as any).db = new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === "query") return (query: string, ...args: unknown[]) => { sql.push(query); return value.call(target, query, ...args); };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  for (const key of ["list", "unresolved", "snapshot", "get"] as const) f.journal[key] = (() => { throw new Error("full delivery read is forbidden"); }) as any;
  Object.defineProperty(first, "body", { get() { throw new Error("body read is forbidden"); } });
  try {
    const pressure = f.bus.assignmentQueue("worker");
    expect(pressure.queued).toBe(2);
    expect(pressure.oldestQueuedAt).toBeGreaterThanOrEqual(before);
    expect(pressure.oldestQueuedAt).toBeLessThanOrEqual(after);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("delivery_queue_meta");
    expect(sql[0]).not.toMatch(/originals|out_json|bus_snapshot|ORDER BY/i);
  } finally { (f.journal as any).db = db; }
});

test("batch admission removes every handed-out envelope from queue pressure without counting the batch as a new queue item", async () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) f.bus.publish(env(`item ${n}`));
  expect(f.bus.assignmentQueue("worker").queued).toBe(3);
  const admitted = new Promise<void>(resolve => { f.peer.admitted = resolve; });
  f.peer.set("idle"); await bounded(admitted);
  expect(f.peer.batches).toHaveLength(1); expect(f.peer.batches[0]).toHaveLength(3);
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 0, oldestQueuedAt: null });
  expect(f.journal.list("worker")).toHaveLength(1);
  f.bus.publish(env("later"));
  expect(f.bus.assignmentQueue("worker").queued).toBe(1);
});

test("tracked queue arrival provenance survives a journal restart and is not recreated from sender timestamps", () => {
  const f = fixture(), message = { ...env("waiting"), ts: 1 };
  f.bus.publish(message);
  const before = f.bus.assignmentQueue("worker"); f.bus.closeJournal();
  const journal = f.open("second"), bus = new Bus({ journal, batchMs: 0, trackQueuePressure: () => true }); cleanup.push(() => bus.closeJournal());
  expect(bus.assignmentQueue("worker")).toEqual(before);
  expect(bus.snapshot(false).queues.worker?.map(item => item.id)).toEqual([message.id]);
});

test("legacy queued age stays unknown through resave and restart until those envelopes drain", () => {
  let tracked = false;
  const f = fixture(() => tracked), old = env("legacy");
  f.bus.publish(old);
  expect(f.bus.snapshot(false).queuedAt).toBeUndefined();
  tracked = true;
  const fresh = env("fresh"); f.bus.publish(fresh);
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 2 });
  const known = f.bus.snapshot(false).queuedAt?.worker?.[fresh.id];
  expect(known).toBeGreaterThan(0);
  f.bus.setManualPaused([]); f.bus.closeJournal();
  const journal = f.open("second"), bus = new Bus({ journal, batchMs: 0, trackQueuePressure: () => true }); cleanup.push(() => bus.closeJournal());
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 2 });
  bus.withdraw(old.id);
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 1, oldestQueuedAt: known });
});

test("disabled tracking preserves the v1 snapshot shape, queued order and important/withdrawal behaviour", () => {
  const bus = new Bus({ batchMs: 0 }), peer = new Peer(); cleanup.push(() => bus.closeJournal()); bus.add(peer);
  const one = env("one"), important = env("urgent", "important"), three = env("three");
  bus.publish(one); bus.publish(important); bus.publish(three);
  const snapshot = bus.snapshot(false);
  expect(Object.keys(snapshot).sort()).toEqual(["attempts", "manualPaused", "prefaces", "queues", "schemaVersion", "seen", "withdrawn"]);
  expect(snapshot.queues.worker?.map(item => item.id)).toEqual([one.id, important.id, three.id]);
  expect(bus.queuedImportant("worker")).toBe(1);
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 3 });
  bus.withdraw(important.id);
  expect(bus.snapshot(false).queues.worker?.map(item => item.id)).toEqual([one.id, three.id]);
  expect(bus.queuedImportant("worker")).toBe(0);
});

test("a legacy writer revision invalidates queue summaries instead of making an old queue appear fresh", () => {
  const f = fixture(); f.bus.publish(env("waiting"));
  const TEST_DB_BUSY_TIMEOUT_MS = 1;
  const db = new Database(f.file);
  db.run(`PRAGMA busy_timeout = ${TEST_DB_BUSY_TIMEOUT_MS}`);
  try { db.query("UPDATE delivery_meta SET revision=revision+1 WHERE project_id=?").run("project"); }
  finally { db.close(); }
  expect(f.journal.pendingQueueMetadata("worker")).toBeUndefined();
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 1 });
});

test("malformed optional arrival metadata is unknown and never changes a restored delivery", () => {
  const f = fixture(), message = env("waiting");
  const snapshot: BusSnapshot = { schemaVersion: 1, queues: { worker: [message] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [], queuedAt: { worker: { [message.id]: -1 } } };
  f.bus.restore(snapshot);
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 1 });
  expect(f.bus.snapshot(false).queues.worker?.map(item => item.id)).toEqual([message.id]);
  f.bus.storageError = "delivery journal unavailable";
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 1 });
});


test("a superseded supervision item retains the first host enqueue age", () => {
  const f = fixture(), at = Date.now() - 60_000;
  const first = newEnvelope("hub", "first", { to: ["worker"], kind: "status", refs: { supervision: true, supervisionKey: "milestone" } });
  f.bus.restore({ schemaVersion: 1, queues: { worker: [first] }, prefaces: {}, seen: [first], attempts: {}, withdrawn: [], queuedAt: { worker: { [first.id]: at } } });
  const replacement = newEnvelope("hub", "updated", { to: ["worker"], kind: "status", refs: { supervision: true, supervisionKey: "milestone" } });
  f.bus.publish(replacement);
  expect(f.bus.snapshot(false).queues.worker?.map(item => item.id)).toEqual([replacement.id]);
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 1, oldestQueuedAt: at });
});

test("arrival metadata cannot push an otherwise valid queued snapshot beyond its existing byte cap", () => {
  const f = fixture(), maximum = 20 * 1024 * 1024;
  const items = Array.from({ length: 21 }, (_, i) => env("x".repeat(i === 20 ? 900_000 : 1_000_000)));
  const snapshot: BusSnapshot = { schemaVersion: 1, queues: { worker: items }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
  const remainder = maximum - JSON.stringify(snapshot).length - 32;
  items[20]!.body += "x".repeat(remainder);
  expect(JSON.stringify(snapshot).length).toBe(maximum - 32);
  snapshot.queuedAt = { worker: Object.fromEntries(items.map(item => [item.id, Date.now()])) };
  expect(() => f.journal.persistBus(snapshot, [], true)).not.toThrow();
  expect(f.journal.pendingQueueMetadata("worker")).toEqual({ queued: 21 });
  const saved = f.journal.snapshot().bus;
  expect(saved.queuedAt).toBeUndefined();
  expect(saved.queues.worker?.map(item => item.id)).toEqual(items.map(item => item.id));
});


test("forgotten provenance for an already queued id is never replaced with a fresh timestamp", () => {
  const bus = new Bus({ batchMs: 0, queueCap: 2, trackQueuePressure: () => true }), peer = new Peer(); cleanup.push(() => bus.closeJournal()); bus.add(peer);
  const old = env("old important", "important");
  bus.restore({ schemaVersion: 1, queues: { worker: [old] }, prefaces: {}, seen: [old], attempts: {}, withdrawn: [], queuedAt: { worker: { [old.id]: Date.now() - 60_000 } } });
  for (let n = 0; n < 2050; n++) bus.publish(env(`ordinary ${n}`));
  expect(bus.assignmentQueue("worker").oldestQueuedAt).toBeUndefined();
  bus.publish(old); // The independently bounded seen set may no longer carry this old id.
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 2 });
});


test("materializing a recovery-deferred notice never fabricates a fresh queued age", () => {
  const f = fixture(); f.bus.setRecoveryHold(true, true);
  const notice = newEnvelope("hub", "deferred task notice", { to: ["worker"], kind: "task" });
  f.bus.publish(notice);
  expect(f.bus.queued("worker")).toBe(0);
  f.bus.setRecoveryHold(false);
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 1 });
  expect(f.bus.snapshot(false).queues.worker?.map(item => item.id)).toEqual([notice.id]);
});


test("default-off publishes and checkpoints never rewrite summary rows or carry summary revisions", () => {
  const f = fixture(() => false), spy = querySpy(f.journal);
  try {
    for (let n = 0; n < 3; n++) {
      f.bus.publish(env(`off ${n}`));
      f.bus.setManualPaused([]);
      expect(f.bus.pull("worker")).toHaveLength(1);
    }
    f.journal.persistBusAndDeliveries(f.bus.snapshot(false), [], []);
    expectNoSummaryMutation(spy.sql);
    expect(spy.sql.filter(query => /^UPDATE delivery_queue_meta_state SET revision=-1/.test(query)).length).toBeLessThanOrEqual(1);
    expect(f.journal.pendingQueueMetadata("worker")).toBeUndefined();
    expect(f.bus.snapshot(false).queuedAt).toBeUndefined();
  } finally { spy.restore(); }
});

test("receipts after a live disable do not carry summary revisions before any disabled snapshot write", async () => {
  let tracking = true;
  const f = fixture(() => tracking); f.bus.publish(env("first tracked turn"));
  const first = new Promise<void>(resolve => { f.peer.admitted = resolve; }); f.peer.set("idle"); await bounded(first);
  tracking = false;
  const spy = querySpy(f.journal);
  try {
    f.bus.deliveryReceipt("worker", { id: f.peer.deliveryIds.at(-1)!, state: "completed" });
    expect(f.journal.pendingQueueMetadata("worker")).toBeUndefined();
    for (let n = 0; n < 2; n++) {
      f.bus.publish(env(`off receipt ${n}`));
      const next = new Promise<void>(resolve => { f.peer.admitted = resolve; }); f.peer.set("idle"); await bounded(next);
      f.bus.deliveryReceipt("worker", { id: f.peer.deliveryIds.at(-1)!, state: "completed" });
    }
    expectNoSummaryMutation(spy.sql);
    expect(spy.sql.filter(query => /^UPDATE delivery_queue_meta_state SET revision=-1/.test(query)).length).toBeLessThanOrEqual(1);
  } finally { spy.restore(); }
});

test("enable-disable-enable never revives discarded queue age, including across restart", () => {
  let tracking = true;
  const f = fixture(() => tracking), old = env("old tracked"); f.bus.publish(old);
  expect(f.bus.assignmentQueue("worker").oldestQueuedAt).toBeGreaterThan(0);
  tracking = false;
  const spy = querySpy(f.journal), disabled = env("arrived while disabled");
  try {
    f.bus.publish(disabled);
    for (let n = 0; n < 3; n++) f.bus.setManualPaused([]);
    expectNoSummaryMutation(spy.sql);
    expect(spy.sql.filter(query => /^UPDATE delivery_queue_meta_state SET revision=-1/.test(query))).toHaveLength(1);
    expect(f.journal.snapshot().bus.queuedAt).toBeUndefined();
  } finally { spy.restore(); }
  tracking = true;
  expect(f.bus.assignmentQueue("worker")).toEqual({ queued: 2 });
  const fresh = env("tracked again"); f.bus.publish(fresh);
  const at = f.bus.snapshot(false).queuedAt?.worker?.[fresh.id];
  expect(at).toBeGreaterThan(0);
  expect(f.journal.pendingQueueMetadata("worker")).toEqual({ queued: 3 });
  f.bus.closeJournal();
  const journal = f.open("second"), bus = new Bus({ journal, batchMs: 0, trackQueuePressure: () => true }); cleanup.push(() => bus.closeJournal());
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 3 });
  bus.withdraw(old.id); bus.withdraw(disabled.id);
  expect(bus.assignmentQueue("worker")).toEqual({ queued: 1, oldestQueuedAt: at });
});

test("the explicit tracking flag covers empty queues and disabled imports ignore supplied arrival metadata", () => {
  const enabled = fixture(() => true), empty = enabled.bus.snapshot(false);
  expect(empty.queuedAt).toBeUndefined();
  enabled.journal.persistBus(empty, [], true);
  expect(enabled.journal.pendingQueueMetadata("worker")).toEqual({ queued: 0, oldestQueuedAt: null });
  const disabled = fixture(() => false), waiting = env("imported while disabled");
  const snapshot: BusSnapshot = { schemaVersion: 1, queues: { worker: [waiting] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [], queuedAt: { worker: { [waiting.id]: Date.now() } } };
  const spy = querySpy(disabled.journal);
  try {
    expect(disabled.journal.importSnapshot({ schemaVersion: 1, revision: 7, instanceId: "source", bus: snapshot, deliveries: [], manualPaused: [] }, "import-off")).toBe(true);
    expectNoSummaryMutation(spy.sql);
    expect(disabled.journal.pendingQueueMetadata("worker")).toBeUndefined();
    expect(disabled.journal.snapshot().bus.queuedAt).toBeUndefined();
  } finally { spy.restore(); }
});
