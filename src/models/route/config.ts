/** Hub-owned model policy. Deliberately separate from Switchyard sidecar tables. */
export interface HubRoute {
  type: "stage" | "plan_execute" | "advisor" | "escalation";
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

const TYPES = new Set(["stage", "plan_execute", "advisor", "escalation"]);
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
    out[id] = r as unknown as HubRoute;
  }
  return out;
}
