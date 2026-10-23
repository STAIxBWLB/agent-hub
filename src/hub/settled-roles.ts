import { conductorPeer } from "./conductor.ts";
import { PLANNER_PEERS } from "../adapters/registry.ts";

export interface SettledRoles {
  roles: Record<string, string[]>;
  source: "setting" | "roles" | "automatic" | "none";
  planners: string[];
  conductor?: string;
}

/** Resolve the runtime planner fallback without changing the configured policy role map. */
export function resolveSettledRoles(
  policyRoles: Readonly<Record<string, readonly string[]>>,
  planner: string | readonly string[] | undefined,
  rostered: (peer: string) => boolean,
  /** Extra ids are eligible only through the host's validated startup catalog, never a kind-name fallback. */
  plannerCapable?: (peer: string) => boolean,
): SettledRoles {
  const roles = Object.fromEntries(Object.entries(policyRoles).map(([peer, list]) => [peer, [...list]]));
  const eligible = (peer: unknown): peer is string => typeof peer === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(peer)
    && !["user", "hub", "digest"].includes(peer) && ((PLANNER_PEERS as readonly string[]).includes(peer) || plannerCapable?.(peer) === true);
  let pinned: readonly string[] | undefined;
  if (typeof planner === "string") {
    // Direct callers historically ignored an unknown scalar; configuration validation rejects it before this resolver.
    if (eligible(planner)) pinned = [planner];
  } else if (planner !== undefined) {
    if (!Array.isArray(planner) || planner.length < 1 || planner.length > 8 || new Set(planner).size !== planner.length || !planner.every(eligible))
      throw new Error("planner list must contain 1..8 distinct eligible peer ids");
    pinned = planner;
  }
  let source: SettledRoles["source"];
  if (pinned) {
    for (const peer of Object.keys(roles)) roles[peer] = roles[peer]!.filter(role => role !== "planner");
    for (const peer of pinned) roles[peer] = ["planner", ...(roles[peer] ?? [])];
    source = "setting";
  } else if (Object.entries(roles).some(([peer, list]) => list.includes("planner") && rostered(peer))) source = "roles";
  else {
    const auto = PLANNER_PEERS.find(rostered);
    if (auto) {
      for (const peer of Object.keys(roles)) roles[peer] = roles[peer]!.filter(role => role !== "planner");
      roles[auto] = [...(roles[auto] ?? []), "planner"];
    }
    source = auto ? "automatic" : "none";
  }
  const conductor = conductorPeer(roles);
  return { roles, source, planners: Object.keys(roles).filter(peer => roles[peer]!.includes("planner")).sort(), ...(conductor === null ? {} : { conductor }) };
}
