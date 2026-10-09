import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factsHook } from "../src/cli/facts-hook.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";

test("Claude permission hook fixtures preserve facts and delegate shell decisions unless never-ask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-permission-hook-"));
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
      const result = await factsHook(JSON.stringify({ hook_event_name: phase, tool_name: tool, tool_input: {} }), dir, "claude", timeoutMs);
      return result ? JSON.parse(result).hookSpecificOutput : undefined;
    };
    for (const mode of ["ask", "ask-when-needed", "never-ask"]) {
      reply = { ok: true, permission: mode };
      for (const tool of ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "Bash", "WebFetch", "mcp__example__edit"]) {
        const expected = mode === "never-ask" || mode === "ask-when-needed" && !["Bash", "WebFetch", "mcp__example__edit"].includes(tool);
        expect((await run(tool))?.permissionDecision).toBe(expected ? "allow" : undefined);
      }
      reply = { ok: true, permission: mode, text: "other peer changed file.ts" };
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
