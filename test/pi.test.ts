import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { processTable } from "../src/hub/child-process.ts";
import { join } from "node:path";
import { PiPeer, type PiExit } from "../src/adapters/pi.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { newEnvelope, type EnvelopeOpts } from "../src/hub/envelope.ts";

const currentSignature = (pid = process.pid) => { const signature = processSignature(pid); if (!signature) throw new Error("test owner process is not visible"); return signature; };

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
    await peer.deliver([newEnvelope("user", "watchdog", { to: ["pi"] })]);
    for (let i = 0; i < 100 && peer.state !== "offline"; i++) await Bun.sleep(20); // the stop reads the process table: not instant
    expect(peer.state).toBe("offline");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}, 30_000); // its stop reads the process table: slow on a loaded machine

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

test("Pi resumes its own session in a project whose path has a backslash (issue #26)", async () => {
  const base = mkdtempSync(join(process.cwd(), ".pi-backslash-"));
  const cwd = join(base, "back\\slash");
  const stateDir = join(cwd, ".agenthub", "state");
  mkdirSync(join(stateDir, "pi-sessions"), { recursive: true });
  const sessionFile = join(stateDir, "pi-sessions", "s.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s", cwd }) + "\n");
  const peer = new PiPeer("pi", {
    cwd, stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], sessionFile,
    relay: { url: "http://127.0.0.1:9/v1", token: "relay-token", models: [{ id: "dgx/coding" }] },
    tools: [], executeTool: async () => "ok",
  });
  try {
    await peer.start();
    expect(peer.state).toBe("idle");
  } finally { await peer.stop(); rmSync(base, { recursive: true, force: true }); }
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

test("relay execution-budget denial is reported as needs-review without failure escalation", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-relay-budget-stop-"));
  const failures: string[] = [], messages: string[] = [], receipts: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", onTurnFailure: async (_envs, why) => { failures.push(why); } });
  peer.onMessage = (text) => messages.push(text);
  peer.onDelivery = (receipt) => receipts.push(receipt.state);
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "budgeted task", { to: ["pi"], refs: { task: "42" } })], "budgeted-delivery");
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
    expect(peer.recordBudgetStop({ allowed: false, scope: "task:42", unit: "model_calls", used: 3, limit: 3, remaining: 0, reason: "exhausted" })).toMatchObject({ generation: 1, reason: "execution budget exhausted: task:42 model_calls used 3 of 3; 0 remaining" });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_end", generation: 0, failed: true, error: "stale provider error" }) });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled", generation: 0 }) });
    expect(receipts).toEqual(["accepted"]); // delayed events from an older generation cannot settle this delivery
    // The relay returns a generic HTTP failure after its authoritative typed denial.
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_end", generation: 1, failed: true, error: "backend returned HTTP 502" }) });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled", generation: 1 }) });
    expect(failures).toEqual([]);
    expect(messages.at(-1)).toContain("Pi stopped at the execution budget: execution budget exhausted: task:42 model_calls used 3 of 3; 0 remaining");
    expect(receipts).toEqual(["accepted", "needs_review"]);
    expect(peer.recordBudgetStop({ allowed: false, scope: "run:late", unit: "model_calls", used: 1, limit: 1, remaining: 0, reason: "exhausted" })).toBeUndefined();
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("user-cancelled Pi turns are reported without automatic cloud escalation", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-cancel-"));
  const failures: string[] = [], messages: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok", onTurnFailure: async (_envs, why) => { failures.push(why); } });
  peer.onMessage = (text) => messages.push(text);
  const receipts: { id: string; state: string }[] = [];
  peer.onDelivery = (r) => receipts.push({ id: r.id, state: r.state });
  try {
    await peer.start(); await peer.deliver([newEnvelope("user", "cancel fixture", { to: ["pi"] })], "pi-cancel");
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    for (const event of [{ type: "agent_end", cancelled: true }, { type: "agent_settled" }]) await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify(event) });
    expect(failures).toEqual([]);
    expect(messages[0]).toContain("cancelled");
    expect(receipts).toEqual([{ id: "pi-cancel", state: "accepted" }, { id: "pi-cancel", state: "needs_review" }]);
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

// issue #29: Pi used to answer with no addressee, so every attached peer spent a turn on it.
test("Pi addresses its answer to the senders of the delivery it answers", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-reply-test-"));
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "relay-token", models: [{ id: "dgx/coding" }] },
    tools: [], executeTool: async () => "ok",
  });
  const sent: { text: string; opts?: EnvelopeOpts }[] = [];
  peer.onMessage = (text, opts) => sent.push({ text, opts });
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "hello", { to: ["pi"] }), newEnvelope("codex", "and this", { to: ["pi"] })]);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const url = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_end", text: "done" }) });
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled" }) });
    expect(sent.map((s) => s.text)).toEqual(["done"]);
    expect(sent[0]!.opts?.to).toEqual(["user", "codex"]);
  } finally {
    await peer.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("idle Pi user bash aborts at its elapsed deadline without reusing that signal on the next command", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-idle-budget-deadline-"));
  let admissionCount = 0, firstSignalAborted = false, executionCount = 0;
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [],
    admitBudget: async (_envs, unit) => {
      admissionCount++;
      return admissionCount === 1
        ? [{ allowed: true, scope: "run:idle", unit, used: 1, limit: 5, remaining: 4 }, { allowed: true, scope: "run:idle", unit: "elapsed_ms", used: 0, limit: 80, remaining: 80 }]
        : [{ allowed: true, scope: "run:idle", unit, used: 2, limit: 5, remaining: 3 }];
    },
    executeTool: async (_name, _args, _callId, _sessionId, signal) => {
      executionCount++;
      if (executionCount > 1) return signal?.aborted ? "stale abort signal" : "fresh command";
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { firstSignalAborted = true; resolve(); }, { once: true }));
      return "elapsed deadline reached";
    },
  });
  try {
    await peer.start();
    const launch = peer.tuiLaunch!;
    const base = launch.env.AGENTHUB_PI_BRIDGE_URL!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const metadata = peer.recoveryMetadata();
    expect((await post("/event", { type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: process.pid, signature: currentSignature(), sessionId: metadata.sessionId, sessionFile: metadata.sessionFile })).status).toBe(200);
    const admissionResponse = await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 0 });
    expect(admissionResponse.status).toBe(200);
    const admission = await admissionResponse.json() as { reservation: string };
    const first = post("/tool", { name: "bash", purpose: "idle_user_bash", generation: 0, reservation: admission.reservation, toolCallId: "idle-long", args: { command: "sleep", cwd: process.cwd() } });
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect((await firstResponse.json() as { text: string }).text).toBe("elapsed deadline reached");
    expect(firstSignalAborted).toBe(true);
    expect(peer.state).toBe("idle");
    const nextAdmissionResponse = await post("/budget", { unit: "tool_calls", idleUserBash: true, generation: 0 });
    expect(nextAdmissionResponse.status).toBe(200);
    const nextAdmission = await nextAdmissionResponse.json() as { reservation: string };
    const nextResponse = await post("/tool", { name: "bash", purpose: "idle_user_bash", generation: 0, reservation: nextAdmission.reservation, toolCallId: "idle-next", args: { command: "true", cwd: process.cwd() } });
    expect(nextResponse.status).toBe(200);
    expect((await nextResponse.json() as { text: string }).text).toBe("fresh command");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

// #56 review: a native owner that ignores the graceful shutdown must not survive next to a replacement hub.
test("Pi stop tears down a TUI owner whose shutdown acknowledgement was lost, by verified identity", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-survivor-test-"));
  const owner = Bun.spawn(["sleep", "60"]);
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "mlx", relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "mlx/fast" }] }, tools: [], executeTool: async () => "ok", stopGraceMs: 100 });
  try {
    await peer.start();
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const claimed = await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid), sessionId: "survivor-session", sessionFile: "/tmp/survivor.jsonl" }) });
    expect(claimed.status).toBe(200);
    expect(peer.state).toBe("idle");
    const at = performance.now();
    await peer.stop(); // the shutdown command is never acknowledged: teardown, not abandonment
    expect(performance.now() - at).toBeLessThan(5_000);
    expect(peer.state).toBe("offline");
    const outcome = await Promise.race([owner.exited, Bun.sleep(2_000).then(() => "alive")]);
    expect(outcome).not.toBe("alive"); // the survivor was signaled after its signature verified
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); await owner.exited; }
    await peer.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// issue #115: Pi runs in a process group of its own and is stopped as one, as Codex and ACP agents are; without the group,
// a launcher ignoring SIGTERM is never signalled.
test("Pi stops a launcher that ignores SIGTERM together with the Pi it waits for", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-launcher-test-"));
  const pidFile = join(stateDir, "pi.pid"), launcherFile = join(stateDir, "launcher.pid"), bin = join(stateDir, "pi");
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${launcherFile}\ntrap "" TERM\nexec 3<&0\nbun ${join(import.meta.dir, "fakes/pi-rpc.ts")} "$@" <&3 &\necho $! > ${pidFile}\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: [bin], relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok" });
  try {
    await peer.start();
    const pi = Number(readFileSync(pidFile, "utf8")), launcher = Number(readFileSync(launcherFile, "utf8"));
    await peer.stop();
    expect(processTable()!.some((r) => r.pid === pi || r.pid === launcher)).toBe(false);
  } finally {
    for (const f of [pidFile, launcherFile]) {
      const pid = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
      if (pid && processTable()?.some((r) => r.pid === pid && /pi-rpc|\.pi-launcher-test-/.test(r.command))) process.kill(pid, "SIGKILL");
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 30_000);


for (const outcome of [{ code: 0 }, { code: 17 }, { signal: "SIGTERM" }] as const) {
  test(`Pi exit reports the OS cause once, turn status and last tool name only (${JSON.stringify(outcome)}) (#255)`, async () => {
    const stateDir = mkdtempSync(join(process.cwd(), ".pi-exit-test-")), trigger = join(stateDir, "exit-now");
    const exits: PiExit[] = [], logs: string[] = [];
    const peer = new PiPeer("pi", {
      cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx",
      cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger,
        ...("code" in outcome ? ["--exit-code", String(outcome.code)] : ["--exit-signal", outcome.signal])],
      relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] },
      tools: [{ name: "read", parameters: {} }], executeTool: async () => "ok",
      log: (line) => logs.push(line), onExit: (exit) => exits.push(exit),
    });
    try {
      await peer.start();
      const launch = peer.tuiLaunch!;
      await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers: {
        authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json",
      }, body: JSON.stringify({ name: "read", args: { path: "SECRET_ARGUMENT_MARKER" }, toolCallId: "last-read" }) });
      writeFileSync(trigger, "exit");
      for (let i = 0; i < 200 && !exits.length; i++) await Bun.sleep(5);
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({ cause: "process_exit", expected: false, started: true, turnActive: false, toolActive: false, lastToolName: "read",
        code: "code" in outcome ? outcome.code : null, signal: "signal" in outcome ? outcome.signal : null });
      expect(peer.state).toBe("offline");
      expect(logs.filter((line) => line.includes("Pi exit:"))).toHaveLength(1);
      expect(logs.join("\n")).not.toContain("SECRET_ARGUMENT_MARKER");
      await peer.stop();
      expect(exits).toHaveLength(1);
    } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
}

test("a requested Pi stop reports expected exit once and callback failures cannot undo offline settlement (#255)", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-stop-report-test-")), exits: PiExit[] = [];
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] }, tools: [], executeTool: async () => "ok",
    log: () => { throw new Error("log unavailable"); }, onExit: (exit) => { exits.push(exit); throw new Error("notice unavailable"); },
  });
  try {
    await peer.start(); await peer.stop();
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ cause: "process_exit", expected: true, started: true, turnActive: false, toolActive: false });
    expect(peer.state).toBe("offline");
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("Pi exit captures active turn and tool facts before failure cleanup (#255)", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-active-exit-test-")), trigger = join(stateDir, "exit-now");
  const exits: PiExit[] = [];
  let entered = false, release!: () => void;
  let tool: Promise<Response> | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx",
    cmd: [process.execPath, join(import.meta.dir, "fakes/pi-rpc.ts"), "--exit-trigger", trigger, "--exit-code", "0"],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] },
    tools: [{ name: "write", parameters: {} }], executeTool: async () => { entered = true; await barrier; return "ok"; }, onExit: (exit) => exits.push(exit),
  });
  try {
    await peer.start();
    const launch = peer.tuiLaunch!, url = launch.env.AGENTHUB_PI_BRIDGE_URL;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    await fetch(`${url}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
    tool = fetch(`${url}/tool`, { method: "POST", headers, body: JSON.stringify({ name: "write", args: {}, toolCallId: "active" }) });
    for (let i = 0; i < 200 && !entered; i++) await Bun.sleep(5);
    expect(entered).toBe(true);
    writeFileSync(trigger, "exit");
    for (let i = 0; i < 200 && !exits.length; i++) await Bun.sleep(5);
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: 0, expected: false, started: true, turnActive: true, toolActive: true, lastToolName: "write" });
    release(); await tool;
    expect(peer.state).toBe("offline");
  } finally { release(); await tool?.catch(() => undefined); await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});


test("stopping a verified TUI survivor reports one owned exit with pre-cleanup metadata and unknown OS status (#255)", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-tui-exit-test-")), owner = Bun.spawn(["sleep", "60"]);
  const exits: PiExit[] = [], logs: string[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "dgx", stopGraceMs: 25,
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] }, tools: [], executeTool: async () => "ok",
    onExit: (exit) => exits.push(exit), log: (line) => logs.push(line) });
  try {
    await peer.start();
    const launch = peer.tuiLaunch!, headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    expect((await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({
      type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature: currentSignature(owner.pid),
      sessionId: "owned-tui", sessionFile: join(stateDir, "owned.jsonl"),
    }) })).status).toBe(200);
    await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_start", generation: 1 }) });
    await peer.stop(); // no shutdown ack: the signature-verified survivor is terminated
    expect(await owner.exited).not.toBeNull();
    expect(exits).toHaveLength(1);
    expect(exits[0]).toEqual({ cause: "owner_stopped", code: null, signal: null, expected: true, started: true, turnActive: true, toolActive: false });
    expect(logs.filter((line) => line.includes("Pi exit:"))).toHaveLength(1);
    await peer.stop(); expect(exits).toHaveLength(1);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); await owner.exited; }
    await peer.stop(); rmSync(stateDir, { recursive: true, force: true });
  }
});

test("stopping a never-owned TUI launch invents no exit report (#255)", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-unowned-exit-test-")), exits: PiExit[] = [];
  const peer = new PiPeer("pi", { cwd: process.cwd(), stateDir, mode: "tui", backend: "dgx",
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [] }, tools: [], executeTool: async () => "ok", onExit: (exit) => exits.push(exit) });
  try { await peer.start(); await peer.stop(); expect(exits).toEqual([]); }
  finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
