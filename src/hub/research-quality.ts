import type { StampedEvent } from "./events.ts";
import { familyOf as builtinFamilyOf } from "../adapters/registry.ts";
import { nearestRank } from "./research-record.ts";
import { latestTaskRecords, type ResearchRecord, type TaskRecord } from "./research.ts";

/**
 * #1277 (#44 AC0): the telemetry quality report that lets a dataset carry its own coverage. Everything is a count, a share or a duration over the records and the event
 * log of one window; the report holds no peer text, no model prose and no path. Peer ids are reduced to families where a family is known (the caller passes `familyOf`), and a
 * value that cannot be derived is null, never 0, so a reader can tell "no data" from "none happened".
 */
export const QUALITY_SCHEMA = "agent-hub.research-quality/v1";
/** A quota gap is a silence between two readings of one peer longer than this. */
export const QUOTA_GAP_MS = 60 * 60 * 1000;

export interface FieldCoverage { n: number; unknown: number }
export interface QuotaCoverage { readings: number; gaps: number; gapMs: number; stalenessP95Ms: number | null; clock: { event: number; measured: number } }
export interface OutcomeCounts { approved: number; cancelled: number; firstPass: number; changesRequested: number }
export interface QualityReport {
  schema: typeof QUALITY_SCHEMA;
  window: { since: string | null; until: string | null };
  records: number;
  /** Per v2 field: how many records carry a value and how many are unknown (null or absent). Blocks count per leaf. */
  fields: Record<string, FieldCoverage>;
  /** Quota readings per peer family: how many, the gaps over an hour, the 95th percentile of the time between readings, and where the reading's time came from. */
  quota: Record<string, QuotaCoverage>;
  budget: { pauses: number; resumes: number; byFamily: Record<string, { pauses: number; resumes: number }> };
  /** Task and review outcomes per (peer family, class), by the family of the task's last owner. */
  outcomes: Record<string, Record<string, OutcomeCounts>>;
  /** Every event type seen in the window with its count, and the types this report knows that did not occur. */
  events: { present: Record<string, number>; absent: string[] };
  /** The share of attributed token increments by the attribution rule (#200) and the total; null when no tokens were counted. */
  tokenAttribution: { total: number; share: Record<"delivery" | "single_open" | "unattributed", number | null> };
}

const FAMILY_FALLBACK = "unknown";
/** The event types the report reasons about: the ones whose absence in a window means something. */
export const EXPECTED_EVENTS = ["task", "tokens", "usage", "turn_end", "quota", "budget_pause", "budget_resume", "envelope", "memory_brief", "hub_start"] as const;

/** Fields counted as one value although they are objects: the findings tally is known or not as a whole. */
const WHOLE = new Set(["review.findings"]);
const leaves = (value: unknown, prefix: string, out: Map<string, unknown>): void => {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !WHOLE.has(prefix)) { for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, out); return; }
  out.set(prefix, value);
};
/** The v2 blocks whose leaves are counted; v1 fields predate the report and are not unknown by design. */
const BLOCKS = ["review", "delivery", "merge", "specs", "memory", "person", "handoffs"] as const;
const SCALARS = ["stalls", "cohort", "declines", "escalations", "cancelCause"] as const;

/** `since` and `until` are epoch ms; a record counts when its terminal time falls inside. */
export function buildResearchQuality(records: readonly ResearchRecord[], events: readonly StampedEvent[], window: { since?: number; until?: number } = {}, familyOf: (peer: string) => string | undefined = () => undefined): QualityReport {
  const from = window.since ?? 0, to = window.until ?? Infinity;
  const family = (peer: string | undefined) => (peer ? familyOf(peer) : undefined) ?? builtinFamilyOf(peer ?? "") ?? FAMILY_FALLBACK;
  const inside = (at: string | undefined | null) => { const t = at ? Date.parse(at) : NaN; return Number.isFinite(t) && t >= from && t <= to; };
  // Outcomes count every task (a v1 row is an approved one); the v2 fields are counted over v2 rows only, since a v1 row never had them.
  const tasks = latestTaskRecords(records).filter(r => inside(r.closedAt ?? r.approvedAt));
  const v2 = tasks.filter(r => r.schema === "agent-hub.research/v2");
  const fields: Record<string, FieldCoverage> = {};
  /** Unknown is null, absent, or a closed vocabulary's own `unknown` member. */
  const note = (name: string, value: unknown) => { const f = fields[name] ??= { n: 0, unknown: 0 }; f.n++; if (value === null || value === undefined || value === "unknown") f.unknown++; };
  for (const r of v2) {
    const seen = new Map<string, unknown>();
    for (const block of BLOCKS) leaves((r as unknown as Record<string, unknown>)[block] ?? null, block, seen);
    // A block that is absent from the record counts as unknown at its own name.
    for (const block of BLOCKS) if (![...seen.keys()].some(k => k.startsWith(`${block}.`) || k === block)) seen.set(block, null);
    for (const key of SCALARS) seen.set(key, (r as unknown as Record<string, unknown>)[key] ?? (key === "cancelCause" && r.outcome !== "cancelled" ? undefined : null));
    for (const [name, value] of seen) {
      if (name === "cancelCause" && r.outcome !== "cancelled") continue;
      note(name, value);
    }
  }
  const windowEvents = events.filter(e => { const t = Date.parse(e.at); return Number.isFinite(t) && t >= from && t <= to; });
  const present: Record<string, number> = {};
  const quota: Record<string, { times: number[]; measured: number; event: number }> = {};
  const budget = { pauses: 0, resumes: 0, byFamily: {} as Record<string, { pauses: number; resumes: number }> };
  const attribution: Record<string, number> = { delivery: 0, single_open: 0, unattributed: 0 };
  let tokenTotal = 0;
  for (const e of windowEvents) {
    present[e.type] = (present[e.type] ?? 0) + 1;
    if (e.type === "quota") {
      const fam = family(e.peer), q = quota[fam] ??= { times: [], measured: 0, event: 0 };
      const measured = typeof e.measuredAt === "string" ? Date.parse(e.measuredAt) : NaN;
      if (Number.isFinite(measured)) { q.measured++; q.times.push(measured); } else { q.event++; q.times.push(Date.parse(e.at)); }
    } else if (e.type === "budget_pause" || e.type === "budget_resume") {
      const fam = family(e.peer), row = budget.byFamily[fam] ??= { pauses: 0, resumes: 0 };
      if (e.type === "budget_pause") { budget.pauses++; row.pauses++; } else { budget.resumes++; row.resumes++; }
    } else if (e.type === "tokens" && Number.isFinite(e.n) && e.n > 0) {
      tokenTotal += e.n; const rule = e.attribution === "delivery" || e.attribution === "single_open" ? e.attribution : "unattributed"; attribution[rule]! += e.n;
    }
  }
  const quotaOut: Record<string, QuotaCoverage> = {};
  for (const [fam, q] of Object.entries(quota)) {
    const times = q.times.filter(Number.isFinite).sort((a, b) => a - b), gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
    const over = gaps.filter(g => g > QUOTA_GAP_MS);
    quotaOut[fam] = { readings: times.length, gaps: over.length, gapMs: over.reduce((sum, g) => sum + g, 0), stalenessP95Ms: nearestRank(gaps, 0.95), clock: { event: q.event, measured: q.measured } };
  }
  const outcomes: QualityReport["outcomes"] = {};
  for (const r of tasks) {
    const fam = family(r.owners.at(-1)), cls = r.class ?? "unknown", row = (outcomes[fam] ??= {})[cls] ??= { approved: 0, cancelled: 0, firstPass: 0, changesRequested: 0 };
    row[r.outcome]++; if (r.firstPass) row.firstPass++; row.changesRequested += r.changesRequested;
  }
  const share = (n: number): number | null => tokenTotal > 0 ? n / tokenTotal : null;
  return {
    schema: QUALITY_SCHEMA,
    window: { since: window.since !== undefined ? new Date(window.since).toISOString() : null, until: window.until !== undefined && Number.isFinite(window.until) ? new Date(window.until).toISOString() : null },
    records: tasks.length, fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
    quota: Object.fromEntries(Object.entries(quotaOut).sort(([a], [b]) => a.localeCompare(b))), budget, outcomes,
    events: { present: Object.fromEntries(Object.entries(present).sort(([a], [b]) => a.localeCompare(b))), absent: EXPECTED_EVENTS.filter(type => !(type in present)) },
    tokenAttribution: { total: tokenTotal, share: { delivery: share(attribution.delivery!), single_open: share(attribution.single_open!), unattributed: share(attribution.unattributed!) } },
  };
}
