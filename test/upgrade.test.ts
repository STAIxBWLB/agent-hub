import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortRecovery, abortRefusal, createOperation, disposeRecovery, FinalRefusal, liveProjects, nextActions, planFingerprint, publicOperation, recoveryCommand, registeredProjects, runRecovery, type Inspection, type RecoveryDriver, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import { acquireRecoveryLock, activeOperation, claimRunner, readOperation, recoveryLock, recoveryRunner, releaseRecoveryLock, writeOperation } from "../src/hub/recovery-store.ts";
import { exactVersion, packageDigest, registryRelease } from "../src/cli/recovery-package.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { inspectRecovery, makeRecoveryDriver, PACKAGE_ROOT } from "../src/cli/upgrade-runtime.ts";

const homes: string[] = [];
// The fixture preserves this package as its coordinator, which has every recovery command (#215).
const C = `bun ${join(PACKAGE_ROOT, "src/cli/main.js")} recovery`;
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(kind: "restart" | "upgrade" = "upgrade", ids = ["alpha", "beta"]) {
  const home = mkdtempSync(join(tmpdir(), "ahub-upgrade-test-")); homes.push(home);
  const calls: string[] = [];
  const states = new Map<string, Inspection>();
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind, version: "0.5.0", sourceRoot: "/old", sourceDigest: "digest",
    projects: ids.map((id) => {
      const source: Inspection = { state: "running", instanceId: `old-${id}`, version: "0.5.0", protocol: 9, peers: [], blockers: [] };
      states.set(id, structuredClone(source));
      return { project: { id, root: `/${id}`, stateDir: `/${id}/state`, pid: 123, instanceId: `old-${id}`, basePort: 4600 }, source, terminals: [], blockers: [] };
    }), blockers: [] };
  const plan: UpgradePlan = { ...body, fingerprint: planFingerprint(body) };
  const operation = createOperation(plan, PACKAGE_ROOT, home);
  let clock = 0;
  const driver: RecoveryDriver = {
    stage: async () => { calls.push("stage"); return { root: PACKAGE_ROOT, digest: "target-digest" }; }, // a target that reads recovery waivers
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
    stopAndArchive: async (p, _op, instance) => { calls.push(`stop-archive:${p.id}${instance ? `:${instance}` : ""}`); states.set(p.id, { state: "stopped", peers: [], blockers: [] }); },
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

test("protocol-9 source recovery stages only the current protocol target", async () => {
  const f = fixture("restart");
  f.operation.sourceRoot = PACKAGE_ROOT;
  f.operation.plan.sourceRoot = PACKAGE_ROOT;
  f.operation.plan.version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  f.operation.plan.sourceDigest = packageDigest(PACKAGE_ROOT);
  const driver = makeRecoveryDriver(async (argv) => argv[1] === "-e"
    ? { code: 0, stdout: `${PROTOCOL}\n`, stderr: "" }
    : { code: 0, stdout: "", stderr: "" });
  const target = await driver.stage(f.operation);
  expect(target.root).toBe(PACKAGE_ROOT);
  expect(f.operation.plan.projects[0]?.source.protocol).toBe(9);
  expect(f.operation.plan.projects[0]?.source.protocol).not.toBe(10);
});

// #206: the plan drops an unmanaged Claude's session id, while the source daemon may still report a stale record.
test("a reconnect-only Claude passes the source roster check without the session id the plan dropped", async () => {
  for (const reconnectOnly of [true, false]) {
    const f = fixture();
    f.plan.projects[0]!.source.peers = [{ id: "claude", state: "idle" }];
    if (reconnectOnly) f.plan.projects[0]!.reconnectOnly = ["claude"];
    f.states.get("alpha")!.peers = [{ id: "claude", state: "idle", sessionId: "stale-record" }];
    const { fingerprint: _ignored, ...body } = f.plan;
    f.plan.fingerprint = planFingerprint(body);
    writeOperation(f.operation.id, f.operation, f.home);
    const result = await runRecovery(f.operation.id, f.driver, f.home);
    if (reconnectOnly) expect(result.phase).toBe("completed");
    else expect(result.error).toContain("source conversation or active peer membership changed");
  }
});

// #215: alpha was prepared and its Claude terminal closed, then the ten-minute lease expired before commit.
function expiredLease() {
  const f = fixture();
  f.plan.projects[0]!.source.peers = [{ id: "claude", state: "idle", sessionId: "s1" }, { id: "codex", state: "idle", threadId: "t1" }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  f.operation.projects[0]!.phase = "prepared";
  f.operation.projects[0]!.terminals = { "closed:claude": true };
  f.states.get("alpha")!.peers = [{ id: "claude", state: "offline", sessionId: "s1" }, { id: "codex", state: "idle", threadId: "t1" }];
  writeOperation(f.operation.id, f.operation, f.home);
  f.driver.closeTerminals = async (planned, progress, _op, save) => {
    for (const peer of ["claude", "codex"]) if (planned.project.id === "alpha" && progress.terminals[`closed:${peer}`] !== true) {
      f.calls.push(`close:${peer}`); progress.terminals[`closed:${peer}`] = true; save();
    }
  };
  return f;
}

test("after an expired lease resume re-prepares the same source, keeps the close receipt and never closes twice", async () => {
  const f = expiredLease();
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("completed");
  expect(f.calls.slice(0, 4)).toEqual(["stage", "prepare:alpha", "close:codex", "commit:alpha"]);
  expect(f.calls).not.toContain("close:claude");
  expect(f.calls.filter((call) => call === "commit:alpha")).toHaveLength(1);
  expect(result.projects[0]!.terminals["closed:claude"]).toBe(true);
});

test("re-preparation refuses a conflicting operation, a replaced daemon and a changed session without acting", async () => {
  const cases = [
    { change: (f: ReturnType<typeof fixture>) => { f.states.get("alpha")!.recovery = { operationId: "11111111-1111-1111-1111-111111111111", phase: "prepared", ready: true }; },
      error: "held by another recovery operation 11111111-1111-1111-1111-111111111111", prepared: false },
    { change: (f: ReturnType<typeof fixture>) => { f.states.get("alpha")!.instanceId = "replacement"; }, error: "replaced by instance replacement", prepared: false },
    { change: (f: ReturnType<typeof fixture>) => { f.states.get("alpha")!.peers[1]!.threadId = "t-other"; }, error: "codex changed while this operation has recorded effects", prepared: true },
  ];
  for (const c of cases) {
    const f = expiredLease();
    c.change(f);
    const result = await runRecovery(f.operation.id, f.driver, f.home);
    expect(result.phase).toBe("blocked");
    expect(result.error).toContain(c.error);
    expect(result.error).toContain(`${C} `); // the operation's own coordinator, not the bare "source is no longer prepared"
    expect(f.calls.includes("prepare:alpha")).toBe(c.prepared);
    expect(f.calls.some((call) => ["commit:alpha", "close:codex", "close:claude", "abort:alpha"].includes(call))).toBe(false);
    expect(result.projects[0]!.terminals).toEqual({ "closed:claude": true });
    expect(recoveryLock(f.home)).toBe(f.operation.id);
  }
});

function failedRestore() {
  const f = fixture();
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  f.plan.projects[0]!.terminals = [{ peer: "codex", handle: "term-codex", incarnationId: "inc", worktreeId: "wt", projectRoot: "/alpha", sessionId: "t1", launch, launchMetadata: launch }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  Object.assign(f.operation.projects[0]!, { phase: "started", instanceId: "new-alpha", terminals: { "closed:codex": true, "restored:codex": "failed" } });
  Object.assign(f.operation, { phase: "blocked", targetRoot: PACKAGE_ROOT });
  f.states.set("alpha", { state: "running", instanceId: "new-alpha", version: "0.5.0", protocol: 10, peers: [], blockers: [], recovery: { operationId: f.operation.id, phase: "restored", ready: true } });
  writeOperation(f.operation.id, f.operation, f.home);
  return f;
}

test("a failed restoration offers both dispositions; fresh-session records the lost thread and keeps the lock", async () => {
  const f = failedRestore();
  const failed = readOperation<RecoveryOperation>(f.operation.id, f.home);
  expect(publicOperation(failed, undefined, await liveProjects(failed, f.driver.inspect)).next).toEqual([
    `${C} resume ${f.operation.id}`,
    `${C} dispose ${f.operation.id} --fresh-session codex --reason <text>`,
    `${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`,
  ]);
  await expect(disposeRecovery(f.operation.id, { fresh: "claude" }, "wrong peer", f.driver, f.home)).rejects.toThrow("no failed restoration of it is open to a fresh session");
  const op = await disposeRecovery(f.operation.id, { fresh: "codex" }, "rollout missing from the store", f.driver, f.home);
  expect(op.projects[0]!.fresh?.codex).toMatchObject({ lost: "t1", reason: "rollout missing from the store" });
  expect(op.projects[0]!.terminals).toEqual({ "closed:codex": true, "restored:codex": "failed" }); // until resume launches the fresh session
  expect(publicOperation(op).next).not.toContain(`${C} dispose ${f.operation.id} --fresh-session codex --reason <text>`);
  expect(op.audit).toEqual([expect.objectContaining({ action: "fresh-session", peer: "codex", projects: ["alpha"] })]);
  expect(op.phase).toBe("blocked");
  expect(recoveryLock(f.home)).toBe(f.operation.id);
  expect(publicOperation(op).projects[0]).toMatchObject({ lostContinuity: { codex: "t1" } });
  expect(f.calls).toEqual([]);
});

test("stop-and-archive stops only its own target, releases its own source hold, and only then the lock", async () => {
  const f = failedRestore();
  Object.assign(f.operation.projects[1]!, { phase: "prepared" });
  f.states.get("beta")!.recovery = { operationId: f.operation.id, phase: "prepared", ready: true };
  writeOperation(f.operation.id, f.operation, f.home);
  const uncertain = structuredClone(f.states.get("beta")!);
  f.states.set("beta", { ...uncertain, state: "unavailable" });
  await expect(disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home)).rejects.toThrow("beta: its hub reads as unavailable, so whether this operation owns it cannot be verified");
  expect(f.calls).toEqual([]);
  expect(recoveryLock(f.home)).toBe(f.operation.id);

  f.states.set("beta", uncertain);
  const op = await disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home);
  expect(f.calls).toEqual(["stop-archive:alpha:new-alpha", "abort:beta"]);
  expect(op.phase).toBe("cancelled");
  expect(op.disposition?.projects).toEqual({ alpha: "target stopped", beta: "source hold released; source left running" });
  expect(op.globalInstalled).toBeUndefined();
  expect(recoveryLock(f.home)).toBeUndefined();
  expect(publicOperation(op)).toMatchObject({ phase: "cancelled", globalInstalled: false, next: [] });
  expect((await runRecovery(f.operation.id, f.driver, f.home)).phase).toBe("cancelled");
});

test("status tells a live runner from a stale running receipt", () => {
  const f = fixture();
  f.operation.phase = "running";
  expect(publicOperation(f.operation)).toMatchObject({ runner: { state: "none" }, stale: expect.stringContaining("no runner holds") });
  expect(publicOperation(f.operation, 4242)).toMatchObject({ runner: { state: "running", pid: 4242 }, next: [expect.stringContaining("runner 4242")] });
  expect(publicOperation(f.operation, 4242).stale).toBeUndefined();
});

test("stop-and-archive never stops a daemon this operation does not hold", async () => {
  const f = failedRestore();
  f.states.set("alpha", { state: "running", instanceId: "replacement", version: "0.5.0", protocol: 10, peers: [], blockers: [] });
  const op = await disposeRecovery(f.operation.id, { stop: true }, "replacement appeared", f.driver, f.home);
  expect(f.calls).toEqual([]);
  expect(op.disposition?.projects).toEqual({ alpha: "left running: instance replacement is not held by this operation", beta: "source left running (never prepared)" });
  expect(op.phase).toBe("cancelled");
  expect(recoveryLock(f.home)).toBeUndefined();
});

// #215 review: the no-rollout advice says to end the Codex session; the hold may expire meanwhile.
test("re-preparation lets a planned peer that detached since pass; closing it is left to the terminal inventory", async () => {
  const f = expiredLease();
  f.states.get("alpha")!.peers[1]!.state = "offline";
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.phase).toBe("completed");
  expect(f.calls.slice(0, 4)).toEqual(["stage", "prepare:alpha", "close:codex", "commit:alpha"]);
});

test("stop-and-archive knows its target by the operation fence when the receipt never recorded the instance", async () => {
  const f = failedRestore();
  Object.assign(f.operation.projects[0]!, { phase: "stopped", instanceId: undefined, terminals: { "closed:codex": true } });
  writeOperation(f.operation.id, f.operation, f.home);
  const op = await disposeRecovery(f.operation.id, { stop: true }, "start failed after the target came up", f.driver, f.home);
  expect(f.calls).toEqual(["stop-archive:alpha:new-alpha"]);
  expect(op.disposition?.projects.alpha).toBe("target stopped");
  expect(recoveryLock(f.home)).toBeUndefined();
});

test("a stop-and-archive that fails partway records what it did, keeps the lock and blocks resume until finished", async () => {
  const f = failedRestore();
  Object.assign(f.operation.projects[1]!, { phase: "prepared" });
  f.states.get("beta")!.recovery = { operationId: f.operation.id, phase: "prepared", ready: true };
  writeOperation(f.operation.id, f.operation, f.home);
  const abort = f.driver.abort;
  f.driver.abort = async () => { throw new Error("a committed recovery cannot be aborted"); };
  await expect(disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home)).rejects.toThrow("cannot be aborted");
  let op = readOperation(f.operation.id, f.home) as ReturnType<typeof fixture>["operation"];
  expect(op.disposition?.projects).toEqual({ alpha: "target stopped" });
  expect(op.error).toContain("stop-and-archive stopped partway and keeps the lock");
  expect(publicOperation(op, undefined, await liveProjects(op, f.driver.inspect)).next).toEqual([`rerun ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`]);
  expect(recoveryLock(f.home)).toBe(f.operation.id);
  await expect(disposeRecovery(f.operation.id, { fresh: "codex" }, "no", f.driver, f.home)).rejects.toThrow("stop-and-archive of this operation is partway");
  const calls = f.calls.length;
  // Resume refuses an operation being abandoned and keeps the stop-and-archive's own cause.
  expect((await runRecovery(f.operation.id, f.driver, f.home)).error).toContain("stop-and-archive stopped partway and keeps the lock: a committed recovery cannot be aborted");
  expect(f.calls).toHaveLength(calls);

  f.driver.abort = abort;
  op = await disposeRecovery(f.operation.id, { stop: true }, "finish", f.driver, f.home);
  expect(op.phase).toBe("cancelled");
  expect(op.error).toBeUndefined();
  expect(op.disposition?.projects).toEqual({ alpha: "target stopped", beta: "source hold released; source left running" });
  expect(op.audit?.map((entry) => entry.reason)).toEqual(["give up", "finish"]);
  expect(recoveryLock(f.home)).toBeUndefined();
});

test("stop-and-archive gives a project whose directory is gone a true outcome instead of waiting forever", async () => {
  const f = failedRestore();
  f.states.set("alpha", { state: "missing", peers: [], blockers: ["project directory is missing"] });
  const op = await disposeRecovery(f.operation.id, { stop: true }, "project removed", f.driver, f.home);
  expect(op.disposition?.projects.alpha).toContain("project directory is missing; nothing was stopped or archived");
  expect(op.phase).toBe("cancelled");
});

// #215 review: a restored hub refills a Pi start from its recorded resume, so a "fresh" Pi would quietly resume.
test("--fresh-session pi is refused and never offered", async () => {
  const f = failedRestore();
  f.operation.projects[0]!.terminals["restored:pi"] = "failed";
  writeOperation(f.operation.id, f.operation, f.home);
  await expect(disposeRecovery(f.operation.id, { fresh: "pi" }, "lost", f.driver, f.home)).rejects.toThrow("pi: --fresh-session is not supported");
  const next = publicOperation(readOperation(f.operation.id, f.home)).next;
  expect(next).toContain(`${C} dispose ${f.operation.id} --fresh-session codex --reason <text>`);
  expect(next.some((line) => line.includes("--fresh-session pi"))).toBe(false);
});

// #215 review: no effects, an expired hold and a changed roster used to loop between "make a new plan" (refused by
// this operation's lock), "resume it instead" and abort's refusal.
test("a changed roster after an expired hold with no effects names abort, and abort cancels the lapsed preparation", async () => {
  const f = fixture();
  f.plan.projects[0]!.source.peers = [{ id: "codex", state: "idle", threadId: "t1" }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  f.operation.projects[0]!.phase = "prepared";
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.get("alpha")!.peers = [{ id: "codex", state: "idle", threadId: "t1" }, { id: "kimi", state: "idle" }];
  const blocked = await runRecovery(f.operation.id, f.driver, f.home);
  expect(blocked.error).toBe(`alpha: source conversation or active peer membership changed (kimi); end that kimi session before resuming, or end this operation: a new plan can be made once it is cancelled or ended; next actions: ${C} resume ${f.operation.id} | ${C} abort ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  expect(publicOperation(blocked, undefined, { alpha: f.states.get("alpha")!, beta: f.states.get("beta")! }).next).toContain(`${C} abort ${f.operation.id}`);
  delete f.states.get("alpha")!.recovery; // the re-prepared hold lapses again before the operator acts
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect((readOperation(f.operation.id, f.home) as { phase: string }).phase).toBe("cancelled");
  expect(recoveryLock(f.home)).toBeUndefined();
  expect(f.calls).not.toContain("commit:alpha");
});

test("a session that joined after the plan, with effects recorded, is to be ended, not restored", async () => {
  const f = expiredLease();
  f.states.get("alpha")!.peers.push({ id: "kimi", state: "idle" });
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.error).toContain(`kimi changed while this operation has recorded effects, so a new plan cannot replace it; end that kimi session before resuming; next actions: ${C} resume`);
});

test("staging refuses a target that cannot read recovery waivers when a reconnect-only session is planned", async () => {
  // A minimal package of an older release: same identity and protocol, a restart.ts without readRecoveryWaivers.
  const older = mkdtempSync(join(tmpdir(), "ahub-older-target-")); homes.push(older);
  for (const dir of ["src/cli", "src/hub", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(older, dir), { recursive: true });
  writeFileSync(join(older, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.5.0" }));
  writeFileSync(join(older, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.5.0" }));
  writeFileSync(join(older, "src/cli/main.js"), "");
  writeFileSync(join(older, "src/hub/restart.ts"), "export function readRestartSnapshot() {}\n");
  const f = fixture("restart");
  f.operation.sourceRoot = older;
  Object.assign(f.operation.plan, { sourceRoot: older, sourceDigest: packageDigest(older) });
  f.operation.plan.projects[0]!.reconnectOnly = ["claude"];
  const driver = makeRecoveryDriver(async () => ({ code: 0, stdout: `${PROTOCOL}\n`, stderr: "" }));
  await expect(driver.stage(f.operation)).rejects.toThrow("predates recovery waivers");
  await expect(driver.stage(f.operation)).rejects.toBeInstanceOf(FinalRefusal); // the staged target never changes back
  f.operation.sourceRoot = PACKAGE_ROOT;
  Object.assign(f.operation.plan, { sourceRoot: PACKAGE_ROOT, version: JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version, sourceDigest: packageDigest(PACKAGE_ROOT) });
  expect((await driver.stage(f.operation)).root).toBe(PACKAGE_ROOT);
});

// #215 review: a failed roster check during re-preparation keeps the hold it took; a second resume inside the lease
// sees the hold ours and ready and must still compare the roster before it closes anything (#215 AC2).
test("a second resume within the hold's lease checks the roster again and never closes or commits a changed conversation", async () => {
  const f = expiredLease();
  f.states.get("alpha")!.peers[1]!.threadId = "t-new"; // the person started a new Codex conversation meanwhile
  expect((await runRecovery(f.operation.id, f.driver, f.home)).error).toContain("codex changed while this operation has recorded effects");
  expect(f.states.get("alpha")!.recovery).toMatchObject({ operationId: f.operation.id, ready: true });
  const second = await runRecovery(f.operation.id, f.driver, f.home);
  expect(second.error).toContain("codex changed while this operation has recorded effects");
  expect(f.calls.filter((call) => call === "prepare:alpha")).toHaveLength(1); // the second run did not re-prepare
  expect(f.calls.some((call) => ["close:codex", "close:claude", "commit:alpha"].includes(call))).toBe(false);
});

test("a roster change in an untouched project names stop-and-archive, not abort, once another project has effects", async () => {
  const f = fixture();
  f.plan.projects[1]!.source.peers = [{ id: "codex", state: "idle", threadId: "t1" }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  f.operation.projects[0]!.phase = "verified";
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.get("beta")!.peers = [{ id: "codex", state: "idle", threadId: "t2" }];
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.error).toContain(`beta: codex changed while this operation has recorded effects, so a new plan cannot replace it; restore codex's original session before resuming; next actions: ${C} resume ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  expect(result.error).not.toContain(" abort ");
  expect(publicOperation(result).next).not.toContain(`${C} abort ${f.operation.id}`);
});

test("stop-and-archive names the operation's own lapsed source as such", async () => {
  const f = expiredLease();
  const op = await disposeRecovery(f.operation.id, { stop: true }, "give up after the lease", f.driver, f.home);
  expect(op.disposition?.projects.alpha).toBe("source left running (its hold had lapsed)");
  expect(f.calls).toEqual([]);
});

// #215 review: a finished operation owns no lock; refusing to dispose of it must not take one.
test("disposing of a finished operation again leaves no lock", async () => {
  const f = failedRestore();
  expect((await disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home)).phase).toBe("cancelled");
  expect(recoveryLock(f.home)).toBeUndefined();
  await expect(disposeRecovery(f.operation.id, { stop: true }, "again", f.driver, f.home)).rejects.toThrow("operation is already cancelled");
  await expect(disposeRecovery(f.operation.id, { fresh: "codex" }, "again", f.driver, f.home)).rejects.toThrow("operation is already cancelled");
  expect(recoveryLock(f.home)).toBeUndefined();
});

// #215 review: the table's escape for a replaced source, or one another operation holds, with no effects is abort too.
test("abort cancels around a replaced source but not one that may have committed, and next offers it only then", async () => {
  const f = fixture();
  f.operation.projects[0]!.phase = "prepared";
  writeOperation(f.operation.id, f.operation, f.home);
  expect(publicOperation(readOperation(f.operation.id, f.home), undefined, { alpha: f.states.get("alpha")!, beta: f.states.get("beta")! }).next).toContain(`${C} abort ${f.operation.id}`);
  // Not inspected, or unreadable: whether this operation's hold still stands is uncertain, so abort is neither offered
  // nor accepted (status reads the sources; its failed reads count as uncertain too).
  expect(publicOperation(readOperation(f.operation.id, f.home)).next).not.toContain(`${C} abort ${f.operation.id}`);
  f.states.get("alpha")!.state = "unavailable";
  await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("alpha: the source reads as unavailable, so whether this operation's hold still stands is uncertain");
  f.states.set("alpha", { state: "running", instanceId: "replacement", version: "0.5.0", protocol: 9, peers: [], blockers: [], recovery: { operationId: "11111111-1111-1111-1111-111111111111", phase: "prepared", ready: true } });
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect((readOperation(f.operation.id, f.home) as { phase: string }).phase).toBe("cancelled");
  expect(f.calls).toEqual([]); // the replacement and the other operation's hold were left alone

  // This coordinator writes commitSent before every commit request, so a crashed prepared source with none was never
  // committed: abort, offered by the same predicate, cancels it.
  const crashed = fixture();
  crashed.operation.projects[0]!.phase = "prepared";
  writeOperation(crashed.operation.id, crashed.operation, crashed.home);
  crashed.states.get("alpha")!.state = "stopped";
  expect(abortRefusal(readOperation(crashed.operation.id, crashed.home), { alpha: { state: "stopped", peers: [], blockers: [] } })).toBeUndefined();
  await abortRecovery(crashed.operation.id, crashed.driver, crashed.home);
  expect((readOperation(crashed.operation.id, crashed.home) as { phase: string }).phase).toBe("cancelled");

  // An older coordinator writes no commitSent: its prepared source that is not running may have committed. Next does
  // not offer abort then (the same predicate), and abort refuses.
  const older = fixture();
  older.operation.sourceRoot = "/releases/source-older";
  older.operation.projects[0]!.phase = "prepared";
  writeOperation(older.operation.id, older.operation, older.home);
  older.states.get("alpha")!.state = "stopped";
  const stopped = { alpha: { state: "stopped", peers: [], blockers: [] } };
  expect(nextActions(readOperation(older.operation.id, older.home), undefined, stopped)).not.toContain(`${C} abort ${older.operation.id}`);
  expect(nextActions(readOperation(older.operation.id, older.home))).not.toContain(`${C} abort ${older.operation.id}`); // not inspected
  await expect(abortRecovery(older.operation.id, older.driver, older.home)).rejects.toThrow("alpha: the source is stopped and may have committed (this operation's coordinator does not record a sent commit)");

  const committing = fixture();
  committing.operation.projects[0]!.phase = "prepared";
  Object.assign(committing.operation, { step: "commit:alpha" }); // stopped before the request, e.g. a terminal not idle
  const sources = { alpha: committing.states.get("alpha")!, beta: committing.states.get("beta")! };
  expect(publicOperation(committing.operation, undefined, sources).next).toContain(`${C} abort ${committing.operation.id}`);
  committing.operation.projects[0]!.commitSent = true; // the commit request may have been sent
  expect(publicOperation(committing.operation, undefined, sources).next).not.toContain(`${C} abort ${committing.operation.id}`);
});

// #215 review: a coordinator from before #215 lacks dispose and refuses abort and resume on a lapsed hold (the #215
// loop): its operations are driven by the running release, and resume says what its own runner cannot do.
test("an operation from a coordinator without dispose is driven by the running release", async () => {
  const f = failedRestore();
  f.operation.sourceRoot = "/releases/source-older";
  for (const action of ["status", "resume", "abort"] as const) expect(recoveryCommand(f.operation, action)).toBe(`${C} ${action} ${f.operation.id}`);
  expect(recoveryCommand(f.operation, "dispose", "--stop-and-archive --reason <text>")).toBe(`${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  // This operation has effects, so its note names only what abort's predicate allows: stop-and-archive.
  expect(nextActions(f.operation)[0]).toBe(`${C} resume ${f.operation.id} (runs the coordinator that started this operation, which cannot re-prepare an expired hold: if it reports "source is no longer prepared", use stop-and-archive)`);
  // The abort named is this release's, which cancels a prepared source whose hold lapsed.
  const lapsed = fixture();
  lapsed.operation.sourceRoot = "/releases/source-older";
  lapsed.operation.projects[0]!.phase = "prepared";
  writeOperation(lapsed.operation.id, lapsed.operation, lapsed.home);
  const running = { alpha: lapsed.states.get("alpha")!, beta: lapsed.states.get("beta")! };
  expect(nextActions(readOperation(lapsed.operation.id, lapsed.home), undefined, running)).toContain(`${C} abort ${lapsed.operation.id}`);
  await abortRecovery(lapsed.operation.id, lapsed.driver, lapsed.home);
  expect((readOperation(lapsed.operation.id, lapsed.home) as { phase: string }).phase).toBe("cancelled");
});

// #215 review: a same-protocol downgrade target cannot read waivers, so a fresh session could never be released.
test("--fresh-session is neither offered nor accepted when the target cannot read recovery waivers", async () => {
  const f = failedRestore();
  f.operation.targetRoot = "/releases/target-without-waivers";
  writeOperation(f.operation.id, f.operation, f.home);
  const op = readOperation<RecoveryOperation>(f.operation.id, f.home);
  const next = nextActions(op, undefined, await liveProjects(op, f.driver.inspect));
  expect(next.some((line) => line.includes("--fresh-session codex"))).toBe(false);
  expect(next.every((line) => line.startsWith(C))).toBe(true); // commands only; the reason is its own status field
  expect(publicOperation(readOperation(f.operation.id, f.home)).freshSession).toBe("not offered: target 0.5.0 cannot read recovery waivers, so it could not release a new session");
  await expect(disposeRecovery(f.operation.id, { fresh: "codex" }, "lost", f.driver, f.home)).rejects.toThrow("--fresh-session is not available: target 0.5.0 cannot read recovery waivers");
});

// #215 review: a runner record that cannot be read is unknown, never "no runner" (and never a stale receipt).
test("an unreadable runner record reads as unknown in status and blocks nothing else", () => {
  const f = fixture();
  writeFileSync(`${join(f.home, "recovery", f.operation.id)}.json.runner.db`, "not a database");
  expect(recoveryRunner(f.operation.id, f.home)).toBe("unknown");
  f.operation.phase = "running";
  const status = publicOperation(f.operation, recoveryRunner(f.operation.id, f.home));
  expect(status).toMatchObject({ runner: { state: "unknown" }, next: [`${C} status ${f.operation.id} again: whether a runner holds the operation could not be read (resume, abort and dispose are refused until it can)`] });
  expect(status.stale).toBeUndefined();
  // A crash between creating the file and its table leaves no runner, as claimRunner (which creates the table) agrees.
  const path = `${join(f.home, "recovery", f.operation.id)}.json.runner.db`;
  rmSync(path);
  const empty = new Database(path);
  empty.run("PRAGMA user_version = 1"); empty.close();
  expect(recoveryRunner(f.operation.id, f.home)).toBeUndefined();
  claimRunner(f.operation.id, f.home)();
});

// #215 review: the disposition is on record before its first act, and abort defers to it.
test("stop-and-archive records its disposition before acting, and abort refuses while it is unfinished", async () => {
  const f = failedRestore();
  let recorded: unknown;
  f.driver.stopAndArchive = async () => { recorded = (readOperation(f.operation.id, f.home) as { disposition?: unknown }).disposition; throw new Error("crashed mid-stop"); };
  await expect(disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home)).rejects.toThrow("crashed mid-stop");
  expect(recorded).toMatchObject({ choice: "stop-and-archive", projects: {} });
  await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("stop-and-archive of this operation is partway");
  expect((await runRecovery(f.operation.id, f.driver, f.home)).error).toContain("stop-and-archive stopped partway and keeps the lock: crashed mid-stop");
  expect(recoveryLock(f.home)).toBe(f.operation.id);
});

// #215 review: `step` is rewritten on every resume; whether a commit may have been sent must survive it.
test("a sent commit stays on record across a failing resume, so abort is never offered for a source that may have committed", async () => {
  const f = fixture();
  f.driver.commit = async (p) => { f.calls.push(`commit:${p.id}`); f.states.set(p.id, { state: "stopping", peers: [], blockers: [] }); throw new Error("commit reply lost"); };
  const first = await runRecovery(f.operation.id, f.driver, f.home);
  expect(first.phase).toBe("blocked");
  expect(first.projects[0]!.commitSent).toBe(true);
  expect(publicOperation(first).next).not.toContain(`${C} abort ${f.operation.id}`);
  f.driver.stage = async () => { throw new Error("staging failed"); };
  const second = await runRecovery(f.operation.id, f.driver, f.home);
  expect(second.step).toBe("stage");
  expect(publicOperation(second).next).not.toContain(`${C} abort ${f.operation.id}`);
  await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("abort refused: alpha: its commit request may have been sent");
});

// #215 review: "make a new plan" is impossible while this operation holds the lock.
// Resume can never get past a replaced source, so it is not offered either.
test("a changed untouched source names abort, and stop-and-archive once another project has effects", async () => {
  const f = fixture();
  f.states.get("alpha")!.instanceId = "replacement";
  expect((await runRecovery(f.operation.id, f.driver, f.home)).error).toBe(`alpha: source runtime changed; next actions: ${C} abort ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  f.operation.projects[1]!.phase = "verified";
  writeOperation(f.operation.id, f.operation, f.home);
  expect((await runRecovery(f.operation.id, f.driver, f.home)).error).toBe(`alpha: source runtime changed; next actions: ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
});

// #215 review: a planned fresh start has nothing to lose; a fresh-session choice would record a loss that is not one.
test("a failed planned fresh start offers resume and stop-and-archive, and refuses --fresh-session", async () => {
  const f = failedRestore();
  f.plan.projects[0]!.freshStart = ["codex"];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  writeOperation(f.operation.id, f.operation, f.home);
  const op = readOperation<RecoveryOperation>(f.operation.id, f.home);
  expect(nextActions(op, undefined, await liveProjects(op, f.driver.inspect))).toEqual([`${C} resume ${f.operation.id}`, `${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`]);
  await expect(disposeRecovery(f.operation.id, { fresh: "codex" }, "lost", f.driver, f.home)).rejects.toThrow("codex: its plan already restarts it as a new session");
});

test("stop-and-archive says when another operation holds a source, and lock refusals name the coordinator", async () => {
  const f = expiredLease();
  f.states.get("alpha")!.recovery = { operationId: "11111111-1111-1111-1111-111111111111", phase: "prepared", ready: true };
  const op = await disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home);
  expect(op.disposition?.projects.alpha).toBe("source left running (held by another operation, 11111111-1111-1111-1111-111111111111)");

  const g = fixture();
  expect(activeOperation(g.operation.id, g.home)).toBe(`recovery operation ${g.operation.id} is active; ${C} status ${g.operation.id} lists what to do next`);
});

// #215 review: a #215 coordinator records a commit request first, so a prepared source found stopped without one crashed
// before any commit: there is nothing to start from, and the phase stays prepared (abort applies without effects).
test("a stopped prepared source with no commit request stays prepared and names abort, or stop-and-archive with effects", async () => {
  const f = fixture();
  f.operation.projects[0]!.phase = "prepared";
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.set("alpha", { state: "stopped", peers: [], blockers: [] });
  const blocked = await runRecovery(f.operation.id, f.driver, f.home);
  expect(blocked.projects[0]!.phase).toBe("prepared");
  // Resume could never get past it, so it is not offered.
  expect(blocked.error).toBe(`alpha: the source stopped while prepared and no commit was requested, so there is nothing to restore; next actions: ${C} abort ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  expect(f.calls.some((call) => call.startsWith("start:") || call.startsWith("commit:"))).toBe(false);
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect((readOperation(f.operation.id, f.home) as { phase: string }).phase).toBe("cancelled");

  // The incident shape: a terminal was already closed, so the way out is stop-and-archive.
  const g = fixture();
  Object.assign(g.operation.projects[0]!, { phase: "prepared", terminals: { "closed:claude": true } });
  writeOperation(g.operation.id, g.operation, g.home);
  g.states.set("alpha", { state: "stopped", peers: [], blockers: [] });
  const withEffects = await runRecovery(g.operation.id, g.driver, g.home);
  expect(withEffects.projects[0]!.phase).toBe("prepared");
  expect(withEffects.error).toContain(`${C} dispose ${g.operation.id} --stop-and-archive --reason <text>`);
  expect(withEffects.error).not.toContain(" abort ");
});

// #215 review: every error takes its choices from nextActions. Two projects: alpha may have committed (commitSent, no
// effects yet), beta's source was replaced. Abort would refuse because of alpha, so beta's error must not offer it.
test("an error lists only the choices abort's predicate allows, the same as status", async () => {
  const f = fixture();
  Object.assign(f.operation.projects[0]!, { phase: "prepared", commitSent: true });
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.get("alpha")!.recovery = { operationId: f.operation.id, phase: "prepared", ready: true };
  f.states.get("beta")!.instanceId = "replacement";
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  expect(result.error).toStartWith("beta: source runtime changed; next actions: ");
  expect(result.error).not.toContain(`${C} abort`);
  await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("alpha: its commit request may have been sent");
  const status = publicOperation(result, undefined, { alpha: f.states.get("alpha")!, beta: f.states.get("beta")! }).next
    .map((line) => line.replace(" (after the next action in error)", ""));
  expect(result.error).toEndWith(`next actions: ${status.join(" | ")}`);
});

test("--fresh-session is decided per project: a planned fresh start elsewhere does not refuse it", async () => {
  const f = failedRestore();
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  f.plan.projects[0]!.freshStart = ["codex"]; // alpha: nothing to lose
  f.plan.projects[1]!.terminals = [{ peer: "codex", handle: "term-beta", incarnationId: "inc-b", worktreeId: "wt", projectRoot: "/beta", sessionId: "t-beta", launch, launchMetadata: launch }];
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  Object.assign(f.operation.projects[1]!, { phase: "started", instanceId: "new-beta", terminals: { "closed:codex": true, "restored:codex": "failed" } });
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.set("beta", { state: "running", instanceId: "new-beta", version: "0.5.0", protocol: 10, peers: [], blockers: [], recovery: { operationId: f.operation.id, phase: "restored", ready: true } });
  const op = await disposeRecovery(f.operation.id, { fresh: "codex" }, "beta's thread is gone", f.driver, f.home);
  expect(op.projects[0]!.fresh).toBeUndefined();
  expect(op.projects[1]!.fresh?.codex).toMatchObject({ lost: "t-beta" });
});

// #215 review: with no effects abort can apply, so the runner's error reads every source as status does. Alpha is
// prepared (its hold may stand), beta was replaced: reading beta alone would leave out the abort status offers.
test("a runner error with no effects reads every source, so its choices are status's", async () => {
  const f = fixture();
  f.operation.projects[0]!.phase = "prepared";
  writeOperation(f.operation.id, f.operation, f.home);
  f.states.get("beta")!.instanceId = "replacement";
  const result = await runRecovery(f.operation.id, f.driver, f.home);
  const status = publicOperation(result, undefined, await liveProjects(result, f.driver.inspect)).next;
  expect(status).toEqual([`${C} abort ${f.operation.id}`, `${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`]); // no resume past a replaced source
  expect(result.error).toBe(`beta: source runtime changed; next actions: ${status.join(" | ")}`);
});

// #215 review: a crashed daemon's manifest stays on disk. Read by the real inspection it is stopped, not unavailable
// forever, so the stopped-with-no-commit row is reachable: abort cancels it, and with effects stop-and-archive ends it.
test("a crashed prepared source read by the real inspection can be aborted or stopped and archived", async () => {
  const crash = (f: ReturnType<typeof fixture>) => {
    const root = mkdtempSync(join(tmpdir(), "ahub-crashed-source-")); homes.push(root);
    writeFileSync(join(root, "control-token"), "token\n");
    writeFileSync(join(root, "status.json"), JSON.stringify({ controlPort: 1, protocol: PROTOCOL, projectId: "alpha", instanceId: "old-alpha", cwd: root, pid: Bun.spawnSync(["true"]).pid }));
    const fake = f.driver.inspect;
    f.driver.inspect = (p) => p.id === "alpha" ? inspectRecovery({ ...p, root, stateDir: root }) : fake(p);
  };
  const f = fixture();
  crash(f);
  f.operation.projects[0]!.phase = "prepared";
  writeOperation(f.operation.id, f.operation, f.home);
  const blocked = await runRecovery(f.operation.id, f.driver, f.home);
  expect(blocked.error).toBe(`alpha: the source stopped while prepared and no commit was requested, so there is nothing to restore; next actions: ${C} abort ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect((readOperation(f.operation.id, f.home) as { phase: string }).phase).toBe("cancelled");
  expect(recoveryLock(f.home)).toBeUndefined();

  const g = fixture();
  crash(g);
  Object.assign(g.operation.projects[0]!, { phase: "prepared", terminals: { "closed:claude": true } });
  writeOperation(g.operation.id, g.operation, g.home);
  const op = await disposeRecovery(g.operation.id, { stop: true }, "source crashed", g.driver, g.home);
  expect(op.phase).toBe("cancelled");
  expect(op.disposition?.projects.alpha).toBe("stopped");
  expect(recoveryLock(g.home)).toBeUndefined();
});

// #215 review: `next` and the commands, held together by an invariant. One project, no peers; each receipt state is
// crossed with what its runtime (the source before the commit, the target after) reads as, and an older coordinator's
// operation is run by this runner. Abort, stop-and-archive and --fresh-session codex are offered exactly when the
// command accepts them on a twin fixture; where resume is offered, resuming makes progress (a receipt changes or the
// operation completes) or its error names a step a person takes first.
test("next offers exactly what the commands accept, and resume only where it can get past what is live", async () => {
  const staged = (op: RecoveryOperation) => Object.assign(op, { targetRoot: PACKAGE_ROOT, targetDigest: "target-digest" });
  const receipts: Record<string, (op: RecoveryOperation) => void> = {
    pending: () => {},
    prepared: (op) => { op.projects[0]!.phase = "prepared"; },
    "prepared, commit sent": (op) => { Object.assign(op.projects[0]!, { phase: "prepared", commitSent: true }); },
    "prepared, older coordinator": (op) => { op.sourceRoot = "/releases/source-older"; op.projects[0]!.phase = "prepared"; },
    "prepared, terminal closed": (op) => { Object.assign(op.projects[0]!, { phase: "prepared", terminals: { "closed:claude": true } }); },
    stopped: (op) => { staged(op); Object.assign(op.projects[0]!, { phase: "stopped", commitSent: true }); },
    started: (op) => { staged(op); Object.assign(op.projects[0]!, { phase: "started", commitSent: true, instanceId: "new-alpha" }); },
    "started, codex restoration failed": (op) => {
      staged(op);
      const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
      op.plan.projects[0]!.terminals = [{ peer: "codex", handle: "term-codex", incarnationId: "inc", worktreeId: "wt", projectRoot: "/alpha", sessionId: "t1", launch, launchMetadata: launch }];
      const { fingerprint: _ignored, ...body } = op.plan;
      op.plan.fingerprint = planFingerprint(body);
      Object.assign(op.projects[0]!, { phase: "started", commitSent: true, instanceId: "new-alpha", terminals: { "closed:codex": true, "restored:codex": "failed" } });
    },
    "peers restored": (op) => { staged(op); Object.assign(op.projects[0]!, { phase: "peers-restored", commitSent: true, instanceId: "new-alpha" }); },
    "stop-and-archive partway": (op) => { op.disposition = { choice: "stop-and-archive", at: 0, projects: {} }; },
  };
  const source: Inspection = { state: "running", instanceId: "old-alpha", version: "0.5.0", protocol: 9, peers: [], blockers: [] };
  const bare = (state: string, snapshot?: string): Inspection => ({ state, peers: [], blockers: [], ...(snapshot ? { snapshot } : {}) });
  const lives: Record<string, (op: RecoveryOperation) => Inspection> = {
    "as planned": (op) => ["pending", "prepared"].includes(op.projects[0]!.phase) ? source
      : op.projects[0]!.phase === "stopped" ? bare("stopped", op.id)
      : { state: "running", instanceId: "new-alpha", version: "0.5.0", protocol: 10, peers: [], blockers: [], recovery: { operationId: op.id, phase: "restored", ready: true } },
    replaced: () => ({ ...source, instanceId: "replacement" }),
    "held by another operation": () => ({ ...source, recovery: { operationId: "other-operation", phase: "prepared", ready: true } }),
    crashed: () => bare("stopped"),
    "crashed, snapshot kept": (op) => bare("stopped", op.id),
    unavailable: () => bare("unavailable"),
    starting: () => bare("starting"),
    stopping: () => bare("stopping"),
    incompatible: () => bare("incompatible"),
    missing: () => bare("missing"),
  };
  const make = (receipt: string, live: string) => {
    const f = fixture("upgrade", ["alpha"]);
    receipts[receipt]!(f.operation);
    writeOperation(f.operation.id, f.operation, f.home);
    f.states.set("alpha", lives[live]!(f.operation));
    // As the daemon and the real driver do: prepare refuses another operation's hold, commit leaves the snapshot, and
    // only this operation's unreleased snapshot starts a target.
    const { prepare, commit, start } = f.driver;
    f.driver.prepare = async (p, id, instance) => {
      const hold = f.states.get(p.id)!.recovery;
      if (hold?.operationId && hold.operationId !== id && hold.phase !== "released") throw new Error("another recovery operation is active");
      await prepare(p, id, instance);
    };
    f.driver.commit = async (p, id, instance) => { await commit(p, id, instance); f.states.get(p.id)!.snapshot = id; };
    f.driver.start = async (p, op) => {
      if (f.states.get(p.id)!.snapshot !== op.id) throw new Error("committed restart snapshot is missing or belongs to another operation");
      await start(p, op);
    };
    return f;
  };
  const accepts = (attempt: Promise<unknown>) => attempt.then(() => true, () => false);
  const receiptsOf = (op: RecoveryOperation) => JSON.stringify([op.phase === "completed", op.projects, op.pluginInstalled, op.globalInstalled]);
  const human = (error = "") => /\b(first|before resuming|wait until|once it answers)\b/.test(error.split("; next actions: ")[0]!);
  const verdicts: { at: string; wrong: string[] }[] = [];
  for (const receipt of Object.keys(receipts)) for (const live of Object.keys(lives)) {
    const at = `${receipt} / ${live}`, wrong: string[] = [];
    const f = make(receipt, live), id = f.operation.id;
    const initial = readOperation<RecoveryOperation>(id, f.home);
    const next = nextActions(initial, undefined, await liveProjects(initial, f.driver.inspect));
    const twin = () => make(receipt, live);
    const abort = twin(), stop = twin(), fresh = twin();
    const offered = {
      abort: next.includes(`${C} abort ${id}`),
      stop: next.some((line) => line.includes(`${C} dispose ${id} --stop-and-archive`)),
      fresh: next.includes(`${C} dispose ${id} --fresh-session codex --reason <text>`),
    };
    const accepted = {
      abort: await accepts(abortRecovery(abort.operation.id, abort.driver, abort.home)),
      stop: await accepts(disposeRecovery(stop.operation.id, { stop: true }, "invariant", stop.driver, stop.home)),
      fresh: await accepts(disposeRecovery(fresh.operation.id, { fresh: "codex" }, "invariant", fresh.driver, fresh.home)),
    };
    for (const command of ["abort", "stop", "fresh"] as const) {
      if (offered[command] !== accepted[command]) wrong.push(`${command} offered ${offered[command]}, accepted ${accepted[command]}`);
    }
    if (offered.stop && !next.at(-1)!.includes("--stop-and-archive")) wrong.push("stop-and-archive is not the last entry");
    for (let run = 0; run < 4; run++) {
      const op = readOperation<RecoveryOperation>(id, f.home);
      if (op.phase === "completed") break;
      if (!nextActions(op, undefined, await liveProjects(op, f.driver.inspect)).some((line) => line.startsWith(`${C} resume `))) break;
      const after = await runRecovery(id, f.driver, f.home);
      if (receiptsOf(after) !== receiptsOf(op)) continue;
      // Resume was offered and changed nothing: its error must name what a person does first.
      if (!human(after.error)) wrong.push(`resume offered, no progress, no human step: ${after.error}`);
      break;
    }
    verdicts.push({ at, wrong });
  }
  expect(verdicts).toHaveLength(Object.keys(receipts).length * Object.keys(lives).length); // every case was judged
  expect(verdicts.filter((v) => v.wrong.length)).toEqual([]);
});

// #215 review: a staging refusal holds for every resume (the target release and preserved source are fixed), so it is
// recorded and `next` stops offering resume; with nothing done yet, abort ends it.
test("a final staging refusal is recorded and next no longer offers resume", async () => {
  const f = fixture();
  f.driver.stage = async () => { throw new FinalRefusal("target protocol requires a newer coordinator; staged package retained, runtimes unchanged"); };
  const blocked = await runRecovery(f.operation.id, f.driver, f.home);
  expect(blocked.final).toBe(true);
  expect(blocked.error).toBe(`target protocol requires a newer coordinator; staged package retained, runtimes unchanged; next actions: ${C} abort ${f.operation.id} | ${C} dispose ${f.operation.id} --stop-and-archive --reason <text>`);
  await abortRecovery(f.operation.id, f.driver, f.home);
  expect((readOperation(f.operation.id, f.home) as { phase: string }).phase).toBe("cancelled");
});

// #215 review: the protocol and waiver checks belong to the staged bytes. A probe that does not answer (killed: exit 1)
// is retried before the first staging, never recorded final, and is not run again once these bytes were staged.
test("a failing staging probe is retried, and never run again once the target was staged", async () => {
  const f = fixture("restart");
  const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  f.operation.sourceRoot = PACKAGE_ROOT;
  Object.assign(f.plan, { sourceRoot: PACKAGE_ROOT, version, sourceDigest: packageDigest(PACKAGE_ROOT) });
  const { fingerprint: _ignored, ...body } = f.plan;
  f.plan.fingerprint = planFingerprint(body);
  writeOperation(f.operation.id, f.operation, f.home);
  const answered = { code: 0, stdout: `${PROTOCOL}\n`, stderr: "" }, killed = { code: 1, stdout: "", stderr: "" };
  let probe = killed, probes = 0;
  const real = makeRecoveryDriver(async () => { probes++; return probe; });
  f.driver.stage = real.stage;
  const first = await runRecovery(f.operation.id, f.driver, f.home);
  expect(first.error).toStartWith("the staged target's control protocol could not be read (probe exit 1)");
  expect(first.final).toBeUndefined();
  expect(nextActions(first, undefined, await liveProjects(first, f.driver.inspect)).some((line) => line.startsWith(`${C} resume `))).toBe(true);

  // Staged once (the runner records the digest), and a project is far along: a killed probe cannot refuse it now.
  probe = answered;
  const target = await real.stage(first);
  Object.assign(first, { targetRoot: target.root, targetDigest: target.digest });
  Object.assign(first.projects[0]!, { phase: "peers-restored", commitSent: true, instanceId: "new-alpha" });
  first.projects[1]!.phase = "verified";
  writeOperation(f.operation.id, first, f.home);
  f.states.set("alpha", { state: "running", instanceId: "new-alpha", version, protocol: PROTOCOL, peers: [], blockers: [], recovery: { operationId: f.operation.id, phase: "restored", ready: true } });
  probe = killed;
  const before = probes;
  const done = await runRecovery(f.operation.id, f.driver, f.home);
  expect(done.phase).toBe("completed");
  expect(done.final).toBeUndefined();
  expect(probes).toBe(before);
});

// #215 review: a failed receipt whose planned session is attached again lost nothing: resume records it as restored, so
// --fresh-session is neither offered nor accepted (it would audit a loss that never happened). Without an inspection
// that shows it, the receipt alone decides, as before.
test("--fresh-session is neither offered nor accepted while the planned session is attached again", async () => {
  const f = failedRestore();
  f.states.get("alpha")!.peers = [{ id: "codex", state: "idle", threadId: "t1" }];
  const op = readOperation<RecoveryOperation>(f.operation.id, f.home);
  const live = await liveProjects(op, f.driver.inspect);
  expect(nextActions(op, undefined, live).some((line) => line.includes("--fresh-session"))).toBe(false);
  expect(nextActions(op).some((line) => line.includes("--fresh-session codex"))).toBe(true); // not inspected: the receipt decides
  await expect(disposeRecovery(f.operation.id, { fresh: "codex" }, "lost", f.driver, f.home)).rejects.toThrow("codex: its planned session is attached again, so nothing was lost");
  expect(readOperation<RecoveryOperation>(f.operation.id, f.home).audit).toBeUndefined();
});

// #227: an older coordinator's runner never reads `disposition`, and an older global `ahub recovery resume` runs it.
// Every older runner and abort refuses a receipt whose schema is not 1 before the lock and the runner claim.
test("stop-and-archive on an older coordinator's operation writes schema 2 with its disposition; a #215 one keeps 1", async () => {
  const older = failedRestore();
  older.operation.sourceRoot = "/releases/source-older";
  writeOperation(older.operation.id, older.operation, older.home);
  const stop = older.driver.stopAndArchive;
  let recorded: RecoveryOperation | undefined;
  older.driver.stopAndArchive = async () => { recorded = readOperation(older.operation.id, older.home); throw new Error("crashed mid-stop"); };
  await expect(disposeRecovery(older.operation.id, { stop: true }, "give up", older.driver, older.home)).rejects.toThrow("crashed mid-stop");
  expect(recorded).toMatchObject({ schema: 2, disposition: { choice: "stop-and-archive" } }); // the same write, before the first act
  // This release reads it as before: status, resume refuses it, abort refuses it, and a dispose rerun finishes it.
  const op = readOperation<RecoveryOperation>(older.operation.id, older.home);
  expect(publicOperation(op, undefined, await liveProjects(op, older.driver.inspect)).next).toEqual([`rerun ${C} dispose ${op.id} --stop-and-archive --reason <text>`]);
  expect((await runRecovery(op.id, older.driver, older.home)).error).toContain("stop-and-archive stopped partway and keeps the lock: crashed mid-stop");
  await expect(abortRecovery(op.id, older.driver, older.home)).rejects.toThrow("stop-and-archive of this operation is partway");
  older.driver.stopAndArchive = stop;
  const done = await disposeRecovery(op.id, { stop: true }, "finish", older.driver, older.home);
  expect(done).toMatchObject({ schema: 2, phase: "cancelled" });
  expect(recoveryLock(older.home)).toBeUndefined();

  const current = failedRestore(); // preserved by this package: a #215 coordinator, whose runner refuses a disposition itself
  expect((await disposeRecovery(current.operation.id, { stop: true }, "give up", current.driver, current.home)).schema).toBe(1);
});

test("a receipt's schema is 1, or 2 only with a disposition; anything else is refused before any act", async () => {
  for (const schema of [2, 3, 0]) {
    const f = fixture();
    writeOperation(f.operation.id, { ...f.operation, schema }, f.home);
    await expect(runRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("unsupported operation receipt");
    await expect(abortRecovery(f.operation.id, f.driver, f.home)).rejects.toThrow("unsupported operation receipt");
    await expect(disposeRecovery(f.operation.id, { stop: true }, "give up", f.driver, f.home)).rejects.toThrow("unsupported operation receipt");
    expect(f.calls).toEqual([]);
    expect(recoveryRunner(f.operation.id, f.home)).toBeUndefined();
  }
});

test("a dispose rerun moves a disposition 0.12.20 recorded at schema 1 on an older coordinator's operation to schema 2", async () => {
  const f = failedRestore();
  // What 0.12.20 left: an older coordinator's operation, its stop-and-archive recorded at schema 1 and stopped partway.
  Object.assign(f.operation, { sourceRoot: "/releases/source-older", disposition: { choice: "stop-and-archive", at: 1, projects: {} } });
  writeOperation(f.operation.id, f.operation, f.home);
  // Even a rerun that refuses (a hub that cannot be read) holds the runner claim long enough to move it.
  f.states.set("beta", { ...f.states.get("beta")!, state: "unavailable" });
  await expect(disposeRecovery(f.operation.id, { stop: true }, "finish", f.driver, f.home)).rejects.toThrow("beta: its hub reads as unavailable");
  expect(readOperation<RecoveryOperation>(f.operation.id, f.home).schema).toBe(2);
  expect(f.calls).toEqual([]);
});
