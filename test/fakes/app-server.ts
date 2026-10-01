// Fake `codex app-server` (v2 shapes from codex-cli 0.154.0 generate-json-schema). One thread, echo turns.
export function startFakeAppServer(delayMs = 30) {
  let turnSeq = 0;
  let threadTotal = 0; // the thread's running token total, as Codex keeps it
  const usage = (n: number) => ({ totalTokens: n, inputTokens: n - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 });
  let active = false;
  let activeTurnId = "";
  let steered: string[] = [];
  const reverted: { threadId: string; beforeTurnId: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/healthz") return new Response("ok");
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      async message(ws, data) {
        const msg = JSON.parse(String(data));
        const reply = (result: unknown) => void ws.send(JSON.stringify({ id: msg.id, result }));
        const note = (method: string, params: unknown) => void ws.send(JSON.stringify({ method, params }));
        if (msg.method === "initialize") return reply({ userAgent: "fake-codex/0.154.0" });
        if (msg.method === "thread/start") return (threadTotal = 0), reply({ thread: { id: "th1" }, model: "fake" });
        if (msg.method === "thread/resume") {
          // A thread with 5000 tokens of history; Codex 0.156 replays its saved usage to the connection that attaches.
          threadTotal = 5000;
          reply({ thread: { id: msg.params.threadId }, model: "fake" });
          return note("thread/tokenUsage/updated", { threadId: msg.params.threadId, turnId: "old", tokenUsage: { total: usage(threadTotal), last: usage(800) } });
        }
        if (msg.method === "account/rateLimits/read") return reply({ rateLimits: { primary: { usedPercent: 93, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null } });
        if (msg.method === "thread/revert") {
          reverted.push(msg.params);
          reply({ thread: { id: msg.params.threadId, turns: [] }, itemsBackwardsCursor: null, turnsBackwardsCursor: null });
          return note("thread/reverted", { threadId: msg.params.threadId });
        }
        if (msg.method === "turn/steer") {
          if (!active || msg.params.expectedTurnId !== activeTurnId) {
            return void ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }));
          }
          if (msg.params.input[0].text.includes("SILENT")) return; // app-server that never answers the steer
          steered.push(msg.params.input[0].text.split("\n").at(-1));
          return reply({ turnId: activeTurnId });
        }
        if (msg.method !== "turn/start") return;
        if (active) return void ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "turn in progress" } }));
        active = true;
        const turn = { id: `turn${++turnSeq}`, items: [], status: "inProgress" };
        activeTurnId = turn.id;
        steered = [];
        const threadId = msg.params.threadId;
        const text: string = msg.params.input[0].text.split("\n").at(-1);
        if (text.includes("QUOTA")) {
          // what a limited account does: refuse the turn
          reply({ turn });
          note("turn/started", { threadId, turn });
          note("account/rateLimits/updated", { rateLimits: { primary: null, secondary: null, rateLimitReachedType: "usageLimitExceeded" } });
          note("error", { error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" }, willRetry: false, threadId, turnId: turn.id });
          active = false;
          return note("turn/completed", { threadId, turn: { ...turn, status: "failed", error: { message: "usage limit" } } });
        }
        reply({ turn });
        note("turn/started", { threadId, turn });
        await Bun.sleep(delayMs);
        const item = (id: string, phase: string, t: string) =>
          note("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { type: "agentMessage", id, phase, text: t } });
        item("m1", "commentary", "thinking out loud");
        item("m2", "final_answer", `echo: ${text}${steered.map((s) => ` +steered: ${s}`).join("")}`);
        // As Codex 0.156 reports it: the thread's running total and what this update added, 100 tokens per turn.
        threadTotal += 100;
        note("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { total: usage(threadTotal), last: usage(100) } });
        // Compaction: an estimate of the retained history in `last`, the total unchanged.
        if (text.includes("COMPACT")) note("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { total: usage(threadTotal), last: usage(4000) } });
        active = false;
        note("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true), reverted };
}
