import { createHash } from "node:crypto";

/** Safe, process-local view of the most recent machine memory sync. */
export type MemorySyncCause = "declined" | "remote" | "binding" | "stopped" | "transport" | "writer" | "unknown";
/** Closed words of a refused writer attestation (agent-mem `PlacementWriterContextError`); never its message, a path or a version. */
export interface MemorySyncWriterRefusal { writerCategory?: string; writerCauseClass?: string }
export const WRITER_CATEGORIES: readonly string[] = ["running CLI", "host package", "setup receipt", "declared writer", "active locator", "home floor", "writer renewal", "unknown"];
export const WRITER_CAUSE_CLASSES: readonly string[] = ["missing", "changed", "unavailable"];
const closedWriter = (value: unknown, allowed: readonly string[]): string | undefined => typeof value === "string" && allowed.includes(value) ? value : undefined;
export interface MemorySyncPlacementCounts { withheldCount: number; exportedCount: number }
export type MemorySyncOutcome =
  | { state: "notrun" }
  | { state: "not-configured"; at: number }
  | { state: "stopped"; at: number }
  | { state: "ok"; at: number; withheldCount?: number; exportedCount?: number }
  | { state: "failed"; at: number; cause: MemorySyncCause; declinedCount?: number; declinedIdsKnown?: false; placementActive?: false } & MemorySyncWriterRefusal;

export interface MemorySyncState {
  outcome: MemorySyncOutcome;
  /** Private dedupe key: never include this in a status or log line. */
  failureSignature?: string;
}

export type MemorySyncEvent =
  | { type: "success"; at: number; withheldCount?: number; exportedCount?: number }
  | { type: "quiet"; at: number; state: "not-configured" | "stopped" }
  | { type: "failure"; at: number; cause: MemorySyncCause; declinedCount?: number; declinedIdsFingerprint?: string; declinedIdsKnown?: false; failureDetailHash?: string; placementActive?: false } & MemorySyncWriterRefusal;

export const initialMemorySyncState = (): MemorySyncState => ({ outcome: { state: "notrun" } });
const MAX_DECLINED_ROWS = 20_000;

function placementCounts(withheldCount: unknown, exportedCount: unknown): MemorySyncPlacementCounts | undefined {
  if (typeof withheldCount !== "number" || !Number.isSafeInteger(withheldCount) || withheldCount < 0
    || typeof exportedCount !== "number" || !Number.isSafeInteger(exportedCount) || exportedCount < 0) return undefined;
  return { withheldCount, exportedCount };
}

/** Project only public counts from a completed placement publication, never its retained hashes or policy metadata. */
export function memorySyncPlacementCounts(value: unknown): MemorySyncPlacementCounts | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const read = (key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable && "value" in field ? field.value : undefined;
    };
    const outcome = read("outcome");
    if (outcome !== "committed" && outcome !== "not-needed") return undefined;
    return placementCounts(read("withheld"), read("exported"));
  } catch { return undefined; }
}

/** Reduces one completed sync. The boolean says whether this failure is a new loggable episode. */
export function reduceMemorySync(state: MemorySyncState, event: MemorySyncEvent): { state: MemorySyncState; logFailure: boolean } {
  if (event.type === "success") return { state: { outcome: { state: "ok", at: event.at, ...placementCounts(event.withheldCount, event.exportedCount) } }, logFailure: false };
  if (event.type === "quiet") return { state: { outcome: { state: event.state, at: event.at } }, logFailure: false };
  const signature = [event.cause, event.declinedCount ?? "", event.declinedIdsFingerprint ?? (event.declinedIdsKnown === false ? "ids-unknown" : ""), event.failureDetailHash ?? "", event.cause === "writer" ? closedWriter(event.writerCategory, WRITER_CATEGORIES) ?? "" : "", event.cause === "writer" ? closedWriter(event.writerCauseClass, WRITER_CAUSE_CLASSES) ?? "" : ""].join("\0");
  const changed = state.failureSignature !== signature;
  return {
    state: { outcome: { state: "failed", at: event.at, cause: event.cause, ...(event.declinedCount === undefined ? {} : { declinedCount: event.declinedCount }), ...(event.declinedIdsKnown === false ? { declinedIdsKnown: false as const } : {}), ...(event.cause === "declined" && event.placementActive === false ? { placementActive: false as const } : {}), ...writerFields(event) }, failureSignature: signature },
    logFailure: changed,
  };
}

function writerFields(value: { cause?: string } & MemorySyncWriterRefusal): MemorySyncWriterRefusal {
  if (value.cause !== "writer") return {};
  const writerCategory = closedWriter(value.writerCategory, WRITER_CATEGORIES), writerCauseClass = closedWriter(value.writerCauseClass, WRITER_CAUSE_CLASSES);
  return { ...(writerCategory ? { writerCategory } : {}), ...(writerCauseClass ? { writerCauseClass } : {}) };
}

export interface MemorySyncView {
  state: "disabled" | "unavailable" | "notrun" | "not-configured" | "stopped" | "ok" | "failed" | "unknown";
  at?: number;
  cause?: MemorySyncCause;
  declinedCount?: number;
  declinedIdsKnown?: false;
  withheldCount?: number;
  exportedCount?: number;
  placementActive?: false;
  writerCategory?: string;
  writerCauseClass?: string;
  nextStep?: string;
}

export function memorySyncNextStep(cause: MemorySyncCause): string {
  return cause === "declined" ? "ahub memory declined"
    : cause === "remote" ? "configure a private sync remote"
    : cause === "binding" ? "ahub memory profile-check"
    : cause === "stopped" ? "retry after hub restart"
    : cause === "writer" ? "repair the amem install and its host pin, then a person runs amem migrate --sync-placement --dry-run"
    : "run ahub memory sync as a person";
}

/** Public status projection. It never includes an id, error string, path, home or fingerprint. */
export function memorySyncView(state: MemorySyncState, availability: "enabled" | "disabled" | "unavailable" | "unknown"): MemorySyncView {
  if (availability !== "enabled") return { state: availability };
  const outcome = state.outcome;
  if (outcome.state === "notrun") return { state: "notrun" };
  if (outcome.state === "not-configured") return { state: "not-configured", at: outcome.at, nextStep: memorySyncNextStep("remote") };
  if (outcome.state === "stopped") return { state: "stopped", at: outcome.at, nextStep: memorySyncNextStep("stopped") };
  if (outcome.state === "ok") return { state: "ok", at: outcome.at, ...placementCounts(outcome.withheldCount, outcome.exportedCount) };
  return {
    state: "failed", at: outcome.at, cause: outcome.cause,
    ...(outcome.declinedCount === undefined ? {} : { declinedCount: outcome.declinedCount }),
    ...(outcome.declinedIdsKnown === false ? { declinedIdsKnown: false } : {}),
    ...(outcome.cause === "declined" && outcome.placementActive === false ? { placementActive: false } : {}),
    ...writerFields(outcome),
    nextStep: memorySyncNextStep(outcome.cause),
  };
}

/** Map the upstream free-form reason into a closed, non-sensitive status cause. */
export function classifyMemorySyncFailure(error: unknown): { cause: "declined"; declinedCount: number } | { cause: Exclude<MemorySyncCause, "declined">; declinedCount?: never } {
  const text = typeof error === "string" ? error : "";
  const declined = /^the configured privacy policy declines (\d+) long-term entr(y|ies) \([^()\r\n]*\); fix the entry or the policy, then sync again$/.exec(text);
  if (declined) {
    const count = Number(declined[1]);
    const singular = declined[2] === "y";
    if (Number.isSafeInteger(count) && count > 0 && count <= MAX_DECLINED_ROWS && (count === 1) === singular)
      return { cause: "declined", declinedCount: count };
    return { cause: "unknown" };
  }
  if (text === "stopped") return { cause: "stopped" };
  if (text === "no sync remote: a person sets one with `amem sync --remote <private git url>`"
    || text === "no generation sync remote configured"
    || text === "no shard sync remote configured"
    || text === "the sync remote is public; memory syncs only to a private remote"
    || text === "generation sync remote is invalid"
    || text === "generation sync requires positively verified private remote visibility"
    || text === "generation remote lookup failed"
    || text === "generation remote branch identity mismatch") return { cause: "remote" };
  if (text === "binding changed" || text === "sharded sync binding or policy unavailable or changed"
    || text === "generation profile unavailable") return { cause: "binding" };
  if (["git init failed: ", "the remote could not be set: ", "git add failed: ", "commit failed: ", "fetch failed: ", "checkout failed: ", "merge failed: ", "push failed: ",
    "generation staging failed", "generation commit failed", "generation fetch failed", "generation push failed"].some(prefix => text.startsWith(prefix))) return { cause: "transport" };
  return { cause: "unknown" };
}
export function memorySyncFailureDetailHash(error: unknown): string {
  const canonical = typeof error === "string" ? error : "<missing-or-non-string-error>";
  return createHash("sha256").update(canonical).digest("hex");
}

export interface DeclinedMemoryInspection {
  rows: readonly { id: string }[];
  declinedIdsFingerprint: string;
  complete: boolean;
}

/** Use complete all-target inspection when available; otherwise keep the package's first-target count and say ids are unknown. */
export function memorySyncDeclinedDetails(
  canonical: { cause: "declined"; declinedCount: number },
  inspection?: DeclinedMemoryInspection,
): { cause: "declined"; declinedCount: number; declinedIdsFingerprint?: string; declinedIdsKnown?: false } {
  const fingerprintValid = /^[a-f0-9]{64}$/.test(inspection?.declinedIdsFingerprint ?? "");
  const idsAvailable = !!inspection && inspection.rows.every(row => typeof row.id === "string" && row.id !== "(no id)");
  if (inspection?.complete && inspection.rows.length > 0 && inspection.rows.length <= MAX_DECLINED_ROWS && fingerprintValid && idsAvailable) {
    return { cause: "declined", declinedCount: inspection.rows.length, declinedIdsFingerprint: inspection.declinedIdsFingerprint };
  }
  return { ...canonical, declinedIdsKnown: false };
}
