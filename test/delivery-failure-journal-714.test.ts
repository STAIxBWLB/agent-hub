import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryJournal, validateJournalSnapshot } from "../src/hub/delivery-journal.ts";
import { DELIVERY_FAILURE_CAUSES, isDeliveryFailureCause, type DeliveryFailureCause } from "../src/hub/delivery-failure.ts";
import type { Database } from "../src/hub/db-schema.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-failure-cause-714-"));
  const options = { file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "first" };
  const journal = new DeliveryJournal(options);
  return { dir, options, journal, db: (journal as unknown as { db: Database }).db };
}

function delivery(id: string, peer = "codex") {
  const env = newEnvelope("user", "private body canary 714", { to: [peer], private: true });
  return { id, peer, state: "dispatching" as const, createdAt: env.ts, originals: [env], out: [env] };
}

const emptyBus = { schemaVersion: 1 as const, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };

test("all five delivery causes are closed public metadata, persisted on failed transitions", () => {
  const f = fixture();
  try {
    expect(DELIVERY_FAILURE_CAUSES).toEqual(["peer offline", "adapter refused", "push error", "turn aborted", "timeout"]);
    for (const cause of DELIVERY_FAILURE_CAUSES) {
      expect(isDeliveryFailureCause(cause)).toBe(true);
      const row = f.journal.createDelivery(delivery(cause));
      const failed = f.journal.transition(row.id, "failed", undefined, row.revision, cause);
      expect(failed.failureCause).toBe(cause);
      expect(f.journal.get(row.id)?.failureCause).toBe(cause);
      expect(f.journal.list().find(item => item.id === row.id)?.failureCause).toBe(cause);
      expect(f.db.query("SELECT failure_cause FROM deliveries WHERE id=?").get(row.id)).toEqual({ failure_cause: cause });
    }
    expect(JSON.stringify(f.journal.list().map(row => row.failureCause))).not.toContain("private body canary 714");
    expect(isDeliveryFailureCause("private body canary 714")).toBe(false);
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("cause survives each journal insertion route, reopen and snapshot import without a schema bump", () => {
  const source = fixture(), target = fixture();
  let reopened: DeliveryJournal | undefined;
  try {
    source.journal.createDelivery({ ...delivery("created"), state: "failed", failureCause: "peer offline" });
    source.journal.persistBusAndDeliveries(emptyBus, [], [{ ...delivery("persisted"), state: "failed", failureCause: "push error" }]);
    source.journal.checkpointDelivery(emptyBus, { ...delivery("checkpoint"), failureCause: "timeout" });
    source.journal.transition("checkpoint", "needs_review", "unknown effect");
    const before = source.journal.snapshot();
    expect(before.schemaVersion).toBe(1);
    expect(validateJournalSnapshot(before)).toBe(true);
    source.journal.close();
    reopened = new DeliveryJournal({ ...source.options, instanceId: "second" });
    expect(reopened.get("created")?.failureCause).toBe("peer offline");
    expect(reopened.get("persisted")?.failureCause).toBe("push error");
    expect(reopened.get("checkpoint")?.failureCause).toBe("timeout");
    expect(target.journal.importSnapshot(reopened.snapshot(), "restore-714")).toBe(true);
    expect(target.journal.get("created")?.failureCause).toBe("peer offline");
    expect(target.journal.get("persisted")?.failureCause).toBe("push error");
    expect(target.journal.get("checkpoint")?.failureCause).toBe("timeout");
  } finally {
    source.journal.close(); reopened?.close(); target.journal.close();
    rmSync(source.dir, { recursive: true, force: true }); rmSync(target.dir, { recursive: true, force: true });
  }
});

test("an older journal adds the nullable cause column and retains unknown legacy cause honestly", () => {
  const f = fixture();
  let reopened: DeliveryJournal | undefined;
  try {
    f.journal.createDelivery({ ...delivery("legacy"), state: "failed", reason: "timeout text is not typed evidence" });
    f.db.run("ALTER TABLE deliveries DROP COLUMN failure_cause");
    f.journal.close();
    reopened = new DeliveryJournal({ ...f.options, instanceId: "after-upgrade" });
    expect(reopened.get("legacy")).not.toHaveProperty("failureCause");
    expect(reopened.unresolvedFailedCounts()).toEqual({ codex: 1 });
    expect(reopened.snapshot().deliveries[0]).not.toHaveProperty("failureCause");
    expect((reopened as unknown as { db: Database }).db.query("SELECT failure_cause FROM deliveries WHERE id='legacy'").get()).toEqual({ failure_cause: null });
  } finally { f.journal.close(); reopened?.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("untrusted cause text refuses before journal writes, import, or readback and is never echoed", () => {
  const f = fixture(), target = fixture();
  const invalid = "secret-canary-714" as DeliveryFailureCause;
  try {
    const row = f.journal.createDelivery(delivery("valid"));
    const revision = f.journal.revision();
    expect(() => f.journal.createDelivery({ ...delivery("invalid-create"), state: "failed", failureCause: invalid })).toThrow("failureCause is invalid");
    expect(() => f.journal.transition(row.id, "failed", undefined, row.revision, invalid)).toThrow("failureCause is invalid");
    expect(() => f.journal.persistBusAndDeliveries(emptyBus, [], [{ ...delivery("invalid-persist"), state: "failed", failureCause: invalid }])).toThrow("failureCause is invalid");
    expect(() => f.journal.checkpointDelivery(emptyBus, { ...delivery("invalid-checkpoint"), failureCause: invalid })).toThrow("failureCause is invalid");
    let causeReads = 0;
    const changingCause = { ...delivery("changing-cause"), state: "failed" as const, get failureCause() { return causeReads++ === 0 ? "timeout" as const : invalid; } };
    expect(() => f.journal.createDelivery(changingCause)).toThrow("failureCause is invalid");
    expect(f.journal.revision()).toBe(revision);
    expect(f.journal.get(row.id)?.state).toBe("dispatching");
    const badSnapshot = f.journal.snapshot();
    badSnapshot.deliveries[0]!.failureCause = invalid;
    expect(() => validateJournalSnapshot(badSnapshot)).toThrow("failureCause is invalid");
    expect(() => target.journal.importSnapshot(badSnapshot, "invalid-restore")).toThrow("failureCause is invalid");
    expect(target.journal.list()).toEqual([]);
    f.db.query("UPDATE deliveries SET failure_cause=? WHERE id=?").run(invalid, row.id);
    let refused: unknown;
    try { f.journal.get(row.id); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain("failureCause is invalid");
    expect(String(refused)).not.toContain("secret-canary-714");
  } finally { f.journal.close(); target.journal.close(); rmSync(f.dir, { recursive: true, force: true }); rmSync(target.dir, { recursive: true, force: true }); }
});

test("unresolved failed counts are metadata-only, exclude settled retry parents and retain detached peers", () => {
  const f = fixture();
  try {
    const open = f.journal.createDelivery({ ...delivery("unresolved", "retired"), state: "failed", failureCause: "peer offline" });
    const retry = f.journal.createDelivery({ ...delivery("retry-parent"), state: "needs_review", failureCause: "timeout" });
    const acknowledged = f.journal.createDelivery({ ...delivery("acknowledged"), state: "failed", failureCause: "adapter refused" });
    f.journal.createDelivery({ ...delivery("other-failure"), state: "failed", failureCause: "turn aborted" });
    f.journal.createDelivery({ ...delivery("not-failed"), state: "completed" });
    const retried = f.journal.resolve(retry.id, retry.revision, "retry", "person retry");
    expect(retried.state).toBe("failed");
    expect(retried.failureCause).toBe("timeout");
    const resolved = f.journal.resolve(acknowledged.id, acknowledged.revision, "completed", "handled");
    expect(resolved.failureCause).toBe("adapter refused");
    f.journal.list = () => { throw new Error("status read full delivery history"); };
    f.journal.snapshot = () => { throw new Error("status read recovery payloads"); };
    f.db.query("UPDATE deliveries SET originals='unreadable-json',out_json='unreadable-json' WHERE id=?").run(open.id);
    expect(f.journal.unresolvedFailedCounts()).toEqual({ codex: 1, retired: 1 });
    expect(f.journal.revision()).toBeGreaterThan(open.revision);
  } finally { f.journal.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("known signed refusal and interrupted handoff record their cause without guessing adapter text", () => {
  const f = fixture();
  let reopened: DeliveryJournal | undefined;
  try {
    const remote = f.journal.createDelivery(delivery("remote", "codex@remote-hub"));
    expect(f.journal.failRemoteReceipt(remote.id, remote.peer, remote.revision, "recipient safe refusal").failureCause).toBe("adapter refused");
    f.journal.createDelivery(delivery("interrupted"));
    f.journal.close();
    reopened = new DeliveryJournal({ ...f.options, instanceId: "after-interruption" });
    expect(reopened.get("interrupted")).toMatchObject({ state: "needs_review", failureCause: "turn aborted" });
    expect(reopened.get("remote")?.failureCause).toBe("adapter refused");
  } finally { f.journal.close(); reopened?.close(); rmSync(f.dir, { recursive: true, force: true }); }
});
