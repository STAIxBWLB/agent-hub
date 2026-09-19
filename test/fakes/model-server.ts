// Fake OpenAI-compatible gateway (OmniRoute-like): /health, bearer check, x-omniroute-provider, scripted replies.
import type { ChatMessage } from "../../src/omniroute/client.ts";

export type Script = (body: { model: string; messages: ChatMessage[] }, call: number) => Partial<ChatMessage> | Promise<Partial<ChatMessage>>;

export const toolCall = (name: string, args: unknown, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({
  id,
  type: "function" as const,
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

export function startFakeModelServer(opts: { key?: string; script?: Script; healthy?: boolean } = {}) {
  const requests: { headers: Record<string, string>; body: any }[] = [];
  const state = { healthy: opts.healthy ?? true, script: opts.script ?? ((b) => ({ content: `echo: ${b.messages.at(-1)?.content}` })) };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") return state.healthy ? Response.json({ data: [] }) : new Response("down", { status: 503 });
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = (await req.json()) as any;
      requests.push({ headers: Object.fromEntries(req.headers), body });
      if (opts.key && req.headers.get("authorization") !== `Bearer ${opts.key}`) return new Response("invalid api key", { status: 401 });
      let scripted: Partial<ChatMessage>;
      try {
        scripted = await state.script(body, requests.length);
      } catch (e) {
        return new Response(`upstream error: ${(e as Error).message}`, { status: 500 });
      }
      const message = { role: "assistant", content: null, reasoning_content: "private chain of thought", ...scripted };
      return Response.json({ choices: [{ message }] }, { headers: { "x-omniroute-provider": "vllm" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, state, stop: () => server.stop(true) };
}
