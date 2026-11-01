// The named refusal for a connection that names a native peer id without that peer's own launch (#604 PR B item 9, agent-hub#1030). One text, so the daemon's two admissions and the
// plugin's explanation say the same thing, and a person reading a refusal learns the sanctioned route.
//
// Limit, stated plainly: this stops accidental and inherited-environment joins; not a same-user process that reads the launch record.
export const ownPeerRefusal = (peer: string): string =>
  `peer id ${peer.slice(0, 64)} belongs to this project's own launch; another project's session hands work over with hub_task_handoff`;
