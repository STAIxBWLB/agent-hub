import { parseEvery, type ScheduleEntry } from "./schedules.ts";

// #1329 part 1: the scheduled memory review is a `review`-class task built from one fixed template, driven by one
// machine-local schedule. Nothing here reads the board, a clock, a file or a memory store: the config in, an entry out.

/**
 * The schedule id the review runs under, in the same machine-local store as the configured schedules, so the timer,
 * `ahub schedule list`, the open-task rule and the pause epoch read it exactly like a configured entry. The id is
 * fixed, never configurable: one review per project, and a person turns it off rather than filing a second one.
 */
export const MEMORY_REVIEW_SCHEDULE_ID = "memory-review";

/** Notes one run may review. The template names the cap; the run reads no note itself. */
export const MEMORY_REVIEW_MAX_NOTES = 200;
/** Projects named in one config: enough for a person's own projects, never a machine-wide sweep. */
const MEMORY_REVIEW_MAX_PROJECTS = 16;
/** A token cap is a whole count the person sets; this only keeps a typo out of the scheduler's arithmetic. */
export const MEMORY_REVIEW_CAP_MAX = 100_000_000;

export interface MemoryReviewConfig {
  /** Off until a person turns it on with both caps set (AC1). */
  enabled: boolean;
  /** `<n>m`, `<n>h` or `<n>d`, the same spelling a configured schedule takes. */
  every: string;
  /** Project paths or directory names the review runs for; empty means every project this machine holds. */
  projects: string[];
  /** The peer the card is filed for; unset leaves the role's own owner choice to routing. */
  peer?: string;
  max_notes: number;
  /** Both are required to enable: a run and a week, so one runaway review cannot spend the week's allowance. */
  max_tokens_run?: number;
  max_tokens_week?: number;
}

export const MEMORY_REVIEW_DEFAULTS: MemoryReviewConfig = { enabled: false, every: "1d", projects: [], max_notes: 20 };

const KEYS = new Set(["enabled", "every", "projects", "peer", "max_notes", "max_tokens_run", "max_tokens_week"]);
const PEER = /^[a-z][a-z0-9-]{0,31}$/;
const control = /[\x00-\x1f\x7f]/;
const cap = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MEMORY_REVIEW_CAP_MAX) throw new Error(`memory.review.${name} must be a whole token count from 1 to ${MEMORY_REVIEW_CAP_MAX}`);
  return value as number;
};

/**
 * The checked `memory.review` block. Enabling without both caps is refused here, in the config path, so no daemon ever
 * schedules a review whose spend nothing bounds (#1329 AC1). Every other refusal names the key it is about.
 */
export function memoryReviewConfig(input: unknown): MemoryReviewConfig {
  if (input === undefined) return { ...MEMORY_REVIEW_DEFAULTS };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("memory.review must be an object");
  const row = input as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!KEYS.has(key)) throw new Error(`memory.review has no key ${key}`);
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error("memory.review.enabled must be true or false");
  let every = MEMORY_REVIEW_DEFAULTS.every;
  if (row.every !== undefined) {
    try { parseEvery(row.every); } catch (error) { throw new Error(`memory.review.${(error as Error).message}`); }
    every = row.every as string;
  }
  const projects: string[] = [];
  if (row.projects !== undefined) {
    if (!Array.isArray(row.projects) || row.projects.length > MEMORY_REVIEW_MAX_PROJECTS) throw new Error(`memory.review.projects is a list of at most ${MEMORY_REVIEW_MAX_PROJECTS} project paths or directory names`);
    for (const entry of row.projects) {
      if (typeof entry !== "string" || !entry.trim() || entry.length > 300 || control.test(entry)) throw new Error("memory.review.projects entries are project paths or directory names of at most 300 printable characters");
      if (!projects.includes(entry)) projects.push(entry);
    }
  }
  if (row.peer !== undefined && (typeof row.peer !== "string" || !PEER.test(row.peer))) throw new Error("memory.review.peer is a peer id");
  let maxNotes = MEMORY_REVIEW_DEFAULTS.max_notes;
  if (row.max_notes !== undefined) {
    if (!Number.isInteger(row.max_notes) || (row.max_notes as number) < 1 || (row.max_notes as number) > MEMORY_REVIEW_MAX_NOTES) throw new Error(`memory.review.max_notes must be a whole number of notes from 1 to ${MEMORY_REVIEW_MAX_NOTES}`);
    maxNotes = row.max_notes as number;
  }
  const run = row.max_tokens_run === undefined ? undefined : cap(row.max_tokens_run, "max_tokens_run");
  const week = row.max_tokens_week === undefined ? undefined : cap(row.max_tokens_week, "max_tokens_week");
  if (run !== undefined && week !== undefined && week < run) throw new Error("memory.review.max_tokens_week must be at least memory.review.max_tokens_run, or one run could not finish inside its own week");
  const enabled = row.enabled === true;
  if (enabled && (run === undefined || week === undefined)) throw new Error("memory.review.enabled needs both caps: set memory.review.max_tokens_run and memory.review.max_tokens_week, then run ahub memory review on");
  return { enabled, every, projects, ...(row.peer === undefined ? {} : { peer: row.peer as string }), max_notes: maxNotes, ...(run === undefined ? {} : { max_tokens_run: run }), ...(week === undefined ? {} : { max_tokens_week: week }) };
}

/** Whether this project is one the review was turned on for: an exact path, or the directory name of one. */
function memoryReviewSelects(config: { projects?: string[] } | undefined, project: string): boolean {
  const projects = config?.projects ?? [];
  if (!projects.length) return true;
  const name = project.split("/").filter(Boolean).pop();
  return projects.some(selected => selected === project || selected === name);
}

/**
 * The card's words: one fixed template, so a person reading the board sees the same scope every run and the review
 * cannot be widened by whatever a scheduler happened to remember. The inputs are the notes whose code anchors moved
 * (`ahub memory stale-anchors`), which is the only input agent-mem exposes before agent-mem#324.
 */
function memoryReviewTemplate(config: MemoryReviewConfig, project: string): string {
  return [
    `The machine-local memory.review switch schedules this review for ${project} every ${config.every ?? MEMORY_REVIEW_DEFAULTS.every}.`,
    "",
    `List the inputs with \`ahub memory stale-anchors --json\` and review only the notes it reports as stale, at most ${config.max_notes ?? MEMORY_REVIEW_DEFAULTS.max_notes}.`,
    "For each note, either re-point the anchor it names or report the note as no longer true; change no code and no note outside that list.",
    `Caps: ${config.max_tokens_run} per run, ${config.max_tokens_week} per week. The hub counts no tokens for a review turn yet, so these are declared and the budget stop that enforces them lands with #1329 part 2.`,
  ].join("\n");
}

/**
 * The schedule entry the config stands for, or undefined when the review is off or this project is not selected. The
 * daemon reads this at every schedule path, so it must be total over the live config object: a reload applies one key at a
 * time, and a block missing a scalar is read with the default here rather than throwing inside a status reply.
 *
 * The block is validated again here rather than trusted, and that is deliberate: `memoryReviewConfig` is the one place the
 * both-caps rule (AC1) lives, so a live block a key-by-key reload left half applied schedules nothing, and the entry cannot
 * come back for a review nothing bounds without the rule itself changing.
 */
export function memoryReviewEntry(config: Partial<MemoryReviewConfig> | undefined, project: string): ScheduleEntry | undefined {
  if (config?.enabled !== true) return undefined;
  if (!memoryReviewSelects(config, project)) return undefined;
  // A block the validator would refuse schedules nothing. This runs inside status and the schedules pass, so it fails closed
  // rather than throwing there; the config write is what names the key at fault.
  let selected: MemoryReviewConfig;
  try { selected = memoryReviewConfig({ ...MEMORY_REVIEW_DEFAULTS, ...config }); } catch { return undefined; }
  return {
    id: MEMORY_REVIEW_SCHEDULE_ID, every: selected.every, class: "review",
    title: "Memory review: notes whose code anchors no longer resolve",
    detail: memoryReviewTemplate(selected, project), ...(selected.peer ? { owner: selected.peer } : {}), queue: "backlog",
  };
}
