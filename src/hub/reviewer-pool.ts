import { reviewBudgetAdmission, type ReviewBudgetSnapshot } from "./review-budget.ts";
export type ReviewerPoolReason = "rotation" | "implementer skip" | "unavailable skip" | "same-family fallback";
export interface ReviewerPoolCandidate { id: string; kind: string; family: string; blocked?: string }
export interface ReviewerPoolInput {
  pool: readonly string[];
  candidates: readonly ReviewerPoolCandidate[];
  implementerFamily?: string;
  seed: number;
  continuityFamily?: string;
  rerotate?: boolean;
  failed?: readonly string[];
  /** `never` (#820): an implementer-family candidate is never selected, not even as the last resort. */
  sameFamily?: "fallback" | "never";
  budget?: ReviewBudgetSnapshot;
  waitForReset?: boolean;
}
export interface ReviewerPoolSelection {
  reviewer: string | null;
  family?: string;
  reason?: ReviewerPoolReason;
  walk: readonly { id: string; kind: string; family: string; reason: string }[];
  blocked?: "no reviewer can run";
  quotaWait?: { resetsAt: number; candidates: readonly { id: string; state: "paused" | "floor"; resetsAt: number }[] };
}

/** Pure selection: caller supplies declared candidates and current availability, never inferred authority. */
export function selectReviewerPool(input: ReviewerPoolInput): ReviewerPoolSelection {
  const kinds = [...new Set(input.pool)];
  const walk: { id: string; kind: string; family: string; reason: string }[] = [];
  if (!kinds.length) return { reviewer: null, walk, blocked: "no reviewer can run" };
  // A configured kind without any declaration cannot take a modulo share from actual reviewers.
  // Blocked declarations still own their slot: current availability never changes the denominator.
  const declaredKinds = kinds.filter(kind => input.candidates.some(candidate => candidate.kind === kind));
  const undeclared = kinds.filter(kind => !declaredKinds.includes(kind)).map(kind => ({ id: "", kind, family: "", reason: "no declared reviewer" }));
  const finish = (selection: Omit<ReviewerPoolSelection, "walk">): ReviewerPoolSelection => {
    let quotaWait: ReviewerPoolSelection["quotaWait"];
    if (selection.reviewer === null && input.budget && input.waitForReset !== false) {
      const candidates = input.candidates.filter(candidate => kinds.includes(candidate.kind)), failed = new Set(input.failed ?? []);
      const waiting = candidates.map(candidate => ({ candidate, reading: reviewBudgetAdmission(candidate.id, input.budget!) }));
      if (waiting.length && waiting.every(({ candidate, reading }) => !failed.has(candidate.id)
        && !(input.sameFamily === "never" && candidate.family === input.implementerFamily)
        && (candidate.blocked === undefined || candidate.blocked === "paused" && reading.state === "paused" || candidate.blocked === "quota exhausted" && (reading.state === "paused" || reading.state === "floor"))
        && (reading.state === "paused" || reading.state === "floor") && reading.resetsAt !== undefined)) {
        const rows = waiting.map(({ candidate, reading }) => ({ id: candidate.id, state: reading.state as "paused" | "floor", resetsAt: reading.resetsAt! }));
        quotaWait = { resetsAt: Math.min(...rows.map(row => row.resetsAt)), candidates: rows };
      }
    }
    return { ...selection, walk: [...walk, ...undeclared], ...(quotaWait ? { quotaWait } : {}) };
  };
  if (!declaredKinds.length) return finish({ reviewer: null, blocked: "no reviewer can run" });
  const seed = Number.isSafeInteger(input.seed) ? input.seed : 0;
  const start = ((seed % declaredKinds.length) + declaredKinds.length) % declaredKinds.length;
  const rotated = [...declaredKinds.slice(start), ...declaredKinds.slice(0, start)];
  const slots = rotated.flatMap(kind => {
    const declared = input.candidates.filter(candidate => candidate.kind === kind).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return declared;
  });
  let ordered = slots;
  // Preserve the rotated order within each family, including sibling instance ids.
  const continuity = !input.rerotate && input.continuityFamily !== undefined && input.continuityFamily !== input.implementerFamily;
  if (continuity) ordered = [...ordered.filter(candidate => candidate.family === input.continuityFamily), ...ordered.filter(candidate => candidate.family !== input.continuityFamily)];
  const failed = new Set(input.failed ?? []);
  let skippedOwner = false, skippedUnavailable = false;
  const unavailable = (candidate: ReviewerPoolCandidate) => {
    if (failed.has(candidate.id)) return "start failed for this review";
    const quota = input.budget ? reviewBudgetAdmission(candidate.id, input.budget) : undefined;
    if (candidate.blocked !== undefined && !(candidate.blocked === "paused" && quota?.state === "paused")
      && !(candidate.blocked === "quota exhausted" && (quota?.state === "paused" || quota?.state === "floor"))) return candidate.blocked;
    return quota && quota.state !== "available" ? quota.reason : candidate.blocked;
  };
  const record = (candidate: ReviewerPoolCandidate, reason: string) => { walk.push({ id: candidate.id, kind: candidate.kind, family: candidate.family, reason }); };
  for (const candidate of ordered) {
    if (!candidate.id) {
      skippedUnavailable = true;
      record(candidate, "no declared reviewer");
      continue;
    }
    if (input.implementerFamily !== undefined && candidate.family === input.implementerFamily) {
      skippedOwner = true;
      record(candidate, "implementer skip");
      continue;
    }
    const blocked = unavailable(candidate);
    if (blocked !== undefined) {
      skippedUnavailable = true;
      record(candidate, `unavailable skip: ${blocked}`);
      continue;
    }
    const reason: ReviewerPoolReason = skippedUnavailable ? "unavailable skip" : skippedOwner ? "implementer skip" : "rotation";
    record(candidate, `selected (${continuity && candidate.family === input.continuityFamily ? "continuity" : reason})`);
    return finish({ reviewer: candidate.id, family: candidate.family, reason });
  }
  // The caller supplies separate fresh reviewer instances; this does not authorize an implementer's own session.
  if (input.sameFamily === "never") return finish({ reviewer: null, blocked: "no reviewer can run" });
  for (const candidate of ordered) {
    if (!candidate.id || input.implementerFamily === undefined || candidate.family !== input.implementerFamily) continue;
    const blocked = unavailable(candidate);
    if (blocked !== undefined) { record(candidate, `unavailable skip: ${blocked}`); continue; }
    record(candidate, "selected (same-family fallback)");
    return finish({ reviewer: candidate.id, family: candidate.family, reason: "same-family fallback" });
  }
  return finish({ reviewer: null, blocked: "no reviewer can run" });
}
