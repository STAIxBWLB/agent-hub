import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { startModeOf } from "../src/hub/start-mode.ts";
import { ControlClient, readControl } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { retainedLaunchWarning } from "../src/cli/launch.ts";
import { renderStatus } from "../src/cli/output.ts";
import { initialConsoleState, renderConsoleLines } from "../src/cli/console-state.ts";
import { runClaudeEntry } from "../src/adapters/definitions/native-cli-entry-claude.ts";
import { runKimiEntry } from "../src/adapters/definitions/native-cli-entry-kimi.ts";
import { runPiEntry } from "../src/adapters/definitions/native-cli-entry-pi.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("#542 a retained guarded launch key stays visible until confirmed", async () => {
  const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-config-retained-"))), state = join(dir, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const file = (name: string) => join(dir, ".agenthub", name);
  writeFileSync(file("config.json"), JSON.stringify({ batch_ms: 0, roster: { jcode: false }, memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false }, pi: { enabled: false, auto_start: false } }));
  writeFileSync(file("routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "fixture baseline");
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(state, { role: "console" }); cleanup.push(() => client.close());

  writeFileSync(file("config.local.json"), JSON.stringify({ jcode_cmd: ["jcode", "--model", "new"] }));
  const preview = await client.request({ t: "settings_reload" });
  expect(preview.confirmation?.keys).toContain("jcode_cmd");
  const pending = (await client.request({ t: "status" })).status.retainedConfig;
  expect(pending).toContainEqual(expect.objectContaining({ key: "jcode_cmd", reason: expect.any(String) }));

  unlinkSync(file("config.local.json"));
  await client.request({ t: "settings_reload" });
  expect((await client.request({ t: "status" })).status.retainedConfig ?? []).toEqual([]);

  writeFileSync(file("config.local.json"), JSON.stringify({ jcode_cmd: ["jcode", "--model", "new"] }));
  const confirmedPreview = await client.request({ t: "settings_reload" });
  expect(confirmedPreview.confirmation?.keys).toContain("jcode_cmd");
  expect((await client.request({ t: "status" })).status.retainedConfig).toContainEqual(expect.objectContaining({ key: "jcode_cmd" }));
  const applied = await client.request({ t: "settings_reload", confirm: confirmedPreview.confirmation.token });
  expect(applied.ok).toBe(true);
  expect((await client.request({ t: "status" })).status.retainedConfig ?? []).toEqual([]);
}, 15_000);

test("#542 retained launch settings warn by adapter metadata and status renders the reload instruction", () => {
  const status = { retainedConfig: [{ key: "jcode_cmd", reason: "guarded change needs confirmation" }] };
  const warning = retainedLaunchWarning(status, "jcode", definitionOf("jcode")!);
  expect(warning).toContain("config retained: jcode_cmd");
  expect(warning).toContain("starting jcode with the running value");
  expect(warning).toContain("run ahub settings reload");
  expect(retainedLaunchWarning(status, "qwen", definitionOf("qwen")!)).toBeUndefined();
  expect(retainedLaunchWarning({ retainedConfig: [{ key: "peers.kimi.start_mode", reason: "guarded change" }] }, "kimi", definitionOf("kimi")!)).toContain("config retained: peers.kimi.start_mode");
  expect(retainedLaunchWarning({ retainedConfig: [{ key: "peers.pi.start_mode", reason: "guarded change" }] }, "pi", definitionOf("pi")!)).toContain("config retained: peers.pi.start_mode");
  const lines = renderStatus({ peers: {}, ...status }).flat().map(row => row.text);
  expect(lines.some(line => line.includes("config retained") && line.includes("jcode_cmd") && line.includes("run ahub settings reload"))).toBe(true);
  const consoleState = initialConsoleState(); consoleState.retainedConfig = status.retainedConfig;
  const consoleLines = renderConsoleLines(consoleState, 120).flat().map(row => row.text);
  expect(consoleLines.some(line => line.includes("config retained") && line.includes("jcode_cmd") && line.includes("run ahub settings reload"))).toBe(true);
});

test("#542 ahub jcode warns about a retained command and starts with the accepted argv", async () => {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-retained-jcode-"))), stateDir = join(cwd, ".agenthub/state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const agent = join(import.meta.dir, "fakes/jcode-agent.ts"), home = join(cwd, "jcode-home");
  mkdirSync(join(cwd, ".agenthub")); mkdirSync(home);
  writeFileSync(join(home, "mcp.json"), "{}");
  const oldRecord = join(cwd, "old-command.jsonl"), pendingRecord = join(cwd, "pending-command.jsonl");
  const oldCommand = [process.execPath, agent, "--record", oldRecord];
  const pendingCommand = [process.execPath, agent, "--record", pendingRecord];
  const configFile = (name: string) => join(cwd, ".agenthub", name);
  writeFileSync(configFile("config.json"), JSON.stringify({
    batch_ms: 0, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: true, pi: false, local: false },
    memory: { enabled: false, native: false }, inference: { enabled: false }, mlx: { enabled: false },
    pi: { enabled: false, auto_start: false }, approvals: { notify: true }, snapshots: { enabled: false },
  }));
  writeFileSync(configFile("routing.toml"), readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"'));
  writeFileSync(configFile("config.local.json"), JSON.stringify({ jcode_cmd: oldCommand, jcode_home: home }));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git("init", "-q"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "fixture baseline");

  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  expect(readControl(stateDir)?.startModes).toMatchObject({ kimi: "tui", pi: "tui" });

  writeFileSync(configFile("config.local.json"), JSON.stringify({ jcode_cmd: pendingCommand, jcode_home: home }));
  const reload = await client.request({ t: "settings_reload" });
  expect(reload.confirmation?.keys).toContain("jcode_cmd");
  expect((await client.request({ t: "status" })).status.retainedConfig).toContainEqual(expect.objectContaining({ key: "jcode_cmd" }));
  expect((await client.request({ t: "settings_set", key: "approvals.notify", value: false, reason: "scoped reload retention regression" })).ok).toBe(true);
  expect((await client.request({ t: "status" })).status.retainedConfig).toContainEqual(expect.objectContaining({ key: "jcode_cmd" }));

  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(cwd, "home"), JCODE_HOME: home, AGENTHUB_HOME: join(cwd, "home"),
    AGENTHUB_PROJECT_DIR: cwd, AGENTHUB_STATE_DIR: stateDir,
  };
  for (const key of Object.keys(env)) if (/^(AGENTHUB_(PEER_ID|CHANNEL|MODE|RECOVERY_OPERATION|INSTANCE_ID|LAUNCH_ID|DELIVERY_ONLY)|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)$/.test(key)) delete env[key];
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "jcode", "--mode", "headless"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  expect(stderr).toContain("config retained: jcode_cmd");
  expect(stderr).toContain("starting jcode with the running value");
  expect(stderr).toContain("run ahub settings reload");

  const rows = readFileSync(oldRecord, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.some((row: { kind?: string; home?: string }) => row.kind === "serve" && row.home === home)).toBe(true);
  expect(rows.some((row: { kind?: string; method?: string }) => row.kind === "rpc" && row.method === "initialize")).toBe(true);
  expect(existsSync(pendingRecord)).toBe(false);
}, 15_000);

test("#542 Claude's ordinary launcher does not require a hub connection", async () => {
  let connections = 0;
  const context = {
    args: [], cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf("claude"), projectConfig: () => ({}),
    connect: async () => { connections++; throw new Error("unexpected hub connection"); },
    fail: (message: string): never => { throw new Error(message); },
    helpers: {
      launcherPreview: () => ({}), readControl: () => undefined, recordTerminalLaunch: async () => undefined, prepareTerminalLaunch: async () => undefined, registerTerminalLaunch: async () => undefined,
      claudeObservationHooks: () => undefined, buildLaunch: () => ({ cmd: "claude", args: [] }),
      runClaudeLaunch: async () => { throw new Error("native launcher boundary reached"); },
      processSignature: () => undefined, recordClaudeLaunch: () => undefined, cleanupStaleClaudeSettings: () => undefined,
      nativeLaunchEnv: () => ({}), childEnv: () => ({}), cleanupClaudeSettings: () => undefined,
      retainedLaunchWarning: () => undefined,
    },
  } as any;
  await expect(runClaudeEntry(context)).rejects.toThrow("native launcher boundary reached");
  expect(connections).toBe(0);
});

function modeEntryContext(peer: "kimi" | "pi", args: string[] = []) {
  const requests: Record<string, unknown>[] = [];
  const snapshot = { retainedConfig: [{ key: `peers.${peer}.start_mode`, reason: "guarded start mode change" }], startModes: { [peer]: "tui" }, roster: [{ peer, on: true }], peers: {} };
  const context = {
    args, cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf(peer), projectConfig: () => ({ peers: { [peer]: { start_mode: "headless" } }, pi: { backend: "auto" } }),
    connect: async () => ({ request: async (message: Record<string, unknown>) => {
      requests.push(message);
      return message.t === "status" ? { status: snapshot } : message.t === "peer_start" ? { ok: true, opened: "fixture", command: `ahub ${peer}` } : { ok: true };
    }, close() {} }),
    fail: (message: string): never => { throw new Error(message); },
    takeFlags: (argv: string[]) => ({ one: Object.fromEntries(argv.reduce<string[][]>((pairs, value, index) => index % 2 ? pairs : [...pairs, [value, argv[index + 1]!]], [])), rest: [], many: {} }),
    helpers: {
      launcherPreview: () => ({}), retainedLaunchWarning,
      startModeOf: (peers: unknown, kind: string) => startModeOf(peers as any, kind),
      buildKimiTuiLaunch: () => ({ cmd: "fake-kimi", args: [] }), configureKimiMcp: () => ({ tracked: false }),
      nativeLaunchEnv: () => ({}), childEnv: () => ({}),
      recoveryLock: () => undefined, readControl: () => ({ startModes: { [peer]: "tui" } }), recordTerminalLaunch: async () => undefined, prepareTerminalLaunch: async () => undefined, registerTerminalLaunch: async () => undefined,
    },
  } as any;
  return { context, requests, snapshot };
}

test("#542 unflagged Kimi and Pi follow retained daemon start modes; explicit mode flags still win", async () => {
  for (const [peer, run] of [["kimi", runKimiEntry], ["pi", runPiEntry]] as const) {
    const pending = modeEntryContext(peer);
    await run(pending.context);
    expect(pending.requests.map(request => request.t)).toEqual(["status", "peer_start"]);

    const explicit = modeEntryContext(peer, ["--mode", "headless"]);
    if (peer === "kimi") explicit.context.helpers.configureKimiMcp = () => ({ tracked: false });
    await run(explicit.context);
    expect(explicit.requests.find(request => request.t === "start")).toMatchObject({ args: { mode: "headless" } });

    const legacy = modeEntryContext(peer);
    legacy.context.helpers.readControl = () => undefined;
    delete (legacy.snapshot as { startModes?: unknown }).startModes;
    legacy.snapshot.retainedConfig = [];
    await run(legacy.context);
    expect(legacy.requests.find(request => request.t === "start")).toMatchObject({ args: { mode: "headless" } });
  }
});
