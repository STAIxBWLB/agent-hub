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
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";
import { definitionOf } from "../src/adapters/registry.ts";

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
      buildLaunch: (_kind: string, _args: string[], options: { proxyUrl: string }) => ({ cmd: "codex", args: [options.proxyUrl] }),
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
