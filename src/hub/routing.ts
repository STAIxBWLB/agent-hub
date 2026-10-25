import { selectReviewerPool, type ReviewerPoolSelection } from "./reviewer-pool.ts";
import { ADAPTERS, definitionOf, kindOf, familyOf, type ProjectAdapterCatalog } from "../adapters/registry.ts";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLASSES, type Task, type TaskClass } from "./board.ts";
import { isGitHubRepository, specRefs } from "./spec-read.ts";

export interface PeerCapabilities { tests: boolean; spec: boolean; testsReason?: string; specReason?: string; }
import type { PeerId, PeerState } from "./envelope.ts";

import { parseHubRoutes, type HubRoute } from "../models/route/config.ts";
import { DEFAULT_STAY_SWITCH, type StaySwitchMode } from "../models/route/stage.ts";

export interface ClassPolicy {
  /** preference order among attached, unpaused peers */
  peers: PeerId[];
  /** In-process hub route, or a retired non-hub selection that uses fixed_model. */
  route?: string;
  fixed_model?: string;
  /** on `tasks.escalate_after` consecutive changes_requested (default 3) */
  escalate_to?: PeerId[];
  /** false: `local` is never owner or reviewer for this class */
  local_allowed?: boolean;
  /** Pi backend for Pi-owned work. */
  pi_backend?: "dgx" | "mlx";
}

export interface Routing {
  local: { route?: string; fixed_model: string };
  /** Loader-owned diagnostics for ignored legacy routing tables. */
  retired?: string[];
  hub_routes?: Record<string, HubRoute>;
  /** Session-aware stay/switch for `hub/auto` and hub stage routes (#197). */
  stay_switch: StaySwitchMode;
  max_switch_prefill_tokens: number;
  classes: Partial<Record<TaskClass, ClassPolicy>>;
  /** `pii_screen` (issue #198): `local` adds the on-device or on-campus model screen to the patterns. */
  signals: { pii_patterns: string[]; long_context_tokens: number; pii_screen: "off" | "local" };
  constraints: { pii: "local_only" | "off"; long_context: "skip_local" | "off"; budget_paused: "skip_peer" | "off" };
  /** `efficient_wait_ms`, opt-in (#199): how long a hub/auto request waits for a busy MLX slot before it moves to dgx/fast; absent, nothing moves for load. */
  pi: { dgx_max_context_tokens: number; mlx_max_context_tokens: number; efficient_wait_ms?: number };
  /** The keys `.agenthub/routing.local.toml` set (#269), such as `classes.implement.peers`; every other value is routing.toml's. */
  sources?: Record<string, "routing.local.toml">;
}

/** A class fixed_model without its own route explicitly selects the gateway alias directly. */
export function effectiveLocalRoute(defaultRoute: string | undefined, classRoute?: string, classFixedModel?: string): string | undefined {
  return classRoute ?? (classFixedModel === undefined ? defaultRoute : undefined);
}

/**
 * What `.agenthub/routing.local.toml` may hold (#269): a person's machine-local override of these keys and nothing
 * else, so a settings write can never reach hub routes, signals or the PII constraint.
 */
export interface RoutingOverlay {
  stay_switch?: StaySwitchMode;
  classes?: Partial<Record<TaskClass, { peers?: PeerId[]; escalate_to?: PeerId[]; route?: string; pi_backend?: "dgx" | "mlx" }>>;
}
export const OVERLAY_FILE = "routing.local.toml";
const OVERLAY_PEER = /^[a-z][a-z0-9-]{0,31}$/;
const OVERLAY_ROUTE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,63}$/;
const OVERLAY_PEERS_MAX = 8;

/** A checked copy of an overlay, in a fixed key order; throws on anything outside the keys above. */
export function checkOverlay(raw: unknown): RoutingOverlay {
  const bad = (what: string): never => { throw new Error(`${OVERLAY_FILE}: ${what}`); };
  const table = (value: unknown, where: string): Record<string, unknown> => (!value || typeof value !== "object" || Array.isArray(value) ? bad(`${where} must be a table`) : value as Record<string, unknown>);
  const peers = (value: unknown, where: string): PeerId[] => {
    if (!Array.isArray(value) || value.length > OVERLAY_PEERS_MAX || value.some((p) => typeof p !== "string" || !OVERLAY_PEER.test(p)) || new Set(value).size !== value.length) bad(`${where} must list up to ${OVERLAY_PEERS_MAX} distinct peer ids`);
    return [...(value as PeerId[])];
  };
  const top = table(raw, "the file");
  const out: RoutingOverlay = {};
  for (const [key, value] of Object.entries(top)) {
    if (key === "stay_switch") {
      if (value !== "off" && value !== "shadow" && value !== "enforce") bad('stay_switch must be "off", "shadow" or "enforce"');
      out.stay_switch = value as StaySwitchMode;
    } else if (key === "classes") {
      for (const [name, policy] of Object.entries(table(value, "classes"))) {
        if (!(CLASSES as readonly string[]).includes(name)) bad(`[classes.${name}] is not a task class`);
        const entry: NonNullable<RoutingOverlay["classes"]>[TaskClass] = {};
        for (const [field, v] of Object.entries(table(policy, `[classes.${name}]`))) {
          if (field === "peers" || field === "escalate_to") entry[field] = peers(v, `[classes.${name}] ${field}`);
          else if (field === "route") entry.route = typeof v === "string" && OVERLAY_ROUTE.test(v) ? v : bad(`[classes.${name}] route must be a route id`);
          else if (field === "pi_backend") entry.pi_backend = v === "dgx" || v === "mlx" ? v : bad(`[classes.${name}] pi_backend must be "dgx" or "mlx"`);
          else bad(`[classes.${name}] ${field} is not a setting this file holds; edit routing.toml`);
        }
        if (Object.keys(entry).length) (out.classes ??= {})[name as TaskClass] = entry;
      }
    } else bad(`${key} is not a setting this file holds; edit routing.toml`);
  }
  return out;
}
export const parseOverlay = (text: string): RoutingOverlay => checkOverlay(Bun.TOML.parse(text));

/** The overlay as TOML. Every value is a checked id or a closed word, so a JSON string is a valid TOML basic string. */
export function overlayToml(overlay: RoutingOverlay): string {
  const checked = checkOverlay(overlay);
  const lines = ["# Written by ahub settings and the dashboard (machine-local). It overrides routing.toml key by key."];
  if (checked.stay_switch) lines.push(`stay_switch = ${JSON.stringify(checked.stay_switch)}`);
  for (const name of CLASSES) {
    const entry = checked.classes?.[name];
    if (!entry) continue;
    lines.push("", `[classes.${name}]`);
    for (const field of ["peers", "escalate_to"] as const) if (entry[field]) lines.push(`${field} = [${entry[field]!.map((p) => JSON.stringify(p)).join(", ")}]`);
    if (entry.route) lines.push(`route = ${JSON.stringify(entry.route)}`);
    if (entry.pi_backend) lines.push(`pi_backend = ${JSON.stringify(entry.pi_backend)}`);
  }
  return `${lines.join("\n")}\n`;
}

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "routing.toml");
export const LOCAL: PeerId = "local";
export const PI: PeerId = "pi";

/** Startup-bound project data, never inferred from a suffix or read from configuration here. */
export interface InstanceRoutingOptions {
  adapterCatalog?: ProjectAdapterCatalog;
  instances?: Readonly<Record<string, { kind: string }>>;
  wip?: Record<string, number>;
  load?: Record<string, number>;
  /** Positive host verification of the live extra runtime's noncanonical execution root. */
  ownerIsolation?: Readonly<Record<string, boolean>>;
}
const hasInstances = (opts: InstanceRoutingOptions): boolean => !!opts.instances && Object.keys(opts.instances).length > 0;
function siblingOrder(states: Readonly<Record<string, PeerState>>, opts: InstanceRoutingOptions): (a: string, b: string) => number {
  const count = (map: Record<string, number> | undefined, id: string) => {
    const value = peerEntry(map, id);
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return (a, b) => Number(states[a] !== "idle") - Number(states[b] !== "idle") || count(opts.wip, a) - count(opts.wip, b) || count(opts.load, a) - count(opts.load, b);
}
/** A class kind expands once; an explicitly declared instance remains an exact id. */
function expandClassPeers(peers: readonly PeerId[], states: Readonly<Record<string, PeerState>>, opts: InstanceRoutingOptions): PeerId[] {
  if (!hasInstances(opts)) return [...peers];
  return [...new Set(peers.flatMap(peer => {
    const kind = (opts.adapterCatalog?.kindOf ?? kindOf)(peer, opts.instances);
    return kind && kind === peer ? [peer, ...Object.keys(opts.instances!).filter(id => (opts.adapterCatalog?.kindOf ?? kindOf)(id, opts.instances) === kind)].sort(siblingOrder(states, opts)) : [peer];
  }))];
}
/** Quota/adaptive policy retains kind slots; sibling workload chooses only within that kind's slots. */
function orderSiblingSlots(peers: PeerId[], states: Readonly<Record<string, PeerState>>, opts: InstanceRoutingOptions): PeerId[] {
  if (!hasInstances(opts)) return peers;
  const groups = new Map<string, number[]>(), out = [...peers];
  for (const [index, peer] of peers.entries()) {
    const kind = (opts.adapterCatalog?.kindOf ?? kindOf)(peer, opts.instances);
    if (kind) { const slots = groups.get(kind) ?? []; slots.push(index); groups.set(kind, slots); }
  }
  for (const slots of groups.values()) {
    const sorted = slots.map(index => peers[index]!).sort(siblingOrder(states, opts));
    slots.forEach((index, position) => { out[index] = sorted[position]!; });
  }
  return out;
}

/** The quota/roster relay keeps its native preference order, then the class's original tail. */
export function relayCandidates(classPeers: readonly PeerId[], pii: boolean, opts: InstanceRoutingOptions & { states?: Readonly<Record<string, PeerState>> } = {}): PeerId[] {
  const preferred = (opts.adapterCatalog?.definitions ?? ADAPTERS).filter(adapter => adapter.routing?.handoffPriority !== undefined)
    .sort((a, b) => a.routing!.handoffPriority! - b.routing!.handoffPriority!);
  const candidates = [
    ...preferred.filter(adapter => !pii || adapter.trust.onPrem).map(adapter => adapter.kind),
    ...classPeers.filter(peer => (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.routing?.handoffPriority === undefined),
  ].filter((peer): peer is PeerId => !!peer);
  return expandClassPeers(candidates, opts.states ?? {}, opts);
}

/**
 * `.agenthub/routing.toml`, or the shipped default when the project has none, with `.agenthub/routing.local.toml`
 * merged over it key by key (#269). Throws on a file that does not parse or lacks a fixed model.
 */
export function loadRouting(cwd: string): Routing {
  const text = routingText(cwd);
  let overlay: string | undefined;
  try {
    overlay = readFileSync(join(cwd, ".agenthub", OVERLAY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return parseRouting(text, overlay === undefined ? undefined : parseOverlay(overlay));
}

/** The project's routing.toml as text, or the shipped default when it has none. */
export function routingText(cwd: string): string {
  try {
    return readFileSync(join(cwd, ".agenthub", "routing.toml"), "utf8");
  } catch {
    return readFileSync(TEMPLATE, "utf8");
  }
}

/** The policy of a routing.toml text with an overlay merged over it: what `loadRouting` reads, without the disk. */
export function parseRouting(text: string, overlay?: RoutingOverlay): Routing {
  const raw = Bun.TOML.parse(text) as Partial<Routing> & { targets?: unknown; routes?: unknown };
  const retired: string[] = [];
  if (Object.hasOwn(raw, "targets")) retired.push('[targets] is retired and ignored: name gateway aliases directly in hub_routes efficient/capable/judge or fixed_model');
  if (Object.hasOwn(raw, "routes")) retired.push('[routes] is retired and ignored: replace stage_router with hub_routes type="stage" (efficient_target -> efficient, capable_target -> capable, same confidence_threshold), passthrough with fixed_model and no route, and llm_classifier escalation with hub_routes type="escalation"');
  delete raw.targets;
  delete raw.routes;
  const sources: NonNullable<Routing["sources"]> = {};
  if (overlay) {
    const checked = checkOverlay(overlay);
    if (checked.stay_switch) { (raw as Record<string, unknown>).stay_switch = checked.stay_switch; sources.stay_switch = OVERLAY_FILE; }
    const known = new Set(Object.keys(raw.hub_routes ?? {}));
    for (const [name, entry] of Object.entries(checked.classes ?? {})) {
      if (entry.route && entry.route.startsWith("hub/") && !known.has(entry.route)) throw new Error(`${OVERLAY_FILE}: [classes.${name}] route ${entry.route} names no route in routing.toml`);
      const classes = (raw.classes ??= {}) as Record<string, ClassPolicy>;
      // A class the shared file does not have starts from an empty peer list: the overlay may add its own.
      classes[name] = { ...(classes[name] ?? { peers: [] }), ...entry };
      for (const field of Object.keys(entry)) sources[`classes.${name}.${field}`] = OVERLAY_FILE;
    }
  }
  if (!raw.local?.fixed_model) throw new Error("routing.toml: [local] fixed_model is required (the direct gateway fallback)");
  const signals = { pii_patterns: [], long_context_tokens: 120_000, pii_screen: "off" as const, ...raw.signals };
  for (const p of signals.pii_patterns) new RegExp(p); // a bad pattern fails here, at load, not in the middle of an assignment
  if (signals.pii_screen !== "off" && signals.pii_screen !== "local") throw new Error('routing.toml: [signals] pii_screen must be "off" or "local"');
  const classes = raw.classes ?? {};
  if ([raw.local.route, ...Object.values(classes).map(policy => policy?.route)].some(route => route && !route.startsWith("hub/"))) {
    retired.push('non-hub route selections are retired and ignored; using fixed_model (replace the selection with a hub/ route to enable in-process routing)');
  }
  for (const [name, policy] of Object.entries(classes)) {
    if (policy?.pi_backend !== undefined && policy.pi_backend !== "dgx" && policy.pi_backend !== "mlx") throw new Error(`routing.toml: [classes.${name}] pi_backend must be "dgx" or "mlx"`);
  }
  const pi = { dgx_max_context_tokens: 262_144, mlx_max_context_tokens: 16_000, ...(raw as any).pi };
  if (!(Number.isSafeInteger(pi.dgx_max_context_tokens) && pi.dgx_max_context_tokens > 0) || !(Number.isSafeInteger(pi.mlx_max_context_tokens) && pi.mlx_max_context_tokens > 0)) throw new Error("routing.toml: [pi] context limits must be positive integers");
  // A dispatch gives up on a busy MLX slot after 120 s; a longer load wait would never move anything.
  if (pi.efficient_wait_ms !== undefined && !(Number.isSafeInteger(pi.efficient_wait_ms) && pi.efficient_wait_ms >= 0 && pi.efficient_wait_ms < 120_000)) throw new Error("routing.toml: [pi] efficient_wait_ms must be an integer from 0 to 119999");
  const { stay_switch, max_switch_prefill_tokens } = { ...DEFAULT_STAY_SWITCH, ...(raw as any) };
  // Written after a table header, a top-level key lands in that table and would be ignored without a word.
  const misplaced = (table: unknown, path: string): string | undefined => !table || typeof table !== "object" || Array.isArray(table) ? undefined
    : Object.entries(table).map(([key, value]) => Object.hasOwn(DEFAULT_STAY_SWITCH, key) ? `${path}${key}` : misplaced(value, `${path}${key}.`)).find(Boolean);
  const nested = Object.entries(raw).map(([key, value]) => misplaced(value, `${key}.`)).find(Boolean);
  if (nested) throw new Error(`routing.toml: ${nested} is inside a table; stay_switch and max_switch_prefill_tokens are top-level keys, before any table`);
  if (!["off", "shadow", "enforce"].includes(stay_switch)) throw new Error('routing.toml: stay_switch must be "off", "shadow" or "enforce" (a top-level key, before any table)');
  if (!(Number.isSafeInteger(max_switch_prefill_tokens) && max_switch_prefill_tokens > 0)) throw new Error("routing.toml: max_switch_prefill_tokens must be a positive integer");
  return {
    local: raw.local,
    ...(retired.length ? { retired } : {}),
    hub_routes: parseHubRoutes(raw.hub_routes),
    stay_switch,
    max_switch_prefill_tokens,
    classes,
    signals,
    constraints: { pii: "local_only", long_context: "skip_local", budget_paused: "skip_peer", ...raw.constraints },
    pi,
    ...(Object.keys(sources).length ? { sources } : {}),
  };
}

const cache = new Map<string, { mtime: string; routing: Routing }>();

/**
 * loadRouting behind an mtime check. routing.toml is edited while the hub runs and read on every task operation;
 * a half-saved file must not abort an operation midway, so the last good parse stays in force until the file parses again.
 */
export function currentRouting(cwd: string, log: (line: string) => void = () => {}): Routing {
  // Both files count: a settings write changes only the overlay.
  const mtime = ["routing.toml", OVERLAY_FILE].map((name) => {
    try {
      const stat = statSync(join(cwd, ".agenthub", name));
      return `${stat.mtimeMs}/${stat.size}`;
    } catch {
      return 0; // no project file: the shipped template, or no overlay
    }
  }).join(":");
  const hit = cache.get(cwd);
  if (hit && hit.mtime === mtime) return hit.routing;
  try {
    const routing = loadRouting(cwd);
    cache.set(cwd, { mtime, routing });
    return routing;
  } catch (e) {
    if (!hit) throw e;
    log(`routing does not load, keeping the previous policy: ${(e as Error).message}`);
    cache.set(cwd, { mtime, routing: hit.routing });
    return hit.routing;
  }
}

export type Signal = "pii" | "pii_path" | "long_context" | "urgent";

/** What the policy can see in a task. Context length is estimated from the referenced files, 3 characters per token as elsewhere. */
export function detectSignals(task: Pick<Task, "title" | "detail" | "refs">, routing: Routing, cwd: string): Signal[] {
  const out: Signal[] = [];
  const text = `${task.title}\n${task.detail}`;
  if (routing.signals.pii_patterns.some((p) => new RegExp(p).test(text))) out.push("pii");
  const bytes = (task.refs.paths ?? []).reduce((n, p) => {
    try {
      return n + statSync(resolve(cwd, p)).size;
    } catch {
      return n;
    }
  }, 0);
  if (bytes / 3 > routing.signals.long_context_tokens) out.push("long_context");
  return out;
}

/** A peer's entry in a peer-indexed map: own keys only, so a peer named `constructor` is never an inherited Object member. */
export const peerEntry = <T>(map: Readonly<Record<string, T>> | undefined, peer: string): T | undefined => (map && Object.hasOwn(map, peer) ? map[peer] : undefined);

export type RoutingRefusalCode = "instance" | "family" | "tests" | "spec" | "roster" | "pull-only" | "not-attached" | "excluded" | "owner-admission" | "offline" | "paused" | "failing" | "pii" | "policy";
export interface RoutingRefusal { peer: PeerId; role: "owner" | "reviewer"; code: RoutingRefusalCode; reason: string }
export interface Assignment {
  reviewSelection?: ReviewerPoolSelection;
  reviewBlocked?: true;
  /** A same-family reviewer was chosen only because no other family was eligible. */
  sameFamilyFallback?: true;
  /** #223 R5: the planner reviews because the declared reviewer-only instance was not eligible. */
  plannerFallback?: true;
  refusals?: RoutingRefusal[];
  owner?: PeerId;
  reviewer?: PeerId;
  /** #525-3: the task's planner, from the planner walk. Read-only information until 525-2 records it; absent for a PII task or when nobody holds the role. */
  planner?: PeerId;
  plannerReason?: PlannerReason;
  /** What local should ask for on this task: a hub route or retired non-hub selection, with its fixed fallback. */
  route?: string;
  fixedModel?: string;
  piBackend?: "dgx" | "mlx";
  /** Why the task's reserved owner (issue #207) was passed over; absent when it was honored or there is none. */
  unreserved?: string;
  trace: string[];
}

/**
 * The role a class's owner works in (#735): `plan` is the planner's, `review` the reviewer's, and every other class (implement, bulk_edit,
 * test, summarize, triage, and a profile class that maps onto one) is done by an implementer, which needs write access. Derived, never a
 * list of the write classes, so a class added later is a write class unless it says otherwise here.
 */
export function ownerRoleOfClass(cls: TaskClass): "planner" | "implementer" | "reviewer" {
  return cls === "review" ? "reviewer" : cls === "plan" ? "planner" : "implementer";
}

/** Why a planner was chosen: the person named it, rotation reached it, the task's recorded planner is kept, or there is none (PII, no holder). */
export type PlannerReason = "rotation" | "named" | "kept" | "none";

/**
 * I-2 (#525-3): the peers that implemented a task, read from its own history: any peer with an `accepted` or `done` entry. A reviewer is
 * never one of them, so a multi-role holder (implementer and reviewer) never reviews a change it made, even after the task changed hands.
 * Pure: history in, set out. A `done` by the person is not a peer's implementation and is left out.
 */
export function implementers(history: readonly { by: PeerId; event: string }[] | undefined): Set<PeerId> {
  return new Set((history ?? []).filter(entry => (entry.event === "accepted" || entry.event === "done") && entry.by !== "user").map(entry => entry.by));
}

export interface PlannerWalkInput {
  /** The settled planner holders, sorted by id. The walk sorts again, so an unsorted input cannot change the result. */
  planners: readonly PeerId[];
  /** The rotation seed: the task id. */
  seed: number;
  /** A person-named planner: exact, never replaced by rotation. */
  named?: PeerId;
  /** The planner already recorded on the task: kept while it is still a holder. */
  kept?: PeerId;
  /** Why a holder cannot take planning right now; undefined when it can. */
  blocked(peer: PeerId): string | undefined;
  /** A PII task has no planner: its planning stays with the person. */
  pii: boolean;
}
export interface PlannerWalk { planner?: PeerId; reason: PlannerReason; walk: { peer: PeerId; note: string }[]; line: string }

/**
 * The planner walk (#525 R3, "Choice"): pure, so assignment and `ahub route explain` print the same lines.
 * - a PII task has no planner;
 * - a named planner is exact: a name that is not a holder or cannot plan is refused in the trace, never replaced by rotation;
 * - otherwise the recorded planner is kept while it is still a holder;
 * - otherwise rotation: holders sorted by id, starting at `seed mod n`, walking forward past unavailable holders. The denominator is every
 *   holder, availability never renumbers it (the #519 seed rule). When all are skipped, the seed holder is taken, "rotation (none available)".
 */
export function plannerWalk(input: PlannerWalkInput): PlannerWalk {
  const holders = [...new Set(input.planners)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const walk: { peer: PeerId; note: string }[] = [];
  const finish = (reason: PlannerReason, planner: PeerId | undefined, detail: string): PlannerWalk => ({ ...(planner ? { planner } : {}), reason, walk, line: planner ? `planner: ${planner} (${detail})` : `planner: none (${detail})` });
  if (input.pii) return finish("none", undefined, "pii: planning stays with the person");
  if (!holders.length) return finish("none", undefined, "no planner holder");
  if (input.named !== undefined) {
    if (!holders.includes(input.named)) { walk.push({ peer: input.named, note: "skipped, not a planner holder" }); return finish("none", undefined, `named ${input.named} is not a planner holder`); }
    const why = input.blocked(input.named);
    walk.push({ peer: input.named, note: why ? `named, ${why}` : "named" });
    return finish("named", input.named, why ? `named; ${why}` : "named");
  }
  if (input.kept !== undefined && holders.includes(input.kept)) {
    walk.push({ peer: input.kept, note: "kept: already the task's planner" });
    return finish("kept", input.kept, "kept");
  }
  const seed = Number.isSafeInteger(input.seed) ? input.seed : 0;
  const start = ((seed % holders.length) + holders.length) % holders.length;
  for (let step = 0; step < holders.length; step++) {
    const peer = holders[(start + step) % holders.length]!;
    const why = input.blocked(peer);
    walk.push({ peer, note: why ? `skipped, ${why}` : "available" });
    if (!why) return finish("rotation", peer, step === 0 ? "rotation" : "rotation, skipped unavailable holders");
  }
  const seeded = holders[start]!;
  return finish("rotation", seeded, "rotation (none available)");
}

/**
 * L1. A pure function of policy, task and peer states, so `ahub route explain` runs exactly what assignment runs and
 * prints its trace. `states`: effective bus states of attached peers (a peer that is not in the map is not attached).
 */
export function assign(
  task: Pick<Task, "class" | "signals" | "reserved"> & Partial<Pick<Task, "state" | "title" | "detail" | "refs" | "external" | "id" | "sdlc" | "history">>,
  states: Record<PeerId, PeerState>,
  routing: Routing,
  opts: InstanceRoutingOptions & {
    capabilities?: Record<PeerId, PeerCapabilities>;
    repository?: string;
    exclude?: PeerId[];
    /** Owner admission limits do not remove otherwise eligible reviewers. */
    excludeOwners?: PeerId[];
    /** Live membership supplied as data; routing never reads the roster store. */
    offRoster?: PeerId[];
    /** Watched peers take work only on an explicit nomination, never a routing singleton. */
    pullOnly?: PeerId[];
    namedOwner?: PeerId;
    namedReviewer?: PeerId;
    /** #525-3: the settled planner holders (sorted ids) and a person-named planner. Absent `planners`: no planner walk, as before. */
    planners?: readonly PeerId[];
    namedPlanner?: PeerId;
    /** The planner already recorded on the task (525-2): kept while it is still a holder. */
    keptPlanner?: PeerId;
    reviewPool?: { pool: readonly string[]; rerotate?: boolean; failed?: readonly string[]; required?: boolean; sameFamily?: "fallback" | "never" };
    candidates?: PeerId[];
    notReviewer?: PeerId;
    waitsFor?: number[];
    /** Quota per peer from its fresh readings, and the clock they are read against (issue #36). */
    quota?: Record<PeerId, { headroom: number; resetsAt?: number }>;
    now?: number;
    /** Peers demoted for this task's class, with their recent failure weight (issue #36). */
    demoted?: Record<PeerId, number>;
    /** Review record per implementer, then per reviewer, for this class (issue #35); followed only when `adaptive`. */
    reviews?: Record<PeerId, Record<PeerId, { score: number; n: number }>>;
    adaptive?: { min: number };
    /** Peers whose recent deliveries all failed, with the reason (issue #89): skipped until a delivery succeeds. */
    failing?: Record<PeerId, string>;
    /** Peers whose queue a needs_review delivery holds, with the hold detail (issue #90): eligible, but the hold is explained. */
    held?: Record<PeerId, string>;
    /** Roles from `.agenthub/config.json` (issue #92): peers with the reviewer role join the reviewer candidates after the review class's. */
    roles?: Record<string, string[]>;
  } = {},
): Assignment {
  if (task.state === "cancelled" || task.state === "approved") return { trace: [`${task.state}: closed; not routed`] };
  if (task.state === "backlog") return { trace: ["backlog: not routed; pull into To Do first"] };
  const instanceMode = hasInstances(opts);
  const policy = routing.classes[task.class];
  const trace: string[] = [`class ${task.class}${policy ? "" : " (no [classes] entry: only an explicit owner can take it)"}`, `signals: ${task.signals.join(", ") || "none"}`];
  // Which file each of this class's values comes from (#269), only when the machine-local overlay sets one.
  const local = Object.keys(routing.sources ?? {}).filter((key) => key.startsWith(`classes.${task.class}.`)).map((key) => key.slice(`classes.${task.class}.`.length));
  if (local.length) trace.push(`policy source: ${local.join(", ")} from ${OVERLAY_FILE}; the rest from routing.toml`);
  // A reserved owner (issue #207) is offered the task first. Named candidates (an assign, an escalation, a relay) replace it.
  const reserved = opts.candidates || instanceMode && opts.namedOwner !== undefined ? undefined : task.reserved ?? undefined;
  // Readiness is an input like peer states (issue #34): a task that waits for others goes to nobody yet.
  if (opts.waitsFor?.length) return { trace: [...trace, `blocked: waits for ${opts.waitsFor.map((id) => `#${id}`).join(", ")} (not approved)`, ...(reserved ? [`reserved owner ${reserved}: offered first once it is ready`] : [])] };
  const pii = task.signals.includes("pii_path") || (task.signals.includes("pii") && routing.constraints.pii === "local_only");

  let needsSpec = false;
  if (!pii) try { needsSpec = specRefs({ title: task.title ?? "", detail: task.detail ?? "", refs: task.refs ?? {}, external: task.external }, opts.repository ?? "", { bareTitle: isGitHubRepository(opts.repository) }).length > 0; }
  catch { needsSpec = true; } // an invalid/foreign reference never grants a sandboxed peer spec access
  const needsTests = ["implement", "test", "bulk_edit"].includes(task.class);
  // #735: the owner needs write access whenever its role for this class is the implementer's, not only for the three classes that need tests.
  const ownerWrites = ownerRoleOfClass(task.class) === "implementer";
  const refusals = new Map<string, RoutingRefusal>();
  const former = implementers(task.history);
  const blocked = (peer: PeerId, role: "owner" | "reviewer"): string | undefined => {
    const deny = (code: RoutingRefusalCode, reason: string): string => { refusals.set(`${role}:${peer}`, { peer, role, code, reason }); return reason; };
    const ceiling = (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.routing?.allowedRoles;
    const requiredRole = role === "reviewer" ? "reviewer" : ownerRoleOfClass(task.class);
    if (ceiling && !ceiling.includes(requiredRole)) return deny("policy", "adapter role ceiling excludes this assignment");
    const unavailable = role === "reviewer" ? (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.reviewer?.unavailable : undefined;
    if (unavailable) return deny("policy", unavailable);
    if (role === "owner" && opts.capabilities && !pii) {
      const caps = peerEntry(opts.capabilities, peer);
      if (needsTests && !caps?.tests) return deny("tests", `missing tests: ${caps?.testsReason ?? "capability unavailable"}`);
      if (needsSpec && !caps?.spec) return deny("spec", `missing spec: ${caps?.specReason ?? "capability unavailable"}`);
    }
    if (opts.offRoster?.includes(peer)) return deny("roster", "off roster");
    const named = role === "owner" ? opts.namedOwner ?? reserved : opts.namedReviewer;
    if (opts.pullOnly?.includes(peer) && named !== peer) return deny("pull-only", "pull-only: takes work when named or when it claims it");
    if (!Object.hasOwn(states, peer)) return deny("not-attached", "not attached");
    if (opts.exclude?.includes(peer)) return deny("excluded", "excluded (declined or replaced)");
    if (role === "owner" && opts.excludeOwners?.includes(peer)) return deny("owner-admission", "owner admission: WIP or delivery hold");
    const adapter = (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances);
    if (role === "owner" && adapter?.routing?.reviewOnly) return deny("owner-admission", "owner admission: a review-only instance owns no task");
    if (role === "owner" && ownerWrites && adapter && adapter.kind !== peer) {
      if (!peerEntry(opts.roles, peer)?.includes("implementer")) return deny("owner-admission", "owner admission: declared write owner requires the current implementer role");
      if (peerEntry(opts.ownerIsolation, peer) !== true) return deny("owner-admission", "owner admission: declared write owner requires a verified isolated execution root");
    }
    if (states[peer] === "offline") return deny("offline", "offline");
    if (states[peer] === "paused" && routing.constraints.budget_paused === "skip_peer") return deny("paused", "paused");
    const failing = peerEntry(opts.failing, peer);
    if (failing) return deny("failing", `failing: ${failing}`);
    if (pii && (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.trust.onPrem !== true) return deny("pii", "pii: on-prem peers only");
    const nativeRouting = (opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.routing;
    if (nativeRouting?.localAllowedRefusal && policy?.local_allowed === false) return deny("policy", nativeRouting.localAllowedRefusal);
    if (nativeRouting?.longContext === "backend-limit" && task.signals.includes("long_context")) {
      const backend = policy?.pi_backend ?? "dgx";
      const limit = backend === "mlx" ? routing.pi.mlx_max_context_tokens : routing.pi.dgx_max_context_tokens;
      if (routing.signals.long_context_tokens > limit) return deny("policy", `${nativeRouting.backendLabel} ${backend} capability limit ${limit} tokens`);
    }
    if (nativeRouting?.longContext === "skip-owner" && role === "owner" && task.signals.includes("long_context") && routing.constraints.long_context === "skip_local") return deny("policy", "long_context: skip local");
    // I-2 (#525-3): a peer that implemented this task never reviews it, whoever holds it now, a named reviewer included. It is the LAST check,
    // so it only ever removes a candidate that was otherwise eligible: a former implementer that is offline, paused, failing or off roster is
    // refused for that real reason and leaves the outcome exactly as it was before I-2 (a task with no other reviewer still approves directly).
    if (role === "reviewer" && former.has(peer)) return deny("policy", "implemented this task");
    return undefined;
  };
  /** Quota that resets soonest gets used first: headroom per hour left in the window, at least 15 min (a task assigned that close to a reset mostly runs after it). */
  const drain = (p: PeerId): number | undefined => {
    const q = peerEntry(opts.quota, p);
    return q?.resetsAt === undefined ? undefined : q.headroom / Math.max((q.resetsAt - (opts.now ?? 0)) / 3_600_000, 0.25);
  };
  /** Peers with readings swap places among themselves by drain rate; peers without (local, pi) keep theirs. */
  const byDrain = (list: PeerId[]): PeerId[] => {
    const slots = list.flatMap((p, i) => (drain(p) === undefined ? [] : [i]));
    if (slots.length < 2) return list;
    const sorted = slots.map((i) => list[i]!).sort((a, b) => drain(b)! - drain(a)!);
    const out = [...list];
    slots.forEach((i, k) => (out[i] = sorted[k]!));
    const left = (p: PeerId) => `${p} ${Math.round(opts.quota![p]!.headroom * 100)}% left, resets in ${Math.max(0, Math.round((opts.quota![p]!.resetsAt! - (opts.now ?? 0)) / 60_000))} min`;
    if (sorted.join() !== slots.map((i) => list[i]).join()) trace.push(`  quota first: ${sorted.map(left).join("; ")}`);
    return out;
  };
  /** Demoted peers go behind the rest for this class (owners only); each group is then ordered by quota. */
  /** Reviewers with enough recorded reviews of this owner's work swap places by how those reviews held up. */
  const byRecord = (list: PeerId[], owner: PeerId | undefined): PeerId[] => {
    const record = owner ? peerEntry(opts.reviews, owner) : undefined;
    if (!record || !Object.keys(record).length) return list;
    trace.push(`  review record with ${owner} in ${task.class}: ${Object.entries(record).map(([r, s]) => `${r} ${s.n} reviews, ${Math.round(s.score * 100)}% held`).join("; ")}${opts.adaptive ? "" : " (review.adaptive is off)"}`);
    if (!opts.adaptive) return list;
    const known = (p: PeerId) => { const r = peerEntry(record, p); return r && r.n >= opts.adaptive!.min ? r.score : undefined; };
    const slots = list.flatMap((p, i) => (known(p) === undefined ? [] : [i]));
    const sorted = slots.map((i) => list[i]!).sort((a, b) => known(b)! - known(a)!);
    const out = [...list];
    slots.forEach((i, k) => (out[i] = sorted[k]!));
    return out;
  };
  const rank = (ok: PeerId[], role: "owner" | "reviewer", owner?: PeerId): PeerId[] => {
    const down = role === "owner" ? ok.filter((p) => peerEntry(opts.demoted, p)) : [];
    if (down.length) trace.push(`  demoted for ${task.class}: ${down.map((p) => `${p} (${opts.demoted![p]!.toFixed(1)} recent failures)`).join(", ")}`);
    const ranked = [...byDrain(ok.filter((p) => !down.includes(p))), ...byDrain(down)];
    // The review record comes after quota, so it decides among reviewers that have one: idle, then record, then quota.
    return role === "reviewer" ? byRecord(ranked, owner) : ranked;
  };

  const pick = (list: PeerId[], role: "owner" | "reviewer", not?: PeerId, sortSiblings = false): PeerId | undefined => {
    const ok: PeerId[] = [];
    for (const peer of list) {
      const why = peer === not ? "is the owner" : blocked(peer, role);
      trace.push(`  ${role} candidate ${peer}: ${why ? `skipped, ${why}` : states[peer]}`);
      if (!why) ok.push(peer);
    }
    const ranked = sortSiblings ? orderSiblingSlots(rank(ok, role, not), states, opts) : rank(ok, role, not);
    // Demotion applies to local and Pi too: a demoted one loses its place ahead of the cloud peers.
    const localTier = ranked.filter((p) => (opts.adapterCatalog?.definitionOf ?? definitionOf)(p, opts.instances)?.routing?.preferredTier === true && !(role === "owner" && peerEntry(opts.demoted, p)));
    if (localTier.length) return localTier.find((p) => states[p] === "idle") ?? localTier[0]; // local/Pi stays ahead of an idle cloud peer
    return ranked.find((p) => states[p] === "idle") ?? ranked[0];
  };

  // The PII constraint, capability limits, exclusions and peer states still apply: when they pass it over, routing proceeds.
  const unreserved = reserved ? blocked(reserved, "owner") : undefined;
  if (reserved) trace.push(`reserved owner ${reserved}: ${unreserved ? `not honored, ${unreserved}; routing proceeds` : "honored"}`);
  // Never the task's current owner by default: a decline or an escalation has to reach the next peer in the list.
  const automaticOwner = !(reserved && !unreserved) && opts.candidates === undefined && !(instanceMode && opts.namedOwner !== undefined);
  const wanted = reserved && !unreserved ? [reserved] : opts.candidates ?? (instanceMode && opts.namedOwner !== undefined ? [opts.namedOwner] : expandClassPeers(policy?.peers ?? [], states, opts));
  const owner = pick(wanted, "owner", undefined, automaticOwner);
  trace.push(owner ? `owner: ${owner}` : "owner: none available, task stays proposed (ahub task assign <id> <peer>)");
  const ownerHold = owner ? peerEntry(opts.held, owner) : undefined;
  if (ownerHold) trace.push(`  hold: ${owner}'s queue is held: ${ownerHold} (it receives the task once the hold is resolved)`);

  // #525-3: the planner is chosen by its own walk over the settled planner holders, independent of the owner and the reviewer (planner and
  // owner, or planner and reviewer, may be the same peer). Information only until 525-2 records it: nothing here moves the task.
  let planner: PeerId | undefined, plannerReason: PlannerReason | undefined;
  if (opts.planners !== undefined) {
    const plannerBlocked = (peer: PeerId): string | undefined => {
      if ((opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.routing?.allowedRoles?.includes("planner") === false) return "adapter role ceiling excludes planning";
      if (opts.offRoster?.includes(peer)) return "off roster";
      if (!Object.hasOwn(states, peer)) return "not attached";
      if (states[peer] === "offline") return "offline";
      if (states[peer] === "paused" && routing.constraints.budget_paused === "skip_peer") return "paused";
      const failing = peerEntry(opts.failing, peer);
      return failing ? `failing: ${failing}` : undefined;
    };
    const walked = plannerWalk({ planners: opts.planners, seed: task.id ?? 0, ...(opts.namedPlanner !== undefined ? { named: opts.namedPlanner } : {}),
      ...(opts.keptPlanner !== undefined ? { kept: opts.keptPlanner } : {}), blocked: plannerBlocked, pii });
    for (const row of walked.walk) trace.push(`  planner candidate ${row.peer}: ${row.note}`);
    trace.push(walked.line);
    planner = walked.planner;
    plannerReason = walked.reason;
  }

  let reviewer: PeerId | undefined;
  let sameFamilyFallback = false;
  let plannerFallback = false;
  let reviewSelection: ReviewerPoolSelection | undefined;
  let reviewBlocked = false;
  if (task.class !== "review") {
    if (pii) trace.push("reviewer: user (pii: no second on-prem peer; ahub review <id> <verdict>)");
    else {
      // Reviewer candidates (issue #92): the review class's peers first, then peers holding the reviewer role, deduped.
      const classPeers = routing.classes.review?.peers ?? [];
      const rolePeers = Object.keys(opts.roles ?? {}).filter((p) => opts.roles![p]!.includes("reviewer"));
      trace.push(opts.namedReviewer === undefined ? `  reviewer candidates: [classes.review] peers ${classPeers.join(", ") || "none"}${rolePeers.length ? `; reviewer role ${rolePeers.join(", ")}` : ""}` : `  reviewer candidate explicitly named: ${opts.namedReviewer}`);
      const reviewOwner = owner ?? opts.notReviewer;
      const automatic = [...new Set([...expandClassPeers(classPeers, states, opts), ...rolePeers])];
      const ownerFamily = instanceMode && reviewOwner ? (opts.adapterCatalog?.familyOf ?? familyOf)(reviewOwner, opts.instances) : undefined;
      const sameFamily = (peer: PeerId) => ownerFamily !== undefined && (opts.adapterCatalog?.familyOf ?? familyOf)(peer, opts.instances) === ownerFamily;
      // #820: with review.same_family = never, a reviewer of the owner's family is never chosen; the planner or the person reviews instead.
      const neverSame = opts.reviewPool?.sameFamily === "never" && ownerFamily !== undefined;
      if (neverSame) trace.push(`  review.same_family = never: no reviewer of the owner's family (${ownerFamily}) is chosen; another family, the planner or the person reviews`);
      const independent = ownerFamily === undefined ? [] : automatic.filter(peer => peer !== reviewOwner && !blocked(peer, "reviewer") && !sameFamily(peer));
      const named = opts.namedReviewer;
      const declaredPool = opts.reviewPool && named === undefined ? Object.keys(opts.instances ?? {}).flatMap(id => {
        const roles = peerEntry(opts.roles, id), definition = (opts.adapterCatalog?.definitionOf ?? definitionOf)(id, opts.instances);
        const kind = (opts.adapterCatalog?.kindOf ?? kindOf)(id, opts.instances), family = (opts.adapterCatalog?.familyOf ?? familyOf)(id, opts.instances);
        if (roles?.length !== 1 || roles[0] !== "reviewer" || !definition?.routing?.reviewOnly || !kind || !family) return [];
        const reason = id === reviewOwner ? "is the owner" : definition.reviewer?.unavailable ?? blocked(id, "reviewer")
          ?? (states[id] === "paused" ? "paused" : undefined)
          ?? peerEntry(opts.held, id)
          ?? ((peerEntry(opts.quota, id)?.headroom ?? Infinity) <= 0 ? "quota exhausted" : undefined);
        return [{ id, kind, family, ...(reason === undefined ? {} : { blocked: reason }) }];
      }) : [];
      if (declaredPool.length || opts.reviewPool?.required && named === undefined) {
        for (const candidate of declaredPool) if (!opts.reviewPool!.pool.includes(candidate.kind)) trace.push(`  reviewer pool candidate ${candidate.id} (${candidate.family}): unavailable skip: ${candidate.blocked ?? "kind outside configured pool"}`);
        const last = task.history?.findLast(entry => entry.event === "changes_requested");
        const continuityFamily = last && "reviewerFamily" in last && typeof last.reviewerFamily === "string" ? last.reviewerFamily : last ? (opts.adapterCatalog?.familyOf ?? familyOf)(last.by, opts.instances) : undefined;
        const pr = task.sdlc?.pr;
        const seed = typeof pr === "number" && Number.isSafeInteger(pr) && pr > 0 ? pr : task.id ?? 0;
        reviewSelection = selectReviewerPool({ pool: opts.reviewPool!.pool, candidates: declaredPool, seed, implementerFamily: ownerFamily, continuityFamily, rerotate: opts.reviewPool!.rerotate, failed: opts.reviewPool!.failed, ...(neverSame ? { sameFamily: "never" as const } : {}) });
        for (const row of reviewSelection.walk) trace.push(row.id ? `  reviewer pool candidate ${row.id} (${row.family}): ${row.reason}` : `  reviewer pool kind ${row.kind}: ${row.reason}`);
        reviewer = reviewSelection.reviewer ?? "user";
        if (reviewSelection.blocked) {
          trace.push("blocked: no reviewer can run");
          // Optional defaults retain the legacy planner escape when no fresh reviewer can run.
          const planners = opts.reviewPool?.required && !neverSame ? [] : automatic.filter(peer => peer !== reviewOwner && peerEntry(opts.roles, peer)?.includes("planner") && (!neverSame || peerEntry(opts.roles, peer)?.includes("reviewer") === true) && !(opts.adapterCatalog?.definitionOf ?? definitionOf)(peer, opts.instances)?.routing?.reviewOnly && !blocked(peer, "reviewer"));
          const otherFamily = planners.filter(peer => !sameFamily(peer));
          const planner = pick(neverSame || otherFamily.length ? otherFamily : planners, "reviewer", reviewOwner);
          if (planner) {
            reviewer = planner;
            plannerFallback = true;
            trace.push(`  planner fallback: no declared reviewer-only instance is eligible; ${planner} reviews`);
          } else reviewBlocked = true;
        }
      } else if (neverSame && named !== undefined && named !== reviewOwner && !blocked(named, "reviewer") && sameFamily(named)) {
        const reason = `same family as ${reviewOwner}; review.same_family is never`;
        refusals.set(`reviewer:${named}`, { peer: named, role: "reviewer", code: "family", reason });
        trace.push(`  reviewer candidate ${named}: skipped, ${reason}`);
      } else if (named !== undefined && named !== reviewOwner && !blocked(named, "reviewer") && sameFamily(named) && independent.length) {
        const reason = `same family as ${reviewOwner}; eligible other-family reviewer available`;
        refusals.set(`reviewer:${named}`, { peer: named, role: "reviewer", code: "family", reason });
        trace.push(`  reviewer candidate ${named}: skipped, ${reason}`);
      } else {
        // #223 R1: a declared instance that reviews and does not plan goes first, busy or not.
        const holds = (peer: PeerId, role: string) => opts.roles?.[peer]?.includes(role) === true;
        const dedicated = (peer: PeerId) => !!opts.instances && Object.hasOwn(opts.instances, peer) && holds(peer, "reviewer") && !holds(peer, "planner");
        const pool = independent.length || neverSame ? independent : automatic;
        const ready = named === undefined ? pool.filter(peer => dedicated(peer) && peer !== reviewOwner && !blocked(peer, "reviewer")) : [];
        reviewer = pick(named === undefined ? ready.length ? ready : pool : [named], "reviewer", reviewOwner, named === undefined);
        if (named === undefined && !ready.length && reviewer && holds(reviewer, "planner") && Object.keys(opts.roles ?? {}).some(dedicated)) {
          plannerFallback = true;
          trace.push(`  planner fallback: no declared reviewer-only instance is eligible; ${reviewer} reviews`);
        }
      }
      if (reviewer && sameFamily(reviewer)) {
        sameFamilyFallback = true;
        trace.push(`  same-family fallback: ${reviewer} and ${reviewOwner} share ${ownerFamily}; no eligible other family`);
      }
      // Under never an exhausted automatic choice (nobody eligible, all offline, no candidate at all) is the person's, never an approval without review.
      if (opts.reviewPool?.sameFamily === "never" && reviewOwner !== undefined && !reviewer && named === undefined && !reviewSelection) {
        reviewer = "user";
        reviewBlocked = true;
        trace.push("  review.same_family = never: no reviewer of another family and no eligible planner; the person reviews");
      }
      // I-2 (#525-3): when the peers that implemented this task were the only candidates left, the person reviews. Never a fallback to an implementer.
      if (!reviewer && [...refusals.values()].some(row => row.role === "reviewer" && row.code === "policy" && row.reason === "implemented this task")) {
        reviewer = "user";
        reviewBlocked = true;
        trace.push("  every eligible reviewer implemented this task: the person reviews");
      }
      trace.push(reviewer ? `reviewer: ${reviewer}` : "reviewer: none, done will approve directly");
      const reviewerHold = reviewer ? peerEntry(opts.held, reviewer) : undefined;
      if (reviewerHold) trace.push(`  hold: ${reviewer}'s queue is held: ${reviewerHold} (it receives the review once the hold is resolved)`);
    }
  }
  const route = effectiveLocalRoute(routing.local.route, policy?.route, policy?.fixed_model);
  const fixedModel = policy?.fixed_model ?? routing.local.fixed_model;
  const piBackend = policy?.pi_backend;
  if (owner && (opts.adapterCatalog?.definitionOf ?? definitionOf)(owner, opts.instances)?.routing?.trace === "route") trace.push(`route: ${route ?? "(none)"}, fixed_model ${fixedModel}`);
  if (owner && (opts.adapterCatalog?.definitionOf ?? definitionOf)(owner, opts.instances)?.routing?.trace === "backend") trace.push(`${(opts.adapterCatalog?.definitionOf ?? definitionOf)(owner, opts.instances)!.routing!.backendLabel} decision: backend ${piBackend ?? "dgx"}${task.signals.includes("long_context") ? `, context limit ${piBackend === "mlx" ? routing.pi.mlx_max_context_tokens : routing.pi.dgx_max_context_tokens}` : ""}`);
  return { ...(reviewSelection ? { reviewSelection } : {}), ...(reviewBlocked ? { reviewBlocked: true as const } : {}), ...(sameFamilyFallback ? { sameFamilyFallback: true as const } : {}), ...(plannerFallback ? { plannerFallback: true as const } : {}), ...(owner ? { owner } : {}), ...(planner ? { planner } : {}), ...(plannerReason ? { plannerReason } : {}), ...(pii ? { reviewer: "user" } : reviewer ? { reviewer } : {}), ...(route ? { route } : {}), fixedModel, ...(piBackend ? { piBackend } : {}), ...(unreserved ? { unreserved } : {}), ...(refusals.size ? { refusals: [...refusals.values()] } : {}), trace };
}

/**
 * One recorded task of a peer in a class, as stage proxies (issue #109): `orient` from being handed the task to its
 * accept (queueing included), `work` from the accept to its done. Unknown stages stay undefined, never zero.
 */
export interface SplitObservation {
  outcome: "approved" | "failed";
  orient?: number;
  work?: number;
}

/** Everything the shadow split prediction reads; `Tasks` builds it once and `route explain` shows the same. */
export interface SplitInput {
  /** The pair: the peer routing would pick for the task, and the owner of the open task it overlaps. */
  peers: [PeerId, PeerId];
  /**
   * Each peer's observations in this class, across hub runs of the project, from the records tagged with the profile
   * the peer has now (hub version, agent version, hook profile): only those describe the peer being predicted.
   */
  observations: Record<PeerId, SplitObservation[]>;
  /** Each peer's profile now; undefined while its agent's version is unknown, and then no record matches it. */
  profiles: Record<PeerId, string | undefined>;
  /** Work units of the routed task and of the one it overlaps; undefined is unknown. */
  units: [number | undefined, number | undefined];
  /** Other open work each peer has: a busy owner does not start from orientation plus two whole units. */
  backlog: Record<PeerId, number>;
  available: Record<PeerId, boolean>;
}

export interface SplitPrediction {
  verdict: "split" | "single" | "unknown";
  trace: string[];
  /** The peer that would finish both units soonest on its own. */
  single?: PeerId;
  /** Predicted seconds: both peers one unit each, in parallel (the later of the two), and the best peer alone. */
  splitS?: number;
  singleS?: number;
}

/** Observations a peer needs, and the share of failures a history may hold, before a prediction is made. */
export const SPLIT_MIN = 5;
const SPLIT_FAILURE_SHARE = 0.3;

/**
 * Shadow split prediction (issue #109): never changes assignment. For two similar units of overlapping work, a split
 * (each peer one unit, in parallel) finishes when the later of `o + u` does; the best single peer takes `o + 2u`. With
 * a faster and a slower peer that is `o_s + u_s < o_f + 2u_f`. It is a model assumption (equal units, measured
 * orientation, free coordination), not a bound, so anything that breaks it makes the prediction unknown: unequal or
 * unknown units, a busy or unavailable peer, too few or failure-heavy records, or work times too spread out to call
 * comparable. A difference under a tenth of the single time is inconclusive.
 */
export function predictSplit(input: SplitInput): SplitPrediction {
  const trace: string[] = ["shadow split prediction (it never changes assignment):"];
  const unknown = (why: string): SplitPrediction => ({ verdict: "unknown", trace: [...trace, `  unknown: ${why}`] });
  const [a, b] = input.peers;
  if (a === b) return unknown("the routed task and the one it overlaps have the same owner");
  const [ua, ub] = input.units;
  if (ua === undefined || ub === undefined || ua !== ub) return unknown(`work units ${ua ?? "?"} and ${ub ?? "?"}: the rule needs two equal, known units`);
  for (const p of [a, b]) {
    if (!input.profiles[p]) return unknown(`${p}'s version is unknown: no record can be matched to it`);
    trace.push(`  ${p}: ${input.profiles[p]}`);
  }
  for (const p of [a, b]) {
    if (!input.available[p]) return unknown(`${p} is not available`);
    if ((input.backlog[p] ?? 0) > 0) return unknown(`${p} has ${input.backlog[p]} other open task(s): it would not start from orientation plus two units`);
  }
  const median = (xs: number[]) => {
    const v = [...xs].sort((x, y) => x - y);
    return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
  };
  const stats: Record<PeerId, { o: number; u: number }> = {};
  for (const p of [a, b]) {
    const all = input.observations[p] ?? [];
    const failed = all.filter((o) => o.outcome !== "approved").length;
    const ok = all.filter((o): o is Required<SplitObservation> => o.outcome === "approved" && o.orient !== undefined && o.work !== undefined);
    if (ok.length < SPLIT_MIN) return unknown(`${p} has ${ok.length} measured task(s) with this profile; ${SPLIT_MIN} are needed`);
    if (failed / all.length > SPLIT_FAILURE_SHARE) return unknown(`${failed} of ${all.length} of ${p}'s recorded tasks failed: its successes alone would understate its time`);
    const works = ok.map((o) => o.work).sort((x, y) => x - y);
    const u = median(works);
    const iqr = works[Math.floor((works.length * 3) / 4)]! - works[Math.floor(works.length / 4)]!;
    if (u <= 0 || iqr / u > 1) return unknown(`${p}'s work times spread too widely (IQR ${Math.round(iqr / 1000)} s against a median of ${Math.round(u / 1000)} s) to call its tasks comparable units`);
    stats[p] = { o: median(ok.map((o) => o.orient)), u };
    trace.push(`  ${p}: orientation ${Math.round(stats[p]!.o / 1000)} s, one unit ${Math.round(u / 1000)} s (median of ${ok.length})`);
  }
  const single = stats[a]!.o + 2 * stats[a]!.u <= stats[b]!.o + 2 * stats[b]!.u ? a : b;
  const s = (ms: number) => Math.round(ms / 1000);
  const splitS = s(Math.max(stats[a]!.o + stats[a]!.u, stats[b]!.o + stats[b]!.u));
  const singleS = s(stats[single]!.o + 2 * stats[single]!.u);
  trace.push(`  split: ${splitS} s (${a} ${s(stats[a]!.o + stats[a]!.u)} s, ${b} ${s(stats[b]!.o + stats[b]!.u)} s for one unit each); ${single} alone: ${singleS} s for two`);
  if (Math.abs(splitS - singleS) < singleS / 10) return { ...unknown("the difference is under a tenth of the single time: inconclusive"), single, splitS, singleS };
  const verdict = splitS < singleS ? "split" : "single";
  trace.push(verdict === "split" ? "  a split would finish sooner" : `  ${single} alone would finish sooner`);
  return { verdict, trace, single, splitS, singleS };
}
