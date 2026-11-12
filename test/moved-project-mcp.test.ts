import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameDirectory, shownValue } from "../src/adapters/same-directory.ts";
import { configureJcodeMcp, JCODE_MCP_FILE, JCODE_MCP_NAME, jcodeMcpEntry, jcodeMcpReady } from "../src/adapters/definitions/native-cli-jcode-mcp.ts";
import { agyMcpReady, ensureAgyMcp, type AgyMcpOptions } from "../src/cli/agy-mcp.ts";
import { configureKimiMcp, kimiMcpPlan } from "../src/cli/kimi-mcp.ts";

// #1423: a project directory renamed with its old path left as a symlink must not make the hub's own project MCP entries read as foreign.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** A project at `<base>/new` that used to be `<base>/old` (now a symlink to it), as after `mv old new && ln -s new old`. */
function moved() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-moved-"))); roots.push(base);
  const current = join(base, "new"), old = join(base, "old");
  mkdirSync(current); symlinkSync(current, old);
  return { base, current, old };
}

test("sameDirectory: equal text, a symlinked old name and nothing else", () => {
  const { base, current, old } = moved();
  expect(sameDirectory(current, current)).toBe(true);
  expect(sameDirectory(old, current)).toBe(true);
  expect(sameDirectory(join(base, "gone"), current)).toBe(false);
  mkdirSync(join(base, "other"));
  expect(sameDirectory(join(base, "other"), current)).toBe(false);
  for (const bad of [undefined, null, 7, "", {}, [], "a\nb", "x".repeat(5000)]) expect(sameDirectory(bad, current)).toBe(false);
  expect(shownValue("/a/b")).toBe("/a/b");
  for (const bad of [undefined, 7, "", "a\nb", "x".repeat(201)]) expect(shownValue(bad)).toBeUndefined();
});

test("Jcode: the hub's own entry written before the move is recognised, rewritten with the new paths, and then ready", () => {
  const { current, old } = moved(), state = join(current, ".agenthub/state"), bundle = "/installed/server.js";
  mkdirSync(join(current, ".jcode"));
  writeFileSync(join(current, JCODE_MCP_FILE), JSON.stringify({ mcpServers: { keep: { command: "other" }, [JCODE_MCP_NAME]: jcodeMcpEntry(old, join(old, ".agenthub/state"), bundle) } }));
  expect(jcodeMcpReady(current, state, bundle)).toBe(false);
  expect(configureJcodeMcp(current, state, bundle).changed).toBe(true);
  const written = JSON.parse(readFileSync(join(current, JCODE_MCP_FILE), "utf8")).mcpServers;
  expect(written[JCODE_MCP_NAME].env).toMatchObject({ AGENTHUB_PROJECT_DIR: current, AGENTHUB_STATE_DIR: state });
  expect(written.keep).toEqual({ command: "other" });
  expect(jcodeMcpReady(current, state, bundle)).toBe(true);
});

test("Jcode: an entry for a different project, another peer or a missing old path is still foreign, and the refusal names the field and the remedy", () => {
  const { base, current } = moved(), state = join(current, ".agenthub/state"), file = join(current, JCODE_MCP_FILE);
  mkdirSync(join(current, ".jcode")); mkdirSync(join(base, "elsewhere"));
  const write = (entry: unknown) => writeFileSync(file, JSON.stringify({ mcpServers: { [JCODE_MCP_NAME]: entry } }));
  const base0 = jcodeMcpEntry(current, state, "/b");
  write(jcodeMcpEntry(join(base, "elsewhere"), state, "/b"));
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow(/foreign MCP entry \(AGENTHUB_PROJECT_DIR .*elsewhere is not this project/);
  write(jcodeMcpEntry(join(base, "deleted-old-name"), state, "/b"));
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow("remove the agent-hub-jcode key from .jcode/mcp.json and run ahub jcode again");
  write({ ...base0, env: { ...base0.env, AGENTHUB_PEER_ID: "codex" } });
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow("AGENTHUB_PEER_ID names another peer");
  write({ ...base0, env: { ...base0.env, AGENTHUB_MODE: "channel" } });
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow("AGENTHUB_MODE is not tools");
  write({ command: "foreign" });
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow("env is missing");
  write("text");
  expect(() => configureJcodeMcp(current, state, "/b")).toThrow("not an object");
  // A refusal changes nothing.
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers[JCODE_MCP_NAME]).toBe("text");
});

function agyOptions(root: string, state: string): AgyMcpOptions {
  return { projectRoot: root, stateDir: state, serverJs: "/installed/plugins/agent-hub/server.js", hookScript: "/installed/src/cli/facts-hook.ts", instanceId: "instance-a", launchId: "launch-a", peer: "agy" };
}

test("agy: a plugin written before the move (project and state under the old path) is the hub's own and is rewritten", () => {
  // What a rename really does: the plugin was written while the project lived at `old`, then the directory moved to `new` and `old` became a symlink to it.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-moved-agy-"))); roots.push(base);
  const old = join(base, "old"), current = join(base, "new");
  mkdirSync(join(old, ".agenthub/state"), { recursive: true });
  ensureAgyMcp(agyOptions(old, join(old, ".agenthub/state")));
  renameSync(old, current); symlinkSync(current, old);
  const after = agyOptions(current, join(current, ".agenthub/state"));
  expect(agyMcpReady(after)).toBe(false);
  expect(() => ensureAgyMcp(after)).not.toThrow();
  expect(agyMcpReady(after)).toBe(true);
  const mcp = JSON.parse(readFileSync(join(current, ".agents/plugins/agent-hub/mcp_config.json"), "utf8")).mcpServers["agent-hub"];
  expect(mcp.env).toMatchObject({ AGENTHUB_PROJECT_DIR: current, AGENTHUB_STATE_DIR: after.stateDir });
  expect(readFileSync(join(current, ".agents/plugins/agent-hub/hooks.json"), "utf8")).toContain(`AGENTHUB_PROJECT_DIR='${current}'`);
});

test("agy: an entry or hook for another project or state directory is still foreign, and the MCP refusal names the field", () => {
  const { base, current } = moved(), state = join(current, ".agenthub/state");
  mkdirSync(state, { recursive: true }); mkdirSync(join(base, "elsewhere/.agenthub/state"), { recursive: true });
  const mine = agyOptions(current, state);
  ensureAgyMcp(mine);
  const file = join(current, ".agents/plugins/agent-hub/mcp_config.json"), original = readFileSync(file, "utf8");
  const edit = (change: (env: Record<string, string>) => void) => { const doc = JSON.parse(original); change(doc.mcpServers["agent-hub"].env); writeFileSync(file, JSON.stringify(doc)); };
  edit(env => { env.AGENTHUB_PROJECT_DIR = join(base, "elsewhere"); });
  expect(() => ensureAgyMcp(mine)).toThrow(/foreign MCP entry \(AGENTHUB_PROJECT_DIR .*elsewhere is not this project/);
  edit(env => { env.AGENTHUB_STATE_DIR = join(base, "elsewhere/.agenthub/state"); });
  expect(() => ensureAgyMcp(mine)).toThrow(/AGENTHUB_STATE_DIR .* is not this hub's state directory/);
  edit(env => { env.AGENTHUB_PEER_ID = "codex"; });
  expect(() => ensureAgyMcp(mine)).toThrow("AGENTHUB_PEER_ID names another peer");
  writeFileSync(file, original);
  const hooks = join(current, ".agents/plugins/agent-hub/hooks.json"), text = readFileSync(hooks, "utf8");
  writeFileSync(hooks, text.replaceAll(`AGENTHUB_PROJECT_DIR='${current}'`, `AGENTHUB_PROJECT_DIR='${join(base, "elsewhere")}'`));
  expect(() => ensureAgyMcp(mine)).toThrow("foreign hooks entry");
  writeFileSync(hooks, text.replaceAll(`AGENTHUB_STATE_DIR='${state}'`, `AGENTHUB_STATE_DIR='${join(base, "elsewhere/.agenthub/state")}'`));
  expect(() => ensureAgyMcp(mine)).toThrow("foreign hooks entry");
});

test("Kimi has no ownership wall: its entry is rewritten unconditionally from the current paths, so a moved project needs no change", () => {
  const { current, old } = moved(), state = join(current, ".agenthub/state");
  mkdirSync(join(current, ".kimi-code"));
  writeFileSync(join(current, ".kimi-code/mcp.json"), JSON.stringify({ mcpServers: { "agent-hub": { command: "bun", args: ["run", "/b"], env: { AGENTHUB_PEER_ID: "kimi", AGENTHUB_STATE_DIR: join(old, ".agenthub/state"), AGENTHUB_PROJECT_DIR: old } }, keep: { command: "x" } } }));
  expect(configureKimiMcp(current, state, "/b", "tui").changed).toBe(true);
  const servers = JSON.parse(readFileSync(join(current, ".kimi-code/mcp.json"), "utf8")).mcpServers;
  expect(servers["agent-hub"].env).toMatchObject({ AGENTHUB_PROJECT_DIR: current, AGENTHUB_STATE_DIR: state });
  expect(servers.keep).toEqual({ command: "x" });
  expect(kimiMcpPlan(current, state, "/b", "tui").changed).toBe(false);
});
