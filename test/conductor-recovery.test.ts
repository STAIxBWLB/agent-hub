import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { ControlClient, DAEMON_FEATURES, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { captureRecoveryPolicy } from "../src/hub/recovery-policy.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { realPath } from "../src/hub/project.ts";
import { planFingerprint, type Inspection, type RecoveryPeer, type UpgradePlan } from "../src/cli/upgrade.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { VERSION } from "../src/version.ts";
import { LocalPeer } from "../src/adapters/local-worker.ts";
import { OmniRoute } from "../src/omniroute/client.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

const PACKAGE_ROOT = realPath(resolve(import.meta.dir, ".."));
class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;
  constructor() { this.promise = new Promise<void>(resolve => { this.resolve = resolve; }); }
}
class CapturePeer extends BasePeer {
  captures = 0;
  constructor(readonly capture: () => Promise<void>) { super("pi"); }
  async start() { this.setState("idle"); }
  async stop() { this.clearWatchdog(); this.setState("offline"); }
  async deliver() { throw new Error("recovery fixture never delivers native work"); }
  async captureResume(): Promise<Record<string, unknown>> { this.captures++; await this.capture(); return {}; }
}

async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-recovery-daemon-"))), stateDir = join(root, ".agenthub", "state");
  const oldEnv = { AGENTHUB_HOME: process.env.AGENTHUB_HOME, HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.AGENTHUB_HOME = join(root, "home"); process.env.HOME = join(root, "home"); process.env.PATH = "/usr/bin:/bin";
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude"); process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(join(root, ".agenthub"), { recursive: true });
  const configFile = join(root, ".agenthub", "config.local.json");
  const config = { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex",
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
    snapshots: { enabled: false, keep: 20 }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, batch_ms: 0 };
  writeFileSync(configFile, JSON.stringify(config));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const clients: ControlClient[] = [];
  const close = async () => {
    for (const client of clients) client.close(); await daemon?.stop();
    for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: loadConfig(root), snapshotClock: () => 0, configWatch: false, boundedTools: emulatedBoundedTools() });
    const connect = async (peer?: string) => {
      const client = await ControlClient.connect(stateDir, peer ? { role: "tools", peer, projectRoot: root } : { role: "console", projectRoot: root });
      clients.push(client); return client;
    };
    const person = await connect(), lead = await connect("codex"), ordinary = await connect("claude");
    const status = (await person.request({ t: "status" })).status;
    const project = { id: status.projectId as string, root, stateDir, basePort: daemon.port, instanceId: status.instanceId as string, pid: process.pid };
    const inspect = () => person.request({ t: "recovery", op: "inspect", expectedInstanceId: project.instanceId });
    const authority = async () => {
      const observed = await inspect(); expect(observed.ok).toBe(true);
      const source: Inspection = { state: "running", instanceId: project.instanceId, version: VERSION, protocol: PROTOCOL,
        peers: Object.values(observed.recovery.peers ?? {}) as RecoveryPeer[], blockers: [] };
      const digest = packageDigest(PACKAGE_ROOT, { ownDependencies: true });
      const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: digest,
        projects: [{ project, source, terminals: [], blockers: [] }], blockers: [] };
      const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "restart", projectId: project.id,
        projectRoot: root, stateDir, sourceInstanceId: project.instanceId, targetRoot: PACKAGE_ROOT, targetDigest: digest, planFingerprint: plan.fingerprint,
        ...captureRecoveryPolicy(project, "codex", loadConfig(root)) };
      return { binding, plan };
    };
    const request = (binding: ConductorRecoveryBinding, op: string, extra: Record<string, unknown> = {}) => lead.request({ t: "recovery", op,
      expectedInstanceId: project.instanceId, operationId: binding.operationId, authority: binding, targetFeatures: [...DAEMON_FEATURES], targetVersion: VERSION, ...extra });
    const addCapture = async (callback: () => Promise<void>) => { const peer = new CapturePeer(callback); daemon!.bus.add(peer); await peer.start(); return peer; };
    return { root, stateDir, daemon, person, lead, ordinary, project, authority, inspect, request, addCapture,
      async revokeConductor() {
        config.roles.codex = ["planner"]; writeFileSync(configFile, JSON.stringify(config));
        const first = await person.request({ t: "settings_reload" }); expect(first.ok).toBe(true);
        if (first.confirmation?.token) expect((await person.request({ t: "settings_reload", confirm: first.confirmation.token })).ok).toBe(true);
        expect((await lead.request({ t: "recovery_authority", op: "authorize", command: "restart" })).ok).toBe(false);
      },
      noEffects() { expect(daemon!.bus.isRecoveryHeld).toBe(false); expect(existsSync(join(stateDir, "restart.json"))).toBe(false); }, close };
  } catch (error) { await close(); throw error; }
}

test("conductor task unassign RPC preserves its real actor and rejects an ordinary current owner", async () => {
  const f = await fixture(), board = new Board(join(f.stateDir, "hub.db"));
  try {
    let task = board.propose("user", { title: "unassign RPC fixture", class: "implement" });
    task = board.update(task.id, "claude", "accepted", { owner: "claude", state: "in_progress" });
    const request = { t: "task", op: "task_unassign", args: { id: task.id, role: "owner", revision: task.history.length } };
    expect((await f.ordinary.request(request)).ok).toBe(false); expect(board.get(task.id)).toEqual(task);
    expect((await f.lead.request(request)).ok).toBe(true);
    expect(board.get(task.id)).toMatchObject({ owner: null, reserved: null, state: "proposed" });
    expect(board.get(task.id)!.history.at(-1)).toMatchObject({ by: "codex", event: "unassigned", conductorManual: true });
    f.noEffects();
  } finally { board.close(); await f.close(); }
}, 20_000);

test("recovery RPC missing authority refuses before capture, hold, snapshot or private grant creation", async () => {
  const f = await fixture();
  try {
    const peer = await f.addCapture(async () => {}), operationId = crypto.randomUUID();
    for (const op of ["prepare", "commit", "abort", "release"]) {
      expect((await f.lead.request({ t: "recovery", op, operationId, expectedInstanceId: f.project.instanceId, targetFeatures: [...DAEMON_FEATURES] })).ok).toBe(false);
    }
    expect((await f.ordinary.request({ t: "recovery_authority", op: "authorize", command: "restart" })).ok).toBe(false);
    expect(peer.captures).toBe(0); f.noEffects();
    expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false);
    expect(existsSync(join(f.stateDir, `conductor-recovery.${operationId}.json`))).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("source authority issue and verify bind the full current package plan before tools prepare and abort", async () => {
  const f = await fixture();
  try {
    const { binding, plan } = await f.authority();
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(false);
    expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false);
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(true);
    const wrongInstance = await f.request(binding, "prepare", { expectedInstanceId: crypto.randomUUID() });
    expect(wrongInstance.ok).toBe(false); f.noEffects();
    const prepared = await f.request(binding, "prepare"); expect(prepared.ok).toBe(true); expect(f.daemon.bus.isRecoveryHeld).toBe(true);
    expect((await f.request(binding, "abort")).ok).toBe(true); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

test("source issuance refuses foreign owner, plan, instance and package bindings without minting a grant", async () => {
  const f = await fixture();
  try {
    const { binding, plan } = await f.authority();
    const mismatches: Partial<ConductorRecoveryBinding>[] = [{ peer: "claude" }, { projectId: "foreign" }, { projectRoot: PACKAGE_ROOT }, { stateDir: f.root },
      { sourceInstanceId: crypto.randomUUID() }, { targetRoot: f.root }, { targetDigest: "e".repeat(64) }, { kind: "upgrade" }, { planFingerprint: "e".repeat(64) }, { policyDigest: "e".repeat(64) }, { boardDigest: "e".repeat(64) }];
    for (const change of mismatches) expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding: { ...binding, ...change }, plan })).ok).toBe(false);
    expect((await f.ordinary.request({ t: "recovery_authority", op: "issue", binding: { ...binding, peer: "claude" }, plan })).ok).toBe(false);
    expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false);
    expect(existsSync(join(f.stateDir, `conductor-recovery.${binding.operationId}.json`))).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

test("a minted recovery continuation refuses every mismatched binding without recovery effects", async () => {
  const f = await fixture();
  try {
    const { binding, plan } = await f.authority(); expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    for (const change of [{ operationId: crypto.randomUUID() }, { peer: "claude" }, { projectId: "foreign" }, { projectRoot: PACKAGE_ROOT }, { stateDir: f.root },
      { sourceInstanceId: crypto.randomUUID() }, { targetDigest: "e".repeat(64) }, { targetRoot: f.root }, { planFingerprint: "e".repeat(64) }, { policyDigest: "e".repeat(64) }, { boardDigest: "e".repeat(64) }]) {
      const candidate = { ...binding, ...change };
      expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: candidate })).ok).toBe(false);
      expect((await f.request(candidate, "prepare")).ok).toBe(false); f.noEffects();
    }
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(true);
  } finally { await f.close(); }
}, 20_000);

test("conductor revocation during captureResume awaits refuses prepare before holding or saving state", async () => {
  const f = await fixture(), entered = new Deferred(), release = new Deferred(); let blocked = false;
  try {
    const peer = await f.addCapture(async () => { if (blocked) { entered.resolve(); await release.promise; } });
    const { binding, plan } = await f.authority(); expect(peer.captures).toBe(1);
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    blocked = true;
    const pending = f.request(binding, "prepare");
    const reached = Promise.race([entered.promise, pending.then(() => { throw new Error("prepare returned before its capture fence"); })]);
    await reached; await f.revokeConductor(); release.resolve();
    const result = await pending; expect(result.ok).toBe(false); expect(String(result.error)).toContain("conductor");
    expect(peer.captures).toBe(2); f.noEffects();
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(false);
  } finally { release.resolve(); await f.close(); }
}, 20_000);

test("new private conductor context revokes a previously issued recovery proof without exposing task text", async () => {
  const f = await fixture(), board = new Board(join(f.stateDir, "hub.db"));
  try {
    const { binding, plan } = await f.authority(); expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    const task = board.propose("user", { title: "PRIVATE_RECOVERY_TITLE_CANARY", class: "plan", signals: ["pii_path"] });
    board.update(task.id, "user", "assigned", { owner: "codex" });
    for (const reply of [await f.lead.request({ t: "recovery_authority", op: "verify", binding }), await f.request(binding, "prepare")]) {
      expect(reply.ok).toBe(false); expect(JSON.stringify(reply)).not.toContain("PRIVATE_RECOVERY_TITLE_CANARY");
    }
    f.noEffects();
  } finally { board.close(); await f.close(); }
}, 20_000);

class SnapshotLocal extends BasePeer {
  constructor(readonly session: string, readonly stopping: Deferred, readonly releaseStop: Deferred) { super("local"); }
  async start() { this.setState("idle"); }
  async stop() { this.stopping.resolve(); await this.releaseStop.promise; this.clearWatchdog(); this.setState("offline"); }
  async deliver() { throw new Error("paused source fixture never delivers a native turn"); }
  recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "local", model: "saved-recovery-model" }, sessionId: this.session }; }
}

test("real source commit permits only its stopping verification and a replacement target restores only its own saved launch", async () => {
  const f = await fixture(), source = f.daemon, stopping = new Deferred(), releaseStop = new Deferred();
  const savedSession = crypto.randomUUID(), fake = new SnapshotLocal(savedSession, stopping, releaseStop);
  let target: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const targetClients: ControlClient[] = [], starts: Record<string, unknown>[] = [], modelCalls: string[] = [];
  const originalStart = LocalPeer.prototype.start;
  const start = spyOn(LocalPeer.prototype, "start").mockImplementation(function(this: LocalPeer) { starts.push(this.recoveryMetadata()); return originalStart.call(this); });
  const inventory = spyOn(OmniRoute.prototype, "models").mockImplementation(async () => { modelCalls.push("models"); throw new Error("recovery fixture must not query a gateway"); });
  const chat = spyOn(OmniRoute.prototype, "chat").mockImplementation(async () => { modelCalls.push("chat"); throw new Error("recovery fixture must not start a model turn"); });
  const oldOperation = process.env.AGENTHUB_RECOVERY_OPERATION;
  try {
    source.bus.add(fake); await fake.start();
    // Preserve a manual pause through the actual snapshot: this model-free leg may
    // restore its saved alias while provider availability remains deliberately unknown.
    expect((await f.person.request({ t: "pause", peer: "local" })).ok).toBe(true);
    const { binding, plan } = await f.authority();
    expect(plan.projects[0]!.source.peers.find(peer => peer.id === "local")).toMatchObject({ sessionId: savedSession });
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    expect((await f.lead.request({ t: "recovery_restore", peer: "local", authority: binding, model: "WIRE_MODEL_CANARY", sessionId: "WIRE_SESSION_CANARY" })).ok).toBe(false);
    expect(starts).toEqual([]); expect(modelCalls).toEqual([]);
    expect((await f.request(binding, "prepare")).ok).toBe(true);
    const committing = f.request(binding, "commit");
    const committed = await committing; expect(committed).toMatchObject({ ok: true, committed: true });
    await stopping.promise; // The old listener is still owned while its fake peer stop is held.
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(true);
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: { ...binding, operationId: crypto.randomUUID() } })).ok).toBe(false);
    expect((await f.lead.request({ t: "recovery_authority", op: "authorize", command: "restart" })).ok).toBe(false);
    releaseStop.resolve(); await source.stopped;
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(true);

    const targetInstance = crypto.randomUUID();
    process.env.AGENTHUB_RECOVERY_OPERATION = binding.operationId;
    try {
      target = await startDaemon({ cwd: f.root, stateDir: f.stateDir, projectId: f.project.id, instanceId: targetInstance,
        controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: loadConfig(f.root), snapshotClock: () => 0,
        configWatch: false, boundedTools: emulatedBoundedTools() });
    } finally {
      if (oldOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = oldOperation;
    }
    const connectTarget = async (peer?: string) => {
      const client = await ControlClient.connect(f.stateDir, { role: peer ? "tools" : "console", ...(peer ? { peer } : {}),
        projectRoot: f.root, projectId: f.project.id, instanceId: targetInstance }); targetClients.push(client); return client;
    };
    const lead = await connectTarget("codex"), ordinary = await connectTarget("claude"), person = await connectTarget();
    const targetStatus = (await person.request({ t: "status" })).status;
    expect(targetStatus.instanceId).toBe(targetInstance); expect(targetStatus.instanceId).not.toBe(binding.sourceInstanceId);
    expect(targetStatus.recovery).toMatchObject({ operationId: binding.operationId, phase: "restored" });
    expect((await lead.request({ t: "recovery_authority", op: "verify", binding })).ok).toBe(true);
    expect((await ordinary.request({ t: "recovery_restore", peer: "local", authority: binding })).ok).toBe(false);
    for (const authority of [undefined, { ...binding, sourceInstanceId: targetInstance }, { ...binding, operationId: crypto.randomUUID() }, { ...binding, targetDigest: "e".repeat(64) }]) {
      expect((await lead.request({ t: "recovery_restore", peer: "local", authority })).ok).toBe(false);
    }
    expect(starts).toEqual([]); expect(modelCalls).toEqual([]);
    const restored = await lead.request({ t: "recovery_restore", peer: "local", authority: binding,
      model: "WIRE_MODEL_CANARY", sessionId: "WIRE_SESSION_CANARY", args: { model: "WIRE_MODEL_CANARY", sessionId: "WIRE_SESSION_CANARY" }, launch: { model: "WIRE_MODEL_CANARY" } });
    expect(restored.ok).toBe(true); expect(starts).toHaveLength(1);
    expect(starts[0]!.launch).toMatchObject({ kind: "local", model: "saved-recovery-model" });
    expect(starts[0]!.sessionId).toMatch(/^agent-hub-local-[a-f0-9-]{36}$/);
    // Local intentionally rebuilds a fresh worker; this does not claim native
    // session persistence, only refusal to accept a wire-selected session.
    expect(starts[0]!.sessionId).not.toBe(savedSession); expect(starts[0]!.sessionId).not.toBe("WIRE_SESSION_CANARY");
    expect(JSON.stringify(starts)).not.toContain("WIRE_MODEL_CANARY"); expect(modelCalls).toEqual([]);
    expect(target.bus.peers.get("local")).toBeInstanceOf(LocalPeer);
    expect(target.bus.isPaused("local")).toBe(true);
  } finally {
    releaseStop.resolve();
    if (oldOperation === undefined) delete process.env.AGENTHUB_RECOVERY_OPERATION; else process.env.AGENTHUB_RECOVERY_OPERATION = oldOperation;
    for (const client of targetClients) client.close(); await target?.stop();
    start.mockRestore(); inventory.mockRestore(); chat.mockRestore(); await f.close();
  }
}, 20_000);

test("a source-issued grant cannot prepare an unrelated replacement daemon", async () => {
  const f = await fixture(); let replacement: Awaited<ReturnType<typeof startDaemon>> | undefined, lead: ControlClient | undefined;
  try {
    const { binding, plan } = await f.authority();
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    await f.daemon.stop(); await f.daemon.stopped;
    replacement = await startDaemon({ cwd: f.root, stateDir: f.stateDir, projectId: binding.projectId, instanceId: crypto.randomUUID(),
      controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: loadConfig(f.root), snapshotClock: () => 0, configWatch: false, boundedTools: emulatedBoundedTools() });
    lead = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex", projectRoot: f.root });
    expect((await lead.request({ t: "recovery", op: "prepare", operationId: binding.operationId, expectedInstanceId: lead.instanceId, authority: binding, targetFeatures: DAEMON_FEATURES })).ok).toBe(false);
    expect(replacement.bus.isRecoveryHeld).toBe(false);
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(false);
  } finally { lead?.close(); await replacement?.stop(); await f.close(); }
}, 20_000);
