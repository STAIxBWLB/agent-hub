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
      if (url.pathname === "/api/search") {
        const q = (url.searchParams.get("query") ?? "").toLowerCase();
        const rows = Object.values(observations).flat().filter((line) => q.split(/\s+/).some((w) => w.length > 3 && line.toLowerCase().includes(w)));
        return Response.json({ content: [{ type: "text", text: `Found ${rows.length} result(s)\n\n| ID | Time | T | Title | Read |\n|----|------|---|-------|------|\n${rows.map((r) => { const [id, time, type, ...title] = r.split(" "); return `| #${id} | ${time} | ${type} | ${title.join(" ")} | ~100 |`; }).join("\n")}\n` }] });
      }
      if (url.pathname === "/api/timeline") {
        const anchor = url.searchParams.get("anchor");
        return Response.json({ content: [{ type: "text", text: `# Timeline around anchor: ${anchor}\n| ID | Time | T | Title | Tokens |\n|----|------|---|-------|--------|\n| #${anchor} | 10:00a | decision | anchor row <- **ANCHOR** | ~80 |\n| #${Number(anchor) + 1} | 10:01a | change | neighbour of ${anchor} | ~50 |\n` }] });
      }
      if (url.pathname === "/api/memory/save") return Response.json({ status: "saved", id: calls.length });
      if (url.pathname === "/api/sessions/summarize" && (calls.at(-1)!.body as any)?.agentId) {
        return Response.json({ status: "skipped", reason: "subagent_context" }); // what worker 13.25.1 does
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/sessions/")) return Response.json({ status: "queued" });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}
