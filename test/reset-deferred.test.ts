import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { RecoveryDeferredHubError } from "../src/hub/deferred-hub.ts";
import type { Project } from "../src/hub/registry.ts";
import { planReset, resetLines, resetRuntime } from "../src/cli/reset.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-reset-deferred-"));
  const stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "hub.db");
  const project: Project = { id: "reset-deferred", root, stateDir, basePort: 4600, instanceId: null, pid: null };
  const journal = new DeliveryJournal({ file, projectRoot: root, projectId: project.id, instanceId: "seed" });
  const notice = newEnvelope("hub", "private reset notice body", { to: ["codex", "claude"], kind: "task", private: true });
  journal.persistBus({ schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [], deferredHub: [notice] }, []);
  journal.close();
  return { root, stateDir, file, project, notice };
}

test("#478 reset previews and audits every deferred recipient, and restart cannot restore the notice", () => {
  const { root, stateDir, file, project, notice } = fixture();
  try {
    const expected = notice.to!.map(peer => `q:${peer}:${notice.id}`);
    const before = readFileSync(file);
    const plan = planReset(stateDir, project.id);
    expect(plan.queued).toEqual(expected);
    expect(resetLines(plan).join("\n")).toContain("queued 2");
    expect(resetLines(plan).join("\n")).not.toContain(notice.body);
    expect(readFileSync(file)).toEqual(before);

    const result = resetRuntime(stateDir, project);
    expect(result.settled).toEqual(expected);
    expect(result.plan.queued).toEqual(expected);
    const journal = new DeliveryJournal({ file, projectRoot: root, projectId: project.id, instanceId: "restart" });
    const bus = new Bus({ journal, batchMs: 0 });
    try {
      expect(bus.snapshot().deferredHub ?? []).toEqual([]);
      bus.setRecoveryHold(false);
      expect(bus.snapshot().queues).toEqual({});
      expect(bus.queueList().filter(row => row.state !== "discarded")).toEqual([]);
      expect(journal.list().map(row => ({ id: row.id, peer: row.peer, state: row.state })).sort((a, b) => a.id.localeCompare(b.id)))
        .toEqual(expected.map((id, i) => ({ id, peer: notice.to![i]!, state: "discarded" as const })).sort((a, b) => a.id.localeCompare(b.id)));
    } finally { bus.closeJournal(); }
    const db = new Database(file, { readonly: true });
    try {
      expect(db.query("SELECT delivery_id, action, reason FROM resolution_history ORDER BY delivery_id").all())
        .toEqual(expected.sort().map(delivery_id => ({ delivery_id, action: "discard", reason: "reset" })));
    } finally { db.close(); }
    expect(resetRuntime(stateDir, project).settled).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#478 reset refuses a corrupt deferred original without changing the journal", () => {
  const { root, stateDir, file, project } = fixture();
  try {
    const db = new Database(file);
    try {
      const row = db.query("SELECT bus_snapshot FROM delivery_meta WHERE project_id = ?").get(project.id) as { bus_snapshot: string };
      const snapshot = JSON.parse(row.bus_snapshot);
      snapshot.deferredHub[0].from = "codex";
      db.query("UPDATE delivery_meta SET bus_snapshot = ? WHERE project_id = ?").run(JSON.stringify(snapshot), project.id);
    } finally { db.close(); }
    const before = readFileSync(file);
    expect(() => planReset(stateDir, project.id)).toThrow(RecoveryDeferredHubError);
    expect(() => resetRuntime(stateDir, project)).toThrow(RecoveryDeferredHubError);
    expect(readFileSync(file)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
