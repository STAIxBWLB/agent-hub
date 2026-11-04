import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

test("#1056 package publication evidence survives terminal pruning and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-publication-")), file = join(dir, "hub.db");
  let journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "one", terminalHistoryLimit: () => 1 });
  try {
    const env = newEnvelope("hub", "immutable person comment", { to: ["codex"], kind: "review", refs: { task: "1", taskRecipient: "owner", reviewPackage: "review-person-package" } });
    journal.createDelivery({ id: "package-delivery", peer: "codex", state: "completed", createdAt: env.ts, originals: [env], out: [env] });
    for (let n = 0; n < 3; n++) {
      const ordinary = newEnvelope("user", "ordinary history");
      journal.createDelivery({ id: `ordinary-${n}`, peer: "codex", state: "completed", createdAt: env.ts + n + 1, originals: [ordinary], out: [ordinary] });
    }
    expect(journal.get("ordinary-0")).toBeUndefined();
    expect(journal.reviewEnvelopePublished(env.id)).toBe(true);
    journal.close();
    journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "two", terminalHistoryLimit: () => 1 });
    const bus = new Bus({ journal, batchMs: 0 });
    expect(bus.get(env.id)).toBeUndefined(); // No reply-cache evidence survives this fixture.
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("published");
    expect(bus.publishReviewEnvelope(env)).toEqual(["codex"]);
    expect(() => bus.publishReviewEnvelope({ ...env, body: "changed package body" })).toThrow("differs from its publication evidence");
    expect(bus.queued("codex")).toBe(0);
    expect(bus.reviewEnvelopeStatus(crypto.randomUUID())).toBe("absent");
    bus.closeJournal();
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("unknown");
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 package publication proof includes saved queues and refuses an unavailable journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-publication-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "one" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    const env = newEnvelope("hub", "saved package", { to: ["codex"], kind: "review", refs: { reviewPackage: "review-saved-package" } });
    journal.persistBus({ schemaVersion: 1, queues: { codex: [env] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, []);
    expect(bus.reviewEnvelopeStatus(env.id)).toBe("published");
    const ephemeral = new Bus();
    expect(ephemeral.reviewEnvelopeStatus(env.id)).toBe("unknown");
    expect(() => ephemeral.publishReviewEnvelope(env)).toThrow("publication evidence is unavailable");
    ephemeral.closeJournal();
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 unsettled review scope follows the original recipient until explicit disposition across restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-former-recipient-")), file = join(dir, "hub.db");
  let journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "one" });
  try {
    const env = newEnvelope("hub", "former reviewer source quote", { to: ["former-reviewer"], kind: "review", refs: { task: "7", reviewPackage: "finding-original-recipient" } });
    journal.createDelivery({ id: "uncertain-review", peer: "former-reviewer", state: "needs_review", createdAt: env.ts, originals: [env], out: [env] });
    journal.close();
    journal = new DeliveryJournal({ file, projectRoot: dir, projectId: "p", instanceId: "two" });
    const bus = new Bus({ journal, batchMs: 0 });
    expect(bus.hasUnsettledReviewScope("former-reviewer", 7)).toBe(true);
    expect(bus.hasUnsettledReviewScope("former-reviewer", 8)).toBe(false);
    expect(bus.hasUnsettledReviewScope("replacement-reviewer", 7)).toBe(false);
    const held = journal.get("uncertain-review")!;
    journal.resolve(held.id, held.revision, "completed", "person confirmed handling");
    expect(bus.hasUnsettledReviewScope("former-reviewer", 7)).toBe(false);
    bus.closeJournal();
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("#1056 queued and recovery-deferred review scope retains its actual recipient", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-pending-recipient-"));
  const journal = new DeliveryJournal({ file: join(dir, "hub.db"), projectRoot: dir, projectId: "p", instanceId: "one" });
  const bus = new Bus({ journal, batchMs: 0 });
  try {
    const env = newEnvelope("hub", "pending source quote", { to: ["old-owner"], kind: "review", priority: "important", refs: { task: "9", reviewPackage: "finding-pending-recipient" } });
    const snapshot = { schemaVersion: 1 as const, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] };
    journal.persistBus({ ...snapshot, queues: { "old-owner": [env] } }, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(true);
    expect(bus.hasUnsettledReviewScope("new-owner", 9)).toBe(false);
    journal.persistBus({ ...snapshot, deferredHub: [env] }, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(true);
    journal.persistBus(snapshot, []);
    expect(bus.hasUnsettledReviewScope("old-owner", 9)).toBe(false);
  } finally { bus.closeJournal(); rmSync(dir, { recursive: true, force: true }); }
});
