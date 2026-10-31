// Sender provenance (#604 PR B, agent-hub#1030 item 11). Pure: a connection's identity fields in, a bounded record out. The record names the sending connection by role, bound peer
// and launch or instance id, and nothing else: never a path, a cwd, a project root, a message body or a token. Two sessions that both claim `claude` stay distinguishable in
// events.jsonl because their launch ids differ, and an envelope can be traced to the connection that sent it.
/** `instanceId` is a declared extra instance's id when the connection is one. It is never the hub run's own id, which is the same for every connection and so distinguishes none. */
export interface ConnectionIdentity { role?: "peer" | "console" | "tools"; peer?: string; launchId?: string; instanceId?: string }
export type Origin = { role: "peer" | "console" | "tools" | "hub"; peer?: string; launch?: string; instance?: string };

/** An id the hub itself minted (a UUID or a short token). Anything else, or anything long, is dropped rather than copied: the field is evidence, not a channel for caller text. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const idOf = (value: unknown): string | undefined => typeof value === "string" && ID.test(value) ? value : undefined;
const PEER = /^[a-z][a-z0-9_-]{0,63}$/;

/** `undefined` identity is the hub's own writer (a task flow, a notice): it is `hub`, not a connection. */
export function originOf(identity: ConnectionIdentity | undefined): Origin {
  if (!identity?.role) return { role: "hub" };
  const peer = typeof identity.peer === "string" && PEER.test(identity.peer) ? identity.peer : undefined;
  const launch = idOf(identity.launchId), instance = idOf(identity.instanceId);
  return { role: identity.role, ...(peer ? { peer } : {}), ...(launch ? { launch } : {}), ...(instance ? { instance } : {}) };
}

/** The one `attach` event a peer or tools hello writes, and the shape an envelope event embeds as `origin`. */
export function attachEvent(identity: ConnectionIdentity): { type: "attach" } & Origin {
  return { type: "attach", ...originOf(identity) };
}

/** Whether two origins name the same connection identity: the same role, peer and launch. A connection with no launch id never equals one that has it. */
export function sameOrigin(a: Origin, b: Origin): boolean {
  return a.role === b.role && a.peer === b.peer && a.launch === b.launch && a.instance === b.instance;
}
