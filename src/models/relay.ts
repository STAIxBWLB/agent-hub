import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { OmniRoute, ChatMessage } from "../omniroute/client.ts";
import { ensureMlx, type MlxHandle, type MlxOptions, type MlxStatus } from "./mlx.ts";
import { AutoRouteSelector, type RelayRouteEvent } from "./route/relay-selector.ts";
import type { StaySwitchPolicy } from "./route/stage.ts";

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

/** Sanitized per-request identity and lifecycle evidence. One record per upstream dispatch attempt
 *  (a fallback dispatch is its own record). Records carry no messages, keys or Access headers; with the
 *  opt-in `observeToolSurface` they additionally carry the bounded `toolSurface` projection (allowlist-
 *  charset names, a count and an opaque schema hash — never descriptions, arguments or message text).
 *  `identified: false` with `outcome: "cancelled"` is the cancelled-before-identification state; an
 *  observed `actualModel` that differs from the trusted expected served model sets `mismatch`.
 *  Without an explicit expectation, the upstream-configured identifier remains the comparison default.
 *  `identitySource` says where the served-model label came from: the gateway response header, a
 *  generation SSE event (#137 classification: heartbeats never identify), or the locally validated
 *  MLX configuration. HTTP 200, the requested alias and a previous request's label never identify. */
export interface RelayUsageObservation {
  source: "openai-stream-usage";
  completeness: "complete" | "partial";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * The bounded tool-surface projection of one request's published `tools` array (#183): what the native
 * declared to the model, reduced to allowlist-charset names (sorted, deduplicated), the raw entry count
 * and an opaque full structural JSON-schema fingerprint. Schema annotations are omitted, while types,
 * constraints and literal default/const/enum values are hashed only, never exported.
 */
export interface RelayToolSurface {
  count: number;
  names: string[];
  schemaSha256: string;
  invalidEntries: number;
  duplicateNames: number;
  truncated: boolean;
}

const SURFACE_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const SURFACE_CAP = 64;
const SCHEMA_ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependentRequired"]);

/** Structural JSON-schema fingerprint, including types, constraints and nested shapes. Annotation text is
 * omitted; all remaining values enter only the opaque hash. Resource ceilings fail explicitly, never silently
 * qualify a partial schema. */
export function toolSurfaceProjection(tools: unknown): RelayToolSurface | undefined {
  if (!Array.isArray(tools)) return undefined;
  let invalidEntries = 0, duplicateNames = 0, truncated = tools.length > SURFACE_CAP, nodes = 0;
  const names = new Set<string>();
  const canonical = (value: unknown, depth = 0, keyword = "", schemaMap = false, literal = false): unknown => {
    if (++nodes > 8192 || depth > 20) { truncated = true; return null; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") { if (Number.isFinite(value)) return value; invalidEntries++; return null; }
    if (typeof value === "string") { if (value.length > 8192) { truncated = true; return null; } return value; }
    if (Array.isArray(value)) {
      if (value.length > 256) truncated = true;
      const result = value.slice(0, 256).map((v) => canonical(v, depth + 1, "", false, literal || keyword === "enum"));
      return !literal && (keyword === "required" || keyword === "enum" || keyword === "type") ? result.sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; }) : result;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value).filter((k) => literal || schemaMap || !SCHEMA_ANNOTATIONS.has(k)).sort();
      if (keys.length > 256) truncated = true;
      return Object.fromEntries(keys.slice(0, 256).map((k) => [k, canonical((value as Record<string, unknown>)[k], depth + 1, schemaMap ? "" : k, !literal && !schemaMap && SCHEMA_MAPS.has(k), literal || (!schemaMap && ["default", "const", "enum"].includes(k)))]));
    }
    invalidEntries++; return null;
  };
  const schema: { name: string; parameters: unknown }[] = [];
  for (const entry of tools.slice(0, SURFACE_CAP)) {
    const e = entry as { function?: unknown; name?: unknown; parameters?: unknown } | null;
    const fn = (e && typeof e === "object" && e.function && typeof e.function === "object" ? e.function : e) as { name?: unknown; parameters?: unknown } | null;
    const name = typeof fn?.name === "string" && SURFACE_NAME.test(fn.name) ? fn.name : "";
    if (!name || !fn?.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) invalidEntries++;
    if (name) { if (names.has(name)) duplicateNames++; names.add(name); }
    schema.push({ name, parameters: canonical(fn?.parameters ?? null) });
  }
  schema.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { count: tools.length, names: [...names].sort(), schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"), invalidEntries, duplicateNames, truncated };
}

export interface RelayRequestRecord {
  id: string;
  dispatchGroupId?: string;
  fallbackOfId?: string;
  failureClass?: "http" | "transport" | "startup" | "admission" | "cancelled";
  httpStatus?: number;
  /** Admission timestamp (start of the upstream dispatch attempt), ISO. */
  at: string;
  /** Resolved backend alias (the requested route). */
  alias: string;
  /** Physical model the relay asked the upstream for. */
  requestedModel?: string;
  /** Sanitized `x-omniroute-provider` header; absent stays unknown. */
  provider?: string;
  providerSource?: "header" | "none";
  providerAvailability?: "known" | "missing";
  /** Independent transport counter, never a native session counter. */
  requestUsage?: RelayUsageObservation;
  usageAvailability?: "known" | "partial" | "missing" | "invalid";
  /** Observed served model; never read back from the backend's mutable last label. */
  actualModel?: string;
  /** Bounded tool-surface projection of the request's published tools; only when the owner opted in. */
  toolSurface?: RelayToolSurface;
  identitySource: "header" | "stream" | "configured" | "none";
  // ponytail: the relay cannot see native turn structure, so role stays "unknown"; a native surface
  // that knows primary vs auxiliary work (benchmark wiring, issue #140) is the upgrade path.
  role: "primary" | "auxiliary" | "unknown";
  outcome: "completed" | "cancelled" | "failed";
  identified: boolean;
  /** Set only when the observed served model differs from the expected model. */
  mismatch?: boolean;
  durationMs: number;
}

export interface ModelRelayOptions {
  omni: OmniRoute;
  /** Authoritative admission immediately before each upstream request, including fallbacks. */
  admitRequest?: () => Promise<{ allowed: boolean; reason?: string; remainingMs?: number }>;
  host?: string;
  port?: number;
  token?: string;
  defaultBackend?: ModelBackend;
  selectBackend?: (request: RelayRequest) => ModelBackend | Promise<ModelBackend>;
  /** Expose the virtual, stage-routed model alias to Pi. */
  enableHubAuto?: boolean;
  /** Trusted host callback. Requests without a stable session key get stateless stage selection. */
  routeSessionKey?: (request: RelayRequest) => string | undefined;
  onRoute?: (event: RelayRouteEvent) => void;
  /** Read on every `hub/auto` call (#197); absent is the shadow default. */
  staySwitch?: () => StaySwitchPolicy | undefined;
  allowedDGXmodels: Record<string, string>;
  /** Trusted physical model expectations by backend alias. Gateway identifiers can include a provider
   *  prefix or route name that differs from the model reported by generation. Omission preserves the
   *  existing literal upstream-identifier comparison; never derive this map from a response. */
  expectedServedModels?: Record<string, string>;
  dgxMaxInputTokens?: number;
  mlx?: MlxOptions;
  mlxAlias?: string;
  mlxModel?: string;
  fallbackDGXAlias?: string;
  /** Include explicit missing usage/provider metadata and dispatch groups, independently of observers.
   *  Omission preserves the legacy absent-metadata journal schema. */
  observeRequestMetadata?: boolean;
  /** Journal each request's bounded tool-surface projection (#183). Omission preserves the no-tools
   *  journal contract. */
  observeToolSurface?: boolean;
  /** Called exactly once per journaled request, at its terminal close, with a sanitized copy. */
  onRequest?: (record: RelayRequestRecord) => void;
}

export interface ModelRelay {
  readonly url: string;
  readonly token: string;
  readonly models: string[];
  readonly status: () => ModelRelayStatus;
  /** Closed request records, oldest first, bounded to the last 1000. */
  readonly requests: () => RelayRequestRecord[];
  readonly close: () => Promise<void>;
}

interface RequestJournalEntry {
  readonly record: RelayRequestRecord;
  identify(model: string, source: "header" | "stream" | "configured"): void;
  usage(value: unknown): void;
  close(outcome: RelayRequestRecord["outcome"]): void;
}

interface ActiveRequest {
  controller: AbortController;
  release?: () => void;
  cancel?: (reason?: unknown) => Promise<void>;
  closeRecord?: (outcome: RelayRequestRecord["outcome"]) => void;
  cleanup: () => void;
}

class ExecutionAdmissionError extends Error {}

const safeHeader = (value: string | null): string | undefined => value && value.length < 256 && !/\p{C}/u.test(value) ? value : undefined;

export function normalizeRelayUsage(value: unknown): RelayUsageObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const fields = [["prompt_tokens", "promptTokens"], ["completion_tokens", "completionTokens"], ["total_tokens", "totalTokens"]] as const;
  const result: RelayUsageObservation = { source: "openai-stream-usage", completeness: "partial" };
  let count = 0;
  for (const [input, output] of fields) {
    if (usage[input] === undefined) continue;
    const v = usage[input];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
    result[output] = v; count++;
  }
  if (!count) return undefined;
  if (count === 3) result.completeness = "complete";
  return result;
}

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
  const allowed = ["temperature", "top_p", "max_tokens", "stop", "tools", "tool_choice", "response_format", "reasoning_effort"];
  return {
    model,
    messages: body.messages,
    stream: true,
    ...Object.fromEntries(allowed.filter((key) => body[key] !== undefined).map((key) => [key, body[key]])),
  };
}

/** An SSE event carries model identity only with generation activity: a delta with any field (a role-only
 *  first chunk counts), a finish reason, or a non-streaming message. Empty choices and empty-delta events
 *  are transport heartbeats and say nothing about the served model. */
function isGenerationEvent(choices: unknown): boolean {
  if (!Array.isArray(choices)) return false;
  return choices.some((choice: any) => {
    if (choice?.finish_reason) return true;
    if (choice?.message && typeof choice.message === "object") return true;
    const delta = choice?.delta;
    return delta !== null && typeof delta === "object" && Object.keys(delta).length > 0;
  });
}

function sseResponse(response: Response, release: () => void, onModel?: (model: string) => void, registerCancel?: (cancel: (reason?: unknown) => Promise<void>) => void, onClose?: (outcome: RelayRequestRecord["outcome"]) => void, onUsage?: (value: unknown) => void): Response {
  if (!response.body) {
    release();
    onClose?.("failed");
    return new Response("upstream returned no stream", { status: 502 });
  }
  const reader = response.body.getReader();
  const cancel = async (reason?: unknown) => {
    try { await reader.cancel(reason); } catch { /* the upstream may already be closed */ }
  };
  registerCancel?.(cancel);
  let inspectBuffer = "";
  let inspectedModel = false;
  const decoder = new TextDecoder();
  const inspect = (chunk: Uint8Array) => {
    if (!onUsage && (!onModel || inspectedModel)) return;
    inspectBuffer += decoder.decode(chunk, { stream: true });
    if (inspectBuffer.length > 64_000) inspectBuffer = inspectBuffer.slice(-64_000);
    const lines = inspectBuffer.split(/\r?\n/);
    inspectBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
      try {
        const value = JSON.parse(line.slice(5).trim()) as { model?: unknown; choices?: unknown[]; usage?: unknown };
        if (value.usage !== undefined && value.usage !== null) onUsage?.(value.usage);
        // Transport heartbeats are not model identity: a gateway keepalive can name a synthetic model on
        // an event with no generation activity (no choices, or only empty deltas without a finish reason).
        if (!inspectedModel && typeof value.model === "string" && safeHeader(value.model) !== undefined && isGenerationEvent(value.choices)) {
          inspectedModel = true;
          onModel?.(value.model);
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
          onClose?.("completed");
          controller.close();
        } else { inspect(next.value); controller.enqueue(next.value); }
      } catch (error) {
        release();
        onClose?.("failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      onClose?.("cancelled");
      await cancel(reason);
    },
  });
  return new Response(stream, {
    status: response.status,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

const copyRecord = (record: RelayRequestRecord): RelayRequestRecord => ({ ...record, ...(record.requestUsage ? { requestUsage: { ...record.requestUsage } } : {}), ...(record.toolSurface ? { toolSurface: { ...record.toolSurface, names: [...record.toolSurface.names] } } : {}) });

/** Pure advertised alias list, also used by no-start launch previews. */
export function relayModelIds(options: Pick<ModelRelayOptions, "enableHubAuto" | "mlx" | "mlxAlias" | "allowedDGXmodels">): string[] {
  return [...new Set([...(options.enableHubAuto ? ["hub/auto"] : []), ...(options.mlx ? [options.mlxAlias ?? "mlx/fast"] : []), ...Object.keys(options.allowedDGXmodels)])];
}

export async function startModelRelay(options: ModelRelayOptions): Promise<ModelRelay> {
  const host = options.host ?? "127.0.0.1";
  assertLoopback(host);
  const token = options.token ?? randomUUID();
  const mlxAlias = options.mlxAlias ?? "mlx/fast";
  const dgxMaxInputTokens = options.dgxMaxInputTokens ?? 262_144;
  const defaultBackend = options.defaultBackend ?? (options.mlx ? { kind: "mlx", alias: mlxAlias } : { kind: "dgx", alias: "dgx/coding" });
  const models = relayModelIds(options);
  const autoRoute = options.enableHubAuto ? new AutoRouteSelector({ ...options, dgxMaxInputTokens }, defaultBackend, mlxAlias, estimateInputTokens) : undefined;
  let mlx: MlxHandle | undefined;
  let mlxStarting: Promise<MlxHandle> | undefined;
  const states = new Map<string, RelayBackendStatus>();
  const activeRequests = new Set<ActiveRequest>();
  const activeByAlias = new Map<string, number>();
  const journal: RelayRequestRecord[] = [];
  const JOURNAL_LIMIT = 1000;

  // The record object is the generation fence: every update goes through this entry's own closure,
  // so interleaved requests for the same alias never write into each other's evidence.
  const openRequestRecord = (alias: string, dispatchGroupId: string): RequestJournalEntry => {
    const start = Date.now();
    const expectedServedModel = options.expectedServedModels?.[alias];
    const record: RelayRequestRecord = {
      id: randomUUID(), ...(options.observeRequestMetadata ? { dispatchGroupId } : {}), at: new Date(start).toISOString(), alias,
      identitySource: "none", role: "unknown", outcome: "completed", identified: false, durationMs: 0,
      ...(options.observeRequestMetadata ? { providerSource: "none" as const, providerAvailability: "missing" as const, usageAvailability: "missing" as const } : {}),
    };
    let closed = false;
    const identify: RequestJournalEntry["identify"] = (model, source) => {
      if (closed) return;
      // First observation wins; a stream observation may still replace a configured label (observed
      // beats configured), and a configured label never replaces an observation.
      if (record.identified && (record.identitySource !== "configured" || source === "configured")) return;
      record.actualModel = model;
      record.identitySource = source;
      record.identified = true;
    };
    const close: RequestJournalEntry["close"] = (outcome) => {
      if (closed) return;
      closed = true;
      record.outcome = outcome;
      record.durationMs = Date.now() - start;
      const expectedModel = expectedServedModel ?? record.requestedModel;
      if (record.identified && expectedModel !== undefined && record.actualModel !== expectedModel) record.mismatch = true;
      journal.push(copyRecord(record));
      if (journal.length > JOURNAL_LIMIT) journal.shift();
      try {
        // An async hook fits the void signature: its rejection is handled too, never unobserved.
        const notified = options.onRequest?.(copyRecord(record)) as unknown;
        if (notified instanceof Promise) notified.catch(() => { /* a persistence hook must never break the relay */ });
      } catch { /* a persistence hook must never break the proxied stream it observes */ }
    };
    const usage = (value: unknown) => {
      if (closed) return;
      record.providerSource ??= "none";
      record.providerAvailability ??= "missing";
      const observation = normalizeRelayUsage(value);
      if (observation) {
        record.requestUsage = observation;
        record.usageAvailability = observation.completeness === "complete" ? "known" : "partial";
      } else if (!record.requestUsage) record.usageAvailability = "invalid";
    };
    return { record, identify, usage, close };
  };

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
    const automatic = options.enableHubAuto === true && requested === "hub/auto";
    if (requested && !models.includes(requested)) throw new Error("model alias is not allowed");
    if (requested === mlxAlias && options.mlx) return { kind: "mlx", alias: mlxAlias };
    if (requested && requested in options.allowedDGXmodels) return { kind: "dgx", alias: requested };
    if (automatic) return autoRoute!.select(body);
    const selected = options.selectBackend ? await options.selectBackend(body) : defaultBackend;
    if (selected.kind === "mlx" && !options.mlx) throw new Error("MLX backend is not configured");
    if (selected.kind === "dgx" && !(selected.alias in options.allowedDGXmodels)) throw new Error("DGX model alias is not allowed");
    return selected;
  };

  const upstream = async (request: RelayRequest, backend: ModelBackend, signal: AbortSignal, journalEntry: RequestJournalEntry): Promise<{ response: Response; release: () => void; onModel?: (model: string) => void }> => {
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
      if (options.mlx?.provider === "ollama" && options.mlxModel && options.mlxModel !== handle.model) throw new Error("Ollama model override does not match the validated model");
      model = options.mlxModel ?? handle.model;
      if (signal.aborted) throw new Error("request was cancelled before MLX generation started");
      release = await handle.acquire(signal);
    } else {
      base = (await options.omni.base()) ?? (() => { throw new Error("DGX gateway is unavailable"); })();
      model = options.allowedDGXmodels[backend.alias]!;
    }
    const key = backend.kind === "dgx" ? options.omni.apiKey() : "";
    if (backend.kind === "dgx" && !key) throw new Error("DGX gateway key is unavailable");
    // What the relay will ask the upstream for is known before the call: a failed dispatch keeps it too.
    journalEntry.record.requestedModel = model;
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
      const isOllama = backend.kind === "mlx" && options.mlx?.provider === "ollama";
      const boundedRequest = isOllama
        ? { ...request, max_tokens: request.max_tokens ?? options.mlx!.maxTokens ?? 2048, reasoning_effort: request.reasoning_effort ?? "none" }
        : request;
      const decision = await options.admitRequest?.();
      if (decision && !decision.allowed) throw new ExecutionAdmissionError(decision.reason ?? "execution budget exhausted");
      const deadline = decision?.remainingMs === undefined ? 180_000 : Math.max(1, Math.min(180_000, decision.remainingMs));
      response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, { method: "POST", ...(isOllama ? { redirect: "error" as const } : {}), headers, body: JSON.stringify(bodyForUpstream(boundedRequest, model)), signal: AbortSignal.any([signal, AbortSignal.timeout(deadline)]) });
    } catch (error) {
      releaseOnce();
      journalEntry.record.failureClass = "transport";
      setState(backend, { state: "error", lastError: error instanceof Error ? error.message.slice(0, 160) : "upstream request failed" });
      throw error;
    }
    const provider = safeHeader(response.headers.get("x-omniroute-provider"));
    if (provider) {
      journalEntry.record.provider = provider;
      journalEntry.record.providerSource = "header";
      journalEntry.record.providerAvailability = "known";
    }
    if (!response.ok) {
      releaseOnce();
      journalEntry.record.failureClass = "http";
      journalEntry.record.httpStatus = response.status;
      const message = `backend returned HTTP ${response.status}`;
      setState(backend, { state: "error", lastError: message });
      throw new Error(message);
    }
    const actualModel = safeHeader(response.headers.get("x-model-router-selected-model"));
    if (actualModel) journalEntry.identify(actualModel, "header");
    else if (backend.kind === "mlx") journalEntry.identify(model, "configured");
    setState(backend, { state: "ready", requestedModel: request.model, active: activeByAlias.get(alias) ?? 0,
      provider: provider ?? undefined, actualModel: actualModel ?? (backend.kind === "mlx" ? model : undefined) });
    const releaseWithStatus = () => {
      releaseOnce();
      setState(backend, { active: activeByAlias.get(alias) ?? 0 });
    };
    return { response, release: releaseWithStatus, ...(actualModel ? {} : { onModel: (value: string) => { setState(backend, { actualModel: value }); journalEntry.identify(value, "stream"); } }) };
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
      const inputBudget = backend.kind === "mlx" ? (options.mlx?.maxInputTokens ?? (options.mlx?.provider === "ollama" ? 6000 : 16_000)) : dgxMaxInputTokens;
      const inputTokens = estimateInputTokens(body.messages, body.tools);
      const ollama = backend.kind === "mlx" && options.mlx?.provider === "ollama";
      const contextWindow = ollama ? (options.mlx?.contextWindow ?? 8192) : undefined;
      const configuredMaxTokens = ollama ? (options.mlx?.maxTokens ?? 2048) : undefined;
      const requestedMaxTokens = body.max_tokens === undefined ? configuredMaxTokens : body.max_tokens;
      if (ollama && (!Number.isInteger(requestedMaxTokens) || (requestedMaxTokens as number) < 1 || (requestedMaxTokens as number) > configuredMaxTokens! || inputTokens + (requestedMaxTokens as number) > contextWindow!)) {
        record.cleanup();
        activeRequests.delete(record);
        return Response.json({ error: "input and max_tokens exceed the Ollama context budget" }, { status: 400 });
      }
      if (inputTokens > inputBudget) {
        record.cleanup();
        activeRequests.delete(record);
        return Response.json({ error: "input exceeds the model context budget" }, { status: 400 });
      }
      const fallback = backend.kind === "mlx" && options.fallbackDGXAlias ? { kind: "dgx", alias: options.fallbackDGXAlias } as ModelBackend : undefined;
      const dispatchGroupId = randomUUID();
      let primaryDispatchId: string | undefined;
      const dispatch = async (selected: ModelBackend, body: RelayRequest) => {
        const journalEntry = openRequestRecord(aliasOf(selected, mlxAlias), dispatchGroupId);
        // The surface is a property of the request as admitted: even a failed dispatch keeps what the
        // native published. A request without a tools array carries no observation, never an empty one.
        if (options.observeToolSurface) {
          const surface = toolSurfaceProjection(body.tools);
          if (surface) journalEntry.record.toolSurface = surface;
        }
        if (primaryDispatchId) {
          journalEntry.record.fallbackOfId = primaryDispatchId;
          journalEntry.record.dispatchGroupId = dispatchGroupId;
        }
        else primaryDispatchId = journalEntry.record.id;
        record.closeRecord = journalEntry.close;
        let result: Awaited<ReturnType<typeof upstream>>;
        try {
          result = await upstream(body, selected, controller.signal, journalEntry);
        } catch (error) {
          journalEntry.record.failureClass ??= controller.signal.aborted ? "cancelled" : error instanceof ExecutionAdmissionError ? "admission" : "startup";
          throw error;
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          result.release();
          record.cleanup();
          activeRequests.delete(record);
        };
        record.release = release;
        const onUsage = journalEntry.usage;
        return { result, release, journalEntry, onUsage };
      };
      try {
        const { result, release, journalEntry, onUsage } = await dispatch(backend, body);
        return sseResponse(result.response, release, result.onModel, (cancel) => { record.cancel = cancel; }, journalEntry.close, onUsage);
      } catch (error) {
        record.closeRecord?.(controller.signal.aborted ? "cancelled" : "failed");
        if (!fallback || controller.signal.aborted || error instanceof ExecutionAdmissionError) {
          record.cleanup();
          activeRequests.delete(record);
          return Response.json({ error: error instanceof Error ? error.message : "backend unavailable" }, { status: 502 });
        }
        try {
          const { result, release, journalEntry, onUsage } = await dispatch(fallback, { ...body, model: fallback.alias });
          return sseResponse(result.response, release, result.onModel, (cancel) => { record.cancel = cancel; }, journalEntry.close, onUsage);
        } catch (fallbackError) {
          record.closeRecord?.(controller.signal.aborted ? "cancelled" : "failed");
          record.cleanup();
          activeRequests.delete(record);
          return Response.json({ error: fallbackError instanceof Error ? fallbackError.message : "fallback unavailable" }, { status: 502 });
        }
      }
    },
  });
  const url = `http://${host}:${server.port}/v1`;
  const status = (): ModelRelayStatus => ({ url, models, backends: [...states.values()].map((value) => ({ ...value })) });
  const requests = (): RelayRequestRecord[] => journal.map(copyRecord);
  return { url, token, models, status, requests, close: async () => {
    const closing = [...activeRequests].map(async (request) => {
      // The relay-initiated cancellation closes the record first: the abort below settles the stream
      // as a completed read, and the first terminal transition is the one that counts. Cancelling the
      // upstream reader before the abort keeps the aborted fetch body from rejecting unobserved.
      request.closeRecord?.("cancelled");
      await request.cancel?.(new Error("model relay closed"));
      request.controller.abort(new Error("model relay closed"));
      request.release?.();
      request.cleanup();
    });
    await Promise.allSettled(closing);
    activeRequests.clear();
    server.stop(false);
    await mlx?.close();
  } };
}
