import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { inspectSavedTerminal, inspectTerminals, prepareTerminalLaunch, publishTerminalLaunch, recordTerminalLaunch, terminalLaunchCandidate } from "../src/cli/terminal-recovery.ts";

function fixture(role: "implementer" | "planner" | "reviewer" = "implementer", grouping: "canonical" | "execution" = "canonical") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-claude-root-recovery-")));
  const stateDir = join(root, ".agenthub", "state"), peer = "claude-worker";
  mkdirSync(stateDir, { recursive: true });
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const executionCwd = role === "implementer" ? join(root, ".worktrees", peer) : root;
  if (executionCwd !== root) git("worktree", "add", "-b", "worker", executionCwd, "HEAD");
  const configure = (worktree = executionCwd) => {
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ roles: { [peer]: [role] } }));
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ instances: {
      [peer]: { kind: "claude", roles: [role], ...(role === "implementer" ? { worktree } : {}) },
    } }));
  };
  configure();
  const terminal = { handle: "claude-terminal", incarnationId: "claude-incarnation", worktreeId: "claude-group",
    worktreePath: grouping === "canonical" ? root : executionCwd, agentIdentity: "claude", sessionId: "claude-session", connected: true, orphaned: false };
  const options = { executionCwd, stateDir, instanceId: "hub-instance", processIdentity: () => "fixture-start",
    runner: async (args: readonly string[]) => args[1] === "list" ? { result: { terminals: [terminal] } } : { result: { terminal } } };
  const keys = ["ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  process.env.ORCA_TERMINAL_HANDLE = terminal.handle; process.env.ORCA_WORKTREE_ID = terminal.worktreeId;
  return { root, stateDir, peer, executionCwd, terminal, options, configure, close() {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  } };
}

for (const grouping of ["canonical", "execution"] as const) test(`#525 terminal Claude implementer recovers a verified worktree with ${grouping} Orca grouping`, async () => {
  const f = fixture("implementer", grouping);
  try {
    const candidate = await prepareTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", f.options);
    expect(candidate?.executionCwd).toBe(f.executionCwd);
    expect(candidate?.terminalRoot).toBe(f.terminal.worktreePath);
    expect(terminalLaunchCandidate(candidate, f.root, f.stateDir, "hub-instance")).toEqual(candidate);
    expect(await publishTerminalLaunch(f.stateDir, candidate!, () => false, f.options)).toBe(false);
    expect(await publishTerminalLaunch(f.stateDir, candidate!, () => true, f.options)).toBe(true);
    const inspection = await inspectTerminals(f.root, { [f.peer]: "claude-session" }, f.options);
    expect(inspection.manualRequired).toBe(false);
    expect(inspection.byPeer[f.peer]?.executionCwd).toBe(f.executionCwd);
    expect((await inspectSavedTerminal(inspection.byPeer[f.peer]!, f.options)).state).toBe("present");
    const saved = readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8");
    await expect(prepareTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", { ...f.options, executionCwd: f.root })).rejects.toThrow("execution worktree changed");
    f.configure(join(f.root, ".worktrees", "other"));
    expect((await inspectSavedTerminal(inspection.byPeer[f.peer]!, f.options)).state).not.toBe("present");
    expect(readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8")).toBe(saved);
  } finally { f.close(); }
});

for (const role of ["planner", "reviewer"] as const) test(`#525 terminal Claude ${role} retains canonical recovery`, async () => {
  const f = fixture(role);
  try {
    const row = await recordTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", f.options, () => true);
    expect(row?.executionCwd).toBe(f.root);
    const inspected = await inspectTerminals(f.root, { [f.peer]: "claude-session" }, f.options);
    expect(inspected.manualRequired).toBe(false);
    expect((await inspectSavedTerminal(inspected.byPeer[f.peer]!, f.options)).state).toBe("present");
  } finally { f.close(); }
});

test("#525 terminal Claude implementer refuses missing or mismatched recovery roots and identity drift", async () => {
  const f = fixture();
  try {
    await expect(prepareTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", { ...f.options, executionCwd: undefined })).rejects.toThrow("requires its authenticated startup execution root");
    const candidate = await prepareTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", f.options);
    expect(await publishTerminalLaunch(f.stateDir, candidate!, () => true, { ...f.options, processIdentity: () => "changed-start" })).toBe(false);
    f.terminal.incarnationId = "replacement-incarnation";
    expect(await publishTerminalLaunch(f.stateDir, candidate!, () => true, f.options)).toBe(false);
    f.terminal.incarnationId = candidate!.incarnationId;
    writeFileSync(join(f.stateDir, "terminal-recovery.json"), JSON.stringify([{ ...candidate, executionCwd: undefined }]));
    expect((await inspectTerminals(f.root, { [f.peer]: "claude-session" }, f.options)).manualRequired).toBe(true);
    f.terminal.worktreePath = join(f.root, "elsewhere");
    await expect(prepareTerminalLaunch(f.peer, f.root, f.stateDir, "hub-instance", f.options)).rejects.toThrow("root/worktree readback");
  } finally { f.close(); }
});
