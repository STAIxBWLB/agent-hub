import { afterEach, expect, test } from "bun:test";
import { createReviewerMcpSession } from "../src/adapters/reviewer-mcp.ts";

type RpcReply = { result?: { capabilities?: unknown; tools?: { name: string }[]; content?: unknown }; error?: unknown };
const json = async (response: Response) => await response.json() as RpcReply;
const sessions: { close(): void }[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); });
const tools = ["hub_review", "hub_task_show", "hub_task_accept"].map(name => ({ name, description: name,
  inputSchema: { type: "object" as const, properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false as const } }));
function fixture() {
  let active = true;
  const calls: unknown[] = [];
  const session = createReviewerMcpSession({ task: 7, current: () => active, tools,
    call: async (name, args) => { calls.push({ name, args }); return "fixture result"; } });
  sessions.push(session);
  const config = JSON.parse(session.config).mcpServers["agent-hub"];
  const rpc = (method: string, params?: unknown, options: { headers?: Record<string, string>; auth?: boolean } = {}) => fetch(config.url, {
    method: "POST", headers: { "content-type": "application/json", ...(options.auth === false ? {} : config.headers), ...options.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { session, config, rpc, calls, revoke: () => { active = false; } };
}

test("reviewer MCP exposes only two host tools without a control token or stdio launcher", async () => {
  const f = fixture();
  expect(f.config.command).toBeUndefined();
  expect(f.session.config).not.toContain("control-token");
  expect((await json(await f.rpc("initialize"))).result?.capabilities).toEqual({ tools: {} });
  const listed = await json(await f.rpc("tools/list"));
  expect(listed.result?.tools?.map((tool: { name: string }) => tool.name)).toEqual(["hub_review", "hub_task_show"]);
  expect(f.calls).toEqual([]);
});

test("reviewer MCP refuses browsers and missing or wrong per-session authority", async () => {
  const f = fixture();
  expect((await f.rpc("tools/list", undefined, { headers: { Origin: "https://example.test" } })).status).toBe(403);
  expect((await f.rpc("tools/list", undefined, { auth: false })).status).toBe(401);
  expect((await f.rpc("tools/list", undefined, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  const other = fixture();
  expect((await fetch(f.config.url, { method: "POST", headers: other.config.headers, body: JSON.stringify({ id: 1, method: "tools/list" }) })).status).toBe(401);
  expect(f.calls).toEqual([]);
});

test("reviewer MCP bounds and normalizes string arguments while enforcing the task and tool", async () => {
  const f = fixture();
  const good = await json(await f.rpc("tools/call", { name: "hub_task_show", arguments: '{"id":7}' }));
  expect(good.result?.content).toEqual([{ type: "text", text: "fixture result" }]);
  for (const params of [
    { name: "hub_task_accept", arguments: { id: 7 } },
    { name: "hub_review", arguments: { id: 8, verdict: "approved" } },
    { name: "hub_task_show", arguments: '{"id":7' },
    { name: "hub_task_show", arguments: [] },
    { name: "hub_task_show", arguments: { id: "7" } },
  ]) expect((await json(await f.rpc("tools/call", params))).error).toBeDefined();
  expect(f.calls).toEqual([{ name: "hub_task_show", args: { id: 7 } }]);
});

test("reviewer MCP revokes the running-child capability for reads and verdicts", async () => {
  const f = fixture();
  f.revoke();
  for (const method of ["tools/list", "tools/call"]) {
    const result = await json(await f.rpc(method, { name: "hub_review", arguments: { id: 7, verdict: "approved" } }));
    expect(result.error).toBeDefined();
  }
  expect(f.calls).toEqual([]);
});

test("reviewer MCP refuses oversized bodies before any host call", async () => {
  const f = fixture();
  const response = await fetch(f.config.url, { method: "POST", headers: { ...f.config.headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hub_review", arguments: { id: 7, note: "x".repeat(262_144) } } }) });
  expect(response.status).toBe(413);
  expect(f.calls).toEqual([]);
});


test("task MCP cannot expose ambient resources, prompts or arbitrary methods", async () => {
  const f = fixture();
  for (const method of ["resources/list", "resources/read", "prompts/list", "prompts/get", "hub_task_accept"]) {
    expect((await json(await f.rpc(method, { uri: "fixture://ambient-secret" }))).error).toBeDefined();
  }
  expect(f.calls).toEqual([]);
});
