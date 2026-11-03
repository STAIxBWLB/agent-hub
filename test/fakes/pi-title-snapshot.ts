// A native RPC snapshot produced before a manual-name event but delivered after it. No Pi/model code runs.
import { createInterface } from "node:readline";
import { join } from "node:path";
const flag = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const sessionId = "title-snapshot-session", sessionFile = join(flag("--session-dir")!, "title-snapshot-session.jsonl");
let reads = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line) as { id: string; type: string };
  if (request.type === "get_state") {
    const data = { sessionId, sessionFile, messageCount: 0, pendingMessageCount: 0, isStreaming: false, isCompacting: false };
    const delayed = ++reads > 1;
    void (async () => {
      if (delayed) {
        const response = await fetch(`${process.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${process.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ type: "session_title", sessionId, titleRevision: 2, sessionName: "newer native manual title" }) });
        if (!response.ok) throw new Error("fixture native title event was refused");
      }
      send({ type: "response", id: request.id, command: "get_state", success: true, data });
    })();
  } else send({ type: "response", id: request.id, command: request.type, success: true });
});
