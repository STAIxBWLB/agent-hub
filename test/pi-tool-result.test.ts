import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PiPeer } from "../src/adapters/pi.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

// #181: Pi 1.0.1 classifies a native tool result by isError === true alone. The bridge must carry
// the managed-tool failure verdict (toolResultFailed) and the real extension must map it to isError.

test("#181 the Pi /tool bridge answers with the toolResultFailed verdict", async () => {
  const stateDir = mkdtempSync(join(process.cwd(), ".pi-tool-failed-"));
  const peer = new PiPeer("pi", {
    cwd: process.cwd(), stateDir, mode: "headless", backend: "dgx", cmd: ["bun", join(import.meta.dir, "fakes/pi-rpc.ts")],
    relay: { url: "http://127.0.0.1:9/v1", token: "t", models: [{ id: "dgx/coding" }] }, tools: [],
    executeTool: async (name, raw) => {
      const args = raw as { path?: string };
      if (name === "throw") throw new Error("effect lost its reply");
      if (name === "bash") return args.path === "fail" ? "unit exploded\n(exit 1)" : "error: printed by the program itself\n(exit 0)";
      if (name === "git") return "fatal: not a git repository\n(exit 128)";
      if (args.path === "error-line") return "1\terror: legitimate file content";
      if (args.path === "cancelled") return "error: turn cancelled before tool execution";
      if (name === "write") return "error: the user did not approve this write";
      if (name === "edit") return "error: `old` must match exactly once, it matched 0 times";
      return args.path === "secret" ? "error: secret is on the secrets denylist" : "1\tmanaged read";
    },
  });
  try {
    await peer.start();
    await peer.deliver([newEnvelope("user", "run tools", { to: ["pi"] })]);
    const launch = peer.tuiLaunch!;
    const headers = { authorization: `Bearer ${launch.env.AGENTHUB_PI_BRIDGE_TOKEN}`, "content-type": "application/json" };
    const call = async (name: string, args: unknown) => {
      const response = await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/tool`, { method: "POST", headers, body: JSON.stringify({ name, args, toolCallId: `c-${name}-${JSON.stringify(args)}`, sessionId: peer.recoveryMetadata().sessionId, generation: 0 }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ text: string; failed: boolean }>;
    };
    expect(await call("read", { path: "ok" })).toEqual({ text: "1\tmanaged read", failed: false });
    expect(await call("read", { path: "secret" })).toEqual({ text: "error: secret is on the secrets denylist", failed: true });
    expect(await call("write", { path: "denied", content: "replacement" })).toEqual({ text: "error: the user did not approve this write", failed: true });
    expect(await call("edit", { path: "denied", old: "before", new: "after" })).toEqual({ text: "error: `old` must match exactly once, it matched 0 times", failed: true });
    expect(await call("read", { path: "cancelled" })).toEqual({ text: "error: turn cancelled before tool execution", failed: true });
    expect(await call("read", { path: "error-line" })).toEqual({ text: "1\terror: legitimate file content", failed: false });
    // Numbered file text can contain an error-looking line without being a managed failure.
    // Exit status decides for bash/git: legitimate output that merely starts with "error:" is not a failure.
    expect((await call("bash", {})).failed).toBe(false);
    expect((await call("bash", { path: "fail" })).failed).toBe(true);
    expect((await call("git", {})).failed).toBe(true);
    const thrown = await call("throw", {});
    expect(thrown.failed).toBe(true);
    expect(thrown.text).toBe("error: effect lost its reply");
    await fetch(`${launch.env.AGENTHUB_PI_BRIDGE_URL}/event`, { method: "POST", headers, body: JSON.stringify({ type: "agent_settled" }) });
  } finally { await peer.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("#181 the real extension maps the bridge verdict to isError without touching the text", async () => {
  const toolCalls: string[] = [];
  const posts: any[] = [];
  let budgetCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/commands") return Response.json({ command: null });
    const body = await req.json() as any;
    if (path === "/budget") {
      budgetCalls++;
      // The fourth managed-tool execute (toolCallId c4) is refused by the execution budget.
      return Response.json(budgetCalls === 4 ? { decisions: [{ allowed: false, reason: "exhausted", scope: "run:r", unit: "tool_calls", used: 5, limit: 5 }] } : { decisions: [] });
    }
    if (path === "/tool") {
      toolCalls.push(String(body.toolCallId));
      if (body.toolCallId === "c1") return Response.json({ text: "1\tmanaged read", failed: false });
      if (body.toolCallId === "c2") return Response.json({ text: "error: secret is on the secrets denylist", failed: true });
      // Backward compatibility: an older bridge omits `failed`; the result must stay unflagged, as
      // before the fix. The extension never re-parses the text.
      if (body.toolCallId === "c3") return Response.json({ text: "error: legacy bridge without the flag" });
      if (body.toolCallId === "c6") return Response.json({ text: "error: the user did not approve this write", failed: true });
      if (body.toolCallId === "c7") return Response.json({ text: "error: `old` must match exactly once, it matched 0 times", failed: true });
      if (body.toolCallId === "c8") return Response.json({ text: "error: turn cancelled before tool execution", failed: true });
      // A bridge-level failure (owner stopped, stale generation) rejects the request.
      return Response.json({ text: "error: Pi owner is stopped" }, { status: 409 });
    }
    posts.push(body);
    return Response.json({ ok: true });
  } });
  try {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "fakes/pi-extension-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts")], {
      stdout: "pipe", stderr: "pipe",
      env: {
        ...process.env,
        AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`,
        AGENTHUB_PI_BRIDGE_TOKEN: "test-token",
        AGENTHUB_PI_TOOLS: JSON.stringify(["read", "write", "edit"].map(name => ({ name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } }))),
      },
    });
    const [results, stderr] = await Promise.all([
      new Response(proc.stdout).text().then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as any)),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(0);
    expect(stderr).toBe("");
    expect(results.length).toBe(8);

    expect(results[0].isError).not.toBe(true);
    expect(results[0].content).toEqual([{ type: "text", text: "1\tmanaged read" }]);

    expect(results[1].isError).toBe(true);
    expect(results[1].content).toEqual([{ type: "text", text: "error: secret is on the secrets denylist" }]);

    expect(results[2].isError).not.toBe(true);
    expect(results[2].content).toEqual([{ type: "text", text: "error: legacy bridge without the flag" }]);

    // Budget refusal stays a failure and never reaches tool execution: no duplicate side effects.
    expect(results[3].isError).toBe(true);
    expect(results[3].content[0].text).toContain("error: execution budget exhausted: run:r tool_calls used 5 of 5");
    expect(toolCalls).toEqual(["c1", "c2", "c3", "c5", "c6", "c7", "c8"]);
    expect(posts.some((p) => p.type === "agent_end" && p.failed === true && String(p.error).includes("execution budget"))).toBe(true);

    // The thrown bridge error surfaces as a rejected execute; Pi classifies it natively.
    expect(results[4].thrown).toContain("Pi bridge HTTP 409");
    for (const [index, text] of [
      [5, "error: the user did not approve this write"],
      [6, "error: `old` must match exactly once, it matched 0 times"],
      [7, "error: turn cancelled before tool execution"],
    ] as const) {
      expect(results[index].isError).toBe(true);
      expect(results[index].content).toEqual([{ type: "text", text }]);
    }
  } finally { server.stop(true); }
});


test("the real extension forwards native abort and the person's shell exit status without parsing output", async () => {
  let settle: (() => void) | undefined;
  const events: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.json() as any;
    if (path === "/budget") return Response.json({ decisions: [], reservation: "verified-idle-reservation" });
    if (path === "/event") { events.push(body); if (body.type === "tool_abort") settle?.(); return Response.json({ ok: true }); }
    if (body.toolCallId === "native-cancelled") {
      await new Promise<void>((resolve) => { settle = resolve; });
      return Response.json({ text: "error: approval withdrawn because the turn ended; no operation was executed", failed: true });
    }
    expect(body).toMatchObject({ name: "bash", purpose: "idle_user_bash", reservation: "verified-idle-reservation" });
    return Response.json({ text: "(exit 0) is arbitrary program output", exitCode: 7, failed: true });
  } });
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-extension-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "approvals"], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "test-token", AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "read", description: "read", parameters: { type: "object" } }]) },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe("");
    const results = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(results[0]).toMatchObject({ isError: true });
    expect(events).toContainEqual({ type: "tool_abort", sessionId: "", generation: 0, toolCallId: "native-cancelled" });
    expect(results[1].result).toMatchObject({ exitCode: 7, cancelled: false, output: "(exit 0) is arbitrary program output" });
  } finally { settle?.(); server.stop(true); }
}, 10_000);


test("the real extension pins tool session and generation before an awaited budget reply", async () => {
  const tools: any[] = [];
  const starts: number[] = [], budgets: number[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/commands") { await Bun.sleep(25); return Response.json({ command: null }); }
    const body = await req.json() as any;
    if (path === "/event") { if (body.type === "agent_start") starts.push(body.generation); return Response.json({ ok: true }); }
    if (path === "/budget") { budgets.push(body.generation); if (budgets.length > 1) { await Bun.sleep(100); return Response.json({ decisions: [{ allowed: false, reason: "exhausted", scope: "run:test", unit: "tool_calls", used: 1, limit: 1 }] }); } return Response.json({ decisions: [] }); }
    tools.push(body); return Response.json({ text: "ok", failed: false });
  } });
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fakes/pi-extension-driver.ts"), join(import.meta.dir, "../src/pi/extension.ts"), "lineage"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${server.port}`, AGENTHUB_PI_BRIDGE_TOKEN: "test-token", AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "read", description: "read", parameters: { type: "object" } }]) } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0); expect(err).toBe("");
    expect(starts).toEqual([1, 2]); expect(budgets).toEqual([1, 1]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "read", toolCallId: "initial-lineage", sessionId: "producer-session", generation: 1 });
    const results = out.trim().split("\n").map((line) => JSON.parse(line));
    expect(results[0].isError).not.toBe(true);
    expect(results[1].isError).toBe(true);
    expect(results[1].content[0].text).toContain("lineage ended during admission");
  } finally { server.stop(true); }
}, 10_000);
