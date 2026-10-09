import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient, PROTOCOL } from "../src/hub/control-client.ts";
import { inspectRecovery, makeRecoveryDriver, makeUpgradePlan, restoredTerminalArgv } from "../src/cli/upgrade-runtime.ts";
import { VERSION } from "../src/version.ts";
import type { PlannedProject, ProjectProgress, RecoveryOperation } from "../src/cli/upgrade.ts";
import { Registry } from "../src/hub/registry.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { readRecoveryWaivers } from "../src/hub/restart.ts";

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
  const op = { id: "op-215", plan: { version: VERSION } } as RecoveryOperation;
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
  let exits = true;
  const replacement = { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt", worktreePath: temp, agentIdentity: "codex", sessionId: "thread-new", connected: true };
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    const result = argv[2] === "create" ? { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId: "wt" } }
      : argv[2] === "show" ? { terminal: replacement }
      : argv[2] === "wait" ? { satisfied: argv.includes("exit") ? exits : !exits } : { terminals: [replacement] };
    return { code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  const launch = { packageEntrypoint: "/pkg/main.js", command: "unused", argv: [], env: { CODEX_HOME: codexHome } };
  const planned: PlannedProject = {
    project: { id: "p-215", root: temp, stateDir, instanceId: "i-target", pid: null, basePort: 4600 },
    source: { state: "running", instanceId: "i-source", version: VERSION, protocol: PROTOCOL, peers: [{ id: "codex", state: "idle", threadId: "thread-T" }], blockers: [] },
    terminals: [{ peer: "codex", handle: "term-codex", incarnationId: "inc-codex", worktreeId: "wt", projectRoot: temp, sessionId: "thread-T", launch, launchMetadata: launch }], blockers: [],
  };
  const progress: ProjectProgress = { id: "p-215", instanceId: "i-target", phase: "started", terminals: { "closed:codex": true } };
  const op = { id: "op-215", targetRoot: "/target", plan: { version: VERSION } } as RecoveryOperation;
  const previousHome = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(temp, "home");
  try {
    const driver = makeRecoveryDriver(run);
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("--fresh-session codex --reason <text>");
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(calls).toEqual([]); // found before any terminal was created

    writeFileSync(join(sessions, "rollout-2026-10-09T00-00-00-thread-T.jsonl"), "{}\n");
    await expect(driver.restore(planned, progress, op, "native", () => {})).rejects.toThrow("its restoration launcher exited before the session was ready");
    expect(progress.terminals["restored:codex"]).toBe("failed");
    expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);

    progress.fresh = { codex: { lost: "thread-T", reason: "test", at: 1 } };
    exits = false; attachedThread = "thread-new";
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
