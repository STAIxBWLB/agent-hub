import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line); let result: unknown;
  if (msg.method === "initialize") result = { protocolVersion: 1, agentInfo: { name: "role-fixture", version: "1" } };
  else if (msg.method === "session/new") result = { sessionId: "role-session" };
  else if (msg.method === "session/prompt") { appendFileSync(process.argv[2]!, JSON.stringify(msg.params.prompt[0].text) + "\n"); result = { stopReason: "end_turn" }; }
  else continue;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
}
