// Friction classifier (#1644 T2). One function, used by every mode: a block is a refusal that stops a person or agent.
// If its text names a continuation that parses, the runner executes that continuation and repeats the blocked step:
// progress makes the block `in_band`, no progress `dead_end`, no continuation `out_of_band`, a marker `by_design`.

export type FrictionClass = "in_band" | "out_of_band" | "dead_end" | "by_design";
export interface StepRun { argv: string[]; exitCode: number; output: string }
export interface Continuation { argv: string[]; text: string }

/** A block marker: a refusal that is closed on purpose says so, reusing the refusal check's marker vocabulary. */
export const BY_DESIGN_MARKER = /\b(?:by design|refusal-ok|person only)\b/i;

/** A block today is a non-zero exit. The spec's second kind, a refusal envelope from a hub tool call, needs a tool-call step kind (T3) and is not checked here. */
export function isBlock(run: StepRun): boolean {
  return run.exitCode !== 0;
}

/** Split a command line the way a person would type it: single and double quotes group, nothing else is shell. */
export function splitCommand(text: string): string[] | undefined {
  const words: string[] = [];
  let current = "", quote = "", started = false;
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; else current += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started || current) { words.push(current); current = ""; started = false; } continue; }
    if ("|&;<>`$(){}\\".includes(char)) return undefined;
    current += char; started = true;
  }
  if (quote) return undefined;
  if (started || current) words.push(current);
  return words.length ? words : undefined;
}

/** The first runnable continuation a block names: a line that starts with `ahub ` (optionally after a run-in word) or sits in backticks. */
export function continuationOf(output: string): Continuation | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const quoted = /`(ahub [^`]+)`/.exec(line)?.[1];
    const candidate = quoted ?? /(?:^|:\s+|run\s+)(ahub\s+\S.*)$/.exec(line)?.[1];
    if (!candidate) continue;
    const split = splitCommand(candidate.replace(/[).;,]+$/, ""));
    if (!split || split[0] !== "ahub") continue;
    // ponytail: prose after a command ("run ahub init there first") is cut at the first stop word; ceiling: a command whose own argument is a stop word; upgrade: the structured continuation marker of the refusal check (#1643).
    const stop = split.findIndex((word, at) => at > 1 && PROSE_STOP.has(word.toLowerCase()));
    const words = stop < 0 ? split : split.slice(0, stop);
    if (words.length < 2) continue;
    if (words.some(word => /^<.*>$|^\[.*\]$|^\.\.\.$/.test(word))) continue;
    return { argv: words.slice(1), text: words.join(" ") };
  }
  return undefined;
}

const PROSE_STOP = new Set(["there", "first", "then", "again", "now", "before", "after", "once", "if", "and", "or", "to", "so", "because"]);

export interface Classification { class: FrictionClass; continuation?: string; retried?: StepRun }

/**
 * Classify one block. `runContinuation` executes a continuation in the same isolated hub; `retry` repeats the blocked step.
 * Progress means the repeated step is no longer blocked: it exits zero.
 */
export async function classifyBlock(
  block: StepRun,
  runContinuation: (argv: string[]) => Promise<StepRun>,
  retry: () => Promise<StepRun>,
): Promise<Classification> {
  if (BY_DESIGN_MARKER.test(block.output)) return { class: "by_design" };
  const continuation = continuationOf(block.output);
  if (!continuation) return { class: "out_of_band" };
  await runContinuation(continuation.argv);
  const retried = await retry();
  return retried.exitCode === 0 ? { class: "in_band", continuation: continuation.text, retried } : { class: "dead_end", continuation: continuation.text, retried };
}
