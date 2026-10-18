import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { MAX_DEFERRED_HUB, RecoveryDeferredHubError, validateDeferredHub } from "../src/hub/deferred-hub.ts";
import { validateJournalSnapshot, type JournalSnapshot } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { readRestartSnapshot, restartPath, type RestartSnapshot } from "../src/hub/restart.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function journal(deferredHub?: unknown): JournalSnapshot {
  return {
    schemaVersion: 1, revision: 1, instanceId: "source", deliveries: [], manualPaused: [],
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [],
      ...(deferredHub === undefined ? {} : { deferredHub: deferredHub as Envelope[] }) },
  };
}
function restart(bus: JournalSnapshot["bus"]): RestartSnapshot | undefined {
  const dir = mkdtempSync(join(tmpdir(), "ahub-deferred-validation-"));
  dirs.push(dir);
  const snapshot: RestartSnapshot = {
    schemaVersion: 1, projectRoot: dir, projectId: "project", sourceInstanceId: "source", operationId: "operation",
    committedAt: 1, bus, manualPaused: [], peers: [],
  };
  writeFileSync(restartPath(dir), JSON.stringify(snapshot), { mode: 0o600 });
  return readRestartSnapshot(dir, { projectRoot: dir, projectId: "project", operationId: "operation" });
}

test("#478: deferred hub support is advertised without changing the control protocol", () => {
  expect(DAEMON_FEATURES).toContain("task_cancel");
  expect(DAEMON_FEATURES).toContain("recovery_deferred_hub");
});

test("#478: older snapshots without deferred notices remain readable", () => {
  const snapshot = journal();
  expect(validateJournalSnapshot(snapshot)).toBe(true);
  expect(restart(snapshot.bus)?.bus).toEqual(snapshot.bus);
});

test("#478: bounded deferred hub originals preserve exact order and private metadata", () => {
  const originals = [newEnvelope("hub", "first", { to: ["codex"], kind: "task", private: true, refs: { task: "1" } }),
    newEnvelope("hub", "second", { to: ["pi"], kind: "budget" })];
  const snapshot = journal(originals);
  expect(validateJournalSnapshot(snapshot)).toBe(true);
  expect(restart(snapshot.bus)?.bus.deferredHub).toEqual(originals);
  expect(validateDeferredHub(originals)).toEqual(originals);
  const atCap = Array.from({ length: MAX_DEFERRED_HUB }, (_, n) => ({ ...originals[0]!, id: `deferred-${n}` }));
  expect(validateJournalSnapshot(journal(atCap))).toBe(true);
  expect(restart(journal(atCap).bus)?.bus.deferredHub).toEqual(atCap);
});

const original = newEnvelope("hub", "notice", { to: ["codex"], kind: "task" });
const malformed: [string, unknown][] = [
  ["not an array", {}],
  ["null", null],
  ["non-envelope", [null]],
  ["foreign sender", [{ ...original, from: "user" }]],
  ["duplicate original", [original, { ...original }]],
  ["oversized list", Array.from({ length: MAX_DEFERRED_HUB + 1 }, (_, n) => ({ ...original, id: `deferred-${n}` }))],
  ["bad body", [{ ...original, body: 1 }]],
  ["bad private marker", [{ ...original, private: "yes" }]],
  ["bad refs", [{ ...original, refs: [] }]],
  ["bad recipient", [{ ...original, to: [1] }]],
  ["bad hop", [{ ...original, hop: -1 }]],
];
for (const [name, value] of malformed) test(`#478: journal and restart both refuse deferred ${name}`, () => {
  const snapshot = journal(value);
  expect(() => validateJournalSnapshot(snapshot)).toThrow();
  expect(() => restart(snapshot.bus)).toThrow(RecoveryDeferredHubError);
  expect(() => validateDeferredHub(value)).toThrow(RecoveryDeferredHubError);
});

for (const place of ["seen", "queue"] as const) test(`#478: deferred ids cannot also be accepted in ${place}`, () => {
  const snapshot = journal([original]);
  if (place === "seen") snapshot.bus.seen.push(original);
  else snapshot.bus.queues.codex = [original];
  expect(() => validateJournalSnapshot(snapshot)).toThrow("repeats an accepted envelope id");
  expect(() => restart(snapshot.bus)).toThrow(RecoveryDeferredHubError);
});
