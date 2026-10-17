import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
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
