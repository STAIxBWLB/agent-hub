import { expect, test } from "bun:test";
import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsHook, projectFileTool, scopedWriteBlocked, nativeHookIdentity } from "../src/cli/facts-hook.ts";
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
    // Another name for a protected file, and a look-alike a case-insensitive disk opens as the real name.
    linkSync(join(dir, ".claude", "config"), join(dir, "notes.ts"));
    for (const file of ["notes.ts", ".mcp.j\u017Fon", ".\u212Aimi/config"]) expect(projectFileTool("Edit", { file_path: file }, dir)).toBe(false);
    for (const directory of [".codex", ".qwen", ".kimi", ".kimi-code", ".pi"]) {
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
    for (const name of [".CODEX", ".QWEN", ".KIMI", ".KIMI-CODE", ".PI"]) {
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

test("instruction protection removes write grants under both spellings but keeps reads and the default (#323)", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-instruction-hook-"));
  try {
    for (const name of ["AGENTS.md", "CLAUDE.md", "QWEN.md", "agents.md", "ＡＧＥＮＴＳ.md"]) {
      writeFileSync(join(root, name), "before");
      for (const tool of ["Write", "Edit", "MultiEdit"]) {
        expect(projectFileTool(tool, { file_path: name }, root)).toBe(true);
        expect(projectFileTool(tool, { file_path: name }, root, true)).toBe(false);
      }
      expect(projectFileTool("Read", { file_path: name }, root, true)).toBe(true);
    }
    writeFileSync(join(root, "ordinary.txt"), "before");
    mkdirSync(join(root, "nested"));
    symlinkSync(join(root, "ordinary.txt"), join(root, "nested", "AGENTS.md"));
    symlinkSync(join(root, "CLAUDE.md"), join(root, "alias.txt"));
    for (const file_path of ["nested/AGENTS.md", "alias.txt"]) expect(projectFileTool("Write", { file_path }, root, true)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("expensive scoped file policy is evaluated only for a usable PreToolUse write grant (#259)", () => {
  let evaluated = 0;
  const lookup = () => { evaluated++; return false; };
  for (const phase of ["session", "start", "post", "stop"]) for (const mode of [undefined, "ask", "ask-when-needed", "never-ask"]) {
    expect(scopedWriteBlocked(phase, mode, "Write", lookup)).toBe(false);
  }
  for (const mode of [undefined, "unknown", "ask", "never-ask"]) expect(scopedWriteBlocked("pre", mode, "Write", lookup)).toBe(false);
  for (const tool of ["Read", "Glob", "Grep", "Bash", "mcp__example__edit"]) expect(scopedWriteBlocked("pre", "ask-when-needed", tool, lookup)).toBe(false);
  expect(evaluated).toBe(0);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(scopedWriteBlocked("pre", "ask-when-needed", tool, lookup)).toBe(true);
  expect(evaluated).toBe(4);
  expect(scopedWriteBlocked("pre", "ask-when-needed", "Write", () => true)).toBe(false);
});

test("native envelope size cap preserves existing large Claude permission, facts and post-effect hooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-large-claude-hook-"));
  writeFileSync(join(dir, "file.ts"), "fixture");
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 400 }); }, websocket: {
    message(ws, raw) {
      const msg = JSON.parse(String(raw));
      if (msg.t === "hello") { expect(msg.token).toBe("fixture-token"); ws.send(JSON.stringify({ t: "welcome", rid: msg.rid })); }
      else { requests.push(msg); ws.send(JSON.stringify({ ok: true, permission: "ask-when-needed", projectRoot: dir, text: "fixture fact", rid: msg.rid })); }
    },
  } });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(dir, "control-token"), "fixture-token");
  try {
    const input = { file_path: join(dir, "file.ts"), content: "x".repeat(1024 * 1024 + 1) };
    const pre = await factsHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: input }), dir, "claude");
    expect(pre).toBeDefined();
    expect(JSON.parse(pre!).hookSpecificOutput).toMatchObject({ permissionDecision: "allow", additionalContext: "fixture fact" });
    expect(requests.at(-1)).toMatchObject({ t: "facts", phase: "pre", tool: "Write" });
    expect(requests.at(-1).input.content).toBe(input.content);
    expect(await factsHook(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: input }), dir, "claude")).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)).toMatchObject({ t: "facts", phase: "post", tool: "Write" });
    expect(requests.at(-1).input.content).toBe(input.content);
  } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("a classed call (actionClasses from the hub) is `ask` in every permission mode, never allow, and keeps its facts text (#636)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-action-hook-"));
  let reply: Record<string, unknown> = { ok: true };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 400 }); }, websocket: {
    message(ws, raw) { const msg = JSON.parse(String(raw)); ws.send(JSON.stringify(msg.t === "hello" ? { t: "welcome", rid: msg.rid } : { ...reply, rid: msg.rid })); },
  } });
  writeFileSync(join(dir, "status.json"), JSON.stringify({ controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(dir, "control-token"), "fixture-token");
  const original = process.env.AGENTHUB_STATE_DIR;
  try {
    const run = async (tool = "Bash") => { const out = await factsHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command: "git push origin main" } }), dir, "claude"); return out ? JSON.parse(out).hookSpecificOutput : undefined; };
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      reply = { ok: true, projectRoot: dir, permission: mode, actionClasses: ["publish"] };
      const out = await run();
      expect(out.permissionDecision).toBe("ask");
      expect(out.permissionDecisionReason).toBe("agent-hub always-ask: publish");
      reply = { ok: true, projectRoot: dir, permission: mode, actionClasses: ["publish", "destroy"], text: "other peer changed main" };
      const withFacts = await run();
      expect(withFacts).toMatchObject({ permissionDecision: "ask", additionalContext: "other peer changed main", permissionDecisionReason: "agent-hub always-ask: publish, destroy" });
      reply = { ok: true, projectRoot: dir, permission: mode }; // not classed: the mode decides as before
      expect((await run())?.permissionDecision).toBe(mode === "never-ask" ? "allow" : undefined);
    }
    // an empty list is "not classed"; a value that is present but unreadable asks instead of falling back to an allow
    reply = { ok: true, projectRoot: dir, permission: "never-ask", actionClasses: [] }; expect((await run())?.permissionDecision).toBe("allow");
    for (const bad of ["publish", [1], null, {}]) { reply = { ok: true, projectRoot: dir, permission: "never-ask", actionClasses: bad }; const out = await run(); expect(out.permissionDecision).toBe("ask"); expect(out.permissionDecisionReason).toBe("agent-hub always-ask"); }
    reply = { ok: false, actionClasses: ["publish"] }; expect(await run()).toBeUndefined(); // a hub that cannot answer leaves the native policy
  } finally { if (original === undefined) delete process.env.AGENTHUB_STATE_DIR; server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
