import { remoteRunnerConfig } from "./check-runner.ts";
import { ACTION_CLASSES } from "./action-class.ts";
import { actionPolicyConfig } from "./action-policy.ts";
import { adapterModuleDeclarations } from "../adapters/external-modules.ts";
import { externalMetadataDefinitions, type ExternalAdapterMetadata } from "../adapters/external-metadata.ts";
import { reviewerPoolConfig } from "./reviewer-pool-config.ts";
import type { HubConfig } from "./daemon.ts";
import { ALL_MACHINE_LOCAL, configRepositoryPresent, configTracked } from "./config-trust.ts";
import { structuralLeaf } from "./config-tier.ts";
import { createProjectAdapterCatalog, type ProjectAdapterCatalog, ADAPTERS, DEFAULT_REVIEW_POOL, REVIEW_POOL_KINDS, SUPPORTED_PEERS, PLANNER_PEERS, START_MODE_PEERS } from "../adapters/registry.ts";
import { CLASSES } from "./board.ts";
import { permissionDefaults } from "./permission-mode.ts";
import { peerStartConfig, terminalTemplate } from "./start-mode.ts";
import { catalogAssignments } from "./roles.ts";
import { resolveProfile } from "./profiles.ts";
import { taskSweepConfig } from "./task-sweep.ts";
import { projectionConfig } from "./text-projection.ts";
import { validateInstances, type InstancesConfig } from "./instances.ts";
import { peerRosterConfig, staleInstanceKey } from "./roster.ts";
import { CHARACTER_IDS } from "../pet/characters.ts";
import { checkSettingValue, settingDef } from "./settings.ts";
import { petPalette } from "../pet/config.ts";

export type ApplyClass = "live" | "next use" | "restart";
export interface ApplyRule { applies: ApplyClass; reason?: string }
export interface ConfigIdentityScope { catalog: ProjectAdapterCatalog; instances: InstancesConfig }
/** Plain captured metadata stays cloneable with ConfigSources; native callbacks are compiled outside it. */
export interface ConfigIdentitySnapshot { adapters?: HubConfig["adapters"]; externalAdapters?: readonly ExternalAdapterMetadata[]; instances: InstancesConfig }
export function configIdentityScope(snapshot: ConfigIdentitySnapshot): ConfigIdentityScope {
  return { catalog: createProjectAdapterCatalog(snapshot.adapters, externalMetadataDefinitions(snapshot.externalAdapters)), instances: snapshot.instances };
}
export interface ConfigChange extends ApplyRule { key: string; before: unknown; after: unknown }
export interface ConfigLayer { name: "config.json" | "config.local.json"; raw: Record<string, unknown> }
export interface ReloadGuard { key: string; path: readonly string[]; risk: "safe" | "raises"; floor?: string | boolean | number; store: "runtime" | "config" | "routing" }
export interface ConfigAuthorizationInput {
  key: string;
  before: unknown;
  after: unknown;
  source: "config" | "routing";
  /** Captured host filename, not the requested setting or a caller-provided authority. */
  sourceFile?: string;
  tracked: boolean | undefined;
  authority: "ordinary" | "settings" | "terminal";
  /** The daemon supplies this only for the selected setting or an explicitly confirmed reload key. */
  confirmed?: boolean;
  /** Root proved the destination equals an unchanged, effective startup declaration in this origin. */
  acceptedFallback?: boolean;
  /** The prospective settled planner/conductor holder sets change, even if the raw role list shrinks. */
  settledHolderChange?: boolean;
  /** #689: the daemon sets this only for a structural edit it validated and wrote itself; `structuralLeaf` still decides the key. */
  structural?: boolean;
  guard?: ReloadGuard;
}
export interface ConfigAuthorizationDecision { key: string; allowed: boolean; guarded: boolean; reason: string }

/** Pure per-leaf authority. Schema validation and named-key selection precede this decision. */
export function authorizeConfigLeaf(input: ConfigAuthorizationInput): ConfigAuthorizationDecision {
  const { key, before, after } = input;
  const result = (allowed: boolean, guarded: boolean, reason: string): ConfigAuthorizationDecision => ({ key, allowed, guarded, reason });
  if (key === "action_policy" || key.startsWith("action_policy.")) {
    if (input.sourceFile !== "config.local.json") return result(false, true, "action policy requires .agenthub/config.local.json");
    if (input.tracked !== false) return result(false, true, "action policy requires an untracked machine-local source");
  }
  const remote = key === "checks.remote" || key.startsWith("checks.remote.") || key === "checks.runner" && after === "remote"
    || key === "checks" && !!after && typeof after === "object" && ((after as Record<string, unknown>).runner === "remote" || (after as Record<string, unknown>).remote !== undefined);
  if (remote && after !== undefined && (input.sourceFile !== "config.local.json" || input.tracked !== false)) return result(false, true, "remote checks require untracked config.local.json");
  if (same(before, after)) return result(true, false, "unchanged");
  const supplied = input.guard;
  const guard = supplied && (key === supplied.key || key === `${supplied.store === "routing" ? "routing." : ""}${supplied.path.join(".")}`) ? supplied : undefined;
  const machine = input.source === "config" && ALL_MACHINE_LOCAL.some(path => key === path || key.startsWith(`${path}.`));
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
  const subset = (smaller: unknown, larger: unknown) => strings(larger) && (smaller === undefined || strings(smaller) && smaller.every(item => larger.includes(item)));
  const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  let tightening = false;
  if (guard?.floor !== undefined && same(after, guard.floor)) tightening = true;
  if (key.startsWith("tasks.wip_limits.") && numeric(before) && numeric(after) && after <= before) tightening = true;
  if (key === "routing.constraints.pii" && before === "off" && after === "local_only") tightening = true;
  if (key === "routing.signals.pii_screen" && before === "off" && after === "local") tightening = true;
  if (key === "routing.signals.pii_patterns" && strings(after) && (before === undefined || strings(before) && before.every(pattern => after.includes(pattern)))) tightening = true;
  if (key.startsWith("roles.") && subset(after, before)) tightening = true;
  if (key.startsWith("capabilities.") && strings(after) && (before === undefined || subset(after, before))) tightening = true;
  if (["limits.sender_per_min", "limits.pair_per_min", "limits.important_per_hour"].includes(key)
    && numeric(before) && numeric(after) && after > 0 && (before === 0 || after <= before)) tightening = true;
  if (key === "limits.repeat_window_s" && numeric(before) && numeric(after) && after >= before) tightening = true;
  if (key === "conductor.feed") {
    const levels = ["off", "own", "all"];
    if (typeof before === "string" && typeof after === "string" && levels.includes(before) && levels.includes(after) && levels.indexOf(after) < levels.indexOf(before)) tightening = true;
  }
  if (["inference.enabled", "inference.triage", "review.adaptive"].includes(key) && before === true && after === false) tightening = true;
  if (key === "review.min_reviews" && numeric(before) && numeric(after) && after >= before) tightening = true;
  if (tightening && !input.settledHolderChange) return result(true, false, "semantic tightening");
  if (input.source === "config" && (key === "pet" || key.startsWith("pet."))) return result(true, false, "console-local presentation");
  if (guard?.risk === "safe" && !machine) return result(true, false, "safe registered setting");
  if (input.acceptedFallback && !machine) {
    const person = input.authority === "terminal" || input.authority === "settings" && !!guard;
    return result(person && input.confirmed === true, true, "restoring an unchanged effective startup value needs this key to be explicitly confirmed");
  }
  // Every other policy change is conservative: person intent never turns tracked or unknown code into host authority.
  if (input.tracked !== false) return result(false, true, input.tracked ? "guarded source is tracked; retain the running value" : "guarded source trust is unknown; retain the running value");
  if (input.authority === "ordinary") return result(false, true, "guarded change needs a selected setting or a confirmed terminal reload");
  // #689: a structural key (never an executable or secret one) written by the daemon's own validated edit, from a settings session.
  if (input.authority === "settings" && !guard && input.structural === true && input.confirmed === true && input.source === "config" && input.sourceFile === "config.local.json" && structuralLeaf(key)) return result(true, true, "confirmed structural edit");
  if (input.authority === "settings" && !guard) return result(false, true, "nonregistered policy requires a confirmed terminal reload");
  if (input.confirmed !== true) return result(false, true, "guarded change needs explicit confirmation for this key");
  return result(true, true, guard ? "confirmed registered setting" : "confirmed terminal reload");
}
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
const petFields: Record<string, Check> = {
  character: words(CHARACTER_IDS),
  size: words(["line", "mini", "full"]),
  glyphs: words(["auto", "ascii", "blocks"]),
  blink: bool,
  bell: bool,
  palette: (v, k) => { if (!petPalette(v)) fail(k, "unknown choice"); },
  window: bool,
};
export const validatePetConfig: Check = (v, k) => {
  if (v === false) return;
  block(petFields)(v, k);
};
shapes.set(validatePetConfig, { fields: petFields });
const nativeValidators = { bool, text, strings, argv, number, words, block };
const schema: Record<string, Check> = {
  ...Object.assign({}, ...ADAPTERS.map(adapter => adapter.configuration?.schema?.(nativeValidators) ?? {})),
  watchdog_ms: number(1, 2_147_483_647), kimi_cmd: argv, qwen_cmd: argv, jcode_cmd: argv, codex_bin: text, jcode_home: text, jcode_provider_profile: text,
  action_policy: block({ enabled: bool, always_ask: (v, k) => { actionPolicyConfig({ always_ask: v }); }, budgets: map(number(0, 1000, true), ACTION_CLASSES) }),
  permission_modes: v => { permissionDefaults(v); }, protect_instruction_files: bool,
  adapter_modules: v => { adapterModuleDeclarations(v); },
  adapters: v => { createProjectAdapterCatalog(v); }, instances: v => { validateInstances(v, createProjectAdapterCatalog()); }, pet: validatePetConfig,
  batch_max: number(1, 100_000, true), batch_ms: number(0, 2_147_483_647), queue_cap: number(1, 1_000_000, true),
  memory: block({ enabled: bool, worker_url: text, inject_tokens: number(0, 1_000_000, true), brief_items: number(0, 10_000, true), native: bool,
    short_ttl_days: number(1, 3650, true), sync_interval_min: number(0, 1440, true), suggest_edges: bool }),
  roster: peerMap(bool), roles: map(strings), planner: words(PLANNER_PEERS), profile: words(["dev", "research", "writing", "general"]),
  profile_overrides: (v, k) => { map(() => {})(v, k); const fields = object(v, k); for (const name of ["classes", "role_text", "catalog_roles"]) if (fields[name] !== undefined) map(() => {})(fields[name], `${k}.${name}`); resolveProfile("dev", v); },
  catalog_roles: (v, k) => { map(() => {})(v, k); catalogAssignments(v); },
  pii: block({ paths: strings }), data: block({ readonly: strings }),
  text_projection: v => { projectionConfig(v); },
  conductor: block({ feed: words(["own", "all", "off"]), approval_wait_s: number(0, 2_147_483_647 / 1000) }),
  budget: block({ gate: number(0, 1), stale_min: timerMinutes, poll_min: timerMinutes, checkpoint_timeout_s: timerSeconds, kimi_tokens_5h: number(0), wait_max_min: number(0) }),
  context: block({ gate: number(0, 1), stale_min: timerMinutes }),
  inference: block({ enabled: bool, digest_min_items: number(1, 100_000, true), digest_min_chars: number(1, 10_000_000, true), triage: bool }),
  omniroute: block({ urls: strings, api_key_file: text, access_hosts: strings, cf_client_id_file: text, cf_client_secret_file: text }),
  mlx: block({ enabled: bool, provider: words(["legacy", "ollama"]), host: text, runtimeDir: text, modelPath: text, bin: text, port: number(1, 65535, true), model: text, sourceModel: text,
    contextWindow: number(1), maxInputTokens: number(1), maxTokens: number(1), maxConcurrency: number(1, 1024, true) }),
  approvals: block({ timeout_s: timerSeconds, notify: bool }), tasks: block({ release_after_min: number(0), wip_limits: map(number(0, 32, true)), escalate_after: number(1, 10, true) }),
  task_sweep: (v, k) => { block({ enabled: bool, auto_reassign: bool, no_writes_turns: number(0, Number.MAX_SAFE_INTEGER, true), interval_s: timerSeconds, unaccepted_min: timerMinutes, idle_min: timerMinutes, review_min: timerMinutes, ready_min: timerMinutes, ladder_min: timerMinutes })(v, k); taskSweepConfig(v); },
  checks: (v, k) => { for (const [key, value] of Object.entries(object(v, k))) {
    if (value === undefined) continue;
    if (key === "timeout_s") timerSeconds(value, `${k}.${key}`);
    else if (key === "runner") words(["container", "remote"])(value, `${k}.${key}`);
    else if (key === "remote") remoteRunnerConfig(value);
    else if (/^[a-z][a-z0-9_]{0,47}$/.test(key)) text(value, `${k}.${key}`); else fail(`${k}.${key}`, "unknown key");
  } },
  snapshots: block({ enabled: bool, keep: number(1, 1_000_000, true) }), research: block({ enabled: bool }), bench: block({ enabled: bool }),
  peers: (v, k) => { map(block({ start_mode: words(["tui", "headless"]) }), START_MODE_PEERS)(v, k); peerStartConfig(v); },
  terminal: (v, k) => { block({ open: strings })(v, k); terminalTemplate(object(v, k).open); },
  limits: block({ sender_per_min: number(0), pair_per_min: number(0), important_per_hour: number(0), repeat_window_s: number(0) }),
  review: block({ adaptive: bool, min_reviews: number(1, Number.MAX_SAFE_INTEGER, true), pool: v => { reviewerPoolConfig({ pool: v }, DEFAULT_REVIEW_POOL, REVIEW_POOL_KINDS); }, rerotate: bool }), recovery: block({ auto_resume_after_crash: bool }),
  capabilities: map(strings), coordination: words(["advisory", "turn-free"]), experiments: block({ stale_notices: words(["drop", "deliver"]) }),
};
export const SCHEMA_KEYS: readonly string[] = Object.freeze(Object.keys(schema));
export function validateRawConfig(raw: unknown, declarations?: InstancesConfig, context?: ProjectAdapterCatalog, inertModuleRoster = false): asserts raw is Record<string, unknown> {
  const value = object(raw, "config");
  const catalog = value.adapters !== undefined ? createProjectAdapterCatalog(value.adapters, context?.externalDefinitions) : context ?? createProjectAdapterCatalog();
  const instances = validateInstances(value.instances ?? declarations, catalog);
  block({ ...schema,
    instances: v => { validateInstances(v, catalog); },
    planner: v => {
      if (v === null) fail("config.planner", "takes a peer id or a nonempty list");
      const def = settingDef("planner", instances, catalog);
      if (typeof def === "string") return fail("config.planner", def);
      checkSettingValue(def, v);
    },
    permission_modes: v => { permissionDefaults(v, instances, catalog); },
    roster: v => { peerRosterConfig(v, instances, catalog, inertModuleRoster); },
    peers: v => { peerStartConfig(v, instances, catalog); },
  })(raw, "config");
}
export function validateEffectiveConfig(value: unknown, catalog?: ProjectAdapterCatalog): asserts value is HubConfig {
  const raw = { ...object(value, "config") };
  delete raw.ignored; delete raw.retired; delete raw.permission_default_sources;
  validateRawConfig(raw, undefined, catalog);
  const profile = resolveProfile(raw.profile, raw.profile_overrides);
  for (const key of Object.keys(object(raw.checks, "checks"))) if (!["timeout_s", "runner", "remote", ...CLASSES, ...Object.keys(profile.classes)].includes(key)) fail(`checks.${key}`, "unknown task class");
  for (const adapter of ADAPTERS) adapter.configuration?.validateEffective?.(raw, fail);
}

const restart: Record<string, string> = {
  adapter_modules: "External adapter modules are verified and imported only at daemon startup",
  adapters: "Configured adapter identity, commands and capability policy are fixed at daemon startup",
  instances: "Native instance identity, worktree, ports and account bindings are fixed at daemon startup",
  ...Object.assign({}, ...ADAPTERS.map(adapter => adapter.configuration?.restartReasons ?? {})),
  memory: "Open memory consumers, selected profile, client and sync timer must be quiesced together",
  omniroute: "Credentials and gateway clients are bound to relay ownership", mlx: "Model runtime ownership and device resources belong to this daemon",
  checks: "Bounded runner and completion-check contracts are constructed together",
  pii: "Existing native sessions retain their startup privacy boundary", data: "Existing native sessions retain their startup read-only policy",
  profile: "Session tool schemas and profile contracts are bound at startup", profile_overrides: "Session tool schemas and profile contracts are bound at startup",
  text_projection: "Converter and cache ownership are bound at startup", terminal: "Terminal provider is supplied by the daemon lifecycle", bench: "Benchmark execution environment is selected before work starts",
};
const live = new Set(["action_policy", "permission", "roster", "roles", "planner", "conductor", "protect_instruction_files", "task_sweep", "capabilities", "research", "snapshots", "tasks.wip_limits", "tasks.escalate_after", "approvals.notify", "pet"]);
const nextMemory = new Set(["memory.inject_tokens", "memory.brief_items", "memory.suggest_edges"]);
/** Closed top-level schema; leaf overrides retain the existing session/runtime boundaries. */
export function configApply(key: string, scopes: readonly ConfigIdentityScope[] = []): ApplyRule {
  const top = key.split(".")[0]!;
  if (!(Object.hasOwn(schema, top) || top === "permission" || top === "routing")) return fail(key, "unknown configuration key");
  if (top !== "routing" && top !== "permission" && key.includes(".")) {
    const special: Record<string, readonly string[]> = {
      task_sweep: ["enabled", "auto_reassign", "no_writes_turns", "interval_s", "unaccepted_min", "idle_min", "review_min", "ready_min", "ladder_min"],
      checks: ["timeout_s", "runner", "remote", ...CLASSES], terminal: ["open"],
    };
    let check = schema[top];
    for (const [index, part] of key.split(".").slice(1).entries()) {
      const shape = check && shapes.get(check);
      if (shape?.fields) { if (!Object.hasOwn(shape.fields, part)) return fail(key, "unknown configuration key"); check = shape.fields[part]; }
      else if (shape?.item) { if (shape.keys && !shape.keys.includes(part) && !(top === "roster" && scopes.some(scope => scope.catalog.definitionOf(part, scope.instances)))) return fail(key, "unknown configuration key"); check = shape.item; }
      else if (index === 0 && (special[top]?.includes(part) || top === "checks" && /^[a-z][a-z0-9_]{0,47}$/.test(part))) break;
      else if (["permission_modes", "catalog_roles", "profile_overrides", "text_projection", "peers", "instances", "adapters", "adapter_modules"].includes(top)) break;
      else return fail(key, "unknown configuration key");
    }
  }
  if (top === "routing" && !ADAPTERS.some(adapter => Object.keys(adapter.configuration?.restartReasons ?? {}).some(prefix => prefix.startsWith("routing.") && key.startsWith(prefix))) && key !== "routing") {
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
export function configChanges(running: HubConfig, next: HubConfig, scopes: readonly ConfigIdentityScope[]): ConfigChange[] {
  const changes: ConfigChange[] = [];
  // Scopes are captured/validated by the host. Their union classifies removed/added keys only; it cannot
  // authorize a declaration or turn a restart-retained hybrid into a fresh startup configuration.
  const walk = (before: unknown, after: unknown, key: string) => {
    if (same(before, after)) return;
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const child of new Set([...Object.keys(before), ...Object.keys(after)])) walk(at(before, [child]), at(after, [child]), key ? `${key}.${child}` : child);
    } else {
      // #225: deleting a roster key whose instance was undeclared is live and needs no identity; adding or setting one stays an unknown key.
      const stale = after === undefined && /^roster\.[^.]+$/.test(key) && scopes.some(scope => staleInstanceKey(key.slice("roster.".length), scope.catalog));
      changes.push({ key, before, after, ...(stale ? { applies: "live" as const } : configApply(key, scopes)) });
    }
  };
  const clean = (v: HubConfig) => Object.fromEntries(Object.entries(v).filter(([key]) => !["ignored", "retired", "permission_default_sources"].includes(key)));
  walk(clean(running), clean(next), ""); return changes.sort((a, b) => a.key.localeCompare(b.key));
}

/** Legacy all-or-nothing authority helper; daemon reload uses authorizeConfigLeaf for scoped publication. */
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
