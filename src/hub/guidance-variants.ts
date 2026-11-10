import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { sanitize } from "./envelope.ts";
import { types } from "node:util";
import { executionReferenceKey, executionText, parseExecutionReference, EXECUTION_REFERENCE_LIMITS, type ExecutionReferenceV1 } from "./execution-reference.ts";
import { executionLinkActor, executionLinkInteger } from "./execution-links.ts";
import { parseRoleDocument, roleIdentity, taskRoleText, type CatalogRole, type RoleDocument } from "./roles.ts";

/** Immutable V1 data bounds, not tunable host policy or execution permissions. */
export const GUIDANCE_ROLE_MAX_BYTES = 8192;
export const GUIDANCE_RATIONALE_MAX_BYTES = 2000;
export const GUIDANCE_RECORD_MAX_BYTES = 32768;
export const GUIDANCE_EVIDENCE_MAX_REFS = 16;
export const GUIDANCE_EXPERIMENT_MAX_VARIANTS = 16;
export const GUIDANCE_HASH_HEX_LENGTH = 64;
export const GUIDANCE_VARIANT_LIMITS = Object.freeze({ roleBytes: GUIDANCE_ROLE_MAX_BYTES, rationaleBytes: GUIDANCE_RATIONALE_MAX_BYTES,
  recordBytes: GUIDANCE_RECORD_MAX_BYTES, evidenceRefs: GUIDANCE_EVIDENCE_MAX_REFS, variants: GUIDANCE_EXPERIMENT_MAX_VARIANTS });
export interface GuidanceBaselineV1 {
  readonly roleId: string; readonly layer: CatalogRole["layer"]; readonly sha256: string; readonly bytes: string;
}
export interface GuidanceCandidateV1 { readonly sha256: string; readonly bytes: string }
export interface GuidanceRationaleV1 { readonly problemHypothesis: string; readonly expectedObservableDifference: string }
export interface GuidanceVariantPayloadV1 {
  readonly v: 1; readonly projectKey: string; readonly experimentId: string;
  readonly taskId: number; readonly taskCreated: number; readonly flowRevision: number;
  readonly baseline: GuidanceBaselineV1; readonly candidate: GuidanceCandidateV1; readonly author: string;
  readonly rationale: GuidanceRationaleV1; readonly evidenceRefs: readonly Readonly<ExecutionReferenceV1>[];
}
export interface GuidanceVariantV1 extends GuidanceVariantPayloadV1 { readonly id: string }
/** The host preserves baseline at experiment creation; currentBaseline is a separate fresh catalog identity. */
export interface GuidanceVariantContext {
  readonly projectKey: string; readonly experimentId: string; readonly taskId: number; readonly taskCreated: number;
  readonly flowRevision: number; readonly actor: string; readonly baseline: GuidanceBaselineV1;
  readonly currentBaseline: Readonly<ReturnType<typeof roleIdentity>>;
  /** Every historical variant key, including withdrawn records. */
  readonly variantIds: readonly string[];
}
export class GuidanceVariantError extends Error {
  constructor(readonly code: "invalid" | "protected" | "prose" | "changed" | "limit") {
    super({
      invalid: "invalid guidance variant fields, hashes or bounds; use the closed V1 contract and current admitted role snapshots before retrying",
      protected: "guidance variant changes protected role bytes; restore the baseline metadata, prefix, headings and protected sections before retrying",
      prose: "guidance variant requires bounded prose-shaped sentences; remove command/code/header syntax and retry without changing protected bytes",
      changed: "guidance variant context changed; reload the current task and catalog identity and start a new experiment when its frozen baseline differs",
      limit: "guidance experiment already has sixteen variants; reuse an identical recorded variant or start a separate experiment before proposing another",
    }[code]);
    this.name = "GuidanceVariantError";
  }
}
const invalid = (): never => { throw new GuidanceVariantError("invalid"); };
const HASH = /^[a-f0-9]{64}$/;
const PAYLOAD_KEYS = ["v", "projectKey", "experimentId", "taskId", "taskCreated", "flowRevision", "baseline", "candidate", "author", "rationale", "evidenceRefs"] as const;
const EDITABLE = new Set(["Scope", "Deliverables", "Evidence"]);

/** Inspect inert own data only. Never invoke a producer getter, iterator or toJSON. */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length > keys.length) return invalid();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== "string" || !keys.includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    out[key] = descriptor.value;
  }
  return out;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== "string")) return invalid();
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    out.push(descriptor.value);
  }
  return out;
}
function boundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || Buffer.byteLength(value, "utf8") > maximum) return invalid();
  return value;
}
function hash(value: unknown): string { return typeof value === "string" && value.length === GUIDANCE_HASH_HEX_LENGTH && HASH.test(value) ? value : invalid(); }
function identity(value: unknown): string { return executionText(value, EXECUTION_REFERENCE_LIMITS.id) ? value : invalid(); }
const actor = (value: unknown): value is string => executionText(value, EXECUTION_REFERENCE_LIMITS.id) && executionLinkActor(value);
function roleDocument(bytes: unknown, roleId: unknown, layer: unknown): RoleDocument {
  const text = boundedText(bytes, GUIDANCE_VARIANT_LIMITS.roleBytes);
  if (typeof roleId !== "string" || (layer !== "shipped" && layer !== "project")) return invalid();
  try {
    const document = parseRoleDocument(text, roleId, layer);
    taskRoleText(document.role); // Preserve the existing complete rendered UTF-16 limit, including its header.
    return document;
  } catch { return invalid(); }
}
function baseline(value: unknown): { value: GuidanceBaselineV1; document: RoleDocument } {
  const fields = object(value, ["roleId", "layer", "sha256", "bytes"]);
  const document = roleDocument(fields.bytes, fields.roleId, fields.layer), sha256 = hash(fields.sha256);
  if (document.role.hash !== sha256) return invalid();
  return { value: Object.freeze({ roleId: document.role.id, layer: document.role.layer, sha256, bytes: fields.bytes as string }), document };
}

/** A deliberately narrow lexical ceiling. It does not establish semantic safety or host authority. */
function prose(text: string): void {
  let meaningful = false;
  for (const raw of text.split("\n")) {
    if (!/^[\p{L}\p{M}\p{N} .,:;!?'"()\/\-]*$/u.test(raw) || raw.includes("--")
      || /\[agent-hub\b|<channel\b/i.test(raw) || /[\p{L}\p{N}_]\(/u.test(raw)) throw new GuidanceVariantError("prose");
    if (!raw.trim()) continue;
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (!/^\p{L}/u.test(line) || !/[.!?]$/.test(line)
      || /^(?:bun|npm|npx|git|ssh|curl|wget|rm|bash|sh|python[0-9.]*|node|pnpm|yarn|zsh|sudo|env|exec|eval|echo|printf|cat|tee|chmod)(?:\s|$)/i.test(line)
      || /^(?:import|export|def|function|class|const|let|var|await|return|throw|raise|yield)(?:\s|$)/i.test(line)) throw new GuidanceVariantError("prose");
    meaningful = true;
  }
  if (!meaningful) throw new GuidanceVariantError("prose");
}
function restricted(baselineDocument: RoleDocument, candidateDocument: RoleDocument): void {
  if (baselineDocument.rawHeader !== candidateDocument.rawHeader || baselineDocument.bodyPrefix !== candidateDocument.bodyPrefix) throw new GuidanceVariantError("protected");
  for (const [index, original] of baselineDocument.sections.entries()) {
    const candidate = candidateDocument.sections[index]!;
    if (original.headingRaw !== candidate.headingRaw || !EDITABLE.has(original.name) && original.raw !== candidate.raw) throw new GuidanceVariantError("protected");
    if (EDITABLE.has(original.name)) prose(candidate.contentRaw);
  }
}
function rationale(value: unknown): GuidanceRationaleV1 {
  const fields = object(value, ["problemHypothesis", "expectedObservableDifference"]);
  const result = { problemHypothesis: boundedText(fields.problemHypothesis, GUIDANCE_VARIANT_LIMITS.rationaleBytes),
    expectedObservableDifference: boundedText(fields.expectedObservableDifference, GUIDANCE_VARIANT_LIMITS.rationaleBytes) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > GUIDANCE_VARIANT_LIMITS.rationaleBytes) return invalid();
  prose(result.problemHypothesis); prose(result.expectedObservableDifference);
  return Object.freeze(result);
}
function payload(fields: Record<string, unknown>): GuidanceVariantPayloadV1 {
  if (fields.v !== 1 || !executionText(fields.projectKey, EXECUTION_REFERENCE_LIMITS.projectKey)
    || !executionLinkInteger(fields.taskId, 1) || !executionLinkInteger(fields.taskCreated) || !executionLinkInteger(fields.flowRevision)
    || !actor(fields.author)) return invalid();
  const original = baseline(fields.baseline), proposed = object(fields.candidate, ["sha256", "bytes"]);
  const candidateDocument = roleDocument(proposed.bytes, original.value.roleId, original.value.layer), sha256 = hash(proposed.sha256);
  if (candidateDocument.role.hash !== sha256) return invalid();
  restricted(original.document, candidateDocument);
  let refs: ExecutionReferenceV1[];
  try {
    refs = array(fields.evidenceRefs, GUIDANCE_VARIANT_LIMITS.evidenceRefs).map(value => {
      const ref = parseExecutionReference(object(value, ["v", "tool", "projectKey", "kind", "id", "revision", "sha256"]));
      if (ref.sha256 !== undefined) hash(ref.sha256);
      return ref;
    });
  }
  catch { return invalid(); }
  if (new Set(refs.map(executionReferenceKey)).size !== refs.length) return invalid();
  return Object.freeze({ v: 1, projectKey: fields.projectKey, experimentId: identity(fields.experimentId),
    taskId: fields.taskId, taskCreated: fields.taskCreated, flowRevision: fields.flowRevision,
    baseline: original.value, candidate: Object.freeze({ sha256, bytes: proposed.bytes as string }), author: fields.author,
    rationale: rationale(fields.rationale), evidenceRefs: Object.freeze(refs.map(ref => Object.freeze(ref))) });
}
function contentKey(value: GuidanceVariantPayloadV1): string {
  return createHash("sha256").update(JSON.stringify(["agent-hub.guidance-variant/v1", value]), "utf8").digest("hex");
}
function record(value: GuidanceVariantPayloadV1, id: string): Readonly<GuidanceVariantV1> {
  const result = Object.freeze({ id, ...value });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > GUIDANCE_VARIANT_LIMITS.recordBytes) return invalid();
  return result;
}
/** Content-addressing is not admission, provenance, testing or approval. */
export function guidanceVariantKey(value: GuidanceVariantPayloadV1): string {
  const normalized = payload(object(value, PAYLOAD_KEYS)), id = contentKey(normalized);
  record(normalized, id);
  return id;
}
export function parseGuidanceVariantV1(value: unknown): Readonly<GuidanceVariantV1> {
  const fields = object(value, [...PAYLOAD_KEYS, "id"]), normalized = payload(fields), id = hash(fields.id);
  if (contentKey(normalized) !== id) return invalid();
  return record(normalized, id);
}
/** Compare supplied host snapshots only; Tasks must separately check live authority, privacy and currentness. */
export function validateGuidanceVariantV1(value: unknown, context: GuidanceVariantContext): Readonly<GuidanceVariantV1> {
  const result = parseGuidanceVariantV1(value);
  const fields = object(context, ["projectKey", "experimentId", "taskId", "taskCreated", "flowRevision", "actor", "baseline", "currentBaseline", "variantIds"]);
  if (!executionText(fields.projectKey, EXECUTION_REFERENCE_LIMITS.projectKey) || !executionLinkInteger(fields.taskId, 1)
    || !executionLinkInteger(fields.taskCreated) || !executionLinkInteger(fields.flowRevision) || !actor(fields.actor)) return invalid();
  const experimentId = identity(fields.experimentId), frozen = baseline(fields.baseline).value;
  const current = object(fields.currentBaseline, ["id", "layer", "hash"]);
  if (typeof current.id !== "string" || (current.layer !== "shipped" && current.layer !== "project")) return invalid();
  hash(current.hash);
  const ids = array(fields.variantIds, GUIDANCE_VARIANT_LIMITS.variants).map(hash);
  if (new Set(ids).size !== ids.length) return invalid();
  if (result.projectKey !== fields.projectKey || result.experimentId !== experimentId || result.taskId !== fields.taskId
    || result.taskCreated !== fields.taskCreated || result.flowRevision !== fields.flowRevision || result.author !== fields.actor
    || result.baseline.roleId !== frozen.roleId || result.baseline.layer !== frozen.layer || result.baseline.sha256 !== frozen.sha256 || result.baseline.bytes !== frozen.bytes
    || current.id !== frozen.roleId || current.layer !== frozen.layer || current.hash !== frozen.sha256) throw new GuidanceVariantError("changed");
  if (ids.length === GUIDANCE_VARIANT_LIMITS.variants && !ids.includes(result.id)) throw new GuidanceVariantError("limit");
  return result;
}
/** Historical rendering is advisory data, never a current-catalog or authorized-handoff receipt. */
export function renderGuidanceVariantV1(value: unknown, review = false): string {
  const parsed = parseGuidanceVariantV1(value);
  return taskRoleText(parseRoleDocument(parsed.candidate.bytes, parsed.baseline.roleId, parsed.baseline.layer).role, review);
}

/** Local storage metadata never changes the immutable V1 payload or confers execution provenance. */
export interface GuidanceExperimentRecord {
  readonly projectKey: string; readonly taskId: number; readonly taskCreated: number; readonly experimentId: string;
  readonly baseline: GuidanceBaselineV1;
}
export interface GuidanceStoredRecord {
  readonly variant: Readonly<GuidanceVariantV1>; readonly createdBy: string; readonly createdAt: number;
  readonly withdrawn?: Readonly<{ by: string; at: number }>;
}
export interface GuidanceSelector { readonly taskId: number; readonly taskCreated: number; readonly experimentId: string; readonly id?: string; readonly flowRevision?: number }
export interface GuidanceWriteFence {
  readonly by: string; readonly at: number; readonly taskId: number; readonly taskCreated: number; readonly flowRevision: number;
  readonly owner: string | null; readonly state: string; readonly roleId: string | undefined;
}
export interface GuidanceWriteReceipt { readonly id: string; readonly taskId: number; readonly experimentId: string; readonly status: "declared" | "withdrawn"; readonly already: boolean }
export interface GuidanceVariantMetadata {
  readonly id: string; readonly experimentId: string; readonly taskId: number; readonly taskCreated: number; readonly flowRevision: number;
  readonly roleId: string; readonly layer: CatalogRole["layer"]; readonly baselineSha256: string; readonly candidateSha256: string;
  readonly changedSections: readonly ("Scope" | "Deliverables" | "Evidence")[];
  readonly bytes: Readonly<{ baseline: number; candidate: number; record: number }>;
  readonly author: string;
}
export type GuidanceReadResult = { state: "unavailable" } | { state: "available"; records: (GuidanceVariantMetadata & {
  status: "declared" | "withdrawn"; applicable: boolean; rationale: GuidanceRationaleV1;
  evidence: { key: string; status: "declared" | "unavailable" }[];
})[] };
/** Structural metadata only: Tasks field-screens the opaque experiment id before public use. No raw snapshots or evidence addresses. */
export function guidanceVariantMetadata(value: unknown): GuidanceVariantMetadata {
  const variant = parseGuidanceVariantV1(value), original = parseRoleDocument(variant.baseline.bytes, variant.baseline.roleId, variant.baseline.layer);
  const candidate = parseRoleDocument(variant.candidate.bytes, variant.baseline.roleId, variant.baseline.layer);
  const changedSections = original.sections.flatMap((section, index) => EDITABLE.has(section.name) && section.contentRaw !== candidate.sections[index]!.contentRaw
    ? [section.name as "Scope" | "Deliverables" | "Evidence"] : []);
  return Object.freeze({ id: variant.id, experimentId: variant.experimentId, taskId: variant.taskId, taskCreated: variant.taskCreated,
    flowRevision: variant.flowRevision, roleId: variant.baseline.roleId, layer: variant.baseline.layer,
    baselineSha256: variant.baseline.sha256, candidateSha256: variant.candidate.sha256, changedSections: Object.freeze(changedSections),
    bytes: Object.freeze({ baseline: Buffer.byteLength(variant.baseline.bytes), candidate: Buffer.byteLength(variant.candidate.bytes), record: Buffer.byteLength(JSON.stringify(variant)) }),
    author: variant.author });
}
export function parseGuidanceSelector(value: unknown, withdraw = false): GuidanceSelector {
  const fields = object(value, withdraw ? ["taskId", "taskCreated", "experimentId", "id", "flowRevision"] : ["taskId", "taskCreated", "experimentId", "id"]);
  if (!executionLinkInteger(fields.taskId, 1) || !executionLinkInteger(fields.taskCreated)
    || withdraw && !executionLinkInteger(fields.flowRevision)) return invalid();
  return Object.freeze({ taskId: fields.taskId, taskCreated: fields.taskCreated, experimentId: identity(fields.experimentId),
    ...(fields.id === undefined && !withdraw ? {} : { id: hash(fields.id) }), ...(withdraw ? { flowRevision: fields.flowRevision as number } : {}) });
}
export function parseGuidanceExperiment(value: unknown): GuidanceExperimentRecord {
  const fields = object(value, ["projectKey", "taskId", "taskCreated", "experimentId", "baseline"]);
  if (!executionText(fields.projectKey, EXECUTION_REFERENCE_LIMITS.projectKey) || !executionLinkInteger(fields.taskId, 1)
    || !executionLinkInteger(fields.taskCreated)) return invalid();
  return Object.freeze({ projectKey: fields.projectKey, taskId: fields.taskId, taskCreated: fields.taskCreated,
    experimentId: identity(fields.experimentId), baseline: baseline(fields.baseline).value });
}
export function parseGuidanceStoredRecord(value: unknown): GuidanceStoredRecord {
  const fields = object(value, ["variant", "createdBy", "createdAt", "withdrawn"]), variant = parseGuidanceVariantV1(fields.variant);
  if (!actor(fields.createdBy) || fields.createdBy !== variant.author || !executionLinkInteger(fields.createdAt)) return invalid();
  let withdrawn: GuidanceStoredRecord["withdrawn"];
  if (fields.withdrawn !== undefined) {
    const item = object(fields.withdrawn, ["by", "at"]);
    if (!actor(item.by) || !executionLinkInteger(item.at) || item.at < fields.createdAt) return invalid();
    withdrawn = Object.freeze({ by: item.by, at: item.at });
  }
  return Object.freeze({ variant, createdBy: fields.createdBy, createdAt: fields.createdAt, ...(withdrawn ? { withdrawn } : {}) });
}


/** Published T3 reply and cursor shapes, separate from private record bounds. */
export const GUIDANCE_PAGE_MAX_RECORDS = 32;
export const GUIDANCE_REPLY_MAX_BYTES = 262144;
export const GUIDANCE_CURSOR_MAX_BYTES = 512;
export type GuidancePublicRecord = Extract<GuidanceReadResult, { state: "available" }>["records"][number];
export interface GuidanceCurrent { readonly taskId: number; readonly taskCreated: number; readonly flowRevision: number }
export type GuidancePageResult = { state: "unavailable" } | { state: "available"; current: GuidanceCurrent; records: GuidancePublicRecord[]; truncated: boolean; cursor?: string };
export type GuidanceEditableSection = "Scope" | "Deliverables" | "Evidence";
export interface GuidanceSectionDiff { readonly section: GuidanceEditableSection; readonly before: string; readonly after: string }
export type GuidanceDiffResult = { state: "unavailable" } | { state: "available"; current: GuidanceCurrent; record: GuidancePublicRecord;
  sections: readonly GuidanceSectionDiff[]; protectedSections: readonly string[] };
const EDITABLE_NAMES: readonly GuidanceEditableSection[] = ["Scope", "Deliverables", "Evidence"];
const PROTECTED_NAMES = ["Not in scope", "Hub use", "Review duties"] as const;
export function guidanceVariantSectionDiff(value: unknown, allowed: (text: string) => boolean): readonly GuidanceSectionDiff[] {
  const variant = parseGuidanceVariantV1(value), original = parseRoleDocument(variant.baseline.bytes, variant.baseline.roleId, variant.baseline.layer);
  const candidate = parseRoleDocument(variant.candidate.bytes, variant.baseline.roleId, variant.baseline.layer);
  const field = (text: string) => {
    try { if (Buffer.byteLength(text) <= GUIDANCE_ROLE_MAX_BYTES && allowed(text)) {
      const rendered = sanitize(text); if (Buffer.byteLength(rendered) <= GUIDANCE_ROLE_MAX_BYTES) return rendered;
    } } catch { /* Unknown policy withholds one whole field. */ }
    return "withheld";
  };
  return Object.freeze(original.sections.flatMap((section, index) => EDITABLE.has(section.name)
    ? [Object.freeze({ section: section.name as GuidanceEditableSection, before: field(section.contentRaw), after: field(candidate.sections[index]!.contentRaw) })] : []));
}
export const guidanceProtectedSectionNames = (): readonly string[] => Object.freeze([...PROTECTED_NAMES]);
function currentBinding(value: unknown): GuidanceCurrent {
  const fields = object(value, ["taskId", "taskCreated", "flowRevision"]);
  if (!executionLinkInteger(fields.taskId, 1) || !executionLinkInteger(fields.taskCreated) || !executionLinkInteger(fields.flowRevision)) return invalid();
  return Object.freeze({ taskId: fields.taskId, taskCreated: fields.taskCreated, flowRevision: fields.flowRevision });
}
function publicText(value: unknown, maximum: number): string {
  const text = boundedText(value, maximum);
  if (!executionText(text.replaceAll("\n", "").replaceAll("\t", ""), maximum)) return invalid();
  return text;
}
export function parseGuidancePublicRecord(value: unknown): GuidancePublicRecord {
  const f = object(value, ["id", "experimentId", "taskId", "taskCreated", "flowRevision", "roleId", "layer", "baselineSha256", "candidateSha256", "changedSections", "bytes", "author", "status", "applicable", "rationale", "evidence"]);
  const current = currentBinding({ taskId: f.taskId, taskCreated: f.taskCreated, flowRevision: f.flowRevision });
  if (!executionText(f.roleId, EXECUTION_REFERENCE_LIMITS.id) || !/^[a-z][a-z0-9-]{0,47}$/.test(f.roleId) || !actor(f.author)
    || !["shipped", "project"].includes(f.layer as string) || !["declared", "withdrawn"].includes(f.status as string)
    || typeof f.applicable !== "boolean" || f.status === "withdrawn" && f.applicable) return invalid();
  const changed = array(f.changedSections, EDITABLE_NAMES.length);
  if (changed.some(name => !EDITABLE_NAMES.includes(name as GuidanceEditableSection)) || new Set(changed).size !== changed.length) return invalid();
  const size = object(f.bytes, ["baseline", "candidate", "record"]);
  if (!executionLinkInteger(size.baseline, 1) || size.baseline > GUIDANCE_ROLE_MAX_BYTES || !executionLinkInteger(size.candidate, 1)
    || size.candidate > GUIDANCE_ROLE_MAX_BYTES || !executionLinkInteger(size.record, 1) || size.record > GUIDANCE_RECORD_MAX_BYTES) return invalid();
  const why = object(f.rationale, ["problemHypothesis", "expectedObservableDifference"]);
  const evidence = array(f.evidence, GUIDANCE_EVIDENCE_MAX_REFS).map(item => {
    const entry = object(item, ["key", "status"]);
    if (entry.status !== "declared" && entry.status !== "unavailable") return invalid();
    return { key: hash(entry.key), status: entry.status };
  });
  if (new Set(evidence.map(entry => entry.key)).size !== evidence.length) return invalid();
  return { id: hash(f.id), experimentId: identity(f.experimentId), ...current, roleId: f.roleId, layer: f.layer as CatalogRole["layer"],
    baselineSha256: hash(f.baselineSha256), candidateSha256: hash(f.candidateSha256), changedSections: changed as GuidanceEditableSection[],
    bytes: { baseline: size.baseline, candidate: size.candidate, record: size.record }, author: f.author,
    status: f.status as "declared" | "withdrawn", applicable: f.applicable,
    rationale: { problemHypothesis: publicText(why.problemHypothesis, GUIDANCE_RATIONALE_MAX_BYTES), expectedObservableDifference: publicText(why.expectedObservableDifference, GUIDANCE_RATIONALE_MAX_BYTES) }, evidence };
}
function replyBytes<T>(value: T): T { const text = JSON.stringify(value); if (typeof text !== "string" || Buffer.byteLength(text) > GUIDANCE_REPLY_MAX_BYTES) return invalid(); return value; }
function inCurrent(record: GuidancePublicRecord, current: GuidanceCurrent): void {
  if (record.taskId !== current.taskId || record.taskCreated !== current.taskCreated || record.applicable && record.flowRevision !== current.flowRevision) return invalid();
}
function unavailable(fields: Record<string, unknown>): { state: "unavailable" } | undefined {
  if (fields.state !== "unavailable") return undefined;
  if (Object.keys(fields).length !== 1) return invalid();
  return { state: "unavailable" };
}
export function parseGuidancePageResult(value: unknown, expected?: Pick<GuidanceCurrent, "taskId" | "taskCreated">): GuidancePageResult {
  const f = object(value, ["state", "current", "records", "truncated", "cursor"]), hidden = unavailable(f); if (hidden) return hidden;
  if (f.state !== "available" || typeof f.truncated !== "boolean") return invalid();
  const current = currentBinding(f.current), records = array(f.records, GUIDANCE_PAGE_MAX_RECORDS).map(parseGuidancePublicRecord);
  if (expected && (current.taskId !== expected.taskId || current.taskCreated !== expected.taskCreated)) return invalid();
  for (const record of records) inCurrent(record, current);
  if (new Set(records.map(record => record.id)).size !== records.length) return invalid();
  if (f.truncated ? !guidanceCursorText(f.cursor) || !records.length : f.cursor !== undefined) return invalid();
  return replyBytes({ state: "available", current, records, truncated: f.truncated, ...(f.truncated ? { cursor: f.cursor as string } : {}) });
}
export function parseGuidanceDiffResult(value: unknown, expected?: Pick<GuidanceSelector, "taskId" | "taskCreated" | "id">): GuidanceDiffResult {
  const f = object(value, ["state", "current", "record", "sections", "protectedSections"]), hidden = unavailable(f); if (hidden) return hidden;
  if (f.state !== "available") return invalid();
  const current = currentBinding(f.current), record = parseGuidancePublicRecord(f.record); inCurrent(record, current);
  if (expected && (current.taskId !== expected.taskId || current.taskCreated !== expected.taskCreated || record.id !== expected.id)) return invalid();
  const sections = array(f.sections, EDITABLE_NAMES.length).map((raw, index) => {
    const entry = object(raw, ["section", "before", "after"]); if (entry.section !== EDITABLE_NAMES[index]) return invalid();
    return { section: entry.section as GuidanceEditableSection, before: publicText(entry.before, GUIDANCE_ROLE_MAX_BYTES), after: publicText(entry.after, GUIDANCE_ROLE_MAX_BYTES) };
  });
  const protectedSections = array(f.protectedSections, PROTECTED_NAMES.length);
  if (sections.length !== EDITABLE_NAMES.length || protectedSections.length !== PROTECTED_NAMES.length
    || protectedSections.some((name, index) => name !== PROTECTED_NAMES[index])) return invalid();
  return replyBytes({ state: "available", current, record, sections, protectedSections: [...PROTECTED_NAMES] });
}
export function parseGuidanceWriteReceipt(value: unknown): GuidanceWriteReceipt {
  const f = object(value, ["id", "taskId", "experimentId", "status", "already"]);
  if (!executionLinkInteger(f.taskId, 1) || !["declared", "withdrawn"].includes(f.status as string) || typeof f.already !== "boolean") return invalid();
  return { id: hash(f.id), taskId: f.taskId, experimentId: identity(f.experimentId), status: f.status as "declared" | "withdrawn", already: f.already };
}
export const guidanceCursorText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= GUIDANCE_CURSOR_MAX_BYTES && !/[^A-Za-z0-9_-]/.test(value);
export function parseGuidanceListQuery(value: unknown): Pick<GuidanceCurrent, "taskId" | "taskCreated"> & { cursor?: string } {
  const f = object(value, ["taskId", "taskCreated", "cursor"]);
  if (!executionLinkInteger(f.taskId, 1) || !executionLinkInteger(f.taskCreated) || f.cursor !== undefined && !guidanceCursorText(f.cursor)) return invalid();
  return { taskId: f.taskId, taskCreated: f.taskCreated, ...(f.cursor === undefined ? {} : { cursor: f.cursor as string }) };
}
export interface GuidanceCursorContext extends GuidanceCurrent { readonly projectKey: string; readonly actor: string }
const cursorSignature = (key: string, context: GuidanceCursorContext, after: string): string => createHmac("sha256", key)
  .update(JSON.stringify([1, context.projectKey, context.actor, context.taskId, context.taskCreated, context.flowRevision, after])).digest("hex");
export function guidancePageCursor(key: string, context: GuidanceCursorContext, after: string): string {
  hash(after);
  return Buffer.from(JSON.stringify({ v: 1, after, signature: cursorSignature(key, context, after) })).toString("base64url");
}
export function guidancePageAfter(key: string, context: GuidanceCursorContext, cursor: string): string {
  if (!guidanceCursorText(cursor)) return invalid();
  const raw = Buffer.from(cursor, "base64url"); if (raw.toString("base64url") !== cursor) return invalid();
  const fields = object(JSON.parse(raw.toString("utf8")), ["v", "after", "signature"]);
  if (fields.v !== 1) return invalid();
  const after = hash(fields.after), signature = hash(fields.signature), expected = cursorSignature(key, context, after);
  if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) return invalid();
  return after;
}

export interface GuidanceIdSelector { readonly taskId: number; readonly taskCreated: number; readonly id: string; readonly flowRevision?: number }
export function parseGuidanceIdQuery(value: unknown, withdraw = false): GuidanceIdSelector {
  const f = object(value, withdraw ? ["taskId", "taskCreated", "flowRevision", "id"] : ["taskId", "taskCreated", "id"]);
  if (!executionLinkInteger(f.taskId, 1) || !executionLinkInteger(f.taskCreated) || withdraw && !executionLinkInteger(f.flowRevision)) return invalid();
  return { taskId: f.taskId, taskCreated: f.taskCreated, id: hash(f.id), ...(withdraw ? { flowRevision: f.flowRevision as number } : {}) };
}

export function parseGuidanceCreateInput(value: unknown): Readonly<GuidanceVariantV1> {
  return parseGuidanceVariantV1(object(value, ["variant"]).variant);
}
