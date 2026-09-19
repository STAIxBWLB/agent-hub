import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { OmniRoute, ChatMessage } from "../omniroute/client.ts";
import { ensureMlx, type MlxHandle, type MlxOptions, type MlxStatus } from "./mlx.ts";

export type ModelBackend = { kind: "mlx"; alias?: string } | { kind: "dgx"; alias: string };

export interface RelayRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  max_tokens?: number;
  [key: string]: unknown;
}

export interface RelayBackendStatus {
  alias: string;
  kind: ModelBackend["kind"];
  state: "idle" | "starting" | "ready" | "error";
  requestedModel?: string;
  actualModel?: string;
  provider?: string;
  active: number;
  lastError?: string;
}

export interface ModelRelayStatus {
  url: string;
  models: string[];
  backends: RelayBackendStatus[];
}

export interface ModelRelayOptions {
  omni: OmniRoute;
  host?: string;
  port?: number;
  token?: string;
  defaultBackend?: ModelBackend;
  selectBackend?: (request: RelayRequest) => ModelBackend | Promise<ModelBackend>;
  allowedDGXmodels: Record<string, string>;
  dgxMaxInputTokens?: number;
  mlx?: MlxOptions;
  mlxAlias?: string;
  mlxModel?: string;
  fallbackDGXAlias?: string;
}

export interface ModelRelay {
  readonly url: string;
  readonly token: string;
  readonly models: string[];
  readonly status: () => ModelRelayStatus;
  readonly close: () => Promise<void>;
}

interface ActiveRequest {
  controller: AbortController;
  release?: () => void;
  cleanup: () => void;
}

const safeHeader = (value: string | null): string | undefined => value && value.length < 256 ? value : undefined;

function assertLoopback(host: string): void {
  const value = host.toLowerCase();
  if (value !== "localhost" && value !== "::1" && !(isIP(value) === 4 && value.startsWith("127."))) throw new Error("model relay host must be loopback");
}

function estimateInputTokens(messages: ChatMessage[], tools?: unknown[]): number {
  return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
}

function bearer(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : undefined;
}

function aliasOf(backend: ModelBackend, mlxAlias: string): string {
  return backend.kind === "mlx" ? backend.alias ?? mlxAlias : backend.alias;
}

function bodyForUpstream(body: RelayRequest, model: string): Record<string, unknown> {
  const allowed = ["temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice", "response_format"];
  return {
    model,
    messages: body.messages,
    stream: true,
    ...Object.fromEntries(allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])),
  };
}

function sseResponse(response: Response, release: () => void, onModel?: (model: string) => void): Response {
  if (!response.body) {
    release();
    return new Response("upstream returned no stream", { status: 502 });
  }
  const reader = response.body.getReader();
  let inspectBuffer = "";
  let inspectedModel = false;
  const inspect = (chunk: Uint8Array) => {
    if (!onModel || inspectedModel) return;
    inspectBuffer += new TextDecoder().decode(chunk);
    if (inspectBuffer.length > 64_000) inspectBuffer = inspectBuffer.slice(-64_000);
    const lines = inspectBuffer.split(/\r?\n/);
    inspectBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
      try {
        const value = JSON.parse(line.slice(5).trim()) as { model?: unknown };
        if (typeof value.model === "string" && value.model.length < 256) {
          inspectedModel = true;
          onModel(value.model);
          return;
        }
      } catch { /* incomplete or non-JSON SSE data */ }
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else { inspect(next.value); controller.enqueue(next.value); }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export async function startModelRelay(options: ModelRelayOptions): Promise<ModelRelay> {
  const host = options.host ?? "127.0.0.1";
  assertLoopback(host);
  const token = options.token ?? randomUUID();
  const mlxAlias = options.mlxAlias ?? "mlx/fast";
  const dgxMaxInputTokens = options.dgxMaxInputTokens ?? 262_144;
  const defaultBackend = options.defaultBackend ?? (options.mlx ? { kind: "mlx", alias: mlxAlias } : { kind: "dgx", alias: "dgx/coding" });
  const models = [...new Set([...(options.mlx ? [mlxAlias] : []), ...Object.keys(options.allowedDGXmodels)])];
  let mlx: MlxHandle | undefined;
  let mlxStarting: Promise<MlxHandle> | undefined;
  const states = new Map<string, RelayBackendStatus>();
  const activeRequests = new Set<ActiveRequest>();
  const activeByAlias = new Map<string, number>();

  const ensureMlxHandle = async (): Promise<MlxHandle> => (mlx ??= await (mlxStarting ??= ensureMlx(options.mlx).finally(() => { mlxStarting = undefined; })));
  const state = (backend: ModelBackend): RelayBackendStatus => states.get(aliasOf(backend, mlxAlias)) ?? {
    alias: aliasOf(backend, mlxAlias), kind: backend.kind, state: "idle", active: 0,
  };
  const setState = (backend: ModelBackend, patch: Partial<RelayBackendStatus>) => {
    const alias = aliasOf(backend, mlxAlias);
    states.set(alias, { ...state(backend), ...patch, alias, kind: backend.kind });
  };

  const resolve = async (body: RelayRequest): Promise<ModelBackend> => {
    const requested = typeof body.model === "string" ? body.model : undefined;
    if (requested && !models.includes(requested)) throw new Error("model alias is not allowed");
    if (requested === mlxAlias && options.mlx) return { kind: "mlx", alias: mlxAlias };
    if (requested && requested in options.allowedDGXmodels) return { kind: "dgx", alias: requested };
    const selected = options.selectBackend ? await options.selectBackend(body) : defaultBackend;
    if (selected.kind === "mlx" && !options.mlx) throw new Error("MLX backend is not configured");
    if (selected.kind === "dgx" && !(selected.alias in options.allowedDGXmodels)) throw new Error("DGX model alias is not allowed");
    return selected;
  };

  const upstream = async (request: RelayRequest, backend: ModelBackend, signal: AbortSignal): Promise<{ response: Response; release: () => void; onModel?: (model: string) => void }> => {
    const alias = aliasOf(backend, mlxAlias);
    let base: string;
    let model: string;
    let release = () => {};
    let released = false;
    const count = (delta: number) => activeByAlias.set(alias, Math.max(0, (activeByAlias.get(alias) ?? 0) + delta));
    if (backend.kind === "mlx") {
      setState(backend, { state: "starting", requestedModel: request.model });
      let handle: MlxHandle;
      try {
        handle = await ensureMlxHandle();
      } catch (error) {
        setState(backend, { state: "error", lastError: error instanceof Error ? error.message.slice(0, 160) : "MLX startup failed" });
        throw error;
      }
      base = handle.url;
      model = options.mlxModel ?? handle.model;
      if (signal.aborted) throw new Error("request was cancelled before MLX generation started");
      release = await handle.acquire();
    } else {
      base = (await options.omni.base()) ?? (() => { throw new Error("DGX gateway is unavailable"); })();
      model = options.allowedDGXmodels[backend.alias]!;
    }
    const key = backend.kind === "dgx" ? options.omni.apiKey() : "";
    if (backend.kind === "dgx" && !key) throw new Error("DGX gateway key is unavailable");
    count(1);
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
      count(-1);
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) Object.assign(headers, { authorization: `Bearer ${key}` }, options.omni.accessHeaders(base));
    let response: Response;
    try {
      response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers, body: JSON.stringify(bodyForUpstream(request, model)), signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
    } catch (error) {
      releaseOnce();
      setState(backend, { state: "error", lastError: error instanceof Error ? error.message.slice(0, 160) : "upstream request failed" });
      throw error;
    }
    if (!response.ok) {
      releaseOnce();
      const message = `backend returned HTTP ${response.status}`;
      setState(backend, { state: "error", lastError: message });
      throw new Error(message);
    }
    const provider = safeHeader(response.headers.get("x-omniroute-provider"));
    const actualModel = safeHeader(response.headers.get("x-model-router-selected-model"));
    setState(backend, { state: "ready", requestedModel: request.model, active: activeByAlias.get(alias) ?? 0,
      provider: provider ?? undefined, actualModel: actualModel ?? (backend.kind === "mlx" ? model : undefined) });
    const releaseWithStatus = () => {
      releaseOnce();
      setState(backend, { active: activeByAlias.get(alias) ?? 0 });
    };
    return { response, release: releaseWithStatus, ...(actualModel ? {} : { onModel: (value: string) => setState(backend, { actualModel: value }) }) };
  };

  const server = Bun.serve({
    hostname: host,
    port: options.port ?? 0,
    idleTimeout: 255,
    async fetch(request) {
      if (bearer(request) !== token) return new Response("unauthorized", { status: 401 });
      if (request.headers.has("origin")) return new Response("origin header is not accepted", { status: 403 });
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") return Response.json({ ok: true, status: status() });
      if (request.method === "GET" && path === "/v1/models") return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: id.startsWith("mlx/") ? "mlx" : "dgx" })) });
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      if (Number(request.headers.get("content-length") ?? 0) > 2_000_000) return new Response("request too large", { status: 413 });
      const controller = new AbortController();
      const onAbort = () => controller.abort(request.signal.reason);
      request.signal.addEventListener("abort", onAbort, { once: true });
      const record: ActiveRequest = { controller, cleanup: () => request.signal.removeEventListener("abort", onAbort) };
      activeRequests.add(record);
      let body: RelayRequest;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new Error("request too large");
        body = JSON.parse(raw) as RelayRequest;
        if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages is required");
      } catch (error) {
        record.cleanup();
        activeRequests.delete(record);
        return Response.json({ error: error instanceof Error ? error.message : "invalid request" }, { status: 400 });
      }
      let backend: ModelBackend;
      try { backend = await resolve(body); } catch (error) {
        record.cleanup();
        activeRequests.delete(record);
        return Response.json({ error: error instanceof Error ? error.message : "backend unavailable" }, { status: 400 });
      }
      const inputBudget = backend.kind === "mlx" ? (options.mlx?.maxInputTokens ?? 16_000) : dgxMaxInputTokens;
      if (estimateInputTokens(body.messages, body.tools) > inputBudget) {
        record.cleanup();
        activeRequests.delete(record);
        return Response.json({ error: "input exceeds the model context budget" }, { status: 400 });
      }
      const fallback = backend.kind === "mlx" && options.fallbackDGXAlias ? { kind: "dgx", alias: options.fallbackDGXAlias } as ModelBackend : undefined;
      try {
        const result = await upstream(body, backend, controller.signal);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          result.release();
          record.cleanup();
          activeRequests.delete(record);
        };
        record.release = release;
        return sseResponse(result.response, release, result.onModel);
      } catch (error) {
        if (!fallback || controller.signal.aborted) {
          record.cleanup();
          activeRequests.delete(record);
          return Response.json({ error: error instanceof Error ? error.message : "backend unavailable" }, { status: 502 });
        }
        try {
          const result = await upstream({ ...body, model: fallback.alias }, fallback, controller.signal);
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            result.release();
            record.cleanup();
            activeRequests.delete(record);
          };
          record.release = release;
          return sseResponse(result.response, release, result.onModel);
        } catch (fallbackError) {
          record.cleanup();
          activeRequests.delete(record);
          return Response.json({ error: fallbackError instanceof Error ? fallbackError.message : "fallback unavailable" }, { status: 502 });
        }
      }
    },
  });
  const url = `http://${host}:${server.port}/v1`;
  const status = (): ModelRelayStatus => ({ url, models, backends: [...states.values()].map((value) => ({ ...value })) });
  return { url, token, models, status, close: async () => {
    for (const request of activeRequests) {
      request.controller.abort(new Error("model relay closed"));
      request.release?.();
      request.cleanup();
    }
    activeRequests.clear();
    server.stop(false);
    await mlx?.close();
  } };
}
