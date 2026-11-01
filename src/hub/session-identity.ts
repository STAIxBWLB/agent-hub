// Distinguishable sessions, not authentication (agent-hub#1036, board #606). A connection that names a peer id but is not that id's current session is bound to an id the DAEMON mints,
// `<peer>~<origin>` (for example `claude~agent-console`), instead of becoming that peer. The id has no `@`, so it never reaches the remote-room paths (`isRemotePeerId`,
// `membershipAllowed`, `remoteEnvelope`), and `PEER_ID` is not widened: only the daemon makes these ids, and it keeps them in its own Set.
//
// What such a session may do: send, and read through the tools below. It is never a WsPeer, never receives a delivery or a push, and holds none of the peer's board roles.
//
// Limit, stated plainly: this makes sessions distinguishable and traceable. It does not authenticate them. A same-user process can always act as the user; the point is that a mix-up
// between two sessions of one person is visible in the header a recipient reads and in events.jsonl.

/** The task ops a distinct session may run: reads that need no role. Everything else is refused with `sessionRefusal`. */
export const SESSION_READ_OPS: ReadonlySet<string> = new Set([
  "hub_task_show", "hub_task_list", "hub_status", "hub_capabilities", "hub_study_show", "hub_backlog_list", "hub_release_list",
]);

/** The control messages a distinct session may send besides task ops. `task` is gated again by `SESSION_READ_OPS`. */
export const SESSION_MESSAGES: ReadonlySet<string> = new Set(["send", "status", "task"]);

const LABEL = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * A label is the other project's name or a short session id, and it ends up in a header another agent reads. It is kept only when it already IS a plain lowercase token: nothing is cleaned up into
 * one, so a path, a sentence or an instruction cannot leave a fragment of itself in a sender name. Anything else is dropped, and the hub mints a random short id instead.
 */
export function sessionLabel(value: unknown): string | undefined {
  return typeof value === "string" && LABEL.test(value) && !value.endsWith("-") ? value : undefined;
}

/** `taken(id)` says whether a live session already has the id. A second session from the same origin gets a short suffix, so no two live sessions share an id. */
export function mintSessionId(peer: string, label: unknown, taken: (id: string) => boolean, random: () => string): string {
  const base = `${peer.slice(0, 32)}~${sessionLabel(label) ?? random()}`;
  let id = base;
  for (let n = 0; taken(id) && n < 8; n++) id = `${base}-${random().slice(0, 4)}`;
  return id;
}

export const isSessionId = (id: unknown): id is string => typeof id === "string" && id.includes("~");

/** The one refusal a distinct session meets, so a person reading it learns which session it is and which one holds the role. */
export function sessionRefusal(id: string): string {
  const peer = id.slice(0, id.indexOf("~"));
  return `this session is ${id}, not this project's ${peer}: it can send and read, and holds none of ${peer}'s board roles`;
}

/** The gate the daemon applies to every message of a distinct session. Returns the refusal text, or undefined when the message may proceed. */
export function sessionGate(id: string, msg: { t?: unknown; op?: unknown }): string | undefined {
  if (typeof msg.t !== "string" || !SESSION_MESSAGES.has(msg.t)) return sessionRefusal(id);
  if (msg.t === "task" && !(typeof msg.op === "string" && SESSION_READ_OPS.has(msg.op))) return sessionRefusal(id);
  return undefined;
}
