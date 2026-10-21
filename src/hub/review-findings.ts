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

/** The undefined head is its own explicit unbound bucket; omitted IDs never settle prior findings. */
export function findingsForHead(sets: readonly ReviewFindingSet[], head?: string): ReviewFinding[] {
  const folded = new Map<string, ReviewFinding>();
  for (const set of sets) if (set.head === head) for (const item of set.items) folded.set(item.id, { ...folded.get(item.id), ...item });
  return [...folded.values()];
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
