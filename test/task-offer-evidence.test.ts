import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
class Peer extends BasePeer {
  got: { envs: Envelope[]; id: string }[] = [];
  pullOnly = false;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], id?: string) { this.got.push({ envs, id: id! }); }
  receipt(id: string, state: "accepted" | "completed") { this.delivery({ id, state }); }
}
function offer(revision = 1, peer = "kimi") {
  return newEnvelope(HUB, "PRIVATE OFFER BODY", { to: [peer], kind: "task", refs: { task: "7", taskOffer: revision } });
}
function rig(condense?: (envs: Envelope[]) => Promise<Envelope[]>) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-offer-evidence-")), file = join(dir, "hub.db");
  let journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "offer", instanceId: "first" });
  let bus = new Bus({ journal, batchMs: 0, condense });
  cleanup.push(() => { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); });
  return { file, bus, journal, reopen() { bus.closeJournal(); journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "offer", instanceId: "next" }); bus = new Bus({ journal, batchMs: 0 }); return { bus, journal }; } };
}
async function until(condition: () => boolean) { for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(1); expect(condition()).toBe(true); }

test("adapter completion records only the addressed original task offer, never accepted or another assignment (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); f.bus.add(peer); await peer.start();
  const first = offer(); f.bus.publish(first); await until(() => peer.got.length === 1);
  const id = peer.got[0]!.id;
  expect(f.journal.offerRead("kimi", first.id)).toBe(false);
  peer.receipt(id, "accepted"); expect(f.journal.offerRead("kimi", first.id)).toBe(false);
  f.bus.deliveryReceipt("codex", { id, state: "completed" }); expect(f.journal.offerRead("kimi", first.id)).toBe(false);
  peer.receipt(id, "completed"); expect(f.journal.offerRead("kimi", first.id)).toBe(true);
  expect(f.journal.offerRead("codex", first.id)).toBe(false);
  expect(f.journal.offerRead("kimi", offer(2).id)).toBe(false);
});

test("correlated reply completion records original offers behind a condensed digest, not unrelated replies or digest ids (#438)", async () => {
  const digest = newEnvelope("digest", "condensed");
  const f = rig(async () => [digest]), peer = new Peer("kimi"); f.bus.add(peer); await peer.start();
  const original = offer(); f.bus.publish(original); await until(() => peer.got.length === 1);
  f.bus.completeReply("codex", digest.id); f.bus.completeReply("kimi", "unrelated");
  expect(f.journal.offerRead("kimi", original.id)).toBe(false);
  f.bus.completeReply("kimi", digest.id);
  expect(f.journal.offerRead("kimi", original.id)).toBe(true);
  expect(f.journal.offerRead("kimi", digest.id)).toBe(false);
});

test("actual pull completes exact offers atomically while an unrelated inbox read cannot read a future offer (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); peer.pullOnly = true; f.bus.add(peer); await peer.start();
  f.bus.publish(newEnvelope("user", "ordinary", { to: ["kimi"] })); f.bus.pull("kimi");
  const original = offer(); f.bus.publish(original);
  expect(f.journal.offerRead("kimi", original.id)).toBe(false);
  expect(f.bus.pull("kimi")!.map(env => env.id)).toContain(original.id);
  expect(f.journal.offerRead("kimi", original.id)).toBe(true);
});

test("operator and hub completion, generic transitions and already-completed acknowledgements never create offer reads (#438)", async () => {
  const f = rig();
  for (const actor of ["user", "hub"] as const) {
    const env = offer(), row = f.journal.createDelivery({ id: actor, peer: "kimi", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    f.bus.resolveDelivery(row.id, row.revision, "completed", "manual disposition", actor);
    expect(f.journal.offerRead("kimi", env.id)).toBe(false);
    expect(f.bus.completeDelivery("kimi", row.id)).toBe(true);
    expect(f.journal.offerRead("kimi", env.id)).toBe(false);
    expect(() => f.journal.completeDelivered(row.id, "kimi", "adapter")).toThrow("not active");
  }
  const env = offer(); f.journal.createDelivery({ id: "generic", peer: "kimi", state: "dispatching", createdAt: env.ts, originals: [env], out: [env] });
  f.journal.transition("generic", "accepted"); expect(f.journal.offerRead("kimi", env.id)).toBe(false);
  f.journal.transition("generic", "completed"); expect(f.journal.offerRead("kimi", env.id)).toBe(false);
});

test("completion ignores forged sender/kind/invalid offer revisions and refuses wrong peer or provenance (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); peer.pullOnly = true; f.bus.add(peer); await peer.start();
  const invalid = [newEnvelope("codex", "forged", { kind: "task", refs: { taskOffer: 1 }, to: ["kimi"] }), newEnvelope(HUB, "ordinary", { refs: { taskOffer: 1 }, to: ["kimi"] }), newEnvelope(HUB, "untagged", { kind: "task", to: ["kimi"] }), offer(0)];
  for (const env of invalid) f.bus.publish(env);
  f.bus.pull("kimi"); for (const env of invalid) expect(f.journal.offerRead("kimi", env.id)).toBe(false);
  const env = offer(), row = f.journal.createDelivery({ id: "guarded", peer: "kimi", state: "accepted", createdAt: env.ts, originals: [env], out: [env] });
  expect(() => f.journal.completeDelivered(row.id, "codex", "adapter")).toThrow("not active");
  expect(() => f.journal.completeDelivered(row.id, HUB, "adapter")).toThrow("source");
  expect(() => f.journal.completeDelivered(row.id, "kimi", "operator" as "adapter")).toThrow("source");
  expect(f.journal.get(row.id)?.state).toBe("accepted"); expect(f.journal.offerRead("kimi", env.id)).toBe(false);
});

test("restored handoffs and generic completed rows do not count as positive delivered offers (#438)", async () => {
  const f = rig(), old = offer(), generic = offer(2);
  f.journal.createDelivery({ id: "old", peer: "kimi", state: "dispatching", createdAt: old.ts, originals: [old], out: [old] });
  f.journal.createDelivery({ id: "generic", peer: "kimi", state: "completed", createdAt: generic.ts, originals: [generic], out: [generic] });
  const next = f.reopen(), peer = new Peer("kimi"); next.bus.add(peer); await peer.start();
  next.bus.deliveryReceipt("kimi", { id: "old", state: "completed" }); next.bus.completeReply("kimi", old.id);
  expect(next.bus.completeDelivery("kimi", "old")).toBe(false);
  expect(next.journal.offerRead("kimi", old.id)).toBe(false); expect(next.journal.offerRead("kimi", generic.id)).toBe(false);
  expect(() => next.journal.completeDelivered("old", "kimi", "reply")).toThrow("not active");
});

test("failed actual pull rolls back completion and exact offer evidence with its queue and preface (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); peer.pullOnly = true; f.bus.add(peer); await peer.start();
  const env = offer(); f.bus.preface("kimi", "recall"); f.bus.publish(env);
  const db = new Database(f.file); db.run("CREATE TRIGGER reject_offer_read BEFORE INSERT ON task_offer_reads BEGIN SELECT RAISE(ABORT, 'offer proof write rejected'); END"); db.close();
  const revision = f.journal.snapshot().revision;
  expect(() => f.bus.pull("kimi")).toThrow("offer proof write rejected");
  expect(f.journal.offerRead("kimi", env.id)).toBe(false); expect(f.journal.list("kimi")).toEqual([]);
  expect(f.journal.snapshot().revision).toBe(revision);
  expect(f.bus.queueIds("kimi")).toEqual([env.id]); expect(f.bus.snapshot(false).prefaces.kimi).toBeDefined();
});

test("positive offer evidence is ids-only and survives completion-time prune and reopen without query writes (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); f.bus.add(peer); await peer.start();
  const env = offer(); f.bus.publish(env); await until(() => peer.got.length === 1);
  const id = peer.got[0]!.id, db = new Database(f.file);
  db.query("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2050) INSERT INTO deliveries (id,project_id,peer,state,revision,created_at,updated_at,originals,out_json) SELECT 'prune-'||i,'offer','kimi','completed',1,1,?, '[]','[]' FROM n").run(Date.now() + 1000); db.close();
  peer.receipt(id, "completed"); expect(f.journal.get(id)).toBeUndefined(); expect(f.journal.offerRead("kimi", env.id)).toBe(true);
  const reopened = f.reopen(), before = reopened.journal.snapshot().revision;
  expect(reopened.journal.offerRead("kimi", env.id)).toBe(true); expect(reopened.journal.snapshot().revision).toBe(before);
  const check = new Database(f.file), rows = check.query("SELECT * FROM task_offer_reads").all(); check.close();
  expect(rows).toEqual([{ project_id: "offer", peer: "kimi", envelope_id: env.id, delivery_id: id, source: "adapter", offer_revision: 1 }]);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE OFFER BODY");
});

test("persisted offer proof refuses malformed provenance on query and reopen (#438)", async () => {
  const f = rig(), peer = new Peer("kimi"); peer.pullOnly = true; f.bus.add(peer); await peer.start();
  const env = offer(); f.bus.publish(env); f.bus.pull("kimi");
  const db = new Database(f.file); db.run("PRAGMA ignore_check_constraints = ON");
  db.run("UPDATE task_offer_reads SET source = 'operator'"); db.close();
  expect(() => f.journal.offerRead("kimi", env.id)).toThrow("offer read source");
  expect(() => f.reopen()).toThrow("offer read source");
});
