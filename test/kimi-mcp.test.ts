import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureKimiMcp, hasKimiHubMcp, kimiMcpPlan, KIMI_MCP_FILE } from "../src/cli/kimi-mcp.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() { const root = mkdtempSync(join(tmpdir(), "kimi-mcp-")); roots.push(root); return root; }

test("Kimi MCP preview writes nothing and exposes no foreign configuration (#316)", () => {
  const root = project();
  const plan = kimiMcpPlan(root, join(root, "state"), "/installed/server.js", "tui");
  expect(plan.action).toBe("merge agent-hub entry");
  expect(existsSync(join(root, ".kimi-code"))).toBe(false);
  expect(plan.next.mcpServers?.["agent-hub"]).toEqual({ command: "bun", args: ["run", "/installed/server.js"], env: { AGENTHUB_PEER_ID: "kimi", AGENTHUB_STATE_DIR: join(root, "state"), AGENTHUB_PROJECT_DIR: root } });
});

test("Kimi MCP launcher merges and replaces only its entry, then headless removes it (#316)", () => {
  const root = project(); mkdirSync(join(root, ".kimi-code"));
  const foreign = { command: "foreign-tool", args: ["literal", "two words"], env: { FOREIGN_SETTING: "kept" } };
  const original = { extra: { policy: true }, mcpServers: { foreign, "agent-hub": { command: "old" } } };
  const file = join(root, KIMI_MCP_FILE); writeFileSync(file, JSON.stringify(original));
  expect(configureKimiMcp(root, "/state", "/bundle/server.js", "tui").changed).toBe(true);
  const next = JSON.parse(readFileSync(file, "utf8"));
  expect(next.extra).toEqual(original.extra); expect(next.mcpServers.foreign).toEqual(foreign);
  expect(next.mcpServers["agent-hub"].env).toEqual({ AGENTHUB_PEER_ID: "kimi", AGENTHUB_STATE_DIR: "/state", AGENTHUB_PROJECT_DIR: root });
  expect(hasKimiHubMcp(root)).toBe(true);
  expect(configureKimiMcp(root, "/state", "/bundle/server.js", "tui").changed).toBe(false);
  expect(configureKimiMcp(root, "/state", "/bundle/server.js", "headless").changed).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ extra: original.extra, mcpServers: { foreign } });
  expect(hasKimiHubMcp(root)).toBe(false);
  expect(readFileSync(file, "utf8")).not.toContain("AGENTHUB");
});

test("Kimi headless cleanup creates no missing file and invalid or linked settings fail closed (#316)", () => {
  const root = project();
  expect(configureKimiMcp(root, "/state", "/bundle", "headless").changed).toBe(false);
  expect(existsSync(join(root, ".kimi-code"))).toBe(false);
  mkdirSync(join(root, ".kimi-code")); const file = join(root, KIMI_MCP_FILE);
  for (const value of ["not JSON", "[]", '{"mcpServers":[]}']) {
    writeFileSync(file, value); expect(() => configureKimiMcp(root, "/state", "/bundle", "tui")).toThrow();
    expect(readFileSync(file, "utf8")).toBe(value);
  }
  rmSync(file); const elsewhere = join(root, "elsewhere.json"); writeFileSync(elsewhere, "{}"); symlinkSync(elsewhere, file);
  expect(() => configureKimiMcp(root, "/state", "/bundle", "tui")).toThrow("not a link");
  expect(readFileSync(elsewhere, "utf8")).toBe("{}");
});
