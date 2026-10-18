// Stand-in for `claude -p` (#223): records its argv and prompt, then acts as the reviewer through the hub's tools role.
import { appendFileSync } from "node:fs";
import { ControlClient } from "../../src/hub/control-client.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = await new Response(Bun.stdin.stream()).text();
const log = process.env.FAKE_CLAUDE_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv, prompt, peer: process.env.AGENTHUB_PEER_ID }) + "\n");
const action = process.env.FAKE_CLAUDE_ACTION ?? "approve";
if (action === "hang") await new Promise(() => {});
if (action === "approve") {
  const server = (JSON.parse(flag("--mcp-config") ?? "{}") as { mcpServers?: Record<string, { env?: Record<string, string> }> }).mcpServers?.["agent-hub"]?.env ?? {};
  const task = Number(/Review task #(\d+)/.exec(prompt)?.[1]);
  const hub = await ControlClient.connect(server.AGENTHUB_STATE_DIR!, { role: "tools", peer: server.AGENTHUB_PEER_ID! });
  const res = await hub.request({ t: "task", op: "hub_review", args: { id: task, verdict: "approved", note: "fresh review" } });
  if (log) appendFileSync(log, JSON.stringify({ review: res }) + "\n");
  hub.close();
}
console.log(JSON.stringify({ type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 5 } }));
