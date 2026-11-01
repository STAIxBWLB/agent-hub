import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { packageDigest, preserveRuntimePackage, stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import { planFingerprint, type Inspection, type PlannedProject, type RecoveryPeer, type UpgradePlan } from "../src/cli/upgrade.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { VERSION } from "../src/version.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

test("scoped conductor upgrade grants only registered A while B runs; malformed scopes and legacy omission refuse", async () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-conductor-scope-"))), home = join(base, "home"); mkdirSync(home);
  const keys = ["HOME", "PATH", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "JCODE_HOME", "AGENTHUB_PEER_ID"];
  const gateway = Object.keys(process.env).filter(key => key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_")); keys.push(...gateway);
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of [...gateway, "AGENTHUB_PEER_ID"]) delete process.env[key];
  Object.assign(process.env, { HOME: home, PATH: "/usr/bin:/bin", AGENTHUB_HOME: home, AMEM_HOME: join(home, "memory"), CLAUDE_CONFIG_DIR: join(home, "claude"),
    CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), JCODE_HOME: join(home, "jcode") });
  const daemons: Awaited<ReturnType<typeof import("../src/hub/daemon.ts")["startDaemon"]>>[] = [], clients: ControlClient[] = [];
  let registry: Registry | undefined;
  try {
    // Actual immutable runtime bytes and a synthetic host registry receipt; no package installation or native/model call.
    const target = stageCurrentRuntime(realPath(resolve(import.meta.dir, "..")), VERSION, home), integrity = "sha512-scoped-grant-fixture";
    const registryChild = join(home, "releases", VERSION, "registry"); mkdirSync(registryChild);
    writeFileSync(join(registryChild, "verified.json"), JSON.stringify({ integrity, digest: target.digest }), { mode: 0o600 });
    const runtime = await import(join(target.root, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
    const policy = await import(join(target.root, "src/hub/recovery-policy.ts")) as typeof import("../src/hub/recovery-policy.ts");
    registry = new Registry();
    const projects: { project: Project; plan: PlannedProject; person: ControlClient; stateDir: string }[] = [];
    for (const name of ["a", "b"]) {
      const root = join(base, `project-${name}`); mkdirSync(root); const canonical = realPath(root), stateDir = join(canonical, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
      expect(Bun.spawnSync(["git", "init", "-q", canonical], { env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 2000 }).exitCode).toBe(0);
      const config = { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex", jcode_home: join(home, "jcode"),
        roster: { codex: true, claude: false, kimi: false, pi: false, local: false, qwen: false, jcode: false, agy: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
        omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], api_key_file: join(home, "no-gateway"), cf_client_id_file: join(home, "no-access-id"), cf_client_secret_file: join(home, "no-access-secret") },
        pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, tasks: { ...DEFAULT_CONFIG.tasks, auto_pull: false }, research: { enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, batch_ms: 0 };
      writeFileSync(join(canonical, ".agenthub/config.local.json"), JSON.stringify(config), { mode: 0o600 });
      const registered = registry.register(canonical, stateDir);
      const daemon = await runtime.startDaemon({ cwd: canonical, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
        config: runtime.loadConfig(canonical), snapshotClock: () => 0, configWatch: false, agentDrift: false, boundedTools: emulatedBoundedTools() }); daemons.push(daemon);
      const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: canonical }); clients.push(person);
      const status = (await person.request({ t: "status" })).status;
      expect(registry.claim(registered.id, status.instanceId, process.pid, processSignature(process.pid))).toBe(true);
      const project = registry.get(registered.id)!;
      const observed = await person.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId }); expect(observed.ok).toBe(true);
      const source: Inspection = { state: "running", instanceId: status.instanceId, version: VERSION, protocol: status.protocolMax,
        protocolMin: status.protocolMin, protocolMax: status.protocolMax, peers: Object.values(observed.recovery.peers) as RecoveryPeer[], blockers: [] };
      projects.push({ project, person, stateDir, plan: { project, source, terminals: [], blockers: [] } });
    }
    const a = projects[0]!, b = projects[1]!, lead = await ControlClient.connect(a.stateDir, { role: "tools", peer: "codex", projectRoot: a.project.root }); clients.push(lead);
    const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, scope: { projectRoot: a.project.root }, kind: "upgrade", version: VERSION, integrity,
      sourceRoot: target.root, sourceDigest: target.digest, projects: [a.plan], blockers: [] };
    const issue = async (candidate: Omit<UpgradePlan, "fingerprint">, targetRoot = target.root) => {
      const plan: UpgradePlan = { ...candidate, fingerprint: planFingerprint(candidate) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "upgrade", projectId: a.project.id,
        projectRoot: a.project.root, stateDir: a.stateDir, sourceInstanceId: a.project.instanceId!, targetRoot, targetDigest: packageDigest(targetRoot, { ownDependencies: true }),
        planFingerprint: plan.fingerprint, ...policy.captureRecoveryPolicy(a.project, "codex", runtime.loadConfig(a.project.root)) };
      return { binding, reply: await lead.request({ t: "recovery_authority", op: "issue", binding, plan }) };
    };
    const { scope: _scope, ...legacy } = body;
    const invalid: Omit<UpgradePlan, "fingerprint">[] = [
      { ...body, scope: { projectRoot: b.project.root } }, { ...body, scope: { projectRoot: "relative-root" } },
      { ...body, scope: { projectRoot: a.project.root, extra: true } as UpgradePlan["scope"] },
      { ...body, scope: null as unknown as UpgradePlan["scope"] }, { ...body, projects: [a.plan, b.plan] },
      { ...body, scope: { projectRoot: b.project.root }, projects: [b.plan] },
    ];
    for (const plan of invalid) {
      expect((await issue(plan)).reply.ok).toBe(false);
      expect(existsSync(join(a.stateDir, "conductor-recovery.key"))).toBe(false);
      expect(daemons.every(daemon => !daemon.bus.isRecoveryHeld)).toBe(true);
    }
    // Keep the legacy omission refusal independent of the new captured-target path rule.
    const legacyRoot = join(home, "releases", VERSION, "node_modules/@staix/agent-hub"); mkdirSync(dirname(legacyRoot), { recursive: true });
    preserveRuntimePackage(target.root, legacyRoot, target.digest);
    writeFileSync(join(home, "releases", VERSION, "verified.json"), JSON.stringify({ integrity, digest: target.digest }), { mode: 0o600 });
    expect((await issue(legacy, legacyRoot)).reply.ok).toBe(false); expect(existsSync(join(a.stateDir, "conductor-recovery.key"))).toBe(false);
    const grant = await issue(body); expect(grant.reply.ok).toBe(true);
    const granted = grant.binding;
    expect(existsSync(join(a.stateDir, "conductor-recovery.key"))).toBe(true); expect(existsSync(join(b.stateDir, "conductor-recovery.key"))).toBe(false);
    rmSync(registryChild, { recursive: true });
    expect((await lead.request({ t: "recovery_authority", op: "verify", binding: granted })).ok).toBe(true);
    expect((await issue(body)).reply.ok).toBe(false); // a new grant needs its registry-child proof restored, even though an old legacy receipt remains
    expect((await b.person.request({ t: "status" })).status.instanceId).toBe(b.project.instanceId);
    expect(daemons.every(daemon => !daemon.bus.isRecoveryHeld)).toBe(true);
    for (const row of projects) expect(existsSync(join(row.stateDir, "restart.json"))).toBe(false);
  } finally {
    try { for (const client of clients) client.close(); for (const daemon of daemons.reverse()) await daemon.stop(); registry?.close(); }
    finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(base, { recursive: true, force: true }); }
  }
}, 20_000);
