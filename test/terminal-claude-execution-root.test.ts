import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, loadConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { Board } from "../src/hub/board.ts";
import { readClaudeLaunchProof } from "../src/hub/claude-launch-proof.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";

async function fixture(role: "implementer" | "verifier" = "implementer") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-terminal-claude-"))), peer = "claude-builder";
  const stateDir = join(root, ".agenthub", "state"), executionCwd = join(root, ".worktrees", peer);
  mkdirSync(stateDir, { recursive: true });
  for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], ["worktree", "add", "-qb", "builder", executionCwd]]) {
    expect(hubGitSync(["-C", root, ...args], { encoding: "utf8" }).status).toBe(0);
  }
  const instances = { [peer]: { kind: "claude", roles: [role], worktree: `.worktrees/${peer}` } };
  writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances, roles: { [peer]: [role] }, memory: { enabled: false, native: false }, inference: { enabled: false }, snapshots: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, task_sweep: { enabled: false }, batch_ms: 0 }));
  writeFileSync(join(root, ".agenthub", "routing.toml"), `[local]\nfixed_model="fixture"\n[classes.implement]\npeers=[${JSON.stringify(peer)}]\n[classes.summarize]\npeers=[${JSON.stringify(peer)}]\n`);
  const workspaceGitCalls: string[][] = [];
  const instanceExecutionGit = ((args: string[], options: Parameters<typeof hubGitSync>[1]) => {
    workspaceGitCalls.push([...args]); return hubGitSync(args, options as never);
  }) as typeof hubGitSync;
  const daemon = await startDaemon({ cwd: root, stateDir, config: loadConfig(root), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    configWatch: false, agentDrift: false, snapshotClock: () => 0, checkoutBranch: () => ({ branch: "fixture", defaultBranch: "main" }), instanceExecutionGit });
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
  const status = async () => (await console_.request({ t: "status" })).status;
  const instanceId = (await status()).instanceId;
  const launchFile = join(stateDir, `claude-launch.${peer}.json`);
  const record = (extra: Record<string, unknown> = {}) => {
    writeFileSync(launchFile, JSON.stringify({ instanceId, launchId: "launch-one", executionCwd, permissionHook: true, hookPurpose: "permission", launcherPid: process.pid, ...extra }), { mode: 0o600 });
    chmodSync(launchFile, 0o600);
  };
  const clients: ControlClient[] = [];
  const attach = async (hello: Record<string, unknown>) => {
    const c = await ControlClient.connect(stateDir, { role: "peer", peer, channel: true, projectRoot: root, ...hello }); clients.push(c);
    for (let n = 0; n < 200 && daemon.bus.stateOf(peer) !== "idle"; n++) await Bun.sleep(5);
    expect(daemon.bus.stateOf(peer)).toBe("idle"); return c;
  };
  const owner = (isolation: boolean) => assign({ class: "implement", signals: [] }, { [peer]: "idle" }, parseRouting(`[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["${peer}"]`), { instances: instances as never, adapterCatalog: createProjectAdapterCatalog(), roles: { [peer]: ["implementer"] }, candidates: [peer], namedOwner: peer, ownerIsolation: { [peer]: isolation } });
  const facts = async () => {
    const tools = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: root });
    try { return await tools.request({ t: "facts", phase: "pre", native: true, nativeLaunchId: "launch-one", nativeInstanceId: instanceId, sessionId: "fixture-session", tool: "Edit", input: { file_path: join(executionCwd, "source.ts") } }); }
    finally { tools.close(); }
  };
  return { root, peer, executionCwd, stateDir, daemon, console_, instanceId, launchFile, record, attach, status, owner, facts, workspaceGitCalls, async close() { for (const c of clients) c.close(); console_.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("#525-5 terminal Claude owns write work only after all execution-root evidence matches; facts use that root", async () => {
  const f = await fixture();
  try {
    f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    const status = await f.status(); expect(status.ownerIsolation[f.peer]).toBe(true); expect(f.owner(status.ownerIsolation[f.peer]).owner).toBe(f.peer);
    const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: f.peer, projectRoot: f.root });
    try {
      const facts = await tools.request({ t: "facts", phase: "pre", native: true, nativeLaunchId: "launch-one", nativeInstanceId: f.instanceId, sessionId: "fixture-session", tool: "Edit", input: { file_path: join(f.executionCwd, "source.ts") } });
      expect(facts.projectRoot).toBe(f.executionCwd);
    } finally { tools.close(); }
    f.record({ launchId: "replacement" });
    expect((await f.facts()).projectRoot).toBeUndefined(); // The old hook is refused before a permission-root reply.
    // Routing checks the retained binding itself, independent of the rejected hook's launch id.
    const admission = await f.console_.request({ t: "task", op: "route_explain", args: { title: "launch proof fixture", class: "summarize" } });
    expect(admission.ok).toBe(true); expect(admission.text).toContain("verified isolated execution root");
    expect((await f.status()).ownerIsolation[f.peer]).toBe(false);
  } finally { await f.close(); }
}, 20_000);

for (const variant of ["missing-cwd", "wrong-cwd", "missing-record-root", "wrong-record-root", "wrong-instance", "missing-launch", "public-record"] as const) test(`#525-5 ${variant} attaches without owner isolation and assign refuses`, async () => {
  const f = await fixture();
  try {
    f.record(variant === "missing-record-root" ? { executionCwd: undefined } : variant === "wrong-record-root" ? { executionCwd: f.root } : variant === "wrong-instance" ? { instanceId: "other" } : {});
    if (variant === "public-record") chmodSync(f.launchFile, 0o644);
    await f.attach({ ...(variant === "missing-launch" ? {} : { launchId: "launch-one" }), ...(variant === "missing-cwd" ? {} : { cwd: variant === "wrong-cwd" ? f.root : f.executionCwd }) });
    const status = await f.status(); expect(status.ownerIsolation[f.peer]).toBe(false);
    expect(f.owner(status.ownerIsolation[f.peer]).refusals).toContainEqual(expect.objectContaining({ code: "owner-admission" }));
  } finally { await f.close(); }
}, 20_000);

test("#525-5 a replacement or detached socket cannot retain another launch's execution-owner proof", async () => {
  const f = await fixture();
  try {
    f.record(); const first = await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    expect((await f.status()).ownerIsolation[f.peer]).toBe(true);
    const second = await f.attach({ launchId: "launch-one" });
    first.close(); expect((await f.status()).ownerIsolation[f.peer]).toBe(false);
    second.close();
    for (let n = 0; n < 200 && f.daemon.bus.stateOf(f.peer) !== "offline"; n++) await Bun.sleep(5);
    expect((await f.status()).ownerIsolation[f.peer]).toBe(false);
  } finally { await f.close(); }
}, 20_000);

 test("#525-5 post-attach branch drift revokes isolation and automatic facts grants", async () => {
  const f = await fixture();
  try {
    f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    expect((await f.status()).ownerIsolation[f.peer]).toBe(true);
    expect(hubGitSync(["-C", f.executionCwd, "checkout", "--detach", "-q"], { encoding: "utf8" }).status).toBe(0);
    expect((await f.status()).ownerIsolation[f.peer]).toBe(true); // Last verified display is not admission authority.
    f.workspaceGitCalls.length = 0;
    expect((await f.facts()).projectRoot).toBeUndefined();
    expect(f.workspaceGitCalls.length).toBeGreaterThan(0);
    const status = await f.status(); expect(status.ownerIsolation[f.peer]).toBe(false);
    expect(f.owner(status.ownerIsolation[f.peer]).owner).toBeUndefined();
  } finally { await f.close(); }
}, 20_000);

test("#525-5 launch metadata is bounded and bound to the current daemon", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-launch-proof-"));
  try {
    const file = join(dir, "claude-launch.json"); writeFileSync(file, JSON.stringify({ instanceId: "one", launchId: "id", executionCwd: "/fixture" }), { mode: 0o600 });
    expect(readClaudeLaunchProof(dir, "claude", "one")?.executionCwd).toBe("/fixture");
    expect(readClaudeLaunchProof(dir, "claude", "two")).toBeUndefined();
    writeFileSync(file, " ".repeat(16385)); expect(readClaudeLaunchProof(dir, "claude", "one")).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { runClaudeEntry } from "../src/adapters/definitions/native-cli-entry-claude.ts";
import { recordClaudeLaunch } from "../src/cli/launch.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";
import { readInstanceRoleConfig } from "../src/hub/instance-config.ts";
import { effectiveInstanceRoles } from "../src/hub/instances.ts";
import { resolveInstanceExecutionCwd } from "../src/hub/instance-execution.ts";

test("#525-5 Claude launcher records and executes the validated worktree while pinning the canonical hub root", async () => {
  const f = await fixture();
  const names = ["AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"] as const;
  const previous = names.map(name => process.env[name]);
  let executed = false;
  try {
    const context = { args: [], cwd: f.root, instance: f.peer, stateDir: f.stateDir, cliDir: "/fixture/src/cli", unattendedEnv: false,
      projectConfig: () => loadConfig(f.root), fail: (message: string): never => { throw new Error(message); },
      helpers: {
        resolveExecutionCwd: (peer: string) => { const c = readInstanceRoleConfig(f.root); return resolveInstanceExecutionCwd(f.root, peer, c.instances, effectiveInstanceRoles(peer, c.instances, c.roles, c.catalog), c.catalog); },
        readControl: () => ({ instanceId: f.instanceId }), prepareTerminalLaunch: async (_peer: string, project: string, _state: string, _instance: string, options: any) => {
          expect(project).toBe(f.root); expect(options.executionCwd).toBe(f.executionCwd); return undefined;
        }, claudeObservationHooks: () => undefined, buildLaunch: () => ({ cmd: "fake-never-started", args: [] }),
        processSignature: () => "fixture", recordClaudeLaunch, cleanupStaleClaudeSettings: () => {}, cleanupClaudeSettings: () => {},
        nativeLaunchEnv: (_kind: string, env: NodeJS.ProcessEnv) => env, childEnv: () => ({}),
        runClaudeLaunch: async (_launch: unknown, options: any) => {
          executed = true; expect(options.cwd).toBe(f.executionCwd); expect(options.env.AGENTHUB_PROJECT_DIR).toBe(f.root); expect(options.env.AGENTHUB_PEER_ID).toBe(f.peer);
          const proof = readClaudeLaunchProof(f.stateDir, f.peer, f.instanceId);
          expect(proof?.executionCwd).toBe(f.executionCwd); expect(proof?.privateRecord).toBe(true);
          throw new Error("fixture foreground boundary");
        },
      },
    } as unknown as NativeCliEntryContext;
    await expect(runClaudeEntry(context)).rejects.toThrow("fixture foreground boundary"); expect(executed).toBe(true);
  } finally {
    for (const [i, name] of names.entries()) if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    await f.close();
  }
}, 20_000);


test("#525-5 verifier-only worktree never receives canonical permission fallback without current root proof", async () => {
  const f = await fixture("verifier");
  try {
    f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: f.peer, projectRoot: f.root });
    const facts = () => tools.request({ t: "facts", phase: "pre", native: true, nativeLaunchId: "launch-one", nativeInstanceId: f.instanceId, sessionId: "verifier-session", tool: "Edit", input: { file_path: join(f.root, "canonical.ts") } });
    try {
      for (const mode of ["ask-when-needed", "never-ask"]) {
        expect((await facts()).projectRoot).toBe(f.executionCwd);
        expect(await f.console_.request({ t: "permission", peer: f.peer, mode, confirmed: true })).toMatchObject({ ok: true });
        f.record({ executionCwd: f.root });
        const revoked = await facts(); expect(revoked.permission).toBeUndefined(); expect(revoked.projectRoot).toBeUndefined();
        f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
      }
      const valid = await facts(); expect(valid.permission).toBe("never-ask"); expect(valid.projectRoot).toBe(f.executionCwd);
      await f.attach({ launchId: "launch-one" });
      const missing = await facts(); expect(missing.permission).toBeUndefined(); expect(missing.projectRoot).toBeUndefined();
    } finally { tools.close(); }
  } finally { await f.close(); }
}, 20_000);


test("#525-5 repeated status writes use cached isolation, including ordinary and reserved stalled work", async () => {
  const f = await fixture();
  let board: Board | undefined;
  try {
    f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    expect((await f.status()).ownerIsolation[f.peer]).toBe(true);
    expect(f.workspaceGitCalls.length).toBeGreaterThan(0); // The counter observes real initial admission.
    board = new Board(join(f.stateDir, "hub.db"));
    const ordinary = board.propose("user", { title: "ordinary display fixture", class: "summarize" });
    const backlog = board.propose("user", { title: "reserved display fixture", class: "summarize", backlog: true });
    const reserved = board.pullPlanned(backlog.id, "user", f.peer, 0, "fixture reservation");
    for (const row of [ordinary, reserved]) {
      // A human hold prevents unrelated release timers from routing the fixture while status is inspected.
      const held = board.update(row.id, "user", "unassigned", { owner: null });
      board.recordStall({ task: held.id, signature: `display-${held.id}`, replanRevision: held.planningRevision ?? 0,
        cause: { kind: "no-eligible-peer", code: "unavailable" }, at: Date.now() });
    }
    f.workspaceGitCalls.length = 0;
    for (let n = 0; n < 5; n++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await f.console_.request({ t: "send", to: [f.peer], body: `[FYI] status projection ${n}` })).ok).toBe(true);
      const status = await f.status();
      expect(status.tasks.proposed).toBe(2);
      expect(status.ownerIsolation[f.peer]).toBe(true);
      expect(status.peers[f.peer].ownerIsolation).toBe(true);
      expect(status.ownerIsolationNotes[f.peer]).toBeUndefined();
      const saved = JSON.parse(readFileSync(join(f.stateDir, "status.json"), "utf8"));
      expect(saved.ownerIsolation[f.peer]).toBe(true);
    }
    expect(f.workspaceGitCalls).toEqual([]);
    expect(board.get(ordinary.id)?.owner).toBeNull(); expect(board.get(reserved.id)?.owner).toBeNull();
  } finally { board?.close(); await f.close(); }
}, 20_000);

test("#525-5 actual owner admission revalidates and rejects drift despite a positive display cache", async () => {
  const f = await fixture();
  let board: Board | undefined;
  try {
    f.record(); await f.attach({ launchId: "launch-one", cwd: f.executionCwd });
    board = new Board(join(f.stateDir, "hub.db"));
    const row = board.propose("user", { title: "root admission fixture", class: "summarize" });
    board.update(row.id, "user", "unassigned", { owner: null });
    expect(hubGitSync(["-C", f.executionCwd, "checkout", "--detach", "-q"], { encoding: "utf8" }).status).toBe(0);
    f.workspaceGitCalls.length = 0;
    expect((await f.status()).ownerIsolation[f.peer]).toBe(true);
    expect(f.workspaceGitCalls).toEqual([]);
    const result = await f.console_.request({ t: "task", op: "task_assign", args: { id: row.id, peer: f.peer } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("verified isolated execution root");
    expect(f.workspaceGitCalls.length).toBeGreaterThan(0);
    expect(board.get(row.id)?.owner).toBeNull();
    expect((await f.status()).ownerIsolation[f.peer]).toBe(false);
  } finally { board?.close(); await f.close(); }
}, 20_000);
