import type { HubConfig } from "./daemon.ts";
import { ALL_MACHINE_LOCAL, configRepositoryPresent, configTracked } from "./config-trust.ts";
import { SUPPORTED_PEERS, PLANNER_PEERS } from "./peer-catalog.ts";
import { CLASSES } from "./board.ts";
import { permissionDefaults } from "./permission-mode.ts";
import { peerStartConfig, terminalTemplate } from "./start-mode.ts";
import { catalogAssignments } from "./roles.ts";
import { resolveProfile } from "./profiles.ts";
import { taskSweepConfig } from "./task-sweep.ts";
import { projectionConfig } from "./text-projection.ts";

export type ApplyClass = "live" | "next use" | "restart";
export interface ApplyRule { applies: ApplyClass; reason?: string }
export interface ConfigChange extends ApplyRule { key: string; before: unknown; after: unknown }
export interface ConfigLayer { name: "config.json" | "config.local.json"; raw: Record<string, unknown> }
export interface ReloadGuard { key: string; path: readonly string[]; risk: "safe" | "raises"; floor?: string | boolean | number; store: "runtime" | "config" | "routing" }
type TrustLayer = ConfigLayer | { name: "routing.toml" | "routing.local.toml"; raw: Record<string, unknown> };
type Authority = "ordinary" | "settings" | "terminal";
type Check = (value: unknown, key: string) => void;
const fail = (key: string, reason = "invalid value"): never => { throw new Error(`${key}: ${reason}`); };
const object = (value: unknown, key: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(key, "must be an object");
  return value as Record<string, unknown>;
};
const bool: Check = (v, k) => { if (typeof v !== "boolean") fail(k, "must be a boolean"); };
const text: Check = (v, k) => { if (typeof v !== "string" || v.length > 16_384 || /[\x00-\x1f\x7f]/.test(v)) fail(k, "must be bounded text"); };
const number = (min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): Check => (v, k) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || integer && !Number.isSafeInteger(v)) fail(k, "number outside bounds");
};
const words = (values: readonly string[]): Check => (v, k) => { if (typeof v !== "string" || !values.includes(v)) fail(k, "unknown choice"); };
const strings: Check = (v, k) => { if (!Array.isArray(v) || v.length > 1024) return fail(k, "must be a bounded string list"); for (const x of v) text(x, k); };
const argv: Check = (v, k) => { strings(v, k); if (!(v as string[]).length || (v as string[]).some(x => !x)) fail(k, "must be a nonempty argv"); };
const shapes = new WeakMap<Check, { fields?: Record<string, Check>; item?: Check; keys?: readonly string[] }>();
const map = (check: Check, keys?: readonly string[]): Check => {
  const fn: Check = (v, k) => { for (const [key, value] of Object.entries(object(v, k))) {
    if (["__proto__", "constructor", "prototype"].includes(key) || keys && !keys.includes(key)) fail(`${k}.${key}`, "unknown key"); check(value, `${k}.${key}`);
  } };
  shapes.set(fn, { item: check, keys }); return fn;
};
const block = (schema: Record<string, Check>): Check => {
  const fn: Check = (v, k) => { for (const [key, value] of Object.entries(object(v, k))) {
    if (!Object.hasOwn(schema, key)) fail(`${k}.${key}`, "unknown key"); if (value !== undefined) schema[key]!(value, `${k}.${key}`);
  } };
  shapes.set(fn, { fields: schema }); return fn;
};
const peerMap = (check: Check) => map(check, SUPPORTED_PEERS);
const timerSeconds = number(1, 2_147_483_647 / 1000), timerMinutes = number(1, 2_147_483_647 / 60_000);
const schema: Record<string, Check> = {
  watchdog_ms: number(1, 2_147_483_647), kimi_cmd: argv, qwen_cmd: argv, jcode_cmd: argv, codex_bin: text, jcode_home: text, jcode_provider_profile: text,
  permission_modes: v => { permissionDefaults(v); }, protect_instruction_files: bool,
  batch_max: number(1, 100_000, true), batch_ms: number(0, 2_147_483_647), queue_cap: number(1, 1_000_000, true),
  memory: block({ enabled: bool, worker_url: text, inject_tokens: number(0, 1_000_000, true), brief_items: number(0, 10_000, true), native: bool,
    short_ttl_days: number(1, 3650, true), sync_interval_min: number(0, 1440, true), suggest_edges: bool }),
  roster: peerMap(bool), roles: map(strings), planner: words(PLANNER_PEERS), profile: words(["dev", "research", "writing", "general"]),
  profile_overrides: v => { resolveProfile("dev", v); }, catalog_roles: v => { catalogAssignments(v); },
  pii: block({ paths: strings }), data: block({ readonly: strings }),
  text_projection: v => { projectionConfig(v); },
  conductor: block({ feed: words(["own", "all", "off"]), approval_wait_s: number(0, 2_147_483_647 / 1000) }),
  budget: block({ gate: number(0, 1), stale_min: timerMinutes, poll_min: timerMinutes, checkpoint_timeout_s: timerSeconds, kimi_tokens_5h: number(0), wait_max_min: number(0) }),
  context: block({ gate: number(0, 1), stale_min: timerMinutes }),
  inference: block({ enabled: bool, digest_min_items: number(1, 100_000, true), digest_min_chars: number(1, 10_000_000, true), triage: bool }),
  omniroute: block({ urls: strings, api_key_file: text, access_hosts: strings, cf_client_id_file: text, cf_client_secret_file: text }),
  pi: block({ enabled: bool, auto_start: bool, cmd: argv, backend: words(["auto", "dgx", "mlx"]), dgx_coding: text, dgx_fast: text, max_steps: number(1, 1_000_000, true) }),
  mlx: block({ enabled: bool, provider: words(["legacy", "ollama"]), host: text, runtimeDir: text, modelPath: text, bin: text, port: number(1, 65535, true), model: text, sourceModel: text,
    contextWindow: number(1), maxInputTokens: number(1), maxTokens: number(1), maxConcurrency: number(1, 1024, true) }),
  local: block({ deny: strings, bash_network: (v, k) => { if (v !== "direct") bool(v, k); }, network_allow: strings, max_steps: number(1, 1_000_000, true), read_allow: strings }),
  approvals: block({ timeout_s: timerSeconds, notify: bool }), tasks: block({ release_after_min: number(0), wip_limits: map(number(0, 32, true)) }),
  task_sweep: (v, k) => { block({ enabled: bool, auto_reassign: bool, interval_s: timerSeconds, unaccepted_min: timerMinutes, idle_min: timerMinutes, review_min: timerMinutes, ready_min: timerMinutes, ladder_min: timerMinutes })(v, k); taskSweepConfig(v); },
  checks: (v, k) => { for (const [key, value] of Object.entries(object(v, k))) {
    if (value === undefined) continue;
    if (key === "timeout_s") timerSeconds(value, `${k}.${key}`);
    else if (key === "runner") words(["container"])(value, `${k}.${key}`);
    else if (/^[a-z][a-z0-9_]{0,47}$/.test(key)) text(value, `${k}.${key}`); else fail(`${k}.${key}`, "unknown key");
  } },
  snapshots: block({ enabled: bool, keep: number(1, 1_000_000, true) }), research: block({ enabled: bool }), bench: block({ enabled: bool }),
  peers: (v, k) => { map(block({ start_mode: words(["tui", "headless"]) }), ["pi", "codex", "kimi"])(v, k); peerStartConfig(v); },
  terminal: (v, k) => { block({ open: strings })(v, k); terminalTemplate(object(v, k).open); },
  limits: block({ sender_per_min: number(0), pair_per_min: number(0), important_per_hour: number(0), repeat_window_s: number(0) }),
  review: block({ adaptive: bool, min_reviews: number(1, Number.MAX_SAFE_INTEGER, true) }), recovery: block({ auto_resume_after_crash: bool }),
  capabilities: map(strings), coordination: words(["advisory", "turn-free"]), experiments: block({ stale_notices: words(["drop", "deliver"]) }),
};
export function validateRawConfig(raw: unknown): asserts raw is Record<string, unknown> { block(schema)(raw, "config"); }
export function validateEffectiveConfig(value: unknown): asserts value is HubConfig {
  const raw = { ...object(value, "config") };
  delete raw.ignored; delete raw.retired; delete raw.permission_default_sources;
  validateRawConfig(raw);
  const profile = resolveProfile(raw.profile, raw.profile_overrides);
  for (const key of Object.keys(object(raw.checks, "checks"))) if (!["timeout_s", "runner", ...CLASSES, ...Object.keys(profile.classes)].includes(key)) fail(`checks.${key}`, "unknown task class");
  if (object(raw.mlx, "mlx").enabled === false && object(raw.pi, "pi").backend === "mlx") fail("pi.backend", "conflicts with disabled mlx");
}

const restart: Record<string, string> = {
  "pi.dgx_coding": "Published Pi relay model catalogue requires a new daemon relay",
  "pi.dgx_fast": "Published Pi relay model catalogue requires a new daemon relay",
  "routing.pi": "Pi relay context and model publication are bound to the running relay",
  memory: "Open memory consumers, selected profile, client and sync timer must be quiesced together",
  omniroute: "Credentials and gateway clients are bound to relay ownership", mlx: "Model runtime ownership and device resources belong to this daemon",
  checks: "Bounded runner and completion-check contracts are constructed together",
  pii: "Existing native sessions retain their startup privacy boundary", data: "Existing native sessions retain their startup read-only policy",
  "local.deny": "Existing native sessions retain their sandbox deny policy", "local.read_allow": "Existing native sessions retain their sandbox read grants",
  "local.bash_network": "Existing sandbox and egress proxy contracts require a new instance", "local.network_allow": "Existing egress proxy ownership requires a new instance",
  profile: "Session tool schemas and profile contracts are bound at startup", profile_overrides: "Session tool schemas and profile contracts are bound at startup",
  text_projection: "Converter and cache ownership are bound at startup", terminal: "Terminal provider is supplied by the daemon lifecycle", bench: "Benchmark execution environment is selected before work starts",
};
const live = new Set(["permission", "roster", "roles", "planner", "conductor", "protect_instruction_files", "task_sweep", "capabilities", "research", "snapshots", "tasks.wip_limits", "approvals.notify"]);
const nextMemory = new Set(["memory.inject_tokens", "memory.brief_items", "memory.suggest_edges"]);
/** Closed top-level schema; leaf overrides retain the existing session/runtime boundaries. */
export function configApply(key: string): ApplyRule {
  const top = key.split(".")[0]!;
  if (!(Object.hasOwn(schema, top) || top === "permission" || top === "routing")) return fail(key, "unknown configuration key");
  if (top !== "routing" && top !== "permission" && key.includes(".")) {
    const special: Record<string, readonly string[]> = {
      task_sweep: ["enabled", "auto_reassign", "interval_s", "unaccepted_min", "idle_min", "review_min", "ready_min", "ladder_min"],
      checks: ["timeout_s", "runner", ...CLASSES], terminal: ["open"],
    };
    let check = schema[top];
    for (const [index, part] of key.split(".").slice(1).entries()) {
      const shape = check && shapes.get(check);
      if (shape?.fields) { if (!Object.hasOwn(shape.fields, part)) return fail(key, "unknown configuration key"); check = shape.fields[part]; }
      else if (shape?.item) { if (shape.keys && !shape.keys.includes(part)) return fail(key, "unknown configuration key"); check = shape.item; }
      else if (index === 0 && (special[top]?.includes(part) || top === "checks" && /^[a-z][a-z0-9_]{0,47}$/.test(part))) break;
      else if (["permission_modes", "catalog_roles", "profile_overrides", "text_projection", "peers"].includes(top)) break;
      else return fail(key, "unknown configuration key");
    }
  }
  if (top === "routing" && !key.startsWith("routing.pi") && key !== "routing") {
    return { applies: ["classes", "stay_switch", "signals", "constraints", "hub_routes", "max_switch_prefill_tokens"].includes(key.split(".")[1]!) ? "live" : "next use" };
  }
  if (nextMemory.has(key)) return { applies: "next use" };
  for (const [path, reason] of Object.entries(restart)) if (key === path || key.startsWith(`${path}.`)) return { applies: "restart", reason };
  if ([...live].some(path => key === path || key.startsWith(`${path}.`))) return { applies: "live" };
  return { applies: "next use" };
}
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const at = (raw: unknown, path: readonly string[]): unknown => path.reduce<unknown>((v, k) => v && typeof v === "object" && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined, raw);
export function configChanges(running: HubConfig, next: HubConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const walk = (before: unknown, after: unknown, key: string) => {
    if (same(before, after)) return;
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const child of new Set([...Object.keys(before), ...Object.keys(after)])) walk(at(before, [child]), at(after, [child]), key ? `${key}.${child}` : child);
    } else changes.push({ key, before, after, ...configApply(key) });
  };
  const clean = (v: HubConfig) => Object.fromEntries(Object.entries(v).filter(([key]) => !["ignored", "retired", "permission_default_sources"].includes(key)));
  walk(clean(running), clean(next), ""); return changes.sort((a, b) => a.key.localeCompare(b.key));
}

/** File authority is checked before stripped/defaulted effective values can hide a guarded edit. */
export function assertReloadTrust(cwd: string, layers: readonly TrustLayer[], previousLayers: readonly TrustLayer[], guardedRules: readonly ReloadGuard[], authority: Authority, defaults?: object): void {
  const complete = [...layers, ...previousLayers.filter(prior => !layers.some(layer => layer.name === prior.name)).map(prior => ({ ...prior, raw: {} }))];
  for (const layer of complete) {
    const prior = previousLayers.find(p => p.name === layer.name)?.raw;
    const routing = layer.name.endsWith(".toml");
    const paths = new Map<string, { path: readonly string[]; floor?: unknown; machine: boolean; registered?: boolean }>();
    if (!routing) for (const key of ALL_MACHINE_LOCAL) {
      const path = key.split("."), value = at(layer.raw, path), old = at(prior, path);
      const children = new Set([...(value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : []), ...(old && typeof old === "object" && !Array.isArray(old) ? Object.keys(old) : [])]);
      if (children.size) for (const child of children) paths.set(`${key}.${child}`, { path: [...path, child], machine: true });
      else paths.set(key, { path, machine: true });
    }
    for (const rule of guardedRules) if (rule.risk === "raises" && rule.store === (routing ? "routing" : "config")) {
      const key = rule.path.join(".");
      paths.set(key, { path: rule.path, floor: rule.floor, registered: true, machine: !routing && ALL_MACHINE_LOCAL.some(p => key === p || key.startsWith(`${p}.`)) });
    }
    for (const [key, guard] of paths) {
      const value = at(layer.raw, guard.path), old = at(prior, guard.path);
      if (same(value, old)) continue;
      const inherit = guard.registered && value === undefined && old !== undefined;
      if (!inherit && guard.machine && defaults && same(value, at(defaults, guard.path))) continue;
      // Removal can expose a lower layer: registry inherit is guarded just like a direct raise.
      if (!guard.machine && value !== undefined && same(value, guard.floor)) continue;
      // Empty machine-local declarations choose no program/path and are stripped at startup.
      if (!inherit && guard.machine && (value === undefined || value === null || value === "" || Array.isArray(value) && !value.length)) continue;
      let tracked = configTracked(cwd, layer.name);
      if (!guard.machine && tracked === undefined && !configRepositoryPresent(cwd)) tracked = false;
      if (tracked !== false) fail(`${layer.name}:${key}`, tracked ? "guarded change is tracked" : "guarded source trust is unknown");
      if (guard.machine && authority === "settings" && !guard.registered) fail(`${layer.name}:${key}`, "non-editable machine policy requires terminal authority");
      if (value !== undefined && guard.floor !== undefined && same(value, guard.floor)) continue;
      if (authority === "ordinary") fail(`${layer.name}:${key}`, "guarded change requires settings or terminal authority");
    }
  }
}
