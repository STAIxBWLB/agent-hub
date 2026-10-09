import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope, type Envelope, type PeerState } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { abandonRestartSnapshot, readRestartSnapshot, releasedRestartPath, waiveRecoveryPeers, writeRestartSnapshot, type RestartSnapshot } from "../src/hub/restart.ts";

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

test("journal recovery preserves an offline peer's empty queue without reattachment", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-empty-recovery-"));
  const journal = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: stateDir, projectId: "p", instanceId: "i" });
  cleanup.push(() => journal.close());
  const source = new Bus({ journal, batchMs: 0 });
  source.add(new HeldPeer("claude"));
  source.add(new HeldPeer("kimi"));
  const snapshot = source.snapshot();
  expect(snapshot.journal?.revision).toBe(0);
  expect(snapshot.journal?.bus.queues).toEqual({});
  const target = new Bus({ journal, batchMs: 0 });
  target.restore(snapshot, "op-empty");
  expect(target.peers.size).toBe(0);
  expect(target.snapshot().queues).toEqual({ claude: [], kimi: [] });
  expect(journal.snapshot().bus.queues).toEqual({ claude: [], kimi: [] });
});

test("journal recovery keeps durable work authoritative over stale snapshot queues", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-authoritative-recovery-"));
  const journal = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: stateDir, projectId: "p", instanceId: "i" });
  cleanup.push(() => journal.close());
  const target = new Bus({ journal, batchMs: 0 });
  const durable = newEnvelope("user", "durable work");
  const stale = newEnvelope("user", "already removed");
  const snapshot = target.snapshot();
  snapshot.queues = { claude: [], codex: [stale], kimi: [] };
  journal.persistBus({ ...target.snapshot(false), queues: { claude: [durable] } }, []);
  const receipt = journal.createDelivery({ id: "uncertain", peer: "claude", state: "needs_review", createdAt: durable.ts, originals: [durable], out: [durable] });
  target.restore(snapshot, "op-authoritative");
  expect(target.queueIds("claude")).toEqual([durable.id]);
  expect(target.snapshot().queues.codex).toBeUndefined();
  expect(target.snapshot().queues.kimi).toEqual([]);
  expect(journal.get("uncertain")).toEqual(receipt);
});

test("journal recovery releases a committed offline peer without reconnecting it", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-offline-recovery-"));
  const options = { cwd: process.cwd(), projectId: "p-offline", stateDir,
    controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } };
  const first = await startDaemon({ ...options, instanceId: "offline-source" });
  cleanup.push(() => first.stop());
  const one = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => one.close());
  const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
  cleanup.push(() => peer.close());
  await Bun.sleep(20);
  peer.close();
  for (let n = 0; n < 100 && first.bus.peers.get("claude")?.state !== "offline"; n++) await Bun.sleep(5);
  expect(first.bus.peers.get("claude")?.state).toBe("offline");
  expect((await one.request({ t: "recovery", op: "prepare", operationId: "op-offline", expectedInstanceId: "offline-source" })).recovery.phase).toBe("prepared");
  expect((await one.request({ t: "recovery", op: "commit", operationId: "op-offline", expectedInstanceId: "offline-source" })).committed).toBe(true);
  await first.stopped;
  const previous = process.env.AGENTHUB_RECOVERY_OPERATION;
  let second;
  try {
    process.env.AGENTHUB_RECOVERY_OPERATION = "op-offline";
    second = await startDaemon({ ...options, instanceId: "offline-target" });
  } finally {
    if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION;
    else process.env.AGENTHUB_RECOVERY_OPERATION = previous;
  }
  cleanup.push(() => second.stop());
  const two = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => two.close());
  const inspected = await two.request({ t: "recovery", op: "inspect", expectedInstanceId: "offline-target" });
  expect(inspected.recovery.integrity.current).toEqual(inspected.recovery.integrity.expected);
  expect(second.bus.peers.has("claude")).toBe(false);
  expect((await two.request({ t: "recovery", op: "release", operationId: "op-offline", expectedInstanceId: "offline-target" })).released).toBe(true);
});

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

test("a recovery commit waits for a completion check, whose result would land after the commit's board digest", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-check-"));
  const gate = join(stateDir, "check-may-finish");
  cleanup.push(() => writeFileSync(gate, "")); // a failing run must not leave the check looping
  // Bounded too (30 s, under timeout_s), in case the runner itself dies before cleanup.
  const config = { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, checks: { timeout_s: 60, review: `i=0; while [ ! -f '${gate}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done` } };
  const hub = await startDaemon({ cwd: process.cwd(), projectId: "project-1", instanceId: "instance-1", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config });
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  await console_.request({ t: "task", op: "hub_task_propose", args: { title: "x", class: "review" } });
  expect((await console_.request({ t: "task", op: "hub_task_done", args: { id: 1, summary: "s" } })).text).toContain("its check is queued or running");
  const op = (o: string) => console_.request({ t: "recovery", op: o, operationId: "op-check", expectedInstanceId: "instance-1" });
  await op("prepare");
  expect((await op("commit")).error).toContain("completion checks have finished");
  writeFileSync(gate, "");
  let committed: any;
  for (let n = 0; n < 100 && !(committed = await op("commit")).committed; n++) await Bun.sleep(50);
  expect(committed.committed).toBe(true);
  expect(readRestartSnapshot(stateDir, { projectRoot: process.cwd(), projectId: "project-1", operationId: "op-check" })).toBeDefined();
  await hub.stopped;
  console_.close();
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

// A 0.7.x hub digested its board before tasks had a plan column (#31), a 0.8.x hub before the deps column (#34): an
// upgrade from either must still verify the board, and so must one from a hub with both. A board that changed since fails.
test("a board digested before the plan or deps column, or with both, verifies after the restart; a changed one does not", async () => {
  for (const shape of ["0.7.x", "0.8.x", "current", "changed"]) {
    const stateDir = mkdtempSync(join(tmpdir(), "agenthub-board-digest-"));
    const board = new Board(join(stateDir, "hub.db"));
    board.propose("user", { title: "carried across the upgrade", class: "implement" });
    // The columns a hub of that version did not have yet (#31 plan, #34 deps): its rows were digested without them.
    const missing = { "0.7.x": ["deps", "plan"], "0.8.x": ["deps"], current: [], changed: ["deps", "plan"] }[shape]!;
    const rows = board.list().map((t) => {
      const row: Record<string, unknown> = { ...t };
      for (const col of missing) delete row[col];
      return row;
    });
    if (shape === "changed") board.propose("user", { title: "added after the source recorded its digest", class: "implement" });
    board.close();
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    writeRestartSnapshot(stateDir, {
      schemaVersion: 1, projectRoot: stateDir, projectId: "digest-project", sourceInstanceId: "old", operationId: "digest-op", committedAt: Date.now(),
      bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
      integrity: { queues: {}, manualPaused: [], boardDigest: sha(JSON.stringify(rows)), budgetDigest: sha("[]") },
    });
    const previous = process.env.AGENTHUB_RECOVERY_OPERATION;
    process.env.AGENTHUB_RECOVERY_OPERATION = "digest-op";
    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    try {
      daemon = await startDaemon({ cwd: stateDir, stateDir, projectId: "digest-project", instanceId: "new", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
        config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
    } finally { if (previous === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previous; }
    const client = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const { integrity } = (await client.request({ t: "recovery", op: "inspect", expectedInstanceId: "new" })).recovery;
      const released = await client.request({ t: "recovery", op: "release", operationId: "digest-op", expectedInstanceId: "new" });
      if (shape === "changed") {
        expect(integrity.current).not.toEqual(integrity.expected);
        expect(released.ok).toBe(false);
        expect(released.error).toContain("integrity changed during recovery");
      } else {
        expect(integrity.current, shape).toEqual(integrity.expected);
        expect(released.ok, shape).toBe(true);
      }
    } finally { client.close(); await daemon.stop(); }
  }
});

// issue #21: a TUI that exits after prepare must not wedge readiness forever, and a peer
// that comes back with a DIFFERENT conversation must still wedge it.
test("a detached peer does not wedge recovery readiness; a changed thread still does", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-wedge-"));
  const daemon = await startDaemon({
    cwd: process.cwd(), projectId: "project-wedge", instanceId: "instance-wedge", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } },
  });
  cleanup.push(() => daemon.stop());
  class CodexLike extends HeldPeer {
    thread: string | undefined = "thread-T";
    recoveryMetadata(): Record<string, unknown> {
      return { launch: { kind: "codex-appserver" }, ...(this.thread ? { threadId: this.thread } : {}) };
    }
  }
  const codex = new CodexLike("codex");
  daemon.bus.add(codex);
  await codex.start();
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  cleanup.push(() => console_.close());
  const ready = async () => (await console_.request({ t: "recovery", op: "inspect", operationId: "op-wedge", expectedInstanceId: "instance-wedge" })).recovery.ready;

  const prepared = await console_.request({ t: "recovery", op: "prepare", operationId: "op-wedge", expectedInstanceId: "instance-wedge" });
  expect(prepared.recovery.phase).toBe("prepared");
  expect(prepared.recovery.ready).toBe(true);

  // The codex TUI exits: the peer detaches and its thread id is gone with it.
  codex.thread = undefined;
  codex.stateForTest("offline");
  expect(await ready()).toBe(true); // not wedged: a detached peer is not a changed conversation

  // A reattached peer carrying a different thread is the identity change the guard exists for.
  codex.thread = "thread-other";
  codex.stateForTest("idle");
  expect(await ready()).toBe(false);

  // The original thread coming back reads ready again.
  codex.thread = "thread-T";
  expect(await ready()).toBe(true);
  expect((await console_.request({ t: "recovery", op: "abort", operationId: "op-wedge", expectedInstanceId: "instance-wedge" })).aborted).toBe(true);
});


// issue #64: the commit snapshot records whether the Claude session ever persisted a
// transcript, preferring the path Claude itself reported through the status line.
test("commit records whether the Claude session has a persisted transcript", async () => {
  for (const persisted of [false, true] as const) {
    const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-persisted-"));
    const transcript = join(stateDir, "transcript.jsonl");
    if (persisted) writeFileSync(transcript, "{}\n");
    const daemon = await startDaemon({
      cwd: stateDir, projectId: "project-persisted", instanceId: "instance-persisted", stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } },
    });
    const console_ = await ControlClient.connect(stateDir, { role: "console" });
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "instance-persisted", sessionId: "s-old", transcriptPath: transcript }));
    expect((await console_.request({ t: "recovery", op: "prepare", operationId: "op-persisted", expectedInstanceId: "instance-persisted" })).recovery.phase).toBe("prepared");
    expect((await console_.request({ t: "recovery", op: "commit", operationId: "op-persisted", expectedInstanceId: "instance-persisted" })).committed).toBe(true);
    const snapshot = readRestartSnapshot(stateDir, { projectRoot: stateDir, projectId: "project-persisted", operationId: "op-persisted" });
    expect(snapshot?.peers.find((p) => p.id === "claude")?.sessionPersisted).toBe(persisted);
    console_.close();
    peer.close();
    await daemon.stopped;
  }
});

// issue #64: a zero-turn Claude session cannot be resumed (no transcript on disk), so a
// fresh session reattaching after restore is not a changed conversation. The tolerance
// ends the moment a transcript exists, and snapshots written before the flag are
// re-derived from disk.
test("a restored zero-turn Claude session may reattach fresh only while no transcript exists", async () => {
  const cases = [
    { name: "flag false", sessionPersisted: false as boolean | undefined, transcriptOnDisk: false, ready: true },
    { name: "flag true", sessionPersisted: true as boolean | undefined, transcriptOnDisk: false, ready: false },
    { name: "legacy snapshot, no transcript", sessionPersisted: undefined, transcriptOnDisk: false, ready: true },
    { name: "legacy snapshot, transcript exists", sessionPersisted: undefined, transcriptOnDisk: true, ready: false },
  ];
  for (const c of cases) {
    const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-zeroturn-"));
    const claudeConfig = join(stateDir, "claude-config");
    mkdirSync(claudeConfig, { recursive: true });
    if (c.transcriptOnDisk) {
      const dir = join(claudeConfig, "projects", stateDir.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "s-old.jsonl"), "{}\n");
    }
    writeRestartSnapshot(stateDir, {
      schemaVersion: 1, projectRoot: stateDir, projectId: "project-zeroturn", sourceInstanceId: "old", operationId: "op-zeroturn", committedAt: Date.now(),
      bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] },
      manualPaused: [],
      peers: [{ id: "claude", state: "idle", queueIds: [], launch: { kind: "claude-channel" }, sessionId: "s-old", ...(c.sessionPersisted === undefined ? {} : { sessionPersisted: c.sessionPersisted }) }],
    });
    const previousRecovery = process.env.AGENTHUB_RECOVERY_OPERATION;
    const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.AGENTHUB_RECOVERY_OPERATION = "op-zeroturn";
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    try {
      daemon = await startDaemon({ cwd: stateDir, stateDir, projectId: "project-zeroturn", instanceId: "instance-zeroturn", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
        config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
    } finally {
      if (previousRecovery === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previousRecovery;
    }
    const console_ = await ControlClient.connect(stateDir, { role: "console" });
    try {
      const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
      writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "instance-zeroturn", sessionId: "s-fresh" }));
      await Bun.sleep(20);
      const inspected = await console_.request({ t: "recovery", op: "inspect", expectedInstanceId: "instance-zeroturn" });
      expect(inspected.recovery.ready).toBe(c.ready);
      peer.close();
    } finally {
      console_.close();
      await daemon.stop();
      if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    }
  }
});

// #206: an unmanaged Claude reconnects to the target with no session record there, so it can never show the saved
// id. Only the coordinator's waiver for this very operation lets readiness accept it; it still has to reattach.
test("a restored daemon waives a saved session id only for peers its own operation waived", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-recovery-waiver-"));
  writeRestartSnapshot(stateDir, {
    schemaVersion: 1, projectRoot: stateDir, projectId: "project-waiver", sourceInstanceId: "old", operationId: "op-waiver", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] },
    manualPaused: [],
    peers: [{ id: "claude", state: "idle", queueIds: [], sessionId: "s-stale", sessionPersisted: true }],
  });
  const previousRecovery = process.env.AGENTHUB_RECOVERY_OPERATION;
  process.env.AGENTHUB_RECOVERY_OPERATION = "op-waiver";
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ cwd: stateDir, stateDir, projectId: "project-waiver", instanceId: "instance-waiver", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
  } finally {
    if (previousRecovery === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = previousRecovery;
  }
  const console_ = await ControlClient.connect(stateDir, { role: "console" });
  const ready = async () => (await console_.request({ t: "recovery", op: "inspect", expectedInstanceId: "instance-waiver" })).recovery.ready;
  try {
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    await Bun.sleep(20);
    expect(await ready()).toBe(false);
    waiveRecoveryPeers(stateDir, "op-other", { claude: "reconnect-only" });
    expect(await ready()).toBe(false);
    waiveRecoveryPeers(stateDir, "op-waiver", { claude: "reconnect-only" });
    expect(await ready()).toBe(true);
    expect(statSync(join(stateDir, "recovery-waivers.json")).mode & 0o777).toBe(0o600);
    peer.close();
  } finally {
    console_.close();
    await daemon.stop();
  }
});

// #215 stop-and-archive: only this operation's committed snapshot moves aside, privately, so an ordinary start works again.
test("an abandoned operation's snapshot is archived and another operation's is left alone", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-abandon-"));
  writeRestartSnapshot(stateDir, {
    schemaVersion: 1, projectRoot: "/project", projectId: "project-1", sourceInstanceId: "instance-1", operationId: "op-a", committedAt: Date.now(),
    bus: { schemaVersion: 1, queues: {}, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, manualPaused: [], peers: [],
  });
  abandonRestartSnapshot(stateDir, "op-b");
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1", operationId: "op-a" })).toBeDefined();
  abandonRestartSnapshot(stateDir, "op-a");
  expect(readRestartSnapshot(stateDir, { projectRoot: "/project", projectId: "project-1" })).toBeUndefined();
  const archived = join(stateDir, `restart.abandoned.${createHash("sha256").update("op-a").digest("hex")}.json`);
  expect(JSON.parse(readFileSync(archived, "utf8")).operationId).toBe("op-a");
  expect(statSync(archived).mode & 0o777).toBe(0o600);
});
