import { expect, test } from "bun:test";
import { join } from "node:path";
import { rosterPiFixture } from "./fakes/pi-roster-tui.ts";
import { processSignature } from "../src/pi/process-signature.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { Bus } from "../src/hub/bus.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";

const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test("real Pi extension refuses a hub prompt when a personal turn overtakes the snapshot ACK (#379)", async () => {
  const snapshot = barrier(), releaseSnapshot = barrier(), started = barrier();
  const acks: any[] = [], events: any[] = [];
  let command = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/commands") {
      return Response.json({ command: [
        { id: "snapshot", type: "get_session_state" },
        { id: "hub-prompt", type: "prompt", sessionId: "prompt-session", generation: 0, message: "hub work" },
        { id: "shutdown", type: "shutdown" },
      ][command++] ?? null });
    }
    const body = await request.json() as any;
    if (path === "/event") { events.push(body); if (body.type === "agent_start") started.release(); }
    if (path === "/ack") {
      acks.push(body);
      if (body.id === "snapshot") { snapshot.release(); await releaseSnapshot.promise; }
    }
    return Response.json({ ok: true });
  } });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-prompt-admission-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture", AGENTHUB_PI_TOOLS: "[]" },
  });
  try {
    await snapshot.promise;
    expect(acks.find(ack => ack.id === "snapshot").result.idle).toBe(true);
    proc.stdin.write("start\n"); await proc.stdin.flush(); await started.promise;
    releaseSnapshot.release();
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe("");
    expect(JSON.parse(out.trim())).toEqual({ sent: 0 });
    expect(events.find(event => event.type === "session_start").fencedPrompt).toBe(true);
    expect(acks.find(ack => ack.id === "hub-prompt")).toMatchObject({ ok: false, refusal: { kind: "prompt_not_started", promptId: "hub-prompt", sessionId: "prompt-session", generation: 1 } });
  } finally { releaseSnapshot.release(); if (proc.exitCode === null) { proc.kill(); await proc.exited; } server.stop(true); }
}, 10_000);

test("Pi prompt refusal retains its owner and queue when personal lifecycle reaches the daemon before the refusal ACK (#379)", async () => {
  const f = await rosterPiFixture();
  const journal = new DeliveryJournal({ file: join((f.peer as any).opts.stateDir, "prompt-journal.db"), projectRoot: process.cwd(), projectId: "prompt-fixture", instanceId: "prompt-instance" });
  const bus = new Bus({ batchMs: 0, journal });
  const messages: string[] = [], receipts: any[] = [];
  bus.add(f.peer); bus.pause("pi");
  const delivered = f.peer.onDelivery;
  f.peer.onDelivery = receipt => { receipts.push(receipt); delivered?.(receipt); };
  f.peer.onMessage = message => messages.push(message);
  try {
    await f.post("/event", { type: "session_start", ownerToken: f.launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: f.owner.pid, signature: processSignature(f.owner.pid), sessionId: f.sessionId, sessionFile: f.sessionFile, fencedPrompt: true });
    await f.peer.detachForRoster();
    const envelope = newEnvelope("user", "retained hub work", { to: ["pi"] }); bus.publish(envelope);
    // The ACK arrives while the real native agent_start is still in transit.
    await f.resume(true); bus.resume("pi");
    const prompt = await f.next(); expect(prompt.type).toBe("prompt");
    await f.post("/event", { type: "agent_start", generation: 1, sessionId: f.sessionId });
    await f.post("/event", { type: "agent_end", generation: 1, sessionId: f.sessionId, text: "personal secret" });
    await f.post("/event", { type: "agent_settled", generation: 1, sessionId: f.sessionId, text: "personal secret" });
    expect(messages).toEqual([]);
    const refusal = { id: prompt.id, ok: false, error: "native turn is active", refusal: { kind: "prompt_not_started", promptId: prompt.id, sessionId: f.sessionId, generation: 1 } };
    await f.post("/ack", refusal);
    // Consuming the request above also flushes the adapter's promise continuation.
    expect(receipts.some(receipt => receipt.state === "failed_safe")).toBe(true);
    expect(receipts.some(receipt => receipt.state === "accepted" || receipt.state === "completed")).toBe(false);
    expect(f.peer.state).toBe("offline"); expect(f.peer.acceptingTools).toBe(false);
    expect(processSignature(f.owner.pid)).toBeDefined(); expect(f.peer.tuiLaunch).toBe(f.launch);
    expect(bus.queued("pi")).toBe(1); expect((f.peer as any).tuiQueue).toEqual([]);
    expect(journal.list().some(row => row.state === "completed")).toBe(false);
  } finally { bus.closeJournal(); await f.cleanup(); }
});

test("Pi roster return refuses a legacy owner without native prompt admission proof (#379)", async () => {
  const f = await rosterPiFixture(undefined, { fencedPrompt: false });
  try {
    await f.peer.detachForRoster();
    await expect(f.peer.resumeFromRoster()).rejects.toThrow("fenced-prompt extension");
    expect(f.peer.state).toBe("offline"); expect(f.peer.acceptingTools).toBe(false);
    expect((f.peer as any).tuiQueue).toEqual([]); expect(processSignature(f.owner.pid)).toBeDefined();
  } finally { await f.cleanup(); }
});

test("real Pi extension treats a deferred native insertion as uncertain and never lends its lineage to a personal start (#379)", async () => {
  const refused = barrier(), started = barrier();
  const acks: any[] = [], events: any[] = [];
  let command = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/commands") {
      if (command++ === 0) return Response.json({ command: { id: "deferred", type: "prompt", sessionId: "prompt-session", generation: 0, message: "deferred hub work" } });
      await started.promise;
      return Response.json({ command: { id: "shutdown", type: "shutdown" } });
    }
    const body = await request.json() as any;
    if (path === "/event") { events.push(body); if (body.type === "agent_start") started.release(); }
    if (path === "/ack") { acks.push(body); if (body.id === "deferred") refused.release(); }
    return Response.json({ ok: true });
  } });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-prompt-admission-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "deferred"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture", AGENTHUB_PI_TOOLS: "[]" },
  });
  try {
    await refused.promise; proc.stdin.write("start\n"); await proc.stdin.flush();
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe(""); expect(JSON.parse(out.trim())).toEqual({ sent: 1 });
    expect(acks.find(ack => ack.id === "deferred")).toMatchObject({ ok: false, refusal: { kind: "prompt_uncertain", promptId: "deferred", sessionId: "prompt-session", generation: 0 } });
    expect(events.find(event => event.type === "agent_start")).not.toHaveProperty("promptId");
  } finally { started.release(); if (proc.exitCode === null) { proc.kill(); await proc.exited; } server.stop(true); }
}, 10_000);

test("real Pi extension admits the ordinary queued successor while its prior settled POST is finishing (#379)", async () => {
  const firstSettled = barrier(), releaseSettled = barrier();
  const acks: any[] = [], starts: any[] = [];
  let command = 0, settlements = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/commands") {
      const index = command++;
      if (index === 1) { await firstSettled.promise; releaseSettled.release(); }
      return Response.json({ command: index < 2
        ? { id: `prompt-${index}`, type: "prompt", sessionId: "prompt-session", generation: index, message: "queued work" }
        : { id: "shutdown", type: "shutdown" } });
    }
    const body = await request.json() as any;
    if (path === "/event" && body.type === "agent_start") starts.push(body);
    if (path === "/event" && body.type === "agent_settled" && settlements++ === 0) { firstSettled.release(); await releaseSettled.promise; }
    if (path === "/ack") acks.push(body);
    return Response.json({ ok: true });
  } });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-prompt-admission-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "sequential"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture", AGENTHUB_PI_TOOLS: "[]" },
  });
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe(""); expect(JSON.parse(out.trim())).toEqual({ sent: 2 });
    expect(acks.filter(ack => ack.id.startsWith("prompt-"))).toEqual([{ id: "prompt-0", ok: true }, { id: "prompt-1", ok: true }]);
    expect(starts.map(event => event.promptId)).toEqual(["prompt-0", "prompt-1"]);
  } finally { firstSettled.release(); releaseSettled.release(); if (proc.exitCode === null) { proc.kill(); await proc.exited; } server.stop(true); }
}, 10_000);

for (const mismatch of ["session", "command", "generation", "generic"] as const) test(`Pi ${mismatch} refusal evidence cannot settle a personal-turn conflict as failed_safe (#379)`, async () => {
  const f = await rosterPiFixture();
  const receipts: any[] = []; f.peer.onDelivery = receipt => receipts.push(receipt);
  try {
    const delivering = f.peer.deliver([newEnvelope("user", "pending hub work")], "delivery");
    const prompt = await f.next();
    await f.post("/event", { type: "agent_start", generation: 1, sessionId: f.sessionId });
    const refusal = { kind: "prompt_not_started", promptId: mismatch === "command" ? "other" : prompt.id, sessionId: mismatch === "session" ? "other" : f.sessionId, generation: mismatch === "generation" ? -1 : 1 };
    await f.post("/ack", { id: prompt.id, ok: false, error: "prompt_not_started", ...(mismatch === "generic" ? {} : { refusal }) });
    await delivering;
    expect(receipts.map(receipt => receipt.state)).toEqual(["needs_review"]);
    expect(f.peer.state).toBe("offline"); expect(f.peer.acceptingTools).toBe(false); expect(processSignature(f.owner.pid)).toBeDefined();
  } finally { await f.cleanup(); }
});

test("Pi latches fenced prompt capability and holds an accepted delivery when personal activity replaces it (#379)", async () => {
  const f = await rosterPiFixture();
  const receipts: any[] = [], messages: string[] = [];
  f.peer.onDelivery = receipt => receipts.push(receipt); f.peer.onMessage = message => messages.push(message);
  try {
    await f.post("/event", { type: "session_start", ownerToken: f.launch.env.AGENTHUB_PI_OWNER_TOKEN, pid: f.owner.pid, signature: processSignature(f.owner.pid), sessionId: f.sessionId, sessionFile: f.sessionFile, fencedPrompt: false });
    const delivering = f.peer.deliver([newEnvelope("user", "accepted hub work")], "delivery");
    const prompt = await f.next(); expect(prompt.sessionId).toBe(f.sessionId); expect(prompt.generation).toBe(0);
    await f.ack(prompt); await delivering;
    await f.post("/event", { type: "agent_start", generation: 1, sessionId: f.sessionId, promptId: prompt.id });
    await f.post("/event", { type: "agent_start", generation: 2, sessionId: f.sessionId, promptId: null });
    await f.post("/event", { type: "agent_settled", generation: 2, sessionId: f.sessionId, promptId: null, text: "personal secret" });
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "needs_review"]); expect(messages).toEqual([]);
    expect(f.peer.state).toBe("offline"); expect(f.peer.acceptingTools).toBe(false); expect(processSignature(f.owner.pid)).toBeDefined();
  } finally { await f.cleanup(); }
});

test("fresh Pi roster verification retires old prompt lineage before any new queued delivery (#379)", async () => {
  const f = await rosterPiFixture();
  const messages: string[] = [], receipts: any[] = [];
  f.peer.onMessage = message => messages.push(message); f.peer.onDelivery = receipt => receipts.push(receipt);
  try {
    const original = f.peer.deliver([newEnvelope("user", "old work")], "old-delivery");
    const old = await f.next(); await f.ack(old); await original;
    await f.post("/event", { type: "agent_start", generation: 1, promptId: old.id });
    await f.peer.detachForRoster(); await f.resume(true);
    expect(f.peer.state).toBe("idle"); expect((f.peer as any).tuiQueue).toEqual([]);
    const settledReceipts = receipts.slice();
    for (const type of ["agent_start", "agent_end", "agent_settled"]) {
      await f.post("/event", { type, generation: 1, promptId: old.id, text: "late old output" });
      expect(f.peer.state).toBe("idle"); expect(messages).toEqual([]); expect(receipts).toEqual(settledReceipts);
    }
    const successor = f.peer.deliver([newEnvelope("user", "new work")], "new-delivery");
    const next = await f.next(); await f.ack(next); await successor;
    await f.post("/event", { type: "agent_start", generation: 2, promptId: next.id });
    await f.post("/event", { type: "agent_settled", generation: 2, promptId: next.id, text: "new answer" });
    expect(messages).toEqual(["new answer"]);
    expect(receipts.filter(receipt => receipt.id === "new-delivery").map(receipt => receipt.state)).toEqual(["accepted", "completed"]);
    expect(f.peer.state).toBe("idle");
  } finally { await f.cleanup(); }
});
