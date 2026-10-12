import { needs, type Needs, type NeedsInput, type NeedItem } from "../ui/needs.ts";
export interface AttentionState {
  approvals: readonly { id: string; peer?: string; expiresAt: number }[];
  permissionDefaults: readonly { peer: string }[];
  peers: Record<string, { state?: string; attached?: boolean; needsReview?: number; heldBy?: string }>;
  budget: Record<string, { paused?: { since?: number; resetsAt?: number } }>;
  attentionMessages?: readonly { id?: string; peer?: string; important: boolean; since?: number }[];
  storageBlocked?: boolean;
  recoveryNeed?: { id?: string; running: boolean; since?: number };
  queue?: readonly { id: string; peer?: string; state: string }[];
  attentionFacts?: { kind: "review" | "offline"; id: number; peer?: string }[];
}
/** Allowlisted adapter between console-owned facts and the shared body-free model. */
export function consoleNeeds(state: AttentionState, now: number): Needs {
  const input: NeedsInput = { approvals: state.approvals.map(row => ({ id: row.id, peer: row.peer, expiresAt: row.expiresAt })), defaults: state.permissionDefaults.map(row => ({ peer: row.peer })), peers: Object.fromEntries(Object.entries(state.peers).map(([peer,row]) => [peer,{ state: row.state, attached: row.attached, needsReview: row.needsReview, heldBy: row.heldBy }])), budget: Object.fromEntries(Object.entries(state.budget).map(([peer,row]) => [peer,{ ...(row.paused ? { paused: { since: row.paused.since, resetsAt: row.paused.resetsAt } } : {}) }])), messages: (state.attentionMessages ?? []).map(row => ({ id: row.id, peer: row.peer, important: row.important, since: row.since })), storageBlocked: state.storageBlocked, recovery: state.recoveryNeed };
  const result = needs({ ...input, facts: state.attentionFacts }, now);
  // Panel snapshots know each held row; enrich only ids, without changing the status-derived count.
  const used = new Set<string | number>();
  for (const item of result.items) if (item.kind === "delivery") {
    const eligible = (row: { id: string; peer?: string; state: string }) => row.state === "needs_review" && row.peer === item.peer && !used.has(row.id) && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.id);
    const row = state.queue?.find(row => row.id === item.id && eligible(row)) ?? state.queue?.find(eligible);
    if (row) { item.id = row.id; used.add(row.id); }
    else if (item.id !== undefined) used.add(item.id);
  }
  return result;
}
export function attentionLine(value: Needs, now = 0, blink = false): string {
  const label = value.state === "waiting" ? `! ${value.act} need you` : value.state === "blocked" ? `! blocked (${value.act})` : value.state === "review" ? `? ${value.act} for review` : value.state === "working" ? "* working" : value.state === "idle" ? "idle" : "z asleep";
  const eyes = blink && value.items.some(item => item.kind === "approval") && Math.floor(now / 1000) % 2 ? "(- -)" : "(O O)";
  return `${eyes} ${label}${value.watch ? ` +${value.watch}` : ""}${value.items.length ? "  n next" : ""}`;
}

/** Accept only body-free board facts from the authenticated status reply. */
export function attentionFacts(raw: unknown): NonNullable<AttentionState["attentionFacts"]> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap<NonNullable<AttentionState["attentionFacts"]>[number]>(row => {
    if (!row || typeof row !== "object" || !Number.isSafeInteger(row.id) || row.id < 1) return [];
    if (row.kind === "review" && row.level === "act") return [{ kind: "review" as const, id: row.id }];
    if (row.kind === "offline" && row.level === "watch" && typeof row.peer === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(row.peer)) return [{ kind: "offline" as const, id: row.id, peer: row.peer }];
    return [];
  });
}

export function attentionCommand(item: NeedItem): string {
  if (item.kind === "delivery") return `ahub queue list${item.id ? `; ahub queue show ${item.id}` : ""}`;
  if (item.kind === "review") return `ahub task show ${item.id}; ahub review ${item.id} approved|changes_requested`;
  if (item.kind === "offline") return `ahub status; ahub task show ${item.id}; ahub task assign ${item.id} <peer>`;
  if (item.kind === "storage") return "ahub doctor";
  if (item.kind === "recovery") return `ahub recovery status${item.id ? ` ${item.id}` : ""}`;
  if (item.kind === "budget") return "ahub budget";
  if (item.kind === "default") return "ahub permission";
  return item.peer ? `ahub say @${item.peer} <message>` : "ahub console";
}
