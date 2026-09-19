import type { Routing } from "../hub/routing.ts";

export const KEY_ENV = "OMNIROUTE_API_KEY";

const scalar = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(scalar).join(", ")}]`;
  throw new Error(`unsupported TOML value: ${JSON.stringify(v)}`);
};

/** Bare where TOML allows it, quoted otherwise: `glm-5.3` as a bare header would parse as the nested table "glm-5"."3". */
const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function table(header: string, entries: Record<string, unknown>): string {
  const flat = Object.entries(entries).filter(([, v]) => typeof v !== "object" || Array.isArray(v));
  const nested = Object.entries(entries).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v));
  return [
    `[${header}]`,
    ...flat.map(([k, v]) => `${key(k)} = ${scalar(v)}`),
    "",
    ...nested.map(([k, v]) => table(`${header}.${key(k)}`, v as Record<string, unknown>)),
  ].join("\n");
}

/**
 * Switchyard v0.2.0 server config. routing.toml already uses Switchyard's table shapes, so this only adds what the
 * hub knows: the gateway client, `llm_client` on targets and the public `id` on routes. The API key is referenced
 * by env var name and never written; Access headers, when the live URL needs them, are the one secret in the file.
 */
export function switchyardToml(routing: Routing, gateway: { baseUrl: string; extraHeaders: Record<string, string> }): string {
  const headers = Object.entries(gateway.extraHeaders);
  const client = [
    "[llm_clients.gateway]",
    'format = "openai_chat"',
    `base_url = ${scalar(gateway.baseUrl)}`,
    `api_key_env = ${scalar(KEY_ENV)}`,
    ...(headers.length ? [`extra_headers = { ${headers.map(([k, v]) => `${scalar(k)} = ${scalar(v)}`).join(", ")} }`] : []),
    // no timeout_ms: the 0.2.0 binary rejects it (its llm_clients fields are format, base_url, api_key_env, extra_headers, max_retries)
    "",
  ].join("\n");
  const targets = Object.entries(routing.targets).map(([name, t]) => table(`targets.${key(name)}`, { ...t, llm_client: "gateway" }));
  const routes = Object.entries(routing.routes).map(([id, r], i) => table(`routes.r${i}`, { id, ...r }));
  return ["schema_version = 1", "", client, ...targets, ...routes].join("\n");
}
