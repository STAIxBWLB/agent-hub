import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { writeSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2), value = (key: string) => args[args.indexOf(key) + 1];
const record = args.includes("--record") ? value("--record") : undefined;
if (args.includes("version")) {
  if (record) appendFileSync(record, JSON.stringify({ kind: "version", args }) + "\n");
  console.log(JSON.stringify({ semver: args.includes("--semver") ? value("--semver") : "0.98.1" }));
} else if (args.includes("serve")) {
  // Native jcode (0.94.0 through 0.98.1, socket.rs debug_socket_path) also binds a debug socket named by replacing
  // ".sock" with "-debug.sock": a name without ".sock" makes both binds the same path, and serve exits on EADDRINUSE.
  const main = value("--socket") ?? "", debugPath = join(dirname(main), basename(main).replace(".sock", "-debug.sock"));
  const debug = createServer(socket => socket.end());
  const server = createServer(socket => socket.end());
  debug.once("error", () => process.exit(1));
  server.listen(main, () => debug.listen(debugPath, () => {
    if (record) appendFileSync(record, JSON.stringify({ kind: "serve", pid: process.pid, socket: value("--socket"), home: process.env.JCODE_HOME }) + "\n");
    writeSync(3, "1");
  }));
  process.on("SIGTERM", () => {
    if (record) appendFileSync(record, JSON.stringify({ kind: "term" }) + "\n");
    debug.close();
    server.close(() => setTimeout(() => process.exit(0), args.includes("--exit-delay-ms") ? Number(value("--exit-delay-ms")) : 0));
  });
} else {
  let session = "jcode-s1";
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (record) appendFileSync(record, JSON.stringify({ kind: "rpc", method: msg.method, params: msg.params, home: process.env.JCODE_HOME }) + "\n");
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "jcode", version: args.includes("--version-id") ? value("--version-id") : "0.98.1" }, agentCapabilities: { loadSession: true } } });
    else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: session } });
    else if (msg.method === "session/load") { session = msg.params.sessionId; send({ jsonrpc: "2.0", id: msg.id, result: args.includes("--no-load-echo") ? {} : { sessionId: session } }); }
    else if (msg.method === "session/prompt") {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "JCODE_REPLY" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      if (args.includes("--exit-after-prompt")) setTimeout(() => process.exit(0), 30);
    } else if (msg.method === "session/cancel") send({ jsonrpc: "2.0", id: msg.id, result: {} });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no native mode mapping" } });
  });
}
