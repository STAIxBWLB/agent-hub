import { MemoryClient as ProductionMemoryClient } from "../../src/memory/client.ts";

/** Test-only legacy transport. Production MemoryClient never opens this worker URL. */
export class FakeMemoryClient extends ProductionMemoryClient {
  constructor(private readonly fixtureUrl: string, private readonly fixtureTimeoutMs = 2000, private readonly fixtureLog: (line: string) => void = () => {}) { super(); }
  private async fetchFixture<T>(method: "GET" | "POST", route: string, body: unknown, text = false): Promise<T | undefined> {
    try {
      const result = await fetch(`${this.fixtureUrl}${route}`, { method, signal: AbortSignal.timeout(this.fixtureTimeoutMs),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      return (text ? await result.text() : await result.json()) as T;
    } catch (error) { this.fixtureLog(`memory ${method} ${route} dropped: ${(error as Error).message}`); return undefined; }
  }
  request<T = unknown>(method: "GET" | "POST", route: string, body?: unknown): Promise<T | undefined> { return this.fetchFixture(method, route, body); }
  contextInject(chain: string[], platformSource?: string): Promise<string | undefined> {
    return this.fetchFixture("GET", `/api/context/inject?projects=${encodeURIComponent(chain.join(","))}${platformSource ? `&platformSource=${encodeURIComponent(platformSource)}` : ""}`, undefined, true);
  }
  async search(query: string, project: string, limit = 10): Promise<string | undefined> {
    return fixtureText(await this.request("GET", `/api/search?query=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}&limit=${limit}`));
  }
  async timeline(anchor: number | string, project: string, before = 3, after = 3): Promise<string | undefined> {
    return fixtureText(await this.request("GET", `/api/timeline?anchor=${anchor}&project=${encodeURIComponent(project)}&depth_before=${before}&depth_after=${after}`));
  }
  save(note: { text: string; title?: string; project: string; metadata: Record<string, unknown> }): Promise<unknown> { return this.request("POST", "/api/memory/save", note); }
  async health(): Promise<{ ok: boolean; version?: string }> {
    const value = await this.request<{ status?: string; version?: string }>("GET", "/api/health");
    return value?.status === "ok" ? { ok: true, ...(value.version ? { version: value.version } : {}) } : { ok: false };
  }
  appendCapture(event: { project: string; at?: string; agent: string; event: string; tool?: string; paths?: string[]; status?: string; excerpt: string; sessionId?: string; toolUseId?: string; input?: string; output?: string; platformSource?: string; cwd?: string }): Promise<unknown> {
    const common = { contentSessionId: event.sessionId, platformSource: event.platformSource ?? "agent-hub" };
    if (event.event === "SessionStart") return this.request("POST", "/api/sessions/init", { ...common, project: event.project, prompt: event.excerpt });
    if (event.event === "Stop") return this.request("POST", "/api/sessions/summarize", { ...common, last_assistant_message: event.excerpt });
    if (event.event === "SessionEnd") return this.request("POST", "/api/sessions/session-end", { ...common, reason: "hub stop", cwd: event.cwd });
    return this.request("POST", "/api/sessions/observations", { ...common, tool_name: event.tool, tool_input: event.input ?? "", tool_response: event.output ?? event.excerpt,
      cwd: event.cwd, agentId: event.agent, agentType: "local-worker", tool_use_id: event.toolUseId });
  }
}
function fixtureText(result: unknown): string | undefined { return (result as { content?: { type?: string; text?: string }[] } | undefined)?.content?.find(row => row.type === "text")?.text; }

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
