import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiPeer, type PiOptions } from "../src/adapters/pi.ts";
import { piToolStepCeiling, type PiToolStepCeiling } from "../src/pi/ceiling.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import type { DeliveryReceipt } from "../src/hub/peers.ts";

// #179: the extension's tool-step ceiling is a structured bridge signal, validated and bound by the
// adapter, carried through onTurnFailure; the real extension emits it at the actual rejection boundary.

test("#179 piToolStepCeiling validates the fixed shape and rejects arbitrary lookalikes", () => {
  const ok: PiToolStepCeiling = { kind: "tool-step-ceiling", unit: "tool-step", count: 101, limit: 100, sessionId: "s1", generation: 3 };
  expect(piToolStepCeiling(ok)).toEqual(ok);
  const bad: unknown[] = [
    undefined, null, "tool-step-ceiling", {},
    { ...ok, kind: "loop-protection" }, // another class's kind
    { ...ok, unit: "tool_calls" }, // the shared execution-budget unit is a different signal (#102)
    { ...ok, count: 100 }, // a rejection means the counted counter passed the limit
    { ...ok, count: 0 }, { ...ok, count: -1 }, { ...ok, count: 100.5 }, { ...ok, count: "101" },
    { ...ok, limit: -1 }, { ...ok, limit: Number.MAX_SAFE_INTEGER + 1 },
    { ...ok, sessionId: "" }, { ...ok, sessionId: 7 },
    { ...ok, generation: -1 }, { ...ok, generation: 1.5 },
    { type: "agent_end", error: "Pi tool step limit 100 reached" }, // free text never parses
  ];
  for (const value of bad) expect(piToolStepCeiling(value)).toBeUndefined();
});

test("#179 the adapter carries only a session/turn-bound ceiling signal into onTurnFailure", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-ceiling-"));
  const turns: { reason: string; ceiling?: PiToolStepCeiling }[] = [];
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool: async () => "ok",
    onTurnFailure: async (_envs, reason, ceiling) => { turns.push({ reason, ...(ceiling ? { ceiling } : {}) }); },
  });
  try {
    await peer.start();
    const sessionId = String(peer.recoveryMetadata().sessionId);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const post = (path: string, body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const ceilingEvent = (generation: number, over: Partial<Record<string, unknown>> = {}) => ({ type: "ceiling", kind: "tool-step-ceiling", unit: "tool-step", count: 101, limit: 100, sessionId, generation, ...over });
    const runTurn = async (generation: number, events: unknown[] = []) => {
      await peer.deliver([newEnvelope("user", `turn ${generation}`, { to: ["pi"] })]);
      await post("/event", { type: "agent_start", generation });
      for (const event of events) await post("/event", event);
      await post("/event", { type: "agent_end", generation, failed: true, error: `Pi tool step limit 100 reached` });
      await post("/event", { type: "agent_settled", generation });
    };

    // A valid signal bound to this session and turn generation reaches the failure report. A second
    // signal in the same turn (the counter kept counting rejected calls) never overwrites the first.
    await runTurn(1, [ceilingEvent(1), ceilingEvent(1, { count: 102 })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.reason).toBe("Pi tool step limit 100 reached");
    expect(turns[0]!.ceiling).toEqual({ kind: "tool-step-ceiling", unit: "tool-step", count: 101, limit: 100, sessionId, generation: 1 });

    // Stale generation, cross-session, schema-invalid and unbound (no agent_start) signals drop; the
    // failure reports with no ceiling, exactly as before #179.
    await runTurn(2, [ceilingEvent(1)]); // generation 1 while the turn is 2: stale
    expect(turns[1]!.ceiling).toBeUndefined();
    await runTurn(3, [ceilingEvent(3, { sessionId: "other-session" })]); // a different session's signal
    expect(turns[2]!.ceiling).toBeUndefined();
    await runTurn(4, [ceilingEvent(4, { count: 100 })]); // count did not pass the limit: not a rejection
    expect(turns[3]!.ceiling).toBeUndefined();
    await peer.deliver([newEnvelope("user", "unbound turn", { to: ["pi"] })]);
    await post("/event", ceilingEvent(4)); // no agent_start: no running turn owns it
    await post("/event", { type: "agent_end", failed: true, error: "Pi tool step limit 100 reached" });
    await post("/event", { type: "agent_settled" });
    expect(turns[4]!.ceiling).toBeUndefined();

    // A signal beside a turn that then settles clean is never reported, and never leaks into the next turn.
    await peer.deliver([newEnvelope("user", "clean turn", { to: ["pi"] })]);
    await post("/event", { type: "agent_start", generation: 5 });
    await post("/event", ceilingEvent(5));
    await post("/event", { type: "agent_end", generation: 5, text: "recovered" });
    await post("/event", { type: "agent_settled", generation: 5 });
    expect(turns).toHaveLength(5);
    await runTurn(6);
    expect(turns[5]!.ceiling).toBeUndefined();
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}, 30_000);


async function settlementFixture(executeTool: PiOptions["executeTool"] = async () => "ok") {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-ceiling-settlement-"));
  const failures: { reason: string; ceiling?: PiToolStepCeiling; settledCeiling?: boolean }[] = [];
  const aborted: string[][] = [], successes: string[][] = [], receipts: DeliveryReceipt[] = [];
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [], executeTool,
    onTurnFailure: async (_envs, reason, ceiling, settledCeiling) => { failures.push({ reason, ceiling, settledCeiling }); },
    onTurnAborted: envs => { aborted.push(envs.map(env => env.id)); },
    onTurnSuccess: envs => { successes.push(envs.map(env => env.id)); },
  });
  peer.onDelivery = receipt => { receipts.push(receipt); };
  const close = async () => { try { await peer.stop(); } finally { rmSync(stateDir, { recursive: true, force: true }); } };
  try { await peer.start(); } catch (error) { await close(); throw error; }
  const sessionId = String(peer.recoveryMetadata().sessionId), launch = peer.tuiLaunch!;
  const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const event = (body: object) => post("/event", body);
  const start = async (generation: number) => {
    const env = newEnvelope("user", `turn ${generation}`, { to: ["pi"] });
    await peer.deliver([env], `delivery-${generation}`);
    await event({ type: "agent_start", generation });
    return env;
  };
  const ceiling = (generation: number) => event({ type: "ceiling", kind: "tool-step-ceiling", unit: "tool-step", count: 101, limit: 100, sessionId, generation });
  const end = async (generation: number, fields: object = {}) => {
    await event({ type: "agent_end", generation, ...fields });
    await event({ type: "agent_settled", generation });
  };
  return { peer, post, event, start, ceiling, end, close, sessionId, failures, aborted, successes, receipts };
}

test("#1447 a settled ceiling completes its delivery as a limit, never as success; model errors stay held", async () => {
  const f = await settlementFixture();
  try {
    await f.start(1); await f.ceiling(1);
    await f.end(1, { failed: true, error: "Operation aborted" });
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]).toMatchObject({ reason: "Operation aborted", settledCeiling: true, ceiling: { count: 101, limit: 100 } });
    expect(f.receipts.at(-1)).toEqual({ id: "delivery-1", state: "completed", reason: "ceiling steps 101/100" });
    expect(f.successes).toEqual([]); expect(f.aborted).toEqual([]);
    await f.start(2); await f.end(2, { failed: true, error: "provider failed" });
    expect(f.failures[1]).toMatchObject({ reason: "provider failed", settledCeiling: false });
    expect(f.failures[1]?.ceiling).toBeUndefined();
    expect(f.receipts.at(-1)?.state).toBe("needs_review");
    expect(f.successes).toEqual([]); expect(f.aborted).toEqual([]);
  } finally { await f.close(); }
  expect(f.aborted).toEqual([]); // Failure teardown must not add a second aborted class.
}, 30_000);

test("#1447 duplicate terminal events do not report the same logical turn twice", async () => {
  const f = await settlementFixture();
  try {
    await f.start(1); await f.ceiling(1); await f.end(1, { failed: true, error: "Operation aborted" });
    expect(f.failures).toHaveLength(1);
    const receipts = f.receipts.length;
    await f.end(1, { failed: true, error: "duplicate failure" });
    expect(f.failures).toHaveLength(1); expect(f.receipts).toHaveLength(receipts);
    const next = newEnvelope("user", "next prompt before native start", { to: ["pi"] });
    await f.peer.deliver([next], "delivery-next-pending");
    await f.end(1, { failed: true, error: "old failure after new delivery" });
    expect(f.failures).toHaveLength(1); expect(f.receipts).toHaveLength(receipts);
    await f.event({ type: "agent_start", generation: 2 }); await f.end(2, { text: "done" });
    expect(f.successes).toHaveLength(1);
    await f.end(2, { failed: true, error: "late error after success" });
    expect(f.failures).toHaveLength(1); expect(f.successes).toHaveLength(1);
    await f.start(3); await f.end(3, { failed: true, error: "new generation" });
    expect(f.failures).toHaveLength(2);
  } finally { await f.close(); }
}, 30_000);

test("#1447 internal failure teardown reports one failure without an aborted observation", async () => {
  const f = await settlementFixture();
  try {
    await f.start(1);
    await f.peer.stop(undefined, undefined, "failure");
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]?.ceiling).toBeUndefined();
    expect(f.receipts.at(-1)?.state).toBe("needs_review");
    expect(f.aborted).toEqual([]); expect(f.successes).toEqual([]);
  } finally { await f.close(); }
  expect(f.failures).toHaveLength(1); expect(f.aborted).toEqual([]);
}, 30_000);

test("#1447 a tool pending when the ceiling lands remains unsafe even if it settles before agent_settled", async () => {
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await settlementFixture(async () => { entered(); await held; return "ok"; });
  try {
    await f.start(1);
    const tool = f.post("/tool", { name: "read", args: {}, toolCallId: "pending", sessionId: f.sessionId, generation: 1 }).then(response => response.json());
    await began; await f.ceiling(1); release(); await tool;
    await f.end(1, { failed: true, error: "Operation aborted" });
    expect(f.failures[0]).toMatchObject({ settledCeiling: false, ceiling: { count: 101, limit: 100 } });
    expect(f.receipts.at(-1)?.state).toBe("needs_review");
    expect(f.successes).toEqual([]);
  } finally { release(); await f.close(); }
}, 30_000);

test("#1447 explicit cancellation is observed once and prevents a ceiling continuation", async () => {
  const f = await settlementFixture();
  try {
    const cancelled = await f.start(1); await f.ceiling(1);
    await f.end(1, { failed: true, error: "Operation aborted", cancelled: true });
    await f.event({ type: "agent_settled", generation: 1 });
    expect(f.aborted).toEqual([[cancelled.id]]);
    expect(f.failures).toEqual([]); expect(f.successes).toEqual([]);
    expect(f.receipts.at(-1)?.state).toBe("needs_review");
    const success = await f.start(2); await f.end(2, { text: "finished" });
    expect(f.successes).toEqual([[success.id]]);
    const next = await f.start(3); await f.end(3, { cancelled: true });
    expect(f.aborted).toEqual([[cancelled.id], [next.id]]);
  } finally { await f.close(); }
  expect(f.aborted).toHaveLength(2);
}, 30_000);

test("#1447 stop concurrent with a ceiling holds the delivery and observes aborted only once", async () => {
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await settlementFixture(async () => { entered(); await held; return "ok"; });
  try {
    const env = await f.start(1); await f.ceiling(1);
    const tool = f.post("/tool", { name: "read", args: {}, toolCallId: "pending-stop", sessionId: f.sessionId, generation: 1 }).then(response => response.json());
    await began;
    const stopping = f.peer.stop("recovery");
    await f.end(1, { failed: true, error: "Operation aborted" });
    expect(f.receipts.at(-1)?.state).toBe("needs_review");
    expect(f.aborted).toEqual([[env.id]]); expect(f.failures).toEqual([]); expect(f.successes).toEqual([]);
    release(); await tool; await stopping;
    await f.peer.stop("recovery");
    expect(f.aborted).toEqual([[env.id]]); expect(f.failures).toEqual([]);
  } finally { release(); await f.close(); }
}, 30_000);

test("#179 the real extension emits the validated signal at the ceiling, and refused calls never execute", async () => {
  const toolCalls: string[] = [];
  const posts: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/commands") return Response.json({ command: null });
    const body = await req.json() as any;
    if (path === "/budget") return Response.json({ decisions: [] });
    if (path === "/tool") {
      expect(body.sessionId).toBe("sess-ceiling");
      expect(Number.isSafeInteger(body.generation)).toBe(true);
      toolCalls.push(String(body.toolCallId));
      // c2 fails as a tool result (#181): a failed tool call still counts as a tool-step.
      return Response.json(body.toolCallId === "c2" ? { text: "error: read denied", failed: true } : { text: "ok", failed: false });
    }
    posts.push(body);
    return Response.json({ ok: true });
  } });
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fakes/pi-ceiling-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "4"], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`,
        AGENTHUB_PI_BRIDGE_TOKEN: "test-token",
        AGENTHUB_PI_MAX_STEPS: "2",
        AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }]),
      },
    });
    const [results, stderr] = await Promise.all([
      new Response(proc.stdout).text().then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as any)),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(results.length).toBe(4);

    // Below and at the limit the calls execute; beyond it they are refused, with isError set.
    expect(results[0].isError).not.toBe(true);
    expect(results[1].isError).toBe(true); // the failed c2: counted, and its failure is flagged
    expect(results[2].isError).toBe(true);
    expect(results[3].isError).toBe(true);
    expect(results[2].content[0].text).toBe("error: Pi tool step limit 2 reached");
    expect(results[3].content[0].text).toBe("error: Pi tool step limit 2 reached");
    // The refused pre-effect invocations never reached the bridge: no refused side effect executed.
    expect(toolCalls).toEqual(["c1", "c2"]);

    // The structured signal at the rejection boundary: fixed kind/unit, the producer counter already
    // counting the rejected invocation (limit + 1 on the first rejection), bound to session and turn.
    const ceilings = posts.filter((p) => p.type === "ceiling").map((p) => piToolStepCeiling(p));
    expect(ceilings).toEqual([
      { kind: "tool-step-ceiling", unit: "tool-step", count: 3, limit: 2, sessionId: "sess-ceiling", generation: 1 },
      { kind: "tool-step-ceiling", unit: "tool-step", count: 4, limit: 2, sessionId: "sess-ceiling", generation: 1 },
    ]);
    expect(posts.some((p) => p.type === "agent_end" && p.failed === true && p.error === "Pi tool step limit 2 reached")).toBe(true);
  } finally { server.stop(true); }
}, 30_000);

test("#179 shared-budget admission precedes the ceiling counter and a new producer turn resets it", async () => {
  const toolCalls: string[] = [];
  const posts: any[] = [];
  let budgetCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/commands") return Response.json({ command: null });
    const body = await req.json() as any;
    if (path === "/budget") {
      budgetCalls++;
      // Two executions consumed the legacy ceiling. The third invocation is refused BEFORE that
      // counter is consulted; the next admitted invocation must reject at count 3, not 4 or 1.
      return Response.json(budgetCalls === 3
        ? { decisions: [{ allowed: false, reason: "exhausted", scope: "run:r", unit: "tool_calls", used: 2, limit: 2 }] }
        : { decisions: [] });
    }
    if (path === "/tool") {
      expect(body.sessionId).toBe("sess-ceiling");
      expect(Number.isSafeInteger(body.generation)).toBe(true);
      toolCalls.push(String(body.toolCallId));
      return Response.json(body.toolCallId === "t1-c2" ? { text: "error: read denied", failed: true } : { text: "ok", failed: false });
    }
    posts.push({ ...body, budgetCallsAtPost: budgetCalls });
    return Response.json({ ok: true });
  } });
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fakes/pi-ceiling-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "0", "reset-budget"], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`,
        AGENTHUB_PI_BRIDGE_TOKEN: "test-token",
        AGENTHUB_PI_MAX_STEPS: "2",
        AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }]),
      },
    });
    const [results, stderr] = await Promise.all([
      new Response(proc.stdout).text().then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as any)),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(results).toHaveLength(7);
    expect(budgetCalls).toBe(7);
    expect(toolCalls).toEqual(["t1-c1", "t1-c2", "t2-c1", "t2-c2"]);
    expect(results[0].isError).toBe(false);
    expect(results[1].isError).toBe(true); // Failed executions still count.
    expect(results[2].isError).toBe(true);
    expect(results[2].content[0].text).toContain("error: execution budget exhausted:");
    expect(results[3].content[0].text).toBe("error: Pi tool step limit 2 reached");
    expect(results[4].isError).toBe(false);
    expect(results[5].isError).toBe(false); // Both executions fit after agent_start resets the counter.
    expect(results[6].isError).toBe(true);
    expect(results[6].content[0].text).toBe("error: Pi tool step limit 2 reached");

    const ceilings = posts.filter(p => p.type === "ceiling");
    expect(ceilings.map(piToolStepCeiling)).toEqual([
      { kind: "tool-step-ceiling", unit: "tool-step", count: 3, limit: 2, sessionId: "sess-ceiling", generation: 1 },
      { kind: "tool-step-ceiling", unit: "tool-step", count: 3, limit: 2, sessionId: "sess-ceiling", generation: 2 },
    ]);
    expect(ceilings.map(p => p.budgetCallsAtPost)).toEqual([4, 7]);
    expect(posts.filter(p => p.type === "agent_start").map(p => p.generation)).toEqual([1, 2]);
    expect(posts.some(p => p.type === "agent_end" && p.generation === 1 && p.budgetCallsAtPost === 3 && p.failed === true && String(p.error).includes("execution budget"))).toBe(true);
    // The producer also resets its forced failure; a clean end in generation 2 reports success.
    expect(posts.some(p => p.type === "agent_end" && p.generation === 2 && p.budgetCallsAtPost === 6 && p.failed === false && p.text === "new turn succeeded")).toBe(true);
  } finally { server.stop(true); }
}, 30_000);
