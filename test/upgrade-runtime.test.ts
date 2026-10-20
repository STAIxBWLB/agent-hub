import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { inspectProject } from "../src/hub/lifecycle.ts";
import { endPlannedPeer, inspectRecovery, makeRecoveryDriver, makeUpgradePlan, PACKAGE_ROOT, restoredTerminalArgv } from "../src/cli/upgrade-runtime.ts";

/** The test operations preserve this package as their coordinator, which has every recovery command (#215). */
const COORD = `bun ${join(PACKAGE_ROOT, "src/cli/main.js")} recovery`;
import { VERSION } from "../src/version.ts";
import { packageDigest } from "../src/cli/recovery-package.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";
import { createOperation, disposeRecovery, liveProjects, nextActions, planFingerprint, publicOperation, recordRestart, type Inspection, type PlannedProject, type ProjectProgress, type RecoveryOperation, type UpgradePlan } from "../src/cli/upgrade.ts";
import type { TerminalBinding } from "../src/cli/terminal-recovery.ts";
import { realPath } from "../src/hub/project.ts";
import { readOperation, recoveryLock, writeOperation } from "../src/hub/recovery-store.ts";

test("delegated staging refuses an older target before protocol probes or runtime effects, including cached targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-old-live-test-target-"));
  for (const dir of ["src/cli", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.0.0" }));
  writeFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(join(root, "src/cli/main.js"), "throw new Error('old target must not execute');");
  writeFileSync(join(root, "src/cli/identity.ts"), "export const oldIdentity = true;");
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: JSON.stringify({ protocol: PROTOCOL, features: [] }), stderr: "" }; };
  const op = { sourceRoot: root, plan: { kind: "restart", version: "0.0.0", sourceDigest: packageDigest(root), projects: [] } } as unknown as RecoveryOperation;
  try {
    const delegated = makeRecoveryDriver(run, "codex");
    await expect(delegated.stage(op)).rejects.toThrow("target does not support live-test delegation");
    op.targetRoot = root; op.targetDigest = packageDigest(root);
    await expect(delegated.stage(op)).rejects.toThrow("runtimes unchanged");
    expect(calls).toEqual([]);
    expect(await makeRecoveryDriver(run).stage(op)).toMatchObject({ root });
    writeFileSync(join(root, "src/cli/identity.ts"), "export const LIVE_TEST_SUPPORTED = true;");
    op.plan.sourceDigest = packageDigest(root); delete op.targetDigest;
    expect(await delegated.stage(op)).toMatchObject({ root });
    expect(calls).toHaveLength(2);
    op.plan.projects = [{ source: { peers: [{ id: "local", state: "idle" }] } }] as PlannedProject[];
    op.targetRoot = root; op.targetDigest = packageDigest(root);
    expect(await delegated.stage(op)).toMatchObject({ root });
    expect(calls).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("delegated recovery target startup retains its initiating peer and explicit CLI authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-delegated-target-"));
  const project = { id: "p-delegated", root, stateDir: join(root, "state"), basePort: 0, instanceId: null, pid: null };
  mkdirSync(project.stateDir);
  const op = { id: crypto.randomUUID(), targetRoot: "/candidate", plan: { projects: [{ project }] } } as RecoveryOperation;
  writeFileSync(join(project.stateDir, "restart.json"), JSON.stringify({ projectId: project.id, projectRoot: root, operationId: op.id }));
  const calls: { argv: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const driver = makeRecoveryDriver(async (argv, options) => {
    calls.push({ argv, env: options?.env }); return { code: 0, stdout: "", stderr: "" };
  }, "codex");
  try {
    await driver.start(project, op);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([process.execPath, "/candidate/src/cli/main.js", "--project", root, "--live-test", "up"]);
    expect(calls[0]!.env?.AGENTHUB_PEER_ID).toBe("codex");
    expect(calls[0]!.env?.AGENTHUB_RECOVERY_OPERATION).toBe(op.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
import { Registry } from "../src/hub/registry.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { readRecoveryWaivers, waiveRecoveryPeers } from "../src/hub/restart.ts";
import { BasePeer } from "../src/hub/peers.ts";

// #206: a plain `claude` is attached while claude-session.json still holds the session an earlier, ended
// `ahub claude` launch recorded, and the project terminal it runs in shows no agent identity.
test("an unmanaged Claude with a stale session record is planned reconnect-only and the old session id is never named", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-unmanaged-claude-")));
  mkdirSync(join(temp, "project"));
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  const registry = new Registry(join(temp, "home", "registry.db"));
  const project = registry.register(join(temp, "project"));
  registry.close();
  const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, instanceId: "i-live", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const claude = await ControlClient.connect(project.stateDir, { role: "peer", peer: "claude" });
  const ended = Bun.spawnSync(["true"]).pid; // the earlier launcher: its pid no longer runs
  const record = (launchId: string, sessionId: string, launcherPid: number, launcherSignature: string, handle: string) => {
    writeFileSync(join(project.stateDir, "claude-launch.json"), JSON.stringify({ instanceId: "i-live", launchId }));
    writeFileSync(join(project.stateDir, "claude-session.json"), JSON.stringify({ at: 1, instanceId: "i-live", sessionId, launchId }));
    writeFileSync(join(project.stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "claude", projectRoot: project.root, stateDir: project.stateDir, instanceId: "i-live",
      launcherPid, launcherSignature, launchId, handle, incarnationId: `inc-${handle}`, worktreeId: "wt", env: {} }]));
  };
  const unmanagedTerminal = { handle: "term-plain", incarnationId: "inc-plain", worktreeId: "wt", worktreePath: project.root, connected: true };
  const managedTerminal = { handle: "term-managed", incarnationId: "inc-term-managed", worktreeId: "wt", worktreePath: project.root, connected: true };
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    const result = argv[2] === "list" ? { terminals: [unmanagedTerminal, managedTerminal] } : { terminal: argv.includes("term-managed") ? managedTerminal : unmanagedTerminal };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  try {
    record("launch-old", "a9ac5acc-stale", ended, "signature-of-ended-launcher", "term-old");
    for (let n = 0; n < 100 && (await inspectRecovery(project)).peers.find((p) => p.id === "claude")?.state !== "idle"; n++) await Bun.sleep(10);
    expect((await inspectRecovery(project)).peers.find((p) => p.id === "claude")?.sessionId).toBe("a9ac5acc-stale"); // the daemon still reports the stale record

    const plan = await makeUpgradePlan("restart", VERSION, project.root, run);
    expect(plan.projects[0]?.reconnectOnly).toEqual(["claude"]);
    expect((plan.projects[0] as PlannedProject & { unrecordedTerminals?: string[] }).unrecordedTerminals).toEqual(["claude"]);
    expect(plan.projects[0]?.blockers).toEqual([]);
    expect(plan.projects[0]?.terminals).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("a9ac5acc-stale");
    expect(calls).toEqual([]); // no terminal was inspected, let alone chosen, for the unmanaged session

    // The same daemon with a live recorded launcher whose launch wrote the record restores as before.
    record("launch-live", "session-live", process.pid, processSignature(process.pid)!, "term-managed");
    const managed = await makeUpgradePlan("restart", VERSION, project.root, run);
    expect(managed.projects[0]?.reconnectOnly).toBeUndefined();
    expect(managed.projects[0]?.blockers).toEqual([]);
    expect((managed.projects[0]?.terminals as { handle: string; sessionId: string }[]).map((t) => [t.handle, t.sessionId])).toEqual([["term-managed", "session-live"]]);

    // #228: a launch row that may be this Claude's but cannot be evaluated is unknown, never "no launcher": the plan
    // blocks the Claude instead of planning it reconnect-only.
    writeFileSync(join(project.stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "claude", projectRoot: project.root, instanceId: "i-live", launcherPid: "hand edit" }]));
    const invalid = await makeUpgradePlan("restart", VERSION, project.root, run);
    expect(invalid.projects[0]?.reconnectOnly).toBeUndefined();
    expect(invalid.projects[0]?.blockers.some((b) => b.startsWith("claude: a launch record in terminal-recovery.json that may be its launcher's cannot be read"))).toBe(true);
  } finally {
    claude.close(); await daemon.stop();
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    rmSync(temp, { recursive: true, force: true });
  }
});

for (const peer of ["codex", "pi"] as const) test(`#482 attached ${peer} TUI without a current live launcher or Orca session proof stays unrecorded, never fresh`, async () => {
  const temp = realPath(mkdtempSync(join(tmpdir(), "ahub-unrecorded-native-")));
  mkdirSync(join(temp, "project"));
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  const registry = new Registry(join(temp, "home", "registry.db"));
  const project = registry.register(join(temp, "project"));
  registry.close();
  const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, instanceId: "i-current", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  class NativeTuiLike extends BasePeer {
    async deliver(): Promise<void> {}
    async start(): Promise<void> { this.setState("idle"); }
    async stop(): Promise<void> { this.setState("offline"); }
    recoveryMetadata(): Record<string, unknown> {
      return { launch: { kind: peer, ...(peer === "pi" ? { mode: "tui" } : {}) }, ...(peer === "codex" ? { threadId: "recorded-thread" } : { sessionId: "recorded-session", sessionFile: join(temp, "pi-session.jsonl") }) };
    }
  }
  const native = new NativeTuiLike(peer);
  daemon.bus.add(native);
  await native.start();
  const terminal = { handle: "term-live", incarnationId: "inc-live", worktreeId: "wt", worktreePath: project.root, connected: true };
  const run = async (argv: string[]) => ({ code: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === "list" ? { terminals: [terminal] } : { terminal } }), stderr: "" });
  try {
    for (const evidence of ["absent", "current-gone", "older-live"] as const) {
      const file = join(project.stateDir, "terminal-recovery.json");
      if (evidence === "absent") rmSync(file, { force: true });
      else writeFileSync(file, JSON.stringify([{ peer, projectRoot: project.root, stateDir: project.stateDir,
        instanceId: evidence === "older-live" ? "i-older" : "i-current", launcherPid: process.pid,
        launcherSignature: evidence === "older-live" ? processSignature(process.pid) : "signature-of-replaced-process",
        launchId: `launch-${evidence}`, handle: terminal.handle, incarnationId: terminal.incarnationId, worktreeId: terminal.worktreeId, env: {} }]));
      const plan = await makeUpgradePlan("restart", VERSION, project.root, run);
      const planned = plan.projects[0] as PlannedProject & { unrecordedTerminals?: string[] };
      expect(planned.source.peers.find(row => row.id === peer)?.state).toBe("idle");
      if (peer === "pi") expect(planned.source.peers.find(row => row.id === peer)?.args?.mode).toBe("tui");
      expect(planned.unrecordedTerminals).toEqual([peer]);
      expect(planned.terminals).toEqual([]);
      expect(planned.freshStart).toBeUndefined();
      const guidance = planned.blockers.join("\n");
      expect(guidance).toContain("attached, launcher unrecorded");
      expect(guidance).toMatch(/end/i);
      expect(guidance).toMatch(/resume/i);
      expect(guidance).not.toContain("restarts headless");
      expect(guidance).not.toContain("restarts as a new session");
    }
  } finally {
    await daemon.stop();
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Pi terminal restoration builds a TUI command with the saved session selector", () => {
  const argv = restoredTerminalArgv("/target/src/cli/main.js", "/project", {
    peer: "pi", handle: "h", incarnationId: "i", worktreeId: "w", projectRoot: "/project", sessionId: "sid", sessionFile: "/state/pi-session.json", backend: "dgx", model: "dgx/coding",
    launch: { packageEntrypoint: "/old/main.js", command: "old", argv: [], env: {} }, launchMetadata: { packageEntrypoint: "/old/main.js", command: "old", argv: [], env: {} },
  });
  expect(argv).toEqual([process.execPath, "/target/src/cli/main.js", "--project", "/project", "pi", "--mode", "tui", "--backend", "dgx", "--model", "dgx/coding", "--session-file", "/state/pi-session.json"]);
});

// The #56 CI race: server.stop() precedes state-file removal, so a stopping hub briefly
// refuses connections with its manifest still on disk. inspectRecovery must report the
// transition as retryable "unavailable", never throw, and never infer stopped.
test("a stopping hub with its manifest still on disk inspects as unavailable without throwing", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ahub-stopping-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-stopping-state-"));
  // A port nothing listens on, standing in for the stopping hub's closed control listener.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = probe.port;
  probe.stop(true);
  writeFileSync(join(stateDir, "control-token"), "stopping-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: port, protocol: PROTOCOL, projectId: "p-stopping", instanceId: "i-stopping", cwd: projectRoot }));
  try {
    const observed = await inspectRecovery({ id: "p-stopping", root: projectRoot, stateDir, basePort: 4600 } as any);
    expect(observed.state).toBe("unavailable");
    expect(observed.blockers).toContain("runtime changed during recovery inspection");
    expect(observed.instanceId).toBe("i-stopping");
    expect(observed.protocol).toBe(PROTOCOL);
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(projectRoot, { recursive: true, force: true }); }
});

// #215 review: a manifest left by a dead pid is final whatever recovery protocol it names. Probing it read
// "unavailable" forever, which wedged abort, resume and stop-and-archive.
test("a manifest left by a dead daemon inspects as stopped and keeps its identity", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ahub-crashed-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-crashed-state-"));
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(stateDir, "control-token"), "crashed-token\n");
  try {
    for (const protocol of [PROTOCOL, 15]) {
      writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: 1, protocol, projectId: "p-crashed", instanceId: "i-crashed", cwd: projectRoot, pid: dead }));
      expect(await inspectRecovery({ id: "p-crashed", root: projectRoot, stateDir, basePort: 4600 } as any)).toEqual({ state: "stopped", peers: [], blockers: [], instanceId: "i-crashed", protocol });
    }
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(projectRoot, { recursive: true, force: true }); }
});

// issue #21: a peer whose TUI exited after prepare left nothing to close. closeTerminals
// must journal the close from inventory silence instead of failing a wait on a dead terminal.
test("closeTerminals treats an already-exited TUI as closed without issuing a terminal mutation", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "ahub-detached-project-"));
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-detached-state-"));
  // A fake source daemon holding a prepared lease, with codex detached.
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(_request, srv) { return srv.upgrade(_request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-detached", instanceId: "i-detached", cwd: projectRoot, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: "p-detached", instanceId: "i-detached", cwd: projectRoot, version: VERSION, protocol: PROTOCOL } }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: { operationId: "op-detached", phase: "prepared", ready: true, peers: { codex: { id: "codex", state: "offline" } } } }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "detached-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "p-detached", instanceId: "i-detached", cwd: projectRoot }));
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "terminal" && argv[2] === "list") return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: "" };
    throw new Error(`unexpected orca command: ${argv.join(" ")}`);
  };
  try {
    const driver = makeRecoveryDriver(run);
    const launch = { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js", argv: [], env: {} };
    const binding = { peer: "codex" as const, handle: "term-gone", incarnationId: "inc-gone", worktreeId: "repo::detached", projectRoot, sessionId: "thread-T", launch, launchMetadata: launch };
    const planned: PlannedProject = {
      project: { id: "p-detached", root: projectRoot, stateDir, instanceId: "i-detached", pid: null, basePort: 4600 },
      source: { state: "running", instanceId: "i-detached", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
      terminals: [binding], blockers: [],
    };
    const progress: ProjectProgress = { id: "p-detached", phase: "prepared", terminals: {} };
    const op = { id: "op-detached", plan: { version: VERSION } } as RecoveryOperation;
    await driver.closeTerminals(planned, progress, op, () => {});
    expect(progress.terminals["closed:codex"]).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((argv) => argv[1] === "terminal" && argv[2] === "list")).toBe(true); // an inventory read, never a wait or close
  } finally { server.stop(true); rmSync(stateDir, { recursive: true, force: true }); rmSync(projectRoot, { recursive: true, force: true }); }
});

// issue #21: a zero-turn Claude session never persisted a transcript, so --resume can never
// restore it and the pending-restored gate wedged. A fresh attach is accepted only then.
function claudeRestoreFixture(attachedSession: string, onStart?: (message: any, hello: any) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restore-claude-")));
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-restore-claude-state-"));
  const configDir = mkdtempSync(join(tmpdir(), "ahub-restore-claude-config-"));
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(_request, srv) { return srv.upgrade(_request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") { ws.data = msg; ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-restore", instanceId: "i-target", cwd: root, protocol: PROTOCOL })); }
      else if (msg.t === "start") { onStart?.(msg, ws.data); ws.send(JSON.stringify({ rid: msg.rid, t: "started", ok: true })); }
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: "p-restore", instanceId: "i-target", cwd: root, version: VERSION, protocol: PROTOCOL } }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: { operationId: "op-restore", phase: "restored", ready: true, peers: { claude: { id: "claude", state: "idle", sessionId: attachedSession } } } }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "restore-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "p-restore", instanceId: "i-target", cwd: root }));
  const fresh = { handle: "term-fresh", incarnationId: "inc-fresh", worktreeId: `repo::${root}`, worktreePath: root, agentIdentity: "claude", sessionId: attachedSession, connected: true };
  const run = async (argv: string[]) => {
    let result: unknown;
    if (argv[2] === "list") result = { terminals: [fresh] };
    else if (argv[2] === "show") result = { terminal: fresh };
    else if (argv[2] === "wait") result = { wait: { satisfied: true } };
    else throw new Error(`unexpected orca command: ${argv.join(" ")}`);
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js", argv: [], env: { CLAUDE_CONFIG_DIR: configDir } };
  const binding = { peer: "claude" as const, handle: "term-old", incarnationId: "inc-old", worktreeId: `repo::${root}`, projectRoot: root, sessionId: "session-S", launch, launchMetadata: launch };
  const planned: PlannedProject = {
    project: { id: "p-restore", root, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-target", version: VERSION, protocol: PROTOCOL, peers: [], blockers: [] },
    terminals: [binding], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-restore", instanceId: "i-target", phase: "peers-restored", terminals: { "restored:claude": "pending" } };
  const op = { id: "op-restore", targetRoot: "/target", plan: { version: VERSION } } as RecoveryOperation;
  const cleanup = () => { server.stop(true); for (const dir of [root, stateDir, configDir]) rmSync(dir, { recursive: true, force: true }); };
  return { root, configDir, cleanup, driver: makeRecoveryDriver(run), planned, progress, op };
}

test("delegated recovery restores a headless Pi through the real target CLI with its operation and session identity", async () => {
  const starts: any[] = [], hellos: any[] = [];
  const f = claudeRestoreFixture("unused", (message, hello) => { starts.push(message); hellos.push(hello); });
  const oldHome = process.env.AGENTHUB_HOME;
  const home = join(f.root, "home"); process.env.AGENTHUB_HOME = home;
  const registry = new Registry(); registry.register(f.root, f.planned.project.stateDir); registry.close();
  mkdirSync(join(f.root, ".agenthub"), { recursive: true });
  writeFileSync(join(f.root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  f.planned.terminals = [];
  f.planned.source.peers = [{ id: "pi", state: "idle", sessionId: "pi-saved", args: { mode: "headless", backend: "dgx", model: "saved-model" } }];
  f.op.targetRoot = PACKAGE_ROOT; f.op.plan.projects = [f.planned];
  const driver = makeRecoveryDriver(async (argv, options) => {
    const wrapper = join(f.root, "actual-recovery-cli.ts");
    writeFileSync(wrapper, `Object.assign(process.env, ${JSON.stringify(options?.env)});
for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete process.env[name];
process.env.CODEX_THREAD_ID = "delegated-codex-thread";
process.argv = ${JSON.stringify(argv)};
await import(${JSON.stringify(argv[1])});\n`);
    const child = Bun.spawn([process.execPath, wrapper], { cwd: f.root, env: options?.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0); return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  }, "codex");
  try {
    await driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(starts).toHaveLength(1);
    expect(hellos[0]).toMatchObject({ role: "console" });
    expect(starts[0]).toMatchObject({ t: "start", peer: "pi", operationId: f.op.id,
      args: { mode: "headless", backend: "dgx", model: "saved-model", sessionId: "pi-saved" } });
    expect(drainCliAudits(f.planned.project.stateDir)).toMatchObject([{ peer: "codex", command: "pi", outcome: "delegated" }]);
  } finally {
    if (oldHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHome;
    f.cleanup();
  }
}, 20_000);

test("a pending restored:claude accepts a fresh attach when the original session never persisted a transcript", async () => {
  const f = claudeRestoreFixture("session-F");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "claude", () => {});
    expect(f.progress.terminals["restored:claude"]).toMatchObject({ state: "done" });
    const recorded = (f.progress.terminals["restored:claude"] as any).binding;
    expect(recorded.sessionId).toBe("session-F"); // revalidated against the attach that actually exists
    expect(recorded.handle).toBe("term-fresh");
  } finally { f.cleanup(); }
});

test("a pending restored:claude with a transcript on disk keeps the strict identity check", async () => {
  const f = claudeRestoreFixture("session-F");
  try {
    const slug = f.root.replace(/[^a-zA-Z0-9]/g, "-");
    const transcript = join(f.configDir, "projects", slug);
    mkdirSync(transcript, { recursive: true });
    writeFileSync(join(transcript, "session-S.jsonl"), "{}\n");
    await expect(f.driver.restore(f.planned, f.progress, f.op, "claude", () => {})).rejects.toThrow("terminal creation outcome is uncertain");
    expect(f.progress.terminals["restored:claude"]).toBe("pending");
  } finally { f.cleanup(); }
});

test("recovery driver uses the source manifest protocol for a protocol-9 prepare", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-source-v9-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "ahub-source-v9-project-"));
  const seenVersions: number[] = [];
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(_request, srv) { return srv.upgrade(_request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) { const msg = JSON.parse(String(data)); if (msg.t === "hello") { seenVersions.push(msg.v); ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p9", instanceId: "i9", cwd: projectRoot, protocol: 9 })); } else { ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true })); } } },
  });
  writeFileSync(join(stateDir, "control-token"), "source-v9-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: 9, projectId: "p9", instanceId: "i9", cwd: projectRoot }));
  try {
    const driver = makeRecoveryDriver();
    await driver.prepare({ id: "p9", root: projectRoot, stateDir, basePort: 4600 } as any, "op9", "i9");
    expect(seenVersions).toEqual([9]);
  } finally { server.stop(true); rmSync(stateDir, { recursive: true, force: true }); rmSync(projectRoot, { recursive: true, force: true }); }
});

for (const change of ["incarnation", "session"] as const) {
  test(`production recovery verification rejects a changed ${change} without terminal mutation`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-review-runtime-")));
    const stateDir = join(root, "state");
    const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-review", instanceId: "i-review", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
    const consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    try {
      writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "i-review", sessionId: "session-original" }));
      expect((await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: "i-review", operationId: "op-review" })).ok).toBe(true);
      const terminal = { handle: "term-review", incarnationId: "inc-original", worktreeId: `repo::${root}`, worktreePath: root,
        agentIdentity: "claude", sessionId: "session-original", connected: true };
      const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
      const binding = { ...terminal, peer: "claude" as const, projectRoot: root, launch, launchMetadata: launch };
      const planned: PlannedProject = { project: { id: "p-review", root, stateDir, instanceId: "i-review", pid: process.pid, basePort: 0 },
        source: { state: "running", peers: [{ id: "claude", state: "idle", sessionId: "session-original" }], blockers: [] }, terminals: [binding], blockers: [] };
      const progress: ProjectProgress = { id: "p-review", instanceId: "i-review", phase: "peers-restored", terminals: { "restored:claude": binding } };
      const operation = { id: "op-review", plan: { version: VERSION } } as RecoveryOperation;
      const calls: string[][] = [];
      const driver = makeRecoveryDriver(async (argv) => {
        calls.push(argv);
        const current = { ...terminal, incarnationId: change === "incarnation" ? "inc-replaced" : "inc-original" };
        let result: unknown;
        if (argv[2] === "list") result = { terminals: [current] };
        else if (argv[2] === "show") result = { terminal: current };
        else if (argv[2] === "wait") {
          writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "i-review", sessionId: "session-replaced" }));
          result = { wait: { satisfied: true } };
        } else throw new Error("unexpected terminal mutation");
        return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      });
      await expect(driver.verify(planned, progress, operation)).rejects.toThrow(change === "incarnation" ? "saved terminal identity changed" : "daemon session changed");
      expect(calls.some((args) => ["close", "create", "send"].includes(args[2]!))).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).instanceId).toBe("i-review");
    } finally {
      peer.close(); consoleClient.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    }
  });
}


// issue #64: the original session never wrote a transcript, so the restore gate accepted a
// fresh session; verification must tolerate that mismatch, but only while the transcript
// is still absent (a first turn landing after the plan keeps the identity check strict).
test("production recovery verification tolerates a fresh zero-turn Claude session only while no transcript exists", async () => {
  for (const transcriptExists of [false, true] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-zeroturn-runtime-")));
    const stateDir = join(root, "state");
    const claudeConfig = join(root, "claude-config");
    if (transcriptExists) {
      const dir = join(claudeConfig, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session-original.jsonl"), "{}\n");
    }
    const daemon = await startDaemon({ cwd: root, stateDir, projectId: "p-review", instanceId: "i-review", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
    const consoleClient = await ControlClient.connect(stateDir, { role: "console" });
    const peer = await ControlClient.connect(stateDir, { role: "peer", peer: "claude" });
    try {
      // The restored session reports its fresh id from the start, exactly like the post-restore state.
      writeFileSync(join(stateDir, "claude-session.json"), JSON.stringify({ instanceId: "i-review", sessionId: "session-replaced" }));
      expect((await consoleClient.request({ t: "recovery", op: "prepare", expectedInstanceId: "i-review", operationId: "op-review" })).ok).toBe(true);
      const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CLAUDE_CONFIG_DIR: claudeConfig } };
      const terminal = { handle: "term-review", incarnationId: "inc-original", worktreeId: `repo::${root}`, worktreePath: root,
        agentIdentity: "claude", sessionId: "session-replaced", connected: true };
      const binding = { ...terminal, peer: "claude" as const, projectRoot: root, sessionId: "session-original", launch, launchMetadata: launch };
      const planned: PlannedProject = { project: { id: "p-review", root, stateDir, instanceId: "i-review", pid: process.pid, basePort: 0 },
        source: { state: "running", peers: [{ id: "claude", state: "idle", sessionId: "session-original" }], blockers: [] }, terminals: [binding], blockers: [] };
      const progress: ProjectProgress = { id: "p-review", instanceId: "i-review", phase: "peers-restored", terminals: { "restored:claude": { ...binding, sessionId: "session-replaced" } } };
      const operation = { id: "op-review", plan: { version: VERSION } } as RecoveryOperation;
      const driver = makeRecoveryDriver(async (argv) => {
        let result: unknown;
        if (argv[2] === "list") result = { terminals: [terminal] };
        else if (argv[2] === "show") result = { terminal };
        else if (argv[2] === "wait") result = { wait: { satisfied: true } };
        else throw new Error("unexpected terminal mutation");
        return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
      });
      if (transcriptExists) {
        await expect(driver.verify(planned, progress, operation)).rejects.toThrow("Claude resumed a different conversation");
      } else {
        // Tolerated: the run now stops at the later integrity readback (prepared, not restored).
        await expect(driver.verify(planned, progress, operation)).rejects.toThrow("preservation was not verified");
      }
    } finally {
      peer.close(); consoleClient.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true });
    }
  }
});

// #215: a fake hub that answers status and every recovery request with the given view.
function fakeHub(root: string, stateDir: string, instanceId: string, view: () => Record<string, unknown>, observe?: (message: Record<string, unknown>) => void) {
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data)); observe?.(msg);
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-215", instanceId, cwd: root, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: "p-215", instanceId, cwd: root, version: VERSION, protocol: PROTOCOL } }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: view() }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "token-215\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "p-215", instanceId, cwd: root }));
  return server;
}

test("a Codex thread without a rollout in its launcher's store is refused before its terminal is closed", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-codex-viability-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(codexHome, "sessions", "2026", "10", "09"), { recursive: true });
  const server = fakeHub(temp, stateDir, "i-source", () => ({ operationId: "op-215", phase: "prepared", ready: true, peers: { codex: { id: "codex", state: "idle", threadId: "thread-T" } } }));
  const shown = { handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-T", connected: true };
  let closed = false;
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    const result = argv[2] === "show" ? { terminal: shown } : argv[2] === "wait" ? { satisfied: true } : argv[2] === "close" ? (closed = true, {}) : { terminals: closed ? [] : [shown] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", phase: "prepared", terminals: {} };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  try {
    const driver = makeRecoveryDriver(run);
    await expect(driver.closeTerminals(planned, progress, op, () => {})).rejects.toThrow(`codex: thread thread-T has no resumable transcript under ${join(codexHome, "sessions")}; no terminal was closed`);
    expect(calls).toEqual([]);
    expect(progress.terminals).toEqual({});
    writeFileSync(join(codexHome, "sessions", "2026", "10", "09", "rollout-2026-10-09T00-00-00-thread-T.jsonl"), "{}\n");
    await driver.closeTerminals(planned, progress, op, () => {});
    expect(progress.terminals).toEqual({ "closed:codex": true });
    expect(calls.filter((argv) => argv[2] === "close")).toHaveLength(1);
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
});

test("a Codex restoration that cannot resume is receipted failed with both choices; a chosen fresh session is recorded under its new id", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-codex-restore-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home"), sessions = join(codexHome, "sessions", "2026", "10", "09");
  mkdirSync(stateDir); mkdirSync(sessions, { recursive: true });
  let attachedThread: string | undefined;
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true,
    peers: attachedThread ? { codex: { id: "codex", state: "idle", threadId: attachedThread } } : {} }));
  const ended = Bun.spawnSync(["true"]).pid;
  // What `ahub codex` writes in the terminal it runs in, before it execs codex.
  const record = (live: boolean, handle = "term-new") => writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "codex", projectRoot: temp, stateDir, instanceId: "i-target",
    launcherPid: live ? process.pid : ended, launcherSignature: live ? processSignature(process.pid) : "ended-launcher", launchId: `launch-${handle}`, handle, incarnationId: "inc-new", worktreeId: "wt", env: {} }]));
  let resumes = false; // whether the launched codex finds its session
  const replacement = { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-new", connected: true };
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "-e") return { code: 0, stdout: "function\n", stderr: "" }; // the target reads recovery waivers
    if (argv[2] === "wait" && attachedThread) return { code: 0, stdout: JSON.stringify({ ok: true, result: { wait: { satisfied: true } } }), stderr: "" };
    if (argv[2] === "create") { record(resumes); if (resumes) attachedThread = "thread-new"; }
    // The launch was typed into a login shell that outlives it: a codex that exits leaves a terminal that never
    // reads TUI-idle, and Orca answers each timed-out wait with exit 1 and error code "timeout".
    if (argv[2] === "wait" && !resumes) return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }), stderr: "" };
    const result = argv[2] === "create" ? { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt" } }
      : argv[2] === "show" ? { terminal: replacement }
      : argv[2] === "wait" ? { wait: { satisfied: true } } : { terminals: [replacement] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true, "restored:codex": "pending" } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    let elapsed = 0;
    const driver = makeRecoveryDriver(run, undefined, { now: () => elapsed, sleep: async (ms) => { elapsed += ms; } });
    // A pending create with no live launcher and no attached session left nothing to reconcile: failed.
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(progress.terminals["restored:codex"]).toEqual({ state: "failed" });

    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("resume launches it again once the cause is fixed");
    // The runner ends the error with these choices, the same list as status.
    expect(nextActions(op, undefined, await liveProjects(op, inspectRecovery))).toEqual([`${COORD} resume op-215`, `${COORD} dispose op-215 --fresh-session codex --reason <text>`, `${COORD} dispose op-215 --stop-and-archive --reason <text>`]);
    expect(progress.terminals["restored:codex"]).toEqual({ state: "failed" });
    expect(calls).toEqual([]); // no rollout: found before any terminal was created

    writeFileSync(join(sessions, "rollout-2026-10-09T00-00-00-thread-T.jsonl"), "{}\n");
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("the codex restoration launcher in terminal term-new exited before its TUI was ready");
    expect(progress.terminals["restored:codex"]).toEqual({ state: "failed" });
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    expect(calls.some((argv) => argv.includes("exit"))).toBe(false);

    // A failed receipt is settled by what is live: a launcher still running is waited for, never doubled.
    record(true);
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("attachment not verified within 600 s");
    expect(elapsed).toBe(600_000);
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "failed", binding: { handle: "term-new", incarnationId: "inc-new" } });
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    // ...and once the planned thread attached there, the failed receipt is the restoration.
    replacement.sessionId = "thread-T"; attachedThread = "thread-T";
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "thread-T" } });
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    // A fresh session chosen for it lost nothing when the original attaches after all.
    progress.terminals["restored:codex"] = "failed";
    progress.fresh = { codex: { lost: "thread-T", reason: "chosen before the original came back", at: 1 } };
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "thread-T" } });
    expect(progress.fresh).toBeUndefined();
    // A chosen new session found attached when a pending launch is settled is accepted with its waiver written here,
    // not only by the launch that normally writes it first.
    progress.terminals["restored:codex"] = "pending";
    progress.fresh = { codex: { lost: "thread-T", reason: "chosen", at: 1 } };
    replacement.sessionId = "thread-other"; attachedThread = "thread-other";
    rmSync(join(stateDir, "recovery-waivers.json"), { force: true });
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "thread-other" } });
    expect(readRecoveryWaivers(stateDir, "op-215")).toEqual({ codex: "fresh-session" });
    delete progress.fresh; rmSync(join(stateDir, "recovery-waivers.json"), { force: true });
    progress.terminals["restored:codex"] = "failed"; replacement.sessionId = "thread-new"; attachedThread = undefined;
    record(false);

    progress.fresh = { codex: { lost: "thread-T", reason: "test", at: 1 } };
    resumes = true;
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "thread-new" } });
    const create = calls.filter((argv) => argv[2] === "create").at(-1)!;
    expect(create[create.indexOf("--command") + 1]).toEndWith("'codex'");
    expect(readRecoveryWaivers(stateDir, "op-215")).toEqual({ codex: "fresh-session" });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: Codex writes a thread's rollout with its first message, so a thread with no turn has none yet. Which
// turns belong to which thread comes from the hub's own native_thread events; a detach forgets nothing.
test("a Codex thread with no rollout restarts fresh only while the hub saw it start and saw no turn on it", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-codex-zero-turn-")));
  mkdirSync(join(temp, "project"));
  const store = join(temp, "codex-home");
  mkdirSync(join(store, "sessions"), { recursive: true });
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  const registry = new Registry(join(temp, "home", "registry.db"));
  const project = registry.register(join(temp, "project"));
  registry.close();
  const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, instanceId: "i-zero", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  let thread = "thread-Z";
  class CodexLike extends BasePeer {
    async deliver(): Promise<void> {}
    async start(): Promise<void> { this.setState("idle"); }
    async stop(): Promise<void> { this.setState("offline"); }
    turn(): void { this.setState("busy"); this.setState("idle"); }
    recoveryMetadata(): Record<string, unknown> { return { launch: { kind: "codex" }, threadId: thread }; }
  }
  // What the daemon logs when the Codex adapter adopts a thread (onThread), in the hub's own event log.
  const adopt = (id: string, fresh: boolean) => appendFileSync(join(project.stateDir, "events.jsonl"), `${JSON.stringify({ v: 1, at: new Date().toISOString(), type: "native_thread", peer: "codex", thread: id, fresh })}\n`);
  const codex = new CodexLike("codex");
  daemon.bus.add(codex);
  await codex.start();
  const shown = () => ({ handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", worktreePath: project.root, agentIdentity: "codex", sessionId: thread, connected: true, env: { CODEX_HOME: store } });
  const run = async (argv: string[]) => ({ code: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === "list" ? { terminals: [shown()] } : { terminal: shown() } }), stderr: "" });
  const plan = async () => (await makeUpgradePlan("restart", VERSION, project.root, run)).projects[0]!;
  try {
    // Never seen starting (resumed, an older hub, a pruned log): unsure counts as turned.
    expect((await plan()).freshStart).toBeUndefined();
    adopt("thread-Z", true);
    expect(await plan()).toMatchObject({ freshStart: ["codex"], blockers: [] });

    // A thread with history: started here, used, then the TUI detached and resumed it. Detaching forgets nothing.
    thread = "thread-H";
    adopt("thread-H", true);
    codex.turn();
    await codex.stop(); await codex.start(); // the TUI detached and came back
    adopt("thread-H", false);
    const used = await plan();
    expect(used.freshStart).toBeUndefined();
    expect(used.blockers).toEqual([expect.stringContaining("codex: thread thread-H has no resumable transcript under")]);
    expect(used.blockers[0]).toContain("the hub cannot show that no turn ran on it");

    // A turn on another thread does not count against thread-Z.
    thread = "thread-Z";
    expect((await plan()).freshStart).toEqual(["codex"]);
  } finally {
    await daemon.stop();
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: a planned fresh start needs the store to show the rollout missing; an unreadable store is unknown.
test("a planned fresh Codex start is refused while its session store cannot be read", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-codex-unknown-")));
  const stateDir = join(temp, "state"), sessions = join(temp, "codex-home", "sessions");
  mkdirSync(stateDir); mkdirSync(sessions, { recursive: true });
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true, peers: {} }));
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: "function\n", stderr: "" }; };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: join(temp, "codex-home") } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-Z" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-Z", launch, launchMetadata: launch }], blockers: [], freshStart: ["codex"],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  chmodSync(sessions, 0);
  try {
    await expect(makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {})).rejects.toThrow(`the session store ${sessions} cannot be read, so whether thread thread-Z can resume is unknown; no terminal was created`);
    expect(progress.terminals).toEqual({ "closed:codex": true });
    expect(calls).toEqual([]);
    // #215 review: a failed receipt survives the same refusal on resume, with its fresh-session choice.
    progress.terminals["restored:codex"] = "failed";
    delete planned.freshStart;
    await expect(makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {})).rejects.toThrow("cannot be read");
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(nextActions(op)).toContain(`${COORD} dispose op-215 --fresh-session codex --reason <text>`);
    expect(calls).toEqual([]);
  } finally { chmodSync(sessions, 0o700); server.stop(true); rmSync(temp, { recursive: true, force: true }); }
});

// #215 review: an operation from an older coordinator (the 0.12.19 incident) has a target on that release's protocol,
// which the lifecycle stop's inspection refuses; stop-and-archive must stop it at its own protocol, fenced by instance.
test("stop-and-archive stops a legacy-protocol target at its own protocol, fenced by its instance", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-legacy-target-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  const legacy = PROTOCOL - 1;
  const hellos: number[] = [], kills: unknown[] = [];
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") { hellos.push(msg.v); ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-legacy", instanceId: "i-legacy", cwd: temp, protocol: legacy })); return; }
      if (msg.t !== "kill") { ws.send(JSON.stringify({ rid: msg.rid, ok: false, error: "unexpected" })); return; }
      kills.push(msg.instanceId);
      if (msg.instanceId !== "i-legacy") { ws.send(JSON.stringify({ rid: msg.rid, ok: false, error: "hub restarted; refresh before stopping" })); return; }
      ws.send(JSON.stringify({ rid: msg.rid, t: "stopping", ok: true, instanceId: "i-legacy" }));
      setTimeout(() => rmSync(join(stateDir, "status.json"), { force: true }), 20); // the manifest goes once it stopped
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "legacy-token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: legacy, projectId: "p-legacy", instanceId: "i-legacy", cwd: temp }));
  writeFileSync(join(stateDir, "restart.json"), JSON.stringify({ operationId: "op-legacy" }));
  const project = { id: "p-legacy", root: temp, stateDir, instanceId: null, pid: null, basePort: 4600 } as any;
  const op = { id: "op-legacy", sourceRoot: "/releases/source-older", plan: { version: "0.12.19" } } as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home"); // the registry-claim wait reads this home's registry only
  try {
    const driver = makeRecoveryDriver(async () => ({ code: 0, stdout: "", stderr: "" }));
    await expect(driver.stopAndArchive(project, op, "i-replaced")).rejects.toThrow("hub restarted; refresh before stopping");
    expect(readFileSync(join(stateDir, "status.json"), "utf8")).toContain("i-legacy"); // not stopped, not archived
    await driver.stopAndArchive(project, op, "i-legacy");
    expect(hellos.every((v) => v === legacy)).toBe(true);
    expect(kills).toEqual(["i-replaced", "i-legacy"]);
    expect(() => readFileSync(join(stateDir, "status.json"))).toThrow();
    expect(JSON.parse(readFileSync(join(stateDir, `restart.abandoned.${createHash("sha256").update("op-legacy").digest("hex")}.json`), "utf8")).operationId).toBe("op-legacy");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: the choices in a failed-restoration error come from the same list as status, so Pi is never offered a
// fresh session that dispose refuses.
test("a failed Pi restoration names resume and stop-and-archive, never --fresh-session pi", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-pi-failed-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  let inspections = 0;
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-pi", phase: "restored", ready: true,
    // Nothing attached at restore start; a codex session appears before a create (the guard reads again).
    peers: inspections++ > 1 ? { codex: { id: "codex", state: "idle", threadId: "thread-late" } } : {} }));
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "pi", state: "idle", sessionId: "pi-1", args: { mode: "tui" } }], blockers: [] },
    terminals: [{ peer: "pi", handle: "term-pi", incarnationId: "inc-pi", worktreeId: "wt", projectRoot: temp, sessionId: "pi-1", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:pi": true, "restored:pi": "pending" } };
  const op = { id: "op-pi", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const calls: string[][] = [];
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    const driver = makeRecoveryDriver(async (argv) => { calls.push(argv); return { code: 0, stdout: "{}", stderr: "" }; });
    const failed = await driver.restore(planned, progress, op, "native", () => {}).then(() => undefined, (error: Error) => error.message);
    expect(failed).toContain("pi: its launcher no longer runs and no pi session attached");
    expect(nextActions(op, undefined, await liveProjects(op, inspectRecovery))).toEqual([`${COORD} resume op-pi`, `${COORD} dispose op-pi --stop-and-archive --reason <text>`]);
    expect(progress.terminals["restored:pi"]).toEqual({ state: "failed" });

    // The relaunch on the next resume reads what is attached right before it creates, not at restore start.
    const codexPlanned: PlannedProject = { ...planned, source: { ...planned.source, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }] },
      terminals: [{ ...planned.terminals[0] as object, peer: "codex", handle: "term-codex", sessionId: "thread-T", launch: { ...launch, env: {} } } as never] };
    const codexProgress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true }, fresh: { codex: { lost: "thread-T", reason: "test", at: 1 } } };
    inspections = 1;
    await expect(driver.restore(codexPlanned, codexProgress, { ...op, projects: [codexProgress] } as RecoveryOperation, "native", () => {})).rejects.toThrow("codex: session thread-late is attached instead of thread-T; no terminal was created; end that codex session and close its terminal first");
    expect(calls.some((argv) => argv.includes("create"))).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: an unreachable target is unknown evidence, never "nothing attached": no receipt is turned failed and no
// terminal is created beside a session that may be live.
test("a target that cannot be read blocks settling and creating, and keeps every receipt", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-target-unknown-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const deadPort = probe.port; probe.stop(true);
  writeFileSync(join(stateDir, "control-token"), "token\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: deadPort, protocol: PROTOCOL, projectId: "p-215", instanceId: "i-target", cwd: temp }));
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "claude", state: "idle", sessionId: "S" }], blockers: [] },
    terminals: [{ peer: "claude", handle: "term-claude", incarnationId: "inc", worktreeId: "wt", projectRoot: temp, sessionId: "S", launch, launchMetadata: launch }], blockers: [],
  };
  const calls: string[][] = [];
  const driver = makeRecoveryDriver(async (argv) => { calls.push(argv); return { code: 0, stdout: "function\n", stderr: "" }; });
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    for (const receipt of ["pending", "failed"] as const) {
      const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "peers-restored", terminals: { "closed:claude": true, "restored:claude": receipt } };
      const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
      await expect(driver.restore(planned, progress, op, "claude", () => {})).rejects.toThrow("whether a claude session or launcher is live cannot be told (the target hub reads as unavailable); nothing was recorded or created");
      expect(progress.terminals["restored:claude"]).toBe(receipt);
    }
    expect(calls.some((argv) => argv.includes("create"))).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: a corrupt or half-written launcher record is unknown evidence, never "never recorded".
test("an unreadable launcher record keeps a pending restoration pending and creates nothing", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-records-unreadable-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true, peers: {} }));
  writeFileSync(join(stateDir, "terminal-recovery.json"), "[{\"peer\": \"claude\""); // mid-write or corrupt
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "claude", state: "idle", sessionId: "S" }], blockers: [] },
    terminals: [{ peer: "claude", handle: "term-claude", incarnationId: "inc", worktreeId: "wt", projectRoot: temp, sessionId: "S", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "peers-restored", terminals: { "closed:claude": true, "restored:claude": "pending" } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const calls: string[][] = [];
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await expect(makeRecoveryDriver(async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; }).restore(planned, progress, op, "claude", () => {}))
      .rejects.toThrow(`whether a claude session or launcher is live cannot be told (the launcher records cannot be read); nothing was recorded or created; inspect ${join(stateDir, "terminal-recovery.json")} and move it aside`);
    expect(progress.terminals["restored:claude"]).toBe("pending");
    expect(calls).toEqual([]);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: what is live is read before a missing rollout is receipted failed: the planned thread attached is the
// restoration, and an unreadable target changes no receipt.
test("an absent Codex receipt with a missing rollout reads the evidence first", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-evidence-first-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true, peers: { codex: { id: "codex", state: "idle", threadId: "thread-T" } } }));
  const shown = { handle: "term-attached", incarnationId: "inc-attached", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-T", connected: true };
  const run = async (argv: string[]) => ({ code: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === "list" ? { terminals: [shown] } : argv[2] === "wait" ? { wait: { satisfied: true } } : { terminal: shown } }), stderr: "" });
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-attached", sessionId: "thread-T" } });

    server.stop(true); // the target stops answering
    delete progress.terminals["restored:codex"];
    await expect(makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {})).rejects.toThrow("whether a codex session or launcher is live cannot be told (the target hub reads as unavailable); nothing was recorded or created");
    expect(progress.terminals["restored:codex"]).toBeUndefined(); // not receipted failed for the missing rollout
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: a launcher that exits because the target died mid-relaunch is not proof the session cannot resume: the
// receipt is settled by the peer's evidence, so an unreadable target keeps it pending (no --fresh-session offered).
test("a relaunch whose launcher exits while the target stops answering stays pending", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-exit-target-gone-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "rollout-2026-10-09T00-00-00-thread-T.jsonl"), "{}\n");
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true, peers: {} }));
  const ended = Bun.spawnSync(["true"]).pid;
  const replacement = { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-T", connected: true };
  const run = async (argv: string[]) => {
    if (argv[2] === "create") {
      // ahub codex records itself, then exits when the hub it talks to goes away.
      writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "codex", projectRoot: temp, stateDir, instanceId: "i-target", launcherPid: ended,
        launcherSignature: "ended", launchId: "l-new", handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", env: {} }]));
      server.stop(true);
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt" } } }), stderr: "" };
    }
    if (argv[2] === "wait") return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === "show" ? { terminal: replacement } : { terminals: [replacement] } }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await expect(makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {})).rejects.toThrow("whether a codex session or launcher is live cannot be told (the target hub reads as unavailable)");
    expect(progress.terminals["restored:codex"]).toEqual({ state: "pending" });
    expect(nextActions(op).some((line) => line.includes("--fresh-session"))).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: when the launcher exits, an attached session is settled as the pending row settles it: a new session the
// operator chose (or the plan accepted) is the restoration, never "end that session".
test("a launcher that exits after an accepted new session attached is settled as restored", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-exit-accepted-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  let attached: string | undefined;
  const server = fakeHub(temp, stateDir, "i-target", () => ({ operationId: "op-215", phase: "restored", ready: true,
    peers: attached ? { codex: { id: "codex", state: "idle", threadId: attached } } : {} }));
  const ended = Bun.spawnSync(["true"]).pid;
  const replacement = { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-new", connected: true };
  let waits = 0;
  const run = async (argv: string[]) => {
    if (argv[2] === "create") {
      // The new session attaches, then its launcher exits.
      writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "codex", projectRoot: temp, stateDir, instanceId: "i-target", launcherPid: ended,
        launcherSignature: "ended", launchId: "l-new", handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", env: {} }]));
      attached = "thread-new";
      return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt" } } }), stderr: "" };
    }
    if (argv[2] === "wait") return waits++ === 0 ? { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "timeout" } }), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ ok: true, result: { satisfied: true } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ ok: true, result: argv[2] === "show" ? { terminal: replacement } : { terminals: [replacement] } }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true }, fresh: { codex: { lost: "thread-T", reason: "rollout gone", at: 1 } } };
  const op = { id: "op-215", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "thread-new" } });
    expect(readRecoveryWaivers(stateDir, "op-215")).toEqual({ codex: "fresh-session" });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #215 review: a pending close is settled only by an inventory Orca answered in full. A failed, not-ok, truncated or
// non-JSON list shows nothing: the receipt stays pending and the error says the list could not be read.
test("a pending terminal close stays pending when Orca's terminal list cannot be read", async () => {
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const binding = { peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: "/p", sessionId: "thread-T", launch, launchMetadata: launch };
  const planned = { project: { id: "p-215", root: "/p", stateDir: "/p/state", basePort: 4600 }, source: { state: "running", peers: [], blockers: [] }, terminals: [binding], blockers: [] } as unknown as PlannedProject;
  const op = { id: "op-215", plan: { version: VERSION, projects: [planned] } } as unknown as RecoveryOperation;
  const answers: Record<string, { code: number; stdout: string }> = {
    failed: { code: 1, stdout: "" },
    "not json": { code: 0, stdout: "orca: daemon restarting" },
    "not ok": { code: 0, stdout: JSON.stringify({ ok: false, error: { code: "unavailable" } }) },
    truncated: { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [], truncated: true } }) },
  };
  for (const [name, answer] of Object.entries(answers)) {
    const progress: ProjectProgress = { id: "p-215", phase: "prepared", terminals: { "closed:codex": "pending" } };
    const driver = makeRecoveryDriver(async () => ({ ...answer, stderr: "" }));
    await expect(driver.closeTerminals(planned, progress, op, () => {}), name).rejects.toThrow("codex: Orca's terminal list could not be read, so whether terminal term-codex is closed is unknown");
    expect(progress.terminals["closed:codex"], name).toBe("pending");
  }
  const listed = { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [{ handle: "term-codex", incarnationId: "inc-codex" }] } }), stderr: "" };
  const progress: ProjectProgress = { id: "p-215", phase: "prepared", terminals: { "closed:codex": "pending" } };
  await expect(makeRecoveryDriver(async () => listed).closeTerminals(planned, progress, op, () => {})).rejects.toThrow("Orca still lists terminal term-codex");
  const absent = { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: "" };
  await makeRecoveryDriver(async () => absent).closeTerminals(planned, progress, op, () => {});
  expect(progress.terminals["closed:codex"]).toBe(true);
});

// #225: after a restart, the stopped target's restored terminal is closed (or found absent) before its peer is
// relaunched; launch records of the dead instance still count; an accepted session is relaunched by its own id.
test("a restarted target's retired terminal is closed first, dead launchers block, and the accepted session is resumed", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restart-restore-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home"), sessions = join(codexHome, "sessions", "2026", "10", "10");
  mkdirSync(stateDir); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-thread-accepted.jsonl"), "{}\n");
  let attachedThread: string | undefined;
  const server = fakeHub(temp, stateDir, "i-new", () => ({ operationId: "op-225", phase: "restored", ready: true,
    peers: attachedThread ? { codex: { id: "codex", state: "idle", threadId: attachedThread } } : {} }));
  const ended = Bun.spawnSync(["true"]).pid;
  const row = (instanceId: string, handle: string, live: boolean) => ({ peer: "codex", projectRoot: temp, stateDir, instanceId, launcherPid: live ? process.pid : ended,
    launcherSignature: live ? processSignature(process.pid) : "ended", launchId: `l-${handle}`, handle, incarnationId: `inc-${handle}`, worktreeId: "wt", env: {} });
  const records = (rows: unknown[]) => writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify(rows));
  const retired = { handle: "term-retired", incarnationId: "inc-term-retired", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-accepted", connected: true };
  const replacement = { handle: "term-new", incarnationId: "inc-term-new", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-accepted", connected: true };
  let retiredOpen = true, inventoryReadable = false;
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "-e") return { code: 0, stdout: "function\n", stderr: "" };
    if (argv[2] === "list" && !inventoryReadable) return { code: 1, stdout: "", stderr: "orca is not running" };
    if (argv[2] === "close") retiredOpen = false;
    if (argv[2] === "create") { records([row("i-new", "term-new", true)]); attachedThread = "thread-accepted"; }
    const shown = argv.includes("term-retired") ? retired : replacement;
    const result = argv[2] === "create" ? { terminal: { handle: "term-new", incarnationId: "inc-term-new", worktreeId: "wt" } }
      : argv[2] === "show" ? { terminal: shown } : argv[2] === "wait" ? { wait: { satisfied: true } } : argv[2] === "close" ? {}
      : { terminals: [...(retiredOpen ? [retired] : []), ...(calls.some((c) => c[2] === "create") ? [replacement] : [])] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  // The dead instance had restored Codex under a session the operator accepted instead of thread-T.
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-new", phase: "started", restarts: [{ instanceId: "i-dead", at: 1 }], fresh: { codex: { lost: "thread-T", reason: "chosen", at: 1 } },
    terminals: { "closed:codex": true, "retired:codex": { ...planned.terminals[0] as object, handle: "term-retired", incarnationId: "inc-term-retired", sessionId: "thread-accepted" } } };
  const op = { id: "op-225", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    const driver = makeRecoveryDriver(run);
    records([row("i-dead", "term-retired", true)]);
    // An unreadable Orca inventory says nothing about the retired terminal: nothing changes, nothing is closed or made.
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("Orca's terminal list could not be read, so whether terminal term-retired is closed is unknown");
    expect(progress.terminals["closedRetired:codex"]).toBeUndefined();
    expect(calls.some((c) => c[2] === "close" || c[2] === "create")).toBe(false);
    // Readable: the retired terminal is closed first; then a launcher the dead instance recorded that still runs blocks.
    inventoryReadable = true;
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("its launcher in terminal term-retired is running but no codex session attached yet; no terminal was created");
    expect(progress.terminals["closedRetired:codex"]).toBe(true);
    expect(calls.filter((c) => c[2] === "close").map((c) => c[c.indexOf("--terminal") + 1])).toEqual(["term-retired"]);
    expect(calls.some((c) => c[2] === "create")).toBe(false);
    // Once that launcher is gone, Codex is relaunched resuming the session it had accepted.
    records([row("i-dead", "term-retired", false)]);
    await driver.restore(planned, progress, op, "native", () => {});
    const create = calls.filter((c) => c[2] === "create");
    expect(create).toHaveLength(1);
    expect(create[0]![create[0]!.indexOf("--command") + 1]).toEndWith("'codex' 'resume' 'thread-accepted'");
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "thread-accepted" } });
    expect(calls.filter((c) => c[2] === "close")).toHaveLength(1); // closed once, never again
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

test("a Claude attached to the target without a session id blocks its relaunch: never read as nothing attached", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restart-claude-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  const server = fakeHub(temp, stateDir, "i-new", () => ({ operationId: "op-225", phase: "restored", ready: true, peers: { claude: { id: "claude", state: "idle" } } }));
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: "" }; };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "claude", state: "idle", sessionId: "S" }], blockers: [] },
    terminals: [{ peer: "claude", handle: "term-claude", incarnationId: "inc", worktreeId: "wt", projectRoot: temp, sessionId: "S", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-new", phase: "peers-restored", restarts: [{ instanceId: "i-dead", at: 1 }], terminals: { "closed:claude": true } };
  const op = { id: "op-225", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await expect(makeRecoveryDriver(run).restore(planned, progress, op, "claude", () => {})).rejects.toThrow("a claude session is attached to the target without a session id");
    expect(progress.terminals["restored:claude"]).toBeUndefined();
    expect(calls.some((c) => c[2] === "create")).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #225 review: after a restart the accepted session is the one to relaunch, but the operator's fresh choice stays on
// record when it attaches; an accepted Claude with no transcript starts new instead of a --resume that cannot succeed.
test("a restarted target keeps a fresh choice when the accepted session attaches, and starts an accepted Claude with no transcript anew", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restart-accepted-")));
  const stateDir = join(temp, "state"), claudeConfig = join(temp, "claude-config"), codexHome = join(temp, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(claudeConfig, "projects"), { recursive: true }); mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "rollout-thread-accepted.jsonl"), "{}\n");
  let peers: Record<string, unknown> = { codex: { id: "codex", state: "idle", threadId: "thread-accepted" } };
  const server = fakeHub(temp, stateDir, "i-new", () => ({ operationId: "op-225", phase: "restored", ready: true, peers }));
  const shown = (handle: string, agentIdentity: string, sessionId: string) => ({ handle, incarnationId: `inc-${handle}`, worktreeId: "wt", worktreePath: temp, agentIdentity, sessionId, connected: true });
  let replacement = shown("term-codex-attached", "codex", "thread-accepted");
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "-e") return { code: 0, stdout: "function\n", stderr: "" };
    if (argv[2] === "create") {
      writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer: "claude", projectRoot: temp, stateDir, instanceId: "i-new", launcherPid: process.pid,
        launcherSignature: processSignature(process.pid), launchId: "l-new", handle: "term-claude-new", incarnationId: "inc-term-claude-new", worktreeId: "wt", env: {} }]));
      replacement = shown("term-claude-new", "claude", "S-new");
      peers = { claude: { id: "claude", state: "idle", sessionId: "S-new" } };
    }
    const result = argv[2] === "create" ? { terminal: { handle: replacement.handle, incarnationId: replacement.incarnationId, worktreeId: "wt" } }
      : argv[2] === "show" ? { terminal: replacement } : argv[2] === "wait" ? { wait: { satisfied: true } } : { terminals: [replacement] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const codexLaunch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const claudeLaunch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CLAUDE_CONFIG_DIR: claudeConfig } };
  const codex = { peer: "codex" as const, handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch: codexLaunch, launchMetadata: codexLaunch };
  const claude = { peer: "claude" as const, handle: "term-claude", incarnationId: "inc-claude", worktreeId: "wt", projectRoot: temp, sessionId: "S-planned", launch: claudeLaunch, launchMetadata: claudeLaunch };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }, { id: "claude", state: "idle", sessionId: "S-planned" }], blockers: [] },
    terminals: [codex, claude], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-new", phase: "started", restarts: [{ instanceId: "i-dead", at: 1 }],
    fresh: { codex: { lost: "thread-T", reason: "chosen", at: 1 } },
    terminals: { "closed:codex": true, "closed:claude": true, "closedRetired:codex": true, "closedRetired:claude": true,
      "retired:codex": { ...codex, sessionId: "thread-accepted" }, "retired:claude": { ...claude, sessionId: "S-accepted" }, "restored:codex": "pending" } };
  const op = { id: "op-225", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    const driver = makeRecoveryDriver(run);
    // The accepted thread is attached: the pending receipt settles to it and the operator's choice stays recorded.
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "thread-accepted" } });
    expect(progress.fresh?.codex).toMatchObject({ lost: "thread-T" });
    // The accepted Claude session never got a transcript: it starts new rather than resuming S-accepted.
    await driver.restore(planned, progress, op, "claude", () => {});
    const create = calls.filter((c) => c[2] === "create").at(-1)!;
    const command = create[create.indexOf("--command") + 1]!;
    expect(command).toEndWith("'claude'");
    expect(command).not.toContain("--resume");
    expect(progress.terminals["restored:claude"]).toMatchObject({ state: "done", binding: { sessionId: "S-new" } });
    // The waiver's audit label for a Claude with nothing to resume.
    expect(readRecoveryWaivers(stateDir, "op-225")).toEqual({ claude: "zero-turn" });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #225 review: a Claude attached to the target without a session id is judged only after every instance's launch
// records are read, so a block names a dead instance's launcher that still runs, or the records that cannot be read.
for (const mode of ["a dead instance's live launcher", "unreadable launch records"] as const) test(`a restarted target's claude attached without an id blocks on ${mode}`, async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restart-noid-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  const server = fakeHub(temp, stateDir, "i-new", () => ({ operationId: "op-225", phase: "restored", ready: true, peers: { claude: { id: "claude", state: "idle" } } }));
  writeFileSync(join(stateDir, "terminal-recovery.json"), mode === "unreadable launch records" ? "{not json" : JSON.stringify([{ peer: "claude", projectRoot: temp, stateDir, instanceId: "i-dead",
    launcherPid: process.pid, launcherSignature: processSignature(process.pid), launchId: "l-dead", handle: "term-dead-claude", incarnationId: "inc-dead", worktreeId: "wt", env: {} }]));
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: JSON.stringify({ ok: true, result: { terminals: [] } }), stderr: "" }; };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "claude", state: "idle", sessionId: "S" }], blockers: [] },
    terminals: [{ peer: "claude", handle: "term-claude", incarnationId: "inc", worktreeId: "wt", projectRoot: temp, sessionId: "S", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-new", phase: "peers-restored", restarts: [{ instanceId: "i-dead", at: 1 }], terminals: { "closed:claude": true } };
  const op = { id: "op-225", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    const err = await makeRecoveryDriver(run).restore(planned, progress, op, "claude", () => {}).then(() => undefined, (e) => e as Error);
    expect(err?.message).toContain(mode === "unreadable launch records" ? "terminal-recovery.json" : "terminal term-dead-claude is running but no claude session with an id attached yet");
    expect(calls.some((c) => c[2] === "create")).toBe(false);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #225 review: the planned session coming back after a restart needs no waiver (the snapshot expects it), so the one
// written when the operator chose a fresh session keeps its label, and the choice is cleared.
test("a restarted target whose planned session comes back clears the fresh choice and keeps the waiver's label", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restart-planned-")));
  const stateDir = join(temp, "state"), codexHome = join(temp, "codex-home");
  mkdirSync(stateDir); mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const server = fakeHub(temp, stateDir, "i-new", () => ({ operationId: "op-225", phase: "restored", ready: true, peers: { codex: { id: "codex", state: "idle", threadId: "thread-T" } } }));
  waiveRecoveryPeers(stateDir, "op-225", { codex: "fresh-session" });
  const shown = { handle: "term-codex-planned", incarnationId: "inc-planned", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-T", connected: true };
  const run = async (argv: string[]) => {
    if (argv[1] === "-e") return { code: 0, stdout: "function\n", stderr: "" };
    const result = argv[2] === "show" ? { terminal: shown } : argv[2] === "wait" ? { wait: { satisfied: true } } : { terminals: [shown] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const codex = { peer: "codex" as const, handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [codex], blockers: [],
  };
  // The accepted fresh thread never got a rollout, so the planned thread attaching settles the pending receipt.
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-new", phase: "started", restarts: [{ instanceId: "i-dead", at: 1 }],
    fresh: { codex: { lost: "thread-T", reason: "chosen", at: 1 } },
    terminals: { "closed:codex": true, "closedRetired:codex": true, "retired:codex": { ...codex, sessionId: "thread-accepted" }, "restored:codex": "pending" } };
  const op = { id: "op-225", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, phase: "running", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as unknown as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    await makeRecoveryDriver(run).restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { sessionId: "thread-T" } });
    expect(progress.fresh).toBeUndefined();
    expect(readRecoveryWaivers(stateDir, "op-225")).toEqual({ codex: "fresh-session" });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});

// #272 review: [k] on the plan screen acts on a plan a person read a while ago. The lock, the hub and the terminal are
// injected here, so no hub, registry or lock of this machine is read.
const CUT = "; its turn was cut: a delivery it had not settled is held as needs_review, and its queue stays held until ahub queue resolve";
function endFixture(peer: "codex" | "claude" | "pi", root = "/end-272", stateDir = "/end-272/.agenthub/state") {
  const attached = (session: string, state = "idle") => ({ id: peer, state, ...(peer === "codex" ? { threadId: session } : { sessionId: session }), ...(peer === "pi" ? { args: { mode: "tui" } } : {}) });
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: {} };
  const planned: PlannedProject = {
    project: { id: "p-272", root, stateDir, instanceId: "i-plan", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-plan", version: "0.12.21", protocol: PROTOCOL, peers: [attached("session-S")], blockers: [] },
    terminals: [{ peer, handle: "term-planned", incarnationId: "inc-planned", worktreeId: "wt", projectRoot: root, sessionId: "session-S", launch, launchMetadata: launch }], blockers: [],
  };
  // Orca as it answers now: one terminal in the project, until it is closed.
  const orca = { terminal: { handle: "term-planned", incarnationId: "inc-planned", worktreeId: "wt", worktreePath: root, agentIdentity: peer, sessionId: "session-S", connected: true } as Record<string, unknown> | undefined, calls: [] as string[] };
  const run = async (argv: string[]) => {
    orca.calls.push(argv[2]!);
    const result = argv[2] === "show" ? { terminal: orca.terminal } : argv[2] === "close" ? (orca.terminal = undefined, {}) : { terminals: orca.terminal ? [orca.terminal] : [] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const hub = (over: Partial<Inspection> = {}): Inspection => ({ ...planned.source, ...over });
  const end = (deps: Parameters<typeof endPlannedPeer>[2] = {}) => endPlannedPeer(planned, planned.source.peers[0]!, { run, lock: () => undefined, inspect: async () => hub(), ...deps });
  return { planned, orca, hub, attached, end };
}

test("a TUI agent's terminal is closed while the lock, the hub, its session and its terminal are the ones the plan read", async () => {
  for (const peer of ["codex", "claude", "pi"] as const) {
    const { orca, end } = endFixture(peer);
    expect(await end()).toBe(`p-272/${peer}: terminal term-planned closed`);
    expect(orca.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(orca.calls.indexOf("list")).toBeLessThan(orca.calls.indexOf("close")); // bound again before the close
  }
  // An operation that takes the lock while the hub and the terminal are read again still stops the close.
  const late = endFixture("claude");
  let reads = 0;
  expect(await late.end({ lock: () => reads++ === 0 ? undefined : "op-late" })).toBe("p-272/claude: not ended (recovery operation op-late holds the lock)");
  expect([reads, late.orca.calls.includes("close")]).toEqual([2, false]);
  // A turn in progress is cut by the close: the line says what the hub holds because of it.
  const busy = endFixture("codex");
  expect(await busy.end({ inspect: async () => busy.hub({ peers: [busy.attached("session-S", "busy")] }) })).toBe(`p-272/codex: terminal term-planned closed${CUT}`);
});

test("a TUI agent is not ended, and nothing is closed, once the lock, the hub, its session or its terminal differ from the plan", async () => {
  const { orca, hub, attached, end } = endFixture("codex");
  const shown = orca.terminal!;
  const refused = async (why: string, deps: Parameters<typeof end>[0], terminal: Record<string, unknown> | null = shown) => {
    orca.terminal = terminal ?? undefined; orca.calls.length = 0;
    expect(await end(deps)).toBe(`p-272/codex: not ended (${why})`);
    expect(orca.calls).not.toContain("close");
  };
  // An operation took the lock after the plan was drawn: not even the hub is read.
  await refused("recovery operation 00000000-0000-4000-8000-000000000272 holds the lock", { lock: () => "00000000-0000-4000-8000-000000000272", inspect: async () => { throw new Error("not read"); } });
  expect(orca.calls).toEqual([]);
  await refused("recovery lock is unreadable; inspect it before changing runtimes", { lock: () => { throw new Error("recovery lock is unreadable; inspect it before changing runtimes"); } });
  // The hub was restarted, stopped, or cannot be inspected.
  await refused("its hub reads as instance i-other, not the i-plan of the plan", { inspect: async () => hub({ instanceId: "i-other" }) });
  await refused("its hub reads as stopped", { inspect: async () => hub({ state: "stopped", peers: [] }) });
  await refused("registry unreadable", { inspect: async () => { throw new Error("registry unreadable"); } });
  // The peer left, or another conversation attached under its name.
  await refused("it is no longer attached to its hub", { inspect: async () => hub({ peers: [attached("session-S", "offline")] }) });
  await refused("it is no longer attached to its hub", { inspect: async () => hub({ peers: [] }) });
  await refused("the session attached now is not the one the plan bound to terminal term-planned", { inspect: async () => hub({ peers: [attached("session-OTHER")] }) });
  expect(orca.calls).toEqual([]);
  // The session runs in another terminal now, or the planned handle is another incarnation.
  await refused("its session is now bound to terminal term-new (inc-new), not the plan's term-planned (inc-planned)", {}, { ...shown, handle: "term-new", incarnationId: "inc-new" });
  await refused("its session is now bound to terminal term-planned (inc-reused), not the plan's term-planned (inc-planned)", {}, { ...shown, incarnationId: "inc-reused" });
  // The planned terminal (same handle, incarnation, worktree and root) holds another session, no agent, or is gone:
  // `closeTerminal` alone would have closed the first two.
  await refused("its terminal cannot be bound again: no codex terminal with session session-S in /end-272", {}, { ...shown, sessionId: "session-OTHER" });
  await refused("its terminal cannot be bound again: cannot prove codex terminal ownership from Orca metadata", {}, { ...shown, agentIdentity: undefined, sessionId: undefined });
  await refused("its terminal cannot be bound again: no codex terminal with session session-S in /end-272", {}, null);
  await refused("its terminal cannot be bound again: Orca terminal list failed: orca is not running", { run: async () => ({ code: 1, stdout: "", stderr: "orca is not running" }) });
});

test("a headless agent is stopped through peer_stop, and a hub that does not know the request never reads as stopped", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-end-headless-")));
  const stateDir = join(temp, "state");
  mkdirSync(stateDir);
  let answer: Record<string, unknown> = { ok: true };
  const asked: unknown[] = [];
  // A hub that answers the stop request the way the test says; the real control client asks it.
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") return void ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-272", instanceId: "i-plan", cwd: temp, protocol: PROTOCOL }));
      asked.push({ t: msg.t, peer: msg.peer });
      ws.send(JSON.stringify({ rid: msg.rid, t: msg.t, ...answer }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "token-272\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "p-272", instanceId: "i-plan", cwd: temp }));
  const planned: PlannedProject = {
    project: { id: "p-272", root: temp, stateDir, instanceId: "i-plan", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-plan", version: "0.12.21", protocol: PROTOCOL, peers: [{ id: "kimi", state: "idle" }], blockers: [] }, terminals: [], blockers: [],
  };
  const end = (deps: Parameters<typeof endPlannedPeer>[2] = {}) => endPlannedPeer(planned, planned.source.peers[0]!, { lock: () => undefined, inspect: async () => planned.source, run: async () => { throw new Error("no terminal command for a headless agent"); }, ...deps });
  try {
    expect(await end()).toBe("p-272/kimi: stopped");
    expect(await end({ inspect: async () => ({ ...planned.source, peers: [{ id: "kimi", state: "busy" }] }) })).toBe(`p-272/kimi: stopped${CUT}`);
    // The daemon's answer to a request it does not have (0.12.21 and older).
    answer = { ok: false, error: 'this hub does not know "peer_stop" (restart it: ahub kill && ahub up)' };
    expect(await end()).toBe("p-272/kimi: hub 0.12.21 cannot end a headless agent by itself; it stops with the old hub at the upgrade and the new hub starts it again (ahub stop kimi ends it then)");
    answer = { ok: false, error: "kimi is not a peer this hub runs" };
    expect(await end()).toBe("p-272/kimi: not stopped (kimi is not a peer this hub runs)");
    expect(asked).toEqual(Array(4).fill({ t: "peer_stop", peer: "kimi" }));
    // The lock and the hub are read again for a headless agent too: nothing is asked of a hub that is not the planned one.
    answer = { ok: true };
    expect(await end({ lock: () => "00000000-0000-4000-8000-000000000272" })).toBe("p-272/kimi: not ended (recovery operation 00000000-0000-4000-8000-000000000272 holds the lock)");
    expect(await end({ inspect: async () => ({ ...planned.source, instanceId: "i-other" }) })).toBe("p-272/kimi: not ended (its hub reads as instance i-other, not the i-plan of the plan)");
    expect(await end({ inspect: async () => ({ ...planned.source, peers: [{ id: "kimi", state: "offline" }] }) })).toBe("p-272/kimi: not ended (it is no longer attached to its hub)");
    expect(asked).toHaveLength(4);
  } finally { server.stop(true); rmSync(temp, { recursive: true, force: true }); }
});

/** Capture only the control caps; real transport still uses consumed hello/status barriers. */
function inspectionTimerClock() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const timers: { handle: ReturnType<typeof setTimeout>; ms: number; due: number; run: () => void; cleared: boolean; fired: boolean }[] = [];
  let now = 0;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms !== 3000 && ms !== 30_000) return set(callback, ms, ...args);
    const handle = set(() => {}, 60_000);
    timers.push({ handle, ms, due: now + ms, run: () => callback(...args), cleared: false, fired: false });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const timer = timers.find(timer => timer.handle === handle); if (timer) timer.cleared = true;
    clear(handle);
  }) as typeof clearTimeout;
  return { active: () => timers.filter(timer => !timer.cleared && !timer.fired), advance(ms: number) {
    now += ms;
    for (const timer of timers) if (!timer.cleared && !timer.fired && timer.due <= now) { timer.fired = true; timer.run(); }
  }, restore() { for (const timer of timers) clear(timer.handle); globalThis.setTimeout = set; globalThis.clearTimeout = clear; } };
}

function heldInspectionHello(holdStatus = false) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ahub-inspection-hello-"))), stateDir = join(temp, "state"); mkdirSync(stateDir);
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "isolated-home"); // inspectRecovery must not read the live registry
  const project = { id: "p-hello-cap", root: temp, stateDir, basePort: 0, instanceId: "hello-source", pid: process.pid };
  const requests: string[] = [];
  let helloDone!: () => void, statusDone!: () => void, releaseHello: (() => void) | undefined;
  const hello = new Promise<void>(resolve => { helloDone = resolve; }), status = new Promise<void>(resolve => { statusDone = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 400 }); },
    websocket: { message(socket, data) {
      const message = JSON.parse(String(data)); requests.push(message.t);
      if (message.t === "hello") {
        const reply = () => socket.send(JSON.stringify({ rid: message.rid, t: "welcome", ok: true, projectId: project.id, instanceId: project.instanceId, cwd: project.root, protocol: PROTOCOL }));
        if (requests.length === 1) { releaseHello = reply; helloDone(); } else reply();
      } else if (message.t === "status") {
        statusDone();
        if (!holdStatus) socket.send(JSON.stringify({ rid: message.rid, t: "status", ok: true, status: { projectId: project.id, instanceId: project.instanceId, cwd: project.root, protocol: PROTOCOL, version: VERSION, peers: {} } }));
      } else socket.send(JSON.stringify({ rid: message.rid, t: "recovery", ok: true, recovery: { ready: true, phase: "prepared", peers: {} } }));
    } },
  });
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, pid: process.pid, cwd: project.root, projectId: project.id, instanceId: project.instanceId, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "hello-fixture-token");
  return { project, requests, hello, status, releaseHello: () => releaseHello!(), close: () => server.stop(true), cleanup() {
    server.stop(true); rmSync(temp, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
  } };
}
const inspectionContinuations = () => new Promise<void>(resolve => setImmediate(resolve));

test("real inspectRecovery accepts a hello past the ordinary 3-second cap within its 30-second cap (#303)", async () => {
  const f = heldInspectionHello(), clock = inspectionTimerClock(); let settled = false;
  const result = inspectRecovery(f.project).then(value => { settled = true; return value; });
  try {
    await f.hello; // server consumed the first authenticated hello and deliberately withheld welcome
    clock.advance(4000); await inspectionContinuations();
    expect(settled).toBe(false);
    expect(clock.active().map(timer => timer.ms)).toEqual([30_000, 30_000]); // connect and its hello request
    f.releaseHello();
    expect(await result).toMatchObject({ state: "running", instanceId: "hello-source", recovery: { ready: true } });
    expect(f.requests).toEqual(["hello", "status", "hello", "recovery"]);
  } finally { f.close(); await result; clock.restore(); f.cleanup(); }
});

test("real inspectRecovery bounds a never-answered hello at 30 seconds, not the ordinary cap (#303)", async () => {
  const f = heldInspectionHello(), clock = inspectionTimerClock(); let settled = false;
  const result = inspectRecovery(f.project).then(value => { settled = true; return value; });
  try {
    await f.hello;
    clock.advance(29_999); await inspectionContinuations();
    expect(settled).toBe(false); expect(f.requests).toEqual(["hello"]);
    clock.advance(1);
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(settled).toBe(true); expect(f.requests).toEqual(["hello"]); // no second connect or status fallback
  } finally { f.close(); await result; clock.restore(); f.cleanup(); }
});

test("ordinary inspectProject keeps 3-second connect and status-request caps by default (#303)", async () => {
  const f = heldInspectionHello(true), clock = inspectionTimerClock(); let settled = false;
  const result = inspectProject(f.project).then(value => { settled = true; return value; });
  try {
    await f.hello;
    expect(clock.active().map(timer => timer.ms)).toEqual([3000, 3000]);
    clock.advance(2999); await inspectionContinuations(); expect(settled).toBe(false);
    f.releaseHello(); await f.status; // hello completed; status request remains intentionally unanswered
    expect(clock.active().map(timer => timer.ms)).toEqual([3000]);
    clock.advance(2999); await inspectionContinuations(); expect(settled).toBe(false);
    clock.advance(1);
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(f.requests).toEqual(["hello", "status"]);
  } finally { f.close(); await result; clock.restore(); f.cleanup(); }
});

for (const supportsModes of [false, true]) test(`the recovery driver keeps headless Kimi headless on a ${supportsModes ? "mode-aware" : "legacy"} target (#316)`, async () => {
  const f = claudeRestoreFixture("session-S");
  const target = mkdtempSync(join(tmpdir(), "ahub-kimi-target-"));
  try {
    if (supportsModes) { mkdirSync(join(target, "src/hub"), { recursive: true }); writeFileSync(join(target, "src/hub/start-mode.ts"), 'export const START_MODE_PEERS = ["pi", "codex", "kimi"] as const;\n'); }
    f.op.targetRoot = target; f.op.plan.projects = [f.planned];
    f.planned.terminals = [];
    f.planned.source.peers = [{ id: "kimi", state: "idle", args: { model: "saved-model", mode: "headless" } }];
    const calls: string[][] = [];
    const driver = makeRecoveryDriver(async argv => { calls.push(argv); return { code: 0, stdout: "{}", stderr: "" }; });
    await driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(calls).toEqual([[process.execPath, join(target, "src/cli/main.js"), "--project", f.root, "kimi", "--model", "saved-model", ...(supportsModes ? ["--mode", "headless"] : [])]]);
    f.planned.source.peers[0]!.args!.mode = "tui";
    await expect(driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("cannot be restored as a headless worker");
    expect(calls).toHaveLength(1);
  } finally { f.cleanup(); rmSync(target, { recursive: true, force: true }); }
});

test("controlled recovery planning refuses an attached Kimi TUI before effects (#316)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-kimi-recovery-")), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const registry = new Registry(join(root, "home", "registry.db"));
  mkdirSync(join(root, "project")); const project = registry.register(join(root, "project")); registry.close();
  const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  const kimi = await ControlClient.connect(project.stateDir, { role: "peer", peer: "kimi", channel: false });
  try {
    const calls: string[][] = [];
    const source = await inspectRecovery(project);
    expect(source.peers.find(peer => peer.id === "kimi")?.args?.mode).toBe("tui");
    const plan = await makeUpgradePlan("restart", VERSION, project.root, async argv => { calls.push(argv); return { code: 0, stdout: "{}", stderr: "" }; });
    expect(plan.projects[0]!.blockers.some(reason => reason.includes("pull-only terminal has no automatic restore"))).toBe(true);
    expect(calls).toEqual([]); expect(daemon.bus.peers.get("kimi")!.state).toBe("idle");
  } finally {
    kimi.close(); await daemon.stop();
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the recovery driver emits the Qwen headless command without treating it as Claude (#256)", async () => {
  const f = claudeRestoreFixture("session-S");
  try {
    f.planned.terminals = []; f.planned.source.peers = [{ id: "qwen", state: "idle", args: { model: "qwen-model" } }]; f.op.plan.projects = [f.planned];
    const calls: string[][] = [];
    const driver = makeRecoveryDriver(async argv => { calls.push(argv); return { code: 0, stdout: "{}", stderr: "" }; });
    await driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(calls).toEqual([[process.execPath, "/target/src/cli/main.js", "--project", f.root, "qwen", "--model", "qwen-model"]]);
  } finally { f.cleanup(); }
});


test("the recovery driver passes the saved Qwen conversation id through its emitted launcher argv (#256)", async () => {
  const f = claudeRestoreFixture("session-S");
  try {
    f.planned.terminals = []; f.planned.source.peers = [{ id: "qwen", state: "idle", sessionId: "qwen-saved", args: { model: "qwen-model" } }]; f.op.plan.projects = [f.planned];
    const calls: string[][] = [];
    const driver = makeRecoveryDriver(async argv => { calls.push(argv); return { code: 0, stdout: "{}", stderr: "" }; });
    await driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(calls).toEqual([[process.execPath, "/target/src/cli/main.js", "--project", f.root, "qwen", "--model", "qwen-model", "--session-id", "qwen-saved"]]);
  } finally { f.cleanup(); }
});

// #414: Orca can report the preserved terminal ready before its authenticated peer attaches.
function delayedManagedFixture(peer: "claude" | "codex" | "pi", pending?: "pending" | "failed") {
  const control = { attachAfterRead: true, noId: false, wrongSession: false, wrongOperation: false, wrongInstance: false, persistOriginalBeforeAttach: false, corruptIntegrity: false, attachAfterMs: 0, interruptAtMs: Infinity, exitAtMs: Infinity, unavailableAtMs: Infinity, pulseAtMs: Infinity, noRecord: false, staleEndedAtCreate: false, idAfterMs: 0, offlineId: false, recordAtPostCreateRead: Infinity, replacementAtRead: false, endedAtRead: false, olderAtRead: "none" };
  let elapsed = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-414-"))), stateDir = join(root, "state");
  mkdirSync(stateDir);
  const config = join(root, "claude-config"), codeHome = join(root, "codex-home"), session = "session-414";
  mkdirSync(join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true });
  writeFileSync(join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`), "{}\n");
  mkdirSync(join(codeHome, "sessions"), { recursive: true });
  writeFileSync(join(codeHome, "sessions", `${session}.jsonl`), "{}\n");
  let created = !!pending, attached = false, creates = 0, postCreateReads = 0, pulseReads = 0;
  const server = fakeHub(root, stateDir, "i-target", () => {
    const visible = elapsed >= control.pulseAtMs ? ++pulseReads >= 4 || pulseReads % 2 === 0 : attached;
    const state = visible ? "idle" : "offline";
    if (created && postCreateReads + 1 === control.recordAtPostCreateRead) {
      recordLauncher(!control.endedAtRead);
      if (control.olderAtRead !== "none") {
        const file = join(stateDir, "terminal-recovery.json"), rows = JSON.parse(readFileSync(file, "utf8"));
        rows.push(control.olderAtRead === "live" ? { ...rows[0], instanceId: "i-older", handle: "term-older", incarnationId: "inc-older", launcherPid: process.pid, launcherSignature: processSignature(process.pid) }
          : { peer, projectRoot: root, instanceId: "i-older", launcherPid: "unreadable" });
        writeFileSync(file, JSON.stringify(rows));
      }
      if (control.replacementAtRead) {
        const file = join(stateDir, "terminal-recovery.json"), rows = JSON.parse(readFileSync(file, "utf8"));
        rows[0].handle = "term-late-replacement"; rows[0].incarnationId = "inc-late-replacement";
        writeFileSync(file, JSON.stringify(rows));
      }
    }
    if (created && ++postCreateReads && control.attachAfterRead && elapsed >= control.attachAfterMs) queueMicrotask(() => {
      if (control.persistOriginalBeforeAttach) writeFileSync(join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`), "{}\n");
      attached = true;
    });
    const id = control.wrongSession ? "different-session" : session;
    if (state === "idle" && !control.noId && elapsed >= control.idAfterMs) shown.sessionId = id;
    return { operationId: control.wrongOperation && created && (!pending || elapsed > 0) ? "wrong-operation" : "op-414", phase: "restored", ready: attached,
      peers: { [peer]: { id: peer, state, ...((state === "idle" || control.offlineId) && !control.noId && elapsed >= control.idAfterMs ? peer === "codex" ? { threadId: id } : { sessionId: id } : {}) } },
      integrity: { expected: {}, current: control.corruptIntegrity ? { changed: true } : {} } };
  });
  const shown = { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", worktreePath: root, agentIdentity: peer, sessionId: session, connected: true, state: "idle", title: "PRIVATE-TERMINAL-TEXT" };
  const endedLauncher = Bun.spawnSync(["true"]).pid;
  const recordLauncher = (live = true) => writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([{ peer, projectRoot: root, stateDir, instanceId: "i-target",
    launcherPid: live ? process.pid : endedLauncher, launcherSignature: live ? processSignature(process.pid) : "ended-launcher", launchId: "launch-433", handle: shown.handle, incarnationId: shown.incarnationId, worktreeId: "wt", env: {} }]));
  const run = async (argv: string[]) => {
    if (argv[1] !== "terminal") throw new Error("non-terminal command refused by fixture");
    let result: unknown;
    if (argv[2] === "create") { created = true; creates++; if (control.staleEndedAtCreate) {
      recordLauncher(false);
      const rows = JSON.parse(readFileSync(join(stateDir, "terminal-recovery.json"), "utf8"));
      rows[0].handle = "term-earlier"; rows[0].incarnationId = "inc-earlier";
      writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify(rows));
    } else if (!control.noRecord) recordLauncher(); if (control.wrongInstance) progress.instanceId = "wrong-instance"; result = { terminal: shown }; }
    else if (argv[2] === "list") result = { terminals: created ? [shown] : [] };
    else if (argv[2] === "show") result = { terminal: shown };
    else if (argv[2] === "wait") result = { wait: { satisfied: true } };
    else throw new Error("unexpected terminal mutation");
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CLAUDE_CONFIG_DIR: config, CODEX_HOME: codeHome } };
  const binding = { peer, handle: "term-old", incarnationId: "inc-old", worktreeId: "wt", projectRoot: root, sessionId: session, launch, launchMetadata: launch };
  const planned: PlannedProject = { project: { id: "p-215", root, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: session } : { sessionId: session }), ...(peer === "pi" ? { args: { mode: "tui" } } : {}) }], blockers: [] },
    terminals: [binding], blockers: [] };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "peers-restored", terminals: { [`closed:${peer}`]: true } };
  const op = { id: "op-414", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT, plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  if (pending) {
    progress.terminals[`restored:${peer}`] = pending;
    recordLauncher();
  }
  return { root, stateDir, planned, progress, op, control, removeClaudeTranscript: () => rmSync(join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`)), setAttached: (value: boolean) => { attached = value; }, elapsed: () => elapsed,
    driver: makeRecoveryDriver(run, undefined, { now: () => elapsed, sleep: async (ms) => { elapsed += ms; if (elapsed >= control.unavailableAtMs) { server.stop(true); control.unavailableAtMs = Infinity; } if (elapsed >= control.exitAtMs) { recordLauncher(false); control.exitAtMs = Infinity; } if (elapsed >= control.interruptAtMs) throw new Error("fixture coordinator interrupted"); } }), creates: () => creates,
    endLauncher: () => recordLauncher(false),
    resetPostCreateReads: () => { postCreateReads = 0; },
    replaceTerminal: () => { shown.handle = "term-replacement"; shown.incarnationId = "inc-replacement"; },
    cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

for (const peer of ["claude", "codex", "pi"] as const) test(`#414 delayed managed ${peer} attaches before restore then verify completes once`, async () => {
  const f = delayedManagedFixture(peer);
  try {
    await f.driver.restore(f.planned, f.progress, f.op, peer === "claude" ? "claude" : "native", () => {});
    await f.driver.verify(f.planned, f.progress, f.op);
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

for (const noId of [false, true]) test(`#414 timeout retains receipt and diagnostics then saved-binding resume creates nothing (idless=${noId})`, async () => {
  const f = delayedManagedFixture("claude");
  f.control.attachAfterRead = noId; f.control.noId = noId;
  let saved: ProjectProgress | undefined;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "claude", () => { saved = JSON.parse(JSON.stringify(f.progress)); }))
      .rejects.toThrow("attachment not verified within 600 s");
    expect(f.elapsed()).toBe(600_000);
    expect(saved?.terminals["restored:claude"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", sessionId: "session-414" } });
    expect(saved?.attachmentTimeouts?.claude).toMatchObject({ at: 600_000, terminal: { handle: "term-new", state: "idle", connected: true },
      hub: { instanceId: "i-target", peerState: noId ? "idle" : "offline" }, lastHubConnectAttempt: "unknown" });
    expect(JSON.stringify(saved)).not.toContain("PRIVATE-TERMINAL-TEXT");
    Object.assign(f.progress, saved);
    f.control.noId = false; f.control.attachAfterRead = true; f.setAttached(false);
    await f.driver.restore(f.planned, f.progress, f.op, "claude", () => {});
    await f.driver.verify(f.planned, f.progress, f.op);
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

for (const changed of ["operation", "session", "instance"] as const) test(`#414 refuses wrong ${changed} while waiting without another create`, async () => {
  const f = delayedManagedFixture("claude");
  if (changed === "operation") f.control.wrongOperation = true;
  if (changed === "session") f.control.wrongSession = true;
  if (changed === "instance") f.control.wrongInstance = true;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "claude", () => {})).rejects.toThrow(changed === "session" ? "different conversation" : "target identity changed");
    expect(f.creates()).toBeLessThanOrEqual(1);
    expect(f.progress.fresh).toBeUndefined();
  } finally { f.cleanup(); }
});

for (const failed of ["integrity", "detach"] as const) test(`#414 verification still rejects ${failed} after successful attachment`, async () => {
  const f = delayedManagedFixture("claude");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "claude", () => {});
    if (failed === "integrity") f.control.corruptIntegrity = true;
    else { f.control.attachAfterRead = false; f.setAttached(false); }
    await expect(f.driver.verify(f.planned, f.progress, f.op)).rejects.toThrow(failed === "integrity" ? "preservation was not verified" : "peer reattachment not verified");
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

for (const peer of ["claude", "codex"] as const) test(`#414 fresh ${peer} idless deadline saves binding and diagnostic before resume accepts chosen session`, async () => {
  const f = delayedManagedFixture(peer);
  f.progress.fresh = { [peer]: { lost: "session-414", reason: "fixture operator choice", at: 1 } };
  f.control.noId = true; f.control.wrongSession = true;
  let saved: ProjectProgress | undefined;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, peer === "claude" ? "claude" : "native", () => { saved = JSON.parse(JSON.stringify(f.progress)); }))
      .rejects.toThrow("attachment not verified within 600 s");
    expect(saved?.terminals[`restored:${peer}`]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
    expect(saved?.attachmentTimeouts?.[peer]).toMatchObject({ terminal: { handle: "term-new" }, hub: { peerState: "idle" }, lastHubConnectAttempt: "unknown" });
    f.control.noId = false; f.setAttached(false);
    await f.driver.restore(f.planned, f.progress, f.op, peer === "claude" ? "claude" : "native", () => {});
    await f.driver.verify(f.planned, f.progress, f.op);
    expect(f.progress.terminals[`restored:${peer}`]).toMatchObject({ state: "done", binding: { sessionId: "different-session" } });
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

for (const persistedDuringWait of [false, true]) test(`#414 zero-turn Claude exception rechecks transcript at attachment (persisted=${persistedDuringWait})`, async () => {
  const f = delayedManagedFixture("claude");
  f.removeClaudeTranscript(); f.control.wrongSession = true; f.control.persistOriginalBeforeAttach = persistedDuringWait;
  try {
    const restoration = f.driver.restore(f.planned, f.progress, f.op, "claude", () => {});
    if (persistedDuringWait) {
      await expect(restoration).rejects.toThrow("different conversation");
      expect(readRecoveryWaivers(f.stateDir, "op-414")).toEqual({});
    } else {
      await restoration;
      await f.driver.verify(f.planned, f.progress, f.op);
      expect(readRecoveryWaivers(f.stateDir, "op-414")).toEqual({ claude: "zero-turn" });
    }
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});


for (const receipt of ["pending", "failed"] as const) test(`#433 ${receipt} live launcher waits beyond 90 s without another terminal`, async () => {
  const f = delayedManagedFixture("codex", receipt);
  f.control.attachAfterMs = 210_000;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    await f.driver.verify(f.planned, f.progress, f.op);
    expect(f.elapsed()).toBeGreaterThanOrEqual(210_000);
    expect(f.elapsed()).toBeLessThan(600_000);
    expect(f.creates()).toBe(0);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "session-414" } });
  } finally { f.cleanup(); }
});

for (const wrong of [false, true]) test(`#433 pending launcher ${wrong ? "rejects a different conversation" : "times out only at the managed bound"}`, async () => {
  const f = delayedManagedFixture("codex", "pending");
  f.control.attachAfterRead = wrong; f.control.attachAfterMs = 210_000; f.control.wrongSession = wrong;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {}))
      .rejects.toThrow(wrong ? "different conversation" : "attachment not verified within 600 s");
    expect(f.elapsed()).toBe(wrong ? 211_000 : 600_000);
    expect(f.creates()).toBe(0);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
  } finally { f.cleanup(); }
});


for (const identity of ["instance", "operation"] as const) test(`#433 pending launcher refuses changed target ${identity}`, async () => {
  const f = delayedManagedFixture("codex", "pending");
  if (identity === "operation") { f.control.wrongOperation = true; f.control.attachAfterMs = 210_000; }
  else f.progress.instanceId = "other-instance";
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {}))
      .rejects.toThrow(identity === "operation" ? "target identity changed" : "target daemon changed before peer restore");
    expect(f.creates()).toBe(0);
    expect(f.elapsed()).toBe(identity === "operation" ? 1000 : 0);
    if (identity === "operation") expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
    else expect(f.progress.terminals["restored:codex"]).toBe("pending");
  } finally { f.cleanup(); }
});


test("#433 interrupted pending wait persists exact chosen terminal and refuses a replacement on resume", async () => {
  const f = delayedManagedFixture("codex", "pending");
  f.control.attachAfterMs = 210_000; f.control.interruptAtMs = 30_000;
  let saved: ProjectProgress | undefined;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => { saved = JSON.parse(JSON.stringify(f.progress)); }))
      .rejects.toThrow("coordinator interrupted");
    expect(saved?.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt" } });
    f.control.interruptAtMs = Infinity;
    f.replaceTerminal(); f.setAttached(true);
    Object.assign(f.progress, saved);
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("saved terminal identity changed");
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});
for (const origin of ["pending", "new"] as const) test(`#433 selected ${origin} launcher exit during attachment wait enables fresh-session`, async () => {
  const f = delayedManagedFixture("codex", origin === "pending" ? "pending" : undefined);
  f.control.attachAfterRead = false; f.control.exitAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(f.elapsed()).toBe(1000); expect(f.progress.terminals["restored:codex"]).toEqual({ state: "failed" });
    expect(nextActions(f.op)).toContain(`${COORD} dispose op-414 --fresh-session codex --reason <text>`);
    expect(f.creates()).toBe(origin === "new" ? 1 : 0);
  } finally { f.cleanup(); }
});
test("#433 interrupted selected pending wait resumes to failed when that exact launcher exited", async () => {
  const f = delayedManagedFixture("codex", "pending");
  f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  let saved: ProjectProgress | undefined;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => { saved = JSON.parse(JSON.stringify(f.progress)); })).rejects.toThrow("coordinator interrupted");
    expect(saved?.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
    f.endLauncher(); f.control.interruptAtMs = Infinity; Object.assign(f.progress, saved);
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(f.elapsed()).toBe(1000); expect(f.progress.terminals["restored:codex"]).toEqual({ state: "failed" }); expect(f.creates()).toBe(0);
    expect(nextActions(f.op)).toContain(`${COORD} dispose op-414 --fresh-session codex --reason <text>`);
  } finally { f.cleanup(); }
});
test("#433 selected failed-origin launcher exit retries once and clears its waiting marker on success", async () => {
  const f = delayedManagedFixture("codex", "failed"); f.control.attachAfterMs = 2000; f.control.exitAtMs = 1000;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(f.creates()).toBe(1); expect(f.elapsed()).toBeLessThan(600_000);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "session-414" } });
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done" }); expect((f.progress.terminals["restored:codex"] as { binding: unknown }).binding).not.toHaveProperty("attachmentReceipt");
  } finally { f.cleanup(); }
});
for (const evidence of ["unknown", "replacement"] as const) test(`#433 interrupted chosen launcher ${evidence} remains blocked without failed receipt`, async () => {
  const f = delayedManagedFixture("codex", "pending"); f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    f.control.interruptAtMs = Infinity;
    const record = join(f.stateDir, "terminal-recovery.json");
    if (evidence === "unknown") writeFileSync(record, "not JSON");
    else {
      const records = JSON.parse(readFileSync(record, "utf8")); records[0].handle = "term-replacement"; records[0].incarnationId = "inc-replacement";
      writeFileSync(record, JSON.stringify(records));
    }
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow(evidence === "unknown" ? "identity cannot be verified" : "saved terminal identity changed");
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
    expect(f.creates()).toBe(0); expect(f.elapsed()).toBe(1000);
    expect(nextActions(f.op).some(choice => choice.includes("--fresh-session"))).toBe(false);
  } finally { f.cleanup(); }
});
for (const changed of [false, true]) test(`#433 resumed chosen ${changed ? "new session writes waiver" : "planned session clears fresh continuity loss"}`, async () => {
  const f = delayedManagedFixture("codex", "failed"); f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  f.progress.fresh = { codex: { lost: "session-414", reason: "operator choice", at: 0 } };
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "failed" });
    f.control.interruptAtMs = Infinity; f.control.wrongSession = changed; f.setAttached(true);
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(readRecoveryWaivers(f.stateDir, "op-414")).toEqual(changed ? { codex: "fresh-session" } : {});
    if (changed) expect(f.progress.fresh?.codex?.lost).toBe("session-414");
    else { expect(f.progress.fresh).toBeUndefined(); expect(publicOperation(f.op).projects[0]).not.toHaveProperty("lostContinuity"); }
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done" }); expect((f.progress.terminals["restored:codex"] as { binding: unknown }).binding).not.toHaveProperty("attachmentReceipt"); expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});
test("#433 interrupted failed-origin wait retains fresh choice and reports waiting rather than done", async () => {
  const f = delayedManagedFixture("codex", "failed"); f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    expect(nextActions(f.op)).toContain(`${COORD} dispose op-414 --fresh-session codex --reason <text>`);
    expect(publicOperation(f.op).projects[0]?.effects?.["restored:codex"]).toBe("waiting:failed");
  } finally { f.cleanup(); }
});
test("#433 target unavailable during attachment wait blocks immediately with saved binding", async () => {
  const f = delayedManagedFixture("codex", "pending"); f.control.attachAfterRead = false; f.control.unavailableAtMs = 1000; f.control.interruptAtMs = 2000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("target hub reads as unavailable while awaiting attachment");
    expect(f.elapsed()).toBe(1000); expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});
test("#433 flapping launcher-gone and attached-session reads still yield between bounded polls", async () => {
  const f = delayedManagedFixture("codex", "pending"); f.control.attachAfterRead = false;
  f.control.exitAtMs = 1000; f.control.pulseAtMs = 1000; f.control.interruptAtMs = 2000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    expect(f.elapsed()).toBe(2000); expect(f.creates()).toBe(0);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending" });
  } finally { f.cleanup(); }
});
test("#433 PROBE-A a new terminal without any launcher record waits for its delayed authenticated attachment", async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true; f.control.attachAfterMs = 2000;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(f.elapsed()).toBeGreaterThanOrEqual(2000); expect(f.elapsed()).toBeLessThan(600_000);
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", incarnationId: "inc-new", sessionId: "session-414" } });
    expect(await Bun.file(join(f.stateDir, "terminal-recovery.json")).exists()).toBe(false);
    await f.driver.verify(f.planned, f.progress, f.op);
  } finally { f.cleanup(); }
});
test("#433 PROBE-B a completed restoration whose launcher and session close stays done without a fresh choice", async () => {
  const f = delayedManagedFixture("codex");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    const done = JSON.parse(JSON.stringify(f.progress.terminals["restored:codex"]));
    const elapsed = f.elapsed(); f.control.attachAfterRead = false; f.setAttached(false); f.endLauncher();
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("completed restoration is not attached");
    expect(done).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "session-414" } });
    expect(f.progress.terminals["restored:codex"]).toEqual(done); expect(f.elapsed()).toBe(elapsed);
    expect(f.creates()).toBe(1); expect(nextActions(f.op).some(choice => choice.includes("--fresh-session"))).toBe(false);
    expect(publicOperation(f.op).projects[0]?.effects?.["restored:codex"]).toBe("done");
  } finally { f.cleanup(); }
});
for (const condition of ["stale-ended-row", "idless-session"] as const) test(`#143 chosen new terminal polls through ${condition} until its authenticated id attaches`, async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true;
  if (condition === "stale-ended-row") { f.control.staleEndedAtCreate = true; f.control.attachAfterMs = 2000; }
  else f.control.idAfterMs = 2000;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(f.elapsed()).toBeGreaterThanOrEqual(2000); expect(f.elapsed()).toBeLessThan(600_000); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", incarnationId: "inc-new", sessionId: "session-414" } });
  } finally { f.cleanup(); }
});
test("#143 offline stale session id cannot hide an older live launcher while the chosen launcher is gone", async () => {
  const f = delayedManagedFixture("codex", "pending"); f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    f.control.interruptAtMs = Infinity; f.control.offlineId = true; f.endLauncher();
    const file = join(f.stateDir, "terminal-recovery.json"), rows = JSON.parse(readFileSync(file, "utf8"));
    rows.push({ ...rows[0], instanceId: "i-older", handle: "term-older", incarnationId: "inc-older", launcherPid: process.pid, launcherSignature: processSignature(process.pid) });
    writeFileSync(file, JSON.stringify(rows)); f.progress.restarts = [{ instanceId: "i-older", at: 0 }];
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("term-older");
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
    expect(nextActions(f.op).some(line => line.includes("--fresh-session"))).toBe(false); expect(f.creates()).toBe(0); expect(f.elapsed()).toBe(1000);
  } finally { f.cleanup(); }
});
for (const condition of ["other-session", "unknown-launcher"] as const) test(`#143 completed restoration block names ${condition} evidence and retains done`, async () => {
  const f = delayedManagedFixture("codex");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    const done = structuredClone(f.progress.terminals["restored:codex"]); f.control.attachAfterRead = false;
    if (condition === "other-session") f.control.wrongSession = true;
    else { f.setAttached(false); writeFileSync(join(f.stateDir, "terminal-recovery.json"), "unreadable JSON"); }
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow(condition === "other-session" ? "different-session is attached instead of session-414" : "launcher records cannot be read");
    expect(f.progress.terminals["restored:codex"]).toEqual(done); expect(f.creates()).toBe(1); expect(nextActions(f.op).some(line => line.includes("--fresh-session"))).toBe(false);
  } finally { f.cleanup(); }
});
for (const replacement of [false, true]) test(`#143 no-record second read ${replacement ? "refuses a replacement launcher" : "adopts the matching late record and keeps polling"}`, async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true; f.control.attachAfterMs = 2000;
  f.control.recordAtPostCreateRead = 2; f.control.replacementAtRead = replacement;
  try {
    const restore = f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    if (replacement) {
      await expect(restore).rejects.toThrow("saved terminal identity changed while awaiting attachment");
      expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new", incarnationId: "inc-new" } });
      expect(f.elapsed()).toBe(0);
    } else {
      await restore;
      expect(f.elapsed()).toBeGreaterThanOrEqual(2000); expect(f.elapsed()).toBeLessThan(600_000);
      expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "session-414" } });
    }
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});
test("#143 late matching gone launcher settles the selected pending wait on that same observation", async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true; f.control.attachAfterRead = false;
  f.control.recordAtPostCreateRead = 2; f.control.endedAtRead = true;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(f.elapsed()).toBe(0); expect(f.progress.terminals["restored:codex"]).toEqual({ state: "failed" }); expect(f.creates()).toBe(1);
    expect(nextActions(f.op).some(line => line.includes("--fresh-session codex"))).toBe(true);
  } finally { f.cleanup(); }
});
test("#143 late unrelated gone launcher does not fail the chosen no-record terminal", async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true; f.control.attachAfterMs = 2000;
  f.control.recordAtPostCreateRead = 2; f.control.endedAtRead = true; f.control.replacementAtRead = true;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    expect(f.elapsed()).toBeGreaterThanOrEqual(2000); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new", sessionId: "session-414" } });
  } finally { f.cleanup(); }
});
for (const older of ["live", "unknown"] as const) test(`#143 late matching gone launcher preserves the older ${older} fence`, async () => {
  const f = delayedManagedFixture("codex"); f.control.noRecord = true; f.control.attachAfterRead = false;
  f.control.recordAtPostCreateRead = 2; f.control.endedAtRead = true; f.control.olderAtRead = older;
  f.progress.restarts = [{ instanceId: "i-older", at: 0 }];
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow(older === "live" ? "term-older" : "identity cannot be verified");
    expect(f.elapsed()).toBe(0); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
    expect(nextActions(f.op).some(line => line.includes("--fresh-session"))).toBe(false);
  } finally { f.cleanup(); }
});
test("#143 an exact gone first read is not erased by an unrelated ended row on the second read", async () => {
  const f = delayedManagedFixture("codex", "pending"); f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("coordinator interrupted");
    f.endLauncher(); f.resetPostCreateReads();
    f.control.recordAtPostCreateRead = 3; f.control.endedAtRead = true; f.control.replacementAtRead = true; f.control.interruptAtMs = 2000;
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(f.elapsed()).toBe(1000); expect(f.creates()).toBe(0); expect(f.progress.terminals["restored:codex"]).toEqual({ state: "failed" });
    expect(nextActions(f.op).some(line => line.includes("--fresh-session codex"))).toBe(true);
  } finally { f.cleanup(); }
});
function featureStageFixture(controlSource: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-target-features-"));
  for (const dir of ["src/cli", "src/hub", "plugins/agent-hub/.claude-plugin", "templates", ".claude-plugin"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: "0.0.0" }));
  writeFileSync(join(root, "plugins/agent-hub/.claude-plugin/plugin.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(join(root, "src/cli/main.js"), ""); writeFileSync(join(root, "src/hub/control-client.ts"), controlSource);
  const project = { id: "feature", root, stateDir: join(root, "state"), instanceId: "source", pid: null, basePort: 4600 };
  const op = { sourceRoot: root, projects: [{ id: project.id, phase: "pending", terminals: {} }],
    plan: { kind: "restart", version: "0.0.0", sourceDigest: packageDigest(root), projects: [{ project, source: { state: "running", peers: [], blockers: [] }, terminals: [], blockers: [] }] } } as unknown as RecoveryOperation;
  return { root, op, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
for (const supported of [false, true]) test(`#438 direct restart probes verified target features with ${supported ? "task_cancel" : "a legacy missing export"}`, async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL}; ${supported ? 'export const DAEMON_FEATURES = ["task_cancel"];' : ""}`);
  try {
    expect(await makeRecoveryDriver().stage(f.op)).toMatchObject({ root: f.root, targetFeatures: supported ? ["task_cancel"] : [] });
  } finally { f.cleanup(); }
});
test("#438 cached staged targets still probe features and malformed capability metadata fails closed", async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL}; export const DAEMON_FEATURES = ["task_cancel"];`);
  let probes = 0;
  const driver = makeRecoveryDriver(async () => { probes++; return { code: 0, stdout: JSON.stringify({ protocol: PROTOCOL, features: ["task_cancel"] }), stderr: "" }; });
  try {
    f.op.targetRoot = f.root; f.op.targetDigest = packageDigest(f.root);
    expect(await driver.stage(f.op)).toMatchObject({ targetFeatures: ["task_cancel"] }); expect(probes).toBe(1);
    const malformed = makeRecoveryDriver(async () => ({ code: 0, stdout: JSON.stringify({ protocol: PROTOCOL, features: [123] }), stderr: "" }));
    await expect(malformed.stage(f.op)).rejects.toThrow("staged target features");
  } finally { f.cleanup(); }
});
test("#438 production recovery driver transmits verified features on readonly inspect, prepare and commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-feature-rpc-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  const messages: Record<string, unknown>[] = [];
  const server = fakeHub(root, stateDir, "i-feature", () => ({ operationId: "op-feature", phase: "prepared", ready: true, peers: {} }), message => messages.push(message));
  const project = { id: "p-215", root, stateDir, instanceId: "i-feature", pid: null, basePort: 4600 };
  try {
    const driver = makeRecoveryDriver();
    await driver.inspect(project, ["task_cancel"]);
    await driver.prepare(project, "op-feature", "i-feature", ["task_cancel"]);
    await driver.commit(project, "op-feature", "i-feature", ["task_cancel"]);
    const recovery = messages.filter(message => message.t === "recovery");
    expect(recovery.map(message => message.op)).toEqual(["inspect", "prepare", "commit"]);
    expect(recovery.every(message => JSON.stringify(message.targetFeatures) === '["task_cancel"]')).toBe(true);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
for (const features of [[], ["task_cancel"]]) test(`#117 P3-5 cached verified ${features.length ? "task_cancel" : "empty"} features avoid target probing before commit`, async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL};`); let probes = 0;
  Object.assign(f.op, { targetRoot: f.root, targetDigest: packageDigest(f.root), targetFeatures: features });
  const driver = makeRecoveryDriver(async () => { probes++; throw new Error("transient target probe must not run"); });
  try {
    expect(await driver.stage(f.op)).toMatchObject({ root: f.root, digest: f.op.targetDigest, targetFeatures: features });
    expect(probes).toBe(0);
  } finally { f.cleanup(); }
});
test("#117 P3-5 a fully committed legacy cached receipt needs no target feature probe", async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL};`); let probes = 0;
  Object.assign(f.op, { targetRoot: f.root, targetDigest: packageDigest(f.root) });
  f.op.projects[0]!.phase = "peers-restored"; f.op.projects[0]!.commitSent = true;
  try {
    const target = await makeRecoveryDriver(async () => { probes++; throw new Error("no feature probe after commit"); }).stage(f.op);
    expect(target).toMatchObject({ root: f.root, digest: f.op.targetDigest }); expect(target.targetFeatures).toBeUndefined(); expect(probes).toBe(0);
  } finally { f.cleanup(); }
});
test("#117 P3-5 legacy prepared commitSent still requires feature evidence before a possible commit", async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL};`); let probes = 0;
  Object.assign(f.op, { targetRoot: f.root, targetDigest: packageDigest(f.root) });
  f.op.projects[0]!.phase = "prepared"; f.op.projects[0]!.commitSent = true;
  try {
    await expect(makeRecoveryDriver(async () => { probes++; return { code: 1, stdout: "", stderr: "" }; }).stage(f.op)).rejects.toThrow("control protocol could not be read"); expect(probes).toBe(1);
  } finally { f.cleanup(); }
});
test("#117 P3-5 cached feature evidence cannot authorize changed target bytes", async () => {
  const f = featureStageFixture(`export const PROTOCOL = ${PROTOCOL};`); let probes = 0;
  Object.assign(f.op, { targetRoot: f.root, targetDigest: "different-digest", targetFeatures: ["task_cancel"] });
  try {
    const target = await makeRecoveryDriver(async () => { probes++; return { code: 0, stdout: JSON.stringify({ protocol: PROTOCOL, features: [] }), stderr: "" }; }).stage(f.op);
    expect(target.targetFeatures).toEqual([]); expect(probes).toBe(1);
  } finally { f.cleanup(); }
});

/** #463: only a fake control server and fake Orca argv boundary; no terminal or native agent is opened. */
function detachedAfterRestoreFixture(peer: "pi" | "codex" | "claude" = "pi", accepted = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-463-detached-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  const sessionFile = join(stateDir, "recorded-pi.jsonl"); writeFileSync(sessionFile, '{"type":"session","id":"recorded-pi"}\n');
  const configDir = join(root, "claude-config"), codexHome = join(root, "codex-home");
  const transcriptDir = join(configDir, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(transcriptDir, { recursive: true }); mkdirSync(join(codexHome, "sessions"), { recursive: true });
  for (const id of [`recorded-${peer}`, `accepted-${peer}`]) {
    writeFileSync(join(transcriptDir, `${id}.jsonl`), "{}\n"); writeFileSync(join(codexHome, "sessions", `${id}.jsonl`), "{}\n");
  }
  const launch = { packageEntrypoint: "/old/main.js", command: "unused fixture command", argv: [], env: { CLAUDE_CONFIG_DIR: configDir, CODEX_HOME: codexHome } };
  const original: TerminalBinding = { peer, handle: "term-original", incarnationId: "inc-original", worktreeId: "wt", projectRoot: root,
    sessionId: `recorded-${peer}`, ...(peer === "pi" ? { sessionFile, backend: "dgx", model: "dgx/coding" } : {}), launch, launchMetadata: launch };
  const saved: TerminalBinding = { ...original, ...(accepted ? { sessionId: `accepted-${peer}` } : {}), handle: "term-restored", incarnationId: "inc-restored" };
  const planned: PlannedProject = { project: { id: "p-215", root, stateDir, instanceId: "i-source", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL,
      peers: [{ id: peer, state: "idle", ...(peer === "codex" ? { threadId: original.sessionId } : { sessionId: original.sessionId }), ...(peer === "pi" ? { sessionFile, args: { mode: "tui", backend: "dgx", model: "dgx/coding" } } : {}) }], blockers: [] },
    terminals: [original], blockers: [] };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "peers-restored",
    terminals: { [`closed:${peer}`]: true, [`restored:${peer}`]: { state: "done", binding: saved } } };
  const op = { schema: 1, id: "op-463", sourceRoot: PACKAGE_ROOT, targetRoot: PACKAGE_ROOT,
    plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  const control = { attached: false, sessionId: saved.sessionId, sessionFile, terminal: "orphaned" as "orphaned" | "missing" | "unknown" | "live" | "replacement", attachAfterCreate: true, interruptWait: false, failCreate: false,
    targetOperation: op.id, targetVersion: VERSION, targetInstance: "i-target", allowStop: false, busyAfterCreate: false, omitSessionFile: false, resumeAttachAfterNextCreate: false, expectFence: true };
  let created = 0, elapsed = 0, postCreateReads = 0;
  const snapshots: ProjectProgress[] = [], commands: string[][] = [];
  const save = () => snapshots.push(structuredClone(progress));
  const view = () => {
    const attached = control.attached;
    if (created && !attached && control.attachAfterCreate && ++postCreateReads > 0) queueMicrotask(() => { control.attached = true; });
    return { operationId: control.targetOperation, phase: "restored", ready: attached,
      peers: { [peer]: { id: peer, state: attached ? "idle" : "offline", ...(peer === "codex" ? { threadId: control.sessionId } : { sessionId: control.sessionId }), ...(peer === "pi" ? { ...(!control.omitSessionFile ? { sessionFile: control.sessionFile } : {}),
        launch: { mode: "tui", backend: "dgx", model: "dgx/coding", ...(!control.omitSessionFile ? { sessionFile: control.sessionFile } : {}) } } : {}) } }, integrity: { expected: {}, current: {} } };
  };
  const stopObservations: { instance: unknown; bookmarkPresent: boolean; restartPresent: boolean }[] = [];
  const server = Bun.serve<any>({ hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-215", instanceId: control.targetInstance, cwd: root, protocol: PROTOCOL }));
      else if (msg.t === "status") ws.send(JSON.stringify({ rid: msg.rid, t: "status", ok: true, status: { projectId: "p-215", instanceId: control.targetInstance, cwd: root, version: control.targetVersion, protocol: PROTOCOL } }));
      else if (msg.t === "kill") {
        stopObservations.push({ instance: msg.instanceId, bookmarkPresent: existsSync(join(stateDir, "recovery-continuity.json")), restartPresent: existsSync(join(stateDir, "restart.json")) });
        if (!control.allowStop || msg.instanceId !== "i-target") { ws.send(JSON.stringify({ rid: msg.rid, ok: false, error: "fixture refuses to stop an unowned target" })); return; }
        ws.send(JSON.stringify({ rid: msg.rid, ok: true, t: "stopping" })); rmSync(join(stateDir, "status.json"), { force: true });
      } else if (created && control.busyAfterCreate) ws.send(JSON.stringify({ rid: msg.rid, ok: false, code: "database_busy", retryable: true, error: "a database is busy" }));
      else ws.send(JSON.stringify({ rid: msg.rid, t: "recovery", ok: true, recovery: view() }));
    } },
  });
  writeFileSync(join(stateDir, "control-token"), "token-463\n");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL, projectId: "p-215", instanceId: "i-target", cwd: root }));
  const shown = () => ({ handle: created ? created === 1 ? "term-repair" : `term-repair-${created}` : control.terminal === "replacement" ? "term-other" : saved.handle,
    incarnationId: created ? created === 1 ? "inc-repair" : `inc-repair-${created}` : control.terminal === "replacement" ? "inc-other" : saved.incarnationId,
    worktreeId: "wt", worktreePath: root, agentIdentity: peer, sessionId: control.sessionId, env: launch.env,
    sessionFile: control.sessionFile, backend: "dgx", model: "dgx/coding",
    connected: control.terminal === "live", orphaned: control.terminal === "orphaned", state: control.terminal === "orphaned" ? "exited" : "idle" });
  const runner = async (argv: string[]) => {
    commands.push(argv);
    if (argv[1] !== "terminal") throw new Error("non-terminal execution is forbidden in this fixture");
    let result: unknown;
    if (argv[2] === "create") {
      // Intent must be durable before the first create attempt, even if the runner then fails or is interrupted.
      if (control.expectFence) expect((snapshots.at(-1) as any)?.reattachments?.[peer]?.state).toBe("attempted");
      else {
        expect(progress.reattachments?.[peer]).toBeUndefined();
        expect(progress.restarts?.length).toBeGreaterThan(0); // explicitly selected ordinary #225 restart
      }
      created++;
      if (control.failCreate) return { code: 1, stdout: "fixture create refused", stderr: "" };
      control.terminal = "live";
      if (control.resumeAttachAfterNextCreate) { control.attachAfterCreate = true; control.resumeAttachAfterNextCreate = false; }
      result = { terminal: shown() };
    } else if (argv[2] === "list") {
      if (control.terminal === "unknown") return { code: 1, stdout: "unreadable fixture inventory", stderr: "" };
      result = { terminals: control.terminal === "missing" ? [] : [shown()] };
    } else if (argv[2] === "show") {
      if (control.terminal === "unknown") return { code: 1, stdout: "unreadable fixture terminal", stderr: "" };
      if (control.terminal === "missing") return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }), stderr: "" };
      result = { terminal: shown() };
    } else if (argv[2] === "wait") result = { wait: { satisfied: true } };
    else throw new Error("unexpected terminal mutation in detached fixture");
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const driver = makeRecoveryDriver(runner, undefined, { now: () => elapsed, sleep: async ms => { elapsed += ms; if (control.interruptWait) throw new Error("fixture repair interrupted"); } });
  const verify = () => driver.verify(planned, progress, op, save);
  const restore = () => driver.restore(planned, progress, op, peer === "claude" ? "claude" : "native", save, peer);
  const recordLauncher = (instanceId: string, invalid = false) => {
    if (instanceId !== progress.instanceId) progress.restarts = [{ instanceId, at: 1 }];
    writeFileSync(join(stateDir, "terminal-recovery.json"), JSON.stringify([invalid
      ? { peer, projectRoot: root, instanceId, launcherPid: "unreadable" }
      : { peer, projectRoot: root, stateDir, instanceId, launcherPid: process.pid, launcherSignature: processSignature(process.pid),
        launchId: "fixture-463", handle: saved.handle, incarnationId: saved.incarnationId, worktreeId: "wt", env: {} }]));
  };
  return { root, stateDir, planned, progress, op, control, original, saved, driver, stopObservations, commands, snapshots, save, verify, restore, recordLauncher, creates: () => created,
    cleanup: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

for (const terminal of ["orphaned", "missing"] as const) test(`#463 offline Pi with ${terminal} done terminal is durably armed for one same-session re-restore`, async () => {
  const f = detachedAfterRestoreFixture(); f.control.terminal = terminal;
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore");
    expect(f.progress.terminals["restored:pi"]).toEqual({ state: "failed" });
    expect(f.progress.phase).toBe("started");
    expect((f.progress as any).reattachments.pi).toMatchObject({ state: "ready", cause: "detached after restore", binding: f.saved });
    expect((f.snapshots.at(-1) as any)?.reattachments?.pi?.state).toBe("ready");
    await f.restore();
    expect(f.creates()).toBe(1);
    const command = f.commands.find(argv => argv[2] === "create")!;
    const body = command[command.indexOf("--command") + 1]!;
    for (const expected of ["--session-file", f.saved.sessionFile!, "--backend", "dgx", "--model", "dgx/coding"]) expect(body).toContain(expected);
    expect(f.snapshots.some(snapshot => (snapshot.terminals["restored:pi"] as any)?.state === "waiting" && (snapshot.terminals["restored:pi"] as any)?.binding.handle === "term-repair")).toBe(true);
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "done", binding: { handle: "term-repair", incarnationId: "inc-repair", sessionId: f.saved.sessionId, sessionFile: f.saved.sessionFile, backend: "dgx", model: "dgx/coding" } });
    expect((f.progress as any).reattachments.pi.state).toBe("attempted");
    await f.verify();
    expect(f.progress.fresh).toBeUndefined();
    expect(nextActions(f.op).some(action => action.includes("--fresh-session"))).toBe(false);
  } finally { f.cleanup(); }
});

test("#463 a second post-restore detach blocks without rearming or creating another terminal", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore"); await f.restore();
    f.control.attached = false; f.control.attachAfterCreate = false; f.control.terminal = "orphaned";
    await expect(f.verify()).rejects.toThrow(/detached after restore|already attempted|reattach/i);
    expect((f.progress as any).reattachments.pi.state).toBe("attempted");
    const before = structuredClone(f.progress.terminals["restored:pi"]);
    await expect(f.restore()).rejects.toThrow();
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:pi"]).toEqual(before);
  } finally { f.cleanup(); }
});

test("#463 interrupted repair resumes its durable waiting binding without consuming a second terminal", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore");
    f.control.attachAfterCreate = false; f.control.interruptWait = true;
    await expect(f.restore()).rejects.toThrow("fixture repair interrupted");
    expect(f.creates()).toBe(1);
    expect((f.snapshots.at(-1) as any)?.reattachments?.pi?.state).toBe("attempted");
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "waiting", binding: { handle: "term-repair" } });
    f.control.interruptWait = false; f.control.attachAfterCreate = true;
    await f.restore(); await f.verify();
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "done", binding: { handle: "term-repair", sessionId: f.saved.sessionId } });
  } finally { f.cleanup(); }
});

test("#463 failed repair creation retains attempted intent and cannot launch a second terminal", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore");
    f.control.failCreate = true;
    await expect(f.restore()).rejects.toThrow();
    expect((f.progress as any).reattachments.pi.state).toBe("attempted");
    expect(f.creates()).toBe(1);
    f.control.failCreate = false;
    await expect(f.restore()).rejects.toThrow();
    expect(f.creates()).toBe(1);
    expect(nextActions(f.op).some(action => action.includes("--fresh-session"))).toBe(false);
  } finally { f.cleanup(); }
});

for (const condition of ["live-wrong-session", "live-wrong-file", "unknown-terminal", "replacement-terminal", "current-launcher", "older-launcher", "unknown-launcher"] as const) test(`#463 ${condition} cannot arm automatic repair or erase a done receipt`, async () => {
  const f = detachedAfterRestoreFixture();
  if (condition === "live-wrong-session") { f.control.attached = true; f.control.sessionId = "different-pi"; f.control.terminal = "live"; }
  if (condition === "live-wrong-file") { f.control.attached = true; f.control.sessionFile = join(f.stateDir, "different.jsonl"); f.control.terminal = "live"; }
  if (condition === "unknown-terminal") f.control.terminal = "unknown";
  if (condition === "replacement-terminal") f.control.terminal = "replacement";
  if (condition === "current-launcher") f.recordLauncher("i-target");
  if (condition === "older-launcher") f.recordLauncher("i-older");
  if (condition === "unknown-launcher") f.recordLauncher("i-target", true);
  const before = structuredClone(f.progress);
  try {
    await expect(f.verify()).rejects.toThrow();
    expect((f.progress as any).reattachments).toBeUndefined();
    expect(f.progress.terminals).toEqual(before.terminals);
    expect(f.progress.phase).toBe(before.phase);
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

for (const peer of ["codex", "claude"] as const) test(`#463 ${peer} repairs the last accepted conversation instead of reverting to its original plan`, async () => {
  const f = detachedAfterRestoreFixture(peer, true);
  try {
    expect(f.saved.sessionId).not.toBe(f.original.sessionId);
    await expect(f.verify()).rejects.toThrow("detached after restore");
    expect(f.progress.reattachments?.[peer]?.binding.sessionId).toBe(f.saved.sessionId);
    await f.restore();
    const argv = f.commands.find(command => command[2] === "create")!;
    const command = argv[argv.indexOf("--command") + 1]!;
    expect(command).toContain(f.saved.sessionId);
    expect(command).not.toContain(f.original.sessionId);
    expect(f.progress.terminals[`restored:${peer}`]).toMatchObject({ state: "done", binding: { sessionId: f.saved.sessionId } });
    await f.verify();
    // Even the originally planned id is now a different conversation: repair has one exact accepted identity.
    f.control.sessionId = f.original.sessionId;
    await expect(f.verify()).rejects.toThrow(/different.*conversation/i);
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals[`restored:${peer}`]).toMatchObject({ state: "done", binding: { sessionId: f.saved.sessionId } });
    expect(f.progress.fresh).toBeUndefined();
  } finally { f.cleanup(); }
});

for (const changed of ["operation", "version"] as const) test(`#463 a changed target ${changed} cannot arm detached repair`, async () => {
  const f = detachedAfterRestoreFixture();
  if (changed === "operation") f.control.targetOperation = "another-operation";
  else f.control.targetVersion = "0.0.0";
  const before = structuredClone(f.progress);
  try {
    await expect(f.verify()).rejects.toThrow("target identity verification failed");
    expect(f.progress).toEqual(before);
    expect(f.snapshots).toEqual([]);
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

test("#463 stop-and-archive writes Pi continuity only after its owned target stopped and snapshot archived", async () => {
  const f = detachedAfterRestoreFixture();
  const homeBefore = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(f.root, "home");
  const operation = crypto.randomUUID(); f.op.id = operation; f.control.targetOperation = operation;
  const bookmark = join(f.stateDir, "recovery-continuity.json");
  const restart = join(f.stateDir, "restart.json");
  const archive = join(f.stateDir, `restart.abandoned.${createHash("sha256").update(operation).digest("hex")}.json`);
  writeFileSync(restart, JSON.stringify({ operationId: operation, projectId: f.planned.project.id, projectRoot: f.root }));
  try {
    await expect(f.driver.stopAndArchive(f.planned.project, f.op, "unowned-instance")).rejects.toThrow("unowned target");
    expect(existsSync(bookmark)).toBe(false); expect(existsSync(restart)).toBe(true); expect(existsSync(archive)).toBe(false);
    f.control.allowStop = true;
    await f.driver.stopAndArchive(f.planned.project, f.op, "i-target");
    expect(f.stopObservations).toEqual([
      { instance: "unowned-instance", bookmarkPresent: false, restartPresent: true },
      { instance: "i-target", bookmarkPresent: false, restartPresent: true },
    ]);
    expect(existsSync(join(f.stateDir, "status.json"))).toBe(false);
    expect(existsSync(restart)).toBe(false); expect(existsSync(archive)).toBe(true);
    const continuity = JSON.parse(readFileSync(bookmark, "utf8"));
    expect(continuity).toMatchObject({ operationId: operation, projectId: f.planned.project.id, projectRoot: f.root,
      pi: { sessionId: f.saved.sessionId, sessionFile: f.saved.sessionFile, backend: "dgx", model: "dgx/coding" } });
    expect(f.creates()).toBe(0);
  } finally {
    if (homeBefore === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = homeBefore;
    f.cleanup();
  }
});

test("#463 an archive failure after the owned fake stop cannot leave a continuity bookmark", async () => {
  const f = detachedAfterRestoreFixture();
  const homeBefore = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = join(f.root, "home");
  const operation = crypto.randomUUID(); f.op.id = operation; f.control.targetOperation = operation;
  const archive = join(f.stateDir, `restart.abandoned.${createHash("sha256").update(operation).digest("hex")}.json`);
  writeFileSync(join(f.stateDir, "restart.json"), JSON.stringify({ operationId: operation }));
  mkdirSync(archive); // rename of the snapshot onto a directory is a real archival write failure.
  f.control.allowStop = true;
  try {
    await expect(f.driver.stopAndArchive(f.planned.project, f.op, "i-target")).rejects.toThrow();
    expect(existsSync(join(f.stateDir, "status.json"))).toBe(false);
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(true);
    expect(existsSync(join(f.stateDir, "recovery-continuity.json"))).toBe(false);
    expect(f.creates()).toBe(0);
  } finally {
    if (homeBefore === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = homeBefore;
    f.cleanup();
  }
});

test("#463 a snapshot owned by another operation cannot authorize a continuity bookmark", async () => {
  const f = detachedAfterRestoreFixture();
  const homeBefore = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = join(f.root, "home");
  const operation = crypto.randomUUID(); f.op.id = operation; f.control.targetOperation = operation;
  const other = crypto.randomUUID();
  writeFileSync(join(f.stateDir, "restart.json"), JSON.stringify({ operationId: other }));
  f.control.allowStop = true;
  try {
    await expect(f.driver.stopAndArchive(f.planned.project, f.op, "i-target")).resolves.toEqual({ continuity: "not-archived" });
    expect(existsSync(join(f.stateDir, "status.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.stateDir, "restart.json"), "utf8")).operationId).toBe(other);
    expect(existsSync(join(f.stateDir, "recovery-continuity.json"))).toBe(false);
  } finally {
    if (homeBefore === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = homeBefore;
    f.cleanup();
  }
});

for (const phase of ["pending", "prepared"] as const) test(`#463 stop-and-archive succeeds for a stopped ${phase} Pi project with no snapshot`, async () => {
  const f = detachedAfterRestoreFixture();
  const homeBefore = process.env.AGENTHUB_HOME; process.env.AGENTHUB_HOME = join(f.root, "home");
  f.op.id = crypto.randomUUID(); f.progress.phase = phase; f.progress.terminals = {};
  rmSync(join(f.stateDir, "status.json"));
  try {
    await expect(f.driver.stopAndArchive(f.planned.project, f.op)).resolves.toEqual({ continuity: "not-archived" });
    expect(existsSync(join(f.stateDir, "recovery-continuity.json"))).toBe(false);
    expect(f.stopObservations).toEqual([]); expect(f.creates()).toBe(0);
  } finally {
    if (homeBefore === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = homeBefore;
    f.cleanup();
  }
});

test("#463 multi-project disposal remains an exit when stopped Pi projects have foreign or expired snapshots", async () => {
  const alpha = detachedAfterRestoreFixture(), beta = detachedAfterRestoreFixture();
  const homeBefore = process.env.AGENTHUB_HOME; const home = join(alpha.root, "home"); process.env.AGENTHUB_HOME = home;
  const betaPlan = { ...beta.planned, project: { ...beta.planned.project, id: "beta" } };
  const body: Omit<UpgradePlan, "fingerprint"> = { schema: 1, kind: "upgrade", version: VERSION, sourceRoot: PACKAGE_ROOT, sourceDigest: "fixture-source", projects: [alpha.planned, betaPlan], blockers: [] };
  const operation = createOperation({ ...body, fingerprint: planFingerprint(body) }, PACKAGE_ROOT, home);
  operation.phase = "blocked"; operation.projects[1]!.phase = "prepared";
  writeOperation(operation.id, operation, home);
  const foreign = JSON.stringify({ operationId: crypto.randomUUID(), preserved: "another operation's evidence" });
  writeFileSync(join(alpha.stateDir, "restart.json"), foreign);
  rmSync(join(alpha.stateDir, "status.json")); rmSync(join(beta.stateDir, "status.json"));
  const archived: string[] = [];
  const driver: typeof alpha.driver = { ...alpha.driver,
    inspect: async () => ({ state: "stopped", peers: [], blockers: [] }),
    stopAndArchive: async (project, op, instance) => {
      archived.push(project.id); expect(instance).toBeUndefined();
      return (project.id === "beta" ? beta.driver : alpha.driver).stopAndArchive(project, op, instance);
    },
  };
  try {
    const result = await disposeRecovery(operation.id, { stop: true }, "last-resort exit after an interrupted upgrade", driver, home);
    expect(result.phase).toBe("cancelled");
    expect(result.disposition?.projects).toEqual({ "p-215": "stopped", beta: "stopped" });
    expect(result.disposition?.continuity).toEqual({ "p-215": "not-archived", beta: "not-archived" });
    expect(archived).toEqual(["p-215", "beta"]);
    expect(recoveryLock(home)).toBeUndefined();
    expect(readOperation<RecoveryOperation>(operation.id, home).phase).toBe("cancelled");
    expect(readFileSync(join(alpha.stateDir, "restart.json"), "utf8")).toBe(foreign);
    expect(existsSync(join(alpha.stateDir, "recovery-continuity.json"))).toBe(false);
    expect(existsSync(join(beta.stateDir, "recovery-continuity.json"))).toBe(false);
  } finally {
    if (homeBefore === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = homeBefore;
    alpha.cleanup(); beta.cleanup();
  }
});

test("#463 database contention during a repair preserves the retryable busy outcome", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore");
    f.control.busyAfterCreate = true;
    await expect(f.restore()).rejects.toMatchObject({ code: "database_busy", retryable: true });
    expect(f.creates()).toBe(1);
    expect(f.progress.reattachments?.pi?.state).toBe("attempted");
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "waiting" });
  } finally { f.cleanup(); }
});

test("#463 non-repair Pi revalidation accepts a verified-empty id-only attachment", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    // Pi's verified-empty metadata deliberately omits the file from the source and target, while its captured
    // terminal binding can retain the historical selector. No repair permits a new identity here.
    delete f.planned.source.peers[0]!.sessionFile;
    f.control.attached = true; f.control.terminal = "live"; f.control.omitSessionFile = true;
    await f.verify();
    expect(f.progress.reattachments).toBeUndefined();
    expect(f.progress.terminals["restored:pi"]).toMatchObject({ state: "done", binding: { sessionId: f.saved.sessionId } });
    expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

test("#463 repaired Pi still requires its exact recorded file when target metadata omits it", async () => {
  const f = detachedAfterRestoreFixture();
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore"); await f.restore();
    f.control.omitSessionFile = true;
    await expect(f.verify()).rejects.toThrow(/different.*conversation|session changed/i);
    expect(f.progress.reattachments?.pi?.state).toBe("attempted");
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});

test("#463 a target restart after repair permits the ordinary retired-binding relaunch of the accepted Codex id", async () => {
  const f = detachedAfterRestoreFixture("codex", true);
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore"); await f.restore(); await f.verify();
    expect(f.progress.reattachments?.codex?.state).toBe("attempted");
    recordRestart(f.progress, 100);
    expect(f.progress.terminals["retired:codex"]).toMatchObject({ sessionId: f.saved.sessionId, handle: "term-repair" });
    expect(f.progress.reattachments?.codex).toBeUndefined();
    f.control.expectFence = false; // This scenario deliberately tests the ordinary #225 relaunch, not repair creation.
    f.progress.phase = "started"; f.progress.instanceId = "i-next-target"; f.control.targetInstance = "i-next-target";
    f.control.attached = false; f.control.terminal = "missing"; f.control.attachAfterCreate = false; f.control.resumeAttachAfterNextCreate = true;
    writeFileSync(join(f.stateDir, "status.json"), JSON.stringify({ controlPort: JSON.parse(readFileSync(join(f.stateDir, "status.json"), "utf8")).controlPort,
      protocol: PROTOCOL, projectId: f.planned.project.id, instanceId: f.progress.instanceId, cwd: f.root }));
    await f.restore(); await f.verify();
    expect(f.creates()).toBe(2);
    expect(f.progress.terminals["closedRetired:codex"]).toBe(true);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-repair-2", sessionId: f.saved.sessionId } });
    const creates = f.commands.filter(argv => argv[2] === "create");
    expect(creates[1]![creates[1]!.indexOf("--command") + 1]).toContain(f.saved.sessionId);
  } finally { f.cleanup(); }
});

// Optional continuity metadata must not turn the last-resort disposal into a permanent machine lock.
test("#463 unavailable bookmark storage is reported after archival without failing stop-and-archive", async () => {
  const f = detachedAfterRestoreFixture();
  const operation = crypto.randomUUID(); f.op.id = operation; f.control.targetOperation = operation;
  writeFileSync(join(f.stateDir, "restart.json"), JSON.stringify({ operationId: operation }));
  mkdirSync(join(f.stateDir, "recovery-continuity-lock.db"));
  try {
    await expect(f.driver.stopAndArchive(f.planned.project, f.op)).resolves.toEqual({ continuity: "unavailable" });
    expect(existsSync(join(f.stateDir, "restart.json"))).toBe(false);
    expect(existsSync(join(f.stateDir, `restart.abandoned.${createHash("sha256").update(operation).digest("hex")}.json`))).toBe(true);
    expect(existsSync(join(f.stateDir, "recovery-continuity.json"))).toBe(false);
  } finally { f.cleanup(); }
});

for (const check of ["queues", "manualPaused", "boardDigest", "budgetDigest"] as const) test(`#466 verify reports the actual ${check} preservation comparison as a typed cause`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-466-cause-"))), stateDir = join(root, "state"); mkdirSync(stateDir);
  const expected = { queues: { codex: ["queued-one"] }, manualPaused: ["codex"], boardDigest: "board-before", budgetDigest: "budget-before" };
  const current = { ...expected, [check]: check === "queues" ? { codex: [] } : check === "manualPaused" ? [] : "different" };
  const server = fakeHub(root, stateDir, "i-target", () => ({ operationId: "op-466", phase: "restored", ready: true, peers: {}, integrity: { expected, current } }));
  const planned: PlannedProject = { project: { id: "p-215", root, stateDir, instanceId: "i-source", pid: null, basePort: 4600 }, source: { state: "running", peers: [], blockers: [] }, terminals: [], blockers: [] };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "peers-restored", terminals: {} };
  const op = { id: "op-466", plan: { version: VERSION, projects: [planned] }, projects: [progress] } as RecoveryOperation;
  const driver = makeRecoveryDriver(async () => { throw new Error("verify must not create a terminal"); }, undefined, { now: () => 1250, sleep: async () => { throw new Error("verify must not wait"); } });
  try {
    let error: unknown; try { await driver.verify(planned, progress, op); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as { presentationCause?: unknown }).presentationCause).toEqual({ kind: "preservation", check, projectId: planned.project.id });
    expect((error as Error).message).toBe("queue, manual pause, task board or budget preservation was not verified");
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("#466 actual managed attachment wait records its existing bound and completed fake-clock interval", async () => {
  const f = delayedManagedFixture("codex"), snapshots: any[] = [];
  f.op.step = "restore:p-215"; f.control.attachAfterMs = 2000;
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => { snapshots.push(JSON.parse(JSON.stringify((f.op as any).waits ?? null))); });
    const timing = (f.op as any).waits?.[f.op.step];
    expect(timing).toEqual({ waitStartedAt: new Date(0).toISOString(), deadlineAt: new Date(600_000).toISOString(), waitEndedAt: new Date(f.elapsed()).toISOString() });
    expect(snapshots.some(saved => saved?.[f.op.step]?.waitStartedAt === new Date(0).toISOString() && saved[f.op.step].waitEndedAt === undefined)).toBe(true);
    expect(f.elapsed()).toBeGreaterThanOrEqual(2000); expect(f.elapsed()).toBeLessThan(600_000); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done" });
  } finally { f.cleanup(); }
});

test("#466 an interrupted managed wait records its actual end but keeps the saved binding and original error", async () => {
  const f = delayedManagedFixture("codex");
  f.op.step = "restore:p-215"; f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("fixture coordinator interrupted");
    expect((f.op as any).waits?.[f.op.step]).toEqual({ waitStartedAt: new Date(0).toISOString(), deadlineAt: new Date(600_000).toISOString(), waitEndedAt: new Date(1000).toISOString() });
    expect(f.elapsed()).toBe(1000); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", binding: { handle: "term-new" } });
  } finally { f.cleanup(); }
});

test("#466 a saved terminal identity rejection exposes only its actual native recovery metadata", async () => {
  const f = delayedManagedFixture("codex");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    f.replaceTerminal();
    const error = await f.driver.verify(f.planned, f.progress, f.op).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("codex: saved terminal identity changed or is not verified; manual-required");
    expect(error.presentationCause).toEqual({ kind: "native_recovery", reason: "terminal_unverified", projectId: "p-215", peer: "codex", handle: "term-new" });
    expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "done", binding: { handle: "term-new" } });
    expect(JSON.stringify(error.presentationCause)).not.toContain("PRIVATE-TERMINAL-TEXT");
  } finally { f.cleanup(); }
});

for (const at of ["attachment", "verification"] as const) test(`#466 a wrong session during ${at} exposes the actual recorded and attached identities`, async () => {
  const f = delayedManagedFixture("codex");
  try {
    if (at === "verification") await f.driver.restore(f.planned, f.progress, f.op, "native", () => {});
    f.control.wrongSession = true;
    const error = await (at === "attachment" ? f.driver.restore(f.planned, f.progress, f.op, "native", () => {}) : f.driver.verify(f.planned, f.progress, f.op)).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(at === "attachment" ? "codex: a different conversation attached while awaiting session-414" : "Codex resumed a different conversation");
    expect(error.presentationCause).toMatchObject({ kind: "native_recovery", reason: "session_changed", projectId: "p-215", peer: "codex", expectedSession: "session-414", observedSession: "different-session" });
    expect(f.creates()).toBe(1); expect(f.progress.fresh).toBeUndefined();
  } finally { f.cleanup(); }
});

for (const evidence of ["unknown", "replacement"] as const) test(`#466 a chosen ${evidence} launcher exposes a typed block without changing its waiting receipt`, async () => {
  const f = delayedManagedFixture("codex", "pending");
  f.control.attachAfterRead = false; f.control.interruptAtMs = 1000;
  try {
    await expect(f.driver.restore(f.planned, f.progress, f.op, "native", () => {})).rejects.toThrow("fixture coordinator interrupted");
    f.control.interruptAtMs = Infinity;
    const file = join(f.stateDir, "terminal-recovery.json");
    if (evidence === "unknown") writeFileSync(file, "not JSON");
    else {
      const rows = JSON.parse(readFileSync(file, "utf8")); rows[0].handle = "term-replacement"; rows[0].incarnationId = "inc-replacement";
      writeFileSync(file, JSON.stringify(rows));
    }
    const error = await f.driver.restore(f.planned, f.progress, f.op, "native", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(evidence === "unknown" ? "identity cannot be verified" : "saved terminal identity changed");
    expect(error.presentationCause).toEqual({ kind: "native_recovery", reason: "launcher_unverified", projectId: "p-215", peer: "codex", handle: "term-new", launcherState: evidence === "unknown" ? "unknown" : "replaced" });
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
    expect(f.elapsed()).toBe(1000); expect(f.creates()).toBe(0);
  } finally { f.cleanup(); }
});

test("#466 a target becoming unavailable during attachment exposes its actual state without treating it as gone", async () => {
  const f = delayedManagedFixture("codex", "pending");
  f.control.attachAfterRead = false; f.control.unavailableAtMs = 1000; f.control.interruptAtMs = 2000;
  try {
    const error = await f.driver.restore(f.planned, f.progress, f.op, "native", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("codex: target hub reads as unavailable while awaiting attachment; saved terminal retained");
    expect(error.presentationCause).toEqual({ kind: "native_recovery", reason: "target_unavailable", projectId: "p-215", peer: "codex", handle: "term-new", targetState: "unavailable" });
    expect(f.elapsed()).toBe(1000); expect(f.creates()).toBe(0);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending" });
  } finally { f.cleanup(); }
});

test("#466 a managed timeout exposes its exact 600-second bound and retains the chosen terminal", async () => {
  const f = delayedManagedFixture("codex"); f.control.attachAfterRead = false;
  try {
    const error = await f.driver.restore(f.planned, f.progress, f.op, "native", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("attachment not verified within 600 s");
    expect(error.presentationCause).toEqual({ kind: "native_recovery", reason: "attachment_timeout", projectId: "p-215", peer: "codex", handle: "term-new", timeoutMs: 600_000 });
    expect(f.elapsed()).toBe(600_000); expect(f.creates()).toBe(1);
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending", binding: { handle: "term-new" } });
  } finally { f.cleanup(); }
});

test("#466 an unmanaged reconnect timeout names its exact 90-second window without inventing a terminal or session", async () => {
  const f = delayedManagedFixture("claude");
  f.planned.terminals = []; f.planned.reconnectOnly = ["claude"];
  try {
    const error = await f.driver.restore(f.planned, f.progress, f.op, "claude", () => {}).catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.message).toContain("unmanaged session did not reconnect within 90 s");
    expect(error.presentationCause).toEqual({ kind: "native_recovery", reason: "attachment_timeout", projectId: "p-215", peer: "claude", timeoutMs: 90_000 });
    expect(f.elapsed()).toBe(90_000); expect(f.creates()).toBe(0);
    expect(f.progress.terminals["restored:claude"]).toBeUndefined();
  } finally { f.cleanup(); }
});

test("#466 an interrupted repair preserves its actual wrong-session cause inside the existing repair wrapper", async () => {
  const f = detachedAfterRestoreFixture("codex");
  try {
    await expect(f.verify()).rejects.toThrow("detached after restore");
    f.control.attachAfterCreate = false; f.control.interruptWait = true;
    await expect(f.restore()).rejects.toThrow("fixture repair interrupted");
    f.control.interruptWait = false; f.control.sessionId = "wrong-attached-session"; f.control.attached = true;
    const error = await f.restore().catch(error => error);
    expect(error).toBeInstanceOf(Error); expect(error.constructor.name).toBe("ReattachmentRequired");
    expect(error.message).toContain("a different conversation attached while awaiting recorded-codex");
    expect(error.presentationError?.presentationCause).toMatchObject({ kind: "native_recovery", reason: "session_changed", projectId: "p-215", peer: "codex", expectedSession: "recorded-codex", observedSession: "wrong-attached-session" });
    expect(f.progress.reattachments?.codex?.state).toBe("attempted");
    expect(f.progress.terminals["restored:codex"]).toMatchObject({ state: "waiting", origin: "pending" });
    expect(f.creates()).toBe(1);
  } finally { f.cleanup(); }
});
