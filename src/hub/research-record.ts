import { existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFigures } from "./research-memory.ts";
import type { PersonFigures } from "./person-figures.ts";
import { cleanMergeCost } from "./cost-governance.ts";
import { openHubDatabase } from "./db-schema.ts";
import { taskSample, type MetricTask } from "./sdlc-metrics.ts";

/**
 * #1277: the closed, text-free blocks research record v2 adds to a task record, and the evidence they are folded from.
 * Everything here is a count, a duration, a boolean or a member of a closed vocabulary. A value that cannot be derived is `null`
 * and is counted as unknown by the quality report, never 0. Nothing is copied from a title, note, path, rationale, message body or
 * check output: the readers below pick named closed fields out of the board history and the delivery journal and drop the rest.
 */
export const FINDING_PASSES = ["bugs", "security", "compliance"] as const;
export type FindingPass = (typeof FINDING_PASSES)[number];
const SEVERITIES = ["important", "nit"] as const;
const DISPOSITIONS = ["open", "fixed", "false_positive", "accepted"] as const;
const PLANNED_SCOPES = ["none", "delta", "full"] as const;
/** A peer family or any other id-like value from a store: anything else is untrusted text and reads as unknown. */
const ID = /^[a-z][a-z0-9-]{0,63}$/;
export const closedId = (value: unknown): string | null => typeof value === "string" && ID.test(value) ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const member = <T extends string>(values: readonly T[], value: unknown): T | undefined => (values as readonly string[]).includes(value as string) ? value as T : undefined;

export interface FindingTally { important: number; nit: number; open: number; fixed: number; falsePositive: number; accepted: number }
export type ReviewScope = "code" | "full" | "delta" | "none" | "unknown";
export interface ReviewBlock {
  /** Substantive verdicts: approvals and change requests that are not evidence-only. (`reviewRounds` on the record counts times the task went to review; this counts what came back.) */
  rounds: number | null;
  firstPass: boolean | null;
  /** Distinct findings by pass, each at its last disposition; null when no verdict carried a structured report. */
  findings: Record<FindingPass, FindingTally> | null;
  reviewerFamily: string | null;
  ownerFamily: string | null;
  scope: ReviewScope;
  evidenceOnly: number | null;
  context: "fresh" | "continuing" | "unknown";
  staleHeadReReviews: number | null;
}
export interface Quantiles { p50: number | null; p95: number | null }
export interface DeliveryBlock {
  /** Envelopes that named the task, from the events. */
  count: number | null;
  firstDeliveryMs: Quantiles;
  needsReview: number | null; failed: number | null; discarded: number | null;
  dropped: { fyi: number | null; hop: number | null };
}
export interface MergeBlock { ciRuns: number | null; ciReruns: number | null; githubReviews: number | null; doneToApprovedMs: number | null; approvedToMergedMs: number | null }
export interface SpecsBlock { covering: number | null; unchanged: number | null; acked: number | null; errors: number | null }
/** `rendered`, `delivered` and `cited` stay null until #1279 reports them. */
export interface MemoryBlock {
  briefs: number | null; briefNotes: number | null; fails: number | null; rendered: number | null; delivered: number | null; cited: number | null;
  /** #1279: fail notes among the entries rendered for the task, how many of them were cited, and the exposed ones the plan touches that were not cited. A signal to read, never an outcome. */
  failsExposed: number | null; failsCited: number | null; failRetrySignal: number | null;
}
/** #1278: what the person was asked and did for the task (docs/research.md); every part is null when the log does not cover the task, never 0. Shape and rules: `src/hub/person-figures.ts`. */
export type PersonBlock = PersonFigures;
export interface HandoffsBlock { in: number | null; out: number | null }
export type CohortKind = "silent" | "advisory" | "none";
export const CANCEL_CAUSES = ["cancelled", "declined", "escalated", "stale", "unknown"] as const;
export type CancelCause = (typeof CANCEL_CAUSES)[number];

/** One board history entry, reduced to the closed fields v2 reads. */
export interface EvidenceEntry {
  at: number; event: string;
  evidenceOnly?: true; withheld?: true; sweep?: true;
  reviewScope?: "code"; reviewContext?: "fresh" | "continuing"; reviewerFamily?: string;
  requestHead?: string; verdictHead?: string; plannedScope?: (typeof PLANNED_SCOPES)[number];
  findings?: { id: string; pass: FindingPass; severity: "important" | "nit"; disposition: (typeof DISPOSITIONS)[number] }[];
  spec?: { complete: boolean; errors: number; unchanged: number; changed: number; acked: number };
  /** An explicit closed cause recorded on a cancellation, never inferred from its note. */
  cause?: CancelCause;
}
export interface EvidenceMerge { mergedAt: number | null; ciRuns: number | null; ciReruns: number | null; reviews: number | null }
export interface EvidenceTask { id: number; history: EvidenceEntry[]; merge?: EvidenceMerge; handoffs?: { in: number; out: number } }
export interface JournalRow { task: number; state: string; createdAt: number; updatedAt: number }
export interface ResearchEvidence {
  tasks: ReadonlyMap<number, EvidenceTask>;
  /** Absent: the journal was not read, so every journal-derived field is unknown. */
  /**
   * `coveredAfter`: a delivery created strictly after this time is in `rows` if it ever existed; null when that cannot be established. The journal prunes its oldest-updated terminal rows beyond a
   * cap and keeps unresolved rows, review-package receipts and retry parents, so the oldest surviving row is no watermark (an old protected row survives while newer ones are gone).
   */
  journal?: { rows: readonly JournalRow[]; coveredAfter: number | null };
  /** Whether the board was read at all: without it every board-derived field is unknown, also for a task the map lacks. */
  board: boolean;
  familyOf?: (peer: string) => string | undefined;
  /** #1279: the counter figures of one task from agent-mem's sidecar; absent (backfill, no sidecar) leaves every counter figure unknown. */
  memory?: (task: number) => MemoryFigures;
}
export const NO_EVIDENCE: ResearchEvidence = { tasks: new Map(), board: false };

const text = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The closed cause a cancelled entry carries, or none. Only an exact member of `CANCEL_CAUSES` in a `cause` field counts. Today the board retains no such field (`Tasks.cancel` stores a free-text note and
 * nothing closed), so every cancelled record reads `unknown`; a cause is never inferred from the note, from an earlier decline or escalation, or from who cancelled (ruling 2026-11-07 on #778).
 */
export function cancelCauseOf(raw: unknown): CancelCause | undefined {
  const cause = text(raw)?.cause;
  return typeof cause === "string" && (CANCEL_CAUSES as readonly string[]).includes(cause) && cause !== "unknown" ? cause as CancelCause : undefined;
}

/** One history entry (a `HistoryEntry` or its parsed JSON) as closed evidence; undefined when it has no usable time or event. */
export function evidenceEntry(raw: unknown): EvidenceEntry | undefined {
  const e = text(raw);
  if (!e || typeof e.at !== "number" || !Number.isFinite(e.at) || e.at < 0 || typeof e.event !== "string" || e.event.length > 80) return undefined;
  const out: EvidenceEntry = { at: e.at, event: e.event };
  if (e.evidenceOnly === true) out.evidenceOnly = true;
  if (e.withheld === true) out.withheld = true;
  if (text(e.sweep)) out.sweep = true;
  if (e.reviewScope === "code") out.reviewScope = "code";
  if (e.reviewContext === "fresh" || e.reviewContext === "continuing") out.reviewContext = e.reviewContext;
  const family = closedId(e.reviewerFamily);
  if (family) out.reviewerFamily = family;
  const cost = text(e.reviewCost), findings = text(e.reviewFindings);
  if (typeof cost?.head === "string" && /^[0-9a-f]{40}$/.test(cost.head)) out.requestHead = cost.head;
  const planned = member(PLANNED_SCOPES, text(cost?.review)?.scope);
  if (planned) out.plannedScope = planned;
  if (typeof findings?.head === "string" && /^[0-9a-f]{40}$/.test(findings.head)) out.verdictHead = findings.head;
  if (Array.isArray(findings?.items)) {
    out.findings = (findings.items as unknown[]).flatMap(item => {
      const f = text(item), pass = member(FINDING_PASSES, f?.pass), severity = member(SEVERITIES, f?.severity), disposition = member(DISPOSITIONS, f?.disposition);
      return f && typeof f.id === "string" && f.id.length <= 96 && pass && severity && disposition ? [{ id: f.id, pass, severity, disposition }] : [];
    });
  }
  const spec = text(e.specReport);
  if (spec) {
    const list = (value: unknown) => Array.isArray(value) ? value.map(text).filter((row): row is Record<string, unknown> => !!row) : [];
    const unchanged = list(spec.unchanged), changed = list(spec.changed);
    out.spec = { complete: spec.complete === true, errors: count(spec.errors) ?? 0, unchanged: unchanged.length, changed: changed.length,
      acked: unchanged.filter(row => typeof row.reason === "string" && row.reason.length > 0).length };
  }
  const cause = e.event === "cancelled" ? cancelCauseOf(e) : undefined;
  if (cause) out.cause = cause;
  return out;
}

/** A board task (live `Task` or a parsed row) as closed evidence. The title, detail, plan, refs and every note stay behind. */
export function evidenceTask(raw: { id: number; history?: unknown; sdlc?: unknown }, handoffs?: { in: number; out: number }): EvidenceTask {
  const history = (Array.isArray(raw.history) ? raw.history : []).flatMap(entry => { const e = evidenceEntry(entry); return e ? [e] : []; }).sort((a, b) => a.at - b.at);
  const merge = text(text(raw.sdlc)?.merge);
  let mergeEvidence: EvidenceMerge | undefined;
  if (merge?.state === "merged") {
    const cost = cleanMergeCost(merge.cost), at = cost?.mergedAt ?? (typeof merge.at === "number" && Number.isSafeInteger(merge.at) ? merge.at : null);
    mergeEvidence = { mergedAt: at, ciRuns: cost?.ciRuns ?? null, ciReruns: cost?.ciReruns ?? null, reviews: cost?.reviews ?? null };
  }
  return { id: raw.id, history, ...(mergeEvidence ? { merge: mergeEvidence } : {}), ...(handoffs ? { handoffs } : {}) };
}

/** Deliveries of one task from the journal rows: only their state and two times, never an envelope body. */
export function journalRow(task: unknown, state: unknown, createdAt: unknown, updatedAt: unknown): JournalRow | undefined {
  const id = typeof task === "string" && /^[1-9]\d{0,9}$/.test(task) ? Number(task) : typeof task === "number" && Number.isSafeInteger(task) && task > 0 ? task : undefined;
  return id !== undefined && typeof state === "string" && ID.test(state.replaceAll("_", "-")) && typeof createdAt === "number" && typeof updatedAt === "number" && Number.isFinite(createdAt) && Number.isFinite(updatedAt)
    ? { task: id, state, createdAt, updatedAt } : undefined;
}

/**
 * The board and journal of one project, read without writing: `hub.db` opens read-only through the same compatibility check the hub uses, and the journal's envelope bodies are
 * never decoded (SQLite hands back only each original's task reference). A store that cannot be read leaves its part unknown, never an empty one.
 */
export function readEvidence(stateDir: string, projectId: string, only?: number): ResearchEvidence {
  const file = join(stateDir, "hub.db");
  if (!existsSync(file)) return NO_EVIDENCE;
  let db: ReturnType<typeof openHubDatabase> | undefined;
  try { db = openHubDatabase(file, { readonly: true }); } catch { return NO_EVIDENCE; }
  try {
    const handoffIn = new Set<number>(), handoffOut = new Map<number, number>();
    // `only` (the live writer, one task) narrows each read to that task; a backfill reads them all.
    const one = only === undefined ? "" : " WHERE task_id = " + Number(only);
    try { for (const r of db.query("SELECT task_id FROM task_handoff_origin" + one).all() as { task_id: number }[]) handoffIn.add(r.task_id); } catch { /* an older hub.db has no handoff table */ }
    try { for (const r of db.query("SELECT local_task FROM task_handoff_outbound WHERE local_task IS NOT NULL" + (only === undefined ? "" : " AND local_task = " + Number(only))).all() as { local_task: number }[]) handoffOut.set(r.local_task, (handoffOut.get(r.local_task) ?? 0) + 1); } catch { /* same */ }
    const tasks = new Map<number, EvidenceTask>();
    let board = true;
    try {
      for (const row of db.query("SELECT id, history, sdlc FROM tasks" + (only === undefined ? "" : " WHERE id = " + Number(only))).all() as { id: number; history: string | null; sdlc: string | null }[]) {
        const parse = (s: string | null) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
        tasks.set(row.id, evidenceTask({ id: row.id, history: parse(row.history), sdlc: parse(row.sdlc) }, { in: handoffIn.has(row.id) ? 1 : 0, out: handoffOut.get(row.id) ?? 0 }));
      }
    } catch { board = false; }
    let journal: ResearchEvidence["journal"];
    try {
      const rows = (db.query("SELECT d.state AS state, d.created_at AS createdAt, d.updated_at AS updatedAt, json_extract(e.value, '$.refs.task') AS task FROM deliveries d, json_each(d.originals) e WHERE d.project_id = ?" + (only === undefined ? "" : " AND CAST(json_extract(e.value, '$.refs.task') AS TEXT) = '" + Number(only) + "'")).all(projectId) as Record<string, unknown>[])
        .flatMap(r => { const row = journalRow(r.task, r.state, r.createdAt, r.updatedAt); return row ? [row] : []; });
      journal = { rows, coveredAfter: journalCoveredAfter(db, projectId) };
    } catch { /* no journal table: delivery timing is unknown */ }
    return { tasks, board, ...(journal ? { journal } : {}) };
  } finally { db.close(); }
}

/**
 * Why this bound is sound (#1290 review): pruning deletes only terminal rows, oldest `updated_at` first (ties by id), and never a protected one, so every pruned row's `updated_at` is at most the
 * smallest `updated_at` among the terminal, unprotected rows that survive (W). A delivery is created no later than it is last updated, so a delivery created after W cannot be a pruned one.
 * Protected rows are left out of W on purpose: including one (old, kept) would lower W and claim coverage the pruning did not keep. Unresolved rows are never pruned, so they need no bound.
 * Unknown (null) when the journal's own review-input coverage is incomplete (legacy candidates are protected in memory only, where this reader cannot see them) or the tables cannot be read.
 * No terminal row at all: nothing was kept and nothing needs bounding (-1, before any time).
 */
function journalCoveredAfter(db: ReturnType<typeof openHubDatabase>, projectId: string): number | null {
  try {
    const meta = db.query("SELECT review_input_coverage_complete AS ok FROM delivery_meta WHERE project_id = ?").get(projectId) as { ok: number } | null;
    if (meta?.ok !== 1) return null;
    const terminal = "d.project_id = ? AND d.state IN ('completed','discarded','failed')";
    const any = db.query(`SELECT COUNT(*) AS n FROM deliveries d WHERE ${terminal}`).get(projectId) as { n: number };
    if (any.n === 0) return -1;
    const unprotected = db.query(`SELECT MIN(d.updated_at) AS w FROM deliveries d WHERE ${terminal}
      AND NOT EXISTS (SELECT 1 FROM json_each(d.originals) e WHERE json_extract(e.value,'$.from')='hub' AND json_extract(e.value,'$.kind')='review' AND json_extract(e.value,'$.refs.reviewPackage') GLOB 'review-*')
      AND NOT EXISTS (SELECT 1 FROM deliveries c WHERE c.project_id = d.project_id AND c.previous_id = d.id)`).get(projectId) as { w: number | null };
    return typeof unprotected.w === "number" && Number.isFinite(unprotected.w) ? unprotected.w : null;
  } catch { return null; }
}

/** Nearest-rank quantile of whole numbers, or null for none. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

const EMPTY_TALLY = (): FindingTally => ({ important: 0, nit: 0, open: 0, fixed: 0, falsePositive: 0, accepted: 0 });

/** The review block of a task. Board evidence missing (`task` undefined) leaves every board-derived field null. */
export function reviewBlock(task: EvidenceTask | undefined, board: boolean, ownerFamily: string | null, pii: boolean): ReviewBlock {
  const blank: ReviewBlock = { rounds: null, firstPass: null, findings: null, reviewerFamily: null, ownerFamily, scope: "unknown", evidenceOnly: null, context: "unknown", staleHeadReReviews: null };
  if (!task) return blank;
  const entries = task.history;
  const verdicts = entries.filter(e => e.event === "approved" || e.event === "changes_requested");
  const view: MetricTask = { id: task.id, history: entries.map(e => ({ at: e.at, event: e.event, ...(e.requestHead ? { requestHead: e.requestHead } : {}), ...(e.verdictHead ? { verdictHead: e.verdictHead } : {}), ...(e.evidenceOnly ? { evidenceOnly: true as const } : {}) })) };
  const sample = taskSample(view);
  let findings: ReviewBlock["findings"] = null;
  const reported = entries.filter(e => !e.withheld && e.findings);
  if (!pii && reported.length) {
    const last = new Map<string, NonNullable<EvidenceEntry["findings"]>[number]>();
    for (const entry of reported) for (const f of entry.findings!) last.set(f.id, f);
    findings = { bugs: EMPTY_TALLY(), security: EMPTY_TALLY(), compliance: EMPTY_TALLY() };
    for (const f of last.values()) {
      const tally = findings[f.pass];
      tally[f.severity]++;
      if (f.disposition === "open") tally.open++; else if (f.disposition === "fixed") tally.fixed++; else if (f.disposition === "false_positive") tally.falsePositive++; else tally.accepted++;
    }
  }
  const lastVerdict = verdicts.at(-1), lastDone = entries.findLast(e => e.event === "done");
  const scope: ReviewScope = lastVerdict?.reviewScope === "code" ? "code" : lastDone?.plannedScope ?? "unknown";
  return {
    rounds: board ? verdicts.filter(e => e.evidenceOnly !== true).length : null,
    firstPass: sample.first_pass_approval === null ? null : sample.first_pass_approval === 1,
    findings,
    reviewerFamily: entries.findLast(e => e.reviewerFamily)?.reviewerFamily ?? null,
    ownerFamily, scope,
    evidenceOnly: board ? verdicts.filter(e => e.evidenceOnly === true).length : null,
    context: lastVerdict?.reviewContext ?? "unknown",
    staleHeadReReviews: sample.stale_head_re_reviews,
  };
}

/** The merge block. `doneToApprovedMs` is from the events' own times, so it needs no board; the CI and merge figures come from the receipt the guarded merge wrote. */
export function mergeBlock(task: EvidenceTask | undefined, doneAt: number | null, approvedAt: number | null): MergeBlock {
  const merge = task?.merge;
  const gap = (from: number | null, to: number | null) => from !== null && to !== null && to >= from ? to - from : null;
  return { ciRuns: merge?.ciRuns ?? null, ciReruns: merge?.ciReruns ?? null, githubReviews: merge?.reviews ?? null,
    doneToApprovedMs: gap(doneAt, approvedAt), approvedToMergedMs: gap(approvedAt, merge?.mergedAt ?? null) };
}

/** The specs block from the latest done's report; an incomplete report is unknown, never zero. */
export function specsBlock(task: EvidenceTask | undefined, pii: boolean): SpecsBlock {
  const report = pii ? undefined : task?.history.findLast(e => e.spec)?.spec;
  if (!report || !report.complete) return { covering: null, unchanged: null, acked: null, errors: null };
  return { covering: report.unchanged + report.changed, unchanged: report.unchanged, acked: report.acked, errors: report.errors };
}

/** Delivery states and first-delivery times of one task from the journal rows in `[from, to]` (the task's life plus a settling hour); everything is null when the journal does not reach back that far. */
export function journalFigures(evidence: ResearchEvidence, task: number, fromMs: number | null, toMs: number): Pick<DeliveryBlock, "firstDeliveryMs" | "needsReview" | "failed" | "discarded"> {
  const journal = evidence.journal;
  if (!journal || journal.coveredAfter === null || fromMs === null || fromMs <= journal.coveredAfter) return { firstDeliveryMs: { p50: null, p95: null }, needsReview: null, failed: null, discarded: null };
  const rows = journal.rows.filter(r => r.task === task && r.createdAt >= fromMs && r.createdAt <= toMs + 3_600_000);
  const latencies = rows.filter(r => r.state === "completed" && r.updatedAt >= r.createdAt).map(r => r.updatedAt - r.createdAt);
  const n = (state: string) => rows.filter(r => r.state === state).length;
  return { firstDeliveryMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) }, needsReview: n("needs_review"), failed: n("failed"), discarded: n("discarded") };
}
