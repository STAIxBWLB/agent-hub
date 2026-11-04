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
