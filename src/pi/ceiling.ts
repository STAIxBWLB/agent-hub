/**
 * The Pi tool-step ceiling signal (#179): the one structured record of the hub extension refusing a
 * managed tool call at its configured step limit. The trusted extension emits it over the bridge at the
 * actual rejection boundary; the adapter validates it here before it can classify anything. Free text
 * that merely resembles a ceiling never parses, and an unparsable or unbound signal leaves the failure
 * unknown, exactly as before #179.
 *
 * Counter semantics (the producer's contract):
 * - unit `tool-step`: one admitted managed-tool execution attempt — the extension's `execute` entry for
 *   a hub-registered tool, after execution-budget admission succeeds and before the tool runs.
 * - The rejected pre-effect invocation IS counted: the counter increments at that boundary, before the
 *   limit check, so the first rejection reports `count = limit + 1` and the refused call's side effect
 *   never executes.
 * - Failed tool calls count: the counter does not observe the outcome. A counted call is an execution
 *   attempt, never a proven successful effect.
 * - Calls refused by execution-budget admission (#102) do NOT count: admission precedes the counter.
 * - Reset: `agent_start` zeroes the counter and opens a new turn generation; it never resets mid-turn
 *   and never carries across turns.
 *
 * The signal carries fixed enums, counts and identity only — never tool arguments, paths, responses or
 * error text.
 */
export const PI_CEILING_KIND = "tool-step-ceiling" as const;
export const PI_CEILING_UNIT = "tool-step" as const;

export interface PiToolStepCeiling {
  kind: typeof PI_CEILING_KIND;
  unit: typeof PI_CEILING_UNIT;
  /** The producer's counter after counting the rejected pre-effect invocation: always > limit. */
  count: number;
  /** The configured ceiling (AGENTHUB_PI_MAX_STEPS). */
  limit: number;
  /** The extension's session id and turn generation the rejection belongs to; the adapter binds both. */
  sessionId: string;
  generation: number;
}

/**
 * Parse and validate a bridge ceiling event. Shape only — finite nonnegative safe-integer counts with
 * count > limit (a rejection means the counted counter passed the configured limit), the fixed kind and
 * unit, a non-empty bounded session id and a nonnegative turn generation. Session/turn binding to the
 * current adapter state is the caller's check, not this function's.
 */
export function piToolStepCeiling(value: unknown): PiToolStepCeiling | undefined {
  if (!value || typeof value !== "object") return undefined;
  const e = value as Record<string, unknown>;
  if (e.kind !== PI_CEILING_KIND || e.unit !== PI_CEILING_UNIT) return undefined;
  if (!Number.isSafeInteger(e.count) || (e.count as number) < 1) return undefined;
  if (!Number.isSafeInteger(e.limit) || (e.limit as number) < 0) return undefined;
  if ((e.count as number) <= (e.limit as number)) return undefined;
  if (typeof e.sessionId !== "string" || !e.sessionId || e.sessionId.length > 200) return undefined;
  if (!Number.isSafeInteger(e.generation) || (e.generation as number) < 0) return undefined;
  return { kind: PI_CEILING_KIND, unit: PI_CEILING_UNIT, count: e.count as number, limit: e.limit as number, sessionId: e.sessionId, generation: e.generation as number };
}
