import { SUPPORTED_PEERS, definitionOf } from "../adapters/registry.ts";

/**
 * #608 (agent-hub#1040): the agents `ahub up` asks the hub to start, `start.agents`. Pure and free of file-system
 * imports: the config schema (`config-apply.ts`) reaches the Claude channel bundle. The list is read by the CLI at a
 * person's `ahub up` and by the dashboard manager's start; the daemon never reads it, so a restart, a crash recovery,
 * a reload or an upgrade relaunch starts nothing from it.
 *
 * Which kinds may be listed, which are in the default set and why a kind is refused all come from the kind's own
 * `AdapterDefinition.start.upStart` (#451): nothing here names a peer.
 */
const upStart = (id: string) => definitionOf(id)?.start.upStart;

/** The kinds in the default set, in the registry's order. */
export const START_AGENTS_DEFAULT: readonly string[] = Object.freeze(SUPPORTED_PEERS.filter(peer => { const s = upStart(peer); return s?.allowed === true && s.default === true; }));
export const START_AGENTS_MAX = 8;
const PEER = /^[a-z][a-z0-9-]{0,31}$/;

/** The kinds `ahub up` may start. A declared instance, a channel extra and an unknown id are never in it. */
export const START_AGENTS_ALLOWED: readonly string[] = Object.freeze(SUPPORTED_PEERS.filter(peer => definitionOf(peer)?.start.conductorStartable === true && upStart(peer)?.allowed === true));

/** Why `id` cannot be in the start set, or undefined. The reason never repeats the id unless it is a well-formed peer id. */
export function startAgentRefusal(id: unknown): string | undefined {
  if (typeof id !== "string" || !PEER.test(id)) return "an entry is not a peer id (lowercase letters, digits and dashes)";
  if (START_AGENTS_ALLOWED.includes(id)) return undefined;
  const own = upStart(id);
  if (own?.allowed === false) return `${id} cannot be started by ahub up: ${own.refusal}`;
  if (SUPPORTED_PEERS.includes(id)) return `${id} cannot be started by ahub up: the hub does not start it; run ahub ${id} in a terminal`;
  return `${id} cannot be started by ahub up: it is a declared instance, a channel extra or unknown, and only ${START_AGENTS_ALLOWED.join(", ")} are started by the hub`;
}

/** The checked list (a copy), or a thrown reason. An empty list is allowed and starts nothing. */
export function checkStartAgents(raw: unknown, key = "start.agents"): string[] {
  if (!Array.isArray(raw) || raw.length > START_AGENTS_MAX) throw new Error(`${key} takes a list of up to ${START_AGENTS_MAX} peer ids (an empty list starts none)`);
  for (const id of raw) { const why = startAgentRefusal(id); if (why) throw new Error(`${key}: ${why}`); }
  if (new Set(raw).size !== raw.length) throw new Error(`${key} takes distinct peer ids`);
  return [...raw] as string[];
}

/** A person's text for the list: commas or spaces between ids, `none` for an empty list. */
export function parseStartAgents(text: string): string[] {
  const words = text.split(/[\s,]+/).filter(Boolean);
  return checkStartAgents(words.length === 1 && words[0] === "none" ? [] : words);
}
