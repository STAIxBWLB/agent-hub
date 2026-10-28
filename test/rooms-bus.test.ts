import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, type BusEvent, type BusSnapshot } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, replyAudience, type Envelope, type PeerState } from "../src/hub/envelope.ts";

const roots: string[] = [], buses: Bus[] = [];
afterEach(() => { for (const bus of buses.splice(0)) bus.closeJournal(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
class Peer extends BasePeer {
  readonly remoteRoom?: string;
  readonly remoteMember?: string;
  readonly remoteQueueTtlMs?: number;
  batches: Envelope[][] = [];
  deadlines = new Map<string, number>();
  accepted?: (envs: Envelope[], id?: string) => Promise<void>;
  constructor(id: string, room?: string, ttlMs?: number, member = "a".repeat(64)) { super(id); this.remoteRoom = room; this.remoteMember = room ? member : undefined; this.remoteQueueTtlMs = ttlMs; }
  setRemoteDeadline(id: string, expiry: number): void { this.deadlines.set(id, expiry); }
  async deliver(envs: Envelope[], id?: string) {
    this.batches.push(envs);
    if (this.accepted) await this.accepted(envs, id);
    else if (id) this.onDelivery?.({ id, state: "completed" });
  }
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  set(state: PeerState) { this.setState(state); }
}
function fixture(options: ConstructorParameters<typeof Bus>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-room-bus-")); roots.push(root);
  const journal = new DeliveryJournal({ file: join(root, "hub.db"), projectRoot: root, projectId: "rooms", instanceId: crypto.randomUUID() });
  const bus = new Bus({ batchMs: 0, ...options, journal }); buses.push(bus);
  return { root, bus, journal };
}
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(check()).toBe(true);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const remote = "codex@hub-a", room = "room-a";

test("room peers never join a broadcast and malformed or unknown explicit remote targets refuse before effects", () => {
  const { bus } = fixture(), local = new Peer("local"), target = new Peer(remote, room), events: BusEvent[] = [];
  bus.add(local); bus.add(target); bus.tap(event => events.push(event));
  const ordinary = newEnvelope("user", "ordinary broadcast");
  expect(bus.publish(ordinary)).toEqual([local.id]); expect(bus.queueIds(remote)).toEqual([]);
  for (const id of ["ghost@hub-a", "codex@hub-a@evil", "codex@hub-a\n"]) {
    const env = newEnvelope("user", "must not publish", { to: [local.id, id] }), before = events.length;
    expect(() => bus.publish(env)).toThrow();
    expect(bus.get(env.id)).toBeUndefined(); expect(bus.queueIds(local.id)).toEqual([ordinary.id]); expect(events.length).toBe(before);
  }
  const snapshot = bus.snapshot(false);
  snapshot.queues["retired@hub-z"] = [];
  bus.restore(snapshot);
  expect(bus.audience(newEnvelope("user", "still local"))).toEqual([local.id]);
});

test("a remote transport gets one untouched original per signed admission, without prefaces or condensation", async () => {
  let condensed = 0;
  const { bus, journal } = fixture({ batchMs: 60_000, condense: async envs => { condensed++; return [newEnvelope("digest", "rewritten")]; } });
  const target = new Peer(remote, room); bus.add(target);
  bus.preface(remote, "MEMORY-CANARY"); bus.note(remote, "RECALL-CANARY");
  const envs = [newEnvelope("user", "one", { to: [remote] }), newEnvelope("user", "two", { to: [remote] })];
  for (const env of envs) bus.publish(env);
  const deadlines = bus.snapshot(false).remoteQueueExpires![remote]!;
  await target.start(); await until(() => target.batches.length === 2);
  expect(condensed).toBe(0); expect(target.batches.map(batch => batch.map(env => env.id))).toEqual(envs.map(env => [env.id]));
  expect(target.batches.flat().map(env => env.body)).toEqual(["one", "two"]);
  expect([...target.deadlines]).toEqual(envs.map(env => [env.id, deadlines[env.id]!]));
  const completed = journal.list(remote).filter(row => row.state === "completed");
  expect(completed).toHaveLength(2); expect(completed.every(row => row.originals.length === 1 && row.out.length === 1)).toBe(true);
});

test("remote-origin mixed local batches bypass condensation and memory while telemetry gets only stubs", async () => {
  let condensed = 0, memory = 0;
  const { bus } = fixture({ condense: async envs => { condensed++; return envs; } });
  const local = new Peer("local"), target = new Peer(remote, room), events: BusEvent[] = [];
  bus.add(local); bus.add(target); bus.onMemoryDelivery = () => { memory++; }; bus.tap(event => events.push(event));
  const incoming = newEnvelope(remote, "REMOTE-CANARY", { to: [local.id], refs: { paths: ["REF-CANARY"] } });
  const publicLocal = newEnvelope("user", "ordinary", { to: [local.id] });
  bus.publish(incoming); bus.publish(publicLocal); await local.start(); await until(() => local.batches.length === 1);
  expect(condensed).toBe(0); expect(memory).toBe(0);
  expect(local.batches[0]!.map(env => env.body)).toEqual(["REMOTE-CANARY", "ordinary"]);
  expect(JSON.stringify(events)).not.toContain("REMOTE-CANARY"); expect(JSON.stringify(events)).not.toContain("REF-CANARY");
  const outgoing = newEnvelope("user", "OUTGOING-CANARY", { to: [remote], refs: { paths: ["OUTGOING-REF"] } });
  bus.publish(outgoing); await target.start(); await until(() => target.batches.length === 1);
  expect(target.batches[0]![0]!.body).toBe("OUTGOING-CANARY"); expect(memory).toBe(0);
  expect(JSON.stringify(events)).not.toContain("OUTGOING-CANARY"); expect(JSON.stringify(events)).not.toContain("OUTGOING-REF");
});

test("the per-room cap deduplicates host outbox ids and refuses mixed publication atomically", () => {
  const external: string[] = [];
  const { bus } = fixture({ queueCap: 1, remotePending: () => external });
  const a = new Peer(remote, room), b = new Peer("kimi@hub-a", room), local = new Peer("local");
  bus.add(a); bus.add(b); bus.add(local);
  const shared = newEnvelope("user", "shared outbox identity", { to: [a.id] }); bus.publish(shared); external.push(shared.id);
  for (let n = 0; n < 198; n++) bus.publish(newEnvelope("user", `queued ${n}`, { to: [a.id] }));
  expect(bus.remotePendingIds(room)).toHaveLength(199); expect(bus.queued(a.id)).toBe(199);
  external.push("external-outbox-id");
  const refused = newEnvelope("user", "full", { to: [local.id, a.id] });
  expect(() => bus.publish(refused)).toThrow("remote room queue is full");
  expect(bus.get(refused.id)).toBeUndefined(); expect(bus.queueIds(local.id)).toEqual([]); expect(bus.queued(a.id)).toBe(199);
  external.pop(); bus.publish(refused);
  expect(bus.remotePendingIds(room)).toHaveLength(200); expect(bus.queued(a.id)).toBe(200); expect(bus.queueIds(local.id)).toEqual([refused.id]);
});

test("active remote work still occupies the same cap and is deduplicated with its durable outbox", async () => {
  const external: string[] = [], held = deferred();
  const { bus } = fixture({ remotePending: () => external }), target = new Peer(remote, room); bus.add(target);
  target.accepted = async (_envs, id) => { target.set("busy"); target.onDelivery?.({ id: id!, state: "accepted" }); await held.promise; target.onDelivery?.({ id: id!, state: "completed" }); };
  await target.start(); const active = newEnvelope("user", "active", { to: [remote] }); bus.publish(active);
  await until(() => target.batches.length === 1); external.push(active.id);
  try {
    for (let n = 0; n < 199; n++) bus.publish(newEnvelope("user", `offline ${n}`, { to: [remote] }));
    expect(bus.remotePendingIds(room)).toHaveLength(200); expect(bus.queued(remote)).toBe(199);
    const env = newEnvelope("user", "over cap", { to: [remote] });
    expect(() => bus.publish(env)).toThrow("remote room queue is full"); expect(bus.get(env.id)).toBeUndefined();
  } finally { held.resolve(); await until(() => !bus.hasInFlight(remote)); }
});

test("remote queue expiry uses host arrival and survives restart without granting a new TTL", () => {
  const { bus } = fixture(), target = new Peer(remote, room, 60_000); bus.add(target); bus.pause(remote); bus.setManualPaused([remote]);
  const env = { ...newEnvelope("user", "queued", { to: [remote] }), ts: 1 }; bus.publish(env);
  const snapshot = bus.snapshot(false), expiry = snapshot.remoteQueueExpires![remote]![env.id]!;
  expect(expiry).toBeGreaterThan(Date.now()); expect(bus.expireRemoteQueues(expiry - 1)).toBe(0);
  const restored = fixture(); restored.bus.restore(snapshot); restored.bus.add(new Peer(remote, room, 86_400_000));
  expect(restored.bus.snapshot(false).remoteQueueExpires![remote]![env.id]).toBe(expiry);
  expect(restored.bus.expireRemoteQueues(expiry)).toBe(1); expect(restored.bus.queueIds(remote)).toEqual([]);
  expect(restored.bus.isPaused(remote)).toBe(true); expect(restored.bus.manualPausedPeers()).toEqual([remote]);
  expect(restored.journal.unresolved(remote)).toEqual([expect.objectContaining({ state: "needs_review", reason: "remote queue expired before recipient admission", originals: [env] })]);
  expect(restored.bus.expireRemoteQueues(expiry + 1)).toBe(0);
});

test("missing old remote deadlines fail closed without guessing a newly attached recipient identity", async () => {
  const env = newEnvelope("user", "old snapshot", { to: [remote] });
  const old: BusSnapshot = { schemaVersion: 1, queues: { [remote]: [env] }, prefaces: {}, seen: [env], attempts: {}, withdrawn: [] };
  const { bus, journal } = fixture(); bus.restore(old); const target = new Peer(remote, room);
  expect(() => bus.add(target)).toThrow("remote queued identity binding unavailable"); await target.start();
  expect(target.batches).toEqual([]); const row = journal.unresolved(remote)[0]!;
  expect(row).toMatchObject({ state: "needs_review", reason: "remote queue expiry unavailable after restore" });
  expect(bus.noteLateRemoteReceipt(remote, row.id, "completed")).toBe(false);
  expect(bus.queueIds(remote)).toEqual([]);
});

test("late signed evidence for a known recipient never auto-completes needs_review", () => {
  const { bus, journal } = fixture(), target = new Peer(remote, room); bus.add(target);
  const env = newEnvelope("user", "known recipient", { to: [remote] }); bus.publish(env);
  const deadline = bus.snapshot(false).remoteQueueExpires![remote]![env.id]!; bus.expireRemoteQueues(deadline);
  const row = journal.unresolved(remote)[0]!;
  expect(bus.noteLateRemoteReceipt(remote, row.id, "completed")).toBe(true);
  expect(journal.get(row.id)).toMatchObject({ state: "needs_review", reason: "late signed completed receipt: remote queue admitted; remains needs_review" });
  expect(bus.noteLateRemoteReceipt("kimi@hub-a", row.id, "completed")).toBe(false);
  expect(bus.noteLateRemoteReceipt(remote, row.id, "failed_safe")).toBe(true); expect(journal.get(row.id)?.state).toBe("needs_review");
  expect(bus.queueIds(remote)).toEqual([]); expect(target.batches).toEqual([]);
});


test("remote deadline snapshot metadata rejects malformed keys, invalid deadlines and excess side entries", () => {
  const { bus, journal } = fixture(), baseline = bus.snapshot(false);
  for (const remoteQueueExpires of [{ bad: { env: 1 } }, { [remote]: { env: -1 } }, { [remote]: Object.fromEntries(Array.from({ length: 201 }, (_, n) => [`id-${n}`, 1])) }]) {
    expect(() => journal.persistBus({ ...baseline, remoteQueueExpires }, [])).toThrow("invalid delivery journal");
  }
  for (const remoteQueueRooms of [{ bad: room }, { [remote]: "" }, { [remote]: room }]) {
    expect(() => journal.persistBus({ ...baseline, remoteQueueRooms }, [])).toThrow("invalid delivery journal");
  }
  const env = newEnvelope("user", "bound target", { to: [remote] });
  expect(() => journal.persistBus({ ...baseline, queues: { [remote]: [env] }, remoteQueueMembers: { [remote]: "g".repeat(64) } }, [])).toThrow("invalid delivery journal");
});


test("host private-turn provenance is captured before publication and cannot be laundered by offline waiting or restart", () => {
  let privateTurn: boolean | undefined = true;
  const { bus } = fixture({ remotePrivate: () => privateTurn }), target = new Peer(remote, room); bus.add(target);
  const env = newEnvelope("codex", "private turn output", { to: [remote] }); bus.publish(env);
  privateTurn = false;
  const snapshot = bus.snapshot(false);
  expect(env.private).toBe(true); expect(snapshot.queues[remote]![0]!.private).toBe(true);
  const restored = fixture({ remotePrivate: () => false }); restored.bus.restore(snapshot); restored.bus.add(new Peer(remote, room));
  expect(restored.bus.snapshot(false).queues[remote]![0]!.private).toBe(true);
  privateTurn = undefined;
  const unknown = newEnvelope("codex", "unknown turn", { to: [remote] }); bus.publish(unknown); expect(unknown.private).toBe(true);
});


test("restored remote queues retain their host room cap without an attached adapter and cannot be retargeted", () => {
  const first = fixture(), target = new Peer(remote, room); first.bus.add(target);
  for (let n = 0; n < 199; n++) first.bus.publish(newEnvelope("user", `retained ${n}`, { to: [remote] }));
  const snapshot = first.bus.snapshot(false);
  expect(snapshot.remoteQueueRooms).toEqual({ [remote]: room });
  const next = fixture(); next.bus.restore(snapshot);
  expect(next.bus.remotePendingIds(room)).toHaveLength(199);
  expect(() => next.bus.add(new Peer(remote, "another-room"))).toThrow("remote queued room binding changed");
  const other = new Peer("kimi@hub-b", room), local = new Peer("local"); next.bus.add(other); next.bus.add(local);
  next.bus.publish(newEnvelope("user", "last room slot", { to: [other.id] }));
  const blocked = newEnvelope("user", "not a fresh capacity", { to: [local.id, other.id] });
  expect(() => next.bus.publish(blocked)).toThrow("remote room queue is full");
  expect(next.bus.queueIds(local.id)).toEqual([]); expect(next.bus.queueIds(remote)).toHaveLength(199); expect(next.bus.get(blocked.id)).toBeUndefined();
});

test("a legacy queued remote with an unknown room never borrows a newly attached adapter binding", async () => {
  const env = newEnvelope("user", "unknown room", { to: [remote] });
  const snapshot: BusSnapshot = { schemaVersion: 1, queues: { [remote]: [env] }, prefaces: {}, seen: [env], attempts: {}, withdrawn: [], remoteQueueExpires: { [remote]: { [env.id]: Date.now() + 86_400_000 } } };
  const { bus, journal } = fixture(); bus.restore(snapshot); const target = new Peer(remote, room); expect(() => bus.add(target)).toThrow("remote queued identity binding unavailable"); await target.start();
  expect(target.batches).toEqual([]); expect(bus.queueIds(remote)).toEqual([]);
  expect(journal.unresolved(remote)).toEqual([expect.objectContaining({ state: "needs_review", reason: "remote queue room binding unavailable after restore" })]);
});

test("a failed remote deadline handoff retains needs_review without calling the transport", async () => {
  const { bus, journal } = fixture(), target = new Peer(remote, room); bus.add(target);
  target.setRemoteDeadline = () => { throw new Error("fixture deadline unavailable"); };
  bus.publish(newEnvelope("user", "queued before the fixed deadline", { to: [remote] }));
  await target.start(); await until(() => journal.unresolved(remote).some(row => row.state === "needs_review"));
  expect(target.batches).toEqual([]);
  expect(journal.unresolved(remote)[0]?.state).toBe("needs_review");
});


test("the next remote expiry reads queued metadata only and makes unknown legacy work immediately due", () => {
  const { bus, journal } = fixture(), a = new Peer(remote, room, 60_000), b = new Peer("kimi@hub-b", "room-b", 120_000);
  bus.add(a); bus.add(b); bus.add(new Peer("local"));
  expect(bus.nextRemoteExpiry()).toBeUndefined();
  bus.publish(newEnvelope("user", "native queue", { to: ["local"] }));
  expect(bus.nextRemoteExpiry()).toBeUndefined();
  const later = newEnvelope("user", "later remote", { to: [b.id] }), earlier = newEnvelope("user", "earlier remote", { to: [a.id] });
  bus.publish(later); bus.publish(earlier);
  const deadline = bus.snapshot(false).remoteQueueExpires![a.id]![earlier.id];
  const snapshot = journal.snapshot.bind(journal), list = journal.list.bind(journal);
  journal.snapshot = () => { throw new Error("no snapshot on timer path"); };
  journal.list = () => { throw new Error("no history on timer path"); };
  try { expect(bus.nextRemoteExpiry()).toBe(deadline); }
  finally { journal.snapshot = snapshot; journal.list = list; }
  bus.withdraw(earlier.id); expect(bus.nextRemoteExpiry()).toBeGreaterThan(deadline!);
  bus.withdraw(later.id); expect(bus.nextRemoteExpiry()).toBeUndefined();
  const env = newEnvelope("user", "legacy remote", { to: [remote] }), old = fixture();
  old.bus.restore({ schemaVersion: 1, queues: { [remote]: [env] }, prefaces: {}, seen: [env], attempts: {}, withdrawn: [] });
  const before = Date.now(), due = old.bus.nextRemoteExpiry();
  expect(due).toBeGreaterThanOrEqual(before); expect(due).toBeLessThanOrEqual(Date.now());
});


test("a reused room label cannot inherit queued text after its original member was revoked", async () => {
  const first = fixture(), original = "a".repeat(64), replacement = "b".repeat(64);
  first.bus.add(new Peer(remote, room, undefined, original));
  const env = newEnvelope("user", "original member only", { to: [remote] }); first.bus.publish(env);
  const snapshot = first.bus.snapshot(false);
  expect(snapshot.remoteQueueMembers).toEqual({ [remote]: original });
  const next = fixture(); next.bus.restore(snapshot);
  const foreign = new Peer(remote, room, undefined, replacement);
  expect(() => next.bus.add(foreign)).toThrow("remote queued member binding changed");
  await foreign.start(); expect(foreign.batches).toEqual([]);
  expect(next.bus.queueIds(remote)).toEqual([env.id]);
  const legacy = { ...snapshot }; delete legacy.remoteQueueMembers;
  const unknown = fixture(); unknown.bus.restore(legacy); const current = new Peer(remote, room, undefined, replacement);
  expect(() => unknown.bus.add(current)).toThrow("remote queued identity binding unavailable"); await current.start();
  expect(current.batches).toEqual([]); expect(unknown.bus.queueIds(remote)).toEqual([]);
  expect(unknown.journal.unresolved(remote)).toEqual([expect.objectContaining({ state: "needs_review", reason: "remote queue member binding unavailable after restore" })]);
});


test("room admission journal availability distinguishes a bare bus, known storage failure and closed journal", () => {
  const bare = new Bus(); buses.push(bare); expect(bare.deliveryJournalAvailable()).toBe(false);
  const { bus } = fixture(); expect(bus.deliveryJournalAvailable()).toBe(true);
  bus.storageError = "fixture storage unavailable"; expect(bus.deliveryJournalAvailable()).toBe(false);
  bus.storageError = undefined; expect(bus.deliveryJournalAvailable()).toBe(true);
  bus.closeJournal(); buses.splice(buses.indexOf(bus), 1); expect(bus.deliveryJournalAvailable()).toBe(false);
});


test("remote identity survives dispatch restart and refuses foreign re-enrollment, a new send and person retry", async () => {
  const first = fixture(), original = "a".repeat(64), replacement = "b".repeat(64), target = new Peer(remote, room, undefined, original);
  target.accepted = async (_envs, id) => { target.onDelivery?.({ id: id!, state: "accepted" }); };
  first.bus.add(target); await target.start();
  const old = newEnvelope("user", "ORIGINAL-PRIVATE-TO-RECIPIENT", { to: [remote] }); first.bus.publish(old);
  await until(() => first.journal.unresolved(remote).some(row => row.state === "accepted"));
  const persisted = first.journal.snapshot().bus;
  expect(persisted.queues[remote]).toEqual([]);
  expect(persisted.remoteQueueRooms).toEqual({ [remote]: room }); expect(persisted.remoteQueueMembers).toEqual({ [remote]: original });
  first.bus.closeJournal(); buses.splice(buses.indexOf(first.bus), 1);
  const journal = new DeliveryJournal({ file: join(first.root, "hub.db"), projectRoot: first.root, projectId: "rooms", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal, batchMs: 0 }); buses.push(bus);
  const uncertain = journal.unresolved(remote)[0]!; expect(uncertain.state).toBe("needs_review");
  const foreign = new Peer(remote, room, undefined, replacement);
  expect(() => bus.add(foreign)).toThrow("remote queued member binding changed");
  // Exercise publication and retry fences independently even if a host bypasses add's check.
  bus.peers.set(remote, foreign);
  const fresh = newEnvelope("user", "fresh replacement message", { to: [remote] });
  expect(() => bus.publish(fresh)).toThrow("remote queued identity binding changed"); expect(bus.get(fresh.id)).toBeUndefined();
  expect(() => bus.resolveDelivery(uncertain.id, uncertain.revision, "retry", "person asks to retry")).toThrow("remote original identity unavailable");
  expect(journal.get(uncertain.id)?.state).toBe("needs_review"); expect(foreign.batches).toEqual([]);
  expect(bus.snapshot(false).remoteQueueMembers).toEqual({ [remote]: original });
  bus.peers.delete(remote);
  bus.resolveDelivery(uncertain.id, uncertain.revision, "discard", "person explicitly discards old uncertainty");
  bus.add(foreign); bus.publish(fresh); await foreign.start(); await until(() => foreign.batches.length === 1);
  expect(foreign.batches.flat().map(env => env.body)).toEqual(["fresh replacement message"]);
  expect(() => bus.resolveDelivery(uncertain.id, journal.get(uncertain.id)!.revision, "retry", "revive old text")).toThrow();
  expect(foreign.batches.flat().some(env => env.id === old.id)).toBe(false);
});

test("terminal remote failure history cannot mint a fresh retry binding from a replacement recipient", () => {
  const { bus, journal } = fixture(), old = newEnvelope("user", "old failed recipient", { to: [remote] });
  const failed = journal.createDelivery({ id: "old-failed", peer: remote, state: "failed", createdAt: old.ts, originals: [old], out: [old] });
  const foreign = new Peer(remote, room, undefined, "b".repeat(64)); bus.add(foreign);
  bus.publish(newEnvelope("user", "fresh recipient only", { to: [remote] }));
  expect(() => bus.resolveDelivery(failed.id, failed.revision, "retry", "retry failed history")).toThrow("remote original identity unavailable");
  expect(journal.get(failed.id)?.state).toBe("failed"); expect(bus.queueIds(remote)).not.toContain(old.id);
});

test("two remote targets refuse before limiter, telemetry or local fanout, while one remote plus locals works", () => {
  let admitted = 0;
  const { bus } = fixture({ admit: () => { admitted++; return undefined; } });
  const sender = new Peer("sender"), local = new Peer("local"), a = new Peer(remote, room), b = new Peer("kimi@hub-b", "room-b");
  for (const peer of [sender, local, a, b]) bus.add(peer);
  const events: BusEvent[] = []; bus.tap(event => events.push(event));
  const refusal = sender.onMessage?.("mixed fanout", { to: [local.id, a.id, b.id] });
  expect(typeof refusal).toBe("string");
  expect(refusal).toContain(a.id); expect(refusal).toContain(b.id); expect(refusal).toContain("send to each remote peer separately");
  expect(bus.snapshot(false).prefaces[sender.id]?.body).toContain("your message was not delivered");
  expect(admitted).toBe(0); expect(events).toEqual([]); expect(bus.snapshot(false).seen).toEqual([]);
  for (const peer of [local, a, b]) expect(bus.queueIds(peer.id)).toEqual([]);
  sender.onMessage?.("one explicit remote", { to: [local.id, a.id] });
  expect(admitted).toBe(1); expect(bus.queueIds(local.id)).toHaveLength(1); expect(bus.queueIds(a.id)).toHaveLength(1); expect(bus.queueIds(b.id)).toEqual([]);
});


test("a legacy uncertain journal original without recipient provenance cannot borrow the current roster identity", () => {
  const { bus, journal } = fixture(), env = newEnvelope("user", "legacy uncertain original", { to: [remote] });
  const row = journal.createDelivery({ id: "legacy-uncertain", peer: remote, state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  const target = new Peer(remote, room);
  expect(() => bus.add(target)).toThrow("remote queued identity binding unavailable");
  expect(() => bus.resolveDelivery(row.id, row.revision, "retry", "guess current roster")).toThrow("remote original identity unavailable");
  expect(journal.get(row.id)?.state).toBe("needs_review"); expect(target.batches).toEqual([]);
  bus.resolveDelivery(row.id, row.revision, "discard", "person explicitly disposes unknown provenance");
  expect(() => bus.add(target)).not.toThrow();
});


test("a signed remote failed_safe NACK is terminal without native poison retries or read evidence", async () => {
  const { bus, journal } = fixture(), target = new Peer("user@hub-a", room);
  let delivered = 0, failed = 0, memory = 0;
  bus.onDelivered = () => { delivered++; }; bus.onDeliveryFailed = () => { failed++; }; bus.onMemoryDelivery = () => { memory++; };
  target.accepted = async (_envs, id) => {
    target.set("busy");
    target.onDelivery?.({ id: id!, state: "failed_safe", reason: "remote user inbox is not supported" });
    target.set("idle");
  };
  bus.add(target);
  const env = newEnvelope("user", "unsupported recipient", { to: [target.id] }); bus.publish(env);
  await target.start(); await until(() => target.batches.length > 0 && !bus.hasInFlight(target.id));
  expect(target.batches).toHaveLength(1); expect(bus.queueIds(target.id)).toEqual([]); expect(bus.attemptState()).toEqual({});
  expect(journal.list(target.id)).toEqual([expect.objectContaining({ state: "failed", reason: "remote user inbox is not supported", originals: [env] })]);
  expect(journal.unresolved(target.id)).toEqual([]); expect(bus.failingPeers()).toEqual({});
  expect(delivered).toBe(0); expect(failed).toBe(0); expect(memory).toBe(0);
});

test("a native failed_safe receipt still retains its original for the existing retry path", async () => {
  const { bus, journal } = fixture(), target = new Peer("native"); let failed = 0;
  bus.onDeliveryFailed = () => { failed++; };
  target.accepted = async (_envs, id) => { target.set("busy"); target.onDelivery?.({ id: id!, state: "failed_safe", reason: "native safe failure" }); };
  bus.add(target);
  const env = newEnvelope("user", "native retry control", { to: [target.id] }); bus.publish(env);
  await target.start(); await until(() => target.batches.length === 1 && bus.queueIds(target.id).includes(env.id));
  expect(bus.queueIds(target.id)).toEqual([env.id]); expect(bus.attemptState()).toEqual({ [`${target.id}:${env.id}`]: 1 });
  expect(journal.list(target.id).some(row => row.state === "failed" && row.reason === "native safe failure")).toBe(true);
  expect(failed).toBe(1);
  await target.stop();
});


test("a native turn answer to remote senders returns a refusal and settles idle instead of throwing", async () => {
  for (const mode of ["multi", "full", "late-full"] as const) {
    let full = mode === "full", admissions = 0;
    const { bus, journal } = fixture({
      remotePending: () => full ? Array.from({ length: 200 }, (_, n) => `already-pending-${n}`) : [],
      admit: () => { admissions++; if (mode === "late-full") full = true; return undefined; },
    });
    const native = new Peer("codex"), a = new Peer("claude@bob", room), b = new Peer("codex@bob", room);
    for (const peer of [native, a, b]) bus.add(peer);
    let outcome: unknown;
    native.accepted = async (envs, id) => {
      native.set("busy");
      // Like a turn/completed handler, there is no caller catch around the turn answer.
      outcome = native.onMessage?.("native answer", { to: replyAudience(envs), inReplyTo: envs[0] });
      native.onDelivery?.({ id: id!, state: "completed" }); native.set("idle");
    };
    bus.publish(newEnvelope(a.id, "one sender", { to: [native.id] }));
    if (mode === "multi") bus.publish(newEnvelope(b.id, "second sender", { to: [native.id] }));
    await native.start(); await until(() => native.batches.length === 1 && !bus.hasInFlight(native.id));
    expect(native.state).toBe("idle");
    expect(outcome).toContain(mode === "multi" ? "send to each remote peer separately" : "remote room queue is full");
    expect(bus.snapshot(false).prefaces[native.id]?.body).toContain(String(outcome));
    expect(bus.queued(a.id)).toBe(0); expect(bus.queued(b.id)).toBe(0);
    expect(journal.list(native.id).filter(row => row.state === "completed")).toHaveLength(1);
    expect(admissions).toBe(mode === "late-full" ? 1 : 0);
  }
});


for (const mode of ["valid", "expired", "missing"] as const) test(`a remote uncertain retry validates its ${mode} enqueue deadline before recording disposition`, async () => {
  const { bus, journal } = fixture(), target = new Peer(remote, room); bus.add(target);
  target.accepted = async (_envs, id) => {
    target.onDelivery?.({ id: id!, state: target.batches.length === 1 ? "needs_review" : "completed" });
  };
  await target.start();
  const env = newEnvelope("user", "original remote work", { to: [remote] }); bus.publish(env);
  await until(() => journal.unresolved(remote).some(row => row.state === "needs_review") && !bus.hasInFlight(remote));
  const held = journal.unresolved(remote)[0]!, before = held.revision;
  if (mode === "valid") {
    const deadline = target.deadlines.get(env.id);
    expect(bus.snapshot(false).remoteQueueExpires?.[remote]?.[env.id]).toBe(deadline);
    bus.add(new Peer("local")); bus.publish(newEnvelope("user", "unrelated checkpoint", { to: ["local"] }));
    expect(journal.snapshot().bus.remoteQueueExpires?.[remote]?.[env.id]).toBe(deadline);
    bus.resolveDelivery(held.id, held.revision, "retry", "person retries before the original deadline");
    await until(() => target.batches.length === 2 && !bus.hasInFlight(remote));
    expect(target.batches[1]!.map(item => item.id)).toEqual([env.id]);
    expect(journal.resolution(held.id)?.action).toBe("retry");
    return;
  }
  const clock = Date.now;
  try {
    if (mode === "expired") Date.now = () => target.deadlines.get(env.id)! + 1;
    else {
      const legacy = bus.snapshot(false); delete legacy.remoteQueueExpires;
      bus.restore(legacy); // A genuinely missing legacy proof cannot borrow a fresh TTL.
    }
    expect(() => bus.resolveDelivery(held.id, held.revision, "retry", "person asks to retry")).toThrow("remote original deadline unavailable or expired");
  } finally { Date.now = clock; }
  expect(journal.resolution(held.id)).toBeUndefined();
  expect(journal.get(held.id)).toMatchObject({ state: "needs_review", revision: before });
  expect(bus.queueIds(remote)).toEqual([]); expect(target.batches).toHaveLength(1);
});

test("an expired offline remote queue refuses retry without a successful person disposition", () => {
  const { bus, journal } = fixture(), target = new Peer(remote, room); bus.add(target);
  const env = newEnvelope("user", "expired while offline", { to: [remote] }); bus.publish(env);
  const deadline = bus.snapshot(false).remoteQueueExpires![remote]![env.id]!;
  bus.expireRemoteQueues(deadline + 1);
  const held = journal.unresolved(remote)[0]!;
  expect(held.state).toBe("needs_review");
  expect(() => bus.resolveDelivery(held.id, held.revision, "retry", "retry expired queue")).toThrow("remote original deadline unavailable or expired");
  expect(journal.resolution(held.id)).toBeUndefined(); expect(bus.queueIds(remote)).toEqual([]);
  expect(target.batches).toEqual([]);
});


test("an unexpired remote uncertain deadline survives restart and can authorize the person's retry", async () => {
  const first = fixture(), target = new Peer(remote, room); first.bus.add(target);
  target.accepted = async (_envs, id) => { target.onDelivery?.({ id: id!, state: "needs_review" }); };
  await target.start(); const env = newEnvelope("user", "uncertain before restart", { to: [remote] }); first.bus.publish(env);
  await until(() => first.journal.unresolved(remote).some(row => row.state === "needs_review") && !first.bus.hasInFlight(remote));
  const deadline = target.deadlines.get(env.id)!;
  expect(first.bus.snapshot(false).remoteQueueExpires?.[remote]?.[env.id]).toBe(deadline);
  first.bus.closeJournal(); buses.splice(buses.indexOf(first.bus), 1);
  const journal = new DeliveryJournal({ file: join(first.root, "hub.db"), projectRoot: first.root, projectId: "rooms", instanceId: crypto.randomUUID() });
  const bus = new Bus({ journal, batchMs: 0 }); buses.push(bus); const replacement = new Peer(remote, room); bus.add(replacement);
  await replacement.start(); const held = journal.unresolved(remote)[0]!;
  expect(bus.snapshot(false).remoteQueueExpires?.[remote]?.[env.id]).toBe(deadline);
  bus.resolveDelivery(held.id, held.revision, "retry", "same recipient before the original expiry");
  await until(() => replacement.batches.length === 1 && !bus.hasInFlight(remote));
  expect(replacement.batches[0]!.map(item => item.id)).toEqual([env.id]); expect(replacement.deadlines.get(env.id)).toBe(deadline);
  expect(journal.resolution(held.id)?.action).toBe("retry");
});
