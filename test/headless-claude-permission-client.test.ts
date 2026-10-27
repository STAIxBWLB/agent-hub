import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";

async function client(permission: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ahub-print-permission-client-"));
  const requests: Record<string, any>[] = [], replies = new Map<number, (value: any) => void>();
  let sequence = 0, diagnostics = "", mode: "allow" | "wrapper" | "bad-wrapper" | "future-wrapper" | "deny" | "error" | "disconnect" = "allow";
  const daemon = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response("websocket only", { status: 400 }); },
    websocket: { message(ws, data) {
      const message = JSON.parse(String(data)); requests.push(message);
      if (message.t === "hello") return void ws.send(JSON.stringify({ t: "welcome", rid: message.rid, ok: true, projectId: "permission-fixture", instanceId: "permission-instance", cwd: root }));
      if (message.t === "permission_request") {
        if (mode === "disconnect") return void ws.close(4401, "fixture disconnected");
        return void ws.send(JSON.stringify({ t: message.t, rid: message.rid,
          ...(mode === "wrapper" || mode === "bad-wrapper" || mode === "future-wrapper" ? { ok: true, behavior: "allow", wrapperProtocol: mode === "future-wrapper" ? 2 : 1, updatedInput: mode !== "bad-wrapper" ? { command: "fixed-wrapper single-use-ticket", description: "Hub-owned task command", timeout: 1000 } : null }
            : mode === "allow" ? { ok: true, behavior: "allow", updatedInput: { command: "daemon must not replace native input" } } : mode === "deny" ? { ok: true, behavior: "deny", message: "person denied" } : { ok: false, behavior: "allow", message: "approval unavailable" }) }));
      }
      ws.send(JSON.stringify({ t: message.t, rid: message.rid, ok: true,
        ...(message.t === "inbox" ? { envs: [], waiting: 0, waitingImportant: 0 } : message.t === "status" ? { status: {} } : {}) }));
    } },
  });
  writeFileSync(join(root, "status.json"), JSON.stringify({ protocol: PROTOCOL, controlPort: daemon.port, projectId: "permission-fixture", instanceId: "permission-instance", cwd: root }));
  writeFileSync(join(root, "control-token"), "fixture-token");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_STATE_DIR: root, AGENTHUB_PROJECT_DIR: root, AGENTHUB_PEER_ID: "claude", AGENTHUB_MODE: "tools" };
  for (const key of ["AGENTHUB_CHANNEL", "AGENTHUB_DELIVERY_ONLY", "AGENTHUB_PERMISSION_TOOL", "AGENTHUB_LAUNCH_ID", "AGENTHUB_INSTANCE_ID"]) delete env[key];
  if (permission) env.AGENTHUB_PERMISSION_TOOL = "1";
  // Run the source MCP server, never a stale generated bundle or a real native Claude process.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/adapters/claude-channel.ts")], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stderr = (async () => { for await (const chunk of child.stderr) diagnostics = (diagnostics + Buffer.from(chunk).toString()).slice(-16384); })();
  const stdout = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += Buffer.from(chunk).toString();
      for (let end; (end = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const value = JSON.parse(line), receive = replies.get(value.id);
        if (receive) { replies.delete(value.id); receive(value); }
      }
    }
  })();
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { replies.delete(id); reject(new Error(`MCP ${method} timed out: ${diagnostics}`)); }, 3000);
    replies.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  const close = async () => {
    child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    await child.exited; clearTimeout(timer); await Promise.all([stdout, stderr]); daemon.stop(true); rmSync(root, { recursive: true, force: true });
  };
  try {
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "permission-client-test", version: "1" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (let n = 0; n < 300 && !diagnostics.includes('connected to hub as "claude"'); n++) await Bun.sleep(5);
    expect(diagnostics).toContain('connected to hub as "claude"');
    return { rpc, requests, close, mode(value: typeof mode) { mode = value; },
      call: (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args }) };
  } catch (error) { await close(); throw error; }
}
const decision = (result: any) => JSON.parse(result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"));
const request = { tool_name: "Bash", input: { command: "printf 'exact input'", timeout: 1000, nested: { preserve: true } }, tool_use_id: "native-tool-call-17" };

test("#525 headless permission MCP exposes prompt and inbox, and person allow preserves the original native input without a hook receipt", async () => {
  const f = await client(true);
  try {
    const list = await f.rpc("tools/list"), names = list.tools.map((tool: any) => tool.name);
    expect(names).toContain("hub_permission_request"); expect(names).toContain("hub_inbox");
    expect(names).not.toContain("hub_review"); expect(names).not.toContain("hub_task_assign");
    expect((await f.call("hub_review", { id: 1, verdict: "approved" })).isError).toBe(true);
    const schema = list.tools.find((tool: any) => tool.name === "hub_permission_request").inputSchema;
    expect(schema.required).toEqual(["tool_name", "input", "tool_use_id"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["input", "tool_name", "tool_use_id"]); expect(schema.additionalProperties).toBe(false);
    expect(decision(await f.call("hub_permission_request", request))).toEqual({ behavior: "allow", updatedInput: request.input });
    expect(f.requests.filter(row => row.t === "permission_request")).toEqual([expect.objectContaining({ tool: request.tool_name, input: request.input })]);
    expect(f.requests.some(row => ["facts", "native_facts", "native_hook_launch"].includes(row.t))).toBe(false);
    await f.call("hub_inbox"); expect(f.requests.filter(row => row.t === "inbox")).toHaveLength(1);
  } finally { await f.close(); }
});

for (const mode of ["deny", "error", "disconnect"] as const) test(`#525 headless permission MCP ${mode} fails closed`, async () => {
  const f = await client(true);
  try {
    f.mode(mode);
    const result = decision(await f.call("hub_permission_request", request));
    expect(result.behavior).toBe("deny"); expect(result.updatedInput).toBeUndefined(); expect(typeof result.message).toBe("string");
    expect(f.requests.filter(row => row.t === "permission_request")).toHaveLength(1);
  } finally { await f.close(); }
});

test("#525 ordinary tools mode cannot expose or call the native permission prompt", async () => {
  const f = await client(false);
  try {
    const list = await f.rpc("tools/list"); expect(list.tools.some((tool: any) => tool.name === "hub_permission_request")).toBe(false);
    expect(decision(await f.call("hub_permission_request", request)).behavior).toBe("deny");
    expect(f.requests.filter(row => row.t === "permission_request")).toHaveLength(0);
  } finally { await f.close(); }
});

test("#845 the fixed wrapper protocol passes only host replacement input; malformed or non-Bash replacements deny", async () => {
  const f = await client(true);
  try {
    f.mode("wrapper");
    expect(decision(await f.call("hub_permission_request", request))).toEqual({ behavior: "allow", updatedInput: { command: "fixed-wrapper single-use-ticket", description: "Hub-owned task command", timeout: 1000 } });
    expect(f.requests.find(row => row.t === "permission_request")?.wrapperProtocol).toBe(1);
    expect(decision(await f.call("hub_permission_request", { ...request, tool_name: "Write" })).behavior).toBe("deny");
    f.mode("bad-wrapper");
    expect(decision(await f.call("hub_permission_request", request)).behavior).toBe("deny");
    f.mode("future-wrapper");
    expect(decision(await f.call("hub_permission_request", request)).behavior).toBe("deny");
  } finally { await f.close(); }
});


test("#525 malformed native permission calls deny before reaching the daemon", async () => {
  const f = await client(true);
  try {
    for (const bad of [{ ...request, input: null }, { ...request, input: [] }, { ...request, tool_use_id: "" }, { ...request, tool_name: "spoof\nBash" }]) {
      expect(decision(await f.call("hub_permission_request", bad)).behavior).toBe("deny");
    }
    expect(f.requests.filter(row => row.t === "permission_request")).toEqual([]);
  } finally { await f.close(); }
});
