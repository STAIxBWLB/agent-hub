import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const option = (flag: string) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
const empty = process.argv.includes("--empty-session");
const dir = option("--session-dir")!;
mkdirSync(dir, { recursive: true });
const existing = option("--session");
const sessionId = option("--session-id") ?? (existing ? JSON.parse(readFileSync(existing, "utf8").split("\n")[0]!).id : "fake-session");
const sessionFile = existing ?? join(dir, `${sessionId}.jsonl`);
if (!empty && !existsSync(sessionFile)) writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() }) + "\n");
let messageCount = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as { id?: string; type?: string };
  if (request.type === "get_state") send({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount, sessionId, sessionFile } });
  else if (request.type === "set_model") send({ type: "response", id: request.id, command: "set_model", success: true });
  else if (request.type === "prompt" || request.type === "steer") { messageCount++; send({ type: "response", id: request.id, command: request.type, success: true }); }
});
