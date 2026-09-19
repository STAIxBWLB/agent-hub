import { createInterface } from "node:readline";

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line) as { id?: string; type?: string };
  if (request.type === "get_state") send({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false, sessionId: "fake-session", sessionFile: "/tmp/fake-session.jsonl" } });
  else if (request.type === "set_model") send({ type: "response", id: request.id, command: "set_model", success: true });
  else if (request.type === "prompt" || request.type === "steer") send({ type: "response", id: request.id, command: request.type, success: true });
});
