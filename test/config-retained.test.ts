import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { definitionOf } from "../src/adapters/registry.ts";
import { retainedLaunchWarning } from "../src/cli/launch.ts";
import { renderStatus } from "../src/cli/output.ts";
import { initialConsoleState, renderConsoleLines } from "../src/cli/console-state.ts";
import { runClaudeEntry } from "../src/adapters/definitions/native-cli-entry-claude.ts";

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
  const daemon = await startDaemon({ cwd: dir, stateDir: state, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0 });
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
  const lines = renderStatus({ peers: {}, ...status }).flat().map(row => row.text);
  expect(lines.some(line => line.includes("config retained") && line.includes("jcode_cmd") && line.includes("run ahub settings reload"))).toBe(true);
  const consoleState = initialConsoleState(); consoleState.retainedConfig = status.retainedConfig;
  const consoleLines = renderConsoleLines(consoleState, 120).flat().map(row => row.text);
  expect(consoleLines.some(line => line.includes("config retained") && line.includes("jcode_cmd") && line.includes("run ahub settings reload"))).toBe(true);
});

test("#542 Claude's ordinary launcher does not require a hub connection", async () => {
  let connections = 0;
  const context = {
    args: [], cwd: "/project", stateDir: "/state", cliDir: "/package/src/cli", unattendedEnv: false,
    definition: definitionOf("claude"), projectConfig: () => ({}),
    connect: async () => { connections++; throw new Error("unexpected hub connection"); },
    fail: (message: string): never => { throw new Error(message); },
    helpers: {
      launcherPreview: () => ({}), readControl: () => undefined, recordTerminalLaunch: async () => undefined,
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
