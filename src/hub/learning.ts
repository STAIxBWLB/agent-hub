import type { Task } from "./board.ts";

/**
 * Recurring unmet acceptance criteria, grouped by profile, class and criterion (#514a). Pure: it reads task rows the caller has already cleared of PII and
 * returns groups; it touches no board, config or file. A group is evidence for a person to review, never a change: `overridesDiff` builds the text of a
 * `profile_overrides` fragment and nothing in this module, or the card made from it, applies it.
 */
export interface CriterionGroup {
  profile: string;
  /** The task's profile class alias when it has one, else its base class: what the person recognises on the board. */
  class: string;
  criterion: string;
  /** Distinct task ids that had the criterion unmet in the window, ascending. */
  tasks: number[];
  /** Times it was named unmet across those tasks' reviews in the window. */
  count: number;
}
/** What the grouping needs of a row: kept narrow so a test builds rows without a whole board. */
export type LearningRow = Pick<Task, "id" | "class" | "profile" | "profileClass" | "history">;

export const LEARNING_DEFAULTS = { windowMs: 30 * 24 * 3_600_000, threshold: 3, maxGroups: 64 } as const;

/** One group per (profile, class, criterion) with its tasks in the window. A review that names a criterion twice counts once; a task counts once per group. */
export function groupUnmetCriteria(rows: readonly LearningRow[], opts: { windowMs: number; now: number }): CriterionGroup[] {
  const groups = new Map<string, CriterionGroup & { seen: Set<number> }>();
  for (const row of rows) {
    const profile = row.profile ?? "dev", cls = row.profileClass ?? row.class;
    for (const entry of row.history) {
      // An evidence-only verdict (a code-scope reviewer that named no open finding) is not a rejection and never proposes (#852); it is not recurrence evidence later either.
      if (!entry.unmetCriteria?.length || entry.withheld || entry.evidenceOnly || opts.now - entry.at > opts.windowMs || entry.at > opts.now) continue;
      for (const criterion of new Set(entry.unmetCriteria)) {
        const key = JSON.stringify([profile, cls, criterion]);
        let group = groups.get(key);
        if (!group) { group = { profile, class: cls, criterion, tasks: [], count: 0, seen: new Set() }; groups.set(key, group); }
        group.count++;
        if (!group.seen.has(row.id)) { group.seen.add(row.id); group.tasks.push(row.id); }
      }
    }
  }
  return [...groups.values()].map(({ seen: _seen, ...group }) => ({ ...group, tasks: group.tasks.sort((a, b) => a - b) }))
    .sort((a, b) => b.tasks.length - a.tasks.length || b.count - a.count || a.profile.localeCompare(b.profile) || a.class.localeCompare(b.class) || a.criterion.localeCompare(b.criterion));
}

/**
 * The groups to file now, in order, at most `max`. The cap counts cards to file, never groups examined: a group that this verdict did not name, that is below the
 * threshold, that already has a card or that is one piece of work is skipped BEFORE the cap, so a long run of settled groups can never fill the cap and starve a new one.
 */
export function selectGroups(groups: readonly CriterionGroup[], opts: { named: ReadonlySet<string>; threshold: number; max: number; has: (group: CriterionGroup) => boolean; units: (group: CriterionGroup) => number }): CriterionGroup[] {
  const picked: CriterionGroup[] = [];
  for (const group of groups) {
    if (picked.length >= opts.max) break;
    if (!opts.named.has(group.criterion) || group.tasks.length < opts.threshold || opts.has(group) || opts.units(group) < 2) continue;
    picked.push(group);
  }
  return picked;
}

/** Plain ASCII, one line, no quoting surprises: the card text and the diff are read by a person and by a screen. */
const line = (text: string) => text.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();

/**
 * The `profile_overrides` fragment a person would review for this group: a review checklist line that names the criterion, so a reviewer is told to look at it
 * every time. It is text. `review_checklist` replaces as a unit (docs/profiles.md), so the fragment is a line to ADD to the person's current checklist, which the card
 * says; nothing here reads or writes any config file.
 */
export function overridesDiff(group: Pick<CriterionGroup, "profile" | "class" | "criterion" | "tasks">): { profile_overrides: { review_checklist: string[] } } {
  return { profile_overrides: { review_checklist: [line(checklistLineOf(group.criterion, group.tasks.length, group.class))] } };
}

/**
 * #1642 T3: the fixed opening of the one line `ahub learn accept` writes, which is how a followed line is found again in the person's checklist. The count in the
 * line moves as reviews recur, so the line is identified by this prefix and never by its full text.
 */
export const checklistLineMarker = (criterion: string): string => `${criterion}: confirm this first; it was unmet on `;
const checklistLineOf = (criterion: string, tasks: number, cls: string): string => `${checklistLineMarker(criterion)}${tasks} ${cls} tasks`;

/** A stable dedupe key: one card per (profile, class, criterion) however many reviews recur. */
export const criterionKey = (group: Pick<CriterionGroup, "profile" | "class" | "criterion">) => `Criterion candidate key: ${group.profile}:${group.class}:${group.criterion}`;

/** The backlog card's title and detail. Ids and counts only: no review text, no task title, no path. */
export function candidateCard(group: CriterionGroup, windowDays: number, workUnits: number): { title: string; detail: string } {
  const diff = overridesDiff(group);
  return {
    title: `Review checklist candidate for ${group.profile}/${group.class} criterion ${group.criterion}`,
    detail: [
      criterionKey(group),
      `Criterion ${group.criterion} was named unmet ${group.count} time(s) on ${group.tasks.length} ${group.profile}/${group.class} task(s) in the last ${windowDays} days (${workUnits} separate piece(s) of work): ${group.tasks.slice(0, 8).map(id => `#${id}`).join(", ")}.`,
      "This is a candidate for a person to review. Nothing was applied: the hub writes it only when the person runs ahub learn accept <id> (to .agenthub/config.local.json, this machine only, added to your current checklist; ahub settings undo puts it back), or ahub learn reject <id> to close this card. By hand: profile_overrides is not machine-local: it is read from the shared .agenthub/config.json (tracked, so a change there reaches every checkout) and from .agenthub/config.local.json (this machine only), and the layers merge. Put it where you want it to apply. If you agree, add the line below to profile_overrides.review_checklist; that list replaces as a unit, so add it to your current checklist, do not paste it over it:",
      JSON.stringify(diff, null, 2),
    ].join("\n"),
  };
}

/** The cap `resolveProfile` puts on a review checklist (`profiles.ts`): the learn writer never builds a list the loader would refuse. */
export const CHECKLIST_MAX_LINES = 16;
const PROFILE = /^[a-z][a-z0-9_-]{0,31}$/, CLASS = /^[a-z][a-z0-9_]{0,47}$/, CRITERION = /^[A-Za-z][A-Za-z0-9-]{0,47}$/;

/**
 * What `ahub learn accept` may act on (#514b), read from a card the hub itself filed. ONLY the key line is read: `Criterion candidate key: <profile>:<class>:<criterion>`, as the
 * FIRST line of the detail, on a backlog card the hub filed in the `plan` class. The three parts are re-checked against the shapes the loaders accept, and the line to write is
 * REGENERATED from them by `overridesDiff` with a count the caller recomputes from the board, so no text of the card (the diff it prints, a count it states, a title) is ever
 * parsed as a value or written. A card that does not match is refused with a reason, never half read.
 */
export type CandidateCard = { profile: string; class: string; criterion: string } | { refused: string };
export function parseCandidateCard(task: Pick<Task, "class" | "detail" | "history" | "title">): CandidateCard {
  if (task.class !== "plan" || task.history[0]?.by !== "hub") return { refused: "not a candidate the hub filed" };
  const first = task.detail.split("\n", 1)[0] ?? "";
  const match = /^Criterion candidate key: ([^:\s]+):([^:\s]+):([^:\s]+)$/.exec(first);
  if (!match) return { refused: "not a recurring-criterion candidate (no key line first)" };
  const [, profile, cls, criterion] = match as unknown as [string, string, string, string];
  if (!PROFILE.test(profile) || !CLASS.test(cls) || !CRITERION.test(criterion)) return { refused: "the key line names a profile, class or criterion the loaders would not accept" };
  if (task.title !== `Review checklist candidate for ${profile}/${cls} criterion ${criterion}`) return { refused: "the card's title does not match its key line" };
  return { profile, class: cls, criterion };
}

/**
 * The checklist to store after accepting: the person's CURRENT checklist (what the profile uses now) with the one regenerated line added, because `review_checklist` replaces as a
 * unit. The line is skipped when it is already there, so a repeated accept writes nothing new. Refused, not trimmed, when the list would pass `CHECKLIST_MAX_LINES`.
 */
export function withChecklistLine(current: readonly string[], line: string): { list: string[] } | { refused: string } {
  if (current.includes(line)) return { list: [...current] };
  if (current.length + 1 > CHECKLIST_MAX_LINES) return { refused: `the checklist already has ${current.length} lines and the profile allows ${CHECKLIST_MAX_LINES}; remove one in .agenthub/config.local.json first` };
  return { list: [...current, line] };
}

/**
 * The checklist to store after accepting a removal card: the person's CURRENT checklist with the one generated line whose prefix is `marker` gone. Exactly one line must
 * match: none means the person edited or removed it by hand and nothing is guessed, two mean the card cannot name which one it means. Refused, never trimmed.
 */
export function withoutChecklistLine(current: readonly string[], marker: string): { list: string[]; removed: string } | { refused: string } {
  const hits = current.filter(entry => entry.startsWith(marker));
  if (!hits.length) return { refused: `no checklist line starts with ${JSON.stringify(marker)}: it was removed or edited by hand, so nothing was removed` };
  if (hits.length > 1) return { refused: `${hits.length} checklist lines start with ${JSON.stringify(marker)}: remove the one you mean in .agenthub/config.local.json, then reject this card` };
  return { list: current.filter(entry => entry !== hits[0]), removed: hits[0]! };
}

/** What a removal card states, as the caller measured it: the counts on both sides of the acceptance and the window the follow-up runs from. */
interface RemovalSubject {
  profile: string;
  class: string;
  criterion: string;
  acceptedAt: number;
  windowStart: number;
  before: { reviewed: number; unmet: number };
  since: { reviewed: number; unmet: number };
  status: string;
}

/** A stable dedupe key: one removal card per line per follow-up window, so a rejection (which resets the window) can be followed by a new card later. */
export const removalKey = (subject: Pick<RemovalSubject, "profile" | "class" | "criterion" | "windowStart">): string =>
  `Checklist removal key: ${subject.profile}:${subject.class}:${subject.criterion}:${subject.windowStart}`;

/** The backlog card's title and detail: ids and counts only, no review text, no task title, no path. */
export function removalCard(subject: RemovalSubject, windowDays: number): { title: string; detail: string } {
  return {
    title: `Review checklist removal for ${subject.profile}/${subject.class} criterion ${subject.criterion}`,
    detail: [
      removalKey(subject),
      line(`Criterion ${subject.criterion} on ${subject.profile}/${subject.class} was accepted into the checklist on ${new Date(subject.acceptedAt).toISOString()}. Since then ${subject.since.reviewed} task(s) of that profile and class were reviewed and ${subject.since.unmet} named it unmet, against ${subject.before.reviewed} reviewed and ${subject.before.unmet} unmet in the ${windowDays} days before the acceptance (status ${subject.status}).`),
      "This is a candidate for a person to review. Nothing was removed: ahub learn accept on this card removes that one line from .agenthub/config.local.json (this machine only) through the settings writer, and ahub settings undo puts the previous file back. ahub learn reject on this card closes it and starts the follow-up window again. A checklist line can matter for reasons the unmet count does not show, so nothing is removed on its own.",
    ].join("\n"),
  };
}

/**
 * A removal card the hub filed, read the same way as a candidate card: ONLY the key line first, the three parts re-checked against the loaders' shapes, and the title
 * matched to the key line. The line to remove is rebuilt from the criterion by the caller, never taken from the card.
 */
type RemovalCard = { profile: string; class: string; criterion: string; windowStart: number } | { refused: string };
export function parseRemovalCard(task: Pick<Task, "class" | "detail" | "history" | "title">): RemovalCard {
  if (task.class !== "plan" || task.history[0]?.by !== "hub") return { refused: "not a card the hub filed" };
  const first = task.detail.split("\n", 1)[0] ?? "";
  const match = /^Checklist removal key: ([^:\s]+):([^:\s]+):([^:\s]+):(\d{1,16})$/.exec(first);
  if (!match) return { refused: "not a checklist removal card (no removal key line first)" };
  const [, profile, cls, criterion, start] = match as unknown as [string, string, string, string, string];
  if (!PROFILE.test(profile) || !CLASS.test(cls) || !CRITERION.test(criterion) || !Number.isSafeInteger(Number(start))) return { refused: "the key line names a profile, class, criterion or window the hub would not accept" };
  if (task.title !== `Review checklist removal for ${profile}/${cls} criterion ${criterion}`) return { refused: "the card's title does not match its key line" };
  return { profile, class: cls, criterion, windowStart: Number(start) };
}
