import { parseEvery, scheduleKeyOf, type ScheduleEntry } from "./schedules.ts";

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
    `Caps: ${config.max_tokens_run} per run, ${config.max_tokens_week} per week. The hub counts this run's own tokens; at a cap it asks you for one checkpoint and then stops the task as escalated with reason "budget".`,
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

/**
 * #1329 part 2 (AC3): one card is in scope when the hub wrote its detail from the review schedule. The schedule marker is
 * written by `scheduledDetail` when the hub proposes the run, so a card a peer wrote cannot claim the scope, and the class
 * alone is never enough: an audit and a code review are `review`-class too and keep their memory tools.
 */
export function memoryReviewTask(task: { detail?: string } | undefined): boolean {
  return !!task && scheduleKeyOf(task.detail) === MEMORY_REVIEW_SCHEDULE_ID;
}

/** A tool's bare name: the MCP server prefix is the caller's transport, never part of the rule. */
const bareTool = (tool: string): string => tool.replace(/^mcp__[A-Za-z0-9_.-]{1,64}__/, "").toLowerCase();

/** Every hub tool a review card may call: reads, proposal-only memory writes, its own lifecycle and plain messages. */
const MEMORY_REVIEW_HUB_OPS: ReadonlySet<string> = new Set([
  "hub_memory_search", "hub_memory_show", "hub_memory_graph", "hub_memory_correct", "hub_remember",
  "hub_task_show", "hub_task_list", "hub_task_accept", "hub_task_decline", "hub_task_done", "hub_task_wait",
  "hub_checkpoint", "hub_task_escalate", "hub_send", "hub_inbox", "hub_specs", "hub_set_title", "hub_ask",
  "hub_delivery_retry", "hub_delivery_resolve", "hub_check_result", "hub_check_cancel", "hub_source_read",
  "hub_study_show", "hub_experiment_show", "hub_evidence_read", "hub_lineage_show", "hub_guidance_list",
  "hub_guidance_show", "hub_supervision_list", "hub_supervision_dismiss", "hub_permission_request",
]);

/** Memory reads, the consolidation preview and vault reads are the review's own inputs; they are allowed by name wherever they come from. */
const REVIEW_READS: ReadonlySet<string> = new Set([
  "amem_search", "amem_show", "amem_related", "amem_work_state_read", "amem_brief", "amem_consolidate", "amem_consolidate_preview",
  "vmem_search", "vmem_show", "vmem_list", "vmem_read", "vmem_get", "vmem_report", "vmem_links", "vmem_graph", "vmem_backlinks",
]);
/** Mutations a review may never make: accepting a candidate, or changing a note's tier, life or lineage. */
const MEMORY_MUTATIONS: ReadonlySet<string> = new Set([
  "memory_promote", "memory_demote", "memory_forget", "memory_supersede", "memory_accept",
  "amem_promote", "amem_demote", "amem_forget", "amem_supersede", "amem_accept", "amem_review_accept", "amem_review_reject",
  "hub_memory_promote", "hub_memory_demote", "hub_memory_forget", "hub_memory_supersede", "hub_memory_accept",
  "hub_learn_accept", "hub_learn_reject",
]);
const VAULT_WRITES: ReadonlySet<string> = new Set(["vmem_create", "vmem_patch", "vmem_move", "vmem_delete", "vmem_promote", "vmem_demote", "vmem_merge", "vmem_rewrite", "vmem_archive"]);
const CODE_EDITS: ReadonlySet<string> = new Set(["edit", "write", "multiedit", "notebookedit", "str_replace_editor", "apply_patch", "hub_check_start"]);
const PEER_STARTS: ReadonlySet<string> = new Set(["peer_start", "hub_peer_start", "hub_peer_hold", "hub_peer_release"]);

/**
 * The refusal sentence for one tool call inside a review card, or undefined when the call is allowed. Every refusal names
 * its cause and the next step the caller can take; none of them edits anything before it throws.
 */
export function memoryReviewScope(tool: string): string | undefined {
  if (typeof tool !== "string" || !tool) return undefined;
  const name = bareTool(tool);
  if (MEMORY_REVIEW_HUB_OPS.has(name) || REVIEW_READS.has(name)) return undefined;
  if (MEMORY_MUTATIONS.has(name)) return `${tool} changes shared memory, and a memory review only proposes: record it with hub_memory_correct or hub_remember for a person's amem review, and make the mutation in a turn outside this review task`;
  if (VAULT_WRITES.has(name)) return `${tool} writes a vault note, and a memory review reads the vault and writes none: report the finding with vmem report, and make the note change in a turn outside this review task`;
  if (CODE_EDITS.has(name)) return `${tool} edits code or runs a check, and a memory review changes no code: record the finding with hub_checkpoint, and make the edit in an ordinary task`;
  if (PEER_STARTS.has(name)) return `${tool} starts or holds a peer, and a memory review runs no other work: ask the person or the conductor to start it outside this review task`;
  if (name.startsWith("hub_")) return `${tool} is outside a memory-review card's scope (memory reads and proposals, checkpoint, done, messaging, specs and supervision reads): record the need with hub_checkpoint, and do it in an ordinary task`;
  return undefined;
}

/** #1329 AC4: a review's note text is a candidate attributed to the card and to the peer that wrote it. */
interface ReviewCandidateInput { text: string; title?: string; noteKind?: "decision" | "finding" | "contract" | "fail" | "preference" }
export function memoryReviewCandidate(input: ReviewCandidateInput, task: number, peer: string, at = new Date()): { input: { kind: "memory"; text: string; title?: string; noteKind?: ReviewCandidateInput["noteKind"]; about: string[] }; origin: { peer: string; at: string } } {
  return {
    input: { kind: "memory", text: input.text, ...(input.title ? { title: input.title } : {}), ...(input.noteKind ? { noteKind: input.noteKind } : {}), about: [`task:${task}`] },
    origin: { peer, at: at.toISOString() },
  };
}

/** The counted spend one review has made, in the hub's own tokens (never an estimate). */
export interface ReviewSpend { run: number; week: number }
interface ReviewBudgetStop { cap: "run" | "week"; used: number; limit: number }

/**
 * #1329 AC5: whether a review has reached either cap. A cap that is unset cannot stop anything, and a reading equal to the
 * cap is a stop: the run's allowance is spent, and one more turn would exceed it.
 */
export function reviewBudgetStop(spend: ReviewSpend, config: Pick<MemoryReviewConfig, "max_tokens_run" | "max_tokens_week">): ReviewBudgetStop | undefined {
  const run = config.max_tokens_run, week = config.max_tokens_week;
  if (run !== undefined && spend.run >= run) return { cap: "run", used: spend.run, limit: run };
  if (week !== undefined && spend.week >= week) return { cap: "week", used: spend.week, limit: week };
  return undefined;
}

/** The checkpoint the peer is asked for before the card stops, and the note the escalation records (counts only). */
export const reviewCheckpointRequest = (task: number, stop: ReviewBudgetStop): string =>
  `Memory review task #${task} reached its ${stop.cap} token cap (${stop.used} of ${stop.limit}). First call hub_checkpoint with what you reviewed, the proposals you filed and what is left, then stop: the hub escalates the task with reason "budget".`;
export const reviewBudgetNote = (task: number, stop: ReviewBudgetStop, spend: ReviewSpend): string =>
  `memory review budget: task #${task} spent ${spend.run} tokens this run and ${spend.week} this week; the ${stop.cap} cap is ${stop.limit}, so the run stopped.`;

/** #1329: the done summary and the research record carry counts only, never a note or a line of the reviewed text. */
interface MemoryReviewCounts { notes: number; corrections: number; remembered: number; originsFound: number; originsExpired: number; tokens: number }
export function memoryReviewCountLine(counts: Partial<MemoryReviewCounts>): string {
  const n = (value: number | undefined) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown");
  return `memory review counts: notes checked ${n(counts.notes)}, proposals ${n(counts.corrections)} corrections and ${n(counts.remembered)} notes, origin sessions ${n(counts.originsFound)} found and ${n(counts.originsExpired)} expired, tokens ${n(counts.tokens)}`;
}
