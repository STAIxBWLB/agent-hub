import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal, MAX_ENVELOPE_BODY } from "../src/hub/delivery-journal.ts";
import { newEnvelope, noteLine, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
class Peer extends BasePeer {
  got: Envelope[][] = [];
  ids: string[] = [];
  pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  setBusy() { this.setState("busy"); }
  idle() { this.setState("idle"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push(envs); if (id) { this.ids.push(id); this.delivery({ id, state: "needs_review" }); } }
}
function rig(priority: "status" | "important" = "status") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-recipient-retry-"));
  let journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "i" });
  let bus = new Bus({ journal, batchMs: 0, retryMs: 1 });
  cleanup.push(() => { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); });
  const original = newEnvelope("user", "PRIVATE ORIGINAL", { to: ["codex"], private: true, priority });
  journal.createDelivery({ id: "held", peer: "codex", state: "needs_review", createdAt: original.ts, originals: [original], out: [original] });
  const reopen = () => { bus.closeJournal(); journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "next" }); bus = new Bus({ journal, batchMs: 0, retryMs: 1 }); return { bus, journal }; };
  return { dir, journal, bus, original, reopen };
}
async function until(condition: () => boolean) { for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(1); expect(condition()).toBe(true); }

test("AC5 own retry puts originals back once and pull renders a fixed warning without changing originals", async () => {
  const f = rig(), peer = new Peer("codex"); f.bus.add(peer); await peer.start();
  f.bus.retryDelivery("codex", "held");
  const out = f.bus.pull("codex")!;
  expect(out).toHaveLength(1);
  expect(out[0]!.body).toStartWith("Hub redelivery warning:");
  expect(out[0]!.body).toContain("earlier attempt"); expect(out[0]!.body).toContain("check for its effects before acting");
  expect(f.original.body).toBe("PRIVATE ORIGINAL");
  expect(f.journal.get("held")!.originals[0]!.body).toBe("PRIVATE ORIGINAL");
  expect(f.journal.resolution("held")).toMatchObject({ action: "retry", actor: "peer:codex" });
  expect(() => f.bus.retryDelivery("codex", "held")).toThrow();
});

test("AC5 busy own peer consents to requeue only; the real push after idle warns and stays person-only on second uncertainty across restart", async () => {
  const f = rig(), peer = new Peer("codex"); peer.pullOnly = false; f.bus.add(peer); await peer.start(); peer.setBusy();
  f.bus.retryDelivery("codex", "held");
  expect(f.bus.queued("codex")).toBe(1); expect(peer.got).toEqual([]);
  peer.idle(); await until(() => peer.got.length === 1);
  expect(peer.got[0]![0]!.body).toStartWith("Hub redelivery warning:");
  const id = peer.ids[0]!; expect(f.bus.queueShow(id)?.state).toBe("needs_review");
  expect(() => f.bus.retryDelivery("codex", id)).toThrow();
  const reopened = f.reopen(); expect(() => reopened.bus.retryDelivery("codex", id)).toThrow();
});

test("AC5 another recipient and non-needs_review rows cannot use recipient retry", () => {
  const f = rig();
  expect(() => f.bus.retryDelivery("pi", "held")).toThrow();
  expect(f.journal.get("held")?.state).toBe("needs_review");
  for (const state of ["queued", "dispatching", "accepted", "completed", "discarded", "failed"] as const) {
    f.journal.createDelivery({ id: state, peer: "codex", state, createdAt: f.original.ts, originals: [f.original], out: [f.original] });
    expect(() => f.bus.retryDelivery("codex", state)).toThrow();
  }
});

test("an explicit console retry consumes the peer right but a safe-failure-only lineage does not", () => {
  const f = rig(), row = f.journal.get("held")!;
  f.bus.resolveDelivery(row.id, row.revision, "retry", "person inspected uncertainty");
  f.journal.createDelivery({ id: "again", peer: "codex", state: "needs_review", createdAt: f.original.ts, originals: [f.original], out: [f.original] });
  expect(() => f.bus.retryDelivery("codex", "again")).toThrow("recipient retry unavailable");
  const fresh = newEnvelope("user", "never explicitly retried");
  f.journal.createDelivery({ id: "safe-only", peer: "codex", state: "failed", createdAt: fresh.ts, originals: [fresh], out: [fresh] });
  f.journal.createDelivery({ id: "safe-descendant", peer: "codex", state: "needs_review", createdAt: fresh.ts, originals: [fresh], out: [fresh], previousId: "safe-only" });
  f.bus.retryDelivery("codex", "safe-descendant");
  expect(f.journal.resolution("safe-descendant")?.actor).toBe("peer:codex");
});

test("coalescing does not lose a retried non-first parent, and condensation cannot erase its warning", async () => {
  const f = rig(), second = newEnvelope("user", "second uncertain original");
  f.journal.transition("held", "completed");
  f.journal.createDelivery({ id: "first-clean", peer: "codex", state: "queued", createdAt: 1, originals: [f.original], out: [f.original] });
  const held = f.journal.createDelivery({ id: "second-held", peer: "codex", state: "needs_review", createdAt: 2, originals: [second], out: [second] });
  f.journal.resolve(held.id, held.revision, "retry", "recipient requested retry", held.revision, "peer:codex");
  f.journal.persistBus({ ...f.bus.snapshot(false), queues: { codex: [f.original, second] } }, []);
  f.bus.closeJournal();
  const journal = new DeliveryJournal({ file: join(f.dir, "hub.db"), projectRoot: f.dir, projectId: "p", instanceId: "coalesced" });
  const bus = new Bus({ journal, batchMs: 0, condense: async () => [newEnvelope("digest", "condensed body")] });
  const peer = new Peer("codex"); peer.pullOnly = false; bus.add(peer); await peer.start();
  try {
    await until(() => peer.got.length === 1);
    const current = journal.get(peer.ids[0]!)!;
    expect(current.previousId).toBe("first-clean"); expect(current.attempt).toBeGreaterThan(0);
    expect(current.originals.map(env => env.body)).toEqual(["PRIVATE ORIGINAL", "second uncertain original"]);
    expect(peer.got[0]![0]!.body).toStartWith("Hub redelivery warning:");
    expect(peer.got[0]![0]!.body).toContain("condensed body");
    expect(() => bus.retryDelivery("codex", current.id)).toThrow("recipient retry unavailable");
  } finally { bus.closeJournal(); }
});

test("safe failure after the explicit retry preserves warning and consumed right on the next actual push", async () => {
  const f = rig();
  class SafeOnce extends Peer {
    override async deliver(envs: Envelope[], id?: string) {
      if (!this.got.length && id) { this.got.push(envs); this.ids.push(id); this.delivery({ id, state: "failed_safe" }); }
      else await super.deliver(envs, id);
    }
  }
  const peer = new SafeOnce("codex"); peer.pullOnly = false; f.bus.add(peer); await peer.start();
  f.bus.retryDelivery("codex", "held");
  await until(() => peer.got.length === 2);
  expect(peer.got.every(out => out[0]!.body.startsWith("Hub redelivery warning:"))).toBe(true);
  expect(() => f.bus.retryDelivery("codex", peer.ids[1]!)).toThrow("recipient retry unavailable");
  expect(f.journal.get(peer.ids[1]!)?.originals[0]!.body).toBe("PRIVATE ORIGINAL");
});

test("history survives terminal pruning and stays scoped to each fan-out recipient", () => {
  const f = rig(); f.bus.retryDelivery("codex", "held");
  f.journal.transition("held:retry:1", "completed");
  f.journal.transaction(() => { for (let i = 0; i < 2050; i++) f.journal.createDelivery({ id: `prune-${i}`, peer: "codex", state: "completed", createdAt: i, originals: [], out: [] }); });
  expect(f.journal.get("held")).toBeUndefined(); expect(f.journal.get("held:retry:1")).toBeUndefined();
  f.journal.createDelivery({ id: "after-prune", peer: "codex", state: "needs_review", createdAt: Date.now(), originals: [f.original], out: [f.original] });
  expect(() => f.bus.retryDelivery("codex", "after-prune")).toThrow("recipient retry unavailable");
  f.journal.createDelivery({ id: "fanout", peer: "pi", state: "needs_review", createdAt: Date.now(), originals: [f.original], out: [f.original] });
  f.bus.retryDelivery("pi", "fanout"); expect(f.journal.resolution("fanout")?.actor).toBe("peer:pi");
});

test("imported history is conservatively unknown only for imported peer/original ids; new unrelated rows retain their right", () => {
  const f = rig(), dir = mkdtempSync(join(tmpdir(), "ahub-retry-import-"));
  const imported = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: f.dir, projectId: "p", instanceId: "imported", operationId: "op" });
  const snapshot = f.journal.snapshot(); imported.importSnapshot(snapshot, "op");
  const bus = new Bus({ journal: imported, batchMs: 0 });
  try {
    expect(imported.retryEvidence("codex", [f.original])).toBe("unknown");
    expect(() => bus.retryDelivery("codex", "held")).toThrow("recipient retry unavailable");
    const fresh = newEnvelope("user", "fresh after import");
    imported.createDelivery({ id: "fresh", peer: "codex", state: "needs_review", createdAt: fresh.ts, originals: [fresh], out: [fresh] });
    bus.retryDelivery("codex", "fresh"); expect(imported.resolution("fresh")?.actor).toBe("peer:codex");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("recipient names that are Object prototype members keep an unused right", () => {
  const f = rig();
  for (const peer of ["constructor", "toString"]) {
    const env = newEnvelope("user", "name-safe work");
    f.journal.createDelivery({ id: peer, peer, state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    expect(f.journal.retryEvidence(peer, [env])).toBe("unused"); f.bus.retryDelivery(peer, peer);
    expect(f.journal.resolution(peer)?.actor).toBe(`peer:${peer}`);
  }
});

test("an actual important steer of a retried original carries the same fixed warning", async () => {
  const f = rig("important"), held = f.journal.get("held")!;
  f.journal.resolve(held.id, held.revision, "retry", "recipient requested retry", held.revision, "peer:codex");
  class Steering extends Peer { async steer(envs: Envelope[], id?: string) { await this.deliver(envs, id); } }
  const peer = new Steering("codex"); peer.pullOnly = false; f.bus.add(peer); await peer.start(); peer.setBusy();
  f.bus.publish(f.original); await until(() => peer.got.length === 1);
  expect(peer.got[0]![0]!.body).toStartWith("Hub redelivery warning:");
  expect(f.journal.get(peer.ids[0]!)?.originals[0]!.body).toBe("PRIVATE ORIGINAL");
  expect(() => f.bus.retryDelivery("codex", peer.ids[0]!)).toThrow("recipient retry unavailable");
  peer.idle();
});

test("late-opened projects in a shared legacy DB get their own unmappable-history fence, not a global feature disable", async () => {
  const f = rig(), file = join(f.dir, "hub.db");
  const second = new DeliveryJournal({ file, projectRoot: f.dir, projectId: "second-project", instanceId: "second" });
  const env = newEnvelope("user", "legacy second-project original");
  const row = second.createDelivery({ id: "legacy-second", peer: "codex", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  second.resolve(row.id, row.revision, "retry", "legacy console retry");
  second.createDelivery({ id: "legacy-coalesced", peer: "codex", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
  second.close(); f.bus.closeJournal();
  const { Database } = await import("bun:sqlite");
  const legacy = new Database(file);
  legacy.run("DROP INDEX resolution_retry_peer");
  legacy.run("ALTER TABLE resolution_history DROP COLUMN peer"); legacy.run("ALTER TABLE resolution_history DROP COLUMN original_ids");
  legacy.run("ALTER TABLE delivery_meta DROP COLUMN retry_history_cursor");
  legacy.run("DELETE FROM deliveries WHERE id IN ('legacy-second', 'legacy-second:retry:1')"); legacy.close();
  const firstOpen = new DeliveryJournal({ file, projectRoot: f.dir, projectId: "p", instanceId: "first-open" }); firstOpen.close();
  const laterOpen = new DeliveryJournal({ file, projectRoot: f.dir, projectId: "second-project", instanceId: "later-open" });
  try {
    expect(laterOpen.retryEvidence("codex", [env])).toBe("unknown");
    const fresh = newEnvelope("user", "new independent work");
    laterOpen.createDelivery({ id: "new-independent", peer: "codex", state: "needs_review", createdAt: fresh.ts, originals: [fresh], out: [fresh] });
    expect(laterOpen.retryEvidence("codex", [fresh])).toBe("unused");
    laterOpen.close();
    const again = new DeliveryJournal({ file, projectRoot: f.dir, projectId: "second-project", instanceId: "again" });
    try { expect(again.retryEvidence("codex", [fresh])).toBe("unused"); expect(again.retryEvidence("codex", [env])).toBe("unknown"); }
    finally { again.close(); }
  } finally { laterOpen.close(); }
});

test("an old-format explicit retry inserted after migration is recovered on return without consuming unrelated work", async () => {
  const f = rig(), initial = f.journal.get("held")!;
  f.journal.transition("held", "failed");
  f.journal.createDelivery({ id: "old-writer-coalesced", peer: "codex", state: "needs_review", createdAt: f.original.ts, originals: [f.original], out: [f.original] });
  const fresh = newEnvelope("user", "independent existing work");
  f.journal.createDelivery({ id: "unrelated", peer: "codex", state: "needs_review", createdAt: fresh.ts, originals: [fresh], out: [fresh] });
  f.bus.closeJournal();
  const { Database } = await import("bun:sqlite"); const old = new Database(join(f.dir, "hub.db"));
  old.query("INSERT INTO resolution_history (project_id, delivery_id, observed_revision, action, reason, result_revision, result_state) VALUES (?, ?, ?, 'retry', 'older writer retry', ?, 'failed')").run("p", "held", initial.revision, initial.revision + 1);
  old.close();
  writeFileSync(join(f.dir, "status.json"), JSON.stringify({ projectId: "p", cwd: f.dir, instanceId: "i", pid: process.pid }));
  expect(() => new DeliveryJournal({ file: join(f.dir, "hub.db"), projectRoot: f.dir, projectId: "p", instanceId: "refused" })).toThrow("live");
  const fenced = new Database(join(f.dir, "hub.db"));
  expect((fenced.query("SELECT peer FROM resolution_history WHERE delivery_id = 'held'").get() as { peer: string }).peer).toBe(""); fenced.close();
  rmSync(join(f.dir, "status.json"));
  const next = f.reopen();
  expect(next.journal.retryEvidence("codex", [f.original])).toBe("used");
  expect(() => next.bus.retryDelivery("codex", "old-writer-coalesced")).toThrow("recipient retry unavailable");
  expect(next.journal.retryEvidence("codex", [fresh])).toBe("unused");
  next.bus.retryDelivery("codex", "unrelated"); expect(next.journal.resolution("unrelated")?.actor).toBe("peer:codex");
});

test("recipient retry preserves in-flight and later presence notes once each while adding only its rendered warning", async () => {
  const f = rig(); f.journal.transition("held", "completed");
  class InFlight extends Peer {
    override async deliver(envs: Envelope[], id?: string) {
      this.got.push(envs); if (!id) return; this.ids.push(id);
      if (this.got.length === 1) {
        f.bus.note("codex", noteLine("pi", "fail", "in-flight"));
        this.delivery({ id, state: "needs_review" });
      } else this.delivery({ id, state: "completed" });
    }
  }
  const peer = new InFlight("codex"); peer.pullOnly = false; f.bus.add(peer); await peer.start();
  f.bus.preface("codex", "initial recall");
  f.bus.publish(newEnvelope("user", "work with presence", { to: ["codex"], priority: "important" }));
  await until(() => peer.got.length === 1);
  f.bus.note("codex", noteLine("pi", "finding", "after-failure"));
  f.bus.retryDelivery("codex", peer.ids[0]!); await until(() => peer.got.length === 2);
  const presence = peer.got[1]!.find(env => env.from === "hub" && env.kind === "presence")!;
  expect(presence.body).toStartWith("Hub redelivery warning:");
  expect(presence.body.match(/note from pi \[fail\]: in-flight/g)).toHaveLength(1);
  expect(presence.body.match(/note from pi \[finding\]: after-failure/g)).toHaveLength(1);
  expect(presence.body.match(/initial recall/g)).toHaveLength(1);
  expect(f.journal.get(peer.ids[0]!)!.originals.find(env => env.kind === "presence")!.body).toBe("initial recall");
});

test("recipient warning survives a snapshot import that omits resolution history", async () => {
  const f = rig(); f.bus.retryDelivery("codex", "held");
  const dir = mkdtempSync(join(tmpdir(), "ahub-retry-warning-import-"));
  const target = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: f.dir, projectId: "p", instanceId: "imported-warning", operationId: "op" });
  target.importSnapshot(f.journal.snapshot(), "op"); const bus = new Bus({ journal: target, batchMs: 0 });
  const peer = new Peer("codex"); bus.add(peer); await peer.start();
  try {
    expect(target.resolution("held")).toBeUndefined();
    expect(bus.pull("codex")![0]!.body).toStartWith("Hub redelivery warning:");
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

for (const pruneReopen of [false, true]) test(`coalesced retry evidence survives safe failure and original withdrawal${pruneReopen ? " with pruning and reopen" : ""} (#434)`, async () => {
  const f = rig(), b = newEnvelope("user", "coalesced B", { to: ["codex"] });
  class SafeThenUncertain extends Peer {
    async deliver(envs: Envelope[], id?: string) {
      this.got.push(envs); if (!id) return;
      this.ids.push(id);
      if (this.got.length === 1) { this.setBusy(); this.delivery({ id, state: "failed_safe" }); }
      else this.delivery({ id, state: "needs_review" });
    }
  }
  const peer = new SafeThenUncertain("codex"); f.bus.add(peer); await peer.start();
  f.bus.retryDelivery("codex", "held"); f.bus.publish(b);
  peer.setBusy(); peer.pullOnly = false; peer.idle(); await until(() => peer.got.length === 1);
  const coalescedId = peer.ids[0]!;
  expect(f.journal.get(coalescedId)?.originals.map(env => env.id)).toEqual([f.original.id, b.id]);
  expect(f.journal.get(coalescedId)?.attempt).toBe(1);
  expect(f.journal.get(coalescedId)?.state).toBe("failed");
  f.bus.withdraw(f.original.id);
  let bus = f.bus, journal = f.journal;
  if (pruneReopen) {
    const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
    db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2050) INSERT INTO deliveries (id,project_id,peer,state,revision,created_at,updated_at,originals,out_json) SELECT 'terminal-'||i,'p','codex','completed',1,1,?, '[]','[]' FROM n").run(Date.now() + 1000); db.close();
    journal.createDelivery({ id: "prune-trigger", peer: "codex", state: "completed", createdAt: Date.now(), originals: [], out: [] });
    expect(journal.get(coalescedId)).toBeUndefined();
    ({ bus, journal } = f.reopen());
    const next = new Peer("codex"); next.pullOnly = false; bus.add(next); await next.start();
    await until(() => next.got.length === 1);
    expect(next.got[0]![0]!.body).toStartWith("Hub redelivery warning:");
    expect(() => bus.retryDelivery("codex", next.ids[0]!)).toThrow("recipient retry unavailable");
  } else {
    peer.idle(); await until(() => peer.got.length === 2);
    expect(peer.got[1]![0]!.body).toStartWith("Hub redelivery warning:");
    expect(() => bus.retryDelivery("codex", peer.ids[1]!)).toThrow("recipient retry unavailable");
  }
  expect(journal.retryEvidence("codex", [b])).toBe("used");
  expect(journal.retryEvidence("pi", [b])).toBe("unused");
  expect(journal.retryEvidence("codex", [newEnvelope("user", "unrelated fresh")])).toBe("unused");
});

for (const mode of ["push", "pull", "steer"] as const) test(`maximum valid body recipient retry fits journal validation through actual ${mode} (#434)`, async () => {
  const f = rig(); f.journal.transition("held", "completed");
  const prefix = "Hub redelivery warning: An earlier attempt of this delivery is uncertain; check for its effects before acting.\n\n";
  const marker = "\n[cut: rendered body exceeds delivery limit]";
  const boundary = MAX_ENVELOPE_BODY - prefix.length - marker.length;
  const body = "x".repeat(boundary - 1) + "🙂" + "x".repeat(MAX_ENVELOPE_BODY - boundary - 1);
  const original = newEnvelope("user", body, { to: ["codex"], priority: mode === "steer" ? "important" : "status" });
  const held = f.journal.createDelivery({ id: "max-held", peer: "codex", state: "needs_review", createdAt: original.ts, originals: [original], out: [original] });
  class Steering extends Peer { async steer(envs: Envelope[], id?: string) { await this.deliver(envs, id); } }
  const peer = new Steering("codex"); f.bus.add(peer); await peer.start();
  let out: Envelope[];
  if (mode === "steer") {
    f.journal.resolve(held.id, held.revision, "retry", "recipient requested retry", held.revision, "peer:codex");
    peer.pullOnly = false; peer.setBusy(); f.bus.publish(original);
    await until(() => peer.got.length === 1 || !!f.bus.storageError); out = peer.got[0] ?? [];
  } else {
    f.bus.retryDelivery("codex", held.id);
    if (mode === "pull") out = f.bus.pull("codex")!;
    else { peer.setBusy(); peer.pullOnly = false; peer.idle(); await until(() => peer.got.length === 1 || !!f.bus.storageError); out = peer.got[0] ?? []; }
  }
  expect(f.bus.storageError).toBeUndefined(); expect(out).toHaveLength(1);
  expect(out[0]!.body).toStartWith(prefix);
  expect(out[0]!.body.length).toBeLessThanOrEqual(MAX_ENVELOPE_BODY);
  expect(out[0]!.body).toEndWith(marker);
  expect(out[0]!.body.slice(prefix.length, -marker.length)).toBe("x".repeat(boundary - 1));
  expect(original.body).toBe(body); expect(f.journal.get(held.id)!.originals[0]!.body).toBe(body);
  peer.idle();
});

test("a failed coalesced checkpoint cannot consume a fresh original's retry right (#434)", async () => {
  const f = rig(), b = newEnvelope("user", "fresh B", { to: ["codex"] }); f.bus.retryDelivery("codex", "held");
  const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
  db.run("CREATE TRIGGER reject_fixture_handoff BEFORE INSERT ON deliveries WHEN NEW.id = 'rejected-handoff' BEGIN SELECT RAISE(ABORT, 'fixture checkpoint rejected'); END"); db.close();
  expect(() => f.journal.checkpointDelivery(f.bus.snapshot(false), { id: "rejected-handoff", peer: "codex", state: "dispatching", createdAt: Date.now(), originals: [f.original, b], out: [f.original, b] })).toThrow("fixture checkpoint rejected");
  expect(f.journal.retryEvidence("codex", [b])).toBe("unused"); expect(f.journal.retryWarning("codex", [b])).toBe(false);
  expect(f.journal.retryEvidence("codex", [f.original])).toBe("used");
});

test("old-writer terminal coalescing backfills consumed proof on return without touching resolution audit (#434)", async () => {
  const f = rig(), b = newEnvelope("user", "legacy B", { to: ["codex"] }); f.bus.retryDelivery("codex", "held");
  f.bus.closeJournal();
  const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
  db.query("INSERT INTO deliveries (id,project_id,peer,state,revision,created_at,updated_at,originals,out_json,attempt) VALUES ('legacy-coalesced','p','codex','failed',1,1,1,?,?,1)").run(JSON.stringify([f.original, b]), JSON.stringify([f.original, b]));
  const audit = db.query("SELECT * FROM resolution_history ORDER BY id").all(); db.close();
  const reopened = f.reopen();
  expect(reopened.journal.retryEvidence("codex", [b])).toBe("used"); expect(reopened.journal.retryWarning("codex", [b])).toBe(true);
  const check = new Database(join(f.dir, "hub.db")); expect(check.query("SELECT * FROM resolution_history ORDER BY id").all()).toEqual(audit);
  check.run("DELETE FROM resolution_history"); check.run("DELETE FROM deliveries WHERE id = 'legacy-coalesced'"); check.close();
  expect(reopened.journal.retryEvidence("codex", [b])).toBe("used"); expect(reopened.journal.retryWarning("codex", [b])).toBe(true);
  expect(reopened.journal.retryEvidence("codex", [newEnvelope("user", "fresh unrelated")])).toBe("unused");
});

test("persisted consumed proof validates peer, original, proof id and warning before reuse (#434)", async () => {
  const { Database } = await import("bun:sqlite");
  for (const [field, value] of [["peer", ""], ["original_id", ""], ["proof_id", ""], ["warning", 2]] as const) {
    const f = rig(); f.bus.retryDelivery("codex", "held"); f.bus.closeJournal();
    const db = new Database(join(f.dir, "hub.db")); db.run("PRAGMA ignore_check_constraints = ON");
    db.query(`UPDATE delivery_retry_evidence SET ${field} = ? WHERE project_id = 'p'`).run(value); db.close();
    expect(() => f.reopen()).toThrow("invalid delivery journal: retry proof");
  }
});

test("an old-writer attempt with unknown provenance is never backfilled without a warning (#434)", async () => {
  const f = rig(), legacy = newEnvelope("user", "unknown old attempt"); f.bus.closeJournal();
  const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
  db.query("INSERT INTO deliveries (id,project_id,peer,state,revision,created_at,updated_at,originals,out_json,attempt) VALUES ('unknown-attempt','p','codex','failed',1,1,1,?,?,1)").run(JSON.stringify([legacy]), JSON.stringify([legacy])); db.close();
  const reopened = f.reopen();
  expect(reopened.journal.retryEvidence("codex", [legacy])).toBe("used"); expect(reopened.journal.retryWarning("codex", [legacy])).toBe(true);
  expect(reopened.journal.retryEvidence("codex", [newEnvelope("user", "unrelated")])).toBe("unused");
});

for (const legacyCarrier of [false, true]) test(`a restored presence carrier never consumes a fresh message retry${legacyCarrier ? " with old proof, history and queued attempt" : ""} (#434)`, async () => {
  const f = rig(); f.journal.transition("held", "completed");
  const peer = new Peer("codex"); peer.pullOnly = false; f.bus.add(peer); await peer.start();
  f.bus.preface("codex", "recall preserved");
  const x = newEnvelope("user", "uncertain X", { to: ["codex"] }); f.bus.publish(x); await until(() => peer.got.length === 1);
  const p = peer.got[0]![0]!; expect(p.from).toBe("hub"); expect(p.kind).toBe("presence");
  peer.setBusy(); f.bus.retryDelivery("codex", peer.ids[0]!); f.bus.withdraw(x.id); peer.idle();
  expect(peer.got).toHaveLength(1);
  if (legacyCarrier) {
    const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
    db.query("INSERT OR REPLACE INTO delivery_retry_evidence VALUES ('p','codex',?,'old-carrier',1)").run(p.id);
    db.query("INSERT INTO resolution_history (project_id,delivery_id,observed_revision,action,reason,result_revision,result_state,actor,peer,original_ids) VALUES ('p','old-carrier',1,'retry','old presence carrier',1,'failed','peer:codex','codex',?)").run(JSON.stringify([p.id]));
    db.query("UPDATE delivery_meta SET retry_unknown_ids = ? WHERE project_id = 'p'").run(JSON.stringify({ codex: [p.id] })); db.close();
    f.journal.createDelivery({ id: "old-carrier", peer: "codex", state: "queued", createdAt: p.ts, originals: [p], out: [p], attempt: 1 });
  }
  const b = newEnvelope("user", "fresh B", { to: ["codex"] }); f.bus.publish(b); await until(() => peer.got.length === 2);
  expect(peer.got[1]![0]!.id).toBe(p.id); expect(peer.got[1]![0]!.body).toContain("recall preserved");
  expect(peer.got[1]![0]!.body).not.toContain("Hub redelivery warning:");
  expect(f.journal.retryEvidence("codex", [b])).toBe("unused"); expect(f.journal.retryWarning("codex", [b])).toBe(false);
  expect(f.journal.retryEvidence("codex", [x])).toBe("used"); expect(f.journal.retryWarning("codex", [x])).toBe(true);
  expect(f.journal.get(peer.ids[1]!)?.attempt ?? 0).toBe(0);
  peer.setBusy(); expect(() => f.bus.retryDelivery("codex", peer.ids[1]!)).not.toThrow();
});

test("recovery imports a pending presence without fencing the first unrelated fresh message (#434)", async () => {
  const f = rig(); f.journal.transition("held", "completed"); f.bus.preface("codex", "imported recall");
  const snapshot = { ...f.bus.snapshot(false), journal: f.journal.snapshot() };
  const dir = mkdtempSync(join(tmpdir(), "ahub-presence-import-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: f.dir, projectId: "p", instanceId: "import", operationId: "op" });
  const bus = new Bus({ journal, batchMs: 0 }); cleanup.push(() => { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); });
  bus.restore(snapshot, "op"); const peer = new Peer("codex"); peer.pullOnly = false; bus.add(peer); await peer.start(); bus.setRecoveryHold(false);
  const b = newEnvelope("user", "fresh after import", { to: ["codex"] }); bus.publish(b); await until(() => peer.got.length === 1);
  expect(peer.got[0]![0]!.body).toContain("imported recall"); expect(peer.got[0]![0]!.body).not.toContain("Hub redelivery warning:");
  expect(journal.retryEvidence("codex", [b])).toBe("unused"); expect(journal.retryWarning("codex", [b])).toBe(false);
  peer.setBusy(); expect(() => bus.retryDelivery("codex", peer.ids[0]!)).not.toThrow();
});

test("legacy unmappable-history and presence-only attempt backfills cannot fence a later fresh message (#434)", async () => {
  const f = rig(); f.journal.transition("held", "completed"); f.bus.preface("codex", "legacy recall");
  const p = f.bus.snapshot(false).prefaces.codex!;
  f.journal.createDelivery({ id: "presence-attempt", peer: "codex", state: "failed", createdAt: p.ts, originals: [p], out: [p], attempt: 1 });
  const { Database } = await import("bun:sqlite"); const db = new Database(join(f.dir, "hub.db"));
  db.run("INSERT INTO resolution_history (project_id,delivery_id,observed_revision,action,reason,result_revision,result_state,peer,original_ids) VALUES ('p','pruned-legacy',1,'retry','legacy',1,'failed','','[]')"); db.close();
  const reopened = f.reopen(), peer = new Peer("codex"); peer.pullOnly = false; reopened.bus.add(peer); await peer.start();
  const b = newEnvelope("user", "fresh after legacy return", { to: ["codex"] }); reopened.bus.publish(b); await until(() => peer.got.length === 1);
  expect(peer.got[0]![0]!.id).toBe(p.id); expect(peer.got[0]![0]!.body).toContain("legacy recall");
  expect(reopened.journal.retryEvidence("codex", [p, b])).toBe("unused"); expect(reopened.journal.retryWarning("codex", [p, b])).toBe(false);
  const check = new Database(join(f.dir, "hub.db"));
  expect(check.query("SELECT 1 FROM delivery_retry_evidence WHERE original_id = ?").get(p.id)).toBeNull();
  const unknown = JSON.parse((check.query("SELECT retry_unknown_ids FROM delivery_meta WHERE project_id = 'p'").get() as any).retry_unknown_ids);
  expect(unknown.codex ?? []).not.toContain(p.id); check.close();
});

test("presence exclusion is limited to hub context and retains real hub tasks and peer presence retries (#434)", () => {
  const f = rig();
  for (const env of [newEnvelope("hub", "real hub task", { kind: "task" }), newEnvelope("codex", "peer-authored presence", { kind: "presence" })]) {
    const row = f.journal.createDelivery({ id: env.id, peer: "pi", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    f.bus.retryDelivery("pi", row.id);
    expect(f.journal.retryEvidence("pi", [env])).toBe("used"); expect(f.journal.retryWarning("pi", [env])).toBe(true);
  }
});
