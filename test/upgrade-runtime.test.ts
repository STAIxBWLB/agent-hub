import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { inspectRecovery, makeRecoveryDriver, makeUpgradePlan, PACKAGE_ROOT, restoredTerminalArgv } from "../src/cli/upgrade-runtime.ts";

/** The test operations preserve this package as their coordinator, which has every recovery command (#215). */
const COORD = `bun ${join(PACKAGE_ROOT, "src/cli/main.js")} recovery`;
import { VERSION } from "../src/version.ts";
import { liveProjects, nextActions, type PlannedProject, type ProjectProgress, type RecoveryOperation } from "../src/cli/upgrade.ts";
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
function claudeRestoreFixture(attachedSession: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-restore-claude-")));
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-restore-claude-state-"));
  const configDir = mkdtempSync(join(tmpdir(), "ahub-restore-claude-config-"));
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(_request, srv) { return srv.upgrade(_request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
      if (msg.t === "hello") ws.send(JSON.stringify({ rid: msg.rid, t: "welcome", ok: true, projectId: "p-restore", instanceId: "i-target", cwd: root, protocol: PROTOCOL }));
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

test("a pending restored:claude accepts a fresh attach when the original session never persisted a transcript", async () => {
  const f = claudeRestoreFixture("session-F");
  try {
    await f.driver.restore(f.planned, f.progress, f.op, "claude", () => {});
    const recorded = f.progress.terminals["restored:claude"] as any;
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
function fakeHub(root: string, stateDir: string, instanceId: string, view: () => Record<string, unknown>) {
  const server = Bun.serve<any>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, srv) { return srv.upgrade(request) ? undefined : new Response("no"); },
    websocket: { message(ws, data) {
      const msg = JSON.parse(String(data));
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
    const driver = makeRecoveryDriver(run);
    // A pending create with no live launcher and no attached session left nothing to reconcile: failed.
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("its launcher no longer runs and no codex session attached");
    expect(progress.terminals["restored:codex"]).toBe("failed");

    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("resume launches it again once the cause is fixed");
    // The runner ends the error with these choices, the same list as status.
    expect(nextActions(op, undefined, await liveProjects(op, inspectRecovery))).toEqual([`${COORD} resume op-215`, `${COORD} dispose op-215 --fresh-session codex --reason <text>`, `${COORD} dispose op-215 --stop-and-archive --reason <text>`]);
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(calls).toEqual([]); // no rollout: found before any terminal was created

    writeFileSync(join(sessions, "rollout-2026-10-09T00-00-00-thread-T.jsonl"), "{}\n");
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("the codex restoration launcher in terminal term-new exited before its TUI was ready");
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    expect(calls.some((argv) => argv.includes("exit"))).toBe(false);

    // A failed receipt is settled by what is live: a launcher still running is waited for, never doubled.
    record(true, "term-elsewhere");
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow(`its launcher in terminal term-elsewhere is running but no codex session attached yet; no terminal was created; wait until it attaches, or end it and close terminal term-elsewhere first`);
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    // ...and once the planned thread attached there, the failed receipt is the restoration.
    replacement.sessionId = "thread-T"; attachedThread = "thread-T";
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ handle: "term-new", sessionId: "thread-T" });
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
    // A fresh session chosen for it lost nothing when the original attaches after all.
    progress.terminals["restored:codex"] = "failed";
    progress.fresh = { codex: { lost: "thread-T", reason: "chosen before the original came back", at: 1 } };
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ sessionId: "thread-T" });
    expect(progress.fresh).toBeUndefined();
    // A chosen new session found attached when a pending launch is settled is accepted with its waiver written here,
    // not only by the launch that normally writes it first.
    progress.terminals["restored:codex"] = "pending";
    progress.fresh = { codex: { lost: "thread-T", reason: "chosen", at: 1 } };
    replacement.sessionId = "thread-other"; attachedThread = "thread-other";
    rmSync(join(stateDir, "recovery-waivers.json"), { force: true });
    await driver.restore(planned, progress, op, "native", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ sessionId: "thread-other" });
    expect(readRecoveryWaivers(stateDir, "op-215")).toEqual({ codex: "fresh-session" });
    delete progress.fresh; rmSync(join(stateDir, "recovery-waivers.json"), { force: true });
    progress.terminals["restored:codex"] = "failed"; replacement.sessionId = "thread-new"; attachedThread = undefined;
    record(false);

    progress.fresh = { codex: { lost: "thread-T", reason: "test", at: 1 } };
    resumes = true;
    await driver.restore(planned, progress, op, "native", () => {});
    expect((progress.terminals["restored:codex"] as { sessionId: string }).sessionId).toBe("thread-new");
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
    expect(progress.terminals["restored:pi"]).toBe("failed");

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
    expect(progress.terminals["restored:codex"]).toMatchObject({ handle: "term-attached", sessionId: "thread-T" });

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
    expect(progress.terminals["restored:codex"]).toBe("pending");
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
    expect(progress.terminals["restored:codex"]).toMatchObject({ handle: "term-new", sessionId: "thread-new" });
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
    expect(progress.terminals["restored:codex"]).toMatchObject({ handle: "term-new", sessionId: "thread-accepted" });
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
    expect(progress.terminals["restored:codex"]).toMatchObject({ sessionId: "thread-accepted" });
    expect(progress.fresh?.codex).toMatchObject({ lost: "thread-T" });
    // The accepted Claude session never got a transcript: it starts new rather than resuming S-accepted.
    await driver.restore(planned, progress, op, "claude", () => {});
    const create = calls.filter((c) => c[2] === "create").at(-1)!;
    const command = create[create.indexOf("--command") + 1]!;
    expect(command).toEndWith("'claude'");
    expect(command).not.toContain("--resume");
    expect(progress.terminals["restored:claude"]).toMatchObject({ sessionId: "S-new" });
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
    await makeRecoveryDriver(run).restore(planned, progress, op, "codex", () => {});
    expect(progress.terminals["restored:codex"]).toMatchObject({ sessionId: "thread-T" });
    expect(progress.fresh).toBeUndefined();
    expect(readRecoveryWaivers(stateDir, "op-225")).toEqual({ codex: "fresh-session" });
  } finally {
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
    server.stop(true); rmSync(temp, { recursive: true, force: true });
  }
});
