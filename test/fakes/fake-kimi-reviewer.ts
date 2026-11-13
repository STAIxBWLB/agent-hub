import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [log, ...argv] = process.argv.slice(2);
if (!log) throw new Error("fixture log required");
if (argv.includes("--version")) { console.log("2.2.0"); process.exit(0); }
const home = process.env.KIMI_CODE_HOME!;
appendFileSync(log, JSON.stringify({ stage: "started", argv, home, cwd: process.cwd() })+"\n");
const agent = readFileSync(argv[argv.indexOf("--agent-file") + 1]!, "utf8");
const mcp = JSON.parse(readFileSync(join(home, "mcp.json"), "utf8")).mcpServers["agent-hub"];
const task = Number(agent.match(/(?:Task|task) #(\d+)/)?.[1]);
if (!Number.isSafeInteger(task) || !task) { appendFileSync(log,JSON.stringify({stage:"parse-failed",tail:agent.slice(-1200)})+"\n"); throw new Error("task not framed into agent"); }
// Every caller launches a fresh hub-owned profile. Model only native 1.5 usage, never a quota/error frame.
const sessionId = `session_${randomUUID()}`, sessionDir = join(home, "sessions", "wd_fixture", sessionId), agentDir = join(sessionDir, "agents", "main");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ sessionId, sessionDir }) + "\n");
writeFileSync(join(agentDir, "wire.jsonl"), JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1 }) + "\n"
  + JSON.stringify({ type: "usage.record", agentId: "main", model: "fixture", usage: { inputOther: 3, output: 2, inputCacheRead: 0, inputCacheCreation: 0 }, usageScope: "turn", time: Date.now() }) + "\n");
type RpcReply = { result?: { tools?: { name: string }[]; isError?: boolean }; error?: unknown };
const rpc = async (method: string, params?: unknown) => {
 const response = await fetch(mcp.url, { method: "POST", headers: { ...mcp.headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
 return await response.json() as RpcReply;
};
const list = await rpc("tools/list");
const wrong = await rpc("tools/call", { name: "hub_task_accept", arguments: { id: task } });
const show = await rpc("tools/call", { name: "hub_task_show", arguments: { id: task } });
appendFileSync(log, JSON.stringify({ peer: process.env.AGENTHUB_PEER_ID, home, cwd: process.cwd(), agent, tools: list.result?.tools?.map((tool: { name: string }) => tool.name), wrongRefused: !!wrong.error, show }) + "\n");
const verdict = await rpc("tools/call", { name: "hub_review", arguments: { id: task, verdict: "approved", note: "fixture fresh native review" } });
if (verdict.error || verdict.result?.isError) throw new Error("fixture verdict refused");
console.log(JSON.stringify({ role: "assistant", content: "fixture reviewed" }));
