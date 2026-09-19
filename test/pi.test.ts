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

for (const stopImmediately of [false, true]) test(`Pi native owner death without shutdown can be recovered (${stopImmediately ? "stop" : "monitor"})`, async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-dead-owner-"));
  const owner = Bun.spawn(["sleep", "30"]);
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "mlx", relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok" });
  try {
    await peer.start();
    const launch = peer.tuiLaunch!;
    const claimed = await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid), sessionId: "dead-owner-session", sessionFile: "/tmp/dead-owner.jsonl" }) });
    expect(claimed.status).toBe(200);
    owner.kill("SIGTERM"); await owner.exited;
    if (!stopImmediately) {
      for (let i = 0; i < 100 && peer.state !== "offline"; i++) await Bun.sleep(20);
      expect(peer.state).toBe("offline");
      expect(peer.recoveryReady).toBe(true);
      expect(peer.recoveryMetadata().sessionId).toBe("dead-owner-session");
    }
    const at = performance.now();
    await peer.stop();
    expect(performance.now() - at).toBeLessThan(1000);
    expect(peer.state).toBe("offline");
  } finally { if (owner.exitCode === null) { owner.kill(); await owner.exited; } await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("an authenticated long-running tool keeps the Pi watchdog alive", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-tool-watchdog-"));
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", watchdogMs: 200, cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => { await Bun.sleep(650); return "long tool completed"; } });
  const failures: string[] = [];
  peer.onMessage = (text) => failures.push(text);
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "run a tool", { to: ["pi"] })]);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    const result = await fetch(`${url}/tool`, { method: "POST", headers, body: JSON.stringify({ name: "bash", args: {}, toolCallId: "long-tool" }) });
    expect((await result.json() as any).text).toBe("long tool completed");
    expect(peer.state).toBe("busy");
    expect(failures).toEqual([]);
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled" }) });
    expect(peer.state).toBe("idle");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("a successful Pi retry clears its provisional agent_end failure", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-retry-"));
  const failures: string[] = [], messages: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", onTurnFailure: async (_envs, why) => { failures.push(why); } });
  peer.onMessage = (text) => messages.push(text);
  try {
    await peer.start(); await peer.deliver([newEnvelope("user", "retry fixture", { to: ["pi"] })]);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    for (const event of [{ type: "agent_end", failed: true, error: "transient upstream failure" }, { type: "agent_end", failed: false, text: "recovered" }, { type: "agent_settled" }]) {
      await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify(event) });
    }
    expect(failures).toEqual([]);
    expect(messages).toEqual(["recovered"]);
    expect(peer.state).toBe("idle");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("user-cancelled Pi turns are reported without automatic cloud escalation", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-cancel-"));
  const failures: string[] = [], messages: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", onTurnFailure: async (_envs, why) => { failures.push(why); } });
  peer.onMessage = (text) => messages.push(text);
  try {
    await peer.start(); await peer.deliver([newEnvelope("user", "cancel fixture", { to: ["pi"] })]);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    for (const event of [{ type: "agent_end", cancelled: true }, { type: "agent_settled" }]) await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify(event) });
    expect(failures).toEqual([]);
    expect(messages[0]).toContain("cancelled");
    expect(peer.state).toBe("idle");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("only a verified empty source can resume by ID when Pi has not persisted a file", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-empty-resume-"));
  const options = { cwd: process.cwd(), stateDir, mode: "headless" as const, backend: "dgx" as const, cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts"), "--empty-session"], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok" };
  const source = new PiPeer("pi", options);
  let target: PiPeer | undefined;
  try {
    await source.start();
    const unverified = source.recoveryMetadata();
    expect(unverified.sessionFile).toBeString();
    const captured = await source.captureResume();
    expect(captured.sessionFile).toBeUndefined();
    expect((captured.launch as any).sessionFile).toBeUndefined();
    await source.stop();
    expect(source.pendingResume.sessionId).toBe(String(captured.sessionId));
    const retriedCapture = await source.captureResume();
    expect(retriedCapture.sessionId).toBe(String(captured.sessionId));
    expect(retriedCapture.sessionFile).toBeUndefined();
    target = new PiPeer("pi", { ...options, sessionId: captured.sessionId as string });
    await target.start();
    expect(target.recoveryMetadata().sessionId).toBe(captured.sessionId);
    expect(target.tuiLaunch!.args).toContain("--session-id");
    await target.deliver([newEnvelope("user", "unpersisted work", { to: ["pi"] })]);
    const launch = target.tuiLaunch!;
    await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ type: "agent_settled" }) });
    await expect(target.captureResume()).rejects.toThrow("not persisted");
    expect(target.recoveryMetadata().sessionFile).toBeString();
  } finally { await source.stop(); await target?.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
