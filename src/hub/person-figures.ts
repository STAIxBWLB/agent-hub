import type { StampedEvent } from "./events.ts";

/**
 * #1278: what the person was asked and did, per task, from the four events that now carry the token attribution rule (`task`, `attribution`): `permission`, `question`, `completion` and `agent_cli`.
 * One accumulator serves `ahub report --by task` and the research record, so the two cannot show different numbers. Ids, counts and recorded durations only: none of these events holds a
 * prompt, an option, a command or an answer.
 *
 * - An interaction counts for a task only when its event names one (`attribution` of `delivery` or `single_open`). `unattributed` is counted apart and never folded into a task.
 * - Unknown is null, never 0: a log with no attributed person event at all (written before this version, or by a hub that never saw one) says nothing about any task, so every figure is null.
 * - Minutes: `latencyMs.sum` adds only recorded latencies of PERSON-answered permissions and questions (an answer with a `surface`: the console, the dashboard, the terminal, acon). A person
 *   answer with no latency reading raises `n` and `unknown` and adds nothing to `sum`. An automatic answer, an expiry and a cancellation are counted but are not the person's minutes.
 * - `consoleConfirmations` stays null: the hub records no event for a console confirmation (the confirm step is the console's own, and its approval arrives as the permission's `answered`).
 * Ceiling: a person interaction in a vendor TUI the hub cannot see is not observed here at all.
 */
export interface PermissionFigures { asked: number; allowed: number; denied: number; expired: number }
export interface QuestionFigures { asked: number; answered: number; expired: number }
export interface LatencyFigures { sum: number; n: number; unknown: number }
export interface PersonFigures {
  permissions: PermissionFigures | null;
  questions: QuestionFigures | null;
  completions: number | null;
  cliRefusals: number | null;
  consoleConfirmations: null;
  latencyMs: LatencyFigures | null;
}
export const UNKNOWN_PERSON_FIGURES: Readonly<PersonFigures> = Object.freeze({ permissions: null, questions: null, completions: null, cliRefusals: null, consoleConfirmations: null, latencyMs: null });

export interface PersonCounts {
  permissions: PermissionFigures; questions: QuestionFigures; completions: number; cliRefusals: number; latencyMs: LatencyFigures;
}
export const emptyPersonCounts = (): PersonCounts => ({ permissions: { asked: 0, allowed: 0, denied: 0, expired: 0 }, questions: { asked: 0, answered: 0, expired: 0 }, completions: 0, cliRefusals: 0, latencyMs: { sum: 0, n: 0, unknown: 0 } });

/** The four event types this module reads. */
export const PERSON_EVENT_TYPES = ["permission", "question", "completion", "agent_cli"] as const;
export type PersonEvent = Extract<StampedEvent, { type: (typeof PERSON_EVENT_TYPES)[number] }>;
export const isPersonEvent = (e: StampedEvent): e is PersonEvent => (PERSON_EVENT_TYPES as readonly string[]).includes(e.type);

const ALLOW = new Set(["allow_once", "allow_always"]), DENY = new Set(["reject_once", "reject_always"]);
const recorded = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;

/** Add one person event to a group of counts. */
export function addPersonEvent(into: PersonCounts, e: PersonEvent): void {
  if (e.type === "permission") {
    if (e.event === "requested") into.permissions.asked++;
    else if (e.event === "expired") into.permissions.expired++;
    else if (e.event === "answered") {
      if (e.option && ALLOW.has(e.option)) into.permissions.allowed++; else if (e.option && DENY.has(e.option)) into.permissions.denied++;
      if (e.surface !== undefined) minutes(into, e.latencyMs);
    }
  } else if (e.type === "question") {
    if (e.event === "asked") into.questions.asked++;
    else if (e.event === "expired") into.questions.expired++;
    else if (e.event === "answered") { into.questions.answered++; if (e.surface !== undefined) minutes(into, e.latencyMs); }
  } else if (e.type === "completion") into.completions++;
  else if (e.type === "agent_cli" && e.refused) into.cliRefusals++;
}
function minutes(into: PersonCounts, latencyMs: unknown): void {
  into.latencyMs.n++;
  if (recorded(latencyMs)) into.latencyMs.sum += latencyMs; else into.latencyMs.unknown++;
}

/** The figures of one task from its counts; null throughout when the log never reported attribution on a person event. */
export const personFigures = (counts: PersonCounts | undefined, reporting: boolean): PersonFigures =>
  reporting && counts ? { permissions: counts.permissions, questions: counts.questions, completions: counts.completions, cliRefusals: counts.cliRefusals, consoleConfirmations: null, latencyMs: counts.latencyMs } : { ...UNKNOWN_PERSON_FIGURES };

/**
 * Whether a `hub_start` says the run attributes person events (#1278). A task is covered by the log when it began at or after the first such start: from then on every person interaction of
 * the task was written with the rule's answer, so no event means none happened, which is a known 0. Before it, the log cannot say, and the task's person block is unknown. The first
 * person event is NOT the marker: a hub that upgraded and saw no interaction for days would otherwise report its first tasks as unknown instead of as the zero they are.
 */
export const startsAttribution = (e: StampedEvent): boolean => e.type === "hub_start" && e.personAttribution === true;

/** The task an attributed event names, or undefined for an unattributed or pre-attribution one. */
export const personTask = (e: PersonEvent): number | undefined =>
  (e.attribution === "delivery" || e.attribution === "single_open") && typeof e.task === "number" && Number.isSafeInteger(e.task) && e.task > 0 ? e.task : undefined;
