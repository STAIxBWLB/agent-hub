import { types } from "node:util";
import { sanitize } from "./envelope.ts";
import { parseReviewAnchor } from "./review-anchor.ts";
import type { ReviewAnchor } from "@staix/agent-console/contract";

/** #1403 A1: the four things a security finding must name: who is lower-trust, the control meant to hold, the resource affected and the result observed. */
export interface FindingBoundary { principal: string; control: string; resource: string; result: string }
export interface ReviewFinding {
  id: string;
  pass: "bugs" | "security" | "compliance";
  severity: "important" | "nit";
  path?: string;
  disposition: "open" | "fixed" | "false_positive" | "accepted";
  rationale?: string;
  anchor?: ReviewAnchor;
  /** #1403 A1, important security findings only (an enabled lifecycle). `needs_validation` is a source-grounded hypothesis blocked on `blocker`; it never blocks approval. */
  state?: "confirmed" | "needs_validation";
  boundary?: FindingBoundary;
  blocker?: string;
  /** #1403 B4 (an enabled lifecycle). Absent reads as `introduced`; an open `pre_existing` Important never blocks and never carries across heads. */
  origin?: "introduced" | "pre_existing";
}
/**
 * How `parseReviewFindings` treats the #1403 fields. `off` (the default, lifecycle off): they are unknown fields, refused as before. `required` (advise and enforce): accepted, and an
 * open important security finding must carry `state` and `boundary`. `stored`: a report this hub already validated, read back: the shapes are checked, nothing is required again.
 */
export type FindingContract = "off" | "required" | "stored";
export interface ReviewFindingSet { head?: string; items: ReviewFinding[] }
/** `openImportant` counts only findings that block approval; `needsValidation` and `preExisting` (open Important that do not) appear only when nonzero, so an off-mode readback is unchanged. */
export interface ReviewFindingTally { important: number; nit: number; openImportant: number; openNit: number; fixed: number; falsePositive: number; accepted: number; needsValidation?: number; preExisting?: number }
export const DEFAULT_MAX_NITS = 5;
const MAX_ITEMS = 64, MAX_BYTES = 64 * 1024;
const fail = (reason: string): never => { throw new Error("review findings: " + reason); };
const BASE_FIELDS = ["id", "pass", "severity", "path", "disposition", "rationale", "anchor"], SECURITY_FIELDS = ["state", "boundary", "blocker", "origin"];
const BOUNDARY_FIELDS = ["principal", "control", "resource", "result"] as const;
function fields(raw: unknown, allowed: readonly string[] = BASE_FIELDS): Record<string, PropertyDescriptor> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) return fail("plain own-data finding required");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  if (Object.values(descriptors).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return fail("accessors and hidden fields refused");
  if (Object.keys(descriptors).some(key => !allowed.includes(key))) return fail("unknown finding field");
  return descriptors;
}
function text(raw: unknown, max: number, path: boolean): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > max
    || path && /[\p{Cc}\p{Cf}]/u.test(raw)) return fail("invalid bounded finding text");
  const clean = sanitize(raw.trim());
  if (Buffer.byteLength(clean) > max) return fail("sanitized finding text exceeds its bound");
  return clean;
}
function boundaryOf(raw: unknown): FindingBoundary {
  const given = fields(raw, BOUNDARY_FIELDS);
  if (BOUNDARY_FIELDS.some(key => given[key] === undefined)) return fail("boundary needs principal, control, resource and result");
  return Object.fromEntries(BOUNDARY_FIELDS.map(key => [key, text(given[key]!.value, 512, false)])) as unknown as FindingBoundary;
}
const NEEDS_SECURITY_FIELDS = "an important security finding needs state (confirmed or needs_validation) and boundary {principal, control, resource, result}: the lower-trust principal, the control that was meant to hold, the resource affected and the result observed; a missing best practice or a guessed deployment fact is not a finding";
/** Supplied findings are validated independently of lifecycle mode, before any board effect. */
export function parseReviewFindings(raw: unknown, options: { person: boolean; maxNits: number; contract?: FindingContract }): ReviewFinding[] {
  if (typeof options.person !== "boolean" || !Number.isSafeInteger(options.maxNits) || options.maxNits < 0 || options.maxNits > MAX_ITEMS) return fail("invalid finding authority or nit limit");
  const contract = options.contract ?? "off";
  if (contract !== "off" && contract !== "required" && contract !== "stored") return fail("invalid finding contract");
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length || raw.length > MAX_ITEMS) return fail("at most 64 own-data findings required");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  if (Object.keys(descriptors).length !== raw.length + 1) return fail("dense finding array required");
  const ids = new Set<string>();
  const result = Array.from({ length: raw.length }, (_, index): ReviewFinding => {
    const entry = descriptors[String(index)];
    if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) return fail("finding array accessors refused");
    const item = fields(entry.value, contract === "off" ? BASE_FIELDS : [...BASE_FIELDS, ...SECURITY_FIELDS]), id: unknown = item.id?.value, pass: unknown = item.pass?.value;
    const severity: unknown = item.severity?.value, disposition: unknown = item.disposition?.value;
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]+$/.test(id) || Buffer.byteLength(id) > 96 || ids.has(id)) return fail("invalid or duplicate finding id");
    ids.add(id);
    if (pass !== "bugs" && pass !== "security" && pass !== "compliance") return fail("invalid finding pass");
    if (severity !== "important" && severity !== "nit") return fail("invalid finding severity");
    if (disposition !== "open" && disposition !== "fixed" && disposition !== "false_positive" && disposition !== "accepted") return fail("invalid finding disposition");
    const path = item.path ? text(item.path.value, 512, true) : undefined;
    const rationale = item.rationale ? text(item.rationale.value, 2048, false) : undefined;
    const anchor = item.anchor ? parseReviewAnchor(item.anchor.value) : undefined;
    if (path !== undefined && anchor && path !== anchor.path) return fail("path and anchor.path differ; use the same task-scoped file path");
    if (disposition === "accepted" && (!options.person || !rationale)) return fail("accepted findings require a person and rationale");
    // #1403: only an enabled lifecycle reaches here with these fields (off refused them as unknown above).
    const state: unknown = item.state?.value, origin: unknown = item.origin?.value;
    if (item.state && state !== "confirmed" && state !== "needs_validation") return fail("invalid finding state");
    if (item.origin && origin !== "introduced" && origin !== "pre_existing") return fail("invalid finding origin");
    const boundary = item.boundary ? boundaryOf(item.boundary.value) : undefined;
    const blocker = item.blocker ? text(item.blocker.value, 512, false) : undefined;
    if ((state !== undefined || boundary !== undefined || blocker !== undefined) && !(pass === "security" && severity === "important")) return fail("state, boundary and blocker apply only to important security findings");
    if (contract === "required" && pass === "security" && severity === "important" && disposition === "open") {
      if (state === undefined || boundary === undefined) return fail(NEEDS_SECURITY_FIELDS);
      if (state === "needs_validation" && blocker === undefined) return fail("a needs_validation finding names its blocker: the missing fact that settles it");
      if (state === "confirmed" && blocker !== undefined) return fail("a confirmed finding carries no blocker; use needs_validation for a hypothesis blocked on a named fact");
    }
    return { id, pass, severity, disposition, ...(path !== undefined ? { path } : {}), ...(rationale !== undefined ? { rationale } : {}), ...(anchor ? { anchor } : {}),
      ...(state !== undefined ? { state } : {}), ...(boundary !== undefined ? { boundary } : {}), ...(blocker !== undefined ? { blocker } : {}), ...(origin !== undefined ? { origin } : {}) } as ReviewFinding;
  });
  if (result.filter(item => item.severity === "nit").length > options.maxNits) return fail("nit limit exceeded");
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) return fail("finding report exceeds 64 KiB");
  return result;
}

/** Prefer live artifact identity, skipping malformed historical candidates rather than hiding a valid fallback. */
export function findingHead(receipt?: { head?: string; reviewedHead?: string; localHead?: string }, evidence?: { head: string }, commit?: string): string | undefined {
  return [evidence?.head, receipt?.head, receipt?.reviewedHead, receipt?.localHead, commit]
    .find((head): head is string => typeof head === "string" && /^[a-f0-9]{40}$/.test(head));
}

/** An open Important blocks approval unless it is a hypothesis awaiting a named fact (`needs_validation`) or debt the change did not introduce (`pre_existing`). */
export const blocksApproval = (item: ReviewFinding): boolean =>
  item.severity === "important" && item.disposition === "open" && item.state !== "needs_validation" && item.origin !== "pre_existing";
/** What carries across heads: Important, except debt the reviewed change did not introduce. */
const carries = (item: ReviewFinding): boolean => item.severity === "important" && item.origin !== "pre_existing";
/** A later report of an id, over its earlier one. A report that still says open cannot lower an approval-blocking finding: its severity, origin and state stay; only an explicit disposition settles it. */
function merged(prior: ReviewFinding | undefined, item: ReviewFinding): ReviewFinding {
  const next: ReviewFinding = { ...prior, ...item };
  if (prior && blocksApproval(prior) && item.disposition === "open") {
    next.severity = "important";
    for (const key of ["origin", "state"] as const) { if (prior[key] === undefined) delete next[key]; else Object.assign(next, { [key]: prior[key] }); }
  }
  return next;
}
/**
 * Nits belong only to their head bucket, including the explicit undefined bucket.
 * Open Important is an obligation across heads until an explicit disposition resolves its ID globally.
 */
export function findingsForHead(sets: readonly ReviewFindingSet[], head?: string): ReviewFinding[] {
  interface Entry { item: ReviewFinding; order: number }
  const current = new Map<string, Entry>(), important = new Map<string, Entry>();
  let order = 0;
  for (const set of sets) for (const item of set.items) {
    const key = item.id, position = order++;
    if (set.head === head) current.set(key, { item: { ...current.get(key)?.item, ...item }, order: position });
    const prior = important.get(key);
    if (carries(item)) {
      important.set(key, { item: merged(prior?.item, item), order: position });
    } else if (prior && (prior.item.disposition === "open" || item.disposition !== "open")) {
      // A nit/open reclassification (a nit, or #1403 pre_existing) cannot discharge Important. An explicit disposition can.
      important.set(key, { item: { ...merged(prior.item, item), severity: "important" }, order: position });
    }
  }
  for (const [key, entry] of important) {
    if (entry.item.disposition === "open") current.set(key, entry);
    else {
      const seen = current.get(key);
      // Settling on B also settles older A when A is queried again. A later new nit/open remains a head-local nit.
      if (seen?.item.disposition === "open" && seen.order <= entry.order) current.delete(key);
    }
  }
  return [...current.values()].map(entry => ({ ...entry.item }));
}
export function findingTally(items: readonly ReviewFinding[]): ReviewFindingTally {
  const tally: ReviewFindingTally = { important: 0, nit: 0, openImportant: 0, openNit: 0, fixed: 0, falsePositive: 0, accepted: 0 };
  for (const item of items) {
    tally[item.severity]++;
    if (item.disposition === "open") {
      if (item.severity === "nit") tally.openNit++;
      else if (blocksApproval(item)) tally.openImportant++;
      else if (item.state === "needs_validation") tally.needsValidation = (tally.needsValidation ?? 0) + 1;
      else tally.preExisting = (tally.preExisting ?? 0) + 1;
    } else tally[item.disposition === "false_positive" ? "falsePositive" : item.disposition]++;
  }
  return tally;
}

/**
 * #1403: the open Important findings that do not block approval and so get one follow-up card on approval, over every report of the task (a hypothesis or debt is head-local or settled later, so
 * the current head's view would lose it). `validation`: needs_validation, which wins over pre_existing; `preExisting`: debt the change did not introduce.
 */
export function findingFollowUps(sets: readonly ReviewFindingSet[]): { validation: ReviewFinding[]; preExisting: ReviewFinding[] } {
  const latest = new Map<string, ReviewFinding>();
  for (const set of sets) for (const item of set.items) latest.set(item.id, merged(latest.get(item.id), item));
  const open = [...latest.values()].filter(item => item.severity === "important" && item.disposition === "open");
  return { validation: open.filter(item => item.state === "needs_validation"), preExisting: open.filter(item => item.state !== "needs_validation" && item.origin === "pre_existing") };
}
