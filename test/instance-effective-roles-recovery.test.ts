import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { inspectSavedTerminal, inspectTerminals, recordTerminalLaunch } from "../src/cli/terminal-recovery.ts";

function fixture(managedWorktree = false) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-effective-roles-recovery-"))), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  git("init", "-q");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const executionCwd = managedWorktree ? join(root, ".worktrees", "codex-worker") : root;
  if (managedWorktree) git("worktree", "add", "-b", "worker", executionCwd, "HEAD");
  const configure = (roles: Record<string, string[]>, declared = true) => {
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ roles }));
    writeFileSync(join(root, ".agenthub", "config.local.json"), JSON.stringify({ ...(declared ? { instances: {
      "codex-worker": { kind: "codex", ...(managedWorktree ? { worktree: executionCwd } : {}) },
    } } : {}) }));
  };
  const terminal = { handle: "worker-terminal", incarnationId: "worker-incarnation", worktreeId: "worker-group", worktreePath: root,
    agentIdentity: "codex", sessionId: "worker-thread", connected: true, orphaned: false };
  const options = { executionCwd, stateDir, instanceId: "hub-instance", processIdentity: () => "fixture-start",
    runner: async (args: readonly string[]) => args[1] === "list" ? { result: { terminals: [terminal] } } : { result: { terminal } } };
  const keys = ["ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  process.env.ORCA_TERMINAL_HANDLE = terminal.handle; process.env.ORCA_WORKTREE_ID = terminal.worktreeId;
  return { root, stateDir, executionCwd, options, configure, close: () => {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  } };
}

for (const roleKey of ["codex-worker", "codex"]) test(`#450 terminal recovery honors ordinary roles.${roleKey} and rechecks current authority`, async () => {
  const f = fixture();
  try {
    f.configure({ [roleKey]: ["reviewer"] });
    const row = await recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", f.options, () => true);
    expect(row?.executionCwd).toBe(f.root);
    const inspected = await inspectTerminals(f.root, { "codex-worker": "worker-thread" }, f.options);
    expect(inspected.manualRequired).toBe(false);
    const binding = inspected.byPeer["codex-worker"];
    expect(binding?.projectRoot).toBe(f.root);
    expect((await inspectSavedTerminal(binding!, f.options)).state).toBe("present");
    const before = readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8");
    f.configure({ [roleKey]: ["implementer"] });
    await expect(recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", f.options)).rejects.toThrow("requires an explicit managed worktree");
    expect((await inspectSavedTerminal(binding!, f.options)).state).not.toBe("present");
    expect((await inspectTerminals(f.root, { "codex-worker": "worker-thread" }, f.options)).manualRequired).toBe(true);
    expect(readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8")).toBe(before);
    f.configure({ [roleKey]: ["reviewer"] }, false);
    expect((await inspectSavedTerminal(binding!, f.options)).state).not.toBe("present");
    await expect(recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", f.options)).rejects.toThrow("no managed terminal recovery adapter");
  } finally { f.close(); }
});

test("#450 ordinary implementer roles require and recover only the declared managed worktree", async () => {
  const f = fixture(true);
  try {
    f.configure({ "codex-worker": ["implementer"], codex: ["reviewer"] });
    const row = await recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", f.options, () => true);
    expect(row?.executionCwd).toBe(f.executionCwd);
    const inspected = await inspectTerminals(f.root, { "codex-worker": "worker-thread" }, f.options);
    expect(inspected.manualRequired).toBe(false);
    expect((await inspectSavedTerminal(inspected.byPeer["codex-worker"]!, f.options)).state).toBe("present");
    const before = readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8");
    await expect(recordTerminalLaunch("codex-worker", f.root, f.stateDir, "hub-instance", { ...f.options, executionCwd: f.root })).rejects.toThrow("execution worktree changed");
    expect(readFileSync(join(f.stateDir, "terminal-recovery.json"), "utf8")).toBe(before);
  } finally { f.close(); }
});
