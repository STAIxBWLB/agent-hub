import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

const currentSignature = (pid = process.pid) => { const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart=,comm="], { stdout: "pipe" }); return new Bun.CryptoHasher("sha256").update(p.stdout.toString().trim()).digest("hex"); };

test("Pi headless owner uses RPC and settles one reply through the trusted bridge", async () => {
const stateDir = mkdtempSync(join(process.cwd(), ".pi-test-"));
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "relay-token", models: [{ id: "dgx/coding" }] },
    tools: [], executeTool: async () => "ok",
  });
  const messages: string[] = [];
  peer.onMessage = (text) => messages.push(text);
  try {
    await peer.start();
    expect(peer.state).toBe("idle");
    expect(peer.tuiLaunch?.env.AGENTHUB_PI_RELAY_TOKEN).toBe("relay-token");
    const envelope = newEnvelope("user", "hello", { to: ["pi"] });
    await peer.deliver([envelope]);
    expect(peer.state).toBe("busy");
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_end", text: "done" }) });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled" }) });
    expect(messages).toEqual(["done"]);
    expect(peer.state).toBe("idle");
  } finally {
    await peer.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Pi TUI mode exposes the same isolated trusted extension launch without spawning", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-tui-test-"));
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "mlx", cmd: ["pi"], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok" });
  try {
    const owner = Bun.spawn(["sleep", "1"]); await peer.start(); expect(peer.state).toBe("offline"); expect(peer.tuiLaunch?.args).toContain("--extension"); expect(peer.tuiLaunch?.args).not.toContain("rpc"); expect(peer.tuiLaunch?.env.PI_CODING_AGENT_DIR).toContain("/pi");
    const launch = peer.tuiLaunch!; const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }; const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid), sessionId: "tui-session", sessionFile: "/tmp/tui-session.jsonl" }) });
    expect(peer.state).toBe("idle"); const delivery = peer.deliver([newEnvelope("user", "tui prompt", { to: ["pi"] })]);
    const command = await (await fetch(`${url}/commands`, { headers })).json() as any; expect(command.command.type).toBe("prompt");
    await fetch(`${url}/ack`, { method: "POST", headers, body: JSON.stringify({ id: command.command.id, ok: true }) }); await delivery;
  }
  finally { const launch = peer.tuiLaunch; if (launch && peer.state !== "offline") { const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }; const stopping = peer.stop(); const command = await (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/commands`, { headers })).json() as any; await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_shutdown" }) }); await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/ack`, { method: "POST", headers, body: JSON.stringify({ id: command.command.id, ok: true }) }); await stopping; } rmSync(stateDir, { recursive: true, force: true }); }
});

test("Pi bridge rejects duplicate owners and session identity changes", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-owner-test-"));
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "mlx", cmd: ["pi"], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok" });
  try {
    const owner = Bun.spawn(["sleep", "1"]); await peer.start(); const launch = peer.tuiLaunch!; const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }; const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    const first = await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid), sessionId: "s1", sessionFile: "/tmp/s1" }) }); expect(first.status).toBe(200);
    const duplicate = await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: "other", pid: process.pid, signature: currentSignature(), sessionId: "s2", sessionFile: "/tmp/s2" }) }); expect(duplicate.status).toBe(409);
    const changed = await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: process.pid, signature: currentSignature(), sessionId: "s2", sessionFile: "/tmp/s2" }) }); expect(changed.status).toBe(409);
  } finally { const launch = peer.tuiLaunch; if (launch && peer.state !== "offline") { const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }; const stopping = peer.stop(); const command = await (await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/commands`, { headers })).json() as any; await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_shutdown" }) }); await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/ack`, { method: "POST", headers, body: JSON.stringify({ id: command.command.id, ok: true }) }); await stopping; } rmSync(stateDir, { recursive: true, force: true }); }
});

test("Pi watchdog remains offline and accepted failure is escalated without redelivery", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-watchdog-test-")); const failures: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", watchdogMs: 30, onTurnFailure: async (_envs, reason) => { failures.push(reason); } });
  try {
    await peer.start(); const launch = peer.tuiLaunch!; const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }; const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    await peer.deliver([newEnvelope("user", "accepted", { to: ["pi"] })]);
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_end", failed: true, error: "tool mutation uncertain" }) });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled" }) });
    expect(failures).toEqual(["tool mutation uncertain"]);
    await peer.deliver([newEnvelope("user", "watchdog", { to: ["pi"] })]); await Bun.sleep(80); expect(peer.state).toBe("offline");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("Pi resume refuses a session outside its managed directory or from another project", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-resume-test-"));
  const make = (sessionFile: string) => new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "mlx", sessionFile, relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok" });
  try {
    const outside = join(stateDir, "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", id: "s", cwd: process.cwd() }) + "\n");
    const first = make(outside);
    await expect(first.start()).rejects.toThrow("outside the managed");
    await first.stop();
    const inside = join(stateDir, "pi-sessions", "wrong-project.jsonl");
    mkdirSync(join(stateDir, "pi-sessions"), { recursive: true });
    writeFileSync(inside, JSON.stringify({ type: "session", id: "s", cwd: stateDir }) + "\n");
    const second = make(inside);
    await expect(second.start()).rejects.toThrow("does not match");
    await second.stop();
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
