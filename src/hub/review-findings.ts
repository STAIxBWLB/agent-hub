import { types } from "node:util";
import { sanitize } from "./envelope.ts";

export interface ReviewFinding {
  id: string;
  pass: "bugs" | "security" | "compliance";
  severity: "important" | "nit";
  path?: string;
  disposition: "open" | "fixed" | "false_positive" | "accepted";
  rationale?: string;
}
export interface ReviewFindingSet { head?: string; items: ReviewFinding[] }
export interface ReviewFindingTally { important: number; nit: number; openImportant: number; openNit: number; fixed: number; falsePositive: number; accepted: number }
export const DEFAULT_MAX_NITS = 5;
const MAX_ITEMS = 64, MAX_BYTES = 64 * 1024;
const fail = (reason: string): never => { throw new Error("review findings: " + reason); };
function fields(raw: unknown): Record<string, PropertyDescriptor> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) return fail("plain own-data finding required");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  if (Object.values(descriptors).some(field => !Object.hasOwn(field, "value") || !field.enumerable)) return fail("accessors and hidden fields refused");
  if (Object.keys(descriptors).some(key => !["id", "pass", "severity", "path", "disposition", "rationale"].includes(key))) return fail("unknown finding field");
  return descriptors;
}
function text(raw: unknown, max: number, path: boolean): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > max
    || path && /[\p{Cc}\p{Cf}]/u.test(raw)) return fail("invalid bounded finding text");
  const clean = sanitize(raw.trim());
  if (Buffer.byteLength(clean) > max) return fail("sanitized finding text exceeds its bound");
  return clean;
}
/** Supplied findings are validated independently of lifecycle mode, before any board effect. */
export function parseReviewFindings(raw: unknown, options: { person: boolean; maxNits: number }): ReviewFinding[] {
  if (typeof options.person !== "boolean" || !Number.isSafeInteger(options.maxNits) || options.maxNits < 0 || options.maxNits > MAX_ITEMS) return fail("invalid finding authority or nit limit");
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype
    || Object.getOwnPropertySymbols(raw).length || raw.length > MAX_ITEMS) return fail("at most 64 own-data findings required");
  const descriptors: Record<string, PropertyDescriptor> = Object.assign(Object.create(null), Object.getOwnPropertyDescriptors(raw));
  if (Object.keys(descriptors).length !== raw.length + 1) return fail("dense finding array required");
  const ids = new Set<string>();
  const result = Array.from({ length: raw.length }, (_, index): ReviewFinding => {
    const entry = descriptors[String(index)];
    if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) return fail("finding array accessors refused");
    const item = fields(entry.value), id: unknown = item.id?.value, pass: unknown = item.pass?.value;
    const severity: unknown = item.severity?.value, disposition: unknown = item.disposition?.value;
    if (typeof id !== "string" || !/^[A-Za-z0-9._:-]+$/.test(id) || Buffer.byteLength(id) > 96 || ids.has(id)) return fail("invalid or duplicate finding id");
    ids.add(id);
    if (pass !== "bugs" && pass !== "security" && pass !== "compliance") return fail("invalid finding pass");
    if (severity !== "important" && severity !== "nit") return fail("invalid finding severity");
    if (disposition !== "open" && disposition !== "fixed" && disposition !== "false_positive" && disposition !== "accepted") return fail("invalid finding disposition");
    const path = item.path ? text(item.path.value, 512, true) : undefined;
    const rationale = item.rationale ? text(item.rationale.value, 2048, false) : undefined;
    if (disposition === "accepted" && (!options.person || !rationale)) return fail("accepted findings require a person and rationale");
    return { id, pass, severity, disposition, ...(path !== undefined ? { path } : {}), ...(rationale !== undefined ? { rationale } : {}) };
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

/**
 * Nits belong only to their head bucket, including the explicit undefined bucket.
 * Open Important is an obligation across heads until an explicit disposition resolves its pass+ID globally.
 */
export function findingsForHead(sets: readonly ReviewFindingSet[], head?: string): ReviewFinding[] {
  interface Entry { item: ReviewFinding; order: number }
  const current = new Map<string, Entry>(), important = new Map<string, Entry>();
  let order = 0;
  for (const set of sets) for (const item of set.items) {
    const key = item.pass + ":" + item.id, position = order++;
    if (set.head === head) current.set(key, { item: { ...current.get(key)?.item, ...item }, order: position });
    const prior = important.get(key);
    if (item.severity === "important") {
      important.set(key, { item: { ...prior?.item, ...item }, order: position });
    } else if (prior && (prior.item.disposition === "open" || item.disposition !== "open")) {
      // A nit/open reclassification cannot discharge Important. An explicit disposition can.
      important.set(key, { item: { ...prior.item, ...item, severity: "important" }, order: position });
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
    if (item.disposition === "open") tally[item.severity === "important" ? "openImportant" : "openNit"]++;
    else tally[item.disposition === "false_positive" ? "falsePositive" : item.disposition]++;
  }
  return tally;
}
