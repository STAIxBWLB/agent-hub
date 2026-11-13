import { roleEligibility } from "../adapters/role-eligibility.ts";
import { conductorPeer } from "../hub/conductor.ts";
import type { StartMode } from "../hub/start-mode.ts";

/**
 * #1408 R2: `ahub doctor`'s `roles` row. Pure: the caller passes what the loader settled (`roles`, after every ceiling), what the config declared before the ceilings, each peer's effective
 * start mode and the roster. A warning, never a failure, like the other advisory rows: doctor's exit code stays what it was for a project that has not looked at this yet.
 */
export interface RolesRowInput {
  /** `roles` after the loader's ceilings (what the hub holds). */
  roles: Readonly<Record<string, readonly string[]>>;
  /** The raw `roles` block of the config layers merged, before any ceiling, or undefined when none is declared. */
  declared?: Readonly<Record<string, readonly string[]>>;
  startMode: (peer: string) => StartMode | undefined;
  rostered: (peer: string) => boolean;
}
export interface RolesRow { ok: boolean | undefined; detail: string }

const holders = (roles: RolesRowInput["roles"], role: string, rostered: (peer: string) => boolean) => Object.keys(roles).filter(peer => roles[peer]!.includes(role) && rostered(peer)).sort();

export function rolesRow(input: RolesRowInput): RolesRow {
  const conductor = conductorPeer(input.roles), planners = holders(input.roles, "planner", input.rostered), reviewers = holders(input.roles, "reviewer", input.rostered);
  const warnings: string[] = [];
  // A declared conductor that the loader dropped is the case the person most needs to hear about: nobody else holds the role.
  let ignored: string | null = null;
  try { ignored = input.declared ? conductorPeer(input.declared) : null; } catch { ignored = null; }
  if (ignored && ignored !== conductor) {
    const verdict = roleEligibility(ignored, "conductor", input.startMode(ignored));
    warnings.push(`conductor ${ignored} is ignored${verdict.reason ? `: ${verdict.reason}` : ""}${verdict.fix ? `; ${verdict.fix}` : ""}`);
  }
  if (!planners.length) warnings.push("no rostered planner is eligible (the hub falls back to the first eligible rostered kind, or has none)");
  if (!reviewers.length) warnings.push("no rostered reviewer can run: reviews go to the person");
  else {
    const unfit = reviewers.filter(peer => !roleEligibility(peer, "reviewer").eligible);
    if (unfit.length) warnings.push(`${unfit.join(", ")} cannot receive hub_review`);
  }
  const text = `conductor ${conductor ?? "none (the person conducts from ahub console)"}; planner ${planners.join(", ") || "none"}; reviewer ${reviewers.join(", ") || "the person"}`;
  return warnings.length ? { ok: undefined, detail: `${text}. ${warnings.join(". ")}` } : { ok: true, detail: text };
}
