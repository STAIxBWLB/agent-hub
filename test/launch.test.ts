import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync, chmodSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLaunch, cleanupClaudeSettings, claudeObservationHooks, CLAUDE_CHANNEL } from "../src/cli/launch.ts";

const states: string[] = [];
afterEach(() => { for (const dir of states.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixtureState = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-launch-state-")); states.push(dir); return dir; };
const settingsOf = (launch: { args: string[] }) => { const value = launch.args[launch.args.indexOf("--settings") + 1]!; expect(value.startsWith("{")).toBe(false); expect(statSync(value).mode & 0o777).toBe(0o600); return JSON.parse(readFileSync(value, "utf8")); };

test("an exact candidate MCP bundle selects its server channel without overriding owned flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-inline-plugin-"));
  try {
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { "agent-hub": { command: "bun", args: [join(import.meta.dir, "../plugins/agent-hub/server.js")] } } }));
    const launch = buildLaunch("claude", ["--mcp-config", config], { unattended: false });
    expect(launch.args.slice(0, 2)).toEqual(["--dangerously-load-development-channels", "server:agent-hub"]);
    expect(launch.args).not.toContain("--dangerously-skip-permissions");
    writeFileSync(config, JSON.stringify({ mcpServers: { "agent-hub": { command: "bun", args: ["/other/bundle.js"] } } }));
    expect(buildLaunch("claude", ["--mcp-config", config], { unattended: false }).args[1]).toBe(CLAUDE_CHANNEL);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("Claude permission hooks are always installed while native observation remains opt-in", () => {
  const paths = { script: "/candidate/facts-hook.ts", stateDir: fixtureState() };
  expect(claudeObservationHooks({ coordination: "advisory", task_sweep: { enabled: false } }, paths)?.purpose).toBe("permission");
  expect(claudeObservationHooks({ coordination: "advisory" }, paths)?.purpose).toBe("permission");
  for (const [coordination, enabled, purpose] of [["advisory", true, "idle"], ["turn-free", false, "facts"], ["turn-free", true, "facts-and-idle"]] as const) {
    const facts = claudeObservationHooks({ coordination, task_sweep: { enabled } }, paths)!;
    expect(facts.purpose).toBe(purpose);
    const launch = buildLaunch("claude", [], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    const settings = settingsOf(launch);
    for (const hook of ["PreToolUse", "PostToolUse", "Stop"]) expect(settings.hooks[hook][0].hooks[0].command).toContain("facts-hook.ts");
    const own = buildLaunch("claude", ["--settings", JSON.stringify({ statusLine: { command: "caller" }, hooks: { PreToolUse: [{ hooks: [{ command: "caller-hook" }] }] } })], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    expect(own.args.filter(arg => arg === "--settings")).toHaveLength(1);
    const ownSettings = settingsOf(own);
    expect(ownSettings.statusLine.command).toBe("caller");
    expect(ownSettings.hooks.PreToolUse).toHaveLength(2);
    expect(own.permissionHook).toBe(true);
  }
});


test("advisory and unattended launches install the permission hook without global settings changes", () => {
  const facts = claudeObservationHooks({ coordination: "advisory" }, { script: "/candidate/facts-hook.ts", stateDir: fixtureState() })!;
  for (const unattended of [false, true]) {
    const launch = buildLaunch("claude", [], { unattended, facts });
    expect(launch).toMatchObject({ permissionHook: true, unattended });
    const settings = settingsOf(launch);
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("AGENTHUB_HOOK_PURPOSE='permission'");
    expect(launch.hookPurpose).toBe("permission");
    expect(settings).not.toHaveProperty("statusLine");
  }
  expect(() => buildLaunch("claude", ["--settings", "/missing/settings.json"], { unattended: false, facts })).toThrow("permission hook must be installed");
  const dir = mkdtempSync(join(tmpdir(), "ahub-permission-settings-"));
  try {
    const file = join(dir, "settings.json"); writeFileSync(file, JSON.stringify({ env: { USER_VALUE: "preserved" } }));
    const launch = buildLaunch("claude", [`--settings=${file}`], { unattended: false, facts: { ...facts, stateDir: dir } });
    expect(JSON.parse(readFileSync(launch.args[launch.args.indexOf("--settings") + 1]!, "utf8"))).toMatchObject({ env: { USER_VALUE: "preserved" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("facts-only launches inject managed settings and hook metadata reflects installation", () => {
  const facts = claudeObservationHooks({ coordination: "turn-free" }, { script: "/candidate/facts-hook.ts", stateDir: fixtureState() });
  const launch = buildLaunch("claude", [], { unattended: false, facts });
  const index = launch.args.indexOf("--settings"); expect(index).toBeGreaterThanOrEqual(0);
  const settings = settingsOf(launch);
  for (const event of ["PreToolUse", "PostToolUse", "Stop", "SessionStart", "UserPromptSubmit"]) expect(settings.hooks[event]).toBeDefined();
  expect(settings).not.toHaveProperty("statusLine"); expect(launch.permissionHook).toBe(true);
  expect(() => buildLaunch("claude", ["--settings", JSON.stringify({ disableAllHooks: true })], { unattended: false, facts })).toThrow("disableAllHooks prevents the required hub permission hook");
  const unmanaged = buildLaunch("claude", [], { unattended: false });
  expect(unmanaged.args).not.toContain("--settings"); expect(unmanaged.permissionHook).toBe(false);
});


test("Codex launch metadata preserves unattended mode from either CLI or environment", () => {
  for (const [args, configured, expected] of [[[], false, false], [["--unattended"], false, true], [[], true, true]] as const) {
    const launch = buildLaunch("codex", [...args], { unattended: configured, proxyUrl: "ws://fixture" });
    expect(launch.unattended).toBe(expected);
    expect(launch.args.includes("--dangerously-bypass-approvals-and-sandbox")).toBe(expected);
  }
});


test("merged caller settings are private files rather than native argv and previews write nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-private-settings-"));
  try {
    const facts = claudeObservationHooks({}, { script: "/candidate/facts-hook.ts", stateDir: dir });
    const caller = JSON.stringify({ env: { PASSWORD: "native-argv-canary" }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo caller-secret-canary" }] }] } });
    const before = readdirSync(dir);
    const draft = buildLaunch("claude", ["--settings", caller], { unattended: false, facts, preview: true });
    expect(readdirSync(dir)).toEqual(before); expect(JSON.parse(draft.args[draft.args.indexOf("--settings") + 1]!).env.PASSWORD).toBe("native-argv-canary");
    const launch = buildLaunch("claude", ["--settings", caller], { unattended: false, facts });
    expect(launch.args.join(" ")).not.toContain("native-argv-canary"); expect(launch.args.join(" ")).not.toContain("caller-secret-canary");
    const file = launch.args[launch.args.indexOf("--settings") + 1]!;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(file, "utf8")); expect(settings.env.PASSWORD).toBe("native-argv-canary"); expect(settings.hooks.PreToolUse).toHaveLength(2);
    for (const ctx of [
      { unattended: false, facts },
      { unattended: false, statusLine: { script: "/tee.ts", stateDir: dir, original: { command: "echo statusline-secret-canary" } } },
      { unattended: false, facts, statusLine: { script: "/tee.ts", stateDir: dir, original: { command: "echo statusline-secret-canary" } } },
    ]) {
      const generated = buildLaunch("claude", [], ctx);
      expect(generated.args.join(" ")).not.toContain("statusline-secret-canary"); settingsOf(generated);
    }
    expect(readdirSync(dir).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("retiring private Claude settings preserves arbitrary paths, links and previews", () => {
  const state = fixtureState(), outside = fixtureState();
  const facts = claudeObservationHooks({}, { script: "/candidate/facts-hook.ts", stateDir: state });
  const old = buildLaunch("claude", [], { unattended: false, facts });
  expect(old.settingsFile).toBe(old.args[old.args.indexOf("--settings") + 1]);
  const before = readdirSync(state);
  const draft = buildLaunch("claude", [], { unattended: false, facts, preview: true });
  expect(draft.settingsFile).toBeUndefined(); expect(readdirSync(state)).toEqual(before); expect(existsSync(old.settingsFile!)).toBe(true);
  const next = buildLaunch("claude", [], { unattended: false, facts });
  cleanupClaudeSettings(state, old.settingsFile); expect(existsSync(old.settingsFile!)).toBe(false); expect(existsSync(next.settingsFile!)).toBe(true);
  const name = "claude-settings-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json";
  const outsideFile = join(outside, name); writeFileSync(outsideFile, "outside", { mode: 0o600 });
  const arbitrary = join(state, "important.json"); writeFileSync(arbitrary, "preserve", { mode: 0o600 });
  cleanupClaudeSettings(state, outsideFile); cleanupClaudeSettings(state, arbitrary);
  expect(existsSync(outsideFile)).toBe(true); expect(existsSync(arbitrary)).toBe(true);
  const symlink = join(state, name); symlinkSync(outsideFile, symlink); cleanupClaudeSettings(state, symlink);
  expect(existsSync(symlink)).toBe(true); expect(readFileSync(outsideFile, "utf8")).toBe("outside");
  const nonPrivate = buildLaunch("claude", [], { unattended: false, facts }).settingsFile!;
  chmodSync(nonPrivate, 0o644); cleanupClaudeSettings(state, nonPrivate); expect(existsSync(nonPrivate)).toBe(true);
  const linked = buildLaunch("claude", [], { unattended: false, facts }).settingsFile!;
  linkSync(linked, join(outside, "linked-copy")); cleanupClaudeSettings(state, linked); expect(existsSync(linked)).toBe(true);
  cleanupClaudeSettings(state, undefined); cleanupClaudeSettings(state, { settingsFile: next.settingsFile });
  expect(existsSync(next.settingsFile!)).toBe(true);
});
