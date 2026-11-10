import { isClosedTaskState, type HistoryEntry, type TaskState } from "./board.ts";
import type { DeliverableRecord } from "./deliverables.ts";

/**
 * #1221 T1: deterministic supervision rules over facts the public project view already holds.
 *
 * A pure function of admitted records: a task's structured history, the hub's own deliverable measurement and its
 * declared-overlap reading. No note, review finding, transcript, file body or private task is read, there is no clock,
 * no dependency object and no emit path, so an observation cannot turn a worker, write an action or notify anyone.
 * `src/hub/supervision.ts` is the neighbour: it turns board milestones into conductor notices and owns their batching.
 * This module decides only whether one of a closed set of conditions holds, and T2 (unauthorized here) is what would
 * carry a decision to a person. Nothing imports it yet, and that is the point of a shadow rule.
 */

export const SUPERVISION_RULES = ["repeated_failure", "deliverable_invalidated_check", "declared_overlap_without_integration"] as const;
export type SupervisionRuleId = (typeof SUPERVISION_RULES)[number];
/** Bump one rule when its trigger, refs or reason codes change meaning: a stored observation names the version it was made under. */
export const SUPERVISION_RULE_VERSION: Readonly<Record<SupervisionRuleId, number>> = { repeated_failure: 1, deliverable_invalidated_check: 1, declared_overlap_without_integration: 1 };

/** The existing hub operation an observation names. T1 names one; nothing in this module runs it. */
export const SUPERVISION_ACTIONS = ["escalate", "recheck", "request_integration"] as const;
export type SupervisionAction = (typeof SUPERVISION_ACTIONS)[number];
/** Closed reason codes: an observation says why it fired in a token, never in prose. */
export const SUPERVISION_REASONS = ["repeated_failure", "stale_check", "unintegrated_overlap"] as const;
export type SupervisionReasonCode = (typeof SUPERVISION_REASONS)[number];
/** Why a rule could not decide for one task and revision. A gap is not a trigger and never a zero. */
export const SUPERVISION_GAPS = ["no-history", "no-deliverable-measurement", "history-truncated"] as const;
export type SupervisionGapReason = (typeof SUPERVISION_GAPS)[number];

/** The only history fields any rule may read: events, times, check codes, deliverable ids and plan revisions. Notes, withheld text and findings are absent from this type. */
export type SupervisionHistoryFact = Pick<HistoryEntry, "at" | "event"> & Partial<Pick<HistoryEntry, "by" | "checkKey" | "noWrites" | "planRevision" | "evidenceOnly" | "deliverables">>;

export interface TaskRevisionFacts {
  id: number;
  state: TaskState;
  /** In history order, as the board appends it. A replayed record is the same record. */
  history: readonly SupervisionHistoryFact[];
}

/** The hub's own deliverable reading (`Tasks.deliverableStatus`): ids and states, never a file body. */
export interface DeliverableMeasurementFact {
  task: number;
  /** True only when the hub measured the files for this task; an unmeasured row cannot say a file changed. */
  checked: boolean;
  changed: readonly string[];
  missing?: readonly string[];
}

/** The hub's declared-overlap reading for one unordered pair (`Tasks.overlapHits`), one row per pair. */
export interface DeclaredOverlapFact {
  /** Either side of the pair. The observation binds to the pair's lower task id, so either direction reads the same. */
  task: number;
  other: number;
}

export interface ObservationLimits {
  /** Records the rule read for this observation, inside the current revision. */
  records: number;
  /** True when the revision held more records than a rule reads, so the observation saw a prefix. */
  truncated: boolean;
}

export interface SupervisionObservation {
  rule: SupervisionRuleId;
  version: number;
  task: number;
  /** The work attempt the observation binds to: equal only for the same owner episode and plan revision. */
  revision: string;
  /** One observation per (rule, task, revision, trigger): a replayed or duplicate event keeps this value. */
  trigger: string;
  /** The admitted records that fired it, as `history:<index>`, `deliverable:<id>` or `task:<id>`. Never a note or a file body. */
  refs: string[];
  limits: ObservationLimits;
  action: SupervisionAction;
  reason: SupervisionReasonCode;
}

export interface SupervisionGap {
  rule: SupervisionRuleId;
  version: number;
  task: number;
  revision: string;
  reason: SupervisionGapReason;
}

export interface EvaluatedRevision {
  rule: SupervisionRuleId;
  task: number;
  revision: string;
}

export interface SupervisionEvaluation {
  observations: SupervisionObservation[];
  gap: SupervisionGap[];
  /** Every `(rule, task, revision)` this evaluation read, deduped and in key order. A closed task is not read at all. */
  evaluated: EvaluatedRevision[];
}

export interface SupervisionFacts {
  tasks: readonly TaskRevisionFacts[];
  deliverables?: readonly DeliverableMeasurementFact[];
  overlaps?: readonly DeclaredOverlapFact[];
}

/** Records one rule reads from one revision. A longer revision is read as a prefix and the observation says `truncated`. */
export const MAX_RECORDS = 64;
/** Equal classified failures a revision shows before the repetition rule fires: the first is an incident, the second a pattern. */
export const REPEAT_FLOOR = 2;
/** Record refs one observation may carry. */
export const MAX_REFS = 8;
/** Shadow observations retained by one supervisor, and per task revision: the same bounds the proposal queue uses. */
export const MAX_OBSERVATIONS = 100;
export const MAX_PER_REVISION = 3;

/** A work attempt starts where an owner takes or retakes the task, or a plan revision begins. */
const EPISODE_EVENTS: ReadonlySet<string> = new Set(["accepted", "reassigned", "escalated", "reopened"]);
/** Evidence that clears a failure streak: the check ran again, integration landed, or the work was approved. Ordinary events neither fire nor clear. */
const RESET_EVENTS: ReadonlySet<string> = new Set(["check passed", "integrated", "approved"]);
/** Evidence that the pair's overlap was taken up: an attempt counts, a failure of one is the repetition rule's business. */
const INTEGRATION_EVENTS: ReadonlySet<string> = new Set(["integration requested", "integrated", "integration unresolved"]);

export interface TaskRevision {
  revision: string;
  /** First history index inside the current revision. */
  from: number;
  /**
   * History index of the acceptance that still governs this revision, or `-1` when none does. A plan revision keeps the
   * acceptance (the same owner continues) but moves `from` past it, so this can be earlier than `from`.
   */
  accepted: number;
}

/**
 * The work attempt a record belongs to: the number of owner episodes and the host-authored plan revision. It is not
 * `history.length`: unrelated bookkeeping (a check result, a quiet hub entry) must not split one observation into two.
 * A plan revision starts an attempt of its own, so failures recorded under the previous plan are not read as this one's.
 */
export function taskRevision(task: Pick<TaskRevisionFacts, "history">): TaskRevision {
  let episodes = 0, from = 0, plan = "none", accepted = -1;
  for (const [index, entry] of task.history.entries()) {
    // A reassignment, an escalation or a reopen hands the work to another attempt, so an earlier acceptance stops governing.
    if (EPISODE_EVENTS.has(entry.event)) { episodes += 1; from = index + 1; accepted = entry.event === "accepted" ? index : -1; }
    if (entry.planRevision) { plan = String(entry.planRevision.revision); from = index + 1; }
  }
  return { revision: `${episodes}:${plan}`, from, accepted };
}

/**
 * The history indices one revision governs, when the record set still contains it. `taskRevision` names the current
 * attempt only; this names an attempt the history has moved past, which is the window a stored proposal was read under
 * (an escalation recorded after an acceptance is itself an episode event, so the current revision is no longer that
 * one). A record belongs to the revision in force before it, exactly as `taskRevision` counts it.
 */
export function revisionSpan(history: readonly SupervisionHistoryFact[], revision: string): { from: number; to: number } | undefined {
  let episodes = 0, plan = "none", from = -1, to = -1;
  for (const [index, entry] of history.entries()) {
    if (`${episodes}:${plan}` === revision) { if (from < 0) from = index; to = index; }
    if (EPISODE_EVENTS.has(entry.event)) episodes += 1;
    if (entry.planRevision) plan = String(entry.planRevision.revision);
  }
  return from < 0 ? undefined : { from, to };
}

/** One classified failure, in a closed vocabulary: the kind of failure, never its text. */
function failureClass(entry: SupervisionHistoryFact): string | undefined {
  if (entry.event === "check failed") return `check:${entry.checkKey ?? "unknown"}`;
  // #852: a code-scope reviewer's rejection that names no finding is not a defect of the work.
  if (entry.event === "changes_requested") return entry.evidenceOnly ? undefined : "review:changes_requested";
  if (entry.event === "integration unresolved") return "integration:unresolved";
  if (entry.event === "done" && entry.noWrites === true) return "done:no-writes";
  return undefined;
}

interface Side {
  task: TaskRevisionFacts;
  revision: string;
  from: number;
  /** From `taskRevision`: the acceptance still governing this revision, which a plan change can leave before the window. */
  accepted: number;
  window: SupervisionHistoryFact[];
  limits: ObservationLimits;
}

const observationKey = (observation: SupervisionObservation): string => `${observation.rule}:${observation.task}:${observation.revision}:${observation.trigger}`;
const gapKey = (gap: SupervisionGap): string => `${gap.rule}:${gap.task}:${gap.revision}:${gap.reason}`;
const evaluatedKey = (evaluated: EvaluatedRevision): string => `${evaluated.rule}:${evaluated.task}:${evaluated.revision}`;
const gapOf = (rule: SupervisionRuleId, task: number, revision: string, reason: SupervisionGapReason): SupervisionGap => ({ rule, version: SUPERVISION_RULE_VERSION[rule], task, revision, reason });

/**
 * Repeated equal classified failures since the last clearing evidence, one observation per class that reached the floor.
 * A class already observed in this revision is not observed twice, so only the per-revision bound can refuse it.
 */
function repeatedFailures(side: Side): SupervisionObservation[] {
  const found: SupervisionObservation[] = [], seen = new Set<string>();
  let cls: string | undefined, run: string[] = [];
  for (const [offset, entry] of side.window.entries()) {
    if (RESET_EVENTS.has(entry.event)) { cls = undefined; run = []; continue; }
    const next = failureClass(entry);
    if (!next) continue;
    if (next !== cls) { cls = next; run = []; }
    run.push(`history:${side.from + offset}`);
    if (run.length < REPEAT_FLOOR || seen.has(next)) continue;
    seen.add(next);
    found.push({ rule: "repeated_failure", version: SUPERVISION_RULE_VERSION.repeated_failure, task: side.task.id, revision: side.revision, trigger: `failures:${next}`, refs: run.slice(-MAX_REFS), limits: side.limits, action: "escalate", reason: "repeated_failure" });
  }
  return found;
}

interface Reading { observation?: SupervisionObservation; gap?: SupervisionGap }

/** A recorded check whose delivered files the hub now measures as changed or missing. */
function invalidatedCheck(side: Side, measurement: DeliverableMeasurementFact | undefined): Reading {
  let check: number | undefined;
  const recorded = new Set<string>();
  for (const [offset, entry] of side.window.entries()) {
    if (entry.event === "check passed") check = offset;
    for (const record of (entry.deliverables ?? []) as readonly DeliverableRecord[]) recorded.add(record.id);
  }
  if (check === undefined || !recorded.size) return {};
  if (!measurement?.checked) return { gap: gapOf("deliverable_invalidated_check", side.task.id, side.revision, "no-deliverable-measurement") };
  const stale = [...new Set([...measurement.changed, ...(measurement.missing ?? [])])].filter((id) => recorded.has(id)).sort();
  if (!stale.length) return {};
  return { observation: { rule: "deliverable_invalidated_check", version: SUPERVISION_RULE_VERSION.deliverable_invalidated_check, task: side.task.id, revision: side.revision, trigger: `check:${stale.slice(0, MAX_PER_REVISION).join(",")}`, refs: [`history:${side.from + check}`, ...stale.map((id) => `deliverable:${id}`)].slice(0, MAX_REFS), limits: side.limits, action: "recheck", reason: "stale_check" } };
}

/**
 * Integration evidence recorded after an acceptance. A plan change can leave the acceptance before the window, so the
 * read starts at the acceptance when it is inside it and at the window's first record otherwise.
 */
const integratedAfter = (side: Side, accepted: number): boolean => side.window.slice(Math.max(0, accepted - side.from + 1)).some((entry) => INTEGRATION_EVENTS.has(entry.event));

/**
 * Declared overlap that outlived both owners' acceptance of their current revision, with no integration evidence since.
 * Persistence is record-based (both sides accepted), never elapsed time: silence proves nothing. The pair is bound to
 * its lower task id, so the same pair named in either direction is one observation and not two.
 */
function unintegratedOverlap(pair: DeclaredOverlapFact, sides: Map<number, Side>): { reading: Reading; evaluated: EvaluatedRevision } {
  const low = Math.min(pair.task, pair.other), high = Math.max(pair.task, pair.other);
  const mine = sides.get(low), theirs = sides.get(high);
  // The pair is read as its lower id under that id's revision; a pair whose low side is absent keeps this as its gap revision.
  const evaluated: EvaluatedRevision = { rule: "declared_overlap_without_integration", task: low, revision: (mine ?? theirs)?.revision ?? "0:none" };
  if (!mine || !theirs) return { evaluated, reading: { gap: gapOf("declared_overlap_without_integration", low, evaluated.revision, "no-history") } };
  if (isClosedTaskState(mine.task.state) || isClosedTaskState(theirs.task.state)) return { evaluated, reading: {} };
  const accepted = [mine.accepted, theirs.accepted] as const;
  if (accepted[0] < 0 || accepted[1] < 0) return { evaluated, reading: {} };
  if (integratedAfter(mine, accepted[0]) || integratedAfter(theirs, accepted[1])) return { evaluated, reading: {} };
  // Integration past the read prefix is unknown, not absent: a clipped window cannot report the pair as unintegrated.
  if (mine.limits.truncated || theirs.limits.truncated) return { evaluated, reading: { gap: gapOf("declared_overlap_without_integration", low, mine.revision, "history-truncated") } };
  return {
    evaluated,
    reading: {
      observation: {
        rule: "declared_overlap_without_integration", version: SUPERVISION_RULE_VERSION.declared_overlap_without_integration, task: low, revision: mine.revision,
        trigger: `overlap:${low}:${high}`, refs: [`task:${high}`, `history:${accepted[0]}`, `history:${accepted[1]}`].slice(0, MAX_REFS),
        limits: { records: mine.limits.records + theirs.limits.records, truncated: mine.limits.truncated || theirs.limits.truncated }, action: "request_integration", reason: "unintegrated_overlap",
      },
    },
  };
}

/**
 * Every rule's reading of one fact set, in a stable order, with no side effect of any kind. Closed tasks are not
 * supervised: an approved or cancelled task has nothing left to decide. A gap names the rule and the missing record;
 * elapsed silence alone never produces an observation or a gap. `evaluated` is the coverage of that read: one entry per
 * rule and task revision the evaluator looked at, whether or not it found anything.
 */
export function evaluateSupervision(facts: SupervisionFacts): SupervisionEvaluation {
  const observations: SupervisionObservation[] = [], gaps: SupervisionGap[] = [], evaluated: EvaluatedRevision[] = [], sides = new Map<number, Side>();
  for (const task of facts.tasks) {
    const { revision, from, accepted } = taskRevision(task);
    const window = task.history.slice(from, from + MAX_RECORDS);
    sides.set(task.id, { task, revision, from, accepted, window, limits: { records: window.length, truncated: task.history.length - from > MAX_RECORDS } });
  }
  const keep = (reading: Reading): void => { if (reading.observation) observations.push(reading.observation); if (reading.gap) gaps.push(reading.gap); };
  const measurements = new Map((facts.deliverables ?? []).map((row) => [row.task, row]));
  for (const side of sides.values()) {
    if (isClosedTaskState(side.task.state)) continue;
    evaluated.push({ rule: "repeated_failure", task: side.task.id, revision: side.revision }, { rule: "deliverable_invalidated_check", task: side.task.id, revision: side.revision });
    const repeated = repeatedFailures(side);
    observations.push(...repeated);
    const check = invalidatedCheck(side, measurements.get(side.task.id));
    keep(check);
    // A clipped revision is missing coverage, not a clean one: a rule that saw only a prefix says so.
    if (!side.limits.truncated) continue;
    if (!repeated.length) gaps.push(gapOf("repeated_failure", side.task.id, side.revision, "history-truncated"));
    if (!check.observation && !check.gap) gaps.push(gapOf("deliverable_invalidated_check", side.task.id, side.revision, "history-truncated"));
  }
  for (const overlap of facts.overlaps ?? []) {
    const pair = unintegratedOverlap(overlap, sides);
    evaluated.push(pair.evaluated);
    keep(pair.reading);
  }
  // One entry per rule and revision: a pair named twice, or a task listed twice, is one read and not two.
  const coverage = new Map(evaluated.map((entry) => [evaluatedKey(entry), entry]));
  return {
    observations: observations.sort((a, b) => (observationKey(a) < observationKey(b) ? -1 : observationKey(a) > observationKey(b) ? 1 : 0)),
    gap: gaps.sort((a, b) => (gapKey(a) < gapKey(b) ? -1 : gapKey(a) > gapKey(b) ? 1 : 0)),
    evaluated: [...coverage.values()].sort((a, b) => (evaluatedKey(a) < evaluatedKey(b) ? -1 : evaluatedKey(a) > evaluatedKey(b) ? 1 : 0)),
  };
}

export interface ShadowCounts {
  evaluations: number;
  observations: number;
  deduped: number;
  /** Observations and gaps a retention bound refused; they are counted, never stored. */
  suppressed: number;
  gap: number;
  /** Coverage keys a retention bound refused: a bound never reads as "nothing was evaluated". */
  evaluatedSuppressed: number;
  /** AC2: shadow mode has no effect path at all, so these are the literal type zero. */
  workerTurns: 0;
  actionWrites: 0;
  notifications: 0;
}

/**
 * Shadow mode: counts and bounded ids only. It keeps no worker, starts no timer and holds no dependency, so it can
 * record what a rule would have said without producing a turn, an action write or a notification — those counters are
 * the literal `0` and a non-zero value would not typecheck.
 */
export class ShadowSupervisor {
  private readonly retained = new Map<string, SupervisionObservation>();
  private readonly retainedGaps = new Map<string, SupervisionGap>();
  private readonly retainedEvaluated = new Map<string, EvaluatedRevision>();
  private readonly perRevision = new Map<string, number>();
  private evaluations = 0;
  private deduped = 0;
  private suppressed = 0;
  private evaluatedSuppressed = 0;

  /** Adds only what is new. Replaying the same facts, or an event that is a duplicate of one already read, adds nothing. */
  observe(facts: SupervisionFacts): SupervisionObservation[] {
    this.evaluations += 1;
    const evaluation = evaluateSupervision(facts), added: SupervisionObservation[] = [];
    for (const entry of evaluation.evaluated) {
      const key = evaluatedKey(entry);
      if (this.retainedEvaluated.has(key)) continue;
      if (this.retainedEvaluated.size >= MAX_OBSERVATIONS) { this.evaluatedSuppressed += 1; continue; }
      this.retainedEvaluated.set(key, entry);
    }
    for (const gap of evaluation.gap) {
      const key = gapKey(gap);
      if (this.retainedGaps.has(key)) continue;
      if (this.retainedGaps.size >= MAX_OBSERVATIONS) { this.suppressed += 1; continue; }
      this.retainedGaps.set(key, gap);
    }
    for (const observation of evaluation.observations) {
      const key = observationKey(observation);
      if (this.retained.has(key)) { this.deduped += 1; continue; }
      const revisionKey = `${observation.rule}:${observation.task}:${observation.revision}`, held = this.perRevision.get(revisionKey) ?? 0;
      if (this.retained.size >= MAX_OBSERVATIONS || held >= MAX_PER_REVISION) { this.suppressed += 1; continue; }
      this.retained.set(key, observation);
      this.perRevision.set(revisionKey, held + 1);
      added.push(observation);
    }
    return added;
  }

  /** Retained observations in a stable order, for a receipt or a fixture comparison. */
  observations(): SupervisionObservation[] {
    return [...this.retained.values()].sort((a, b) => (observationKey(a) < observationKey(b) ? -1 : observationKey(a) > observationKey(b) ? 1 : 0));
  }

  /** Retained gaps in the evaluator's own `(rule, task, revision, reason)` order: the order `gapKey` sorts by. */
  gaps(): SupervisionGap[] {
    return [...this.retainedGaps.values()].sort((a, b) => (gapKey(a) < gapKey(b) ? -1 : gapKey(a) > gapKey(b) ? 1 : 0));
  }

  /** The `(rule, task, revision)` triples this supervisor read, deduped and in `evaluatedKey` order: coverage, not findings. */
  evaluated(): EvaluatedRevision[] {
    return [...this.retainedEvaluated.values()].sort((a, b) => (evaluatedKey(a) < evaluatedKey(b) ? -1 : evaluatedKey(a) > evaluatedKey(b) ? 1 : 0));
  }

  /**
   * Everything this supervisor holds, as one read: the exported contract a consumer reads (agent-research#63) instead of
   * reaching into the retained maps. A snapshot is a copy, so nothing that happens afterwards reaches it.
   */
  snapshot(): { observations: SupervisionObservation[]; gap: SupervisionGap[]; counts: ShadowCounts; evaluated: EvaluatedRevision[] } {
    return { observations: this.observations(), gap: this.gaps(), counts: this.counts(), evaluated: this.evaluated() };
  }

  counts(): ShadowCounts {
    return { evaluations: this.evaluations, observations: this.retained.size, deduped: this.deduped, suppressed: this.suppressed, gap: this.retainedGaps.size, evaluatedSuppressed: this.evaluatedSuppressed, workerTurns: 0, actionWrites: 0, notifications: 0 };
  }
}
