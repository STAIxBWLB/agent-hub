import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcodeExtraMcpServers, splitJcodeMcpServers } from "../src/adapters/definitions/native-cli-jcode-mcp.ts";
import { nativeDoctorOptionalProbes } from "../src/adapters/definitions/native-cli-doctor.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { ALL_MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { TIER3_INSTANCE_FIELDS } from "../src/hub/config-tier.ts";
import { hubGitSync } from "../src/hub/git.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-jcode-inventory-")); dirs.push(dir); return dir; };
const write = (file: string, value: unknown) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };

test("the doctor lists the extra MCP servers jcode would load from its own config paths only, never a value (#572 AC4)", () => {
  const project = root(), home = root();
  write(join(home, "mcp.json"), { mcpServers: { "kimi-cu": { command: "SECRET-COMMAND", env: { TOKEN: "SECRET-TOKEN" } }, mcpvault: { command: "x" } } });
  write(join(project, ".jcode", "mcp.json"), { servers: { "agent-hub-jcode": { command: "bun" }, "project-extra": { url: "https://SECRET-HOST/mcp" } } });
  write(join(project, ".mcp.json"), { mcpServers: { "claude-layer": {} } });
  write(join(project, ".claude", "mcp.json"), { mcpServers: { "claude-dir-layer": {} } });
  // Not read: a file outside the three config locations, even one that names servers.
  write(join(home, "other", "mcp.json"), { mcpServers: { "never-read": {} } });
  const found = jcodeExtraMcpServers(project, home);
  expect(found.servers).toEqual(["claude-dir-layer", "claude-layer", "kimi-cu", "mcpvault", "project-extra"]);
  expect(found.unreadable).toEqual([]);
  expect(JSON.stringify(found)).not.toContain("SECRET");
  expect(found.servers).not.toContain("agent-hub-jcode");
});

test("an absent, invalid, linked or oversized MCP file is reported by name only, never followed or echoed (#572 AC4)", () => {
  const project = root(), home = root();
  expect(jcodeExtraMcpServers(project, home)).toEqual({ servers: [], unreadable: [] });
  write(join(home, "mcp.json"), "{ not json SECRET");
  const target = join(root(), "real.json"); write(target, { mcpServers: { linked: {} } });
  mkdirSync(join(project, ".jcode")); symlinkSync(target, join(project, ".jcode", "mcp.json"));
  write(join(project, ".mcp.json"), "x".repeat(300 * 1024));
  const found = jcodeExtraMcpServers(project, home);
  expect(found.servers).toEqual([]);
  expect(found.unreadable.sort()).toEqual([".jcode/mcp.json", ".mcp.json", "mcp.json (JCODE_HOME)"]);
  expect(JSON.stringify(found)).not.toContain("SECRET"); expect(JSON.stringify(found)).not.toContain("linked");
});

test("the doctor plan carries the jcode home so the host can list the extras, and only when jcode is on the roster (#572 AC4)", () => {
  const config = { jcode_cmd: ["jcode"], qwen_cmd: ["qwen"], jcode_home: "/native/home" };
  expect(nativeDoctorOptionalProbes({ roster: { jcode: true }, ...config }).find(probe => probe.kind === "jcode-mcp")).toEqual({ kind: "jcode-mcp", name: "jcode MCP servers", home: "/native/home" });
  expect(nativeDoctorOptionalProbes({ roster: {}, ...config }).some(probe => probe.kind === "jcode-mcp")).toBe(false);
});

test("a linked .jcode or .claude directory is never entered, so an outside file's server names stay unread (#572 AC4, review I3)", () => {
  for (const parent of [".jcode", ".claude"]) {
    const project = root(), home = root(), outside = root();
    write(join(outside, "mcp.json"), { mcpServers: { "outside-leak": {} } });
    symlinkSync(outside, join(project, parent));
    const found = jcodeExtraMcpServers(project, home);
    expect(found.servers).toEqual([]);
    expect(found.unreadable).toEqual([parent === ".jcode" ? ".jcode/mcp.json" : ".claude/mcp.json"]);
    expect(JSON.stringify(found)).not.toContain("outside-leak");
  }
});

test("a linked JCODE_HOME or a linked ancestor above the trusted project root is a system alias and stays readable (#572 AC4, review I3)", () => {
  const real = root(), alias = join(root(), "alias");
  write(join(real, "project", ".mcp.json"), { mcpServers: { "via-alias": {} } });
  symlinkSync(real, alias);
  // The project root and home are the hub's own configured paths: links above or at them are legitimate aliases (macOS /var).
  expect(jcodeExtraMcpServers(join(alias, "project"), root()).servers).toEqual(["via-alias"]);
  const home = root(), homeAlias = join(root(), "home-alias");
  write(join(home, "mcp.json"), { mcpServers: { "home-via-alias": {} } });
  symlinkSync(home, homeAlias);
  expect(jcodeExtraMcpServers(root(), homeAlias).servers).toEqual(["home-via-alias"]);
});

test("the allowlist splits the extras by name: all allowed passes, one outsider is the only refusal, no key changes nothing (#1621 AC1)", () => {
  const project = root(), home = root();
  write(join(home, "mcp.json"), { mcpServers: { amem: { command: "SECRET" }, vmem: {}, ares: {} } });
  const all = jcodeExtraMcpServers(project, home).servers;
  expect(splitJcodeMcpServers(all, ["amem", "ares", "vmem"])).toEqual({ allowed: ["amem", "ares", "vmem"], refused: [] });
  write(join(project, ".mcp.json"), { mcpServers: { "computer-use": {} } });
  const more = jcodeExtraMcpServers(project, home).servers;
  expect(splitJcodeMcpServers(more, ["amem", "ares", "vmem"])).toEqual({ allowed: ["amem", "ares", "vmem"], refused: ["computer-use"] });
  expect(splitJcodeMcpServers(more, [])).toEqual({ allowed: [], refused: more });
});

test("the doctor plan passes the top-level allowlist, and an instance's own list or the inherited one (#1621)", () => {
  const config = { jcode_cmd: ["jcode"], qwen_cmd: ["qwen"], jcode_home: "/native/home", jcode_mcp_allow: ["amem"],
    instances: { a: { kind: "jcode", jcode_home: "/h/a" }, b: { kind: "jcode", jcode_home: "/h/b", jcode_mcp_allow: ["vmem"] } } };
  const probes = nativeDoctorOptionalProbes({ roster: { jcode: true, a: true, b: true }, ...config }).filter(probe => probe.kind === "jcode-mcp");
  expect(probes.map(probe => probe.kind === "jcode-mcp" ? probe.allow : null)).toEqual([["amem"], ["amem"], ["vmem"]]);
});

test("jcode_mcp_allow is machine-local: tracked or shared config is ignored, a bad value is a config error (#1621 AC2)", () => {
  const dir = root();
  expect(hubGitSync(["init", "-q"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  write(join(dir, ".agenthub", "config.json"), { jcode_mcp_allow: ["amem"] });
  expect(hubGitSync(["add", "-f", ".agenthub/config.json"], { cwd: dir, encoding: "utf8" }).status).toBe(0);
  expect(loadConfig(dir).jcode_mcp_allow).toBeUndefined();
  expect(loadConfig(dir).ignored?.join(" ")).toContain("jcode_mcp_allow");
  write(join(dir, ".agenthub", "config.local.json"), { jcode_mcp_allow: ["amem", "vmem"] });
  expect(loadConfig(dir).jcode_mcp_allow).toEqual(["amem", "vmem"]);
  expect(DEFAULT_CONFIG.jcode_mcp_allow).toBeUndefined();
  expect(ALL_MACHINE_LOCAL).toContain("jcode_mcp_allow");
  expect(TIER3_INSTANCE_FIELDS).toContain("jcode_mcp_allow");
  for (const bad of ["amem", [""], ["amem", 1], [" "]]) {
    write(join(dir, ".agenthub", "config.local.json"), { jcode_mcp_allow: bad });
    expect(() => loadConfig(dir)).toThrow(/jcode_mcp_allow/);
  }
});
