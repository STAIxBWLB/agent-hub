import { expect, test } from "bun:test";
import { runCodexEntry } from "../src/adapters/definitions/native-cli-entry-codex.ts";
import { runKimiEntry } from "../src/adapters/definitions/native-cli-entry-kimi.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { buildKimiTuiLaunch, buildLaunch } from "../src/cli/launch.ts";
import { startModeOf } from "../src/hub/start-mode.ts";

// #549: the running daemon's retained codex_bin / kimi_cmd, not the file's value, picks what the person's terminal runs.
const FILE_VALUE = "/nonexistent/from-the-file";
const RUNNING_VALUE = "/nonexistent/running-value";

function kimiTuiContext(reply: Record<string, unknown>, fileCommand: string[]) {
  const requests: Record<string, unknown>[] = [];
  const context = {
    args: ["--mode", "tui"], cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf("kimi"), projectConfig: () => ({ peers: {}, kimi_cmd: fileCommand }),
    connect: async () => ({ request: async (message: Record<string, unknown>) => {
      requests.push(message);
      return message.t === "status" ? { status: { roster: [{ peer: "kimi", on: true }], peers: {} } } : message.t === "start" ? { ok: true, admissionId: "admission-549", ...reply } : { ok: true };
    }, close() {} }),
    fail: (message: string): never => { throw new Error(message); },
    takeFlags: (argv: string[]) => ({ one: Object.fromEntries(argv.reduce<string[][]>((pairs, value, index) => index % 2 ? pairs : [...pairs, [value, argv[index + 1]!]], [])), rest: [], many: {} }),
    helpers: {
      launcherPreview: () => ({}), readControl: () => undefined, startModeOf: (peers: unknown, kind: string) => startModeOf(peers as any, kind),
      buildKimiTuiLaunch, configureKimiMcp: () => ({ tracked: false }), nativeLaunchEnv: () => ({}), childEnv: () => ({}),
    },
  } as unknown as NativeCliEntryContext;
  return { context, requests };
}

test("#549 Kimi's TUI runs the daemon's retained kimi_cmd, not the file's", async () => {
  const { context, requests } = kimiTuiContext({ retainedLaunchConfig: { kimi_cmd: [RUNNING_VALUE] } }, [FILE_VALUE]);
  // A command that cannot start reports its own name, so nothing real runs.
  await expect(runKimiEntry(context)).rejects.toThrow(`cannot run ${RUNNING_VALUE}`);
  expect(requests.map(request => request.t)).toEqual(["status", "start", "kimi_launch_end"]);
});

test("#549 Kimi's TUI falls back to the file's kimi_cmd when the hub retains none, or a malformed one", async () => {
  for (const reply of [{}, { retainedLaunchConfig: {} }, { retainedLaunchConfig: { kimi_cmd: [1] } }, { retainedLaunchConfig: { kimi_cmd: "nope" } }]) {
    const { context } = kimiTuiContext(reply, [FILE_VALUE]);
    await expect(runKimiEntry(context)).rejects.toThrow(`cannot run ${FILE_VALUE}`);
  }
});

test("#549 an invalid kimi_cmd releases the TUI admission instead of holding it for its deadline", async () => {
  const invalid: [Record<string, unknown>, string[], string][] = [
    [{}, [], "kimi_cmd must name an executable"],
    [{}, ["kimi", "serve"], "no derivable TUI form"],
    [{ retainedLaunchConfig: { kimi_cmd: ["kimi", "serve"] } }, [FILE_VALUE], "no derivable TUI form"],
  ];
  for (const [reply, fileCommand, message] of invalid) {
    const { context, requests } = kimiTuiContext(reply, fileCommand);
    await expect(runKimiEntry(context)).rejects.toThrow(message);
    expect(requests.map(request => request.t)).toEqual(["status", "start", "kimi_launch_end"]);
    expect(requests.at(-1)).toMatchObject({ t: "kimi_launch_end", admissionId: "admission-549" });
  }
});

test("#549 Codex runs the daemon's retained codex_bin, not the file's", async () => {
  for (const [reply, expected] of [[{ retainedLaunchConfig: { codex_bin: RUNNING_VALUE } }, RUNNING_VALUE], [{}, FILE_VALUE], [{ retainedLaunchConfig: { codex_bin: 7 } }, FILE_VALUE]] as const) {
    const requests: Record<string, unknown>[] = [];
    const context = {
      args: [], cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
      definition: definitionOf("codex"), projectConfig: () => ({ codex_bin: FILE_VALUE }),
      connect: async () => ({ request: async (message: Record<string, unknown>) => {
        requests.push(message);
        return message.t === "status" ? { status: { peers: {} } } : { ok: true, proxyUrl: "ws://127.0.0.1:5555", ...reply };
      }, close() {} }),
      fail: (message: string): never => { throw new Error(message); },
      exec: (bin: string): never => { throw new Error(`exec ${bin}`); },
      helpers: {
        launcherPreview: () => ({}), buildLaunch, readControl: () => undefined,
        prepareTerminalLaunch: async () => undefined, registerTerminalLaunch: async () => undefined,
      },
    } as unknown as NativeCliEntryContext;
    await expect(runCodexEntry(context)).rejects.toThrow(`exec ${expected}`);
    expect(requests.some(request => request.t === "start")).toBe(true);
  }
});
