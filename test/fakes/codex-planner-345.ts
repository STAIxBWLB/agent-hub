// Fixture transport only: an echoed policy tests host admission, never native Codex isolation.
import { appendFileSync } from "node:fs";

const value = (flag: string) => process.argv[process.argv.indexOf(flag) + 1];
const port = Number(new URL(value("--listen") ?? "ws://127.0.0.1:0").port);
const record = value("--fixture-record");
let sequence = 0;
Bun.serve({
  hostname: "127.0.0.1", port,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok");
    return server.upgrade(request) ? undefined : new Response("no", { status: 400 });
  },
  websocket: {
    message(socket, raw) {
      const message = JSON.parse(String(raw));
      if (record) appendFileSync(record, JSON.stringify(message) + "\n");
      const reply = (result: unknown): void => { socket.send(JSON.stringify({ id: message.id, result })); };
      const note = (method: string, params: unknown): void => { socket.send(JSON.stringify({ method, params })); };
      if (message.method === "initialize") return reply({ userAgent: "fake-codex/0.164.0" });
      if (message.method === "thread/start" || message.method === "thread/resume") return reply({
        thread: { id: message.params?.threadId ?? "planner-native-thread" },
        model: "fixture", approvalPolicy: "untrusted", sandbox: { type: "readOnly" },
      });
      if (message.method === "account/rateLimits/read") return reply({ rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null,
      } });
      if (message.method === "turn/start") {
        const turn = { id: "planner-turn-" + ++sequence, status: "inProgress", items: [] };
        reply({ turn }); note("turn/started", { threadId: message.params.threadId, turn });
        note("turn/completed", { threadId: message.params.threadId, turn: { ...turn, status: "completed" } });
      } else if (message.method === "turn/interrupt") reply({});
    },
  },
});
await new Promise(() => {});
