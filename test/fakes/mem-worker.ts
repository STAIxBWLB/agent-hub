// Fake claude-mem worker. Grows endpoint by endpoint with src/memory/client.ts.
const STATUS_PAGE = "# claude-mem status\n\nThis project has no memory yet.\n";

/** `observations`: platform -> observation lines, served by GET /api/context/inject like worker 13.25.1 does. */
export function startFakeMemWorker(observations: Record<string, string[]> = {}) {
  const calls: { method: string; path: string; query: string; body?: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      calls.push({ method: req.method, path: url.pathname, query: url.search, ...(req.method === "POST" ? { body: await req.json() } : {}) });
      if (url.pathname === "/api/health") return Response.json({ status: "ok", version: "13.25.1" });
      if (url.pathname === "/api/context/inject") {
        const chain = (url.searchParams.get("projects") ?? "").split(",");
        const platform = url.searchParams.get("platformSource");
        const lines = Object.entries(observations).flatMap(([p, obs]) => (!platform || platform === p ? obs : []));
        if (!lines.length || chain.includes("nonexistent")) return new Response(STATUS_PAGE);
        return new Response(`# [${chain.at(-1)}] recent context\nLegend: ...\nStats: ...\n\n### Sep 19, 2026\n${lines.join("\n")}\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}
