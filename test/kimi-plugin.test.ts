import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupKimiPlugin, ensureKimiPlugin, kimiPluginPlan, kimiPluginPreview } from "../src/cli/kimi-plugin.ts";
import { kimiTuiSpawnOptions, kimiTuiVersionGate, kimiTuiVersionProbe } from "../src/adapters/definitions/native-cli-entry-kimi.ts";
import { buildKimiTuiLaunch } from "../src/cli/launch.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(launchId = "launch-a") {
  const home = mkdtempSync(join(tmpdir(), "ahub-kimi-plugin-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const hookScript = join(home, "kimi-hook.js");
  writeFileSync(hookScript, "process.exit(0);\n");
  return { home, hookScript, launchId, now: 1000 };
}
const installed = (home: string) => JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8"));

test("the launch-scoped plugin installs only the completion hooks, preserves other plugins and cleans its own files", () => {
  const f = fixture();
  mkdirSync(join(f.home, "plugins"), { recursive: true });
  writeFileSync(join(f.home, "plugins", "installed.json"), JSON.stringify({ version: 1, plugins: [{ id: "other", root: "/other" }] }));
  expect(kimiPluginPreview(f.home, f.hookScript).action).toContain("remove it on exit");
  expect(kimiPluginPlan(f).changed).toBe(true);
  expect(ensureKimiPlugin(f).changed).toBe(true);
  const document = installed(f.home);
  expect(document.plugins.find((row: any) => row.id === "other")).toEqual({ id: "other", root: "/other" });
  expect(document.plugins.find((row: any) => row.id === "agent-hub")).toMatchObject({ enabled: true, agentHubLaunch: "launch-a" });
  const manifest = JSON.parse(readFileSync(join(f.home, "plugins", "managed", "agent-hub", "kimi.plugin.json"), "utf8"));
  expect(manifest.hooks.map((row: any) => row.event)).toEqual(["TurnStarted", "Stop", "StopFailure", "Interrupt", "SessionEnd", "TaskStarted", "Notification"]);
  expect(kimiPluginPlan(f).changed).toBe(false);
  expect(ensureKimiPlugin(f).changed).toBe(false);
  cleanupKimiPlugin(f);
  expect(installed(f.home).plugins).toEqual([{ id: "other", root: "/other" }]);
  expect(existsSync(join(f.home, "plugins", "managed", "agent-hub"))).toBe(false);
});

test("preview allows a native home that does not exist yet without creating it", () => {
  const f = fixture();
  const home = join(f.home, "new-home");
  expect(kimiPluginPreview(home, f.hookScript).changed).toBe(true);
  expect(existsSync(home)).toBe(false);
});

test("another launch's record and linked inputs are refused without writes", () => {
  const f = fixture();
  ensureKimiPlugin(f);
  const before = readFileSync(join(f.home, "plugins", "installed.json"), "utf8");
  expect(() => kimiPluginPlan({ ...f, launchId: "launch-b" })).toThrow("another launch");
  expect(() => cleanupKimiPlugin({ ...f, launchId: "launch-b" })).toThrow("another launch");
  expect(readFileSync(join(f.home, "plugins", "installed.json"), "utf8")).toBe(before);
  expect(existsSync(join(f.home, "plugins", "managed", "agent-hub", "kimi-hook.js"))).toBe(true);
  const linked = fixture("launch-linked");
  const target = join(linked.home, "target.js");
  writeFileSync(target, "process.exit(0);\n");
  rmSync(linked.hookScript);
  symlinkSync(target, linked.hookScript);
  expect(() => ensureKimiPlugin(linked)).toThrow("bounded regular file");
  expect(existsSync(join(linked.home, "plugins", "installed.json"))).toBe(false);
});

test("cleanup leaves a file changed during the launch and removes only the unchanged hook", () => {
  const f = fixture();
  ensureKimiPlugin(f);
  const manifest = join(f.home, "plugins", "managed", "agent-hub", "kimi.plugin.json");
  writeFileSync(manifest, "{}\n");
  cleanupKimiPlugin(f);
  expect(readFileSync(manifest, "utf8")).toBe("{}\n");
  expect(existsSync(join(f.home, "plugins", "managed", "agent-hub", "kimi-hook.js"))).toBe(false);
  expect(installed(f.home).plugins).toEqual([]);
});

test("only the exact native TUI version with a live completion receipt is admitted", () => {
  expect(kimiTuiVersionGate("2.5.2\n")).toEqual({ ok: true });
  for (const version of ["2.5.1", "2.5.3", "2.5", "kimi 2.5.2", ""]) expect(kimiTuiVersionGate(version).ok).toBe(false);
});

test("the version probe preserves the configured TUI prefix without launch-only model options", () => {
  expect(kimiTuiVersionProbe(buildKimiTuiLaunch(["python", "/fixture/kimi.py", "acp"]))).toEqual({ cmd: "python", args: ["/fixture/kimi.py", "--version"] });
});

test("an active owner in another project is never replaced", () => {
  const f = fixture();
  ensureKimiPlugin({ ...f, ownerPid: 4242, ownerSignature: "owner-a", liveness: () => "live" });
  const before = readFileSync(join(f.home, "plugins", "installed.json"), "utf8");
  expect(() => ensureKimiPlugin({ ...f, launchId: "launch-b", replaceStale: true, liveness: () => "live" })).toThrow("active or unknown");
  expect(readFileSync(join(f.home, "plugins", "installed.json"), "utf8")).toBe(before);
});

test("a newly admitted launch replaces a stale record while the stale cleanup stays refused", () => {
  const f = fixture();
  const first = { ...f, replaceStale: true, ownerPid: 4242, ownerSignature: "stale-owner" };
  ensureKimiPlugin(first);
  const replacement = { ...f, launchId: "launch-b", replaceStale: true, ownerPid: 4343, ownerSignature: "new-owner", liveness: () => "gone" as const };
  expect(ensureKimiPlugin(replacement).changed).toBe(true);
  expect(installed(f.home).plugins[0]).toMatchObject({ id: "agent-hub", agentHubLaunch: "launch-b", agentHubOwner: { pid: 4343, signature: "new-owner" } });
  expect(() => cleanupKimiPlugin(first)).toThrow("another launch");
  expect(installed(f.home).plugins[0]).toMatchObject({ id: "agent-hub", agentHubLaunch: "launch-b" });
  cleanupKimiPlugin(replacement);
  expect(installed(f.home).plugins).toEqual([]);
});

test("a foreign replacement lock fails closed without changing the installed record", () => {
  const f = fixture();
  ensureKimiPlugin(f);
  const before = readFileSync(join(f.home, "plugins", "installed.json"), "utf8");
  writeFileSync(join(f.home, "agent-hub-plugin.lock"), "another-owner");
  expect(() => ensureKimiPlugin({ ...f, launchId: "launch-b", replaceStale: true, liveness: () => "gone" })).toThrow("stale lock");
  expect(readFileSync(join(f.home, "plugins", "installed.json"), "utf8")).toBe(before);
});

test("the native TUI stays in the foreground process group so its launcher socket stays live", () => {
  expect(kimiTuiSpawnOptions("/project", { AGENTHUB_PEER_ID: "kimi" })).toEqual({ cwd: "/project", env: { AGENTHUB_PEER_ID: "kimi" }, stdio: "inherit" });
  expect(kimiTuiSpawnOptions("/project", {})).not.toHaveProperty("detached");
});
