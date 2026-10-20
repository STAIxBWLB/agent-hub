import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { writeSync, appendFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2), value = (key: string) => args[args.indexOf(key) + 1];
const record = args.includes("--record") ? value("--record") : undefined;
if (args.includes("version")) {
  if (record) appendFileSync(record, JSON.stringify({ kind: "version", args, telemetry: process.env.JCODE_NO_TELEMETRY }) + "\n");
  console.log(JSON.stringify({ semver: args.includes("--semver") ? value("--semver") : "0.98.1" }));
} else if (args.includes("serve")) {
  // Native jcode (0.94.0 through 0.98.1, socket.rs debug_socket_path) also binds a debug socket named by replacing
  // ".sock" with "-debug.sock": a name without ".sock" makes both binds the same path, and serve exits on EADDRINUSE.
  const main = value("--socket") ?? "", debugPath = join(dirname(main), basename(main).replace(".sock", "-debug.sock"));
  const debug = createServer(socket => socket.end());
  // #572: the native server socket speaks one JSON object per line. Only what the hub's steer uses is modelled, as observed
  // on 0.99.0: ping (capabilities), subscribe (session), state (is_processing) and soft_interrupt (ack, then injected).
  // `--steer-file F`: the ACP process holds its prompt until F exists and marks the turn busy with F.busy.
  const steerFile = args.includes("--steer-file") ? value("--steer-file")! : undefined;
  const server = createServer(socket => {
    let buffer = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        const reply = (value: unknown) => socket.write(JSON.stringify(value) + "\n");
        if (msg.type === "ping") reply({ type: "pong", id: msg.id, capabilities: args.includes("--no-soft-interrupt") ? ["session_tools"] : ["session_tools", "soft_interrupt_ids"] });
        else if (msg.type === "subscribe") { reply({ type: "ack", id: msg.id }); reply({ type: "session", session_id: args.includes("--wrong-session") ? "other-session" : msg.target_session_id ?? "jcode-s1" }); reply({ type: "done", id: msg.id }); }
        else if (msg.type === "state") reply({ type: "state", id: msg.id, session_id: msg.session_id ?? "jcode-s1", is_processing: !!steerFile && existsSync(`${steerFile}.busy`), pending_soft_interrupts: 0 });
        else if (msg.type === "soft_interrupt") {
          if (record) appendFileSync(record, JSON.stringify({ kind: "soft_interrupt", content: msg.content, client_id: msg.client_id, urgent: msg.urgent }) + "\n");
          if (args.includes("--no-ack")) continue;
          reply({ type: "ack", id: msg.id }); reply({ type: "ack", id: msg.id });
          if (steerFile) writeFileSync(steerFile, "steered");
        }
      }
    });
  });
  debug.once("error", () => process.exit(1));
  server.listen(main, () => debug.listen(debugPath, () => {
    if (record) appendFileSync(record, JSON.stringify({ kind: "serve", pid: process.pid, socket: value("--socket"), home: process.env.JCODE_HOME, telemetry: process.env.JCODE_NO_TELEMETRY }) + "\n");
    writeSync(3, "1");
  }));
  process.on("SIGTERM", () => {
    if (record) appendFileSync(record, JSON.stringify({ kind: "term" }) + "\n");
    debug.close();
    server.close(() => setTimeout(() => process.exit(0), args.includes("--exit-delay-ms") ? Number(value("--exit-delay-ms")) : 0));
  });
} else if (args.includes("--resume") && !args.includes("acp")) {
  if (record) appendFileSync(record, JSON.stringify({ kind: "tui", args, peer: process.env.AGENTHUB_PEER_ID, home: process.env.JCODE_HOME, socket: process.env.JCODE_SOCKET, telemetry: process.env.JCODE_NO_TELEMETRY }) + "\n");
} else {
  let session = "jcode-s1";
  const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
  createInterface({ input: process.stdin }).on("line", line => {
    const msg = JSON.parse(line);
    if (record) appendFileSync(record, JSON.stringify({ kind: "rpc", method: msg.method, params: msg.params, home: process.env.JCODE_HOME, telemetry: process.env.JCODE_NO_TELEMETRY }) + "\n");
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "jcode", version: args.includes("--version-id") ? value("--version-id") : "0.98.1" }, agentCapabilities: { loadSession: true } } });
    else if (msg.method === "session/new") send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: session } });
    else if (msg.method === "session/load") { session = msg.params.sessionId; send({ jsonrpc: "2.0", id: msg.id, result: args.includes("--no-load-echo") ? {} : { sessionId: session } }); }
    else if (msg.method === "session/prompt") {
      if (args.includes("--save-native-session")) {
        const directory = join(process.env.JCODE_HOME!, "sessions"); mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${session}.json`), JSON.stringify({ id: session, messages: [{ role: "assistant", content: "JCODE_REPLY" }] }));
      }
      const finish = () => {
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "JCODE_REPLY" } } } });
        send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: args.includes("--max-tokens-stop") ? "max_tokens" : "end_turn" } });
        if (args.includes("--exit-after-prompt")) setTimeout(() => process.exit(0), 30);
      };
      const steerFile = args.includes("--steer-file") ? value("--steer-file")! : undefined;
      if (steerFile) {
        // A turn that stays busy until the hub's steer reaches the native server (the server writes the file).
        writeFileSync(`${steerFile}.busy`, "1");
        const timer = setInterval(() => { if (existsSync(steerFile)) { clearInterval(timer); rmSync(`${steerFile}.busy`, { force: true }); finish(); } }, 20);
      } else finish();
    } else if (msg.method === "session/cancel") send({ jsonrpc: "2.0", id: msg.id, result: {} });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no native mode mapping" } });
  });
}
