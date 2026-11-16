import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore, memoryProjectKey, realPath } from "@staix/agent-mem";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { useEnvironmentScope } from "./helpers/env-scope.ts";

// hub task 976 (#1330) through a real daemon: the session preface orders its long-term section by the sidecar's counters.

useEnvironmentScope();
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (condition: () => boolean, label: string, attempts = 300) => { for (let i = 0; i < attempts && !condition(); i++) await Bun.sleep(20); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

/** Three long-term contracts written before the daemon starts; `counters` seeds the sidecar for them in the same order. */
async function world(counters: (id: (n: number) => string, record: (entryId: string, values: { rendered?: number; delivered?: number; cited?: number }, deliveryId: string) => void) => void, setting?: number) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-preface-order-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), stateDir = join(cwd, "state"), memoryDir = join(root, "memory"), hubHome = join(root, "hub-home");
  mkdirSync(stateDir, { recursive: true });
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.AMEM_HOME = memoryDir; process.env.AGENTHUB_HOME = hubHome;
  cleanup.push(() => { for (const key of ["AMEM_HOME", "AGENTHUB_HOME"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  const project = memoryProjectKey(cwd);
  // A strictly increasing clock: notes written in one millisecond would tie on time and fall back to the id hash for their order.
  let clock = Date.parse("2026-11-16T00:00:00Z");
  const store = new MemoryStore({ now: () => (clock += 1000) });
  const written = [1, 2, 3].map(n => store.note({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "claude", text: `contract number ${n} stays`, about: [], source: "hub" }));
  store.close();
  const sidecar = new CandidateStore();
  counters(n => written[n - 1]!, (entryId, values, deliveryId) => sidecar.recordCounter({ project, entryId, deliveryId, task: null, turn: null, session: null }, values, "public"));
  sidecar.close();
  const daemon = await startDaemon({ cwd, stateDir, projectId: "p-preface-order", instanceId: "i-preface-order", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true, sync_interval_min: 0, ...(setting === undefined ? {} : { preface_unused_after: setting }) } } });
  cleanup.push(() => daemon.stop());
  const worker = await ControlClient.connect(stateDir, { role: "peer", peer: "worker" }); cleanup.push(() => worker.close());
  await until(() => !!daemon.bus.snapshot().prefaces.worker, "the preface");
  const body = daemon.bus.snapshot().prefaces.worker!.body, order = [...body.matchAll(/mem:([0-9a-f]{8}) contract[^\n]*?contract number (\d)/g)].map(m => Number(m[2]));
  return { daemon, body, order, events: () => readEvents(join(stateDir, "events.jsonl")) };
}

test("AC1 through the daemon: a note delivered often and never cited moves to the end of the preface, a cited one leads, and the preface event counts bytes, lines and the reorder", async () => {
  const w = await world((id, record) => {
    // Entry 3 was newest first in store order; entry 1 is the oldest. Rows are per delivery, so entry 3 needs two of them to reach 20.
    record(id(3), { rendered: 1, delivered: 12 }, "a"); record(id(3), { rendered: 1, delivered: 12 }, "b");
    record(id(1), { rendered: 1, delivered: 4, cited: 4 }, "c");
  });
  // Notes 1, 2 and 3 were written in that order, so the store lists them newest first: 3, 2, 1. Entry 1 was cited, entry 3 was delivered 24 times and never cited, entry 2 has no observed row.
  const baseline = await world(() => {});
  expect(baseline.order).toEqual([3, 2, 1]);
  expect(w.order).toEqual([1, 2, 3]);
  const event = w.events().filter(e => e.type === "preface");
  expect(event).toHaveLength(1);
  expect(event[0]).toMatchObject({ type: "preface", peer: "worker", ordered: true, lines: 3 });
  expect((event[0] as { bytes: number }).bytes).toBe(Buffer.byteLength(w.body));
});

test("AC2 through the daemon: with no counter rows the preface keeps the store's order and says it was not reordered", async () => {
  const baseline = await world(() => {});
  expect(baseline.events().filter(e => e.type === "preface")).toMatchObject([{ ordered: false, lines: 3 }]);
  // The same notes with their counters recorded as unobserved (null delivered and cited) change nothing either.
  const nulls = await world((id, record) => { record(id(3), { rendered: 1 }, "a"); record(id(1), { rendered: 2 }, "b"); });
  expect(nulls.events().filter(e => e.type === "preface")).toMatchObject([{ ordered: false }]);
});

test("memory.preface_unused_after = 0 keeps the store order even when counters would move a line", async () => {
  const off = await world((id, record) => { record(id(3), { rendered: 1, delivered: 50 }, "a"); }, 0);
  expect(off.events().filter(e => e.type === "preface")).toMatchObject([{ ordered: false }]);
});
