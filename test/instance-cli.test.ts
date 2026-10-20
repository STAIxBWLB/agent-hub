import { expect, test } from "bun:test";
import { instanceLaunchArguments, requirePeerInstances, nativeLaunchEnv } from "../src/cli/launch.ts";

const declarations = { "codex-review": { kind: "codex" }, "kimi-check": { kind: "kimi" } };

test("instance launch strips only its own selector before native passthrough", () => {
  expect(instanceLaunchArguments("codex", ["--as", "codex-review", "resume", "thread"], declarations)).toEqual({ instance: "codex-review", args: ["resume", "thread"] });
  expect(instanceLaunchArguments("codex", ["--as=codex-review"], declarations)).toEqual({ instance: "codex-review", args: [] });
  expect(instanceLaunchArguments("codex", ["--", "--as", "native-value"], declarations)).toEqual({ args: ["--", "--as", "native-value"] });
  expect(instanceLaunchArguments("say", ["--as", "quoted text"], declarations)).toEqual({ args: ["--as", "quoted text"] });
});

test("instance launch refuses undeclared, mismatched and repeated selectors", () => {
  for (const args of [["--as"], ["--as="], ["--as=codex-review", "--as", "codex-review"], ["--as", "codex-missing"], ["--as", "kimi-check"], ["--as", "codex-review", "--as", "codex-review"]]) {
    expect(() => instanceLaunchArguments("codex", args, declarations)).toThrow();
  }
  expect(() => instanceLaunchArguments("codex", ["--as", "codex-review"])).toThrow();
});

test("extra instance startup requires actual daemon feature evidence", () => {
  for (const features of [undefined, null, [], ["instances"], "peer_instances", { peer_instances: true }]) expect(() => requirePeerInstances(features)).toThrow("peer_instances");
  expect(() => requirePeerInstances(["peer_instances"])).not.toThrow();
});

import { runKimiEntry } from "../src/adapters/definitions/native-cli-entry-kimi.ts";
import { runPiEntry } from "../src/adapters/definitions/native-cli-entry-pi.ts";
import { runQwenEntry } from "../src/adapters/definitions/native-cli-entry-qwen.ts";
import { runLocalEntry } from "../src/adapters/definitions/native-cli-entry-local.ts";
import { runCodexEntry } from "../src/adapters/definitions/native-cli-entry-codex.ts";
import { runClaudeEntry } from "../src/adapters/definitions/native-cli-entry-claude.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import type { RecordedTerminalLaunch } from "../src/cli/terminal-recovery.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function entryContext(kind: string, args: string[] = []) {
  const requests: Record<string, unknown>[] = [];
  const peer = `${kind}-worker`;
  const context = {
    args, instance: peer, cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf(kind), projectConfig: () => ({ codex_bin: "codex" }),
    fail: (message: string): never => { throw new Error(message); },
    connect: async () => ({ request: async (message: Record<string, unknown>) => {
      requests.push(message);
      return message.t === "status" ? { status: { peers: { [peer]: { state: "offline" } } } }
        : { ok: true, proxyUrl: "ws://127.0.0.1:5555", executionCwd: "/verified/worktree" };
    }, close() {} }),
    takeFlags: (argv: string[]) => ({ one: Object.fromEntries(argv.reduce<string[][]>((pairs, value, index) => index % 2 ? pairs : [...pairs, [value, argv[index + 1]!]], [])), rest: [], many: {} }),
    helpers: {
      configureKimiMcp: () => { throw new Error("shared MCP file must not be touched"); },
      startModeOf: () => { throw new Error("extra native mode must not use base peer mode"); },
      recoveryLock: () => undefined,
      readControl: () => undefined,
      buildLaunch: (_kind: string, _args: string[], options: { proxyUrl: string; launchTokenEnv?: string }) => ({ cmd: "codex", args: [options.proxyUrl, ...(options.launchTokenEnv ? [options.launchTokenEnv] : [])] }),
    },
  } as unknown as NativeCliEntryContext;
  return { context, requests, peer };
}

test("extra ACP and local starts carry exact identity without editing shared native configuration", async () => {
  for (const [kind, run] of [["kimi", runKimiEntry], ["qwen", runQwenEntry], ["local", runLocalEntry]] as const) {
    const { context, requests, peer } = entryContext(kind);
    await run(context);
    expect(requests.find(request => request.t === "start")?.peer).toBe(peer);
    if (kind !== "local") expect(requests.find(request => request.t === "start")?.args).toMatchObject({ mode: "headless" });
  }
});

test("extra Pi uses its headless owner and refuses explicit TUI mode", async () => {
  const { context, requests, peer } = entryContext("pi");
  await runPiEntry(context);
  expect(requests.find(request => request.t === "start")).toMatchObject({ peer, args: { mode: "headless" } });
  const refused = entryContext("pi", ["--mode", "tui"]);
  await expect(runPiEntry(refused.context)).rejects.toThrow("headless");
  expect(refused.requests).toEqual([]);
});

test("extra Codex still launches native TUI on its own proxy from verified execution cwd", async () => {
  const { context, requests, peer } = entryContext("codex");
  context.exec = (_bin, argv, tool): never => {
    expect(argv).toEqual(["ws://127.0.0.1:5555"]);
    expect(tool).toBe("codex");
    expect(context.executionCwd).toBe("/verified/worktree");
    throw new Error("native exec boundary observed");
  };
  await expect(runCodexEntry(context)).rejects.toThrow("native exec boundary observed");
  expect(requests.find(request => request.t === "start")?.peer).toBe(peer);
  expect(requests.some(request => request.t === "initialize")).toBe(false);
});


test("native child environment keeps selected instance and removes inherited vendor identity", () => {
  const env = nativeLaunchEnv("codex-review", { AGENTHUB_PEER_ID: "kimi-check", CLAUDECODE: "1", CODEX_THREAD_ID: "old-thread", AGENTHUB_RECOVERY_OPERATION: "old-operation" }, declarations);
  expect(env.AGENTHUB_PEER_ID).toBe("codex-review");
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CODEX_THREAD_ID).toBeUndefined();
  expect(env.AGENTHUB_RECOVERY_OPERATION).toBeUndefined();
});

function terminalEntryFixture(kind: "codex" | "pi" | "claude", directory: string, refused = false) {
  const { context } = entryContext(kind, kind === "pi" ? ["--mode", "tui"] : []);
  delete context.instance;
  context.cwd = directory;
  context.stateDir = join(directory, "state");
  const order: string[] = [];
  const candidate: RecordedTerminalLaunch = { peer: kind, projectRoot: directory, stateDir: context.stateDir, instanceId: "instance-terminal", launcherPid: process.pid, launcherSignature: "fixture-signature", launchId: "3c402333-506a-4448-aad0-bdab112e48e2", handle: "term-fixture", incarnationId: "inc-fixture", worktreeId: "fixture-worktree", env: {} };
  context.connect = async () => ({ features: ["terminal_owner"], request: async (message: Record<string, unknown>) => {
    if (message.t === "status") return { status: { peers: { [kind]: { state: "offline" } } } };
    order.push("start");
    return refused ? { ok: false, error: "native start refused" } : { ok: true, proxyUrl: "ws://127.0.0.1:5555/?retained=1", launch: { cmd: "fake-pi", args: ["--fixture"], env: { FIXTURE_NATIVE: "1" } } };
  }, close() {} }) as unknown as Awaited<ReturnType<NativeCliEntryContext["connect"]>>;
  const helpers: Partial<NativeCliEntryContext["helpers"]> = {
    readControl: () => ({ instanceId: candidate.instanceId }) as ReturnType<NativeCliEntryContext["helpers"]["readControl"]>,
    recordTerminalLaunch: async () => { throw new Error("authoritative terminal writer must not run in a native leaf"); },
    prepareTerminalLaunch: async (peer, projectRoot, stateDir, instanceId) => {
      expect({ peer, projectRoot, stateDir, instanceId }).toEqual({ peer: kind, projectRoot: directory, stateDir: candidate.stateDir, instanceId: candidate.instanceId });
      order.push("prepare");
      process.env.AGENTHUB_LAUNCH_ID = candidate.launchId;
      return candidate;
    },
    registerTerminalLaunch: async (_client, row) => { expect(row).toEqual(candidate); order.push("register-pending"); },
  };
  Object.assign(context.helpers, helpers);
  context.exec = (_bin, argv): never => {
    order.push("foreground-exec");
    // #586: codex --remote takes no query of ours; the launch id rides the bearer env var.
    expect(argv).toEqual(["ws://127.0.0.1:5555/?retained=1", "AGENTHUB_LAUNCH_ID"]);
    expect(process.env.AGENTHUB_LAUNCH_ID).toBe(candidate.launchId);
    throw new Error("foreground native boundary");
  };
  context.execWithEnv = (bin, argv, env): never => {
    order.push("foreground-exec");
    expect(bin).toBe("fake-pi"); expect(argv).toEqual(["--fixture"]);
    expect(env.FIXTURE_NATIVE).toBe("1");
    throw new Error("foreground native boundary");
  };
  return { context, candidate, order };
}

for (const [kind, run] of [["codex", runCodexEntry], ["pi", runPiEntry]] as const) {
  for (const refused of [false, true]) {
    test(`#482 ${kind} ${refused ? "refused start never registers or executes" : "prepares and registers pending ownership before foreground execution"}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "ahub-leaf-wiring-"));
      const previous = process.env.AGENTHUB_LAUNCH_ID;
      try {
        const { context, order } = terminalEntryFixture(kind, directory, refused);
        await expect(run(context)).rejects.toThrow(refused ? "native start refused" : "foreground native boundary");
        expect(order).toEqual(refused ? ["start"] : ["start", "prepare", "register-pending", "foreground-exec"]);
      } finally {
        if (previous === undefined) delete process.env.AGENTHUB_LAUNCH_ID; else process.env.AGENTHUB_LAUNCH_ID = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}

test("#482 Claude registers pending terminal ownership and publishes its hook record before the native child", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ahub-claude-leaf-wiring-"));
  const previous = { home: process.env.HOME, launch: process.env.AGENTHUB_LAUNCH_ID, instance: process.env.AGENTHUB_INSTANCE_ID };
  process.env.HOME = directory;
  try {
    const { context, candidate, order } = terminalEntryFixture("claude", directory);
    const helpers: Partial<NativeCliEntryContext["helpers"]> = {
      claudeObservationHooks: (_config, paths) => ({ ...paths, purpose: "permission" }),
      buildLaunch: () => ({ cmd: "fake-claude", args: [], permissionHook: true, settingsFile: join(directory, "fixture-settings.json") }),
      processSignature: () => candidate.launcherSignature,
      recordClaudeLaunch: (_stateDir, record) => {
        expect(record.launchId).toBe(candidate.launchId);
        expect(record.permissionHook).toBe(true);
        order.push("publish-hook-record");
        return { recorded: true };
      },
      cleanupStaleClaudeSettings: () => {},
      nativeLaunchEnv: (_kind, env) => env,
      childEnv: () => ({ HOME: directory }),
      runClaudeLaunch: async (_launch, options) => {
        expect(options.record?.launchId).toBe(candidate.launchId);
        expect(options.env.HOME).toBe(directory);
        order.push("foreground-exec");
        throw new Error("foreground Claude boundary");
      },
      cleanupClaudeSettings: () => { order.push("cleanup-settings"); },
    };
    Object.assign(context.helpers, helpers);
    await expect(runClaudeEntry(context)).rejects.toThrow("foreground Claude boundary");
    expect(order).toEqual(["prepare", "register-pending", "publish-hook-record", "foreground-exec", "cleanup-settings"]);
  } finally {
    for (const [key, value] of Object.entries({ HOME: previous.home, AGENTHUB_LAUNCH_ID: previous.launch, AGENTHUB_INSTANCE_ID: previous.instance })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
