import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { authorizeConfigLeaf, configApply, validateEffectiveConfig, validateRawConfig } from "../src/hub/config-apply.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
const remote = { host: "fixture@runner.reserved.invalid", image: "registry.reserved.invalid/check@sha256:" + "a".repeat(64), root: "/reserved/check-root" };
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-remote-config-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agenthub"));
  const git = (...args: string[]) => { const result = hubGitSync(["-C", root, ...args], { encoding: "utf8" }); if (result.status !== 0) throw Error("fixture git failed"); };
  git("init", "-q"); return { root, git };
}
test("remote checks require exactly an untracked machine-local config and cannot be granted by tracked layers", () => {
  const f = fixture(), config = { checks: { runner: "remote", remote } };
  writeFileSync(join(f.root, ".agenthub/config.json"), JSON.stringify(config));
  expect(() => loadConfig(f.root)).toThrow("remote checks require untracked config.local.json");
  rmSync(join(f.root, ".agenthub/config.json")); writeFileSync(join(f.root, ".agenthub/config.local.json"), JSON.stringify(config));
  expect(loadConfig(f.root).checks).toMatchObject({ runner: "remote", remote });
  f.git("add", "-f", ".agenthub/config.local.json");
  expect(() => loadConfig(f.root)).toThrow("remote checks require untracked config.local.json");
});
test("remote checks schema validates strict tokens and all remote leaves retain startup-only trust", () => {
  expect(() => validateRawConfig({ checks: { runner: "remote", remote } })).not.toThrow();
  expect(() => validateEffectiveConfig({ ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks, runner: "remote", remote } })).not.toThrow();
  expect(() => validateRawConfig({ checks: { runner: "remote", remote: { ...remote, host: "unsafe;command" } } })).toThrow("invalid remote runner configuration");
  for (const [key, after] of [["checks.runner", "remote"], ["checks.remote", remote], ["checks.remote.host", remote.host]]) {
    expect(configApply(key as string)).toMatchObject({ applies: "restart" });
    for (const tracked of [true, undefined]) expect(authorizeConfigLeaf({ key: key as string, after, before: after, source: "config", sourceFile: "config.local.json", tracked, authority: "terminal", confirmed: true }).allowed).toBe(false);
    expect(authorizeConfigLeaf({ key: key as string, after, source: "config", sourceFile: "config.json", tracked: false, authority: "terminal", confirmed: true }).allowed).toBe(false);
    expect(authorizeConfigLeaf({ key: key as string, after, source: "config", sourceFile: "config.local.json", tracked: false, authority: "terminal", confirmed: true }).allowed).toBe(true);
  }
});
test("daemon feeds remote unavailability into sandboxed tests capability without selecting a local runner", async () => {
  const f = fixture(); let optionsSeen: unknown, stopped = false;
  const daemon = await startDaemon({ cwd: f.root, stateDir: join(f.root, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks, runner: "remote", remote }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } },
    boundedTools: { runner: options => { optionsSeen = options; return { available: async () => ({ available: false, reason: "remote runner unavailable" }),
      sweep: async () => [], stopAll: async () => { stopped = true; }, start: () => { throw Error("must not start an unavailable runner"); }, result: async () => undefined, consumeOutput: async () => {}, cancel: async () => {}, markStale: async () => {} }; } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(join(f.root, "state"), { role: "console" }); cleanup.push(() => client.close());
  const response = await client.request({ t: "status" });
  const status = response.status as { taskCapabilities: Record<string, { tests: boolean; testsReason: string }> };
  expect(optionsSeen).toMatchObject({ remote });
  expect(status.taskCapabilities.pi!.tests).toBe(false); expect(status.taskCapabilities.pi!.testsReason).toContain("remote runner unavailable");
  expect(JSON.stringify(response)).not.toContain(remote.host); expect(JSON.stringify(response)).not.toContain(remote.root);
  await daemon.stop(); expect(stopped).toBe(true);
});

test("remote metadata is reserved and cannot be reinterpreted as a custom completion-check command", () => {
  expect(() => validateEffectiveConfig({ ...DEFAULT_CONFIG, profile_overrides: { classes: { remote: "implement" } }, checks: { ...DEFAULT_CONFIG.checks, remote: "bun test" } })).toThrow("invalid remote runner configuration");
});
