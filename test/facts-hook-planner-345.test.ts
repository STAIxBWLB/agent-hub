import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsHook } from "../src/cli/facts-hook.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

test("#345 a planner mutation ceiling keeps facts/read grants but never auto-allows a mutation in any permission mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-planner-hook-"));
  let response: Record<string, unknown> = {};
  writeFileSync(join(root, "file.ts"), "fixture\n");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: { message(ws, raw) { const request = JSON.parse(String(raw)); ws.send(JSON.stringify(request.t === "hello" ? { t: "welcome", rid: request.rid } : { ...response, rid: request.rid })); } },
  });
  writeFileSync(join(root, "status.json"), JSON.stringify({ protocol: PROTOCOL, controlPort: server.port }));
  writeFileSync(join(root, "control-token"), "fixture-token");
  const run = async (tool: string, peer = "claude-plan") => {
    const result = await factsHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool,
      tool_input: { file_path: join(root, "file.ts"), notebook_path: join(root, "file.ts"), path: root, pattern: "file.ts", command: "touch file.ts" } }), root, peer);
    return result ? JSON.parse(result).hookSpecificOutput : undefined;
  };
  try {
    for (const permission of ["ask", "ask-when-needed", "never-ask"]) {
      response = { ok: true, projectRoot: root, permission, mutationGrants: false, text: "other peer changed file.ts" };
      for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "mcp__fixture__write", "unknown"]) {
        const output = await run(tool);
        expect(output.additionalContext).toBe("other peer changed file.ts");
        expect(output.permissionDecision).toBeUndefined();
      }
      for (const tool of ["Read", "LS", "Glob", "Grep"]) expect((await run(tool)).permissionDecision).toBe(permission === "ask" ? undefined : "allow");
    }
    for (const mutationGrants of [null, "true", 1, {}]) {
      response = { ok: true, projectRoot: root, permission: "never-ask", mutationGrants };
      expect(await run("Write")).toBeUndefined();
    }
    response = { ok: true, projectRoot: root, permission: "never-ask" };
    expect((await run("Write", "claude")).permissionDecision).toBe("allow");
    response = { ...response, mutationGrants: false, actionClasses: ["publish"], text: "bounded fact" };
    expect(await run("Bash")).toMatchObject({ permissionDecision: "ask", additionalContext: "bounded fact" });
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
