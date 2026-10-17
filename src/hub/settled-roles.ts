import { conductorPeer } from "./conductor.ts";
import { PLANNER_PEERS } from "./peer-catalog.ts";

export interface SettledRoles {
  roles: Record<string, string[]>;
  source: "setting" | "roles" | "automatic" | "none";
  planners: string[];
  conductor?: string;
}

/** Resolve the runtime planner fallback without changing the configured policy role map. */
export function resolveSettledRoles(
  policyRoles: Readonly<Record<string, readonly string[]>>,
  planner: string | undefined,
  rostered: (peer: string) => boolean,
): SettledRoles {
  const roles = Object.fromEntries(Object.entries(policyRoles).map(([peer, list]) => [peer, [...list]]));
  const pinned = (PLANNER_PEERS as readonly string[]).includes(planner ?? "") ? planner! : undefined;
  let source: SettledRoles["source"];
  if (pinned) {
    for (const peer of Object.keys(roles)) roles[peer] = roles[peer]!.filter(role => role !== "planner");
    roles[pinned] = ["planner", ...(roles[pinned] ?? [])];
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
