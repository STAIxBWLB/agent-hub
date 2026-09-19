import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Task, TaskClass } from "./board.ts";
import type { PeerId, PeerState } from "./envelope.ts";

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
}

export interface Routing {
  local: { route?: string; fixed_model: string };
  targets: Record<string, Table & { id: string }>;
  routes: Record<string, Table & { type: string }>;
  classes: Partial<Record<TaskClass, ClassPolicy>>;
  signals: { pii_patterns: string[]; long_context_tokens: number };
  constraints: { pii: "local_only" | "off"; long_context: "skip_local" | "off"; budget_paused: "skip_peer" | "off" };
}

const TEMPLATE = join(import.meta.dir, "..", "..", "templates", "routing.toml");
export const LOCAL: PeerId = "local";

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
  return {
    local: raw.local,
    targets: raw.targets ?? {},
    routes: raw.routes ?? {},
    classes: raw.classes ?? {},
    signals,
    constraints: { pii: "local_only", long_context: "skip_local", budget_paused: "skip_peer", ...raw.constraints },
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

export type Signal = "pii" | "long_context";

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

export interface Assignment {
  owner?: PeerId;
  reviewer?: PeerId;
  /** what `local` should ask for on this task: a Switchyard route id and the model to fall back to */
  route?: string;
  fixedModel?: string;
  trace: string[];
}

/**
 * L1. A pure function of policy, task and peer states, so `hub route explain` runs exactly what assignment runs and
 * prints its trace. `states`: effective bus states of attached peers (a peer that is not in the map is not attached).
 */
export function assign(
  task: Pick<Task, "class" | "signals">,
  states: Record<PeerId, PeerState>,
  routing: Routing,
  opts: { exclude?: PeerId[]; candidates?: PeerId[]; notReviewer?: PeerId } = {},
): Assignment {
  const policy = routing.classes[task.class];
  const trace: string[] = [`class ${task.class}${policy ? "" : " (no [classes] entry: only an explicit owner can take it)"}`, `signals: ${task.signals.join(", ") || "none"}`];
  const pii = task.signals.includes("pii") && routing.constraints.pii === "local_only";

  const blocked = (peer: PeerId, role: "owner" | "reviewer"): string | undefined => {
    if (!(peer in states)) return "not attached";
    if (opts.exclude?.includes(peer)) return "excluded (declined or replaced)";
    if (states[peer] === "offline") return "offline";
    if (states[peer] === "paused" && routing.constraints.budget_paused === "skip_peer") return "paused";
    if (pii && peer !== LOCAL) return "pii: on-prem peers only";
    if (peer === LOCAL && policy?.local_allowed === false) return "local_allowed = false for this class";
    if (peer === LOCAL && role === "owner" && task.signals.includes("long_context") && routing.constraints.long_context === "skip_local") return "long_context: skip local";
    return undefined;
  };

  const pick = (list: PeerId[], role: "owner" | "reviewer", not?: PeerId): PeerId | undefined => {
    const ok: PeerId[] = [];
    for (const peer of list) {
      const why = peer === not ? "is the owner" : blocked(peer, role);
      trace.push(`  ${role} candidate ${peer}: ${why ? `skipped, ${why}` : states[peer]}`);
      if (!why) ok.push(peer);
    }
    return ok.find((p) => states[p] === "idle") ?? ok[0]; // idle before busy, otherwise preference order
  };

  // Never the task's current owner by default: a decline or an escalation has to reach the next peer in the list.
  const wanted = opts.candidates ?? policy?.peers ?? [];
  const owner = pick(wanted, "owner");
  trace.push(owner ? `owner: ${owner}` : "owner: none available, task stays proposed (hub task assign <id> <peer>)");

  let reviewer: PeerId | undefined;
  if (task.class !== "review") {
    if (pii) trace.push("reviewer: user (pii: no second on-prem peer; hub review <id> <verdict>)");
    else {
      reviewer = pick(routing.classes.review?.peers ?? [], "reviewer", owner ?? opts.notReviewer);
      trace.push(reviewer ? `reviewer: ${reviewer}` : "reviewer: none, done will approve directly");
    }
  }
  const route = policy?.route ?? routing.local.route;
  const fixedModel = policy?.fixed_model ?? routing.local.fixed_model;
  if (owner === LOCAL) trace.push(`route: ${route ?? "(none)"}, fixed_model ${fixedModel}`);
  return { ...(owner ? { owner } : {}), ...(pii ? { reviewer: "user" } : reviewer ? { reviewer } : {}), ...(route ? { route } : {}), fixedModel, trace };
}
