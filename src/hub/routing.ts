import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Task, TaskClass } from "./board.ts";
import type { PeerId, PeerState } from "./envelope.ts";

import { parseHubRoutes, type HubRoute } from "../models/route/config.ts";
import { DEFAULT_STAY_SWITCH, type StaySwitchMode } from "../models/route/stage.ts";

type Table = Record<string, unknown>;

export interface ClassPolicy {
  /** preference order among attached, unpaused peers */
  peers: PeerId[];
  /** Switchyard route the local worker asks for on a task of this class */
  route?: string;
  fixed_model?: string;
  /** on two consecutive changes_requested */
  escalate_to?: PeerId[];
  /** false: `local` is never owner or reviewer for this class */
  local_allowed?: boolean;
  /** Pi backend for Pi-owned work. */
  pi_backend?: "dgx" | "mlx";
}

export interface Routing {
  local: { route?: string; fixed_model: string };
  targets: Record<string, Table & { id: string }>;
  routes: Record<string, Table & { type: string }>;
  hub_routes?: Record<string, HubRoute>;
  /** Session-aware stay/switch for `hub/auto` and hub stage routes (#197). */
  stay_switch: StaySwitchMode;
  max_switch_prefill_tokens: number;
  classes: Partial<Record<TaskClass, ClassPolicy>>;
  signals: { pii_patterns: string[]; long_context_tokens: number };
  constraints: { pii: "local_only" | "off"; long_context: "skip_local" | "off"; budget_paused: "skip_peer" | "off" };
  /** `efficient_wait_ms`: how long a hub/auto request waits for a busy MLX slot before it moves to dgx/fast (#199). */
  pi: { dgx_max_context_tokens: number; mlx_max_context_tokens: number; efficient_wait_ms: number };
}

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "routing.toml");
export const LOCAL: PeerId = "local";
export const PI: PeerId = "pi";

/** `.agenthub/routing.toml`, or the shipped default when the project has none. Throws on a file that does not parse or lacks a fixed model. */
export function loadRouting(cwd: string): Routing {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".agenthub", "routing.toml"), "utf8");
  } catch {
    text = readFileSync(TEMPLATE, "utf8");
  }
  const raw = Bun.TOML.parse(text) as Partial<Routing>;
  if (!raw.local?.fixed_model) throw new Error("routing.toml: [local] fixed_model is required (the path that works without Switchyard)");
  const signals = { pii_patterns: [], long_context_tokens: 120_000, ...raw.signals };
  for (const p of signals.pii_patterns) new RegExp(p); // a bad pattern fails here, at load, not in the middle of an assignment
  const classes = raw.classes ?? {};
  for (const [name, policy] of Object.entries(classes)) {
    if (policy?.pi_backend !== undefined && policy.pi_backend !== "dgx" && policy.pi_backend !== "mlx") throw new Error(`routing.toml: [classes.${name}] pi_backend must be "dgx" or "mlx"`);
  }
  const pi = { dgx_max_context_tokens: 262_144, mlx_max_context_tokens: 16_000, efficient_wait_ms: 500, ...(raw as any).pi };
  if (!(Number.isSafeInteger(pi.dgx_max_context_tokens) && pi.dgx_max_context_tokens > 0) || !(Number.isSafeInteger(pi.mlx_max_context_tokens) && pi.mlx_max_context_tokens > 0)) throw new Error("routing.toml: [pi] context limits must be positive integers");
  // A dispatch gives up on a busy MLX slot after 120 s; a longer load wait would never move anything.
  if (!(Number.isSafeInteger(pi.efficient_wait_ms) && pi.efficient_wait_ms >= 0 && pi.efficient_wait_ms < 120_000)) throw new Error("routing.toml: [pi] efficient_wait_ms must be an integer from 0 to 119999");
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
    targets: raw.targets ?? {},
    routes: raw.routes ?? {},
    hub_routes: parseHubRoutes(raw.hub_routes),
    stay_switch,
    max_switch_prefill_tokens,
    classes,
    signals,
    constraints: { pii: "local_only", long_context: "skip_local", budget_paused: "skip_peer", ...raw.constraints },
    pi,
  };
}

const cache = new Map<string, { mtime: number; routing: Routing }>();

/**
 * loadRouting behind an mtime check. routing.toml is edited while the hub runs and read on every task operation;
 * a half-saved file must not abort an operation midway, so the last good parse stays in force until the file parses again.
 */
export function currentRouting(cwd: string, log: (line: string) => void = () => {}): Routing {
  let mtime = 0;
  try {
    mtime = statSync(join(cwd, ".agenthub", "routing.toml")).mtimeMs;
  } catch {
    // no project file: the shipped template
  }
  const hit = cache.get(cwd);
  if (hit && hit.mtime === mtime) return hit.routing;
  try {
    const routing = loadRouting(cwd);
    cache.set(cwd, { mtime, routing });
    return routing;
  } catch (e) {
    if (!hit) throw e;
    log(`routing.toml does not load, keeping the previous policy: ${(e as Error).message}`);
    cache.set(cwd, { mtime, routing: hit.routing });
    return hit.routing;
  }
}

export type Signal = "pii" | "long_context" | "urgent";

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

export interface Assignment {
  owner?: PeerId;
  reviewer?: PeerId;
  /** what `local` should ask for on this task: a Switchyard route id and the model to fall back to */
  route?: string;
  fixedModel?: string;
  piBackend?: "dgx" | "mlx";
  /** Why the task's reserved owner (issue #207) was passed over; absent when it was honored or there is none. */
  unreserved?: string;
  trace: string[];
}

/**
 * L1. A pure function of policy, task and peer states, so `ahub route explain` runs exactly what assignment runs and
 * prints its trace. `states`: effective bus states of attached peers (a peer that is not in the map is not attached).
 */
export function assign(
  task: Pick<Task, "class" | "signals" | "reserved">,
  states: Record<PeerId, PeerState>,
  routing: Routing,
  opts: {
    exclude?: PeerId[];
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
  const policy = routing.classes[task.class];
  const trace: string[] = [`class ${task.class}${policy ? "" : " (no [classes] entry: only an explicit owner can take it)"}`, `signals: ${task.signals.join(", ") || "none"}`];
  // A reserved owner (issue #207) is offered the task first. Named candidates (an assign, an escalation, a relay) replace it.
  const reserved = opts.candidates ? undefined : task.reserved ?? undefined;
  // Readiness is an input like peer states (issue #34): a task that waits for others goes to nobody yet.
  if (opts.waitsFor?.length) return { trace: [...trace, `blocked: waits for ${opts.waitsFor.map((id) => `#${id}`).join(", ")} (not approved)`, ...(reserved ? [`reserved owner ${reserved}: offered first once it is ready`] : [])] };
  const pii = task.signals.includes("pii") && routing.constraints.pii === "local_only";

  const blocked = (peer: PeerId, role: "owner" | "reviewer"): string | undefined => {
    if (!Object.hasOwn(states, peer)) return "not attached";
    if (opts.exclude?.includes(peer)) return "excluded (declined or replaced)";
    if (states[peer] === "offline") return "offline";
    if (states[peer] === "paused" && routing.constraints.budget_paused === "skip_peer") return "paused";
    const failing = peerEntry(opts.failing, peer);
    if (failing) return `failing: ${failing}`;
    if (pii && peer !== LOCAL) return "pii: on-prem peers only";
    if (peer === LOCAL && policy?.local_allowed === false) return "local_allowed = false for this class";
    if (peer === PI && policy?.local_allowed === false) return "local_allowed = false also excludes pi for this class";
    if (peer === PI && task.signals.includes("long_context")) {
      const backend = policy?.pi_backend ?? "dgx";
      const limit = backend === "mlx" ? routing.pi.mlx_max_context_tokens : routing.pi.dgx_max_context_tokens;
      if (routing.signals.long_context_tokens > limit) return `pi ${backend} capability limit ${limit} tokens`;
    }
    if (peer === LOCAL && role === "owner" && task.signals.includes("long_context") && routing.constraints.long_context === "skip_local") return "long_context: skip local";
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

  const pick = (list: PeerId[], role: "owner" | "reviewer", not?: PeerId): PeerId | undefined => {
    const ok: PeerId[] = [];
    for (const peer of list) {
      const why = peer === not ? "is the owner" : blocked(peer, role);
      trace.push(`  ${role} candidate ${peer}: ${why ? `skipped, ${why}` : states[peer]}`);
      if (!why) ok.push(peer);
    }
    const ranked = rank(ok, role, not);
    // Demotion applies to local and Pi too: a demoted one loses its place ahead of the cloud peers.
    const localTier = ranked.filter((p) => (p === LOCAL || p === PI) && !(role === "owner" && peerEntry(opts.demoted, p)));
    if (localTier.length) return localTier.find((p) => states[p] === "idle") ?? localTier[0]; // local/Pi stays ahead of an idle cloud peer
    return ranked.find((p) => states[p] === "idle") ?? ranked[0];
  };

  // The PII constraint, capability limits, exclusions and peer states still apply: when they pass it over, routing proceeds.
  const unreserved = reserved ? blocked(reserved, "owner") : undefined;
  if (reserved) trace.push(`reserved owner ${reserved}: ${unreserved ? `not honored, ${unreserved}; routing proceeds` : "honored"}`);
  // Never the task's current owner by default: a decline or an escalation has to reach the next peer in the list.
  const wanted = reserved && !unreserved ? [reserved] : opts.candidates ?? policy?.peers ?? [];
  const owner = pick(wanted, "owner");
  trace.push(owner ? `owner: ${owner}` : "owner: none available, task stays proposed (ahub task assign <id> <peer>)");
  const ownerHold = owner ? peerEntry(opts.held, owner) : undefined;
  if (ownerHold) trace.push(`  hold: ${owner}'s queue is held: ${ownerHold} (it receives the task once the hold is resolved)`);

  let reviewer: PeerId | undefined;
  if (task.class !== "review") {
    if (pii) trace.push("reviewer: user (pii: no second on-prem peer; ahub review <id> <verdict>)");
    else {
      // Reviewer candidates (issue #92): the review class's peers first, then peers holding the reviewer role, deduped.
      const classPeers = routing.classes.review?.peers ?? [];
      const rolePeers = Object.keys(opts.roles ?? {}).filter((p) => opts.roles![p]!.includes("reviewer"));
      trace.push(`  reviewer candidates: [classes.review] peers ${classPeers.join(", ") || "none"}${rolePeers.length ? `; reviewer role ${rolePeers.join(", ")}` : ""}`);
      reviewer = pick([...new Set([...classPeers, ...rolePeers])], "reviewer", owner ?? opts.notReviewer);
      trace.push(reviewer ? `reviewer: ${reviewer}` : "reviewer: none, done will approve directly");
      const reviewerHold = reviewer ? peerEntry(opts.held, reviewer) : undefined;
      if (reviewerHold) trace.push(`  hold: ${reviewer}'s queue is held: ${reviewerHold} (it receives the review once the hold is resolved)`);
    }
  }
  const route = policy?.route ?? routing.local.route;
  const fixedModel = policy?.fixed_model ?? routing.local.fixed_model;
  const piBackend = policy?.pi_backend;
  if (owner === LOCAL) trace.push(`route: ${route ?? "(none)"}, fixed_model ${fixedModel}`);
  if (owner === PI) trace.push(`pi decision: backend ${piBackend ?? "dgx"}${task.signals.includes("long_context") ? `, context limit ${piBackend === "mlx" ? routing.pi.mlx_max_context_tokens : routing.pi.dgx_max_context_tokens}` : ""}`);
  return { ...(owner ? { owner } : {}), ...(pii ? { reviewer: "user" } : reviewer ? { reviewer } : {}), ...(route ? { route } : {}), fixedModel, ...(piBackend ? { piBackend } : {}), ...(unreserved ? { unreserved } : {}), trace };
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
