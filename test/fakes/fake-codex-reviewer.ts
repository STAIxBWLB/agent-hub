// Fixture transport only: sandbox markers test host admission, never prove native Codex isolation.
import { appendFileSync } from "node:fs";
import { ControlClient } from "../../src/hub/control-client.ts";

const argv = process.argv.slice(2);
const override = argv.find(value => value.startsWith("mcp_servers="));
const servers = override ? (Bun.TOML.parse(override) as { mcp_servers: Record<string, Record<string, unknown>> }).mcp_servers : {};
if (argv[0] === "--version") console.log("codex-cli 0.146.0");
else if (argv[0] === "mcp" && argv[1] === "list") console.log(JSON.stringify(Object.entries(servers).map(([name, server]) => ({ name, enabled: server.enabled !== false, transport: { type: "stdio", command: server.command } }))));
else if (argv[0] === "mcp" && argv[1] === "get") {
  const server = servers["agent-hub"]!;
  console.log(JSON.stringify({ name: "agent-hub", enabled: true, enabled_tools: server.enabled_tools, transport: { type: "stdio", command: server.command, args: server.args, env: server.env } }));
} else if (argv[0] === "sandbox") console.log("AHUB_CODEX_PUBLIC_READ\nAHUB_CODEX_PRIVATE_DENIED\nAHUB_CODEX_WRITE_DENIED\nAHUB_CODEX_GLOB_PRIVATE_DENIED\nAHUB_CODEX_ALIAS_PRIVATE_DENIED\nAHUB_CODEX_CORE_NAME_DENIED\nAHUB_CODEX_CORE_STATE_DENIED");
else if (argv[0] === "debug") console.log("{}");
else if (argv[0] === "exec") {
  const prompt = await new Response(Bun.stdin.stream()).text();
  const log = process.env.FAKE_CODEX_REVIEW_LOG;
  if (log) appendFileSync(log, JSON.stringify({ argv, prompt, peer: process.env.AGENTHUB_PEER_ID }) + "\n");
  const server = servers["agent-hub"]!, env = server.env as Record<string, string>;
  const task = Number(/Review task #(\d+)/.exec(prompt)?.[1]);
  const hub = await ControlClient.connect(env.AGENTHUB_STATE_DIR!, { role: "tools", peer: env.AGENTHUB_PEER_ID! });
  const show = await hub.request({ t: "task", op: "hub_task_show", args: { id: task } });
  const review = await hub.request({ t: "task", op: "hub_review", args: { id: task, verdict: "approved", note: "fixture fresh review" } });
  if (log) appendFileSync(log, JSON.stringify({ show, review }) + "\n");
  hub.close();
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }));
} else process.exitCode = 1;
