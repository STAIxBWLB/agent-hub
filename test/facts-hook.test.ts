import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsHook, projectFileTool, nativeHookIdentity } from "../src/cli/facts-hook.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

test("Claude permission hook fixtures preserve facts and delegate shell decisions unless never-ask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-permission-hook-"));
  writeFileSync(join(dir, "file.ts"), "fixture");
  let reply: Record<string, unknown> | undefined = { ok: true };
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 400 }); }, websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") { expect(msg.token).toBe("fixture-token"); ws.send(JSON.stringify({ t: "welcome", rid: msg.rid })); }
      else { requests.push(msg); if (reply) ws.send(JSON.stringify({ ...reply, rid: msg.rid })); }
    },
  } });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(dir, "control-token"), "fixture-token");
  try {
    const run = async (tool: string, phase = "PreToolUse", timeoutMs = 2000) => {
      const result = await factsHook(JSON.stringify({ hook_event_name: phase, tool_name: tool, tool_input: { file_path: join(dir, "file.ts"), notebook_path: join(dir, "file.ts"), path: dir, pattern: "file.ts" } }), dir, "claude", timeoutMs);
      return result ? JSON.parse(result).hookSpecificOutput : undefined;
    };
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      reply = { ok: true, projectRoot: dir, permission: mode };
      for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "Bash", "WebFetch", "mcp__example__edit"]) {
        const expected = mode === "never-ask" || mode === "ask-when-needed" && !["Bash", "WebFetch", "mcp__example__edit"].includes(tool);
        expect((await run(tool))?.permissionDecision).toBe(expected ? "allow" : undefined);
      }
      reply = { ok: true, projectRoot: dir, permission: mode, text: "other peer changed file.ts" };
      const withFacts = await run("Read"); expect(withFacts.additionalContext).toBe("other peer changed file.ts");
      expect(withFacts.permissionDecision).toBe(mode === "ask" ? undefined : "allow");
      expect(await run("Read", "PostToolUse")).toBeUndefined();
    }
    reply = { ok: false, permission: "never-ask" }; expect(await run("Bash")).toBeUndefined();
    reply = { ok: true, permission: "unknown" }; expect(await run("Bash")).toBeUndefined();
    reply = undefined; expect(await run("Bash", "PreToolUse", 20)).toBeUndefined();
    expect(requests.every(r => r.t === "facts")).toBe(true);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});


test("ask-when-needed file grants stay within canonical project paths and exclude native configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-file-grants-")), outside = mkdtempSync(join(tmpdir(), "ahub-outside-grants-"));
  try {
    writeFileSync(join(dir, "file.ts"), "fixture"); writeFileSync(join(outside, "outside.ts"), "fixture");
    for (const name of [".agenthub", ".git", ".claude", ".GIT"]) { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "config"), "fixture"); }
    symlinkSync(outside, join(dir, "escape")); symlinkSync(join(dir, ".agenthub"), join(dir, "alias"));
    for (const tool of ["Read", "Write", "Edit", "MultiEdit"]) {
      expect(projectFileTool(tool, { file_path: "file.ts" }, dir)).toBe(true);
      for (const file of [join(outside, "outside.ts"), "../outside.ts", "missing.ts", "escape/outside.ts", "alias/config", ".git/config", ".GIT/config", ".claude/config", ".agenthub/config"]) expect(projectFileTool(tool, { file_path: file }, dir)).toBe(false);
      expect(projectFileTool(tool, {}, dir)).toBe(false);
    }
    for (const directory of [".codex", ".qwen", ".kimi", ".pi"]) {
      mkdirSync(join(dir, directory)); writeFileSync(join(dir, directory, "settings.json"), "fixture");
      symlinkSync(join(dir, directory), join(dir, `alias-${directory.slice(1)}`));
      for (const path of [`${directory}/settings.json`, `alias-${directory.slice(1)}/settings.json`]) {
        expect(projectFileTool("Write", { file_path: path }, dir)).toBe(false);
        expect(projectFileTool("Grep", { glob: path }, dir)).toBe(false);
      }
    }
    writeFileSync(join(dir, ".mcp.json"), "fixture"); symlinkSync(join(dir, ".mcp.json"), join(dir, "alias-mcp.json"));
    for (const path of [".mcp.json", "alias-mcp.json"]) {
      expect(projectFileTool("Edit", { file_path: path }, dir)).toBe(false);
      expect(projectFileTool("Glob", { pattern: path }, dir)).toBe(false);
    }
    for (const name of [".CODEX", ".QWEN", ".KIMI", ".PI"]) {
      mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "config"), "fixture");
      expect(projectFileTool("Read", { file_path: `${name}/config` }, dir)).toBe(false);
    }
    writeFileSync(join(dir, ".MCP.JSON"), "fixture"); expect(projectFileTool("Read", { file_path: ".MCP.JSON" }, dir)).toBe(false);
    expect(projectFileTool("NotebookEdit", { notebook_path: "file.ts" }, dir)).toBe(true);
    expect(projectFileTool("NotebookEdit", { notebook_path: "escape/outside.ts" }, dir)).toBe(false);
    expect(projectFileTool("LS", { path: dir }, dir)).toBe(true); expect(projectFileTool("LS", {}, dir)).toBe(false);
    expect(projectFileTool("Glob", { pattern: "file.ts" }, dir)).toBe(true);
    expect(projectFileTool("Glob", { pattern: "*.ts" }, dir)).toBe(false);
    expect(projectFileTool("Glob", { pattern: "**/outside.ts" }, dir)).toBe(false);
    for (const pattern of ["../*", join(outside, "*.ts"), ".git/*", ".GIT/*", ".claude/*", "escape/*", "alias/*"]) expect(projectFileTool("Glob", { pattern }, dir)).toBe(false);
    expect(projectFileTool("Grep", { pattern: "some regex" }, dir)).toBe(true);
    expect(projectFileTool("Grep", { path: outside, pattern: "some regex" }, dir)).toBe(false);
    expect(projectFileTool("Grep", { pattern: "some regex", glob: "file.ts" }, dir)).toBe(true);
    for (const glob of [".agenthub/**", ".git/**", ".GIT/**", ".claude/**", "../*", join(outside, "outside.ts"), "escape/outside.ts", "alias/config", "*.ts", "**/*.ts", "missing.ts"]) {
      expect(projectFileTool("Grep", { pattern: "some regex", glob }, dir)).toBe(false);
    }
    expect(projectFileTool("Grep", { pattern: "some regex", glob: null }, dir)).toBe(false);
    expect(projectFileTool("Read", { file_path: "file.ts" }, undefined)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("hook purpose is forwarded only with a matching native target and valid purpose", () => {
  const env = { AGENTHUB_STATE_DIR: "/fixture", AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: "i", AGENTHUB_LAUNCH_ID: "l", AGENTHUB_HOOK_PURPOSE: "permission" };
  expect(nativeHookIdentity("/fixture", "claude", env)).toMatchObject({ hookPurpose: "permission" });
  expect(nativeHookIdentity("/other", "claude", env)).toEqual({});
  expect(nativeHookIdentity("/fixture", "codex", env)).toEqual({});
  expect(nativeHookIdentity("/fixture", "claude", { ...env, AGENTHUB_HOOK_PURPOSE: "invalid" })).not.toHaveProperty("hookPurpose");
});
