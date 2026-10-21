import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definitionOf } from "../src/adapters/registry.ts";
import { peerStartConfig, startModeOf } from "../src/hub/start-mode.ts";
import { launcherPreview } from "../src/cli/preview.ts";
import { runJcodeEntry, waitForJcodeTui } from "../src/adapters/definitions/native-cli-entry-jcode.ts";
import type { NativeCliEntryContext } from "../src/adapters/definitions/native-cli-entry-types.ts";

test("Jcode defaults to TUI and accepts a configured headless override (#464)", () => {
  const definition = definitionOf("jcode")!;
  expect(definition.start.forms).toEqual(["tui", "headless"]);
  expect(definition.start.defaultForm).toBe("tui");
  expect(startModeOf(undefined, "jcode")).toBe("tui");
  expect(startModeOf(peerStartConfig({ jcode: { start_mode: "headless" } }), "jcode")).toBe("headless");
  expect(definition.start).not.toHaveProperty("ownsTerminal");
});

test("Jcode dry preview describes top-level TUI without resolving a private socket or writing config (#464)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-jcode-tui-preview-"));
  try {
    const preview = launcherPreview("jcode", ["--dry-run"], root, join(root, "state"), false);
    expect(preview.mode).toBe("tui");
    expect(preview.args).toContain("--resume");
    expect(preview.args).not.toContain("connect");
    expect(preview.args).not.toContain("acp");
    expect(preview.unresolved.some(row => row.field === "ownedDaemon")).toBe(true);
    const headless = launcherPreview("jcode", ["--mode", "headless"], root, join(root, "state"), false);
    expect(headless.args).toContain("acp");
    expect(headless.args).toContain("--mcp-tools");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function entry(args: string[] = []) {
  const requests: Record<string, unknown>[] = [];
  let configured = 0, executed = 0;
  const context = {
    person: true, args, cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf("jcode"), projectConfig: () => ({}),
    fail: (message: string): never => { throw new Error(message); },
    connect: async () => ({ features: ["native_tui_launch"], request: async (message: Record<string, unknown>) => {
      requests.push(message);
      return message.t === "status" ? { status: { roster: [{ peer: "jcode", on: true }] } }
        : message.t === "peer_start" ? { ok: true, mode: "tui", opened: "fixture", command: "ahub jcode --mode tui" } : { ok: true };
    }, close() {} }),
    takeFlags: (argv: string[]) => ({ one: Object.fromEntries(argv.reduce<string[][]>((pairs, value, index) => index % 2 ? pairs : [...pairs, [value, argv[index + 1]!]], [])), rest: [], many: {} }),
    execWithEnv: (): never => { executed++; throw new Error("TUI must have a terminal"); },
    helpers: { startModeOf, readControl: () => undefined, qwenSessionId: () => true,
      configureJcodeMcp: () => { configured++; return { changed: false, tracked: false }; } },
  } as unknown as NativeCliEntryContext;
  return { context, requests, configured: () => configured, executed: () => executed };
}

test("Jcode default without a terminal requests the terminal provider before configuring native files (#464)", async () => {
  const fixture = entry();
  const before = { input: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    await runJcodeEntry(fixture.context);
    expect(fixture.requests.some(row => row.t === "peer_start" && row.peer === "jcode")).toBe(true);
    expect(fixture.requests.some(row => row.t === "start")).toBe(false);
    expect(fixture.configured()).toBe(0);
    expect(fixture.executed()).toBe(0);
  } finally {
    if (before.input) Object.defineProperty(process.stdin, "isTTY", before.input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (before.output) Object.defineProperty(process.stdout, "isTTY", before.output); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test("Jcode explicit headless retains its direct start and native policy (#464)", async () => {
  const fixture = entry(["--mode", "headless"]);
  await runJcodeEntry(fixture.context);
  expect(fixture.requests.find(row => row.t === "start")).toMatchObject({ peer: "jcode", args: { mode: "headless" } });
  expect(fixture.configured()).toBe(1);
  expect(fixture.executed()).toBe(0);
});


test("Jcode save wait binds the launch and announces once, without inducing any native turn (#464)", async () => {
  const binding = { launchId: "launch", sessionId: "session" }, requests: unknown[] = [], lines: unknown[] = [];
  const log = console.log; console.log = (...args) => { lines.push(args); };
  let polls = 0;
  try {
    const hub = { request: async (message: unknown) => { requests.push(message); return ++polls === 1
      ? { ok: true, state: "waiting", binding } : { ok: true, state: "ready", binding, launch: { cmd: "jcode", args: ["--resume", "session"], env: {} } }; } };
    const ready = await waitForJcodeTui(hub as never, message => { throw new Error(message); }, new AbortController().signal, {});
    expect(ready?.state).toBe("ready");
    expect(lines).toEqual([["jcode's TUI opens after its first hub turn; send it work, or Ctrl-C"]]);
    expect(requests).toEqual([{ t: "native_tui_launch", peer: "jcode", binding: undefined, args: {} }, { t: "native_tui_launch", peer: "jcode", binding, args: {} }]);
  } finally { console.log = log; }
});

test("Jcode save wait aborts without a cancel/stop request and refuses a changed binding (#464)", async () => {
  const abort = new AbortController(), calls: string[] = [];
  const hub = { request: async (message: {t: string}) => { calls.push(message.t); abort.abort(); return {}; } };
  expect(await waitForJcodeTui(hub as never, message => { throw new Error(message); }, abort.signal, {})).toBeUndefined();
  expect(calls).toEqual(["native_tui_launch"]);
  await expect(waitForJcodeTui({ request: async () => ({ ok: true, state: "ready", binding: { launchId: "other", sessionId: "session" } }) } as never,
    message => { throw new Error(message); }, new AbortController().signal, {}, { state: "waiting", binding: { launchId: "launch", sessionId: "session" } })).rejects.toThrow("launch changed");
});

test("Jcode TUI refuses borrowed authority and explicit nonterminal options before configuring files (#464)", async () => {
  const borrowed = entry(); borrowed.context.person = false;
  await expect(runJcodeEntry(borrowed.context)).rejects.toThrow("person-only");
  expect(borrowed.requests).toHaveLength(0); expect(borrowed.configured()).toBe(0);
  const explicit = entry(["--mode", "tui"]);
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(runJcodeEntry(explicit.context)).rejects.toThrow("in a terminal");
    expect(explicit.configured()).toBe(0); expect(explicit.requests.some(row => row.t === "peer_start")).toBe(false);
  } finally { if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor); else delete (process.stdin as {isTTY?: boolean}).isTTY; }
});

test("Jcode opens a saved bound TUI with the owned native environment only after a fresh check, without a managed terminal record (#464, #564)", async () => {
  const fixture = entry(), events: string[] = [], binding = { launchId: "launch", sessionId: "session" };
  const launch = { cmd: "jcode-wrapper", args: ["prefix", "--socket", "/owned/socket", "--resume", "session"], env: { JCODE_HOME: "/native/home", JCODE_SOCKET: "/owned/socket", JCODE_NO_TELEMETRY: "1" } };
  fixture.context.connect = async () => ({ features: ["native_tui_launch"], close() {}, request: async (message: { t: string; binding?: unknown }) => {
    events.push(message.t);
    if (message.t === "status") return { status: { instanceId: "hub-instance", roster: [{ peer: "jcode", on: true }] } };
    if (message.t === "native_tui_launch") {
      if (events.filter(event => event === "native_tui_launch").length > 1) expect(message.binding).toEqual(binding);
      return { ok: true, state: "ready", binding, launch };
    }
    return { ok: true };
  } } as never);
  fixture.context.helpers.readControl = () => ({ instanceId: "hub-instance" } as never);
  // As the real helper does for a definition without session.launchRecord (#564): Jcode has no managed terminal recovery.
  fixture.context.helpers.recordTerminalLaunch = async () => { events.push("record"); throw new Error("jcode: no managed terminal recovery adapter"); };
  fixture.context.helpers.childEnv = () => ({ PATH: "/fixture/bin" });
  fixture.context.execWithEnv = (cmd, args, env): never => {
    events.push("exec"); expect(cmd).toBe(launch.cmd); expect(args).toEqual(launch.args);
    expect(env).toEqual({ PATH: "/fixture/bin", ...launch.env }); throw new Error("fixture exec");
  };
  const before = { input: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    await expect(runJcodeEntry(fixture.context)).rejects.toThrow("fixture exec");
    expect(events).toEqual(["status", "start", "native_tui_launch", "native_tui_launch", "exec"]);
  } finally {
    if (before.input) Object.defineProperty(process.stdin, "isTTY", before.input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (before.output) Object.defineProperty(process.stdout, "isTTY", before.output); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});


test("Jcode headless print-command stays a pure offline preview for a person (#464)", async () => {
  const fixture = entry(["--mode", "headless", "--print-command"]), lines: unknown[] = [], log = console.log;
  fixture.context.helpers.launcherPreview = () => ({ mode: "headless", cmd: "jcode", args: ["acp"] } as never);
  fixture.context.connect = async () => { throw new Error("preview must not connect"); };
  console.log = (...args) => { lines.push(args); };
  try {
    await runJcodeEntry(fixture.context);
    expect(fixture.requests).toHaveLength(0); expect(fixture.configured()).toBe(0);
    expect(lines).toHaveLength(1); expect(JSON.parse((lines[0] as string[])[0]!)).toMatchObject({ mode: "headless" });
  } finally { console.log = log; }
});

test("the running hub's accepted headless start mode beats a tui file or default in the launcher (#559 N4)", async () => {
  const fixture = entry();
  fixture.context.helpers.readControl = () => ({ startModes: { jcode: "headless" } } as never);
  fixture.context.projectConfig = () => ({ peers: { jcode: { start_mode: "tui" } } }) as never;
  const logs: unknown[][] = [], log = console.log; console.log = (...row: unknown[]) => { logs.push(row); };
  try { await runJcodeEntry(fixture.context); } finally { console.log = log; }
  expect(fixture.requests.find(row => row.t === "start")).toMatchObject({ peer: "jcode", args: { mode: "headless" } });
  expect(fixture.requests.some(row => row.t === "peer_start" || row.t === "native_tui_launch")).toBe(false);
  expect(fixture.configured()).toBe(1); expect(fixture.executed()).toBe(0);
  expect(String(logs[0]?.[0])).toContain("headless");
});

test("a mismatched model or provider profile is named in the refusal (#559)", async () => {
  const before = { input: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), output: Object.getOwnPropertyDescriptor(process.stdout, "isTTY") };
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    for (const [flag, option] of [["--model", "--model"], ["--provider-profile", "--provider-profile"]] as const) {
      const fixture = entry([flag, "other"]);
      fixture.context.connect = async () => ({ features: ["native_tui_launch"], close() {}, request: async (message: Record<string, unknown>) => {
        fixture.requests.push(message);
        return message.t === "status" ? { status: { instanceId: "i", roster: [{ peer: "jcode", on: true }] } }
          : message.t === "native_tui_launch" ? { ok: false, option, error: "differs" } : { ok: true };
      } }) as never;
      await expect(runJcodeEntry(fixture.context)).rejects.toThrow(option);
      expect(fixture.executed()).toBe(0);
    }
  } finally {
    if (before.input) Object.defineProperty(process.stdin, "isTTY", before.input); else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (before.output) Object.defineProperty(process.stdout, "isTTY", before.output); else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
});

test("--print-command names a mismatched session option, as the launch does (#574)", async () => {
  for (const option of ["--model", "--provider-profile", "--session-id"] as const) {
    const fixture = entry(["--print-command", option, "other"]);
    fixture.context.helpers.readControl = () => ({ features: ["native_tui_launch"] } as never);
    fixture.context.connect = async () => ({ features: ["native_tui_launch"], close() {}, request: async (message: Record<string, unknown>) => {
      fixture.requests.push(message);
      return message.t === "status" ? { status: { instanceId: "i", roster: [{ peer: "jcode", on: true }] } }
        : message.t === "native_tui_launch" ? { ok: false, option, error: "differs" } : { ok: true };
    } }) as never;
    await expect(runJcodeEntry(fixture.context)).rejects.toThrow(`a different ${option}`);
    expect(fixture.requests.some(row => row.t === "native_tui_launch")).toBe(true);
    expect(fixture.executed()).toBe(0); expect(fixture.configured()).toBe(0);
  }
});
