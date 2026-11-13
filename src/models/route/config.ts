import { isAdecRouteEndpoint } from "./adec.ts";
import { AMBIGUOUS_BAND_DEFAULT, AMBIGUOUS_BAND_MAX } from "./stage-fallback.ts";

/** In-process hub model-route policy. */
export interface HubRoute {
  type: "stage" | "plan_execute" | "advisor" | "escalation" | "decision";
  decision_backend?: "adec";
  decision_mode?: "off" | "shadow";
  adec_endpoint?: string;
  policy_id?: string;
  candidates?: { alias: string; efforts: string[] }[];
  decision_timeout_ms?: number;
  classifier?: "decision";
  ambiguous_band?: number;
  efficient?: string;
  capable?: string;
  judge?: string;
  confidence_threshold?: number;
  hold_turns?: number;
  confirmations?: number;
  max_reviews?: number;
  gate_min_tool_results?: number;
  gate_stall_turns?: number;
  trigger?: "no_tool_call" | "pattern";
  pattern?: string;
  transcript_max_chars?: number;
}

const TYPES = new Set(["stage", "plan_execute", "advisor", "escalation", "decision"]);
/** Reject half-written/unsafe configuration at load time, before a task operation writes the board. */
export function parseHubRoutes(input: unknown): Record<string, HubRoute> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("routing.toml: hub_routes must be a table");
  const out: Record<string, HubRoute> = {};
  for (const [id, value] of Object.entries(input)) {
    if (!id.startsWith("hub/") || !value || typeof value !== "object" || Array.isArray(value)) throw new Error("routing.toml: hub route ids must start with hub/");
    const r = value as Record<string, unknown>;
    if (!TYPES.has(String(r.type))) throw new Error(`routing.toml: unknown hub route type for ${id}`);
    for (const field of ["efficient", "capable", "judge"]) if (r[field] !== undefined && (typeof r[field] !== "string" || !r[field]!.toString().trim())) throw new Error(`routing.toml: ${id}.${field} must be a model id`);
    for (const field of ["hold_turns", "confirmations", "max_reviews", "gate_min_tool_results", "gate_stall_turns", "transcript_max_chars"]) {
      const n = r[field];
      if (n !== undefined && (!Number.isSafeInteger(n) || Number(n) < (field === "hold_turns" || field.startsWith("gate_") ? 0 : field === "transcript_max_chars" ? 256 : 1) || Number(n) > 200_000)) throw new Error(`routing.toml: invalid ${id}.${field}`);
    }
    if (r.confidence_threshold !== undefined && (typeof r.confidence_threshold !== "number" || !Number.isFinite(r.confidence_threshold) || r.confidence_threshold < 0 || r.confidence_threshold > 1)) throw new Error(`routing.toml: invalid ${id}.confidence_threshold`);
    if (r.trigger !== undefined && r.trigger !== "pattern" && r.trigger !== "no_tool_call") throw new Error(`routing.toml: invalid ${id}.trigger`);
    if (r.pattern !== undefined && typeof r.pattern !== "string") throw new Error(`routing.toml: invalid ${id}.pattern`);
    if (r.trigger === "pattern" && !r.pattern) throw new Error(`routing.toml: ${id} requires pattern`);
    if (typeof r.pattern === "string") new RegExp(r.pattern, "u");
    if (r.type === "decision") {
      out[id] = parseDecisionConfig(id, r);
    } else if (r.type === "stage") {
      out[id] = parseStageConfig(id, r);
    } else if (SERVICE_FIELDS.some(field => r[field] !== undefined)) {
      out[id] = parseDecisionConfig(id, r);
    } else out[id] = r as unknown as HubRoute;
  }
  return out;
}

/** A stage route keeps the deterministic picker; the optional classifier only decides whether adec is asked. */
function parseStageConfig(id: string, r: Record<string, unknown>): HubRoute {
  if (r.classifier === undefined) {
    if (r.ambiguous_band !== undefined) throw new Error(`routing.toml: invalid ${id}.ambiguous_band; set classifier = "decision" first`);
    if (SERVICE_FIELDS.some(field => r[field] !== undefined)) throw new Error(`routing.toml: invalid ${id} service binding; set classifier = "decision" first`);
    return r as unknown as HubRoute;
  }
  const problem = (field: string, step: string): never => { throw new Error(`routing.toml: invalid ${id}.${field}; ${step}`); };
  if (r.classifier !== "decision") problem("classifier", 'use "decision"');
  const service = parseServiceConfig(id, r);
  for (const tier of ["efficient", "capable"] as const) if (typeof r[tier] !== "string" || !(r[tier] as string).trim()) problem(tier, 'name the model alias this tier executes when classifier = "decision"');
  const band = r.ambiguous_band ?? AMBIGUOUS_BAND_DEFAULT;
  if (typeof band !== "number" || !Number.isFinite(band) || band < 0 || band > AMBIGUOUS_BAND_MAX) problem("ambiguous_band", `use a number from 0 to ${AMBIGUOUS_BAND_MAX}`);
  return { ...r, ...service, ambiguous_band: band } as unknown as HubRoute;
}

function parseDecisionConfig(id: string, r: Record<string, unknown>): HubRoute {
  const service = parseServiceConfig(id, r);
  const problem = (field: string, step: string): never => { throw new Error(`routing.toml: invalid ${id}.${field}; ${step}`); };
  if (!Array.isArray(r.candidates) || !r.candidates.length || r.candidates.length > 26) problem("candidates", "list 1 to 26 policy alias/effort pairs");
  const candidates: { alias: string; efforts: string[] }[] = [], seen = new Set<string>();
  let pairCount = 0;
  for (const candidate of r.candidates as unknown[]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) problem("candidates", "use tables with an alias and an efforts list");
    const pair = candidate as Record<string, unknown>;
    if (Object.keys(pair).some(key => key !== "alias" && key !== "efforts") || typeof pair.alias !== "string" || !/^[a-z0-9][a-z0-9._/:-]{0,63}$/.test(pair.alias) || !Array.isArray(pair.efforts) || !pair.efforts.length || pair.efforts.some(effort => typeof effort !== "string" || !/^[a-z0-9][a-z0-9_-]{0,15}$/.test(effort))) problem("candidates", "use a bounded policy alias and a non-empty efforts list");
    const alias = pair.alias as string, efforts = pair.efforts as string[];
    pairCount += efforts.length;
    if (seen.has(alias) || new Set(efforts).size !== efforts.length || pairCount > 26) problem("candidates", "remove duplicate aliases/efforts and keep at most 26 pairs");
    seen.add(alias); candidates.push({ alias, efforts: [...efforts] });
  }
  return { ...r, ...service, candidates } as unknown as HubRoute;
}

const SERVICE_FIELDS = ["decision_backend", "decision_mode", "policy_id", "adec_endpoint", "candidates", "decision_timeout_ms"] as const;
/** One validator for service binding, independent of a route's stage/host semantics. */
function parseServiceConfig(id: string, r: Record<string, unknown>): Pick<HubRoute, "decision_backend" | "decision_mode" | "adec_endpoint"> {
  const problem = (field: string, step: string): never => { throw new Error(`routing.toml: invalid ${id}.${field}; ${step}`); };
  if (r.decision_backend !== "adec") problem("decision_backend", 'set decision_backend = "adec" for a loopback policy service');
  if (r.decision_mode === "enforce") throw new Error("decision_mode enforce is not available yet; use shadow; tracked in #554");
  if (r.decision_mode !== undefined && !["off", "shadow"].includes(String(r.decision_mode))) problem("decision_mode", 'use "off" or "shadow"');
  if (typeof r.policy_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,49}$/.test(r.policy_id)) problem("policy_id", "name a configured adec policy with 1 to 50 lowercase identifier characters");
  const endpoint = r.adec_endpoint ?? "http://127.0.0.1:8740/v1/route";
  if (!isAdecRouteEndpoint(endpoint)) return problem("adec_endpoint", "use an HTTP numeric loopback /v1/route URL without credentials, query or fragment");
  if (r.decision_timeout_ms !== undefined && (!Number.isSafeInteger(r.decision_timeout_ms) || Number(r.decision_timeout_ms) < 1 || Number(r.decision_timeout_ms) > 30_000)) problem("decision_timeout_ms", "use 1 to 30000 milliseconds");
  return { decision_backend: "adec", decision_mode: (r.decision_mode ?? "off") as "off" | "shadow", adec_endpoint: endpoint };
}
