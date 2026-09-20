import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortRecovery, createOperation, planFingerprint, registeredProjects, runRecovery, type Inspection, type RecoveryDriver, type UpgradePlan } from "../src/cli/upgrade.ts";
import { acquireRecoveryLock, claimRunner, readOperation, recoveryLock, releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { exactVersion, packageDigest, registryRelease } from "../src/cli/recovery-package.ts";
import { makeRecoveryDriver, PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(kind: "restart" | "upgrade" = "upgrade") {
  const home = mkdtempSync(join(tmpdir(), "ahub-upgrade-test-")); homes.push(home);
  const calls: string[] = [];
  const states = new Map<string, Inspection>();
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind, version: "0.5.0", sourceRoot: "/old", sourceDigest: "digest",
    projects: ["alpha", "beta"].map((id) => {
      const source: Inspection = { state: "running", instanceId: `old-${id}`, version: "0.5.0", protocol: 9, peers: [], blockers: [] };
      states.set(id, structuredClone(source));
      return { project: { id, root: `/${id}`, stateDir: `/${id}/state`, pid: 123, instanceId: `old-${id}`, basePort: 4600 }, source, terminals: [], blockers: [] };
    }), blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
  const operation = createOperation(plan, "/retained", home);
  let clock = 0;
  const driver: RecoveryDriver = {
    stage: async () => { calls.push("stage"); return { root: "/target", digest: "target-digest" }; },
    inspect: async (p) => structuredClone(states.get(p.id)!),
    prepare: async (p, id) => { calls.push(`prepare:${p.id}`); states.get(p.id)!.recovery = { operationId: id, ready: true, phase: "prepared" }; },
    abort: async (p) => { calls.push(`abort:${p.id}`); delete states.get(p.id)!.recovery; },
    closeTerminals: async (p) => { calls.push(`close:${p.project.id}`); },
    commit: async (p) => { calls.push(`commit:${p.id}`); states.set(p.id, { state: "stopped", peers: [], blockers: [] }); },
    start: async (p, op) => { calls.push(`start:${p.id}`); states.set(p.id, { state: "running", peers: [], blockers: [], instanceId: `new-${p.id}`, version: "0.5.0", protocol: 10,
      recovery: { operationId: op.id, phase: "restored", ready: true } }); },
    restore: async (p, _progress, _op, group) => { calls.push(`${group}:${p.project.id}`); },
    installPlugin: async () => { calls.push("plugin"); },
    installGlobal: async () => { calls.push("global"); },
    release: async (p) => { calls.push(`release:${p.id}`); states.get(p.id)!.recovery!.phase = "released"; },
    verify: async (p) => { calls.push(`verify:${p.project.id}`); },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return { home, plan, operation, driver, calls, states };
}

test("two project upgrade restores native peers sequentially, Claude after shared plugin, promotes global last", async () => {
  const f = fixture();
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("completed");
  expect(f.calls).toEqual(["stage", "prepare:alpha", "close:alpha", "commit:alpha", "start:alpha", "native:alpha",
    "prepare:beta", "close:beta", "commit:beta", "start:beta", "native:beta", "plugin", "claude:alpha", "verify:alpha", "release:alpha",
    "claude:beta", "verify:beta", "release:beta", "global"]);
  expect(recoveryLock(f.home)).toBeUndefined();
  const before = [...f.calls];
  await runRecovery(f.operation.id, f.driver, f.home);
  expect(f.calls).toEqual(before);
});

test("resume and abort re-read a completed receipt under the runner claim and clear a stale same-operation lock", async () => {
  const f = fixture();
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("completed");
  acquireRecoveryLock(f.operation.id, f.home);
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("completed");
  expect(recoveryLock(f.home)).toBeUndefined();
  const calls = [...f.calls];

  acquireRecoveryLock(f.operation.id, f.home);
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect(recoveryLock(f.home)).toBeUndefined();
  expect(f.calls).toEqual(calls);
});

test("a resumed peers-restored project still keeps saved terminal bindings in the release verification gate", async () => {
  const f = fixture();
  const planned = f.plan.projects[0]!;
  const progress = f.operation.projects[0]!;
  const binding = {
    peer: "codex" as const, handle: "term-codex", incarnationId: "inc-codex", worktreeId: "repo::/alpha", projectRoot: "/alpha", sessionId: "thread-alpha",
    launch: { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js", argv: [], env: {} },
    launchMetadata: { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js", argv: [], env: {} },
  };
  planned.terminals = [binding];
  progress.phase = "peers-restored";
  progress.instanceId = "new-alpha";
  progress.terminals["restored:codex"] = binding;
  f.states.get("alpha")!.instanceId = "new-alpha";
  f.states.get("alpha")!.recovery = { operationId: f.operation.id, phase: "restored", ready: true };
  const verified: string[] = [];
  f.driver.verify = async (p, saved) => {
    if (p.project.id === "alpha" && !saved.terminals["restored:codex"]) throw new Error("saved terminal binding was dropped");
    verified.push(p.project.id);
  };
  const { fingerprint: _fingerprint, ...reviewed } = f.plan;
  f.plan.fingerprint = planFingerprint(reviewed);
  f.operation.plan = f.plan;
  writeOperation(f.operation.id, f.operation, f.home);
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("completed");
  expect(verified).toContain("alpha");
});

test("read-only registry planning creates no directory or database", () => {
  const f = fixture();
  const missing = join(f.home, "absent");
  expect(registeredProjects(missing)).toEqual([]);
  expect(existsSync(missing)).toBe(false);
});

test("peer fingerprints preserve online membership while normalizing transient active states", () => {
  const f = fixture();
  const body = structuredClone(f.plan);
  body.projects[0]!.source.peers = [{ id: "kimi", state: "idle", sessionId: "same-session" }];
  const hash = () => { const { fingerprint: _ignored, ...plan } = body; return planFingerprint(plan); };
  const online = hash();
  body.projects[0]!.source.peers[0]!.state = "busy";
  expect(hash()).toBe(online);
  body.projects[0]!.source.peers[0]!.state = "paused";
  expect(hash()).toBe(online);
  body.projects[0]!.source.peers[0]!.state = "offline";
  expect(hash()).not.toBe(online);
});

test("a peer going offline after confirmation blocks before any runtime is stopped", async () => {
  const f = fixture();
  f.plan.projects[0]!.source.peers = [{ id: "kimi", state: "idle", sessionId: "same-session" }];
  f.states.get("alpha")!.peers = [{ id: "kimi", state: "offline", sessionId: "same-session" }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  writeOperation(f.operation.id, f.operation, f.home);
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("blocked");
  expect(result.error).toContain("active peer membership changed");
  expect(f.calls).toEqual(["stage"]);
});

test("runner ownership prevents concurrent resume even with the same operation ID", () => {
  const f = fixture();
  const release = claimRunner(f.operation.id, f.home);
  expect(() => claimRunner(f.operation.id, f.home)).toThrow("still alive");
  release();
  claimRunner(f.operation.id, f.home)();
});

test("a replaced source daemon blocks before any project is stopped", async () => {
  const f = fixture();
  f.states.get("beta")!.instanceId = "replacement";
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("blocked");
  expect(f.calls).toEqual(["stage"]);
  expect(f.states.get("alpha")!.state).toBe("running");
  expect(recoveryLock(f.home)).toBe(f.operation.id);
});

test("busy or approval timeout aborts preparation and leaves the source running", async () => {
  const f = fixture();
  f.driver.prepare = async (p, id) => { f.states.get(p.id)!.recovery = { operationId: id, phase: "preparing", ready: false }; };
  const result = await runRecovery(f.operation.id, f.driver, f.home, 500);
  expect(result.phase).toBe("blocked");
  expect(f.calls).toContain("abort:alpha");
  expect(f.calls).not.toContain("commit:alpha");
  expect(f.states.get("alpha")!.state).toBe("running");
});

test("a lost commit reply is reconciled without committing twice", async () => {
  const f = fixture();
  const commit = f.driver.commit;
  let fail = true;
  f.driver.commit = async (...a) => { await commit(...a); if (fail) { fail = false; throw new Error("reply lost"); } };
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("blocked");
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("completed");
  expect(f.calls.filter((v) => v === "commit:alpha")).toHaveLength(1);
});

test("a lost startup response adopts only the operation's exact replacement runtime", async () => {
  const f = fixture();
  const start = f.driver.start;
  let fail = true;
  f.driver.start = async (...a) => { await start(...a); if (fail) { fail = false; throw new Error("start response lost"); } };
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("blocked");
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("completed");
  expect(f.calls.filter((v) => v === "start:alpha")).toHaveLength(1);
});

test("a lost release response does not re-verify changed live queues or release them twice", async () => {
  const f = fixture();
  const release = f.driver.release;
  let fail = true;
  f.driver.release = async (...a) => { await release(...a); if (fail) { fail = false; throw new Error("release response lost"); } };
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("blocked");
  const verify = f.driver.verify;
  f.driver.verify = async (...a) => {
    if (a[0].project.id === "alpha") throw new Error("old queues have now been consumed");
    await verify(...a);
  };
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("completed");
  expect(f.calls.filter((v) => v === "release:alpha")).toHaveLength(1);
});

test("unverified target session prevents release and global promotion", async () => {
  const f = fixture();
  f.driver.verify = async () => { throw new Error("wrong original thread"); };
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("blocked");
  expect(f.calls.some((v) => v.startsWith("release:"))).toBe(false);
  expect(f.calls).not.toContain("global");
});

test("restarting a project never invokes shared plugin or package installation", async () => {
  const f = fixture("restart");
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("completed");
  expect(f.calls).not.toContain("plugin");
  expect(f.calls).not.toContain("global");
});

test("blocked plans cannot create operations and exact versions reject shell/tag ambiguity", async () => {
  const f = fixture();
  releaseRecoveryLock(f.operation.id, f.home);
  expect(() => createOperation({ ...f.plan, blockers: ["legacy runtime"] }, "/old", f.home)).toThrow("blockers");
  for (const value of ["latest", "^0.5.0", "0.5.0; echo bad", "../pkg"]) expect(() => exactVersion(value)).toThrow();
  expect(exactVersion("0.5.0-rc.1")).toBe("0.5.0-rc.1");
  await expect(registryRelease("0.5.0", async () => ({ code: 0, stdout: JSON.stringify({ version: "9.0.0", "dist.integrity": "sha512-fake" }), stderr: "" }))).rejects.toThrow("unexpected release");
});

test("resume rejects an altered reviewed plan before executing a driver action", async () => {
  const f = fixture();
  f.operation.plan.version = "9.0.0";
  writeOperation(f.operation.id, f.operation, f.home);
  await expect(runRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("plan or project scope changed");
  expect(f.calls).toEqual([]);
});

test("a preflight can be cancelled without leaving a machine lock", async () => {
  const f = fixture();
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect(recoveryLock(f.home)).toBeUndefined();
  expect((readOperation(f.operation.id, f.home) as any).phase).toBe("cancelled");
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("cancelled");
  expect(f.calls).toEqual([]);
});

test("cancellation refuses an operation whose source has already stopped", async () => {
  const f = fixture();
  f.driver.start = async () => { throw new Error("installation failed"); };
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("blocked");
  await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("stopped runtimes");
  expect(recoveryLock(f.home)).toBe(f.operation.id);
});

test("target daemons use their captured account homes and each Claude store is updated separately", async () => {
  const f = fixture();
  const previous = { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.CODEX_HOME = "/unrelated-source";
  process.env.OPENAI_API_KEY = "test-only-not-a-secret";
  try {
    const commands: { argv: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const driver = makeRecoveryDriver(async (argv, options) => { commands.push({ argv, env: options?.env }); return { code: 0, stdout: "", stderr: "" }; });
    f.operation.targetRoot = "/target";
    for (const planned of f.plan.projects) {
      planned.project.stateDir = join(f.home, planned.project.id);
      mkdirSync(planned.project.stateDir);
      writeFileSync(join(planned.project.stateDir, "restart.json"), JSON.stringify({ projectId: planned.project.id, projectRoot: planned.project.root, operationId: f.operation.id }));
      planned.terminals = [
        { peer: "codex", launch: { env: { CODEX_HOME: `/accounts/${planned.project.id}/codex` } } },
        { peer: "claude", launch: { env: { CLAUDE_CONFIG_DIR: `/accounts/${planned.project.id}/claude` } } },
      ];
      await driver.start(planned.project, f.operation);
    }
    await driver.installPlugin(f.operation);
    expect(commands).toHaveLength(4);
    for (let i = 0; i < 2; i++) {
      const id = f.plan.projects[i]!.project.id;
      expect(commands[i]!.env?.CODEX_HOME).toBe(`/accounts/${id}/codex`);
      expect(commands[i]!.env?.OPENAI_API_KEY).toBeUndefined();
      expect(commands[i + 2]!.env?.CLAUDE_CONFIG_DIR).toBe(`/accounts/${id}/claude`);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("protocol-9 source recovery stages only a protocol-10 target", async () => {
  const f = fixture("restart");
  f.operation.sourceRoot = PACKAGE_ROOT;
  f.operation.plan.sourceRoot = PACKAGE_ROOT;
  f.operation.plan.version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  f.operation.plan.sourceDigest = packageDigest(PACKAGE_ROOT);
  const driver = makeRecoveryDriver(async (argv) => argv[1] === "-e"
    ? { code: 0, stdout: "10\n", stderr: "" }
    : { code: 0, stdout: "", stderr: "" });
  const target = await driver.stage(f.operation);
  expect(target.root).toBe(PACKAGE_ROOT);
  expect(f.operation.plan.projects[0]?.source.protocol).toBe(9);
  expect(f.operation.plan.projects[0]?.source.protocol).not.toBe(10);
});
