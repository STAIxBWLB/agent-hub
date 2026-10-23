import type { AdapterDefinition } from "../adapters/registry.ts";

/**
 * Why a peer has no quota number, for the `ahub budget` block, the console detail and the dashboard (#285 AC6, AC7). A note never carries a path,
 * a session id or text from a peer's log: only the rule that applies and a count.
 */
export interface BudgetPeerNote {
  peer: string;
  /** `no-quota`: the peer has no provider quota at all. `no-reading`: it has one (or a ceiling) and nothing has been read. */
  kind: "no-quota" | "no-reading";
  note: string;
}

/** What the Kimi count can say now (`KimiUsage.status`): a reason code at most. */
export type KimiSourceState = { state: "off" | "waiting" | "counting" } | { state: "unreadable"; reason: string };

export interface BudgetNoteInput {
  /** The peers to describe: the attached ones, and any with a reading. */
  peers: readonly string[];
  /** How many windows the account of this peer has now (any kind, stale ones included: they are shown as stale, not hidden). */
  windows(peer: string): number;
  definition(peer: string): AdapterDefinition | undefined;
  /** The count of a peer whose definition keeps host-owned soft token accounting (`budget.resetSoftTokensOnResume`); today that is Kimi's wire log. */
  softTokens(): KimiSourceState | undefined;
  /** Tokens the hub counted for the peer in the last 5 h, or undefined when it has no counter. */
  hubTokens5h(peer: string): number | undefined;
}

/** `1.2M`, `340k`, `812`: a count a person reads at a glance. */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/** The line for a peer that has no windows, or undefined when its windows already say everything. */
export function budgetNote(peer: string, input: BudgetNoteInput): BudgetPeerNote | undefined {
  const definition = input.definition(peer), budget = definition?.budget;
  if (!budget) return undefined;
  const tokens = input.hubTokens5h(peer);
  const counted = tokens && tokens > 0 ? `; ${compactTokens(tokens)} tokens in 5h (hub count)` : "";
  if (budget.noQuotaReason) return { peer, kind: "no-quota", note: `no quota: ${budget.noQuotaReason}${counted}` };
  if (input.windows(peer) > 0) return undefined;
  if (budget.resetSoftTokensOnResume) {
    const kimi = input.softTokens();
    if (!kimi || kimi.state === "off") return { peer, kind: "no-reading", note: "no reading: kimi reports context occupancy only; set budget.kimi_tokens_5h to count tokens, or ahub budget set kimi <0..1>" };
    if (kimi.state === "unreadable") return { peer, kind: "no-reading", note: `no reading: kimi wire log unreadable (${kimi.reason}); the hub counts nothing it cannot read cleanly` };
    return { peer, kind: "no-reading", note: kimi.state === "waiting" ? "no reading yet: waiting for a Kimi session to count" : "no reading yet: the count starts with the next Kimi turn" };
  }
  if (budget.reader) return { peer, kind: "no-reading", note: `no reading yet: ${budget.reader.source} has not reported` };
  return { peer, kind: "no-reading", note: `no reading: ${peer} declares no quota source; ahub budget set ${peer} <0..1> feeds one by hand` };
}

export function budgetNotes(input: BudgetNoteInput): BudgetPeerNote[] {
  return input.peers.flatMap(peer => budgetNote(peer, input) ?? []);
}

/** The `ahub doctor` row for the Kimi usage source: `ok` undefined is unknown (nothing to read yet), false is a log the hub cannot trust. */
export function kimiSourceRow(state: KimiSourceState | undefined): { ok: boolean | undefined; detail: string } | undefined {
  if (!state) return undefined;
  if (state.state === "off") return { ok: undefined, detail: "no count: budget.kimi_tokens_5h is 0; Kimi shows context occupancy only" };
  if (state.state === "unreadable") return { ok: false, detail: `wire log unreadable (${state.reason}); no Kimi tokens are counted until it reads cleanly` };
  return { ok: true, detail: state.state === "waiting" ? "counting from Kimi's wire log; no Kimi session is bound yet" : "counting from Kimi's wire log (hub count, never the provider's quota)" };
}
