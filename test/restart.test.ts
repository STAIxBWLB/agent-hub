import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { readRestartSnapshot, releasedRestartPath, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

class HeldPeer extends BasePeer {
  readonly deliveries: Envelope[][] = [];
  constructor(readonly id: "claude" | "codex" | "kimi") { super(id); }
  async deliver(envs: Envelope[]): Promise<void> { this.deliveries.push(envs); }
  async start(): Promise<void> { this.setState("idle"); }
  async stop(): Promise<void> { this.setState("offline"); }
  stateForTest(state: PeerState): void { this.setState(state); }
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

test("bus recovery snapshot preserves queue ids, hop parents, prefaces and retry state", async () => {
  const bus = new Bus({ batchMs: 0, retryMs: 10_000 });
  const peer = new HeldPeer("kimi");
  bus.add(peer);
  await peer.start();
  peer.stateForTest("busy");
  const first = newEnvelope("claude", "queued", { inReplyTo: { trace: "trace-a", hop: 1 } });
  bus.preface("kimi", "recall");
  bus.publish(first);
  bus.setRecoveryHold(true);
  const snapshot = bus.snapshot();
  expect(snapshot.queues.kimi?.map((e) => e.id)).toEqual([first.id]);
  expect(snapshot.queues.kimi?.[0]?.hop).toBe(2);
  expect(snapshot.prefaces.kimi?.body).toBe("recall");

  const restored = new Bus({ batchMs: 0 });
  const second = new HeldPeer("kimi");
  restored.add(second);
  restored.restore(snapshot);
  expect(restored.queueIds("kimi")).toEqual([first.id]);
  expect(restored.snapshot().prefaces.kimi?.body).toBe("recall");
});

test("restart snapshot is project and operation fenced and mode 0600", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-restart-"));
  cleanup.push(() => {});
  const snapshot: RestartSnapshot = {
    schemaVersion: 1,
    projectRoot: "/project",
    projectId: "project-1",
    sourceInstanceId: "instance-1",
    operationId: "operation-1",
    committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: { "kimi:e1": 2 }, withdrawn: [] },
    manualPaused: ["kimi"],
    peers: [{ id: "kimi", state: "idle", queueIds: [], launch: { kind: "acp" }, sessionId: "s1" }],
  };
  writeRestartSnapshot(stateDir, snapshot);
  expect(statSync(join(stateDir, "restart.json")).mode & 0o777).toBe(0o600);
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "operation-1" })).toEqual(snapshot);
  expect(readRestartSnapshot(stateDir, { projectRoot: "/other", projectId: "project-1", operationId: "operation-1" })).toBeUndefined();
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "other" })).toBeUndefined();
  expect(JSON.parse(readFileSync(join(stateDir, "restart.json"), "utf8")).bus.attempts["kimi:e1"]).toBe(2);
});

test("recovery RPC is console-only, fences sends, commits, restores and releases idempotently", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-daemon-"));
  const options = {
    cwd: process.cwd(),
    projectId: "project-1",
    stateDir,
    controlPort: 0,
    codexAppPort: 0,
    codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } },
  };
  const first = await startDaemon({ ...options, instanceId: "instance-1" });
  const consoleOne = await ControlClient.connect(stateDir, { role: "console" });
  const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude-2" });
  const status = await consoleOne.request({ t: "status" });
  expect((await consoleOne.request({ t: "recovery", op: "inspect", expectedInstanceId: "wrong" })).ok).toBe(false);
  expect((await peer.request({ t: "recovery", op: "inspect", expectedInstanceId: "instance-1" })).ok).toBe(false);
  expect((await consoleOne.request({ t: "recovery", op: "inspect", expectedInstanceId: "instance-1" })).ok).toBe(true);
  expect((await consoleOne.request({ t: "recovery", op: "prepare", operationId: "op-1", expectedInstanceId: "instance-1" })).recovery.phase).toBe("prepared");
  expect((await consoleOne.request({ t: "send", body: "held" })).ok).toBe(false);
  peer.close();
  for (let n = 0; n < 100 && first.bus.peers.get("claude-2")?.state !== "offline"; n++) await Bun.sleep(5);
  expect(first.bus.peers.get("claude-2")?.state).toBe("offline");
  await consoleOne.request({ t: "recovery", op: "prepare", operationId: "op-1", expectedInstanceId: "instance-1" });
  const committed = await consoleOne.request({ t: "recovery", op: "commit", operationId: "op-1", expectedInstanceId: "instance-1" });
  expect(committed.committed).toBe(true);
  expect(readRestartSnapshot(stateDir, { projectRoot: options.cwd, projectId: "project-1", operationId: "op-1" })?.peers[0]?.state).toBe("idle");
  await first.stopped;
  consoleOne.close();
  peer.close();

  process.env.AGENTHUB_RECOVERY_OPERATION = "op-1";
  const second = await startDaemon({ ...options, instanceId: "instance-2" });
  delete process.env.AGENTHUB_RECOVERY_OPERATION;
  cleanup.push(() => second.stop());
  const consoleTwo = await ControlClient.connect(stateDir, { role: "console" });
  const inspected = await consoleTwo.request({ t: "recovery", op: "inspect", operationId: "op-1", expectedInstanceId: "instance-2" });
  expect(inspected.recovery.phase).toBe("restored");
  expect((await consoleTwo.request({ t: "recovery", op: "release", operationId: "op-1", expectedInstanceId: "instance-2" })).ok).toBe(false);
  await expect(ControlClient.connect(stateDir, { role: "peer", peer: "claude-3" }, 200)).rejects.toThrow(/not part of the recovery roster|closed/);
  const restoredPeer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude-2" });
  await Bun.sleep(20);
  const released = await consoleTwo.request({ t: "recovery", op: "release", operationId: "op-1", expectedInstanceId: "instance-2" });
  expect(released.released).toBe(true);
  expect(JSON.parse(readFileSync(releasedRestartPath(stateDir, "op-1"), "utf8")).operationId).toBe("op-1");
  expect((await consoleTwo.request({ t: "recovery", op: "release", operationId: "op-1", expectedInstanceId: "instance-2" })).released).toBe(true);
  expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).recovery.phase).toBe("released");
  expect((await consoleTwo.request({ t: "send", body: "ordinary after release" })).ok).toBe(true);
  expect((await consoleTwo.request({ t: "recovery", op: "prepare", operationId: "op-2", expectedInstanceId: "instance-2" })).recovery.phase).toBe("prepared");
  expect((await consoleTwo.request({ t: "recovery", op: "abort", operationId: "op-2", expectedInstanceId: "instance-2" })).aborted).toBe(true);
  consoleTwo.close();
  restoredPeer.close();
  void status;
});

test("a present corrupt restart snapshot blocks daemon startup", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-corrupt-"));
  writeFileSync(join(stateDir, "restart.json"), "not-json", { mode: 0o600 });
  await expect(startDaemon({ cwd: process.cwd(), projectId: "project-1", instanceId: "instance-1", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } })).rejects.toThrow(/restart state/);
});

test("restart validation rejects invalid queued hops while retaining seen dropped envelopes", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-envelope-"));
  const envelope = { id: "e1", trace: "t", hop: 99, from: "claude", body: "queued", kind: "chat", priority: "status", ts: Date.now() };
  const snapshot: any = { schemaVersion: 1, projectRoot: "/project", projectId: "project-1", sourceInstanceId: "instance-1", operationId: "operation-1", committedAt: Date.now(), bus: { schemaVersion: 1, queues: { kimi: [envelope] }, prefaces: {}, seen: [{ ...envelope }], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [] };
  writeFileSync(join(stateDir, "restart.json"), JSON.stringify(snapshot), { mode: 0o600 });
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "operation-1" })).toBeUndefined();
  snapshot.bus.queues.kimi = [];
  writeFileSync(join(stateDir, "restart.json"), JSON.stringify(snapshot), { mode: 0o600 });
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "operation-1" })).toBeDefined();
});

test("prepare remains blocked by a pending permission, then preserves a manual pause", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-permit-"));
  const daemon = await startDaemon({
    cwd: process.cwd(), projectId: "project-1", instanceId: "instance-1", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, kimi_cmd: ["bun", join(process.cwd(), "test/fakes/acp-server.ts")], memory: { ...DEFAULT_CONFIG.memory, enabled: false }, batch_ms: 0 },
    permissionTimeoutMs: 5_000,
  });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  const pushes: any[] = [];
  console_.onPush = (message) => pushes.push(message);
  console_.send({ t: "tail" });
  expect((await console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  for (let i = 0; i < 100 && (await console_.request({ t: "status" })).status.peers.kimi?.state !== "idle"; i++) await Bun.sleep(10);
  await console_.request({ t: "send", body: "PERMISSION", to: ["kimi"] });
  for (let i = 0; i < 100 && !pushes.some((message) => message.t === "permission"); i++) await Bun.sleep(10);
  const permission = pushes.find((message) => message.t === "permission");
  expect(permission).toBeDefined();
  await console_.request({ t: "pause", peer: "kimi" });
  const preparing = await console_.request({ t: "recovery", op: "prepare", operationId: "op-1", expectedInstanceId: "instance-1" });
  expect(preparing.recovery.ready).toBe(false);
  console_.send({ t: "permit", id: permission.id, option: "yes" });
  for (let i = 0; i < 100 && pushes.some((message) => message.t === "permission"); i++) await Bun.sleep(10);
  const prepared = await console_.request({ t: "recovery", op: "prepare", operationId: "op-1", expectedInstanceId: "instance-1" });
  expect(prepared.recovery.phase).toBe("prepared");
  expect((await console_.request({ t: "status" })).status.peers.kimi.state).toBe("paused");
  expect((await console_.request({ t: "recovery", op: "abort", operationId: "op-1", expectedInstanceId: "instance-1" })).aborted).toBe(true);
  console_.close();
});

test("restored fresh local sessions retain manual pause and queued work before release", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-local-recovery-"));
  const queued = newEnvelope("user", "held fixture", { to: ["local"] });
  writeRestartSnapshot(stateDir, {
    schemaVersion: 1, projectRoot: stateDir, projectId: "local-project", sourceInstanceId: "old-local", operationId: "local-op", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: { local: [queued] }, prefaces: {}, seen: [queued], attempts: {}, withdrawn: [] },
    manualPaused: ["local"], peers: [{ id: "local", state: "idle", queueIds: [queued.id], sessionId: "old-worker-session", launch: { kind: "local" } }],
    integrity: { queues: { local: [queued.id] }, manualPaused: ["local"], boardDigest: createHash("sha256").update("[]").digest("hex"), budgetDigest: createHash("sha256").update("[]").digest("hex") },
  });
  const previous = process.env.AGENTHUB_RECOVERY_OPERATION;
  process.env.AGENTHUB_RECOVERY_OPERATION = "local-op";
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ cwd: stateDir, stateDir, projectId: "local-project", instanceId: "new-local", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  } finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
  const client = await ControlClient.connect(stateDir, { role: "console" });
  try {
    expect((await client.request({ t: "start", peer: "local", operationId: "local-op" })).ok).toBe(true);
    const inspected = await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "new-local" });
    expect(inspected.recovery.peers.local.sessionId).not.toBe("old-worker-session");
    expect(inspected.recovery.ready).toBe(true);
    expect((await client.request({ t: "recovery", op: "release", operationId: "local-op", expectedInstanceId: "new-local" })).ok).toBe(true);
    expect(daemon.bus.stateOf("local")).toBe("paused");
    expect(daemon.bus.queueIds("local")).toEqual([queued.id]);
  } finally { client.close(); await daemon.stop(); }
});
