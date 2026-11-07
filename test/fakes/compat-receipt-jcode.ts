#!/usr/bin/env bun
// A protocol fake, not an installed CLI or evidence about any native provider/account.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, writeSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (name: string): string => args[args.indexOf(name) + 1] ?? "";
if (args[0] === "--proof-worker") {
  const context = JSON.parse(readFileSync(args[1]!, "utf8"));
  const { runJcodeProofs } = await import(args[2]!);
  const { runBoundedReceiptCommand } = await import(args[3]!);
  const result = await runJcodeProofs({ ...context, signal: AbortSignal.timeout(context.limits.totalMs), run: runBoundedReceiptCommand });
  process.stdout.write(JSON.stringify(result));
} else {
  const fault = value("--fault") ?? "none";
  const nativeHome = process.env.JCODE_HOME!;
  const peerHome = process.env.HOME!;
  const socketPath = value("--socket") ?? "j.sock";
  const config = join(nativeHome, "config.toml");
  const busy = join(process.cwd(), "fixture.busy"), steerFile = join(process.cwd(), "fixture.steer");
  const session = "receipt-session";
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  if (args.includes("version")) {
    if (fault === "decoy-mutated") writeFileSync(join(peerHome, ".jcode/config.toml"), "# changed private decoy\n");
    send({ semver: "0.99.1", version: "v0.99.1 (fixture)" });
  } else if (args.includes("provider") && args.includes("add")) {
    if (!args.includes("--no-api-key")) throw new Error("fixture requires no API key");
    writeFileSync(config, JSON.stringify({ baseURL: value("--base-url"), model: value("--model") }));
  } else if (args.includes("serve")) {
    if (fault === "telemetry") writeFileSync(join(nativeHome, "telemetry_id"), "fixture");
    if (fault === "home-telemetry") writeFileSync(join(peerHome, ".jcode/telemetry_id"), "fixture");
    const server = createServer(conn => {
      let buffer = "";
      conn.on("error", () => {});
      conn.on("data", chunk => {
        buffer += chunk.toString();
        for (;;) {
          const index = buffer.indexOf("\n"); if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          const reply = (data: unknown) => conn.write(`${JSON.stringify(data)}\n`);
          if (message.type === "ping") reply({ type: "pong", id: message.id,
            capabilities: fault === "capability-string" ? "soft_interrupt_ids" : fault === "capability" ? [] : ["soft_interrupt_ids"] });
          else if (message.type === "subscribe") reply({ type: "session", session_id: fault === "subscribe-session" ? "other" : message.target_session_id });
          else if (message.type === "state") {
            const active = existsSync(busy);
            reply({ type: "state", id: message.id, session_id: fault === "state-session" && active ? "other" : session,
              is_processing: fault === "idle-active" ? true : fault === "active-idle" ? false : active });
          } else if (message.type === "soft_interrupt") {
            if (message.urgent !== false || message.client_id !== "receipt-steer") throw new Error("invalid fixture steer");
            writeFileSync(steerFile, message.content);
            if (fault !== "ack-missing") reply({ type: "ack", id: message.id });
          }
        }
      });
    });
    const debug = createServer(conn => conn.end());
    server.listen(socketPath, () => debug.listen("j-debug.sock", () => {
      writeFileSync("j.sock.hash", "fixture"); writeFileSync("j.sock.daemon.lock", "fixture");
      writeFileSync("j.sock.server.json", JSON.stringify({ argv: process.argv, debug_socket_path: "j-debug.sock", idle_timeout_secs: 30,
        owner_pid: Number(value("--owner-pid")), pid: process.pid + (fault === "serve-identity" ? 1 : 0), ppid: process.ppid,
        schema_version: 1, scope: "temporary", socket_path: socketPath, started_at: "fixture" }));
      writeSync(3, "1");
    }));
    process.on("SIGTERM", () => { server.close(); debug.close(); process.exit(0); });
  } else if (args.includes("acp")) {
    const entry = JSON.parse(readFileSync(join(process.cwd(), ".jcode/mcp.json"), "utf8")).mcpServers.observer;
    // No markers live in the entry; the child inherits only the native process environment.
    if (entry.env !== undefined) throw new Error("fixture MCP entry unexpectedly supplies an environment");
    const env = { ...process.env };
    if (fault === "mcp-peer") env.AGENTHUB_PEER_ID = "wrong-peer";
    if (fault === "mcp-launch") env.AGENTHUB_LAUNCH_ID = "wrong-launch";
    const observer = spawn(entry.command, entry.args, { env, stdio: ["pipe", "pipe", "ignore"] });
    observer.on("error", () => {}); observer.stdout.on("data", () => {});
    observer.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    const rpc = async (message: any) => {
      const answer = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
      if (message.method === "initialize") answer({ protocolVersion: fault === "protocol" ? 2 : 1,
        agentInfo: { name: fault === "identity" ? "other" : "jcode", title: "Jcode", version: "0.99.1" },
        agentCapabilities: { loadSession: fault !== "load-capability" }, authMethods: fault === "auth-methods" ? [{ id: "account" }] : [] });
      else if (message.method === "session/new") answer({ sessionId: session, configOptions: [], ...(fault === "new-models" ? {} : { models: {} }) });
      else if (message.method === "session/load") answer({ configOptions: [], models: {}, ...(fault === "load-echo" ? { sessionId: session } : {}) });
      else if (message.method === "session/set_mode" || message.method === "session/request_permission") {
        if (fault === "mode-supported") answer({});
        else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported ACP method: ${message.method}` } });
      } else if (message.method === "session/prompt") {
        const profile = JSON.parse(readFileSync(config, "utf8"));
        if (!profile.baseURL.startsWith("http://127.0.0.1:")) throw new Error("fixture endpoint is not loopback");
        const original = message.params.prompt[0].text;
        writeFileSync(busy, "busy");
        const post = (messages: any[]) => fetch(`${profile.baseURL}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: profile.model, stream: true, messages }) });
        const first = await post([{ role: "system", content: "fixture system" }, { role: "user", content: original }, ...(fault === "first-extra-user" ? [{ role: "user", content: "unexpected extra user" }] : [])]);
        const text = await first.text();
        const head = text.match(/"content":"([^"]+)"/)?.[1];
        if (!head || !existsSync(steerFile)) throw new Error("fixture never observed running steer");
        const steer = readFileSync(steerFile, "utf8");
        const originalUser = { role: "user", content: original }, assistant = { role: "assistant", content: head }, steerUser = { role: "user", content: steer };
        let messages = [originalUser, assistant, steerUser];
        if (fault === "missing-assistant") messages = [originalUser, steerUser];
        if (fault === "missing-steer") messages = [originalUser, assistant];
        if (fault === "request-order") messages = [assistant, originalUser, steerUser];
        if (fault === "extra-user") messages = [originalUser, assistant, { role: "user", content: "extra" }, steerUser];
        const second = await post([{ role: "system", content: "fixture system" }, ...messages]); await second.text();
        rmSync(busy, { force: true });
        answer({ stopReason: fault === "cancelled" ? "cancelled" : "end_turn" });
      }
    };
    createInterface({ input: process.stdin }).on("line", line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      void rpc(message).catch(() => send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "fixture operation failed" } }));
    });
  } else throw new Error("fixture command unsupported");
}
