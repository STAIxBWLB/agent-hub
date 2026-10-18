import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function restoredFixture(features: readonly string[] = DAEMON_FEATURES) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-held-target-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const options = { cwd: dir, projectId: "p-held", stateDir: join(dir, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } };
  const source = await startDaemon({ ...options, instanceId: "held-source" }); cleanup.push(() => source.stop());
  const one = await ControlClient.connect(options.stateDir, { role: "console" }); cleanup.push(() => one.close());
  const peer = await ControlClient.connect(options.stateDir, { role: "peer", peer: "claude" });
  await Bun.sleep(10); peer.close();
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
  return { target, client, carried, sourceNotice };
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
  const { target, client, carried, sourceNotice } = await restoredFixture(["task_cancel"]);
  expect(target.bus.queueIds("claude")).toEqual([carried.id, sourceNotice.id]);
  const inspect = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "held-target" });
  expect(inspect.recovery.integrity.current).toEqual(inspect.recovery.integrity.expected);
  expect((await client.request({ t: "recovery", op: "release", operationId: "held-op", expectedInstanceId: "held-target" })).released).toBe(true);
});
