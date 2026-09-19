// Fake `codex app-server` (v2 shapes from codex-cli 0.154.0 generate-json-schema). One thread, echo turns.
export function startFakeAppServer(delayMs = 30) {
  let turnSeq = 0;
  let active = false;
  let activeTurnId = "";
  let steered: string[] = [];
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
        if (msg.method === "thread/start") return reply({ thread: { id: "th1" }, model: "fake" });
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
        reply({ turn });
        note("turn/started", { threadId, turn });
        await Bun.sleep(delayMs);
        const item = (id: string, phase: string, t: string) =>
          note("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item: { type: "agentMessage", id, phase, text: t } });
        item("m1", "commentary", "thinking out loud");
        item("m2", "final_answer", `echo: ${text}${steered.map((s) => ` +steered: ${s}`).join("")}`);
        active = false;
        note("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
