// Fake `codex app-server` (v2 shapes from codex-cli 0.154.0 generate-json-schema). One thread, echo turns.
export function startFakeAppServer(
  delayMs = 30,
  port = 0,
  onRevert?: (params: { threadId: string; beforeTurnId: string }) => void,
  usedPercent = 93,
) {
  let turnSeq = 0;
  let threadTotal = 0; // the thread's running token total, as Codex keeps it
  const usage = (n: number) => ({ totalTokens: n, inputTokens: n - 10, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 });
  let active = false;
  let activeTurnId = "";
  let steered: string[] = [];
  const reverted: { threadId: string; beforeTurnId: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
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
        if (msg.method === "account/rateLimits/read") return reply({ rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null } });
        if (msg.method === "thread/revert") {
          reverted.push(msg.params);
          onRevert?.(msg.params);
          reply({ thread: { id: msg.params.threadId, turns: [] }, itemsBackwardsCursor: null, turnsBackwardsCursor: null });
          return note("thread/reverted", { threadId: msg.params.threadId });
        }
        if (msg.method === "turn/steer") {
          if (!active || msg.params.expectedTurnId !== activeTurnId) {
            return void ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "no active turn to steer" } }));
          }
          if (msg.params.input[0].text.includes("SILENT")) return; // app-server that never answers the steer
          steered.push(msg.params.input[0].text.split("\n").at(-1));
          reply({ turnId: activeTurnId });
          // As app-server 0.159 does: the steered input becomes a user message item of the running turn.
          return note("item/completed", { threadId: msg.params.threadId, turnId: activeTurnId, completedAtMs: Date.now(), item: { type: "userMessage", id: `u${steered.length}`, content: msg.params.input } });
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
        if (text.includes("EDIT:")) {
          // A real patch (issue #108): one line appended to the file, reported with a diff that matches it.
          const path = /EDIT:(\S+)/.exec(text)![1]!;
          const before = await Bun.file(path).text();
          await Bun.write(path, `${before}codex line\n`);
          const n = before.split("\n").length - 1;
          note("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { type: "fileChange", id: "f2", status: "completed", changes: [{ path, kind: { type: "update", move_path: null }, diff: `@@ -${n} +${n},2 @@\n+codex line` }] } });
          await Bun.sleep(delayMs); // room for a steer from the item handler
        }
        if (text.includes("ITEMS")) {
          // Tool items as Codex 0.159 reports them (issue #108): a patch, then a read the CLI parsed into an action.
          // `ITEMS:<path>` names the file both items are about; the patch itself is up to the test.
          const path = /ITEMS:(\S+)/.exec(text)?.[1];
          note("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: path ?? "/abs/src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" }] } });
          note("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { type: "commandExecution", id: "c1", status: "completed", command: "sed -n 1,5p src/b.ts", commandActions: [{ type: "read", command: "sed -n 1,5p src/b.ts", name: "b.ts", path: path ?? "/abs/src/b.ts" }] } });
          await Bun.sleep(delayMs); // room for a steer from the item handler
        }
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
