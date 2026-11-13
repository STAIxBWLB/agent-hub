import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { types } from "node:util";

// Wire contract: agent-decide issue #4 / PR #5, merged source 008548c5 (policy.ts, route.ts, contract.ts).
const POLICY = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const TURN = /^[A-Za-z0-9._:-]{1,128}$/;
const ALIAS = /^[a-z0-9][a-z0-9._/:-]{0,63}$/;
const EFFORT = /^[a-z0-9][a-z0-9_-]{0,15}$/;
const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const BODY_BYTES = 64 * 1024;
const MAX_PAIRS = 26;
const REASONS = ["ok", "explicit", "pinned", "single", "no_candidate", "low_margin", "off_prem", "timeout", "http", "malformed", "outside_options", "state_too_long"] as const;
const RULES = ["onprem_only", "explicit", "no_downgrade", "ctx_max", "no_candidate", "pin_broken", "pinned", "single"] as const;
export type AdecReason = typeof REASONS[number];
export type AdecRule = typeof RULES[number];
export interface AdecPair { alias: string; effort: string }
export interface AdecRouteRequest {
  policyId: string; turnId: string; evidence: string;
  constraints: { contextTokens: number; pii: boolean; private: boolean; explicit?: AdecPair; current?: AdecPair };
  candidates?: string[];
}
export interface AdecDecision {
  id: string; policyId: string; alias: string | null; effort: string | null; margin: number; abstain: boolean;
  reason: AdecReason; fallbackApplied: boolean; pinned: boolean; rules: AdecRule[];
  estimatedCost?: number;
  decider: null | { provider: string; kind?: "systemone" | "logits"; model: string; version?: string; latencyMs: number };
}
export type AdecFailure = "caller_error" | "timeout" | "http" | "malformed" | "outside_options" | "aborted";
export type AdecResult = { ok: true; decision: AdecDecision } | { ok: false; reason: AdecFailure };
const failure = (reason: AdecFailure): AdecResult => ({ ok: false, reason });
const token = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Literal addresses only: no DNS, URL normalization aliases, credentials, query, fragment or redirect target. */
export function isAdecRouteEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?\/v1\/route$/.exec(value);
  return !!match && (match[2] === undefined || Number(match[2]) <= 65535);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const own = Reflect.ownKeys(value);
  if (own.length > keys.length) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== "string" || !keys.includes(key)) return;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return;
    result[key] = field.value;
  }
  return result;
}
function list(value: unknown, max: number): unknown[] | undefined {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, index);
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable) return;
    result.push(field.value);
  }
  return result;
}
function pair(value: unknown): AdecPair | undefined {
  const p = record(value, ["alias", "effort"]);
  return p && token(p.alias, ALIAS) && token(p.effort, EFFORT) ? { alias: p.alias, effort: p.effort } : undefined;
}
const same = (a: AdecPair, b: AdecPair) => a.alias === b.alias && a.effort === b.effort;
function prepare(value: unknown, allowed: unknown): { request: AdecRouteRequest; pairs: AdecPair[]; body: string } | undefined {
  const options = list(allowed, MAX_PAIRS);
  if (!options?.length) return;
  const pairs: AdecPair[] = [];
  for (const option of options) {
    const p = pair(option);
    if (!p || pairs.some(previous => same(previous, p))) return;
    pairs.push(p);
  }
  const r = record(value, ["policyId", "turnId", "evidence", "constraints", "candidates"]);
  if (!r || !token(r.policyId, POLICY) || !token(r.turnId, TURN) || typeof r.evidence !== "string" || r.evidence.length > BODY_BYTES) return;
  const c = record(r.constraints, ["contextTokens", "pii", "private", "explicit", "current"]);
  if (!c || typeof c.contextTokens !== "number" || !Number.isSafeInteger(c.contextTokens) || c.contextTokens < 0
    || typeof c.pii !== "boolean" || typeof c.private !== "boolean") return;
  const constraints: AdecRouteRequest["constraints"] = { contextTokens: c.contextTokens, pii: c.pii, private: c.private };
  for (const key of ["explicit", "current"] as const) if (c[key] !== undefined) {
    const p = pair(c[key]); if (!p || !pairs.some(option => same(option, p))) return;
    constraints[key] = p;
  }
  let candidates: string[] | undefined;
  if (r.candidates !== undefined) {
    const aliases = list(r.candidates, MAX_PAIRS);
    if (!aliases?.length) return;
    candidates = [];
    for (const alias of aliases) {
      if (!token(alias, ALIAS) || candidates.includes(alias) || !pairs.some(option => option.alias === alias)) return;
      candidates.push(alias);
    }
    if (constraints.explicit && !candidates.includes(constraints.explicit.alias)) return;
  }
  const request: AdecRouteRequest = { policyId: r.policyId, turnId: r.turnId, evidence: r.evidence, constraints, ...(candidates ? { candidates } : {}) };
  const body = JSON.stringify(request);
  return Buffer.byteLength(body) <= BODY_BYTES ? { request, pairs, body } : undefined;
}
function decision(value: unknown, request: AdecRouteRequest, pairs: readonly AdecPair[]): AdecResult {
  const d = record(value, ["id", "policyId", "alias", "effort", "margin", "abstain", "reason", "fallbackApplied", "pinned", "rules", "estimatedCost", "decider", "error"]);
  if (!d || !token(d.id, /^[a-f0-9]{32}$/) || d.policyId !== request.policyId || !finite(d.margin) || d.margin > 1
    || typeof d.abstain !== "boolean" || typeof d.fallbackApplied !== "boolean" || typeof d.pinned !== "boolean"
    || !REASONS.includes(d.reason as AdecReason) || d.error !== undefined && typeof d.error !== "string") return failure("malformed");
  const reason = d.reason as AdecReason, rules = list(d.rules, RULES.length);
  if (!rules || rules.some(rule => !RULES.includes(rule as AdecRule)) || new Set(rules).size !== rules.length
    || d.estimatedCost !== undefined && !finite(d.estimatedCost)) return failure("malformed");
  let selected: AdecPair | undefined;
  if (d.alias === null && d.effort === null) {
    if (reason !== "no_candidate" || !d.abstain || d.fallbackApplied || d.pinned || d.decider !== null) return failure("malformed");
  } else {
    selected = pair({ alias: d.alias, effort: d.effort });
    if (!selected || reason === "no_candidate") return failure("malformed");
    if (!pairs.some(option => same(option, selected!)) || request.candidates && !request.candidates.includes(selected.alias)
      || request.constraints.explicit && !same(request.constraints.explicit, selected)) return failure("outside_options");
    if (d.abstain !== d.fallbackApplied || d.pinned !== (reason === "pinned")
      || d.fallbackApplied !== !["ok", "explicit", "pinned", "single"].includes(reason)) return failure("malformed");
  }
  let decider: AdecDecision["decider"] = null;
  if (d.decider !== null) {
    const model = record(d.decider, ["provider", "kind", "model", "version", "latencyMs"]);
    if (!model || !token(model.provider, PROVIDER) || !token(model.model, MODEL) || !finite(model.latencyMs)
      || model.kind !== undefined && model.kind !== "systemone" && model.kind !== "logits"
      || model.version !== undefined && (!token(model.version, MODEL) || /(^|-)latest$/i.test(model.version))) return failure("malformed");
    decider = { provider: model.provider, model: model.model, latencyMs: model.latencyMs,
      ...(model.kind === undefined ? {} : { kind: model.kind }), ...(model.version === undefined ? {} : { version: model.version }) };
  }
  // Project only closed data. In particular the upstream optional error string never escapes this client.
  return { ok: true, decision: { id: d.id, policyId: request.policyId, alias: selected?.alias ?? null, effort: selected?.effort ?? null,
    margin: d.margin, abstain: d.abstain, reason, fallbackApplied: d.fallbackApplied, pinned: d.pinned, rules: rules as AdecRule[],
    ...(d.estimatedCost === undefined ? {} : { estimatedCost: d.estimatedCost as number }), decider } };
}

/** One direct loopback request, no retries or ambient credentials/proxy; deadline includes the entire response body. */
export async function requestAdecRoute(endpoint: string, input: AdecRouteRequest, allowedPairs: readonly AdecPair[], signal: AbortSignal, timeoutMs: number): Promise<AdecResult> {
  if (!isAdecRouteEndpoint(endpoint) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !(signal instanceof AbortSignal)) return failure("caller_error");
  const prepared = prepare(input, allowedPairs);
  if (!prepared) return failure("caller_error");
  if (signal.aborted) return failure("aborted");
  const url = new URL(endpoint), ipv6 = url.hostname === "[::1]", host = ipv6 ? "::1" : "127.0.0.1", port = Number(url.port || 80);
  // A private non-reusing agent with an explicit numeric socket never consults global-agent/env proxy policy.
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
  agent.createConnection = () => connect({ host, port, family: ipv6 ? 6 : 4 });
  return await new Promise<AdecResult>(resolve => {
    let req: ClientRequest | undefined, res: IncomingMessage | undefined, done = false;
    const finish = (result: AdecResult) => {
      if (done) return; done = true;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      res?.destroy(); req?.destroy(); agent.destroy(); resolve(result);
    };
    const abort = () => finish(failure("aborted"));
    const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      req = httpRequest({ hostname: host, port, path: "/v1/route", method: "POST", agent,
        headers: { host: `${ipv6 ? "[::1]" : host}:${port}`, "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(prepared.body), connection: "close" } }, response => {
        res = response;
        if (done) { response.destroy(); return; }
        if (response.statusCode !== 200) { finish(failure(response.statusCode === 400 ? "caller_error" : "http")); return; }
        if (response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
          || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity"
          || Number(response.headers["content-length"] ?? 0) > BODY_BYTES) { finish(failure("malformed")); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          if (done || chunk.byteLength === 0) return; bytes += chunk.byteLength;
          if (bytes > BODY_BYTES) { finish(failure("malformed")); return; }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (done) return;
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
            finish(decision(JSON.parse(text), prepared.request, prepared.pairs));
          } catch { finish(failure("malformed")); }
        });
        response.once("error", () => finish(failure("http")));
        response.once("aborted", () => finish(failure("http")));
      });
      req.once("error", () => finish(failure("http")));
      req.end(prepared.body);
    } catch { finish(failure("http")); }
  });
}
