import { randomBytes, timingSafeEqual } from "node:crypto";
import type { HubTool } from "../hub/hub-tools.ts";
import { sanitize } from "../hub/envelope.ts";

export type ReviewerToolName = "hub_review" | "hub_task_show";
export interface ReviewerMcpSession { config: string; close(): void }
export interface ReviewerMcpOptions {
  task: number;
  current(): boolean;
  tools: readonly HubTool[];
  /** Fixed host port; the host still applies Tasks' role, privacy, head and running-child fences. */
  call(name: ReviewerToolName, args: Record<string, unknown>): Promise<string>;
}
const NAMES: readonly ReviewerToolName[] = ["hub_review", "hub_task_show"];
const BODY_CAP = 256 * 1024, RESULT_CAP = 4 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One revocable review capability. This server never reads a daemon control token or accepts a peer/role. */
export function createReviewerMcpSession(options: ReviewerMcpOptions): ReviewerMcpSession {
  if (!Number.isSafeInteger(options.task) || options.task < 1) throw new Error("reviewer MCP needs a task");
  const tools = NAMES.map(name => {
    const tool = options.tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`reviewer MCP tool missing: ${name}`);
    return structuredClone(tool);
  });
  const authority = Buffer.from(`Bearer ${randomBytes(32).toString("hex")}`);
  let closed = false, calls = 0;
  const current = () => { try { return !closed && options.current(); } catch { return false; } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: BODY_CAP,
    async fetch(request) {
      if (request.headers.has("origin")) return new Response("forbidden", { status: 403 });
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (closed || supplied.length !== authority.length || !timingSafeEqual(supplied, authority)) return new Response("unauthorized", { status: 401 });
      if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
      if (Number(request.headers.get("content-length")) > BODY_CAP) return new Response("body too large", { status: 413 });
      let body: unknown;
      try {
        const reader = request.body?.getReader();
        let size = 0; const parts: Uint8Array[] = [];
        if (reader) for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > BODY_CAP) { await reader.cancel(); return new Response("body too large", { status: 413 }); }
          parts.push(part.value);
        }
        body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch { return new Response("invalid request", { status: 400 }); }
      if (!record(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return new Response("invalid request", { status: 400 });
      const id = body.id;
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
      const error = (message: string, code = -32602) => Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
      if (!current()) return error("review authority ended", -32001);
      if (body.method === "notifications/initialized" && id === undefined) return new Response(null, { status: 202 });
      if (typeof id !== "string" && typeof id !== "number") return error("request id required");
      if (body.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-hub-review", version: "1" } });
      if (body.method === "tools/list") return reply({ tools });
      if (body.method !== "tools/call") return error("method unavailable", -32601);
      if (!record(body.params)) return error("tool parameters required");
      const name = body.params.name;
      if (name !== "hub_review" && name !== "hub_task_show") return error("tool unavailable");
      let args = body.params.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { return error("invalid tool arguments"); } }
      if (!record(args) || args.id !== options.task || !Number.isSafeInteger(args.id)) return error("tool is bound to its review task");
      if (++calls > 64) return error("review tool call limit", -32002);
      if (!current()) return error("review authority ended", -32001);
      try {
        const result = await options.call(name, args);
        // Tasks.review rechecks its captured authority through its final write. A successful verdict
        // ends that in_review binding itself; acknowledge its committed result, never fresh reads.
        if (name !== "hub_review" && !current()) return error("review authority ended", -32001);
        if (Buffer.byteLength(result) > RESULT_CAP) return error("tool result exceeds review limit");
        return reply({ content: [{ type: "text", text: result }] });
      } catch (failure) {
        // The same host tool boundary supplies refusals to the released MCP transport.
        const message = failure instanceof Error ? sanitize(failure.message).slice(0, 4000) : "review tool refused";
        return reply({ isError: true, content: [{ type: "text", text: message }] });
      }
    },
  });
  return { config: JSON.stringify({ mcpServers: { "agent-hub": { transport: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: authority.toString() } } } }),
    close() { if (closed) return; closed = true; authority.fill(0); void server.stop(true); },
  };
}
