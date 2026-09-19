// Fake claude-mem worker. Grows endpoint by endpoint with src/memory/client.ts.
export function startFakeMemWorker() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      calls.push({ method: req.method, path, ...(req.method === "POST" ? { body: await req.json() } : {}) });
      if (path === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}
