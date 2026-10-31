import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverClaudeHomes, claudeHomeEnvironment, checkClaudeHome, type ClaudeHomeProject } from "../src/cli/claude-homes.ts";
import { VERSION } from "../src/version.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-claude-homes-")); roots.push(root);
  const home = join(root, "user"), projectRoot = join(root, "project"), stateDir = join(root, "state"), profile = join(root, "profile-used");
  for (const dir of [home, projectRoot, stateDir, profile]) mkdirSync(dir);
  const project: ClaudeHomeProject = { root: projectRoot, stateDir, instanceId: "fixture-instance", claudePeers: ["claude"] };
  const env = { HOME: home };
  const record = (overrides: Record<string, unknown> = {}) => ({ peer: "claude", projectRoot, stateDir, instanceId: project.instanceId, launcherPid: process.pid, launcherSignature: "fixture-signature", launchId: "fixture-launch", handle: "fixture-handle", incarnationId: "fixture-incarnation", worktreeId: "fixture-worktree", env: { CLAUDE_CONFIG_DIR: profile }, ...overrides });
  const recordsFile = join(stateDir, "terminal-recovery.json");
  const writeRecords = (rows: unknown[]) => writeFileSync(recordsFile, JSON.stringify(rows), { mode: 0o600 });
  const discover = () => discoverClaudeHomes({ home, env, projects: [project], processIdentity: () => "fixture-signature" });
  return { root, home, projectRoot, profile, stateDir, env, project, record, recordsFile, writeRecords, discover };
}

test("only an explicit config home or an existing default home is selected, never adjacent profile directories", async () => {
  const f = fixture();
  mkdirSync(join(f.home, "unused-profile"));
  expect(await discoverClaudeHomes({ home: f.home, env: f.env })).toEqual({ homes: [], notices: [], complete: true });
  mkdirSync(join(f.home, ".claude"));
  expect((await discoverClaudeHomes({ home: f.home, env: f.env })).homes).toEqual([{ path: join(f.home, ".claude"), exists: true, sources: ["default"] }]);
  const explicit = join(f.home, "설정-home");
  expect((await discoverClaudeHomes({ home: f.home, env: { ...f.env, CLAUDE_CONFIG_DIR: explicit } })).homes).toEqual([{ path: explicit, exists: false, sources: ["environment"] }]);
});

test("live matching launch evidence adds its exact config home and canonical aliases deduplicate", async () => {
  const f = fixture(), alias = join(f.root, "profile-alias");
  symlinkSync(f.profile, alias);
  f.writeRecords([f.record()]);
  const result = await discoverClaudeHomes({ home: f.home, env: { ...f.env, CLAUDE_CONFIG_DIR: alias }, projects: [f.project], processIdentity: () => "fixture-signature" });
  expect(result).toEqual({ homes: [{ path: f.profile, exists: true, sources: ["environment", "recorded-launch"] }], notices: [], complete: true });
});

test("a missing captured config variable uses only the existing default for a proven live launch", async () => {
  const f = fixture();
  mkdirSync(join(f.home, ".claude"));
  f.writeRecords([f.record({ env: {} })]);
  const result = await f.discover();
  expect(result.homes).toEqual([{ path: join(f.home, ".claude"), exists: true, sources: ["default", "recorded-launch"] }]);
  expect(result.complete).toBe(true);
});

test("stale and foreign-instance launches do not select a profile, and unknown provenance stays explicit", async () => {
  const f = fixture();
  f.writeRecords([f.record({ launcherSignature: "another-signature" })]);
  expect((await f.discover()).homes).toEqual([]);
  f.writeRecords([f.record({ instanceId: "older-instance" })]);
  expect(await f.discover()).toEqual({ homes: [], notices: [], complete: true });
  f.writeRecords([f.record({ launcherSignature: undefined })]);
  const unknown = await f.discover();
  expect(unknown.homes).toEqual([]);
  expect(unknown.complete).toBe(false);
  expect(unknown.notices.join(" ")).toContain("cannot be proven live");
});

test("unsafe records and invalid home paths never become selected paths or reflect arbitrary content", async () => {
  const f = fixture();
  const invalid = await discoverClaudeHomes({ home: f.home, env: { ...f.env, CLAUDE_CONFIG_DIR: "relative-secret-content" } });
  expect(invalid.homes).toEqual([]);
  expect(invalid.complete).toBe(false);
  expect(invalid.notices.join(" ")).not.toContain("relative-secret-content");
  f.writeRecords([f.record()]); chmodSync(f.recordsFile, 0o666);
  const unsafe = await f.discover();
  expect(unsafe.homes).toEqual([]); expect(unsafe.complete).toBe(false);
  chmodSync(f.recordsFile, 0o600);
  rmSync(f.recordsFile); symlinkSync(join(f.root, "absent-record"), f.recordsFile);
  expect((await f.discover()).complete).toBe(false);
});

test("discovery has a finite launch-candidate budget with an explicit incomplete result", async () => {
  const f = fixture();
  f.writeRecords([f.record()]);
  const peers = Array.from({ length: 130 }, (_, i) => `claude-${i}`);
  const result = await discoverClaudeHomes({ home: f.home, env: f.env, projects: [{ ...f.project, claudePeers: peers }], processIdentity: () => "fixture-signature" });
  expect(result.complete).toBe(false);
  expect(result.notices.join(" ")).toContain("candidate limit");
});

test("per-home plugin probes preserve the caller environment, use exact scoped paths and make read calls only", async () => {
  const f = fixture(), packageRoot = join(f.root, "package");
  mkdirSync(packageRoot);
  const home = { path: f.profile, exists: true, sources: ["recorded-launch" as const] };
  const ambient = { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, "other-profile"), TEST_CONTEXT: "preserve" };
  const calls: { argv: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }[] = [];
  const result = await checkClaudeHome(home, packageRoot, ambient, (argv, options) => {
    calls.push({ argv, ...options });
    return { status: 0, stdout: JSON.stringify(argv.includes("marketplace") ? [{ name: "agent-hub", path: packageRoot }] : [{ id: "agent-hub@agent-hub", version: VERSION }]) };
  });
  expect(result.plugin.state).toBe("current");
  expect(result.next).toBeUndefined();
  expect(result.hook.state).toBe("missing");
  expect(calls.map(call => [...call.argv])).toEqual([["claude", "plugin", "list", "--json"], ["claude", "plugin", "marketplace", "list", "--json"]]);
  for (const call of calls) {
    expect(call.env).toMatchObject({ CLAUDE_CONFIG_DIR: f.profile, TEST_CONTEXT: "preserve" });
    expect(call.timeoutMs).toBeGreaterThan(0); expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
  }
  expect(ambient.CLAUDE_CONFIG_DIR).toBe(join(f.root, "other-profile"));
  expect(claudeHomeEnvironment(home, ambient)).not.toBe(ambient);
});

test("missing plugin and unavailable inventory stay distinct and error text never reflects native output", async () => {
  const f = fixture(), home = { path: f.profile, exists: true, sources: ["environment" as const] };
  const missing = await checkClaudeHome(home, f.root, f.env, () => ({ status: 0, stdout: "[]" }));
  expect(missing.plugin.state).toBe("missing");
  expect(missing.next?.argv).toEqual(["claude", "plugin", "marketplace", "add", f.root]);
  for (const reply of [{ status: 1, stdout: "sensitive failure content" }, { status: 0, stdout: "not-json-sensitive-content" }, { status: 0, stdout: "{}" }, { status: 0, stdout: '[{"id":"agent-hub@agent-hub","version":"sensitive-native-content"}]' }]) {
    const result = await checkClaudeHome(home, f.root, f.env, () => reply);
    expect(result.plugin.state).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("sensitive");
  }
});

test("an explicit missing home is reported without invoking a native CLI that might create it", async () => {
  const f = fixture(), path = join(f.home, "explicit-missing");
  const home = { path, exists: false, sources: ["environment" as const] };
  let probes = 0;
  const result = await checkClaudeHome(home, f.root, f.env, () => { probes++; throw new Error("status must not spawn for a missing home"); });
  expect(probes).toBe(0);
  expect(result.plugin.state).toBe("missing");
  expect(result.hook.state).toBe("missing");
  expect(result.next?.argv).toEqual(["claude", "plugin", "marketplace", "add", f.root]);
});

test("unsafe profile settings prevent native inventory probes as well as hook installation", async () => {
  const f = fixture(), home = { path: f.profile, exists: true, sources: ["environment" as const] };
  writeFileSync(join(f.profile, "settings.json"), "{}", { mode: 0o600 });
  chmodSync(join(f.profile, "settings.json"), 0o666);
  let probes = 0;
  const result = await checkClaudeHome(home, f.root, f.env, () => { probes++; return { status: 0, stdout: "[]" }; });
  expect(probes).toBe(0);
  expect(result.plugin.state).toBe("unknown");
  expect(result.hook.state).toBe("refused");
});
