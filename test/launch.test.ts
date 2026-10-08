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


test("Claude native observation hooks are opt-in in advisory and preserve caller settings", () => {
  const paths = { script: "/candidate/facts-hook.ts", stateDir: "/candidate/state" };
  expect(claudeObservationHooks({ coordination: "advisory", task_sweep: { enabled: false } }, paths)).toBeUndefined();
  expect(claudeObservationHooks({ coordination: "advisory" }, paths)).toBeUndefined();
  for (const [coordination, enabled, purpose] of [["advisory", true, "idle"], ["turn-free", false, "facts"], ["turn-free", true, "facts-and-idle"]] as const) {
    const facts = claudeObservationHooks({ coordination, task_sweep: { enabled } }, paths)!;
    expect(facts.purpose).toBe(purpose);
    const launch = buildLaunch("claude", [], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    const settings = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]!);
    for (const hook of ["PreToolUse", "PostToolUse", "Stop"]) expect(settings.hooks[hook][0].hooks[0].command).toContain("facts-hook.ts");
    const own = buildLaunch("claude", ["--settings", "caller-settings"], { unattended: false, statusLine: { script: "/candidate/tee.ts", stateDir: paths.stateDir }, facts });
    expect(own.args.filter(arg => arg === "--settings")).toHaveLength(1);
    expect(own.args.at(-1)).toBe("caller-settings");
    expect(own.warning).toContain(purpose === "facts" ? "turn-free facts hooks are off" : "native idle observation hooks are off");
  }
});
