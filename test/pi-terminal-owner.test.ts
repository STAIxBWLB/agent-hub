import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { processSignature } from "../src/pi/process-signature.ts";

async function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ahub-pi-terminal-owner-"));
  const owner = Bun.spawn(["sleep", "30"]);
  let reads = 0, mode: "live" | "unknown" | "reused" = "live";
  const signature = processSignature(owner.pid)!;
  const peer = new PiPeer("pi", {
    cwd: stateDir, stateDir, mode: "tui", backend: "mlx", stopGraceMs: 20,
    relay: { url: "http://127.0.0.1:9/v1", token: "fixture", models: [{ id: "mlx/fast" }] },
    tools: [], executeTool: async () => "ok",
    signature(pid) { reads++; return mode === "unknown" ? undefined : mode === "reused" ? "replacement-process" : processSignature(pid); },
  });
  await peer.start();
  const launch = peer.tuiLaunch!;
  const post = (body: Record<string, unknown>) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, {
    method: "POST", headers: { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const claim = () => post({ type: "session_start", ownerToken: launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: owner.pid, signature, sessionId: "owner-session", sessionFile: join(stateDir, "session.jsonl"), fencedPrompt: true });
  expect((await claim()).status).toBe(200);
  return {
    peer, owner, signature, claim, post, reads: () => reads, mode: (next: typeof mode) => { mode = next; },
    async close() {
      if (owner.exitCode === null) { owner.kill(); await owner.exited; }
      await peer.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

test("#576 Pi terminal ownership reads do not repeat process probes for the same owner", async () => {
  const f = await fixture();
  try {
    const before = f.reads();
    const proof = f.peer.terminalOwner("launch");
    expect(proof).toMatchObject({ nativePid: f.owner.pid });
    for (let tick = 0; tick < 100; tick++) {
      expect(f.peer.terminalOwner("launch")).toEqual(proof);
      expect(f.peer.terminalOwner("launch")).toEqual(proof); // owner(row), then isCurrent()
    }
    expect(f.reads() - before).toBe(0);
  } finally { await f.close(); }
}, 10_000);

for (const result of ["unknown", "reused"] as const) test(`#576 ${result} Pi process identity withdraws terminal proof`, async () => {
  const f = await fixture();
  try {
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    f.mode(result);
    const before = f.reads();
    (f.peer as any).checkOwner(); // The same bounded callback the native owner monitor invokes.
    expect(f.reads() - before).toBe(1);
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
    expect(f.peer.state).toBe(result === "unknown" ? "idle" : "offline");
    if (result === "unknown") {
      f.mode("live"); (f.peer as any).checkOwner();
      expect(f.peer.terminalOwner("launch")).toBeDefined();
    }
  } finally { await f.close(); }
}, 10_000);

test("#576 an overdue Pi monitor observation expires instead of spawning a probe", async () => {
  const f = await fixture();
  try {
    // Suspend this fixture's monitor to model a delayed callback, without changing the clock globally.
    clearInterval((f.peer as any).ownerMonitor);
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    const before = f.reads();
    await Bun.sleep(1_050);
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
    expect(f.reads()).toBe(before);
    (f.peer as any).checkOwner();
    expect(f.peer.terminalOwner("launch")).toBeDefined();
  } finally { await f.close(); }
}, 10_000);

test("#576 Pi native owner death still withdraws the cached proof through its real monitor", async () => {
  const f = await fixture();
  try {
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    f.owner.kill(); await f.owner.exited;
    const deadline = performance.now() + 2_000;
    while (f.peer.state !== "offline" && performance.now() < deadline) await Bun.sleep(20);
    expect(f.peer.state).toBe("offline");
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
  } finally { await f.close(); }
}, 10_000);

for (const field of ["ownerPid", "ownerSignature", "sessionId", "sessionFile", "ownerToken"] as const) test(`#576 Pi terminal proof is bound to ${field}`, async () => {
  const f = await fixture();
  const original = (f.peer as any)[field];
  try {
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    (f.peer as any)[field] = field === "ownerPid" ? process.pid : "changed";
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
  } finally { (f.peer as any)[field] = original; await f.close(); }
}, 10_000);

for (const transition of ["detach", "shutdown", "fail", "stop"] as const) test(`#576 Pi ${transition} invalidates terminal ownership immediately`, async () => {
  const f = await fixture();
  try {
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    if (transition === "detach") await f.peer.detachForRoster();
    if (transition === "shutdown") expect((await f.post({ type: "session_shutdown" })).status).toBe(200);
    if (transition === "fail") (f.peer as any).fail(new Error("fixture transport loss"));
    if (transition === "stop") {
      f.owner.kill(); await f.owner.exited;
      const stopping = f.peer.stop();
      expect(f.peer.terminalOwner("launch")).toBeUndefined();
      await stopping;
    }
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
    // A later live process observation cannot revive a detached, stopped or failed peer.
    (f.peer as any).checkOwner();
    expect(f.peer.terminalOwner("launch")).toBeUndefined();
  } finally { await f.close(); }
}, 10_000);

test("#576 fresh Pi effect admission rejects a changed signature before the monitor refreshes", async () => {
  const f = await fixture();
  try {
    expect(f.peer.terminalOwner("launch")).toBeDefined();
    f.mode("reused");
    const before = f.reads();
    const response = await (f.peer as any).handleBudgetRequest({ unit: "tool_calls", generation: 0, idleUserBash: true });
    expect(response.status).toBe(409);
    expect(f.reads()).toBeGreaterThan(before);
    expect(await response.json()).toMatchObject({ error: "stale Pi budget request" });
  } finally { await f.close(); }
}, 10_000);
