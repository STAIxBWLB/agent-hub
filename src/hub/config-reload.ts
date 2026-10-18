import { ADAPTERS } from "../adapters/registry.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateRawConfig, type ConfigLayer } from "./config-apply.ts";
import { parseOverlay, parseRouting, type Routing } from "./routing.ts";
import { CLASSES } from "./board.ts";
import { validateInstances } from "./instances.ts";

export const CONFIG_SOURCE_FILES = ["config.json", "config.local.json", "routing.toml", "routing.local.toml"] as const;
export type ConfigSourceName = typeof CONFIG_SOURCE_FILES[number];
export type ConfigSourceTexts = Record<ConfigSourceName, string | null>;
export interface ConfigSources {
  texts: ConfigSourceTexts;
  layers: ConfigLayer[];
  trustLayers: { name: ConfigSourceName; raw: Record<string, unknown> }[];
  routing: Routing;
  fingerprint: string;
}
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Capture once; a missing file is distinct from a read failure. Errors never quote file contents. */
export function configSourceTexts(cwd: string): ConfigSourceTexts {
  return Object.fromEntries(CONFIG_SOURCE_FILES.map(name => {
    try {
      const text = readFileSync(join(cwd, ".agenthub", name), "utf8");
      if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw new Error("oversized");
      return [name, text];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null];
      throw new Error(`.agenthub/${name}: configuration unavailable or oversized`);
    }
  })) as ConfigSourceTexts;
}

export const configFingerprint = (texts: ConfigSourceTexts): string => createHash("sha256").update(JSON.stringify(texts)).digest("hex");

/** Validate only the hub-owned routing schema; Switchyard target/route fields remain extensible. */
function validateRoutingRaw(value: unknown): void {
  const bad = (key: string): never => { throw new Error(`.agenthub/routing.toml: ${key} is invalid or unknown`); };
  const table = (v: unknown, key: string): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length > 256) return bad(key);
    if (Object.keys(v).some(name => ["__proto__", "constructor", "prototype"].includes(name))) return bad(key);
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, key: string) => { if (typeof v !== "string" || !v || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) bad(key); };
  const numeric = (v: unknown, key: string, min = 1, max = Number.MAX_SAFE_INTEGER) => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) bad(key); };
  const choice = (v: unknown, key: string, choices: readonly string[]) => { if (typeof v !== "string" || !choices.includes(v)) bad(key); };
  const closed = (v: unknown, key: string, fields: Record<string, (v: unknown, key: string) => void>) => {
    for (const [name, item] of Object.entries(table(v, key))) { if (!Object.hasOwn(fields, name)) bad(`${key}.${name}`); fields[name]!(item, `${key}.${name}`); }
  };
  const peers = (v: unknown, key: string) => {
    if (!Array.isArray(v) || v.length > 128 || new Set(v).size !== v.length || v.some(peer => typeof peer !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(peer))) bad(key);
  };
  const strings = (v: unknown, key: string) => { if (!Array.isArray(v) || v.length > 256 || v.some(x => typeof x !== "string" || x.length > 4096)) bad(key); };
  const bool = (v: unknown, key: string) => { if (typeof v !== "boolean") bad(key); };
  const openValue = (v: unknown, key: string, depth = 0): void => {
    if (depth > 16) bad(key);
    if (typeof v === "string") { if (v.length > 16_384) bad(key); }
    else if (typeof v === "number") { if (!Number.isFinite(v)) bad(key); }
    else if (typeof v === "boolean" || v === null) return;
    else if (Array.isArray(v)) { if (v.length > 1024) bad(key); for (const item of v) openValue(item, key, depth + 1); }
    else for (const item of Object.values(table(v, key))) openValue(item, key, depth + 1);
  };
  const switchyard = (v: unknown, key: string, required: "id" | "type") => {
    for (const [name, item] of Object.entries(table(v, key))) {
      if (!name || name.length > 128 || ["__proto__", "constructor", "prototype"].includes(name)) bad(key);
      const entry = table(item, `${key}.${name}`); text(entry[required], `${key}.${name}.${required}`); openValue(entry, `${key}.${name}`);
    }
  };
  const nativeValidators = { bool, text, strings, argv: strings,
    number: (min = 1, max = Number.MAX_SAFE_INTEGER, _integer = true) => (v: unknown, k: string) => numeric(v, k, min, max),
    words: (values: readonly string[]) => (v: unknown, k: string) => choice(v, k, values),
    block: (fields: Record<string, (v: unknown, k: string) => void>) => (v: unknown, k: string) => closed(v, k, fields),
  };
  closed(value, "routing", {
    ...Object.assign({}, ...ADAPTERS.map(adapter => adapter.configuration?.routingSchema?.(nativeValidators) ?? {})),
    targets: (v, k) => switchyard(v, k, "id"), routes: (v, k) => switchyard(v, k, "type"),
    // parseRouting delegates these tables to the existing parseHubRoutes validator.
    hub_routes: (v, k) => { table(v, k); },
    stay_switch: (v, k) => choice(v, k, ["off", "shadow", "enforce"]), max_switch_prefill_tokens: numeric,
    signals: (v, k) => closed(v, k, { pii_patterns: strings, long_context_tokens: numeric, pii_screen: (x, p) => choice(x, p, ["off", "local"]) }),
    constraints: (v, k) => closed(v, k, { pii: (x, p) => choice(x, p, ["local_only", "off"]), long_context: (x, p) => choice(x, p, ["skip_local", "off"]), budget_paused: (x, p) => choice(x, p, ["skip_peer", "off"]) }),
    classes: (v, k) => { for (const [name, item] of Object.entries(table(v, k))) {
      if (!(CLASSES as readonly string[]).includes(name)) bad(`${k}.${name}`);
      closed(item, `${k}.${name}`, { peers, escalate_to: peers, route: text, fixed_model: text, local_allowed: bool, pi_backend: (x, p) => choice(x, p, ["dgx", "mlx"]) });
    } },
  });
}

/** Strict reloads never use routing's last-good fallback. Startup can retain its existing fallback explicitly. */
export function parseConfigSources(texts: ConfigSourceTexts, fallbackRouting?: Routing): ConfigSources {
  const layers: ConfigLayer[] = [], trustLayers: ConfigSources["trustLayers"] = [];
  let localRaw: Record<string, unknown> = {};
  try { localRaw = JSON.parse(texts["config.local.json"] ?? "{}"); }
  catch { if (!fallbackRouting) throw new Error(".agenthub/config.local.json: invalid JSON object"); }
  let declared;
  try { declared = validateInstances(localRaw?.instances); }
  catch (error) {
    if (!fallbackRouting) throw new Error(`.agenthub/config.local.json: ${(error as Error).message}`);
    declared = validateInstances(undefined);
  }
  for (const name of CONFIG_SOURCE_FILES) {
    const text = texts[name];
    if (text === null) continue;
    let raw: Record<string, unknown>;
    try {
      const value: unknown = name.endsWith(".json") ? JSON.parse(text) : Bun.TOML.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      raw = value as Record<string, unknown>;
    } catch {
      if (!fallbackRouting) throw new Error(`.agenthub/${name}: invalid ${name.endsWith(".json") ? "JSON object" : "TOML"}`);
      continue;
    }
    if (name === "config.json" || name === "config.local.json") {
      if (!fallbackRouting) {
        try { validateRawConfig(raw, declared); }
        catch (error) { throw new Error(`.agenthub/${name}: ${(error as Error).message}`); }
      }
      layers.push({ name, raw });
    }
    trustLayers.push({ name, raw });
  }
  let routing = fallbackRouting;
  if (!routing) {
    const base = texts["routing.toml"] ?? readFileSync(new URL("../../templates/routing.toml", import.meta.url), "utf8");
    validateRoutingRaw(Bun.TOML.parse(base));
    let overlay;
    try { overlay = texts["routing.local.toml"] === null ? undefined : parseOverlay(texts["routing.local.toml"]); }
    catch { throw new Error(".agenthub/routing.local.toml: invalid routing overlay"); }
    try { routing = parseRouting(base, overlay); }
    catch { throw new Error(".agenthub/routing.toml / routing.local.toml: invalid effective routing"); }
  }
  return { texts, layers, trustLayers, routing, fingerprint: configFingerprint(texts) };
}
