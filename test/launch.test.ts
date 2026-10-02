import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLaunch, CLAUDE_CHANNEL } from "../src/cli/launch.ts";

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
