// The named refusal for a connection that names a native peer id without that peer's own launch (#604 PR B item 9, agent-hub#1030). One text, so the daemon's two admissions and the
// plugin's explanation say the same thing, and a person reading a refusal learns the sanctioned route.
//
// Limit, stated plainly: this stops accidental and inherited-environment joins; not a same-user process that reads the launch record.
// A WebSocket close reason is capped at 123 bytes: a peer id is at most 32 characters, so the longest text is 115 bytes and nothing may be appended to it.
export const ownPeerRefusal = (peer: string): string =>
  `peer id ${peer.slice(0, 32)} is not an owned launch of this project; other projects use hub_task_handoff`;
