import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcodeExtraMcpServers } from "../src/adapters/definitions/native-cli-jcode-mcp.ts";
import { nativeDoctorOptionalProbes } from "../src/adapters/definitions/native-cli-doctor.ts";

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
