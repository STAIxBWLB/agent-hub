// Explicit live check; never part of the hermetic test suite.
// Requires a prepared local model. No DGX fallback or real tool execution.
import { loadConfig } from "../src/hub/daemon.ts";
import { inspectMlx } from "../src/models/mlx.ts";
import { startModelRelay } from "../src/models/relay.ts";
import type { OmniRoute } from "../src/omniroute/client.ts";

const mlx = loadConfig(process.env.AHUB_SMOKE_PROJECT ?? process.cwd()).mlx;
if (mlx.provider !== "ollama") throw new Error("This smoke requires mlx.provider=ollama");
const relay = await startModelRelay({
  // Deliberately unusable: the smoke must never reach a remote provider.
  omni: { base: async () => { throw new Error("Remote inference is forbidden in this smoke"); } } as unknown as OmniRoute,
  allowedDGXmodels: {}, mlx, defaultBackend: { kind: "mlx" },
});

async function completion(messages: unknown[], tools?: unknown[]) {
  const response = await fetch(`${relay.url}/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "mlx/fast", messages, tools, stream: true, max_tokens: 128, temperature: 0 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Relay returned HTTP ${response.status}: ${await response.text()}`);
  const data = await response.text();
  let content = "";
  const calls = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
  for (const line of data.split("\n")) {
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
    const chunk = JSON.parse(line.slice(5));
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    for (const call of delta?.tool_calls ?? []) {
      const current = calls.get(call.index ?? 0) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      calls.set(call.index ?? 0, current);
    }
  }
  return { role: "assistant", content, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
}

try {
  const text = await completion([{ role: "user", content: "Reply with exactly OLLAMA_MLX_OK." }]);
  if (!text.content.includes("OLLAMA_MLX_OK")) throw new Error("Completion sentinel missing");
  const prompt = { role: "user", content: "Call get_status with component=agenthub. Do not answer in prose." };
  const call = await completion([prompt], [{ type: "function", function: {
    name: "get_status", description: "Read the status of a component",
    parameters: { type: "object", properties: { component: { type: "string" } }, required: ["component"] },
  } }]);
  const tool = call.tool_calls?.[0];
  if (tool?.function.name !== "get_status" || JSON.parse(tool.function.arguments).component !== "agenthub") throw new Error("Streamed tool call was not valid");
  const reply = await completion([prompt, call, { role: "tool", tool_call_id: tool.id, content: '{"status":"ok"}' }, { role: "user", content: "Summarize the result in one sentence." }]);
  if (!reply.content.trim()) throw new Error("Tool result follow-up was empty");
  console.log(JSON.stringify({ completion: text.content, tool: tool.function.name, followUp: reply.content, relay: relay.status().backends, runtime: await inspectMlx(mlx) }, null, 2));
} finally {
  await relay.close();
}
