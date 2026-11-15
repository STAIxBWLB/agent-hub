import { PreEffectToolRefusal } from "./tool-refusal.ts";

/**
 * #1331: the optional structured fields of `hub_checkpoint`, next to the free-text `summary` (kept for compatibility).
 * The order below is the fixed order they render in, in the handoff prompt to the next owner and in the private context-checkpoint
 * file. A field the caller left out is omitted, never invented. A field over its limit is refused with the limit named, never cut.
 */
export const CHECKPOINT_FIELDS = ["done", "in_progress", "next", "verified_by", "traps"] as const;
export type CheckpointField = (typeof CHECKPOINT_FIELDS)[number];
export type CheckpointFields = Partial<Record<CheckpointField, string>>;

/** The heading each field renders under, and the heading the checkpoint request asks the agent to use in `.agenthub/checkpoint.md`. */
export const CHECKPOINT_HEADINGS: Record<CheckpointField, string> = { done: "Done", in_progress: "In progress", next: "Next", verified_by: "Verified by", traps: "Traps" };

/** Each field: at most this many lines of at most this many characters. */
export const CHECKPOINT_FIELD_MAX_LINES = 5;
export const CHECKPOINT_FIELD_MAX_LINE_CHARS = 200;
/**
 * The rendered text (summary and fields together) stays within what a handoff keeps today: `Tasks.sendTask` slices the handoff context
 * to 3000 characters, so a longer structured checkpoint would lose its last field (`traps`) silently. A summary-only call keeps its
 * existing behavior and is not held to this number.
 */
export const CHECKPOINT_TOTAL_MAX_CHARS = 3000;

const chars = (text: string): number => [...text].length;

/** The structured fields of one call, validated. Throws `PreEffectToolRefusal` (nothing is written yet) naming the field and the limit. */
export function parseCheckpointFields(args: Record<string, unknown>): CheckpointFields {
  const out: CheckpointFields = {};
  for (const name of CHECKPOINT_FIELDS) {
    const raw = args[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") throw new PreEffectToolRefusal(`checkpoint field ${name} must be a string`);
    const value = raw.replace(/\r\n?/g, "\n").trim();
    if (!value) continue;
    const lines = value.split("\n");
    if (lines.length > CHECKPOINT_FIELD_MAX_LINES) throw new PreEffectToolRefusal(`checkpoint field ${name} has ${lines.length} lines; the limit is ${CHECKPOINT_FIELD_MAX_LINES} lines`);
    const long = lines.findIndex(line => chars(line) > CHECKPOINT_FIELD_MAX_LINE_CHARS);
    if (long >= 0) throw new PreEffectToolRefusal(`checkpoint field ${name} line ${long + 1} has ${chars(lines[long]!)} characters; the limit is ${CHECKPOINT_FIELD_MAX_LINE_CHARS} characters per line`);
    out[name] = value;
  }
  return out;
}

/** How many structured fields a checkpoint carried (0 for a summary-only call). */
export const checkpointFieldCount = (fields: CheckpointFields): number => CHECKPOINT_FIELDS.filter(name => fields[name] !== undefined).length;

/**
 * The summary first, as written, then each present field in the fixed order under its heading. With no field the result is the summary
 * unchanged, byte for byte. With fields, a total over `CHECKPOINT_TOTAL_MAX_CHARS` is refused (never truncated).
 */
export function renderCheckpoint(summary: string, fields: CheckpointFields): string {
  if (checkpointFieldCount(fields) === 0) return summary;
  const text = [summary, ...CHECKPOINT_FIELDS.filter(name => fields[name] !== undefined).map(name => `${CHECKPOINT_HEADINGS[name]}:\n${fields[name]}`)].join("\n\n");
  if (chars(text) > CHECKPOINT_TOTAL_MAX_CHARS) throw new PreEffectToolRefusal(`checkpoint is ${chars(text)} characters with its fields; the limit is ${CHECKPOINT_TOTAL_MAX_CHARS} characters in total`);
  return text;
}

/** The sentence the checkpoint requests and the tool description use to name the fields, in the render order. */
export const CHECKPOINT_FIELDS_SENTENCE = `Optional structured fields, each at most ${CHECKPOINT_FIELD_MAX_LINES} lines of ${CHECKPOINT_FIELD_MAX_LINE_CHARS} characters: ${CHECKPOINT_FIELDS.map(name => `${name} (${CHECKPOINT_HEADINGS[name].toLowerCase()})`).join(", ")}. Use the same headings in .agenthub/checkpoint.md.`;
