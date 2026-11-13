import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { newEnvelope, USER } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";
import { summarizeByTask } from "../src/hub/report.ts";
import { taskRecords } from "../src/hub/research.ts";
import { useEnvironmentScope } from "./helpers/env-scope.ts";

// #1278 through a real daemon and the fake ACP peer: the permission and completion the peer causes are written with the attribution of the task its delivery belongs to, and the report and the research record read the same numbers from the log.

useEnvironmentScope();
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const ROOT = join(import.meta.dir, "..");
const until = async (condition: () => boolean, label: string, attempts = 400) => { for (let i = 0; i < attempts && !condition(); i++) await Bun.sleep(20); if (!condition()) throw new Error(`timed out waiting for ${label}`); };

test("a permission asked during a delivery of a task is attributed to that task, and the report and record agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-person-attribution-")), stateDir = join(dir, "state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd: ROOT, stateDir, projectId: "p-person", instanceId: "i-person", controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 5_000,
    sdlc: sdlcConfig(undefined), // #1411: the checkout's own lifecycle file is not this fixture's subject
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "headless" } }, specs: { ...DEFAULT_CONFIG.specs, enabled: false }, kimi_cmd: ["bun", join(ROOT, "test/fakes/acp-server.ts")], batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  const pushes: any[] = [];
  person.onPush = m => { if (m.t !== "event") pushes.push(m); };
  person.send({ t: "tail" });
  expect((await person.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await until(() => daemon.bus.peers.get("kimi")?.state === "idle", "kimi attached");
  const propose = await person.request({ t: "task", op: "hub_task_propose", args: { title: "a task for kimi", class: "implement", owner: "kimi" } });
  expect(propose.ok, String(propose.error)).toBe(true);
  // The task's delivery to kimi names it, so the turn it starts belongs to that task by the delivery rule.
  daemon.bus.publish(newEnvelope(USER, "PERMISSION", { to: ["kimi"], refs: { task: "1" } }));
  await until(() => pushes.some(p => p.t === "permission"), "the permission request");
  const ask = pushes.find(p => p.t === "permission");
  await Bun.sleep(30);
  person.send({ t: "permit", id: ask.id, option: "yes", surface: "console" });
  await until(() => readEvents(join(stateDir, "events.jsonl")).some(e => e.type === "permission" && e.event === "answered"), "the answered event");
  const events = readEvents(join(stateDir, "events.jsonl"));
  expect(events.some(e => e.type === "hub_start" && e.personAttribution === true)).toBe(true);
  const requested = events.find(e => e.type === "permission" && e.event === "requested")!, answered = events.find(e => e.type === "permission" && e.event === "answered")!;
  expect(requested).toMatchObject({ task: 1, attribution: "delivery" });
  // The settle event repeats the answer captured when the request opened.
  expect(answered).toMatchObject({ task: 1, attribution: "delivery", surface: "console" });
  expect(typeof (answered as { latencyMs?: number }).latencyMs).toBe("number");
  // No text of the request reaches either event.
  expect(JSON.stringify([requested, answered])).not.toContain("PERMISSION");
  const report = summarizeByTask(events).tasks["1"]!.person;
  expect(report.permissions).toMatchObject({ asked: 1 });
  expect(report.latencyMs).toMatchObject({ n: 1, unknown: 0 });
  // Close the task so it has a record, then read both outputs from the same log: they must show the same person figures.
  expect((await person.request({ t: "task", op: "hub_task_cancel", args: { id: 1, reason: "scenario complete" } })).ok).toBe(true);
  await until(() => readEvents(join(stateDir, "events.jsonl")).some(e => e.type === "task" && e.id === 1 && e.state === "cancelled"), "the cancellation");
  const closed = readEvents(join(stateDir, "events.jsonl"));
  const record = taskRecords(closed, "p-person", { version: "test", source: "backfill" }).find(r => r.task === 1)!;
  expect(record.outcome).toBe("cancelled");
  expect(record.person).toEqual(summarizeByTask(closed).tasks["1"]!.person);
  expect(record.person!.permissions).toMatchObject({ asked: 1 });
});
