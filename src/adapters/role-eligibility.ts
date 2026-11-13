import { SUPPORTED_PEERS, definitionOf, type ProjectAdapterCatalog } from "./registry.ts";
import type { StartMode } from "../hub/start-mode.ts";

/**
 * #1408 R1, R2: who may hold a flow role, read from the adapter definition. Pure: no clock, no I/O. Init, the loader, doctor and the docs table all ask `roleEligibility`, so the answer
 * and its reason cannot drift between them.
 */
export type EligibleRole = "conductor" | "planner" | "reviewer";
export interface RoleEligibility { eligible: boolean; reason?: string; fix?: string }

type Definition = NonNullable<ReturnType<typeof definitionOf>>;
const lookup = (peer: string, catalog?: ProjectAdapterCatalog): Definition | undefined => (catalog?.definitionOf ?? definitionOf)(peer);

/**
 * Whether `peer` may hold `role` when it starts in `startMode` (undefined: the kind's own default form). A kind with no definition is not refused here: its roles are the
 * project's own and the ceiling that already applies to it stays the authority.
 */
export function roleEligibility(peer: string, role: EligibleRole, startMode?: StartMode, catalog?: ProjectAdapterCatalog): RoleEligibility {
  const definition = lookup(peer, catalog);
  if (!definition) return { eligible: true };
  const projection = definition.projection;
  if (role === "planner") return projection?.plannerEligible === true ? { eligible: true } : { eligible: false, reason: `${peer} cannot plan (its kind is not planner-eligible)`, fix: "choose a planner-eligible peer, or move the planner role" };
  if (role === "reviewer") return projection?.reviewerEligible === true ? { eligible: true } : { eligible: false, reason: `${peer} cannot receive hub_review`, fix: "choose another reviewer, or leave reviews to the person" };
  if (projection?.conductorEligible !== true) {
    return { eligible: false, reason: `${peer} cannot conduct: its kind has no interactive session that receives hub pushes and holds a writable tools connection`, fix: "move the conductor role to claude, codex, jcode or pi, or leave the project without a conductor (the person conducts from ahub console)" };
  }
  const mode = startMode ?? definition.start.defaultForm ?? (definition.start.forms.includes("tui") ? "tui" : "headless");
  if (mode === "headless") {
    return { eligible: false, reason: `${peer} starts headless, and the conductor role needs an interactive session to report to the person and ask for decisions`,
      fix: definition.start.forms.includes("tui") ? `run ahub settings set peers.${peer}.start_mode tui, or move the conductor role` : "move the conductor role to an interactive peer" };
  }
  return { eligible: true };
}

/**
 * The adapter ceiling alone, exactly as it was before #1408: roles outside `routing.allowedRoles` and a planner the kind cannot do are dropped. The at-most-one-conductor count runs on this
 * result, so a conductor the kind never allowed (agy) does not count, while one the kind allows but eligibility drops (local) still does.
 */
export function adapterCeiling(peer: string, declared: readonly string[], catalog?: ProjectAdapterCatalog): string[] {
  const definition = lookup(peer, catalog), ceiling = definition?.routing?.allowedRoles;
  return declared.filter(role => (!ceiling || ceiling.includes(role)) && (role !== "planner" || !definition || definition.projection?.plannerEligible === true));
}

/**
 * The roles a peer keeps after the ceilings. `declared` is what the config named; `allowed` is the kind's `routing.allowedRoles` ceiling when it has one. A role outside the ceiling,
 * a planner the kind cannot do, and a conductor `roleEligibility` refuses are dropped, each with one notice that names the reason and the fix. Nobody else gains a dropped role.
 */
export function applyRoleCeiling(peer: string, declared: readonly string[], startMode: StartMode | undefined, catalog?: ProjectAdapterCatalog): { roles: string[]; notices: string[] } {
  const definition = lookup(peer, catalog), ceiling = definition?.routing?.allowedRoles;
  const notices: string[] = [];
  const roles = declared.filter(role => {
    if (ceiling && !ceiling.includes(role)) return false;
    if (role === "planner" && definition && definition.projection?.plannerEligible !== true) return false;
    if (role === "conductor") {
      const verdict = roleEligibility(peer, "conductor", startMode, catalog);
      if (!verdict.eligible) { notices.push(`roles.${peer}: conductor ignored: ${verdict.reason}; ${verdict.fix}`); return false; }
    }
    return true;
  });
  // The existing notice stays for ceiling and planner drops, so every released reader of it keeps working.
  const conductorDropped = declared.includes("conductor") && !roles.includes("conductor") && notices.length > 0;
  if (roles.length !== declared.length - (conductorDropped ? 1 : 0)) notices.unshift(`roles.${peer}: ignored roles outside the adapter ceiling`);
  return { roles, notices };
}

/** One kind's row of the eligibility table: its start forms and what `roleEligibility` answers for it. */
export interface EligibilityRow {
  peer: string;
  /** The forms the kind can start in, in the definition's order. */
  forms: readonly string[];
  /** The forms in which the kind may conduct (none for a kind that cannot conduct at all). */
  conductor: readonly string[];
  planner: boolean;
  reviewer: boolean;
}

/**
 * #1408 R4: the eligibility table, one row per builtin kind, read only from `roleEligibility` so the docs table, init, the loader and doctor cannot disagree. Pure and ordered as the registry is.
 * A conductor form is judged in that form (`roleEligibility(peer, "conductor", form)`), so a kind that can conduct only interactively lists only its interactive form.
 */
export function eligibilityRows(): EligibilityRow[] {
  return SUPPORTED_PEERS.map(peer => {
    const forms = definitionOf(peer)?.start.forms ?? [];
    return {
      peer, forms: [...forms],
      conductor: forms.filter(form => roleEligibility(peer, "conductor", form).eligible),
      planner: roleEligibility(peer, "planner").eligible,
      reviewer: roleEligibility(peer, "reviewer").eligible,
    };
  });
}

const mark = (yes: boolean) => yes ? "yes" : "no";
/** The Markdown table `docs/roles.md` carries, generated from `eligibilityRows`; `test/roles-doc.test.ts` compares the document with it. */
export function renderEligibilityTable(): string {
  const header = "| Kind | Start forms | Conductor | Planner | Reviewer |\n| --- | --- | --- | --- | --- |";
  const rows = eligibilityRows().map(row => `| ${row.peer} | ${row.forms.join(", ") || "none"} | ${row.conductor.length ? row.conductor.join(", ") : "no"} | ${mark(row.planner)} | ${mark(row.reviewer)} |`);
  return [header, ...rows].join("\n");
}
