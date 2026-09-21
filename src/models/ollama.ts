import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MlxHandle, MlxOptions, MlxStatus } from "./mlx.ts";
import { acquireGeneration } from "./mlx.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11434;
const DEFAULT_MODEL = "agenthub-fast-mlx:4b-8k";
const DEFAULT_CONTEXT = 8192;
const DEFAULT_INPUT = 6000;
const DEFAULT_OUTPUT = 2048;
const DEFAULT_CONCURRENCY = 1;

export interface OllamaOptions {
  host: string;
  port: number;
  model: string;
  contextWindow: number;
  maxInputTokens: number;
  maxTokens: number;
  maxConcurrency: number;
  runtimeDir: string;
}

function assertLoopback(host: string): void {
  const value = host.toLowerCase();
  if (value !== "localhost" && value !== "127.0.0.1" && value !== "::1" && !(isIP(value) === 4 && value.startsWith("127."))) {
    throw new Error("Ollama host must be loopback");
  }
}

function baseUrl(config: OllamaOptions): string {
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}`;
}

function assertModel(model: string): void {
  if (!model || model.length > 256 || /[\\/\s]/.test(model) || /cloud/i.test(model) || /^https?:/i.test(model)) {
    throw new Error("Ollama model must be a local model name");
  }
}

export function validateOllamaOptions(options: MlxOptions = {}): OllamaOptions {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const model = options.model ?? options.modelPath ?? DEFAULT_MODEL;
  const contextWindow = options.contextWindow ?? 8192;
  const maxTokens = options.maxTokens ?? DEFAULT_OUTPUT;
  const maxInputTokens = options.maxInputTokens ?? Math.min(DEFAULT_INPUT, contextWindow - maxTokens);
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
  assertLoopback(host);
  assertModel(model);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ollama port must be valid");
  if (!Number.isInteger(contextWindow) || contextWindow < 1) throw new Error("Ollama contextWindow must be positive");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("Ollama maxTokens must fit contextWindow");
  if (!Number.isInteger(maxInputTokens) || maxInputTokens < 1 || maxInputTokens + maxTokens > contextWindow) throw new Error("Ollama maxInputTokens plus maxTokens exceeds contextWindow");
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("Ollama maxConcurrency must be positive");
  return {
    host,
    port,
    model,
    contextWindow,
    maxInputTokens,
    maxTokens,
    maxConcurrency,
    runtimeDir: options.runtimeDir ?? join(homedir(), ".agenthub", "runtimes", "ollama"),
  };
}

type OllamaTag = { name?: unknown; model?: unknown };
type OllamaPs = { models?: Array<{ name?: unknown; model?: unknown; expires_at?: unknown }> };

async function request(base: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${base}${path}`, { ...init, redirect: "manual", signal: init?.signal ?? AbortSignal.timeout(2_000) });
  if (response.status >= 300 && response.status < 400) throw new Error("Ollama endpoint redirect refused");
  return response;
}

async function inspectRemote(config: OllamaOptions): Promise<{ available: boolean; resident: boolean; expiresAt: string | null; error?: string }> {
  const base = baseUrl(config);
  try {
    const [tagsResponse, psResponse, showResponse] = await Promise.all([
      request(base, "/api/tags"),
      request(base, "/api/ps"),
      request(base, "/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: config.model }) }),
    ]);
    if (!tagsResponse.ok) return { available: false, resident: false, expiresAt: null, error: `Ollama catalog returned HTTP ${tagsResponse.status}` };
    const tags = await tagsResponse.json() as { models?: OllamaTag[] };
    const available = (tags.models ?? []).some((tag) => tag.name === config.model || tag.model === config.model);
    if (available && !showResponse.ok) return { available: false, resident: false, expiresAt: null, error: `Ollama model metadata returned HTTP ${showResponse.status}` };
    if (available) {
      const details = await showResponse.json() as { parameters?: unknown; remote_host?: unknown; remote_model?: unknown };
      if (typeof details.remote_host === "string" || typeof details.remote_model === "string") return { available: false, resident: false, expiresAt: null, error: "Ollama model resolves to a remote/cloud model" };
      const parameters = typeof details.parameters === "string" ? details.parameters : "";
      const context = /(?:^|\n)\s*num_ctx\s+(\d+)\s*(?:\n|$)/.exec(parameters)?.[1];
      if (!context || Number(context) !== config.contextWindow) return { available: false, resident: false, expiresAt: null, error: `Ollama model num_ctx does not match ${config.contextWindow}; repair the existing recipe or choose a new model name` };
    }
    let resident = false;
    let expiresAt: string | null = null;
    if (!psResponse.ok) return { available, resident: false, expiresAt: null, error: `Ollama residency status returned HTTP ${psResponse.status}` };
    if (psResponse.ok) {
      const ps = await psResponse.json() as OllamaPs;
      const loaded = (ps.models ?? []).find((item) => item.name === config.model || item.model === config.model);
      resident = Boolean(loaded);
      expiresAt = typeof loaded?.expires_at === "string" ? loaded.expires_at : null;
      if (resident && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)))) return { available, resident, expiresAt, error: "Ollama model residency has no finite expiry" };
    }
    return { available, resident, expiresAt, ...(available ? {} : { error: `Ollama model is unavailable: ${config.model}` }) };
  } catch (error) {
    return { available: false, resident: false, expiresAt: null, error: error instanceof Error ? error.message : "Ollama is unavailable" };
  }
}

export async function inspectOllama(options: MlxOptions = {}): Promise<MlxStatus> {
  const config = validateOllamaOptions(options);
  const remote = await inspectRemote(config);
  return {
    state: remote.error ? "error" : "ready",
    url: `${baseUrl(config)}/v1`,
    model: config.model,
    maxInputTokens: config.maxInputTokens,
    maxConcurrency: config.maxConcurrency,
    active: 0,
    provider: "ollama",
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    modelAvailable: remote.available,
    modelResident: remote.resident,
    expiresAt: remote.expiresAt,
    ...(remote.error ? { lastError: remote.error } : {}),
  };
}

export async function ensureOllama(options: MlxOptions = {}): Promise<MlxHandle> {
  const config = validateOllamaOptions(options);
  const initial = await inspectOllama(options);
  if (initial.state !== "ready") throw new Error(initial.lastError ?? `Ollama model is unavailable: ${config.model}`);
  let active = 0;
  const status = () => ({ ...initial, active });
  return {
    url: `${baseUrl(config)}/v1`,
    model: config.model,
    status,
    acquire: async (signal) => {
      const releaseSlot = await acquireGeneration(config.runtimeDir, config.maxConcurrency, signal);
      try {
        const current = await inspectOllama(options);
        if (signal?.aborted) throw new Error("Ollama generation was cancelled");
        if (current.state !== "ready") throw new Error(current.lastError ?? `Ollama model is unavailable: ${config.model}`);
      } catch (error) { releaseSlot(); throw error; }
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        releaseSlot();
      };
    },
    close: async () => {},
  };
}

export async function stopOllama(_options: MlxOptions = {}): Promise<void> {
  throw new Error("Ollama is externally managed; refusing to stop or unload the shared service");
}
