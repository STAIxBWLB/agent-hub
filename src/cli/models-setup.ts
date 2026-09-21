import type { MlxOptions } from "../models/mlx.ts";
import { validateOllamaOptions } from "../models/ollama.ts";

/** Explicit setup only: inference never downloads models or starts a service. */
export async function setupOllamaModel(options: MlxOptions): Promise<void> {
  const config = validateOllamaOptions(options);
  const source = options.sourceModel ?? "qwen3.5:4b-mlx";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(source) || !source.endsWith("-mlx") || source.includes("cloud") || source.includes("..") || source.includes("://")) {
    throw new Error("Ollama sourceModel must be an explicit local MLX model tag");
  }
  if (source === config.model) throw new Error("sourceModel and the dedicated AgentHub model must differ");
  const base = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok) throw new Error(`Ollama ${path} failed: HTTP ${response.status}`);
    const result = await response.json() as { error?: string };
    if (result.error) throw new Error(`Ollama ${path} failed: ${result.error.slice(0, 200)}`);
    return result;
  };
  await post("/api/pull", { model: source, stream: false });
  const sourceMetadata = await post("/api/show", { model: source }) as { remote_host?: unknown; remote_model?: unknown };
  if (sourceMetadata.remote_host != null || sourceMetadata.remote_model != null) {
    throw new Error("Ollama source model resolves to a remote/cloud model");
  }
  // Idempotent setup must never silently overwrite an existing model's recipe.
  const existing = await fetch(`${base}/api/show`, {
    method: "POST", redirect: "error", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.model }), signal: AbortSignal.timeout(10_000),
  });
  if (existing.ok) return; // The caller's inspect operation validates its context.
  if (existing.status !== 404) throw new Error(`Ollama model inspection failed: HTTP ${existing.status}`);
  await post("/api/create", {
    model: config.model, from: source, stream: false,
    parameters: { num_ctx: config.contextWindow, num_predict: config.maxTokens, temperature: 0.2 },
  });
}
