import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLaunch, claudeObservationHooks, CLAUDE_CHANNEL } from "../src/cli/launch.ts";

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
  const paths = { script: "/candidate/facts-hook.ts", stateDir: "/candidate/state" };
  expect(claudeObservationHooks({ coordination: "advisory", task_sweep: { enabled: false } }, paths)?.purpose).toBe("permission");
  expect(claudeObservationHooks({ coordination: "advisory" }, paths)?.purpose).toBe("permission");
  for (const [coordination, enabled, purpose] of [["advisory", true, "idle"], ["turn-free", false, "facts"], ["turn-free", true, "facts-and-idle"]] as const) {
    const facts = claudeObservationHooks({ coordination, task_sweep: { enabled } }, paths)!;
    expect(facts.purpose).toBe(purpose);
    const launch = buildLaunch("claude", [], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    for (const hook of ["PreToolUse", "PostToolUse", "Stop"]) expect(settings.hooks[hook][0].hooks[0].command).toContain("facts-hook.ts");
    const own = buildLaunch("claude", ["--settings", JSON.stringify({ statusLine: { command: "caller" }, hooks: { PreToolUse: [{ hooks: [{ command: "caller-hook" }] }] } })], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    expect(own.args.filter(arg => arg === "--settings")).toHaveLength(1);
    const ownSettings = JSON.parse(own.args[own.args.indexOf("--settings") + 1]!);
    expect(ownSettings.statusLine.command).toBe("caller");
    expect(ownSettings.hooks.PreToolUse).toHaveLength(2);
    expect(own.permissionHook).toBe(true);
  }
});


test("advisory and unattended launches install the permission hook without global settings changes", () => {
  const facts = claudeObservationHooks({ coordination: "advisory" }, { script: "/candidate/facts-hook.ts", stateDir: "/candidate/state" })!;
  for (const unattended of [false, true]) {
    const launch = buildLaunch("claude", [], { unattended, facts });
    expect(launch).toMatchObject({ permissionHook: true, unattended });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    expect(Object.keys(settings.hooks).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(settings.hooks.Stop[0].hooks).toEqual(settings.hooks.PreToolUse[0].hooks);
    expect(settings).not.toHaveProperty("statusLine");
  }
  expect(() => buildLaunch("claude", ["--settings", "/missing/settings.json"], { unattended: false, facts })).toThrow("permission hook must be installed");
  const dir = mkdtempSync(join(tmpdir(), "ahub-permission-settings-"));
  try {
    const file = join(dir, "settings.json"); writeFileSync(file, JSON.stringify({ env: { USER_VALUE: "preserved" } }));
    const launch = buildLaunch("claude", [`--settings=${file}`], { unattended: false, facts });
    expect(JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!)).toMatchObject({ env: { USER_VALUE: "preserved" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("facts-only launches inject managed settings and hook metadata reflects installation", () => {
  const facts = claudeObservationHooks({ coordination: "turn-free" }, { script: "/candidate/facts-hook.ts", stateDir: "/candidate/state" });
  const launch = buildLaunch("claude", [], { unattended: false, facts });
  const index = launch.args.indexOf("--settings"); expect(index).toBeGreaterThanOrEqual(0);
  const settings = JSON.parse(launch.args[index + 1]!);
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
