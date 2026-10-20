import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { instanceRecoverySourceRefusal, observedSession, restoredTerminalArgv } from "../src/cli/upgrade-runtime.ts";
import { inspectSavedTerminal, inspectTerminals, recordTerminalLaunch, type TerminalBinding } from "../src/cli/terminal-recovery.ts";

function fixture(writer = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-instance-recovery-"))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const executionCwd = writer ? join(root, ".worktrees", "codex-worker") : root;
  if (writer) git("worktree", "add", "-b", "worker", executionCwd, "HEAD");
  const declare = (worktree = writer ? executionCwd : undefined) => writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: {
    "codex-worker": { kind: "codex", roles: [writer ? "implementer" : "reviewer"], ...(worktree ? { worktree } : {}) },
  } }));
  declare();
  const launch = { packageEntrypoint: "/synthetic/main.js", argv: [], env: {}, command: "unused" };
  const binding: TerminalBinding = { peer: "codex-worker", projectRoot: root, executionCwd, terminalRoot: root, sessionId: "worker-thread", handle: "worker-terminal", incarnationId: "worker-incarnation", worktreeId: "worker-group", launch, launchMetadata: launch };
  return { root, stateDir, executionCwd, declare, binding, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("#450 recovery resolves each project's declared native id field and keeps --as outside native resume args", () => {
  const f = fixture();
  try {
    const native = { id: "codex-worker", state: "idle" as const, threadId: "worker-thread", sessionId: "not-the-thread" };
    expect(observedSession(native.id, native, f.root)).toBe("worker-thread");
    expect(restoredTerminalArgv("/target/main.js", f.root, f.binding)).toEqual([process.execPath, "/target/main.js", "--project", f.root, "codex", "--as", "codex-worker", "resume", "worker-thread"]);
    expect(restoredTerminalArgv("/target/main.js", f.root, f.binding, true)).toEqual([process.execPath, "/target/main.js", "--project", f.root, "codex", "--as", "codex-worker"]);
    expect(restoredTerminalArgv("/target/main.js", f.root, { ...f.binding, peer: "codex", executionCwd: undefined, terminalRoot: undefined })).toEqual([process.execPath, "/target/main.js", "--project", f.root, "codex", "resume", "worker-thread"]);
    expect(() => restoredTerminalArgv("/target/main.js", f.root, { ...f.binding, peer: "codex-undeclared" })).toThrow("resume adapter");
  } finally { f.close(); }
});

test("#450 native kind terminal metadata alone never proves ownership of an extra instance", async () => {
  const f = fixture();
  try {
    const terminal = { handle: f.binding.handle, incarnationId: f.binding.incarnationId, worktreeId: f.binding.worktreeId,
      worktreePath: f.root, agentIdentity: "codex", sessionId: f.binding.sessionId, connected: true, orphaned: false };
    const options = { stateDir: f.stateDir, instanceId: "hub-instance", processIdentity: () => "fixture-start", runner: async (args: readonly string[]) => args[1] === "list" ? { result: { terminals: [terminal] } } : { result: { terminal } } };
    expect((await inspectTerminals(f.root, { "codex-worker": f.binding.sessionId }, options)).manualRequired).toBe(true);
    const row = { peer: "codex-worker", projectRoot: f.root, executionCwd: f.root, terminalRoot: f.root, stateDir: f.stateDir, instanceId: "hub-instance", launcherPid: process.pid, launcherSignature: "fixture-start", launchId: "exact-launch", handle: f.binding.handle, incarnationId: f.binding.incarnationId, worktreeId: f.binding.worktreeId, env: {} };
    writeFileSync(join(f.stateDir, "terminal-recovery.json"), JSON.stringify([{ ...row, peer: "codex" }]));
    expect((await inspectTerminals(f.root, { "codex-worker": f.binding.sessionId }, options)).manualRequired).toBe(true);
    writeFileSync(join(f.stateDir, "terminal-recovery.json"), JSON.stringify([row]));
    const bound = await inspectTerminals(f.root, { "codex-worker": f.binding.sessionId }, options);
    expect(bound.manualRequired).toBe(false); expect(bound.byPeer["codex-worker"]?.peer).toBe("codex-worker");
  } finally { f.close(); }
});

test("#450 extra execution cwd and Orca grouping roots remain separate and revalidate the trusted declaration", async () => {
  const f = fixture(true), previous = Object.fromEntries(["ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"].map(key => [key, process.env[key]]));
  try {
    process.env.ORCA_TERMINAL_HANDLE = f.binding.handle; process.env.ORCA_WORKTREE_ID = f.binding.worktreeId;
    for (const terminalRoot of [f.root, f.executionCwd]) {
      const terminal = { handle: f.binding.handle, incarnationId: f.binding.incarnationId, worktreeId: f.binding.worktreeId,
        worktreePath: terminalRoot, agentIdentity: "codex", sessionId: f.binding.sessionId, connected: true, orphaned: false };
      const options = { executionCwd: f.executionCwd, stateDir: f.stateDir, instanceId: "hub-instance", processIdentity: () => "fixture-start", runner: async (args: readonly string[]) => args[1] === "list" ? { result: { terminals: [terminal] } } : { result: { terminal } } };
      const recorded = await recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", options, () => true);
      expect(recorded?.projectRoot).toBe(f.root); expect(recorded?.executionCwd).toBe(f.executionCwd); expect(recorded?.terminalRoot).toBe(terminalRoot);
      const inspected = await inspectTerminals(f.root, { "codex-worker": f.binding.sessionId }, options), binding = inspected.byPeer["codex-worker"];
      expect(inspected.manualRequired).toBe(false); expect(binding?.executionCwd).toBe(f.executionCwd); expect(binding?.terminalRoot).toBe(terminalRoot);
      expect((await inspectSavedTerminal(binding!, options)).state).toBe("present");
      f.declare(join(f.root, "outside"));
      expect((await inspectSavedTerminal(binding!, options)).state).not.toBe("present");
      f.declare();
      const before = readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8");
      await expect(recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", { ...options, executionCwd: join(f.root, "outside") })).rejects.toThrow();
      expect(readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8")).toBe(before);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    f.close();
  }
});


test("#450 declared instances refuse unsupported or unknown running source feature evidence", () => {
  const f = fixture();
  try {
    for (const features of [undefined, null, [], ["instances"], "peer_instances", { peer_instances: true }, ["peer_instances", null]]) {
      expect(instanceRecoverySourceRefusal(f.root, features)).toContain("source lacks peer_instances");
      expect(instanceRecoverySourceRefusal(f.root, features)).toContain("restart the source");
    }
    expect(instanceRecoverySourceRefusal(f.root, ["peer_instances"])).toBeUndefined();
    writeFileSync(join(f.root, ".agenthub", "config.local.json"), "{}");
    expect(instanceRecoverySourceRefusal(f.root, undefined)).toBeUndefined();
  } finally { f.close(); }
});
