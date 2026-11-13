/**
 * #1408 T2 (R3): who conducts, plans and reviews, chosen at `ahub init`. Three independent choices, each one flag and one guided question:
 *
 *   --conductor <peer>|none        --planner <peer>[,<peer>...]        --reviewer <peer>[,<peer>...]|person
 *
 * Pure: no file is read or written. `parseRoleFlag` checks a flag's shape; `planRoles` takes the parsed shared and local config and returns the `roles` entries that change, or throws the
 * refusal (the reason from `roleEligibility` and the eligible alternatives) before anything is written. Only conductor, planner and reviewer move: implementer, verifier and every catalog
 * role stay as they are. A peer whose roles change is written as one explicit list, including the peer that loses a role, because `roles` merges per peer and a missing entry keeps the default.
 */
import { SUPPORTED_PEERS, defaultPeerRoles, definitionOf } from "../adapters/registry.ts";
import { roleEligibility, type EligibleRole } from "../adapters/role-eligibility.ts";
import { START_MODES, type StartMode } from "../hub/start-mode.ts";

export const ROLE_FLAGS = { "--conductor": "conductor", "--planner": "planner", "--reviewer": "reviewer" } as const satisfies Record<string, EligibleRole>;
export type RoleFlag = keyof typeof ROLE_FLAGS;
/** The request keys the three choices use in `InitSettingsRequest.values`. */
export const ROLE_KEYS = ["roles.conductor", "roles.planner", "roles.reviewer"] as const;
export type RoleKey = typeof ROLE_KEYS[number];
export const roleKeyOf = (role: EligibleRole): RoleKey => `roles.${role}`;

/** `none` as the conductor and `person` as the reviewer are choices, not peers: the person conducts from `ahub console`, and reviews go to the person. */
export const NO_CONDUCTOR = "none", PERSON_REVIEWS = "person";
/** The value of a choice: a peer or `none` (conductor), a list of peers (planner), a list of peers or `person` (reviewer). */
export type RoleChoice = string | string[];

/** The most planners a project can name; the loader refuses a longer `planner` list. */
const MAX_PLANNERS = 8;
/** What a flag accepts, for a refusal and for help. */
export const ROLE_ALLOWED: Record<RoleFlag, string> = {
  "--conductor": "a peer or none",
  "--planner": "a peer, or a comma-separated list of peers",
  "--reviewer": "a peer, a comma-separated list of peers, or person",
};
const CANONICAL = ["planner", "implementer", "verifier", "reviewer", "conductor"] as const;
const nothing = "nothing was written";

const isPeer = (word: string) => (SUPPORTED_PEERS as readonly string[]).includes(word);
const clip = (text: string) => JSON.stringify(text.slice(0, 48));

/** A flag's text into its choice, or a refusal that names what is accepted. The eligibility of a peer is judged by `planRoles`, which sees the files. */
export function parseRoleFlag(flag: RoleFlag, text: string): RoleChoice {
  const words = text.split(/[\s,]+/).map(word => word.trim().toLowerCase()).filter(Boolean);
  const allowed = `${flag} takes ${ROLE_ALLOWED[flag]}; peers are ${SUPPORTED_PEERS.join(", ")}`;
  if (!words.length) throw new Error(`${flag} needs a value: ${allowed}; ${nothing}`);
  if (flag === "--conductor") {
    if (words.length !== 1) throw new Error(`${flag}: at most one conductor; ${allowed}; ${nothing}`);
    if (words[0] === NO_CONDUCTOR || isPeer(words[0]!)) return words[0]!;
    throw new Error(`${flag}: ${clip(text)} is not a peer or none; ${allowed}; ${nothing}`);
  }
  if (flag === "--reviewer" && words.includes(PERSON_REVIEWS)) {
    if (words.length !== 1) throw new Error(`${flag}: person stands alone (reviews go to the person); name peers or person, not both; ${nothing}`);
    return PERSON_REVIEWS;
  }
  const unknown = words.find(word => !isPeer(word));
  if (unknown !== undefined) throw new Error(`${flag}: ${clip(unknown)} is not a peer; ${allowed}; ${nothing}`);
  if (new Set(words).size !== words.length) throw new Error(`${flag}: a peer is named twice; ${nothing}`);
  if (flag === "--planner" && words.length > MAX_PLANNERS) throw new Error(`${flag}: at most ${MAX_PLANNERS} planners; ${nothing}`);
  return words;
}

/** The peers `role` may go to, given each peer's start mode (`undefined`: the kind's own default form). Installed agents come first, each group in registry order. */
export function eligiblePeers(role: EligibleRole, startMode: (peer: string) => StartMode | undefined = () => undefined, installed: readonly string[] = []): string[] {
  const ok = SUPPORTED_PEERS.filter(peer => roleEligibility(peer, role, startMode(peer)).eligible);
  return [...ok.filter(peer => installed.includes(peer)), ...ok.filter(peer => !installed.includes(peer))];
}

/** The peers whose agent CLI is on PATH, by the command each adapter definition names. A hub-owned peer (the local worker, `trust.onPrem`) runs inside the hub and needs no CLI. */
export function installedPeers(which: (binary: string) => string | null | undefined = binary => Bun.which(binary)): string[] {
  return SUPPORTED_PEERS.filter(peer => {
    const definition = definitionOf(peer);
    return definition?.trust.onPrem === true || (!!definition && !!which(definition.cli.command));
  });
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const listOf = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? [...value] : undefined;
/** The effective start mode of a peer in the two files: `config.local.json` wins over the shared file, as the loader reads them. */
export function startModeIn(peer: string, shared: Record<string, unknown>, local: Record<string, unknown>): StartMode | undefined {
  for (const doc of [local, shared]) {
    const mode = isObject(doc.peers) && isObject(doc.peers[peer]) ? (doc.peers[peer] as { start_mode?: unknown }).start_mode : undefined;
    if ((START_MODES as readonly unknown[]).includes(mode)) return mode as StartMode;
  }
  return undefined;
}
/** The roles a peer holds now: its entry in the shared file, else the adapter default (a peer left out of `roles` keeps its default). */
export function effectiveRoles(peer: string, shared: Record<string, unknown>): string[] {
  return (isObject(shared.roles) ? listOf(shared.roles[peer]) : undefined) ?? defaultPeerRoles(true)[peer] ?? [];
}

export interface RoleChange { peer: string; from: string[]; to: string[] }

/** The refusal for a peer that cannot take the role: the reason and fix from `roleEligibility`, and who can. */
function refusal(flag: RoleFlag, peer: string, role: EligibleRole, startMode: StartMode | undefined, alternatives: readonly string[]): Error {
  const verdict = roleEligibility(peer, role, startMode);
  const others = alternatives.length ? `eligible: ${alternatives.join(", ")}` : `no peer can hold ${role} here`;
  return new Error(`${flag} ${peer}: ${verdict.reason}; ${verdict.fix}; ${others}; ${nothing}`);
}

/**
 * The `roles` entries the choices change, given the parsed shared and local config. A choice that is not given changes nothing; one that already holds changes nothing. Refuses, before any write:
 * a peer that cannot hold the role (its reason, its fix and the eligible peers), a peer whose roles `config.local.json` overrides (the shared write would not take effect), and a planner choice
 * while a `planner` setting is present (it outranks the roles).
 */
export function planRoles(choices: Partial<Record<RoleKey, unknown>>, shared: Record<string, unknown>, local: Record<string, unknown>): RoleChange[] {
  const startMode = (peer: string) => startModeIn(peer, shared, local);
  const peers = new Set<string>([...SUPPORTED_PEERS, ...(isObject(shared.roles) ? Object.keys(shared.roles) : [])]);
  const held = new Map<string, Set<string>>([...peers].map(peer => [peer, new Set(effectiveRoles(peer, shared))]));
  const give = (role: EligibleRole, to: readonly string[]) => {
    for (const roles of held.values()) roles.delete(role);
    for (const peer of to) (held.get(peer) ?? held.set(peer, new Set()).get(peer)!).add(role);
  };
  const check = (flag: RoleFlag, role: EligibleRole, named: readonly string[]) => {
    for (const peer of named) if (!roleEligibility(peer, role, startMode(peer)).eligible) throw refusal(flag, peer, role, startMode(peer), eligiblePeers(role, startMode));
  };
  const conductor = choices["roles.conductor"], planner = choices["roles.planner"], reviewer = choices["roles.reviewer"];
  if (conductor !== undefined) {
    const named = conductor === NO_CONDUCTOR ? [] : [String(conductor)];
    check("--conductor", "conductor", named);
    give("conductor", named);
  }
  if (planner !== undefined) {
    const named = planner as string[];
    check("--planner", "planner", named);
    if (shared.planner !== undefined || local.planner !== undefined) throw new Error(`--planner: a planner setting is present in .agenthub/config.json or config.local.json and outranks roles; remove that key (or set it with ahub settings set planner), then run ahub init again; ${nothing}`);
    give("planner", named);
  }
  if (reviewer !== undefined) {
    const named = reviewer === PERSON_REVIEWS ? [] : reviewer as string[];
    check("--reviewer", "reviewer", named);
    give("reviewer", named);
  }
  const rank = (role: string) => { const at = CANONICAL.indexOf(role as typeof CANONICAL[number]); return at === -1 ? CANONICAL.length : at; };
  const changes: RoleChange[] = [];
  for (const [peer, roles] of held) {
    const from = effectiveRoles(peer, shared);
    // The roles the peer keeps stay in the order the file has them; a role it gains follows, in the canonical order.
    const to = [...from.filter(role => roles.has(role)), ...[...roles].filter(role => !from.includes(role)).sort((a, b) => rank(a) - rank(b))];
    if (to.length === from.length && to.every(role => from.includes(role))) continue;
    changes.push({ peer, from, to });
  }
  const overridden = isObject(local.roles) ? changes.filter(change => Object.hasOwn(local.roles as object, change.peer)) : [];
  if (overridden.length) throw new Error(`config.local.json roles.${overridden[0]!.peer} overrides the shared roles for ${overridden[0]!.peer}, so the choice would not take effect; change it there (or remove that entry), then run ahub init again; ${nothing}`);
  return changes;
}

/** What each choice means, in the words of the init summary. Printed after the writes, and for a choice that changed nothing too. */
export function roleSummaryLines(choices: Partial<Record<RoleKey, unknown>>): string[] {
  const lines: string[] = [];
  const conductor = choices["roles.conductor"], planner = choices["roles.planner"], reviewer = choices["roles.reviewer"];
  if (conductor === NO_CONDUCTOR) lines.push("- Conductor: none. You conduct from ahub console.");
  else if (typeof conductor === "string") lines.push(`- Conductor: ${conductor}. It must run interactively; ahub doctor shows who holds each role.`);
  if (Array.isArray(planner)) lines.push(`- Planner: ${planner.join(", ")}.`);
  if (reviewer === PERSON_REVIEWS) lines.push("- Reviewer: person. No peer holds the reviewer role, so reviews go to you.");
  else if (Array.isArray(reviewer)) lines.push(`- Reviewer: ${reviewer.join(", ")}.`);
  return lines;
}
