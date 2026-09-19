import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectTerminals,
  recordTerminalLaunch,
  createTerminal,
  restoreTerminal,
  shellQuote,
  waitForIdle,
  type CommandResult,
  type TerminalBinding,
} from "../src/cli/terminal-recovery.ts";

const root = "/tmp/project with 'quote";
const worktreeId = "repo::/tmp/project with 'quote";
const session = "session-1";

function terminal(overrides: Record<string, unknown> = {}) {
  return {
    handle: "term-old",
    incarnationId: "inc-old",
    worktreeId,
    worktreePath: root,
    connected: true,
    orphaned: false,
    agentIdentity: "codex",
    sessionId: session,
    ...overrides,
  };
}

function fake(commands: (argv: readonly string[]) => CommandResult | Promise<CommandResult>) {
  const calls: string[][] = [];
  const runner = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return commands(argv);
  };
  return { calls, runner };
}

test("inspect binds exact session metadata even when list omits agentIdentity", async () => {
  const { calls, runner } = fake((argv) => {
    if (argv[1] === "list") return { result: { terminals: [terminal({ agentIdentity: undefined })] } };
    if (argv[1] === "show") return { result: { terminal: terminal({ agentWait: { agentIdentity: "codex", sessionId: session }, agentIdentity: undefined }) } };
    throw new Error(`unexpected ${argv.join(" ")}`);
  });
  const result = await inspectTerminals(root, { codex: session }, runner);
  expect(result.manualRequired).toBe(false);
  expect(result.bindings).toHaveLength(1);
  expect(result.byPeer.codex?.handle).toBe("term-old");
  expect(calls).toEqual([["terminal", "list", "--json"], ["terminal", "show", "--terminal", "term-old", "--json"]]);
});

test("unknown ownership and wrong root are blockers before a mutation", async () => {
  const unknown = fake((argv) => argv[1] === "list" ? { result: { terminals: [terminal({ agentIdentity: undefined, sessionId: undefined })] } } : { result: { terminal: terminal({ worktreePath: "/other" }) } });
  const inspected = await inspectTerminals(root, { codex: session }, unknown.runner);
  expect(inspected.manualRequired).toBe(true);
  expect(inspected.blockers.some((item) => item.code === "ownership-unknown")).toBe(true);

  const binding: TerminalBinding = {
    peer: "codex",
    handle: "term-old",
    incarnationId: "inc-old",
    worktreeId,
    projectRoot: root,
    sessionId: session,
    launch: { packageEntrypoint: "/pkg/src/cli/main.js", command: "bun /pkg/src/cli/main.js", argv: [], env: {} },
    launchMetadata: { packageEntrypoint: "/pkg/src/cli/main.js", command: "bun /pkg/src/cli/main.js", argv: [], env: {} },
  };
  const stale = fake((argv) => argv[1] === "show" ? { result: { terminal: terminal({ worktreePath: "/other" }) } } : { result: { satisfied: true } });
  const restored = await restoreTerminal(binding, 1000, stale.runner);
  expect(restored.status).toBe("manual-required");
  expect(restored.blockers[0]?.code).toBe("project-root-mismatch");
  expect(stale.calls.some((argv) => argv[1] === "close")).toBe(false);
});

test("Pi terminal binding preserves session file and backend/model launch flags", async () => {
  const piSession = "pi-session";
  const piFile = "/tmp/pi-session.json";
  const shown = terminal({ agentIdentity: "pi", sessionId: piSession, sessionFile: piFile });
  const runner = async (argv: readonly string[]) => argv[1] === "show" ? { result: { terminal: shown } } : argv[1] === "list" ? { result: { terminals: [shown] } } : { result: {} };
  const inspected = await inspectTerminals(root, { pi: { sessionId: piSession, sessionFile: piFile, backend: "dgx", model: "dgx/coding" } }, { runner, packageEntrypoint: "/pkg/main.js" });
  expect(inspected.manualRequired).toBe(false);
  expect(inspected.bindings[0]?.sessionFile).toBe(piFile);
  expect(inspected.bindings[0]?.launch.argv).toEqual(expect.arrayContaining(["pi", "--mode", "tui", "--backend", "dgx", "--model", "dgx/coding", "--session-file", piFile]));
});

test("an unsatisfied bounded wait never closes the captured terminal", async () => {
  const binding: TerminalBinding = {
    peer: "codex",
    handle: "term-old",
    incarnationId: "inc-old",
    worktreeId,
    projectRoot: root,
    sessionId: session,
    launch: { packageEntrypoint: "/pkg/src/cli/main.js", command: "bun /pkg/src/cli/main.js", argv: [], env: {} },
    launchMetadata: { packageEntrypoint: "/pkg/src/cli/main.js", command: "bun /pkg/src/cli/main.js", argv: [], env: {} },
  };
  const { calls, runner } = fake((argv) => {
    if (argv[1] === "show") return { result: { terminal: terminal() } };
    if (argv[1] === "wait") return { result: { satisfied: false } };
    throw new Error(`unexpected ${argv.join(" ")}`);
  });
  const idle = await waitForIdle(binding, 99_999_999, runner);
  expect(idle.satisfied).toBe(false);
  expect(calls.find((argv) => argv[1] === "wait")).toContain("600000");
  const restored = await restoreTerminal(binding, 1000, runner);
  expect(restored.status).toBe("manual-required");
  expect(calls.some((argv) => argv[1] === "close")).toBe(false);
});

test("ambiguous create is reported without retry and shell quoting is literal", async () => {
  const binding: TerminalBinding = {
    peer: "codex",
    handle: "term-old",
    incarnationId: "inc-old",
    worktreeId,
    projectRoot: root,
    sessionId: session,
    launch: { packageEntrypoint: "/pkg path/main.js", command: `CODEX_HOME='/safe/home' 'bun' '/pkg path/main.js' '--project' ${shellQuote(root)} 'codex' 'resume' 'session-1'`, argv: [], env: { CODEX_HOME: "/safe/home" } },
    launchMetadata: { packageEntrypoint: "/pkg path/main.js", command: `CODEX_HOME='/safe/home' 'bun' '/pkg path/main.js' '--project' ${shellQuote(root)} 'codex' 'resume' 'session-1'`, argv: [], env: { CODEX_HOME: "/safe/home" } },
  };
  const { calls, runner } = fake((argv) => {
    if (argv[1] === "show") return { result: { terminal: terminal() } };
    if (argv[1] === "wait") return { result: { satisfied: true } };
    if (argv[1] === "close") return { result: {} };
    if (argv[1] === "list") return calls.some((entry) => entry[1] === "close") ? { result: { terminals: [] } } : { result: { terminals: [terminal()] } };
    if (argv[1] === "create") return { result: { terminal: { handle: "term-new" } } };
    throw new Error(`unexpected ${argv.join(" ")}`);
  });
  const result = await restoreTerminal(binding, 1000, runner);
  expect(result.status).toBe("manual-required");
  expect(calls.filter((argv) => argv[1] === "create")).toHaveLength(1);
  expect(shellQuote("a'b")).toBe("'a'\\''b'");
  const create = calls.find((argv) => argv[1] === "create")!;
  expect(create.join(" ")).toContain("CODEX_HOME='/safe/home'");
  expect(create[create.indexOf("--command") + 1]).toContain(`'--project' ${shellQuote(root)}`);
});

test("runner failures become manual-required results", async () => {
  const result = await inspectTerminals(root, { codex: session }, async () => ({ status: 17, stderr: "permission denied" }));
  expect(result.manualRequired).toBe(true);
  expect(result.blockers[0]?.code).toBe("command-error");
});

test("recorded launch is private, allowlisted, and authenticates Orca metadata without agentWait", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-terminal-recovery-"));
  const previous = { handle: process.env.ORCA_TERMINAL_HANDLE, worktree: process.env.ORCA_WORKTREE_ID, codex: process.env.CODEX_HOME, secret: process.env.RECOVERY_SECRET, launchId: process.env.AGENTHUB_LAUNCH_ID };
  process.env.ORCA_TERMINAL_HANDLE = "term-recorded";
  process.env.ORCA_WORKTREE_ID = worktreeId;
  process.env.CODEX_HOME = "/safe/codex";
  process.env.RECOVERY_SECRET = "must-not-be-recorded";
  const shown = terminal({ handle: "term-recorded", agentIdentity: undefined, sessionId: undefined, agentWait: null, env: undefined });
  const runner = async (argv: readonly string[]) => argv[1] === "show" ? { result: { terminal: shown } } : argv[1] === "list" ? { result: { terminals: [shown] } } : { result: {} };
  try {
    const recorded = await recordTerminalLaunch("codex", root, stateDir, "instance-1", runner);
    expect(recorded?.env).toEqual({ CODEX_HOME: "/safe/codex" });
    expect(recorded?.launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(process.env.AGENTHUB_LAUNCH_ID).toBe(recorded?.launchId);
    const file = join(stateDir, "terminal-recovery.json");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect(readFileSync(file, "utf8")).not.toContain("RECOVERY_SECRET");
    const inspected = await inspectTerminals(root, { codex: session }, { runner, stateDir, instanceId: "instance-1" });
    expect(inspected.manualRequired).toBe(false);
    expect(inspected.bindings[0]?.launch.env).toEqual({ CODEX_HOME: "/safe/codex" });
    const reusedPid = await inspectTerminals(root, { codex: session }, { runner, stateDir, instanceId: "instance-1", processIdentity: () => "different-process-start" });
    expect(reusedPid.manualRequired).toBe(true);
    expect(reusedPid.blockers.some((item) => item.code === "ownership-unknown")).toBe(true);
  } finally {
    if (previous.handle === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = previous.handle;
    if (previous.worktree === undefined) delete process.env.ORCA_WORKTREE_ID; else process.env.ORCA_WORKTREE_ID = previous.worktree;
    if (previous.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codex;
    if (previous.secret === undefined) delete process.env.RECOVERY_SECRET; else process.env.RECOVERY_SECRET = previous.secret;
    if (previous.launchId === undefined) delete process.env.AGENTHUB_LAUNCH_ID; else process.env.AGENTHUB_LAUNCH_ID = previous.launchId;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("create accepts a recorded replacement only after exact readback and rejects a wrong session", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-terminal-create-"));
  const previous = { handle: process.env.ORCA_TERMINAL_HANDLE, worktree: process.env.ORCA_WORKTREE_ID, launchId: process.env.AGENTHUB_LAUNCH_ID };
  process.env.ORCA_TERMINAL_HANDLE = "term-new";
  process.env.ORCA_WORKTREE_ID = worktreeId;
  const newTerminal = terminal({ handle: "term-new", incarnationId: "inc-new", agentIdentity: undefined, sessionId: undefined, agentWait: null });
  const recordRunner = async (argv: readonly string[]) => argv[1] === "show" ? { result: { terminal: newTerminal } } : { result: {} };
  const binding: TerminalBinding = {
    peer: "codex", handle: "term-old", incarnationId: "inc-old", worktreeId, projectRoot: root, sessionId: session,
    launch: { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js --project /tmp codex resume session-1", argv: [], env: {} },
    launchMetadata: { packageEntrypoint: "/pkg/main.js", command: "bun /pkg/main.js --project /tmp codex resume session-1", argv: [], env: {} },
  };
  try {
    await recordTerminalLaunch("codex", root, stateDir, "instance-2", recordRunner);
    const runner = async (argv: readonly string[]) => {
      if (argv[1] === "create") return { result: { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId } } };
      if (argv[1] === "wait") return { result: { wait: { satisfied: true } } };
      if (argv[1] === "show") return { result: { terminal: newTerminal } };
      return { result: {} };
    };
    const created = await createTerminal(binding, { runner, stateDir, instanceId: "instance-2" });
    expect(created.manualRequired).toBe(false);
    expect(created.binding?.handle).toBe("term-new");
    const wrongRunner = async (argv: readonly string[]) => {
      if (argv[1] === "create") return { result: { terminal: { handle: "term-new", incarnationId: "inc-new", worktreeId } } };
      if (argv[1] === "wait") return { result: { wait: { satisfied: true } } };
      if (argv[1] === "show") return { result: { terminal: { ...newTerminal, sessionId: "wrong-session" } } };
      return { result: {} };
    };
    const wrongSession = await createTerminal({ ...binding, sessionId: "expected-session" }, { runner: wrongRunner, stateDir, instanceId: "instance-2" });
    expect(wrongSession.manualRequired).toBe(true);
  } finally {
    if (previous.handle === undefined) delete process.env.ORCA_TERMINAL_HANDLE; else process.env.ORCA_TERMINAL_HANDLE = previous.handle;
    if (previous.worktree === undefined) delete process.env.ORCA_WORKTREE_ID; else process.env.ORCA_WORKTREE_ID = previous.worktree;
    if (previous.launchId === undefined) delete process.env.AGENTHUB_LAUNCH_ID; else process.env.AGENTHUB_LAUNCH_ID = previous.launchId;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
