import { needs, type Needs, type NeedsInput } from "../ui/needs.ts";
export interface AttentionState {
  approvals: readonly { id: string; peer?: string; expiresAt: number }[];
  permissionDefaults: readonly { peer: string }[];
  peers: Record<string, { state?: string; attached?: boolean; needsReview?: number; heldBy?: string }>;
  budget: Record<string, { paused?: { since?: number; resetsAt?: number } }>;
  attentionMessages?: readonly { id?: string; peer?: string; important: boolean; since?: number }[];
  storageBlocked?: boolean;
  recoveryNeed?: { id?: string; running: boolean; since?: number };
}
/** Allowlisted adapter between console-owned facts and the shared body-free model. */
export function consoleNeeds(state: AttentionState, now: number): Needs {
  const input: NeedsInput = { approvals: state.approvals.map(row => ({ id: row.id, peer: row.peer, expiresAt: row.expiresAt })), defaults: state.permissionDefaults.map(row => ({ peer: row.peer })), peers: Object.fromEntries(Object.entries(state.peers).map(([peer,row]) => [peer,{ state: row.state, attached: row.attached, needsReview: row.needsReview, heldBy: row.heldBy }])), budget: Object.fromEntries(Object.entries(state.budget).map(([peer,row]) => [peer,{ ...(row.paused ? { paused: { since: row.paused.since, resetsAt: row.paused.resetsAt } } : {}) }])), messages: (state.attentionMessages ?? []).map(row => ({ id: row.id, peer: row.peer, important: row.important, since: row.since })), storageBlocked: state.storageBlocked, recovery: state.recoveryNeed };
  return needs(input, now);
}
export function attentionLine(value: Needs, now = 0, blink = false): string {
  const label = value.state === "waiting" ? `! ${value.act} need you` : value.state === "blocked" ? `! blocked (${value.act})` : value.state === "review" ? `? ${value.act} for review` : value.state === "working" ? "* working" : value.state === "idle" ? "idle" : "z asleep";
  const eyes = blink && value.items.some(item => item.kind === "approval") && Math.floor(now / 1000) % 2 ? "(- -)" : "(O O)";
  return `${eyes} ${label}${value.watch ? ` +${value.watch}` : ""}${value.items.length ? "  n next" : ""}`;
}
