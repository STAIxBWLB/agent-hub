import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { Registry } from "../src/hub/registry.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { preserveSource } from "../src/cli/upgrade-runtime.ts";
import { planFingerprint, type UpgradePlan } from "../src/cli/upgrade.ts";
import { VERSION } from "../src/version.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

async function reconnectFixture(includeOrdinary = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-reconnect-"))), stateDir = join(root, ".agenthub", "state"), home = join(root, "home");
  const overrides = Object.keys(process.env).filter(key => key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_"));
  const keys = ["HOME", "PATH", "AGENTHUB_HOME", "AGENTHUB_PEER_ID", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "JCODE_HOME", ...overrides];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of [...overrides, "AGENTHUB_PEER_ID"]) delete process.env[key];
  Object.assign(process.env, { HOME: home, PATH: "/usr/bin:/bin", AGENTHUB_HOME: home, AMEM_HOME: join(home, "memory"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), JCODE_HOME: join(home, "jcode") });
  let registry: Registry | undefined, daemon: Awaited<ReturnType<typeof import("../src/hub/daemon.ts")["startDaemon"]>> | undefined;
  const clients: ControlClient[] = [];
  const close = async () => {
    for (const client of clients) client.close(); await daemon?.stop(); registry?.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(root, ".agenthub"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", root], { env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 2000 }).exitCode).toBe(0);
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({
      roles: { codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex", jcode_home: join(home, "jcode"),
      roster: { codex: true, claude: true, local: false, pi: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], api_key_file: join(home, "no-gateway-key"), cf_client_id_file: join(home, "no-access-id"), cf_client_secret_file: join(home, "no-access-secret") },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { enabled: false, keep: 20 }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, batch_ms: 0,
    }));
    const packageRoot = realPath(resolve(import.meta.dir, "..")), sourceDigest = packageDigest(packageRoot);
    const runtimeRoot = preserveSource({ sourceRoot: packageRoot, sourceDigest } as UpgradePlan);
    const runtime = await import(join(runtimeRoot, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
    const runtimeUpgrade = await import(join(runtimeRoot, "src/cli/upgrade-runtime.ts")) as typeof import("../src/cli/upgrade-runtime.ts");
    const policy = await import(join(runtimeRoot, "src/hub/recovery-policy.ts")) as typeof import("../src/hub/recovery-policy.ts");
    registry = new Registry(); const registered = registry.register(root, stateDir);
    daemon = await runtime.startDaemon({ cwd: root, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: runtime.loadConfig(root), snapshotClock: () => 0, configWatch: false, agentDrift: false, boundedTools: emulatedBoundedTools() });
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(person);
    const lead = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root }); clients.push(lead);
    const status = (await person.request({ t: "status" })).status;
    expect(registry.claim(registered.id, status.instanceId, process.pid, processSignature(process.pid))).toBe(true);
    const project = registry.get(registered.id)!;
    const claude = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: root }); clients.push(claude);
    if (includeOrdinary) {
      const { BasePeer } = await import(join(runtimeRoot, "src/hub/peers.ts")) as typeof import("../src/hub/peers.ts");
      class OrdinaryLocal extends BasePeer {
        constructor() { super("local"); }
        async start() { this.setState("idle"); }
        async stop() { this.clearWatchdog(); this.setState("offline"); }
        async deliver() { throw new Error("ordinary recovery fixture never delivers model work"); }
        recoveryMetadata(): Record<string, unknown> { return { sessionId: "ordinary-local-session", launch: { kind: "local", model: "fixture-model" } }; }
      }
      const ordinary = new OrdinaryLocal(); daemon.bus.add(ordinary); await ordinary.start();
    }
    const sessionId = "observed-unmanaged-session", launchId = "observed-ended-launch";
    writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: status.instanceId, sessionId }), { mode: 0o600 });
    const terminalCalls: string[][] = [];
    const plan = await runtimeUpgrade.makeUpgradePlan("restart", VERSION, root, async argv => {
      terminalCalls.push(argv); throw new Error("an unmanaged reconnect must not inspect a terminal");
    }, "codex");
    expect(plan.blockers).toEqual([]); expect(plan.projects).toHaveLength(1);
    expect(plan.projects[0]!.blockers).toEqual([]); expect(plan.projects[0]!.terminals).toEqual([]);
    expect(plan.projects[0]!.reconnectOnly).toContain("claude"); expect(terminalCalls).toEqual([]);
    const authority = (candidate: UpgradePlan) => {
      const { fingerprint: _oldFingerprint, ...body } = candidate;
      const sealedPlan = { ...body, fingerprint: planFingerprint(body) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "restart", projectId: project.id,
        projectRoot: root, stateDir, sourceInstanceId: status.instanceId, targetRoot: runtimeRoot, targetDigest: packageDigest(runtimeRoot, { ownDependencies: true }), planFingerprint: sealedPlan.fingerprint,
        ...policy.captureRecoveryPolicy(project, "codex", runtime.loadConfig(root)) };
      return { binding, plan: sealedPlan };
    };
    const issue = (candidate: UpgradePlan) => lead.request({ t: "recovery_authority", op: "issue", ...authority(candidate) });
    const noEffects = () => { expect(daemon!.bus.isRecoveryHeld).toBe(false); expect(existsSync(join(stateDir, "restart.json"))).toBe(false); };
    const launchRecord = (live: boolean) => writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([live
      ? { peer: "claude", projectRoot: root, stateDir, instanceId: status.instanceId, launcherPid: process.pid, launcherSignature: processSignature(process.pid), launchId,
          handle: "fixture-terminal", incarnationId: "fixture-incarnation", worktreeId: "fixture-worktree", env: {} }
      : { peer: "claude", projectRoot: root, instanceId: status.instanceId, launcherPid: "unreadable" }]), { mode: 0o600 });
    const managed = async () => {
      const managedId = "current-managed-attachment";
      writeFileSync(join(stateDir, "claude-launch.json"), JSON.stringify({ instanceId: status.instanceId, launchId: managedId }), { mode: 0o600 });
      const replacement = await ControlClient.connect(stateDir, { role: "peer", peer: "claude", channel: true, projectRoot: root, launchId: managedId }); clients.push(replacement);
      expect((daemon!.bus.peers.get("claude") as { managedLaunchId?: string }).managedLaunchId).toBe(managedId);
      const current = await runtimeUpgrade.inspectRecovery(project, undefined, undefined, "codex");
      return current.peers.find(peer => peer.id === "claude")!.observation;
    };
    return { root, stateDir, daemon, person, plan, issue, noEffects, sessionId, claude, launchRecord, managed, close };
  } catch (error) { await close(); throw error; }
}

test("a real unmanaged reconnect-only plan retains source observation and issues authority without restoration identity", async () => {
  const f = await reconnectFixture();
  try {
    const row = f.plan.projects[0]!.source.peers.find(peer => peer.id === "claude")!;
    expect(Object.keys(row).sort()).toEqual(["id", "observation", "state"]);
    expect(row.observation).toEqual({ kind: "claude", attached: true, sessionId: f.sessionId });
    expect(row.sessionId).toBeUndefined(); expect(row.threadId).toBeUndefined(); expect(row.args).toBeUndefined();
    expect((await f.issue(f.plan)).ok).toBe(true); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

for (const mutation of ["id", "kind", "attachment", "observed-session", "restore-session", "restore-args", "restore-thread", "terminal"] as const)
  test(`reconnect-only source authority refuses changed ${mutation} after a fresh plan fingerprint`, async () => {
    const f = await reconnectFixture();
    try {
      const plan = structuredClone(f.plan), row = plan.projects[0]!.source.peers.find(peer => peer.id === "claude")!;
      if (mutation === "id") row.id = "foreign-peer";
      if (mutation === "kind") row.observation = { ...row.observation!, kind: "codex" };
      if (mutation === "attachment") row.observation = { ...row.observation!, attached: false };
      if (mutation === "observed-session") row.observation = { ...row.observation!, sessionId: "foreign-session" };
      if (mutation === "restore-session") row.sessionId = f.sessionId;
      if (mutation === "restore-args") row.args = { model: "foreign-model" };
      if (mutation === "restore-thread") row.threadId = "foreign-thread";
      if (mutation === "terminal") plan.projects[0]!.terminals.push({ peer: "claude" } as never);
      expect((await f.issue(plan)).ok).toBe(false); f.noEffects();
    } finally { await f.close(); }
  }, 20_000);

for (const launcher of ["live", "unknown"] as const) test(`a reconnect-only plan is refused when its host launcher becomes ${launcher}`, async () => {
  const f = await reconnectFixture();
  try {
    f.launchRecord(launcher === "live");
    expect((await f.issue(f.plan)).ok).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

test("reconnect-only source observation refuses after the attached socket closes", async () => {
  const f = await reconnectFixture();
  try {
    f.claude.close();
    // Bounded protocol progress, not a wall-clock delay or a replacement authority assumption.
    for (let reads = 0; reads < 20 && (f.daemon.bus.peers.get("claude") as { attached?: boolean }).attached; reads++) await f.person.request({ t: "status" });
    expect((f.daemon.bus.peers.get("claude") as { attached?: boolean }).attached).toBe(false);
    expect((await f.issue(f.plan)).ok).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);


test("a reconnect-only plan cannot waive a current managed socket attachment", async () => {
  const f = await reconnectFixture();
  try {
    const observation = await f.managed(), plan = structuredClone(f.plan);
    plan.projects[0]!.source.peers.find(peer => peer.id === "claude")!.observation = observation;
    expect((await f.issue(plan)).ok).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

test("reconnect-only handling does not relax another peer's native identity comparison", async () => {
  const f = await reconnectFixture(true);
  try {
    const plan = structuredClone(f.plan), ordinary = plan.projects[0]!.source.peers.find(peer => peer.id === "local");
    expect(ordinary).toBeDefined(); expect(ordinary!.sessionId).toBe("ordinary-local-session");
    expect((await f.issue(f.plan)).ok).toBe(true); f.noEffects();
    ordinary!.sessionId = "foreign-ordinary-session";
    expect((await f.issue(plan)).ok).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);
