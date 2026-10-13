import { expect, test } from "bun:test";
import { join } from "node:path";
import { rosterPiFixture } from "./fakes/pi-roster-tui.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

test("real Pi extension keeps prompt lineage across native retry starts until logical settlement (#379)", async () => {
  let finished!: () => void;
  const runsFinished = new Promise<void>(resolve => { finished = resolve; });
  const events: any[] = [];
  let command = 0, settlements = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/commands") {
      if (command++ === 0) return Response.json({ command: { id: "logical-prompt", type: "prompt", sessionId: "continuation-session", generation: 0, message: "hub work" } });
      await runsFinished;
      return Response.json({ command: { id: "shutdown", type: "shutdown" } });
    }
    const body = await request.json() as any;
    if (path === "/event") {
      events.push(body);
      if (body.type === "agent_settled" && ++settlements === 2) finished();
    }
    return Response.json({ ok: true });
  } });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-prompt-continuation-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts")], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "fixture", AGENTHUB_PI_TOOLS: "[]" },
  });
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe(""); expect(JSON.parse(out.trim())).toEqual({ completed: true });
    for (const type of ["agent_start", "agent_end"]) {
      const turns = events.filter(event => event.type === type);
      expect(turns.map(event => event.generation)).toEqual([1, 2, 3]);
      expect(turns.map(event => event.promptId)).toEqual(["logical-prompt", "logical-prompt", undefined]);
    }
    expect(events.filter(event => event.type === "agent_settled").map(event => ({ generation: event.generation, promptId: event.promptId }))).toEqual([
      { generation: 2, promptId: "logical-prompt" }, { generation: 3, promptId: undefined },
    ]);
  } finally { finished(); if (proc.exitCode === null) { proc.kill(); await proc.exited; } server.stop(true); }
}, 10_000);

test("Pi accepted prompt completes one delivery after native retry start/end/start/settled (#379)", async () => {
  const f = await rosterPiFixture();
  const receipts: any[] = [], messages: string[] = [], failures: string[] = [];
  f.peer.onDelivery = receipt => receipts.push(receipt); f.peer.onMessage = message => messages.push(message);
  (f.peer as any).opts.onTurnFailure = async (_envs: unknown, reason: string) => { failures.push(reason); };
  try {
    const delivering = f.peer.deliver([newEnvelope("user", "retry hub work")], "logical-delivery");
    const prompt = await f.next(); await f.ack(prompt); await delivering;
    await f.post("/event", { type: "agent_start", generation: 1, promptId: prompt.id });
    await f.post("/event", { type: "agent_end", generation: 1, promptId: prompt.id, failed: true, error: "retryable failure" });
    expect(f.peer.state).toBe("busy"); expect(messages).toEqual([]); expect(failures).toEqual([]);
    await f.post("/event", { type: "agent_start", generation: 2, promptId: prompt.id });
    expect(f.peer.state).toBe("busy"); expect(f.peer.acceptingTools).toBe(true);
    await f.post("/event", { type: "agent_end", generation: 2, promptId: prompt.id, text: "recovered answer", failed: false });
    await f.post("/event", { type: "agent_settled", generation: 2, promptId: prompt.id });
    expect(messages).toEqual(["recovered answer"]); expect(failures).toEqual([]);
    expect(receipts.map(receipt => receipt.state)).toEqual(["accepted", "completed"]);
    expect(f.peer.state).toBe("idle"); expect((f.peer as any).tuiQueue).toEqual([]);
  } finally { await f.cleanup(); }
});
