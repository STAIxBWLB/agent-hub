import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { operationPath } from "../src/hub/recovery-store.ts";
import { planFingerprint, type UpgradePlan, type RecoveryOperation } from "../src/cli/upgrade.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const FEATURE = "conductor_recovery";
const FEATURES = [...DAEMON_FEATURES.filter(feature => feature !== FEATURE), FEATURE];
const REFUSAL = "conductor recovery authority unavailable; the person runs it in ahub console or a terminal";
interface Message { t: string; rid?: number; op?: string; role?: string; peer?: string; command?: string; projectId?: string; projectRoot?: string; instanceId?: string }
function projectFixture(id: string, options: { deny?: boolean; descriptorFeature?: boolean; welcomeFeature?: boolean; welcomeInstance?: string; authorizeInstance?: string } = {}) {
  const root = realPath(mkdtempSync(join(tmpdir(), `ahub-conductor-recovery-${id}-`))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true }); writeFileSync(join(root, ".agenthub", "config.json"), "{}");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const instanceId = `instance-${id}`, messages: Message[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, server) => server.upgrade(request) ? undefined : new Response("fixture"), websocket: {
    message(socket, raw) {
      const message = JSON.parse(String(raw)) as Message; messages.push(message);
      const reply = (value: Record<string, unknown>) => socket.send(JSON.stringify({ rid: message.rid, ...value }));
      if (message.t === "hello") return void reply({ t: "welcome", ok: true, cwd: root, projectId: id, instanceId: options.welcomeInstance ?? instanceId,
        protocol: PROTOCOL, features: options.welcomeFeature === false ? FEATURES.filter(feature => feature !== FEATURE) : FEATURES });
      if (message.t === "recovery_authority" && message.op === "authorize") return void reply(options.deny
        ? { ok: false, error: "PRIVATE_DENIAL_CANARY" }
        : { ok: true, instanceId: options.authorizeInstance ?? instanceId });
      reply({ ok: false, error: "unexpected fixture request" });
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, projectId: id, instanceId, controlPort: server.port, protocol: PROTOCOL,
    features: options.descriptorFeature === false ? FEATURES.filter(feature => feature !== FEATURE) : FEATURES }));
  return { root, stateDir, instanceId, messages, planned: {
    project: { id, root, stateDir, pid: 123, instanceId, basePort: 4600 },
    source: { state: "running", instanceId, version: "0.5.0", protocol: PROTOCOL, peers: [], blockers: [] }, terminals: [], blockers: [],
  } };
}
function assertToolsOnly(f: ReturnType<typeof projectFixture>, actor = "codex") {
  const hellos = f.messages.filter(message => message.t === "hello");
  expect(hellos).toHaveLength(1);
  expect(hellos[0]).toMatchObject({ role: "tools", peer: actor, projectId: f.planned.project.id, projectRoot: f.root, instanceId: f.instanceId });
  expect(f.messages.filter(message => message.t !== "hello")).toEqual([
    expect.objectContaining({ t: "recovery_authority", op: "authorize", command: "upgrade" }),
  ]);
  expect(f.messages.some(message => message.role === "console")).toBe(false);
}

test("conductor recovery preflights every affected project as the tools actor pinned to its current instance", async () => {
  const first = projectFixture("first"), second = projectFixture("second");
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await preflightConductorRecovery({ kind: "upgrade", projects: [first.planned, second.planned] }, "codex");
  assertToolsOnly(first); assertToolsOnly(second);
  for (const f of [first, second]) {
    expect(existsSync(join(f.root, "recovery.lock"))).toBe(false);
    expect(readdirSync(f.stateDir).sort()).toEqual(["control-token", "status.json"]);
  }
});

test("a second project's missing conductor refuses before any non-authorize recovery message or console fallback", async () => {
  const first = projectFixture("first"), second = projectFixture("second", { deny: true });
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await expect(preflightConductorRecovery({ kind: "upgrade", projects: [first.planned, second.planned] }, "codex")).rejects.toThrow(REFUSAL);
  assertToolsOnly(first); assertToolsOnly(second);
  for (const f of [first, second]) expect(f.messages.every(message => message.t === "hello" || message.t === "recovery_authority" && message.op === "authorize")).toBe(true);
});

for (const missing of ["descriptor", "welcome"] as const) test(`an old daemon missing ${missing} recovery capability refuses without console fallback`, async () => {
  const f = projectFixture("old", { descriptorFeature: missing !== "descriptor", welcomeFeature: missing !== "welcome" });
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await expect(preflightConductorRecovery({ kind: "upgrade", projects: [f.planned] }, "codex")).rejects.toThrow(REFUSAL);
  expect(f.messages.map(message => message.t)).toEqual(missing === "descriptor" ? [] : ["hello"]);
  expect(f.messages.some(message => message.role === "console")).toBe(false);
});

test("authorization from a replacement instance cannot satisfy the reviewed source identity", async () => {
  const f = projectFixture("changed", { authorizeInstance: "replacement-instance" });
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await expect(preflightConductorRecovery({ kind: "upgrade", projects: [f.planned] }, "codex")).rejects.toThrow(REFUSAL);
  assertToolsOnly(f);
});

test("a stale welcome cannot be followed by an authorization or console retry", async () => {
  const f = projectFixture("changed-welcome", { welcomeInstance: "replacement-instance" });
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await expect(preflightConductorRecovery({ kind: "upgrade", projects: [f.planned] }, "codex")).rejects.toThrow();
  expect(f.messages.map(message => message.t)).toEqual(["hello"]);
  expect(f.messages[0]).toMatchObject({ role: "tools", peer: "codex", instanceId: f.instanceId });
});

for (const mutation of ["captured peer arguments", "removed project"] as const) test(`a public plan with ${mutation} changed under its old fingerprint cannot authorize a launcher`, async () => {
  const f = projectFixture("tampered");
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.5.0", sourceRoot: f.root, sourceDigest: "a".repeat(64),
    projects: [{ ...f.planned, source: { ...f.planned.source, peers: [{ id: "codex", state: "idle", sessionId: "fixture-native-thread", args: { model: "reviewed-model" } }] } }], blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) }, id = crypto.randomUUID();
  const op: RecoveryOperation = { schema: 1, id, plan, sourceRoot: f.root, targetRoot: f.root, targetDigest: "b".repeat(64), targetFeatures: [FEATURE],
    createdAt: 1, updatedAt: 1, phase: "running", step: "restore", projects: [{ id: f.planned.project.id, phase: "started", terminals: {}, instanceId: f.instanceId }] };
  if (mutation === "captured peer arguments") plan.projects[0]!.source.peers[0]!.args = { model: "unreviewed-model" };
  else plan.projects = [];
  const { authorizeConductorLaunch } = await import("../src/cli/conductor-recovery.ts");
  await expect(authorizeConductorLaunch(op, "codex", f.root, f.root, "codex", ["--model", "unreviewed-model"])).rejects.toThrow(REFUSAL);
  expect(f.messages).toEqual([]);
  expect(readdirSync(f.stateDir).sort()).toEqual(["control-token", "status.json"]);
});

test("agent recovery resume without target authority proof refuses before runner, coordinator spawn or lock", async () => {
  const f = projectFixture("resume"), home = join(f.root, "home"), sourceRoot = join(f.root, "retained-coordinator"), marker = join(f.root, "coordinator-started");
  mkdirSync(join(home, "recovery"), { recursive: true }); mkdirSync(join(sourceRoot, "src", "cli"), { recursive: true });
  writeFileSync(join(sourceRoot, "src", "cli", "main.js"), `await Bun.write(${JSON.stringify(marker)}, "unexpected coordinator spawn");\n`);
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "restart", version: "0.5.0", sourceRoot, sourceDigest: "a".repeat(64), projects: [f.planned], blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) }, id = crypto.randomUUID();
  // A public receipt and actor audit are intentionally present. Neither supplies the absent private/target proof.
  const operation: RecoveryOperation = { schema: 1, id, plan, sourceRoot, createdAt: 1, updatedAt: 1, phase: "pending", step: "stage",
    projects: [{ id: f.planned.project.id, phase: "pending", terminals: {} }],
    delegatedAudits: [{ peer: "codex", command: "recovery-run", at: 1, operationId: id }] };
  const receipt = operationPath(id, home); writeFileSync(receipt, JSON.stringify(operation)); const before = readFileSync(receipt);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || ["CODEX_THREAD_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "KIMI_CODE", "QWEN_CODE", "QWEN_CODE_SESSION_ID"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_PEER_ID: "codex", AGENTHUB_HOME: home, HOME: home, AMEM_HOME: join(home, "memory"),
    CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), KIMI_CODE_HOME: join(home, "kimi"), XDG_CONFIG_HOME: join(home, ".config") });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "recovery", "resume", id], { cwd: f.root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(1); expect(stderr).toContain(REFUSAL); expect(stdout).toBe("");
    expect(existsSync(join(home, "recovery.lock"))).toBe(false); expect(existsSync(`${receipt}.runner.db`)).toBe(false);
    expect(existsSync(marker)).toBe(false); expect(readFileSync(receipt)).toEqual(before);
    expect(f.messages).toEqual([]);
  } finally { clearTimeout(timeout); }
}, 20_000);

test("captured terminal plans require a person before any project authorization or staging", async () => {
  const f = projectFixture("terminal");
  const { preflightConductorRecovery } = await import("../src/cli/conductor-recovery.ts");
  await expect(preflightConductorRecovery({ kind: "restart", projects: [{ ...f.planned, terminals: [{ peer: "codex" }] }] }, "codex")).rejects.toThrow(REFUSAL);
  expect(f.messages).toEqual([]);
  expect(readdirSync(f.stateDir).sort()).toEqual(["control-token", "status.json"]);
});

test("native descendants cannot inherit the conductor recovery continuation", async () => {
  const { childEnv, personEnv } = await import("../src/hub/child-process.ts");
  const parent = { AGENTHUB_RECOVERY_OPERATION: "owned-operation", AGENTHUB_RECOVERY_CONDUCTOR: "codex", AGENTHUB_RECOVERY_CONTINUATION: "owned-operation", AGENTHUB_HOME: "/fixture/home" };
  for (const env of [childEnv(parent), personEnv(parent)]) {
    expect(env.AGENTHUB_RECOVERY_OPERATION).toBeUndefined();
    expect(env.AGENTHUB_RECOVERY_CONDUCTOR).toBeUndefined();
    expect(env.AGENTHUB_RECOVERY_CONTINUATION).toBeUndefined();
    expect(env.AGENTHUB_HOME).toBe("/fixture/home");
  }
});
