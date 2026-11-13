import { createHash } from "node:crypto";
import { types } from "node:util";
import { validSourceId } from "./sources.ts";
import { sanitize } from "./envelope.ts";

export const EVIDENCE_RELATIONS = ["supports", "contradicts", "context"] as const;
export const MAX_EVIDENCE_LOCATOR_SPAN = 4096;
export const MAX_EVIDENCE_RECORD_BYTES = 4096;

/** Proposed zero-based, half-open scalar-value offsets. T1 stores bounds; T2 resolves and verifies them. */
export interface EvidenceLocatorV1 { start: number; end: number }
/** #931 provenance only: a relation never creates a #901 person verdict or verifies entailment. */
export interface EvidenceLinkV1 {
  id: string;
  claimId: string;
  claimRevision: string;
  sourceId: string;
  rawSha256: string;
  projectionSha256: string;
  projectionVersion: string;
  locator: EvidenceLocatorV1;
  relation: (typeof EVIDENCE_RELATIONS)[number];
  recordedBy: string;
  taskId: number;
  revision: number;
}
/** The actor is host-stamped. Revision defaults to 1; a later revision names an existing link explicitly. */
export type EvidenceRecordInput = Omit<EvidenceLinkV1, "id" | "recordedBy"> & { id?: string };
export type EvidenceReceipt = Pick<EvidenceLinkV1, "id" | "revision" | "taskId">;

const FIELDS = ["id", "claimId", "claimRevision", "sourceId", "rawSha256", "projectionSha256", "projectionVersion", "locator", "relation", "recordedBy", "taskId", "revision"] as const;
const INPUT_FIELDS = FIELDS.filter(field => field !== "recordedBy");
const HASH = /^[0-9a-f]{64}$/;
const LINK_ID = /^ev:[0-9a-f]{32}$/;
function fail(field: string, cause: string): never {
  throw new Error(`evidence ${field}: ${cause}; correct this field using the hub_evidence_record schema and retry`);
}
function dataObject(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !Object.hasOwn(descriptor, "value"))) fail(field, "expected an inert plain data object");
  if (Object.getOwnPropertyNames(value).some(key => !allowed.includes(key))) fail(field, "unknown field");
  return value as Record<string, unknown>;
}
function integer(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail(field, `expected a safe integer >= ${minimum}`);
  return value;
}
function token(value: unknown, field: string, expression: RegExp): string {
  if (typeof value !== "string" || !expression.test(value)) fail(field, "invalid identifier or hash");
  return value;
}
function claimId(value: unknown): string {
  const id = token(value, "claimId", /^claim:[1-9][0-9]{0,15}:(?:0|[1-9][0-9]{0,15}):[1-9][0-9]?$/);
  const [, task, created, slot] = id.split(":");
  if (!Number.isSafeInteger(Number(task)) || !Number.isSafeInteger(Number(created)) || Number(slot) > 50) fail("claimId", "invalid task incarnation or claim slot");
  return id;
}
function locator(value: unknown): EvidenceLocatorV1 {
  const row = dataObject(value, ["start", "end"], "locator");
  const start = integer(row.start, "locator.start", 0), end = integer(row.end, "locator.end");
  if (end <= start || end - start > MAX_EVIDENCE_LOCATOR_SPAN) fail("locator", `expected a nonempty range of at most ${MAX_EVIDENCE_LOCATOR_SPAN} scalar values`);
  return { start, end };
}
function parsed(value: unknown, stored: boolean): EvidenceRecordInput | EvidenceLinkV1 {
  const row = dataObject(value, stored ? FIELDS : INPUT_FIELDS, "record");
  const taskId = integer(row.taskId, "taskId"), revision = row.revision === undefined && !stored ? 1 : integer(row.revision, "revision");
  const id = row.id === undefined && !stored ? undefined : token(row.id, "id", LINK_ID);
  if (revision > 1 && id === undefined) fail("id", "a later revision must name its existing link");
  const sourceId = row.sourceId;
  if (!validSourceId(sourceId)) fail("sourceId", "expected a registered src:<16 hex> id");
  const relation = row.relation;
  if (typeof relation !== "string" || !(EVIDENCE_RELATIONS as readonly string[]).includes(relation)) fail("relation", "expected supports, contradicts or context");
  const common: EvidenceRecordInput = {
    ...(id === undefined ? {} : { id }),
    claimId: claimId(row.claimId),
    claimRevision: token(row.claimRevision, "claimRevision", /^[0-9a-f]{16}$/),
    sourceId,
    rawSha256: token(row.rawSha256, "rawSha256", HASH),
    projectionSha256: token(row.projectionSha256, "projectionSha256", HASH),
    projectionVersion: token(row.projectionVersion, "projectionVersion", /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/),
    locator: locator(row.locator),
    relation: relation as EvidenceLinkV1["relation"],
    taskId, revision,
  };
  const result = stored ? { ...common, id: id!, recordedBy: token(row.recordedBy, "recordedBy", /^[A-Za-z0-9][A-Za-z0-9._:@~+-]{0,127}$/) } : common;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_EVIDENCE_RECORD_BYTES) fail("record", `expected at most ${MAX_EVIDENCE_RECORD_BYTES} bytes`);
  return result;
}
export function parseEvidenceRecord(value: unknown): EvidenceRecordInput { return parsed(value, false) as EvidenceRecordInput; }
export function parseEvidenceLink(value: unknown): EvidenceLinkV1 { return parsed(value, true) as EvidenceLinkV1; }

/** Stable local identity for an identical initial write, without consulting a clock or creating a claim store. */
export function evidenceLinkId(input: EvidenceRecordInput, recordedBy: string): string {
  const parsed = parseEvidenceRecord(input);
  if (parsed.id !== undefined) return parsed.id;
  const actor = token(recordedBy, "recordedBy", /^[A-Za-z0-9][A-Za-z0-9._:@~+-]{0,127}$/);
  return `ev:${createHash("sha256").update(JSON.stringify({ ...parsed, recordedBy: actor })).digest("hex").slice(0, 32)}`;
}
/** Fixed field order; parsing first prevents accessors, toJSON or unknown narrative fields from being serialized. */
export function evidenceLinkCanonical(value: EvidenceLinkV1): string {
  const row = parseEvidenceLink(value);
  return JSON.stringify({ id: row.id, claimId: row.claimId, claimRevision: row.claimRevision, sourceId: row.sourceId,
    rawSha256: row.rawSha256, projectionSha256: row.projectionSha256, projectionVersion: row.projectionVersion,
    locator: row.locator, relation: row.relation, recordedBy: row.recordedBy, taskId: row.taskId, revision: row.revision });
}

export const MAX_EVIDENCE_EXCERPT_BYTES = 4096;
export interface EvidenceProjectionSnapshot {
  sourceId: string; rawSha256: string; projectionSha256: string; projectionVersion: string; text: string; complete: boolean;
}
export type EvidenceResolution =
  | { status: "resolved"; locator: EvidenceLocatorV1; excerpt: string; excerptSha256: string }
  | { status: "stale"; cause: "raw_changed" | "projection_changed" }
  | { status: "unavailable"; cause: "source_unavailable" | "private" | "projection_missing" | "projection_incomplete" | "locator_invalid" | "excerpt_limit" };

/** Existing source-read offsets count String.iterator code points, not UTF-16 units or sanitized output characters. */
export function sourceReadRangeToEvidenceLocator(range: { offset: number; length: number }, text: string): EvidenceLocatorV1 | undefined {
  const end = range.offset + range.length;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 1 || range.length > MAX_EVIDENCE_LOCATOR_SPAN || !Number.isSafeInteger(end)) return undefined;
  let scalars = 0;
  for (const point of text) {
    const value = point.codePointAt(0)!;
    if (value >= 0xd800 && value <= 0xdfff) return undefined; // String.iterator also yields lone surrogates; they are not Unicode scalar values.
    scalars++;
  }
  return end <= scalars ? { start: range.offset, end } : undefined;
}

/** Resolve provenance only from a complete host-screened projection. No source lookup, network, page inference or judgment. */
export function resolveEvidenceLocator(input: EvidenceLinkV1, snapshot?: EvidenceProjectionSnapshot): EvidenceResolution {
  let link: EvidenceLinkV1;
  try { link = parseEvidenceLink(input); } catch { return { status: "unavailable", cause: "locator_invalid" }; }
  if (!snapshot || typeof snapshot.text !== "string" || snapshot.sourceId !== link.sourceId) return { status: "unavailable", cause: "projection_missing" };
  if (snapshot.complete !== true) return { status: "unavailable", cause: "projection_incomplete" };
  if (snapshot.rawSha256 !== link.rawSha256) return { status: "stale", cause: "raw_changed" };
  const projectionHash = createHash("sha256").update(Buffer.from(snapshot.text, "utf8")).digest("hex");
  if (snapshot.projectionSha256 !== projectionHash || snapshot.projectionSha256 !== link.projectionSha256 || snapshot.projectionVersion !== link.projectionVersion) return { status: "stale", cause: "projection_changed" };
  const locator = sourceReadRangeToEvidenceLocator({ offset: link.locator.start, length: link.locator.end - link.locator.start }, snapshot.text);
  if (!locator) return { status: "unavailable", cause: "locator_invalid" };
  let index = 0, passage = "";
  for (const point of snapshot.text) { if (index >= locator.end) break; if (index >= locator.start) passage += point; index++; }
  const excerpt = sanitize(passage);
  if (Buffer.byteLength(excerpt, "utf8") > MAX_EVIDENCE_EXCERPT_BYTES) return { status: "unavailable", cause: "excerpt_limit" };
  return { status: "resolved", locator, excerpt, excerptSha256: createHash("sha256").update(Buffer.from(excerpt, "utf8")).digest("hex") };
}
