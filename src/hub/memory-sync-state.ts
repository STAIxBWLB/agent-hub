import { createHash } from "node:crypto";

/** Safe, process-local view of the most recent machine memory sync. */
export type MemorySyncCause = "declined" | "remote" | "binding" | "stopped" | "transport" | "unknown";
export type MemorySyncOutcome =
  | { state: "notrun" }
  | { state: "not-configured" | "stopped"; at: number }
  | { state: "ok"; at: number }
  | { state: "failed"; at: number; cause: MemorySyncCause; declinedCount?: number; declinedIdsKnown?: false };

export interface MemorySyncState {
  outcome: MemorySyncOutcome;
  /** Private dedupe key: never include this in a status or log line. */
  failureSignature?: string;
}

export type MemorySyncEvent =
  | { type: "success"; at: number }
  | { type: "quiet"; at: number; state: "not-configured" | "stopped" }
  | { type: "failure"; at: number; cause: MemorySyncCause; declinedCount?: number; declinedIdsFingerprint?: string; declinedIdsKnown?: false; failureDetailHash?: string };

export const initialMemorySyncState = (): MemorySyncState => ({ outcome: { state: "notrun" } });
const MAX_DECLINED_ROWS = 20_000;

/** Reduces one completed sync. The boolean says whether this failure is a new loggable episode. */
export function reduceMemorySync(state: MemorySyncState, event: MemorySyncEvent): { state: MemorySyncState; logFailure: boolean } {
  if (event.type === "success") return { state: { outcome: { state: "ok", at: event.at } }, logFailure: false };
  if (event.type === "quiet") return { state: { outcome: { state: event.state, at: event.at } }, logFailure: false };
  const signature = [event.cause, event.declinedCount ?? "", event.declinedIdsFingerprint ?? (event.declinedIdsKnown === false ? "ids-unknown" : ""), event.failureDetailHash ?? ""].join("\0");
  const changed = state.failureSignature !== signature;
  return {
    state: { outcome: { state: "failed", at: event.at, cause: event.cause, ...(event.declinedCount === undefined ? {} : { declinedCount: event.declinedCount }), ...(event.declinedIdsKnown === false ? { declinedIdsKnown: false as const } : {}) }, failureSignature: signature },
    logFailure: changed,
  };
}

export interface MemorySyncView {
  state: "disabled" | "unavailable" | "notrun" | "not-configured" | "stopped" | "ok" | "failed" | "unknown";
  at?: number;
  cause?: MemorySyncCause;
  declinedCount?: number;
  declinedIdsKnown?: false;
  nextStep?: string;
}

export function memorySyncNextStep(cause: MemorySyncCause): string {
  return cause === "declined" ? "ahub memory declined"
    : cause === "remote" ? "configure a private sync remote"
    : cause === "binding" ? "ahub memory profile-check"
    : cause === "stopped" ? "retry after hub restart"
    : "run ahub memory sync as a person";
}

/** Public status projection. It never includes an id, error string, path, home or fingerprint. */
export function memorySyncView(state: MemorySyncState, availability: "enabled" | "disabled" | "unavailable" | "unknown"): MemorySyncView {
  if (availability !== "enabled") return { state: availability };
  const outcome = state.outcome;
  if (outcome.state === "notrun") return { state: "notrun" };
  if (outcome.state === "not-configured") return { state: "not-configured", at: outcome.at, nextStep: memorySyncNextStep("remote") };
  if (outcome.state === "stopped") return { state: "stopped", at: outcome.at, nextStep: memorySyncNextStep("stopped") };
  if (outcome.state === "ok") return { state: "ok", at: outcome.at };
  return {
    state: "failed", at: outcome.at, cause: outcome.cause,
    ...(outcome.declinedCount === undefined ? {} : { declinedCount: outcome.declinedCount }),
    ...(outcome.declinedIdsKnown === false ? { declinedIdsKnown: false } : {}),
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
