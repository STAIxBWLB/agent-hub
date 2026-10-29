import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { ControlClient, DAEMON_FEATURES, PROTOCOL } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { captureRecoveryPolicy } from "../src/hub/recovery-policy.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import { planFingerprint, type Inspection, type RecoveryPeer, type UpgradePlan } from "../src/cli/upgrade.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { preserveSource } from "../src/cli/upgrade-runtime.ts";
import { VERSION } from "../src/version.ts";
import type { LocalPeer } from "../src/adapters/local-worker.ts";
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
    // Exercise the same immutable runtime as recovery. Shared test dependencies may
    // be symlinked; production runtime integrity must keep refusing those links.
    const sourceDigest = packageDigest(PACKAGE_ROOT);
    const runtimeRoot = preserveSource({ sourceRoot: PACKAGE_ROOT, sourceDigest } as UpgradePlan);
    const runtime = await import(join(runtimeRoot, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
    const runtimeLocal = await import(join(runtimeRoot, "src/adapters/local-worker.ts")) as typeof import("../src/adapters/local-worker.ts");
    const runtimeOmni = await import(join(runtimeRoot, "src/omniroute/client.ts")) as typeof import("../src/omniroute/client.ts");
    const registry = new Registry(), registered = registry.register(root, stateDir); registry.close();
    daemon = await runtime.startDaemon({ cwd: root, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
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
      const digest = packageDigest(runtimeRoot, { ownDependencies: true });
      const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: VERSION, sourceRoot: runtimeRoot, sourceDigest: digest,
        projects: [{ project, source, terminals: [], blockers: [] }], blockers: [] };
      const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "restart", projectId: project.id,
        projectRoot: root, stateDir, sourceInstanceId: project.instanceId, targetRoot: runtimeRoot, targetDigest: digest, planFingerprint: plan.fingerprint,
        ...captureRecoveryPolicy(project, "codex", loadConfig(root)) };
      return { binding, plan };
    };
    const request = (binding: ConductorRecoveryBinding, op: string, extra: Record<string, unknown> = {}) => lead.request({ t: "recovery", op,
      expectedInstanceId: project.instanceId, operationId: binding.operationId, authority: binding, targetFeatures: [...DAEMON_FEATURES], targetVersion: VERSION, ...extra });
    const addCapture = async (callback: () => Promise<void>) => { const peer = new CapturePeer(callback); daemon!.bus.add(peer); await peer.start(); return peer; };
    return { root, stateDir, daemon, person, lead, ordinary, project, authority, inspect, request, addCapture, runtimeRoot, runtimeStart: runtime.startDaemon, LocalPeer: runtimeLocal.LocalPeer, OmniRoute: runtimeOmni.OmniRoute,
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

test("source issuance refuses an unbound coordinator or invalid target version before creating a grant", async () => {
  const f = await fixture();
  try {
    const { binding, plan } = await f.authority();
    for (const change of [{ sourceDigest: "e".repeat(64) }, { version: "../outside-cache" }]) {
      const { fingerprint: ignored, ...original } = plan;
      const body = { ...original, ...change }, changed = { ...body, fingerprint: planFingerprint(body) };
      expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding: { ...binding, planFingerprint: changed.fingerprint }, plan: changed })).ok).toBe(false);
      expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false); f.noEffects();
    }
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
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
  const originalStart = f.LocalPeer.prototype.start;
  const start = spyOn(f.LocalPeer.prototype, "start").mockImplementation(function(this: LocalPeer) { starts.push(this.recoveryMetadata()); return originalStart.call(this); });
  const inventory = spyOn(f.OmniRoute.prototype, "models").mockImplementation(async () => { modelCalls.push("models"); throw new Error("recovery fixture must not query a gateway"); });
  const chat = spyOn(f.OmniRoute.prototype, "chat").mockImplementation(async () => { modelCalls.push("chat"); throw new Error("recovery fixture must not start a model turn"); });
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
      target = await f.runtimeStart({ cwd: f.root, stateDir: f.stateDir, projectId: f.project.id, instanceId: targetInstance,
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
    expect(target.bus.peers.get("local")).toBeInstanceOf(f.LocalPeer);
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
    replacement = await f.runtimeStart({ cwd: f.root, stateDir: f.stateDir, projectId: binding.projectId, instanceId: crypto.randomUUID(),
      controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: loadConfig(f.root), snapshotClock: () => 0, configWatch: false, boundedTools: emulatedBoundedTools() });
    lead = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex", projectRoot: f.root });
    expect((await lead.request({ t: "recovery", op: "prepare", operationId: binding.operationId, expectedInstanceId: lead.instanceId, authority: binding, targetFeatures: DAEMON_FEATURES })).ok).toBe(false);
    expect(replacement.bus.isRecoveryHeld).toBe(false);
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(false);
  } finally { lead?.close(); await replacement?.stop(); await f.close(); }
}, 20_000);

test("a source-issued continuation refuses changed plan data under an unchanged signed fingerprint", async () => {
  const f = await fixture();
  try {
    const { binding, plan } = await f.authority();
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    const operation: import("../src/cli/upgrade.ts").RecoveryOperation = { schema: 1, id: binding.operationId, plan,
      sourceRoot: f.runtimeRoot, targetRoot: f.runtimeRoot, targetDigest: binding.targetDigest, targetFeatures: DAEMON_FEATURES,
      createdAt: 1, updatedAt: 1, phase: "pending", step: "stage", projects: [{ id: binding.projectId, phase: "pending", terminals: {} }] };
    const { authorizeConductorOperation } = await import("../src/cli/conductor-recovery.ts");
    await authorizeConductorOperation(operation, "codex");
    plan.version = "0.0.0";
    await expect(authorizeConductorOperation(operation, "codex")).rejects.toThrow("conductor recovery authority unavailable");
    f.noEffects();
  } finally { await f.close(); }
}, 20_000);

test("shared upgrade issuance requires every live or uncertain registered project before creating a grant", async () => {
  const f = await fixture();
  const { Registry } = await import("../src/hub/registry.ts");
  const { processSignature } = await import("../src/pi/process-signature.ts");
  const registry = new Registry();
  try {
    expect(registry.register(f.root, f.stateDir).id).toBe(f.project.id); expect(registry.claim(f.project.id, f.project.instanceId, process.pid, processSignature(process.pid))).toBe(true);
    const otherRoot = join(f.root, "other-project"), otherState = join(otherRoot, ".agenthub", "state"); mkdirSync(otherState, { recursive: true });
    const other = registry.register(otherRoot, otherState), otherInstance = crypto.randomUUID();
    expect(other.id).not.toBe(f.project.id); expect(registry.claim(other.id, otherInstance, process.pid, processSignature(process.pid))).toBe(true);
    const { binding: original, plan: originalPlan } = await f.authority();
    const staged = join(process.env.AGENTHUB_HOME!, "releases", VERSION), targetRoot = join(staged, "node_modules", "@staix", "agent-hub");
    for (const directory of ["src/hub", "src/cli", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(targetRoot, directory), { recursive: true });
    writeFileSync(join(targetRoot, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: VERSION }));
    writeFileSync(join(targetRoot, "src/hub/control-client.ts"), 'export const DAEMON_FEATURES = ["conductor_recovery"];');
    writeFileSync(join(targetRoot, "src/cli/main.js"), 'throw new Error("fixture runtime must never execute");');
    writeFileSync(join(targetRoot, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: VERSION }));
    const targetDigest = packageDigest(targetRoot, { ownDependencies: true }), integrity = "fixture-registry-integrity";
    writeFileSync(join(staged, "verified.json"), JSON.stringify({ digest: targetDigest, integrity }));
    const { fingerprint: ignored, ...originalBody } = originalPlan;
    const body: Omit<UpgradePlan, "fingerprint"> = { ...originalBody, kind: "upgrade", integrity };
    let plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
    let binding: ConductorRecoveryBinding = { ...original, kind: "upgrade", targetRoot, targetDigest, planFingerprint: plan.fingerprint };
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(false);
    expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false); f.noEffects();
    body.projects = [...body.projects, { project: { ...other, instanceId: otherInstance, pid: process.pid }, source: { state: "running", instanceId: otherInstance, version: VERSION, protocol: PROTOCOL, peers: [], blockers: [] }, terminals: [], blockers: [] }];
    plan = { ...body, fingerprint: planFingerprint(body) }; binding = { ...binding, planFingerprint: plan.fingerprint };
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    const board = new Board(join(f.stateDir, "hub.db"));
    try { const row = board.propose("user", { title: "cancelled compatibility fixture", class: "plan" }); board.update(row.id, "user", "cancelled", { state: "cancelled" }); }
    finally { board.close(); }
    const refused = await f.request(binding, "prepare", { targetFeatures: DAEMON_FEATURES });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("target lacks task_cancel");
    f.noEffects();
  } finally { registry.close(); await f.close(); }
}, 20_000);

test("missing control metadata cannot bootstrap while the signed source claim is still live", async () => {
  const f = await fixture(), stopping = new Deferred(), releaseStop = new Deferred();
  const { Registry } = await import("../src/hub/registry.ts"), { processSignature } = await import("../src/pi/process-signature.ts");
  const registry = new Registry(), fake = new SnapshotLocal(crypto.randomUUID(), stopping, releaseStop);
  const token = join(f.stateDir, "control-token"), hidden = join(f.stateDir, "fixture-hidden-token");
  let tokenHidden = false;
  try {
    expect(registry.register(f.root, f.stateDir).id).toBe(f.project.id); expect(registry.claim(f.project.id, f.project.instanceId, process.pid, processSignature(process.pid))).toBe(true);
    f.daemon.bus.add(fake); await fake.start();
    expect((await f.person.request({ t: "pause", peer: "local" })).ok).toBe(true);
    const { binding, plan } = await f.authority();
    expect((await f.lead.request({ t: "recovery_authority", op: "issue", binding, plan })).ok).toBe(true);
    expect((await f.request(binding, "prepare")).ok).toBe(true);
    expect((await f.request(binding, "commit")).ok).toBe(true); await stopping.promise;
    const operation: import("../src/cli/upgrade.ts").RecoveryOperation = { schema: 1, id: binding.operationId, plan,
      sourceRoot: f.runtimeRoot, targetRoot: f.runtimeRoot, targetDigest: binding.targetDigest, targetFeatures: DAEMON_FEATURES,
      createdAt: 1, updatedAt: 1, phase: "running", step: "wait-source", projects: [{ id: binding.projectId, phase: "prepared", terminals: {} }] };
    renameSync(token, hidden); tokenHidden = true;
    const { authorizeConductorLaunch } = await import("../src/cli/conductor-recovery.ts");
    await expect(authorizeConductorLaunch(operation, "codex", f.root, f.runtimeRoot, "up", [])).rejects.toThrow("conductor recovery authority unavailable");
    expect(registry.get(f.project.id)?.instanceId).toBe(f.project.instanceId);
    expect(registry.get(f.project.id)?.pid).toBe(process.pid);
  } finally {
    if (tokenHidden && existsSync(hidden)) renameSync(hidden, token);
    releaseStop.resolve(); await f.daemon.stop(); registry.release(f.project.id, f.project.instanceId); registry.close(); await f.close();
  }
}, 20_000);

test("person recovery also preserves open conductor manual intent across target versions", async () => {
  const f = await fixture(), board = new Board(join(f.stateDir, "hub.db"));
  const id = crypto.randomUUID(), targetFeatures = DAEMON_FEATURES.filter(feature => feature !== "conductor_recovery");
  try {
    const row = board.propose("user", { title: "manual intent compatibility fixture", class: "plan" });
    board.update(row.id, "user", "assigned", { owner: "claude" });
    expect((await f.lead.request({ t: "task", op: "task_unassign", args: { id: row.id } })).ok).toBe(true);
    expect(board.hasConductorManualState()).toBe(true);
    const message = { t: "recovery", op: "prepare", expectedInstanceId: f.project.instanceId, operationId: id, targetFeatures };
    const refused = await f.person.request(message);
    expect(refused.ok).toBe(false); expect(refused.error).toContain("target lacks conductor_recovery"); f.noEffects();
    board.update(row.id, "user", "cancelled", { state: "cancelled" });
    expect(board.hasConductorManualState()).toBe(false);
    expect((await f.person.request(message)).ok).toBe(true);
    expect((await f.person.request({ ...message, op: "abort" })).ok).toBe(true); f.noEffects();
  } finally { board.close(); await f.close(); }
}, 20_000);
