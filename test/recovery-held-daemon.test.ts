import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

for (const coordination of ["advisory", "turn-free"] as const) test(`#1350 ordinary startup releases persisted hub notices before Tasks exists (${coordination})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-deferred-startup-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state");
  const notices = [
    newEnvelope("hub", "retained planner task notice", { to: ["claude"], kind: "task", priority: "status" }),
    newEnvelope("hub", "retained private review notice", { to: ["claude"], kind: "review", priority: "important", private: true }),
  ];
  const journal = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: dir, projectId: "p-startup", instanceId: "prior-startup" });
  try {
    // Retain the offline planner's queue key so the bus includes it in the startup publication audience.
    journal.persistBus({ schemaVersion: 1, queues: { claude: [] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [], deferredHub: notices }, []);
  } finally { journal.close(); }

  // No restart snapshot or recovery operation: use the normal startup release, not the restored-target path.
  const daemon = await startDaemon({ cwd: dir, stateDir, projectId: "p-startup", instanceId: "normal-startup", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, coordination, roster: { claude: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect((await client.request({ t: "status" })).status.instanceId).toBe("normal-startup");
  expect(daemon.bus.isRecoveryHeld).toBe(false);
  expect(daemon.bus.snapshot(false).deferredHub).toBeUndefined();
  expect(daemon.bus.pendingEnvelopes("claude")).toEqual(notices);
  // Releasing again must not duplicate either original.
  daemon.bus.setRecoveryHold(false);
  expect(daemon.bus.queueIds("claude")).toEqual(notices.map(notice => notice.id));
  await daemon.stop();
  const reopened = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: dir, projectId: "p-startup", instanceId: "after-startup" });
  try {
    const bus = reopened.snapshot().bus as { deferredHub?: unknown[]; queues: Record<string, unknown[]> };
    expect(bus.deferredHub).toBeUndefined();
    expect(bus.queues.claude).toEqual(notices);
  } finally { reopened.close(); }
});

async function restoredFixture(features: readonly string[] = DAEMON_FEATURES, backlog = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-held-target-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const options = { cwd: dir, projectId: "p-held", stateDir: join(dir, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } };
  const source = await startDaemon({ ...options, instanceId: "held-source" }); cleanup.push(() => source.stop());
  const one = await ControlClient.connect(options.stateDir, { role: "console" }); cleanup.push(() => one.close());
  const peer = await ControlClient.connect(options.stateDir, { role: "peer", peer: "claude", ...(backlog ? { channel: false } : {}) });
  await Bun.sleep(10);
  if (backlog) {
    expect((await one.request({ t: "task", op: "hub_task_propose", args: { title: "retained planning item", class: "implement", backlog: true } })).ok).toBe(true);
    // Consume the source reminder; a new target's Tasks instance should announce the retained backlog again.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !source.bus.pendingEnvelopes("claude").some(env => env.refs?.backlog?.length)) await Bun.sleep(5);
    expect(source.bus.pendingEnvelopes("claude").some(env => env.refs?.backlog?.length)).toBe(true);
    expect((await peer.request({ t: "inbox" })).ok).toBe(true);
    expect(source.bus.queueIds("claude")).toEqual([]);
  }
  peer.close();
  const end = Date.now() + 5000;
  while (Date.now() < end && source.bus.peers.get("claude")?.state !== "offline") await Bun.sleep(5);
  expect(source.bus.peers.get("claude")?.state).toBe("offline");
  const carried = newEnvelope("user", "retained work", { to: ["claude"] }); source.bus.publish(carried);
  expect((await one.request({ t: "recovery", op: "prepare", operationId: "held-op", expectedInstanceId: "held-source", targetFeatures: features })).ok).toBe(true);
  const sourceNotice = newEnvelope("hub", "source notice while held", { to: ["claude"], kind: "task" }); source.bus.publish(sourceNotice);
  expect((await one.request({ t: "recovery", op: "commit", operationId: "held-op", expectedInstanceId: "held-source", targetFeatures: features })).committed).toBe(true);
  await source.stopped;
  const prior = process.env.AGENTHUB_RECOVERY_OPERATION;
  let target: Awaited<ReturnType<typeof startDaemon>>;
  try { process.env.AGENTHUB_RECOVERY_OPERATION = "held-op"; target = await startDaemon({ ...options, instanceId: "held-target" }); }
  finally { if (prior === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = prior; }
  cleanup.push(() => target.stop());
  const client = await ControlClient.connect(options.stateDir, { role: "console" }); cleanup.push(() => client.close());
  return { target, client, carried, sourceNotice, stateDir: options.stateDir };
}

test("#478 target startup notices verify without queue mutation exemptions and remain for release", async () => {
  const { target, client, carried, sourceNotice } = await restoredFixture();
  const notice = newEnvelope("hub", "new target backlog notice", { to: ["claude"], kind: "task" }); target.bus.publish(notice);
  const inspect = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "held-target" });
  expect(inspect.recovery.integrity.current).toEqual(inspect.recovery.integrity.expected);
  expect(target.bus.queueIds("claude")).toEqual([carried.id]);
  const refused = await client.request({ t: "queue", op: "resolve", id: "not-a-delivery", revision: 0, action: "completed", reason: "not exempt" });
  expect(refused.ok).toBe(false); expect(refused.error).toBe("recovery or shutdown is holding queue mutations");
  expect((await client.request({ t: "recovery", op: "release", operationId: "held-op", expectedInstanceId: "held-target" })).released).toBe(true);
  expect(target.bus.queueIds("claude")).toEqual([carried.id, sourceNotice.id, notice.id]);
});

for (const mutation of ["missing", "altered", "duplicated", "misrouted"] as const) test(`#478 ${mutation} carried queue remains a release refusal`, async () => {
  const { target, client, carried } = await restoredFixture();
  const snapshot = target.bus.snapshot(false);
  if (mutation === "missing") snapshot.queues.claude = [];
  if (mutation === "altered") snapshot.queues.claude = [{ ...carried, id: "wrong-original" }];
  if (mutation === "duplicated") snapshot.queues.claude!.push({ ...carried });
  if (mutation === "misrouted") { snapshot.queues.claude = []; snapshot.queues.codex = [carried]; }
  target.bus.restore(snapshot);
  const result = await client.request({ t: "recovery", op: "release", operationId: "held-op", expectedInstanceId: "held-target" });
  expect(result.ok).toBe(false); expect(result.error).toContain("integrity changed"); expect(target.bus.isRecoveryHeld).toBe(true);
});

test("#478 source carries notices normally for a target without deferred-hub support", async () => {
  const { target, client, carried, sourceNotice } = await restoredFixture(["task_cancel", "schema_guard"]);
  expect(target.bus.queueIds("claude")).toEqual([carried.id, sourceNotice.id]);
  const inspect = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "held-target" });
  expect(inspect.recovery.integrity.current).toEqual(inspect.recovery.integrity.expected);
  expect((await client.request({ t: "recovery", op: "release", operationId: "held-op", expectedInstanceId: "held-target" })).released).toBe(true);
});


test("#478 real Tasks backlog reminder is deferred on target planner attachment and published after release", async () => {
  const { target, client, carried, sourceNotice, stateDir } = await restoredFixture(DAEMON_FEATURES, true);
  const planner = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: false }); cleanup.push(() => planner.close());
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !target.bus.snapshot(false).deferredHub?.some(env => env.refs?.backlog?.length)) await Bun.sleep(5);
  const reminder = target.bus.snapshot(false).deferredHub?.find(env => env.refs?.backlog?.length);
  expect(reminder).toBeDefined(); expect(reminder!.kind).toBe("task");
  const observed = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "held-target" });
  expect(observed.recovery.integrity.current).toEqual(observed.recovery.integrity.expected);
  expect(target.bus.queueIds("claude")).toEqual([carried.id]);
  expect((await client.request({ t: "recovery", op: "release", operationId: "held-op", expectedInstanceId: "held-target" })).released).toBe(true);
  expect(target.bus.queueIds("claude")).toEqual([carried.id, sourceNotice.id, reminder!.id]);
  const inbox = await planner.request({ t: "inbox" });
  expect(inbox.ok).toBe(true);
  expect(target.bus.queueIds("claude")).toEqual([]);
});
