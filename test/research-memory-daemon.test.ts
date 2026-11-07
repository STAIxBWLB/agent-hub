import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore, memoryProjectKey, realPath } from "@staix/agent-mem";
import { ControlClient } from "../src/hub/control-client.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { researchFile, readStore, type TaskRecord } from "../src/hub/research.ts";
import { useEnvironmentScope } from "./helpers/env-scope.ts";

// #1279 through a real daemon: the live record's memory block comes from agent-mem's own sidecar counters, and a done summary or a hub_remember text that names a rendered entry is a citation.

useEnvironmentScope();
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const until = async (condition: () => boolean, label: string, attempts = 300) => { for (let i = 0; i < attempts && !condition(); i++) await Bun.sleep(20); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

async function world() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-research-memory-daemon-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), stateDir = join(cwd, "state"), memoryDir = join(root, "memory"), hubHome = join(root, "hub-home");
  mkdirSync(stateDir, { recursive: true });
  const prior = { AMEM_HOME: process.env.AMEM_HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME };
  process.env.AMEM_HOME = memoryDir; process.env.AGENTHUB_HOME = hubHome;
  cleanup.push(() => { for (const key of ["AMEM_HOME", "AGENTHUB_HOME"] as const) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } });
  const daemon = await startDaemon({ cwd, stateDir, projectId: "p-research-memory", instanceId: "i-research-memory", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, researchGraceMs: 20,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { enabled: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: true, sync_interval_min: 0 } } });
  cleanup.push(() => daemon.stop());
  const worker = await ControlClient.connect(stateDir, { role: "peer", peer: "worker" }); cleanup.push(() => worker.close());
  await until(() => daemon.bus.peers.get("worker")?.state === "idle", "worker attached");
  const tools = await ControlClient.connect(stateDir, { role: "tools", peer: "worker" }); cleanup.push(() => tools.close());
  const op = async (name: string, args: Record<string, unknown>) => { const r = await tools.request({ t: "task", op: name, args }); if (!r.ok) throw new Error(String(r.error)); return String(r.text); };
  return { daemon, op, cwd, stateDir, project: memoryProjectKey(cwd), file: researchFile("p-research-memory", hubHome) };
}

test("a done summary that names a rendered fail note is a citation, and the live record carries the counter figures", async () => {
  const w = await world();
  await w.op("hub_remember", { text: "never retry the WAL approach", kind: "fail", horizon: "long" });
  const reader = new MemoryStore(); cleanup.push(() => reader.close());
  const fail = reader.list({ project: w.project }).find(n => n.kind === "fail")!;
  const sidecar = new CandidateStore(); cleanup.push(() => sidecar.close());
  await w.op("hub_task_propose", { title: "outline the work", class: "plan", owner: "worker", plan: { paths: ["src/hub/research.ts"] } });
  // The brief reaches the worker the way a real one does: a hub-authored envelope that names the task, delivered through the journal.
  w.daemon.bus.publish(newEnvelope(HUB, `Memory brief (hub memory first, fails first):\nmem:${fail.id.slice(0, 8)} fail long: never retry the WAL approach`, { to: ["worker"], refs: { task: "1" } }));
  await until(() => sidecar.counters(w.project).some(c => c.rendered !== null && c.key.task !== null), "the brief rendered for the task");
  // A raw control peer has no journal acknowledgement, so the delivery is not known to have completed: delivered stays null (docs/memory.md). The acknowledged path is test/daemon.test.ts's native memory test.
  const cited = await w.op("hub_task_done", { id: 1, summary: `done, and I read mem:${fail.id.slice(0, 8)} before starting` });
  expect(cited).toContain("approved");
  await until(() => { try { return readStore(w.file).length > 0; } catch { return false; } }, "the live record");
  const record = readStore(w.file).find((r): r is TaskRecord => r.kind === "task")!;
  expect(record.memory).toMatchObject({ rendered: 1, delivered: null, cited: 1, failsExposed: 1, failsCited: 1, failRetrySignal: 0 });
  // Every figure is a count or null, whatever the sidecar holds.
  for (const value of Object.values(record.memory!)) expect(value === null || typeof value === "number").toBe(true);
  expect(JSON.stringify(record)).not.toContain(fail.id.slice(0, 8));
  expect(JSON.stringify(record)).not.toContain("WAL approach");
});

test("a hub_remember text that names a rendered entry cites it for its task, and a note about no task cites nothing for any task", async () => {
  const w = await world();
  await w.op("hub_remember", { text: "the first fail note", kind: "fail", horizon: "long" });
  const reader = new MemoryStore(); cleanup.push(() => reader.close());
  const fail = reader.list({ project: w.project }).find(n => n.kind === "fail")!;
  const sidecar = new CandidateStore(); cleanup.push(() => sidecar.close());
  await w.op("hub_task_propose", { title: "outline the work", class: "plan", owner: "worker" });
  w.daemon.bus.publish(newEnvelope(HUB, `Memory brief (hub memory first, fails first):\nmem:${fail.id.slice(0, 8)} fail long: the first fail note`, { to: ["worker"], refs: { task: "1" } }));
  await until(() => sidecar.counters(w.project).some(c => c.rendered !== null && c.key.task !== null), "the brief rendered for the task");
  const before = sidecar.counters(w.project).filter(c => c.cited !== null).length;
  await w.op("hub_remember", { text: `follow-up: mem:${fail.id.slice(0, 8)} was confirmed again`, kind: "finding", horizon: "long", task: 1 });
  await until(() => sidecar.counters(w.project).filter(c => c.cited !== null).length > before, "the remember citation");
  const cited = sidecar.counters(w.project).filter(c => c.cited !== null);
  expect(cited.every(c => c.key.task !== null)).toBe(true);
  expect(cited.some(c => c.key.deliveryId.startsWith("remember:1:"))).toBe(true);
  // Saying it again is idempotent: one observation key per task and text.
  await w.op("hub_remember", { text: `follow-up: mem:${fail.id.slice(0, 8)} was confirmed again`, kind: "finding", horizon: "long", task: 1 });
  await Bun.sleep(50);
  expect(sidecar.counters(w.project).filter(c => c.key.deliveryId.startsWith("remember:1:"))).toHaveLength(1);
});

test("a review verdict note that names a rendered entry is a citation keyed to that verdict", async () => {
  const w = await world();
  const claude = await ControlClient.connect(w.stateDir, { role: "peer", peer: "claude" }); cleanup.push(() => claude.close());
  await until(() => w.daemon.bus.peers.get("claude")?.state === "idle", "reviewer attached");
  await w.op("hub_remember", { text: "a fail note the reviewer knows", kind: "fail", horizon: "long" });
  const reader = new MemoryStore(); cleanup.push(() => reader.close());
  const fail = reader.list({ project: w.project }).find(n => n.kind === "fail")!;
  const sidecar = new CandidateStore(); cleanup.push(() => sidecar.close());
  await w.op("hub_task_propose", { title: "implement it", class: "implement", owner: "worker" });
  const person = await ControlClient.connect(w.stateDir, { role: "console" }); cleanup.push(() => person.close());
  const ok = await person.request({ t: "task", op: "task_assign", args: { id: 1, peer: "claude", role: "reviewer" } });
  expect(ok.ok).toBe(true);
  w.daemon.bus.publish(newEnvelope(HUB, `Memory brief (hub memory first, fails first):\nmem:${fail.id.slice(0, 8)} fail long: a fail note the reviewer knows`, { to: ["worker"], refs: { task: "1" } }));
  await until(() => sidecar.counters(w.project).some(c => c.rendered !== null && c.key.task !== null), "the brief rendered for the task");
  expect(await w.op("hub_task_done", { id: 1, summary: "implemented, no memory cited" })).toContain("in_review");
  const reviewed = await person.request({ t: "task", op: "hub_review", args: { id: 1, verdict: "approved", note: `fine, mem:${fail.id.slice(0, 8)} was respected` } });
  expect(reviewed.ok, String(reviewed.error)).toBe(true);
  await until(() => sidecar.counters(w.project).some(c => c.key.deliveryId.startsWith("review:1:")), "the review citation");
  expect(sidecar.counters(w.project).find(c => c.key.deliveryId.startsWith("review:1:"))).toMatchObject({ cited: 1 });
});

// #1297 review: one approval must not cost a sidecar read per terminal task in the log.
test("approving a task reads the sidecar's counters once, however many terminal tasks the log already holds", async () => {
  const w = await world();
  // Eleven earlier tasks reach a terminal state first. Research is on, so each writes its own record (and reads once for itself).
  for (let id = 1; id <= 11; id++) {
    await w.op("hub_task_propose", { title: `earlier ${id}`, class: "plan", owner: "worker" });
    expect(await w.op("hub_task_done", { id, summary: "done" })).toContain("approved");
  }
  await until(() => { try { return readStore(w.file).length >= 11; } catch { return false; } }, "the eleven earlier records", 600);
  const original = CandidateStore.prototype.counters;
  let reads = 0;
  CandidateStore.prototype.counters = function (this: CandidateStore, ...args: Parameters<CandidateStore["counters"]>) { reads++; return original.apply(this, args); };
  cleanup.push(() => { CandidateStore.prototype.counters = original; });
  await w.op("hub_task_propose", { title: "the twelfth", class: "plan", owner: "worker" });
  expect(await w.op("hub_task_done", { id: 12, summary: "done" })).toContain("approved");
  await until(() => { try { return readStore(w.file).length >= 12; } catch { return false; } }, "the twelfth record", 600);
  await Bun.sleep(150);
  // The log now holds twelve terminal tasks and the live writer built records for all of them, but computed memory figures for one.
  expect(reads).toBe(1);
});
