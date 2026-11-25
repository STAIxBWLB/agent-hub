import type { HistoryEntry } from "./board.ts";
import { groupUnmetCriteria, LEARNING_DEFAULTS, type LearningRow } from "./learning.ts";

/**
 * #1642 T1/T2: what an accepted review-checklist line did afterwards. A line is followed by counting the hub's own review records that name its criterion unmet,
 * against the reviews of the same profile and class, on both sides of the acceptance. Pure: rows the caller has already cleared (no PII, no text the screen refuses)
 * in, counts out; it reads no config, board or file, and nothing here changes a checklist line.
 */
interface FollowKey {
  profile: string;
  class: string;
  criterion: string;
}
/** Reviewed tasks and the ones that named the criterion unmet: the count, never a significance claim. */
export interface Rate {
  reviewed: number;
  unmet: number;
}
/** The acceptance record: the line key, the card that recorded it, when the person accepted it, and the rate over the window that ended there. */
export interface AcceptanceRecord extends FollowKey {
  card: number;
  acceptedAt: number;
  before: Rate;
}
type FollowStatus = "insufficient" | "helping" | "no-change" | "worse";
/** What `ahub learn list --accepted` shows for one followed line. `windowStart` is the acceptance, or the last removal decision's reset. */
export interface OutcomeView extends FollowKey {
  card: number;
  acceptedAt: number;
  before: Rate;
  since: Rate;
  status: FollowStatus;
  windowStart: number;
}

/** The follow-up window and its floor (#1642, owner-confirmed 2026-11-25: 5 reviewed tasks, 30 days). Both are the same window the candidate rule uses. */
export const FOLLOWUP_DEFAULTS = { windowMs: LEARNING_DEFAULTS.windowMs, minReviewed: 5 } as const;

type ReviewEntry = Pick<HistoryEntry, "at" | "event" | "withheld" | "evidenceOnly" | "unmetCriteria">;
const VERDICT_EVENTS: readonly string[] = ["approved", "changes_requested"];

/** A review that counts in a denominator: a verdict the hub recorded, neither withheld nor evidence-only, inside the half-open span. */
const countedReview = (entry: ReviewEntry, from: number, to: number): boolean =>
  VERDICT_EVENTS.includes(entry.event) && !entry.withheld && !entry.evidenceOnly && entry.at > from && entry.at <= to;

const sameGroup = (row: LearningRow, key: FollowKey): boolean =>
  (row.profile ?? "dev") === key.profile && (row.profileClass ?? row.class) === key.class;

/**
 * The rate over one span, `from` exclusive and `to` inclusive: every distinct task of this profile and class reviewed in it, and those of them naming the criterion
 * unmet. A task reviewed twice counts once; an evidence-only verdict or a withheld review counts in neither side (#1642 shares #514a's exclusions).
 */
export function rateIn(rows: readonly LearningRow[], key: FollowKey, from: number, to: number): Rate {
  const reviewed = new Set<number>();
  for (const row of rows) {
    if (!sameGroup(row, key)) continue;
    for (const entry of row.history) if (countedReview(entry, from, to)) reviewed.add(row.id);
  }
  const group = groupUnmetCriteria(rows, { windowMs: to - from, now: to })
    .find(candidate => candidate.profile === key.profile && candidate.class === key.class && candidate.criterion === key.criterion);
  const unmet = (group?.tasks ?? []).filter(id => reviewed.has(id));
  return { reviewed: reviewed.size, unmet: unmet.length };
}

/** The outcome of one accepted line, `windowStart` being its acceptance or the reset a removal decision recorded. */
export function outcomeOf(record: AcceptanceRecord, rows: readonly LearningRow[], opts: { now: number; windowStart: number }): OutcomeView {
  const from = Math.max(opts.windowStart, opts.now - FOLLOWUP_DEFAULTS.windowMs);
  const since = rateIn(rows, record, from, opts.now), before = record.before;
  // Cross-multiplied so the comparison is exact: unmet/reviewed on each side, never a rounded rate.
  const lower = since.unmet * before.reviewed < before.unmet * since.reviewed;
  const equal = since.unmet * before.reviewed === before.unmet * since.reviewed;
  const status: FollowStatus = since.reviewed < FOLLOWUP_DEFAULTS.minReviewed ? "insufficient" : lower ? "helping" : equal ? "no-change" : "worse";
  return { profile: record.profile, class: record.class, criterion: record.criterion, card: record.card, acceptedAt: record.acceptedAt, before, since, status, windowStart: opts.windowStart };
}

/** Whether this line has earned a removal card: enough reviewed tasks in the window, and the criterion did not get rarer. */
export const removalDue = (view: OutcomeView): boolean =>
  view.since.reviewed >= FOLLOWUP_DEFAULTS.minReviewed && (view.status === "no-change" || view.status === "worse");

/** The rank a cap hint and the view share: worse before no-change before too few samples before helping. */
const STATUS_RANK: Record<FollowStatus, number> = { worse: 0, "no-change": 1, insufficient: 2, helping: 3 };

/** The followed line with the weakest outcome, for the hint a candidate card carries when the checklist is at its cap (#1642 T3). */
export function weakest(view: readonly OutcomeView[]): OutcomeView | undefined {
  return [...view].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.since.unmet * a.since.reviewed - a.since.unmet * b.since.reviewed
    || b.acceptedAt - a.acceptedAt || a.criterion.localeCompare(b.criterion))[0];
}

const windowDays = (): number => Math.round(FOLLOWUP_DEFAULTS.windowMs / 86_400_000);

/**
 * The acceptance record, carried on the closed card's own cancellation: the marker sentence stays first (an older reader keys on it), the counts are a fixed suffix
 * this module writes and reads back. #514b's rule holds: nothing else of a card's text is parsed as a value, and a card accepted before this change has no suffix
 * (the caller recomputes that rate from the board instead).
 */
export const acceptanceSuffix = (before: Rate): string => `; before ${before.unmet}/${before.reviewed} in ${windowDays()} days`;

export function readAcceptance(note: string | undefined): Rate | undefined {
  const match = note === undefined ? null : new RegExp(`; before (\\d{1,9})/(\\d{1,9}) in \\d{1,4} days$`).exec(note);
  if (!match) return undefined;
  return { unmet: Number(match[1]), reviewed: Number(match[2]) };
}
