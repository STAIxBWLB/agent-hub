import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agyMcpPlan, agyMcpReady, cleanupAgyMcp, ensureAgyMcp, type AgyMcpOptions } from "../src/cli/agy-mcp.ts";

const roots: string[] = [];
const plugin = (root: string) => join(root, ".agents/plugins/agent-hub");
const paths = (root: string) => [join(plugin(root), "plugin.json"), join(plugin(root), "mcp_config.json"), join(plugin(root), "hooks.json")] as const;
const options = (root: string, instanceId = "instance-a", launchId = "launch-a"): AgyMcpOptions => ({
  projectRoot: root, stateDir: join(root, ".agenthub/state"), serverJs: "/installed/plugins/agent-hub/server.js", hookScript: "/installed/src/cli/facts-hook.ts", instanceId, launchId, peer: "agy",
});
function project() { const root = mkdtempSync(join(tmpdir(), "agy-mcp-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("agy MCP plan is read-only and describes only the managed plugin files", () => {
  const root = project(), opts = options(root);
  const plan = agyMcpPlan(opts);
  expect(plan.file).toBe(plugin(root));
  expect(plan.changed).toBe(true);
  expect(plan.action).toContain("agent-hub");
  expect(existsSync(join(root, ".agents"))).toBe(false);
});

test("agy MCP ensure creates its plugin, preserves other files, and is idempotent", () => {
  const root = project(), opts = options(root);
  mkdirSync(plugin(root), { recursive: true });
  writeFileSync(join(plugin(root), "README.md"), "keep this file\n");
  expect(ensureAgyMcp(opts)).toMatchObject({ changed: true, tracked: false });
  expect(agyMcpReady(opts)).toBe(true);
  expect(ensureAgyMcp(opts)).toEqual({ changed: false, tracked: false });
  const [manifest, mcp, hooks] = paths(root).map(path => JSON.parse(readFileSync(path, "utf8")));
  expect(Object.keys(manifest).sort()).toEqual(["description", "name"]);
  expect(manifest.name).toBe("agent-hub");
  expect(manifest.description).toContain("ahub agy");
  expect(mcp.mcpServers["agent-hub"]).toEqual({ command: "bun", args: ["run", opts.serverJs], env: { AGENTHUB_PEER_ID: "agy", AGENTHUB_STATE_DIR: opts.stateDir, AGENTHUB_PROJECT_DIR: root } });
  expect(Object.keys(hooks["agent-hub"]).sort()).toEqual(["PostInvocation", "PostToolUse", "PreInvocation", "PreToolUse", "SessionStart", "Stop"]);
  expect(hooks["agent-hub"].PostInvocation).toEqual([]);
  expect(readFileSync(join(plugin(root), "README.md"), "utf8")).toBe("keep this file\n");
  expect(existsSync(join(root, ".agents/hooks.json"))).toBe(false);
});

test("recognized managed entries update for a new launch and stale cleanup preserves the replacement", () => {
  const root = project(), old = options(root), current = { ...options(root, "instance-b", "launch-b"), serverJs: "/new-release/plugins/agent-hub/server.js", hookScript: "/new-release/src/cli/facts-hook.ts" };
  expect(ensureAgyMcp(old).changed).toBe(true);
  expect(ensureAgyMcp(current).changed).toBe(true);
  expect(agyMcpReady(current)).toBe(true);
  cleanupAgyMcp(old);
  expect(agyMcpReady(current)).toBe(true);
  expect(JSON.stringify(JSON.parse(readFileSync(paths(root)[2]!, "utf8")))).toContain("launch-b");
  cleanupAgyMcp(current);
  expect(paths(root).some(existsSync)).toBe(false);
});

test("cleanup removes only the managed MCP server and preserves unrelated server entries", () => {
  const root = project(), opts = options(root), dir = plugin(root);
  mkdirSync(dir, { recursive: true });
  const original = { extension: { keep: true }, mcpServers: { other: { command: "other-tool", args: ["serve"] } } };
  writeFileSync(join(dir, "mcp_config.json"), JSON.stringify(original));
  expect(ensureAgyMcp(opts).changed).toBe(true);
  cleanupAgyMcp(opts);
  expect(JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8"))).toEqual(original);
  expect(existsSync(join(dir, "plugin.json"))).toBe(false);
  expect(existsSync(join(dir, "hooks.json"))).toBe(false);
});

test("foreign plugin entries refuse before creating or changing any managed file", () => {
  for (const [fileIndex, contents] of [[0, JSON.stringify({ name: "agent-hub", description: "owned by a person" })], [1, JSON.stringify({ mcpServers: { "agent-hub": { command: "foreign" } } })], [2, JSON.stringify({ "agent-hub": { SessionStart: [] } })]] as const) {
    const root = project(), dir = plugin(root);
    mkdirSync(dir, { recursive: true });
    const file = paths(root)[fileIndex]!;
    writeFileSync(file, contents);
    expect(() => ensureAgyMcp(options(root))).toThrow();
    expect(readdirSync(dir)).toEqual([basename(file)]);
    expect(readFileSync(file, "utf8")).toBe(contents);
  }
});

test("malformed managed JSON refuses before creating sibling plugin files", () => {
  for (let fileIndex = 0; fileIndex < 3; fileIndex++) {
    const root = project(), dir = plugin(root), file = paths(root)[fileIndex]!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{malformed\n");
    expect(() => ensureAgyMcp(options(root))).toThrow("invalid JSON");
    expect(readdirSync(dir)).toEqual([basename(file)]);
    expect(readFileSync(file, "utf8")).toBe("{malformed\n");
  }
});

test("symlinked plugin parent directories refuse without writing through the link", () => {
  for (const segment of [".agents", ".agents/plugins", ".agents/plugins/agent-hub"]) {
    const root = project(), outside = join(root, "outside");
    mkdirSync(outside);
    const target = join(outside, segment.split("/").at(-1)!);
    mkdirSync(target);
    const parentPath = join(root, segment);
    if (segment.includes("/")) mkdirSync(join(root, segment.slice(0, segment.lastIndexOf("/"))), { recursive: true });
    symlinkSync(target, parentPath, "dir");
    expect(() => ensureAgyMcp(options(root))).toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(paths(root).some(existsSync)).toBe(false);
  }
});

test("symlinked or hardlinked managed files are refused without modifying their targets", () => {
  for (let fileIndex = 0; fileIndex < 3; fileIndex++) {
    for (const kind of ["symlink", "hardlink"] as const) {
      const root = project(), dir = plugin(root), target = join(root, "foreign.json"), file = paths(root)[fileIndex]!;
      mkdirSync(dir, { recursive: true }); writeFileSync(target, "foreign bytes\n");
      if (kind === "symlink") symlinkSync(target, file); else linkSync(target, file);
      expect(() => ensureAgyMcp(options(root))).toThrow();
      expect(readFileSync(target, "utf8")).toBe("foreign bytes\n");
      expect(readdirSync(dir)).toEqual([basename(file)]);
    }
  }
});
