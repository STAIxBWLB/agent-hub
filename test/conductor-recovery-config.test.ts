import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { routingText } from "../src/hub/routing.ts";
import { ControlClient, DAEMON_FEATURES, PROTOCOL } from "../src/hub/control-client.ts";
import { captureRecoveryPolicy } from "../src/hub/recovery-policy.ts";
import type { ConductorRecoveryBinding } from "../src/hub/recovery-authority.ts";
import { Registry } from "../src/hub/registry.ts";
import { writeOperation } from "../src/hub/recovery-store.ts";
import { realPath } from "../src/hub/project.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { preserveSource } from "../src/cli/upgrade-runtime.ts";
import { planFingerprint, type Inspection, type RecoveryOperation, type RecoveryPeer, type UpgradePlan } from "../src/cli/upgrade.ts";
import { VERSION } from "../src/version.ts";
import { emulatedBoundedTools } from "./fakes/bounded-capabilities.ts";

async function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-recovery-config-"))), stateDir = join(root, ".agenthub", "state"), home = join(root, "home");
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
    const config = { roles: { ...DEFAULT_CONFIG.roles, codex: ["conductor", "planner"], claude: ["implementer"] }, planner: "codex",
      permission_modes: { codex: "ask" }, protect_instruction_files: true, jcode_home: join(home, "jcode"), roster: { codex: true, local: false, pi: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [], api_key_file: join(home, "no-gateway-key"), cf_client_id_file: join(home, "no-access-id"), cf_client_secret_file: join(home, "no-access-secret") }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { enabled: false, keep: 20 }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, batch_ms: 0 };
    const original = JSON.stringify(config); writeFileSync(file, original);
    const originalRouting = routingText(root).replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'); writeFileSync(routingFile, originalRouting);
    const rootPackage = realPath(resolve(import.meta.dir, "..")), sourceDigest = packageDigest(rootPackage);
    const runtimeRoot = preserveSource({ sourceRoot: rootPackage, sourceDigest } as UpgradePlan);
    const runtime = await import(join(runtimeRoot, "src/hub/daemon.ts")) as typeof import("../src/hub/daemon.ts");
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
      const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: VERSION, sourceRoot: runtimeRoot, sourceDigest: digest,
        projects: [{ project, source: inspection, terminals: [], blockers: [] }], blockers: [] };
      const plan = { ...body, fingerprint: planFingerprint(body) };
      const binding: ConductorRecoveryBinding = { schema: 1, operationId: crypto.randomUUID(), peer: "codex", kind: "restart", projectId: project.id,
        projectRoot: root, stateDir, sourceInstanceId: status.instanceId, targetRoot: runtimeRoot, targetDigest: digest, planFingerprint: plan.fingerprint,
        ...captureRecoveryPolicy(project, "codex", runtime.loadConfig(root)) };
      return { binding, plan };
    };
    const request = (binding: ConductorRecoveryBinding, op: string) => lead.request({ t: "recovery", op, operationId: binding.operationId,
      expectedInstanceId: status.instanceId, authority: binding, targetVersion: VERSION, targetFeatures: [...DAEMON_FEATURES] });
    const issue = (value: Awaited<ReturnType<typeof input>>) => lead.request({ t: "recovery_authority", op: "issue", ...value });
    return { root, stateDir, home, file, routingFile, originalRouting, original, config, source, person, lead, project, input, issue, request,
      noEffects() { expect(source!.bus.isRecoveryHeld).toBe(false); expect(existsSync(join(stateDir, "restart.json"))).toBe(false); },
      async commit(value: Awaited<ReturnType<typeof input>>) {
        expect((await issue(value)).ok).toBe(true);
        const { binding, plan } = value, now = Date.now();
        const op: RecoveryOperation = { schema: 1, id: binding.operationId, plan, createdAt: now, updatedAt: now, phase: "pending", step: "stage", sourceRoot: runtimeRoot,
          targetRoot: runtimeRoot, targetDigest: binding.targetDigest, targetFeatures: [...DAEMON_FEATURES], delegatedAudits: [{ at: now, peer: "codex", command: "restart", operationId: binding.operationId }],
          projects: [{ id: project.id, phase: "pending", terminals: {} }] };
        writeOperation(op.id, op);
        expect((await request(binding, "prepare")).ok).toBe(true); expect((await request(binding, "commit")).committed).toBe(true);
        await source!.stopped; await released;
        op.phase = "running"; op.step = "start"; op.projects[0]!.phase = "stopped"; op.projects[0]!.instanceId = status.instanceId; writeOperation(op.id, op);
      },
      async startTarget(binding: ConductorRecoveryBinding) {
        process.env.AGENTHUB_RECOVERY_OPERATION = binding.operationId; process.env.AGENTHUB_RECOVERY_CONDUCTOR = "codex"; process.env.AGENTHUB_RECOVERY_CONTINUATION = binding.operationId;
        try {
          target = await runtime.startDaemon({ cwd: root, stateDir, projectId: project.id, instanceId: crypto.randomUUID(), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
            snapshotClock: () => 0, configWatch: false, agentDrift: false, boundedTools: emulatedBoundedTools() });
          return target;
        } finally {
          delete process.env.AGENTHUB_RECOVERY_OPERATION; delete process.env.AGENTHUB_RECOVERY_CONDUCTOR; delete process.env.AGENTHUB_RECOVERY_CONTINUATION;
        }
      }, close };
  } catch (error) { await close(); throw error; }
}

for (const kind of ["permission", "instructions"] as const) test(`pending protected ${kind} config cannot mint or use source recovery authority`, async () => {
  const f = await fixture();
  try {
    const before = await f.input();
    const pending = kind === "permission" ? { ...f.config, permission_modes: { codex: "never-ask" } } : { ...f.config, protect_instruction_files: false };
    writeFileSync(f.file, JSON.stringify(pending));
    for (const reply of [await f.lead.request({ t: "recovery_authority", op: "authorize", command: "restart" }), await f.issue(before),
      await f.lead.request({ t: "recovery_authority", op: "verify", binding: before.binding }), await f.request(before.binding, "prepare")]) expect(reply.ok).toBe(false);
    f.noEffects(); expect(existsSync(join(f.stateDir, "conductor-recovery.key"))).toBe(false);
    writeFileSync(f.file, f.original); expect((await f.person.request({ t: "settings_reload" })).ok).toBe(true);
    const accepted = await f.person.request({ t: "settings_set", key: "snapshots.enabled", value: true });
    expect(accepted.ok).toBe(true);
    const after = await f.input(); expect((await f.issue(after)).ok).toBe(true);
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: after.binding })).ok).toBe(true);
    // A valid private grant must not authorize a second, unpublished file edit.
    const acceptedConfig = { ...f.config, snapshots: { ...f.config.snapshots, enabled: true } };
    writeFileSync(f.file, JSON.stringify(kind === "permission" ? { ...acceptedConfig, permission_modes: { codex: "never-ask" } } : { ...acceptedConfig, protect_instruction_files: false }));
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: after.binding })).ok).toBe(false);
    expect((await f.request(after.binding, "prepare")).ok).toBe(false); f.noEffects();
  } finally { await f.close(); }
}, 20_000);

for (const kind of ["permission", "module"] as const) test(`conductor target startup rejects pending ${kind} config before importing code`, async () => {
  const f = await fixture();
  try {
    const value = await f.input(); await f.commit(value);
    const imported = join(f.root, "module-imported"), factory = join(f.root, "module-factory");
    if (kind === "permission") writeFileSync(f.file, JSON.stringify({ ...f.config, permission_modes: { codex: "never-ask" } }));
    else {
      const source = `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(imported)},"imported");export const definition={api:1,kind:"guard-fixture",family:"guard-fixture",displayName:"Guard fixture",transport:"acp",roles:["implementer"],optional:true,defaultOnRoster:false,trust:{onPrem:false,hubSandboxed:false},identity:{mcp:"acp-session"},permission:{unmanaged:"fixture unmanaged"},start:{forms:["headless"],defaultForm:"headless",daemonPort:"acp",conductorStartable:true,hubSwitches:[],ownedFlags:[],launch:ctx=>({cmd:"never-executed",args:[],metadata:{packageEntrypoint:ctx.entrypoint,argv:[],command:"guard-fixture",env:{}}}),create:()=>{writeFileSync(${JSON.stringify(factory)},"factory");throw new Error("factory must not start")}},session:{idField:"sessionId",currentId:()=>undefined},turnEnd:"adapter",cli:{command:"guard-fixture",startWords:()=>["guard-fixture"]},display:{palette:{fg:"white",bg:"black"}}};`;
      mkdirSync(join(f.root, ".agenthub", "adapters"), { recursive: true }); writeFileSync(join(f.root, ".agenthub", "adapters", "guard.mjs"), source, { mode: 0o600 });
      writeFileSync(f.file, JSON.stringify({ ...f.config, adapter_modules: [{ path: ".agenthub/adapters/guard.mjs", sha256: createHash("sha256").update(source).digest("hex") }] }));
    }
    await expect(f.startTarget(value.binding)).rejects.toThrow();
    expect(existsSync(imported)).toBe(false); expect(existsSync(factory)).toBe(false);
    // Exact source bytes plus the same authentic grant/snapshot remain usable.
    writeFileSync(f.file, f.original);
    const target = await f.startTarget(value.binding);
    const person = await ControlClient.connect(f.stateDir, { role: "console", projectRoot: f.root });
    try { expect((await person.request({ t: "status" })).status.recovery).toMatchObject({ operationId: value.binding.operationId, phase: "restored" }); }
    finally { person.close(); }
    expect(target.bus.isRecoveryHeld).toBe(true); expect(existsSync(imported)).toBe(false); expect(existsSync(factory)).toBe(false);
  } finally { await f.close(); }
}, 20_000);

test("pending routing cannot replace the source's accepted runtime routing under an existing grant", async () => {
  const f = await fixture();
  try {
    const value = await f.input(); expect((await f.issue(value)).ok).toBe(true);
    const pending = f.originalRouting.replace('fixed_model = "coding"', 'fixed_model = "pending-model"'); expect(pending).not.toBe(f.originalRouting);
    writeFileSync(f.routingFile, pending);
    expect((await f.lead.request({ t: "recovery_authority", op: "authorize", command: "restart" })).ok).toBe(false);
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: value.binding })).ok).toBe(false);
    expect((await f.request(value.binding, "prepare")).ok).toBe(false); f.noEffects();
    writeFileSync(f.routingFile, f.originalRouting); expect((await f.person.request({ t: "settings_reload" })).ok).toBe(true);
    expect((await f.lead.request({ t: "recovery_authority", op: "verify", binding: value.binding })).ok).toBe(true); f.noEffects();
  } finally { await f.close(); }
}, 20_000);
