import { realPath } from "../src/hub/project.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { ACCEPTED_SETTLE_TIMEOUT_REASON } from "../src/hub/delivery-journal.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("#1172 the daemon expires accepted channel deliveries once and sends an ids-only status to the conductor", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-settlement-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const settleMs = 1000;
  let now = Date.now();
  const config = {
    ...DEFAULT_CONFIG,
    roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor"] },
    bus: { ...DEFAULT_CONFIG.bus, accepted_settle_ms: settleMs },
    batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false },
  };
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config, configWatch: false, agentDrift: false, invocationSweepMs: 10, acceptedSettlementNow: () => now });
  cleanup.push(() => daemon.stop());
  const peer = await ControlClient.connect(dir, { role: "peer", peer: "claude", channel: true });
  cleanup.push(() => peer.close());
  const person = await ControlClient.connect(dir, { role: "console", projectRoot: dir });
  cleanup.push(() => person.close());
  const instanceId = (await person.request({ t: "status" })).status.instanceId;
  const olderTarget = DAEMON_FEATURES.filter(feature => feature !== "accepted_delivery_settlement");
  expect((await person.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId, targetFeatures: olderTarget })).ok).toBe(true);
  const pushes: { deliveryId: string; generation: string }[] = [];
  peer.onPush = message => { if (message.t === "deliver") pushes.push(message); };
  await until(() => daemon.bus.peers.get("claude")?.state === "idle");

  const sent = newEnvelope("user", "private-looking original body", { to: ["claude"], kind: "review", priority: "important" });
  daemon.bus.publish(sent);
  await until(() => pushes.length === 1);
  const push = pushes[0]!;
  expect((await peer.request({ t: "delivery_receipt", deliveryId: push.deliveryId, generation: push.generation, state: "accepted" })).ok).toBe(true);
  expect(daemon.bus.queueShow(push.deliveryId)?.state).toBe("accepted");
  const activeInbox = await peer.request({ t: "inbox" });
  expect(activeInbox.ok).toBe(true);
  expect(activeInbox.held).toMatchObject({ count: 1, rows: [{ id: push.deliveryId, revision: daemon.bus.queueShow(push.deliveryId)?.revision, state: "accepted" }] });
  daemon.bus.pause("claude");
  const pausedInbox = await peer.request({ t: "inbox" });
  expect(pausedInbox.ok).toBe(false);
  expect(pausedInbox.error).toBe("paused");
  expect(pausedInbox.held).toMatchObject({ count: 1, rows: [{ id: push.deliveryId, state: "accepted" }] });
  daemon.bus.resume("claude");

  const acceptedAt = daemon.bus.queueShow(push.deliveryId)!.updatedAt;
  now = acceptedAt + settleMs;
  await until(() => daemon.bus.queueShow(push.deliveryId)?.state === "needs_review");
  expect(daemon.bus.queueShow(push.deliveryId)?.reason).toBe(ACCEPTED_SETTLE_TIMEOUT_REASON);
  const incompatible = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: instanceId, targetFeatures: olderTarget });
  expect(incompatible).toMatchObject({ ok: false });
  expect(incompatible.error).toContain("accepted_delivery_settlement");

  const timeoutRows = () => daemon.bus.queueList("codex", true).filter(row => row.originals.some(env => env.refs?.supervisionKey?.startsWith("accepted-timeout:")));
  await until(() => timeoutRows().length === 1);
  const notice = timeoutRows()[0]!.originals[0]!;
  expect(notice).toMatchObject({ from: "hub", kind: "status", priority: "status" });
  expect(notice.body).toContain(push.deliveryId);
  expect(notice.body).toContain("claude");
  expect(notice.body).toContain(`ahub queue show ${push.deliveryId}`);
  expect(notice.body).not.toContain("private-looking original body");

  await Bun.sleep(30);
  expect(timeoutRows()).toHaveLength(1);
  const conductorNotices = daemon.bus.queueList("codex", true).filter(row => row.originals.some(env => typeof env.refs?.supervisionKey === "string" && env.refs.supervisionKey.includes(":hold:")));
  expect(conductorNotices).toEqual([]); // no second generic needs_review notice
});

test("#1172 conductor.feed=off suppresses accepted-timeout conductor notices", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-channel-settlement-off-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const settleMs = 1000;
  let now = Date.now();
  const config = {
    ...DEFAULT_CONFIG,
    roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor"] },
    conductor: { ...DEFAULT_CONFIG.conductor, feed: "off" as const },
    bus: { ...DEFAULT_CONFIG.bus, accepted_settle_ms: settleMs },
    batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false },
    inference: { ...DEFAULT_CONFIG.inference, enabled: false },
  };
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config, configWatch: false, agentDrift: false, invocationSweepMs: 10, acceptedSettlementNow: () => now });
  cleanup.push(() => daemon.stop());
  const peer = await ControlClient.connect(dir, { role: "peer", peer: "claude", channel: true });
  cleanup.push(() => peer.close());
  const pushes: { deliveryId: string; generation: string }[] = [];
  peer.onPush = message => { if (message.t === "deliver") pushes.push(message); };
  await until(() => daemon.bus.peers.get("claude")?.state === "idle");

  daemon.bus.publish(newEnvelope("user", "task body", { to: ["claude"], kind: "task" }));
  await until(() => pushes.length === 1);
  const push = pushes[0]!;
  expect((await peer.request({ t: "delivery_receipt", deliveryId: push.deliveryId, generation: push.generation, state: "accepted" })).ok).toBe(true);
  now = daemon.bus.queueShow(push.deliveryId)!.updatedAt + settleMs;
  await until(() => daemon.bus.queueShow(push.deliveryId)?.state === "needs_review");
  expect(daemon.bus.queueList("codex", true).some(row => row.originals.some(env => env.refs?.supervisionKey?.startsWith("accepted-timeout:")))).toBe(false);
});
