import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { routingText } from "../src/hub/routing.ts";
import { ControlClient, DAEMON_FEATURES, PROTOCOL } from "../src/hub/control-client.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { Registry } from "../src/hub/registry.ts";
import { writeOperation } from "../src/hub/recovery-store.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { packageDigest, preserveRuntimeDependencies } from "../src/cli/recovery-package.ts";
import { preserveSource } from "../src/cli/upgrade-runtime.ts";
import { planFingerprint, type Inspection, type RecoveryOperation, type RecoveryPeer, type UpgradePlan } from "../src/cli/upgrade.ts";
import { VERSION } from "../src/version.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

async function versionFixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-recovery-version-"))), stateDir = join(root, ".agenthub", "state"), home = join(root, "home");
  const overrides = Object.keys(process.env).filter(key => key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_"));
  const keys = ["HOME", "PATH", "AGENTHUB_HOME", "AGENTHUB_PEER_ID", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "JCODE_HOME", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_RECOVERY_CONDUCTOR", "AGENTHUB_RECOVERY_CONTINUATION", ...overrides];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of [...overrides, "AGENTHUB_PEER_ID", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_RECOVERY_CONDUCTOR", "AGENTHUB_RECOVERY_CONTINUATION"]) delete process.env[key];
  Object.assign(process.env, { HOME: home, PATH: "/usr/bin:/bin", AGENTHUB_HOME: home, AMEM_HOME: join(home, "memory"), CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), JCODE_HOME: join(home, "jcode") });
  const file = join(root, ".agenthub", "config.local.json"), routingFile = join(root, ".agenthub", "routing.toml");
  let registry: Registry | undefined, source: Awaited<ReturnType<typeof import("../src/hub/daemon.ts")["startDaemon"]>> | undefined;
  let released: Promise<void> | undefined, target: typeof source;
  const clients: ControlClient[] = [];
  const close = async () => {
    for (const client of clients) client.close(); await target?.stop(); await source?.stop(); await released; registry?.close();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    mkdirSync(join(root, ".agenthub"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", root], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null" }, timeout: 2000 }).exitCode).toBe(0);
    const config = { roles: { codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex",
      permission_modes: { codex: "ask" }, protect_instruction_files: true, jcode_home: join(home, "jcode"), roster: { codex: true, local: false, pi: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], api_key_file: join(home, "no-gateway-key"), cf_client_id_file: join(home, "no-access-id"), cf_client_secret_file: join(home, "no-access-secret") }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { enabled: false, keep: 20 }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, batch_ms: 0 };
    const original = JSON.stringify(config); writeFileSync(file, original);
    const originalRouting = routingText(root); // No project routing file: the source resolves its shipped template.
    const rootPackage = realPath(resolve(import.meta.dir, "..")), sourceDigest = packageDigest(rootPackage);
    const runtimeRoot = preserveSource({ sourceRoot: rootPackage, sourceDigest } as UpgradePlan);
    const runtime = await import(join(runtimeRoot, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
    const sourcePolicy = await import(join(runtimeRoot, "src/hub/recovery-policy.ts")) as typeof import("../src/hub/recovery-policy.ts");
    const sourceInputs = sourcePolicy.readRecoveryPolicyInputs(root);
    expect(sourceInputs.routingFallback).toBe(originalRouting);
    const targetVersion = "99.0.0", stage = join(home, "releases", targetVersion), targetRoot = join(stage, "node_modules", "@staix", "agent-hub");
    mkdirSync(targetRoot, { recursive: true });
    // Copy only the runtime assets and exact first-party memory package, never a dependency tree.
    for (const name of ["src", "plugins", "templates", ".claude-plugin", "package.json", "README.md", "LICENSE", "CHANGELOG.md"])
      cpSync(join(runtimeRoot, name), join(targetRoot, name), { recursive: true, dereference: false });
    preserveRuntimeDependencies(runtimeRoot, stage);
    const replaceOne = (file: string, before: string, after: string) => {
      const text = readFileSync(file, "utf8"); expect(text.split(before)).toHaveLength(2); writeFileSync(file, text.replace(before, after));
    };
    replaceOne(join(targetRoot, "src/hub/daemon.ts"), "  batch_max: 3,", "  batch_max: 4,");
    replaceOne(join(targetRoot, "src/hub/hub-tools.ts"), "export const DEFAULT_ROLES: Record<string, string[]> = defaultPeerRoles(true);",
      'export const DEFAULT_ROLES: Record<string, string[]> = { ...defaultPeerRoles(true), qwen: ["reviewer"] };');
    replaceOne(join(targetRoot, "templates/routing.toml"), 'fixed_model = "coding"', 'fixed_model = "version-drift-model"');
    for (const file of [join(targetRoot, "package.json"), join(targetRoot, "plugins/agent-hub/.claude-plugin/plugin.json")]) {
      const manifest = JSON.parse(readFileSync(file, "utf8")); manifest.version = targetVersion; writeFileSync(file, JSON.stringify(manifest));
    }
    const targetDigest = packageDigest(targetRoot, { dependencyRoot: stage }), integrity = "sha512-test-owned-version-drift";
    expect(targetDigest).not.toBe(sourceDigest);
    writeFileSync(join(stage, "verified.json"), JSON.stringify({ digest: targetDigest, integrity }));
    const targetRuntime = await import(join(targetRoot, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
    expect(targetRuntime.DEFAULT_CONFIG.batch_max).toBe(4);
    expect(targetRuntime.DEFAULT_CONFIG.roles.qwen).toEqual(["reviewer"]);
    expect(targetRuntime.loadConfig(root).batch_max).not.toBe(runtime.loadConfig(root).batch_max);
    const targetRouting = await import(join(targetRoot, "src/hub/routing.ts")) as typeof import("../src/hub/routing.ts");
    expect(targetRouting.loadRouting(root).local.fixed_model).toBe("version-drift-model");
    expect(targetRouting.routingText(root)).not.toBe(originalRouting);

    registry = new Registry(); const registered = registry.register(root, stateDir);
    source = await runtime.startDaemon({ cwd: root, stateDir, projectId: registered.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: runtime.loadConfig(root), snapshotClock: () => 0, configWatch: false, agentDrift: false, boundedTools: emulatedBoundedTools() });
    const person = await ControlClient.connect(stateDir, { role: "console", projectRoot: root }); clients.push(person);
    const lead = await ControlClient.connect(stateDir, { role: "tools", peer: "codex", projectRoot: root }); clients.push(lead);
    const status = (await person.request({ t: "status" })).status;
    expect(registry.claim(registered.id, status.instanceId, process.pid, processSignature(process.pid))).toBe(true);
    released = source.stopped.then(() => { registry!.release(registered.id, status.instanceId); });
    const project = registry.get(registered.id)!;
    const input = async () => {
      const observed = await lead.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId }); expect(observed.ok).toBe(true);
      const inspection: Inspection = { state: "running", instanceId: status.instanceId, version: VERSION, protocol: PROTOCOL, peers: Object.values(observed.recovery.peers ?? {}) as RecoveryPeer[], blockers: [] };
      const digest = packageDigest(runtimeRoot, { ownDependencies: true });
      const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: targetVersion, integrity, sourceRoot: runtimeRoot, sourceDigest: digest,
        projects: [{ project, source: inspection, terminals: [], blockers: [] }], blockers: [] };
      const plan = { ...body, fingerprint: planFingerprint(body) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "upgrade", projectId: project.id,
        projectRoot: root, stateDir, sourceInstanceId: status.instanceId, targetRoot, targetDigest, planFingerprint: plan.fingerprint,
        ...sourcePolicy.captureRecoveryPolicy(project, "codex", runtime.loadConfig(root), sourceInputs) };
      return { binding, plan };
    };
    const request = (binding: ConductorRecoveryBinding, op: string) => lead.request({ t: "recovery", op, operationId: binding.operationId,
      expectedInstanceId: status.instanceId, authority: binding, targetVersion, targetFeatures: [...DAEMON_FEATURES] });
    const issue = (value: Awaited<ReturnType<typeof input>>) => lead.request({ t: "recovery_authority", op: "issue", ...value });
    return { root, stateDir, home, file, routingFile, originalRouting, original, config, source, person, lead, project, input, issue, request,
      runtime, targetRuntime, targetRoot, targetVersion,
      noEffects() { expect(source!.bus.isRecoveryHeld).toBe(false); expect(existsSync(join(stateDir, "restart.json"))).toBe(false); },
      async commit(value: Awaited<ReturnType<typeof input>>) {
        expect((await issue(value)).ok).toBe(true);
        const { binding, plan } = value, now = Date.now();
        const op: RecoveryOperation = { schema: 1, id: binding.operationId, plan, createdAt: now, updatedAt: now, phase: "pending", step: "stage", sourceRoot: runtimeRoot,
          targetRoot, targetDigest: binding.targetDigest, conductorRoutingDefaults: { [project.id]: sourceInputs.routingFallback! }, targetFeatures: [...DAEMON_FEATURES], delegatedAudits: [{ at: now, peer: "codex", command: "upgrade", operationId: binding.operationId }],
          projects: [{ id: project.id, phase: "pending", terminals: {} }] };
        writeOperation(op.id, op);
        expect((await request(binding, "prepare")).ok).toBe(true); expect((await request(binding, "commit")).committed).toBe(true);
        await source!.stopped; await released;
        op.phase = "running"; op.step = "start"; op.projects[0]!.phase = "stopped"; op.projects[0]!.instanceId = status.instanceId; writeOperation(op.id, op); return op;
      },
      async startTarget(binding: ConductorRecoveryBinding) {
        process.env.AGENTHUB_RECOVERY_OPERATION = binding.operationId; process.env.AGENTHUB_RECOVERY_CONDUCTOR = "codex"; process.env.AGENTHUB_RECOVERY_CONTINUATION = binding.operationId;
        try {
          target = await targetRuntime.startDaemon({ cwd: root, stateDir, projectId: project.id, instanceId: crypto.randomUUID(), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
            snapshotClock: () => 0, configWatch: false, agentDrift: false, boundedTools: emulatedBoundedTools() });
          return target;
        } finally {
          delete process.env.AGENTHUB_RECOVERY_OPERATION; delete process.env.AGENTHUB_RECOVERY_CONDUCTOR; delete process.env.AGENTHUB_RECOVERY_CONTINUATION;
        }
      }, close };
  } catch (error) { await close(); throw error; }
}


test("conductor upgrade accepts identical project inputs across target default config, roles and template drift", async () => {
  const f = await versionFixture();
  try {
    expect(existsSync(f.routingFile)).toBe(false);
    const rawConfig = readFileSync(f.file, "utf8"), value = await f.input();
    const operation = await f.commit(value);
    // The public fallback map is advisory; only the source-HMAC-bound bytes authorize bootstrap.
    const fallback = operation.conductorRoutingDefaults![f.project.id]!;
    const tampered = fallback.replace('fixed_model = "coding"', 'fixed_model = "tampered-public-model"'); expect(tampered).not.toBe(fallback);
    writeOperation(operation.id, { ...operation, conductorRoutingDefaults: { [f.project.id]: tampered } });
    await expect(f.startTarget(value.binding)).rejects.toThrow();
    writeOperation(operation.id, operation);
    expect(readFileSync(f.file, "utf8")).toBe(rawConfig);
    const target = await f.startTarget(value.binding);
    const person = await ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root });
    const lead = await ControlClient.connect(f.stateDir, { role: "tools", peer: "codex", projectRoot: f.root });
    try {
      const status = (await person.request({ t: "status" })).status;
      expect(status.instanceId).not.toBe(value.binding.sourceInstanceId);
      expect(status.recovery).toMatchObject({ operationId: value.binding.operationId, phase: "restored" });
      expect(target.bus.isRecoveryHeld).toBe(true);
      // A real target retains the actor rather than accepting an arbitrary wire identity.
      expect((await lead.request({ t: "recovery", op: "inspect", expectedInstanceId: status.instanceId })).ok).toBe(true);
      expect(status.version).toBe(f.targetVersion);
      expect((await lead.request({ t: "recovery_authority", op: "verify", binding: value.binding })).ok).toBe(true);
      expect(f.targetRuntime.loadConfig(f.root).roles.codex).toEqual(["conductor", "planner"]);
      expect(readFileSync(f.file, "utf8")).toBe(rawConfig);
      expect(existsSync(f.routingFile)).toBe(false);
    } finally { lead.close(); person.close(); }
  } finally { await f.close(); }
}, 20_000);
