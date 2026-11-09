import { createHash } from "node:crypto";
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
