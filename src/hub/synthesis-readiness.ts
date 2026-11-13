import { createHash } from "node:crypto";
import { types } from "node:util";
import { citationKeys } from "./citations.ts";
import { evidenceLinkCanonical, parseEvidenceLink, type EvidenceLinkV1 } from "./research-evidence.ts";

export const SYNTHESIS_LIMITS = Object.freeze({ manifestBytes: 64 * 1024, claims: 50, links: 128, citationKeyChars: 128 });
export interface SynthesisInventoryBinding { revision: number; sha256: string }
export interface SynthesisManifestClaim {
  claimId: string;
  claimRevision: string;
  inventory: SynthesisInventoryBinding;
  evidence: { id: string; revision: number; citationKey: string }[];
}
export interface SynthesisManifestV1 {
  schemaVersion: 1;
  taskId: number;
  taskCreated: number;
  deliverable: { id: string; sha256: string };
  bibliography: { id: string; sha256: string };
  claims: SynthesisManifestClaim[];
}
/** Withdrawal remains the host's evidence schema; this projection also accepts ordinary active link rows. */
export type SynthesisInventoryLink = EvidenceLinkV1 | { link: EvidenceLinkV1; status: "active" | "withdrawn" };
export interface SynthesisArtifactSnapshot {
  id: string;
  sha256?: string;
  state: "unchanged" | "changed" | "missing" | "unknown";
  /** Guarded complete Markdown/BibTeX text, never included in a readiness result. */
  text?: string;
}
export interface SynthesisCurrentClaim {
  claimId: string;
  claimRevision: string;
  inventory?: { links: readonly SynthesisInventoryLink[]; complete: boolean };
  resolutions?: readonly { id: string; revision: number; status: "resolved" | "stale" | "unavailable" | "private" | "withdrawn" }[];
  /** Host-observed person authority, never a manifest field or a model's relation label. */
  judgment?: { present: boolean; manifestSha256?: string; disposition?: "resolved" | "qualified" };
}
/** Host-screened call-scoped observations only; never deserialize this interface from a tool caller. */
export interface SynthesisCurrent {
  taskId: number;
  taskCreated: number;
  private?: boolean;
  deliverable?: SynthesisArtifactSnapshot;
  bibliography?: SynthesisArtifactSnapshot;
  claims?: readonly SynthesisCurrentClaim[];
}
export type SynthesisNext = "refresh_manifest" | "provide_artifact" | "repair_citations" | "record_evidence" | "resolve_locator" | "record_person_judgment" | "resolve_contradiction" | "read_complete_inventory" | "complete_manifest_claims";
export interface SynthesisClaimReadiness {
  claimId: string;
  claimRevision: string;
  claim: "current" | "stale" | "unknown";
  inventory: "current" | "stale" | "unknown";
  citationKey: "resolved" | "missing" | "unknown";
  evidenceLink: "present" | "missing" | "stale" | "unknown";
  locator: "resolved" | "stale" | "unavailable" | "unknown";
  /** Fresh source/projection provenance for every active inventory row, including unselected counterevidence. */
  provenance: "resolved" | "stale" | "unavailable" | "unknown";
  judgment: "present" | "missing" | "unknown";
  contradiction: "none" | "open" | "resolved" | "qualified" | "unknown";
  selected: number;
  next: SynthesisNext[];
}
export type SynthesisReadiness = { taskId: number; status: "private" } | {
  taskId: number;
  status: "ready" | "not_ready" | "stale" | "unknown";
  /** Structural/provenance readiness only, never entailment or fact certification. */
  scope: "structural_provenance";
  manifestSha256: string;
  binding: "current" | "stale" | "unknown";
  /** Coverage of the full currently declared task list only, never undeclared textual/semantic claims. */
  claimCoverage: "complete" | "partial" | "unknown";
  deliverable: SynthesisArtifactSnapshot["state"];
  bibliography: SynthesisArtifactSnapshot["state"];
  citations: { state: "resolved" | "missing" | "unknown"; cited?: number; missing?: number };
  claims: SynthesisClaimReadiness[];
  next: SynthesisNext[];
};

const HASH = /^[a-f0-9]{64}$/, REVISION = /^[a-f0-9]{16}$/, LINK = /^ev:[a-f0-9]{32}$/, DELIVERABLE = /^d-[a-f0-9]{12}$/;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const invalid = (): never => { throw new Error("invalid synthesis manifest; use bounded task, artifact, claim and evidence bindings"); };
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, field]) => !fields.includes(key) || !Object.hasOwn(field, "value") || !field.enumerable)) return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > max || Object.getOwnPropertySymbols(value).length) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1) return invalid();
  for (let i = 0; i < value.length; i++) if (!descriptors[i] || !Object.hasOwn(descriptors[i]!, "value") || !descriptors[i]!.enumerable) return invalid();
  return value;
}
const integer = (value: unknown, min = 1): number => typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : invalid();
const token = (value: unknown, pattern: RegExp): string => typeof value === "string" && pattern.test(value) ? value : invalid();
function claimIdentity(value: unknown, taskId: number, created: number): string {
  const id = token(value, /^claim:[1-9][0-9]{0,15}:(?:0|[1-9][0-9]{0,15}):[1-9][0-9]?$/);
  const slot = Number(id.split(":").at(-1));
  return slot <= SYNTHESIS_LIMITS.claims && id === `claim:${taskId}:${created}:${slot}` ? id : invalid();
}
function artifact(value: unknown): SynthesisManifestV1["deliverable"] {
  const row = object(value, ["id", "sha256"]);
  return { id: token(row.id, DELIVERABLE), sha256: token(row.sha256, HASH) };
}

export function parseSynthesisManifest(input: unknown): SynthesisManifestV1 {
  const row = object(input, ["schemaVersion", "taskId", "taskCreated", "deliverable", "bibliography", "claims"]);
  if (row.schemaVersion !== 1) return invalid();
  const taskId = integer(row.taskId), taskCreated = integer(row.taskCreated, 0), seen = new Set<string>(), selected = new Set<string>();
  const claims = array(row.claims, SYNTHESIS_LIMITS.claims).map(value => {
    const claim = object(value, ["claimId", "claimRevision", "inventory", "evidence"]), id = claimIdentity(claim.claimId, taskId, taskCreated);
    if (seen.has(id)) return invalid(); seen.add(id);
    const inventory = object(claim.inventory, ["revision", "sha256"]);
    const evidence = array(claim.evidence, SYNTHESIS_LIMITS.links).map(value => {
      const ref = object(value, ["id", "revision", "citationKey"]), id = token(ref.id, LINK);
      if (selected.has(id) || selected.size >= SYNTHESIS_LIMITS.links) return invalid(); selected.add(id);
      const citationKey = token(ref.citationKey, /^[A-Za-z0-9_:./-]+$/);
      if (citationKey.length > SYNTHESIS_LIMITS.citationKeyChars) return invalid();
      return { id, revision: integer(ref.revision), citationKey };
    });
    return { claimId: id, claimRevision: token(claim.claimRevision, REVISION), inventory: { revision: integer(inventory.revision, 0), sha256: token(inventory.sha256, HASH) }, evidence };
  });
  if (!claims.length) return invalid();
  const parsed: SynthesisManifestV1 = { schemaVersion: 1, taskId, taskCreated, deliverable: artifact(row.deliverable), bibliography: artifact(row.bibliography), claims };
  if (Buffer.byteLength(JSON.stringify(parsed)) > SYNTHESIS_LIMITS.manifestBytes) return invalid();
  return parsed;
}
export function synthesisManifestCanonical(input: unknown): string { return JSON.stringify(parseSynthesisManifest(input)); }
export function synthesisManifestHash(input: unknown): string { return sha(synthesisManifestCanonical(input)); }

function inventoryRows(latest: readonly SynthesisInventoryLink[], complete: boolean): { link: EvidenceLinkV1; status: "active" | "withdrawn" }[] | undefined {
  try {
    if (complete !== true) return undefined;
    const seen = new Set<string>(); let identity: string | undefined;
    return array(latest, SYNTHESIS_LIMITS.links).map(value => {
      const wrapped = value && typeof value === "object" && !types.isProxy(value) && Object.hasOwn(value, "link");
      const row = wrapped ? object(value, ["link", "status"]) : undefined;
      if (row && row.status !== "active" && row.status !== "withdrawn") return invalid();
      const link = parseEvidenceLink(row ? row.link : value), incarnation = link.claimId.split(":");
      claimIdentity(link.claimId, link.taskId, Number(incarnation[2]));
      const key = `${link.taskId}|${link.claimId}|${link.claimRevision}`;
      if (seen.has(link.id) || identity !== undefined && identity !== key) return invalid();
      seen.add(link.id); identity = key;
      return { link, status: link.status === "withdrawn" || row?.status === "withdrawn" ? "withdrawn" as const : "active" as const };
    });
  } catch { return undefined; }
}
/** Complete latest inventory only, including unselected counterevidence and explicit host withdrawal states. */
export function inventoryBinding(latest: readonly SynthesisInventoryLink[], complete: boolean): SynthesisInventoryBinding | undefined {
  const rows = inventoryRows(latest, complete); if (!rows) return undefined;
  let revision = 0;
  for (const row of rows) { revision += row.link.revision; if (!Number.isSafeInteger(revision)) return undefined; }
  const canonical = rows.sort((a, b) => (a.link.id < b.link.id ? -1 : a.link.id > b.link.id ? 1 : a.link.revision - b.link.revision))
    .map(row => ({ link: evidenceLinkCanonical(row.link), status: row.status }));
  return { revision, sha256: sha(JSON.stringify(canonical)) };
}

function artifactState(expected: SynthesisManifestV1["deliverable"], current: SynthesisArtifactSnapshot | undefined): SynthesisArtifactSnapshot["state"] {
  if (!current) return "unknown";
  if (current.state === "missing") return "missing";
  if (current.id !== expected.id || current.state === "changed" || current.sha256 !== undefined && current.sha256 !== expected.sha256) return "changed";
  if (current.state !== "unchanged" || current.sha256 !== expected.sha256) return "unknown";
  if (current.text !== undefined && sha(current.text) !== expected.sha256) return "changed";
  return "unchanged";
}
const unique = <T>(items: T[]): T[] => [...new Set(items)];
function mergeResolution(prior: SynthesisClaimReadiness["locator"], status: string | undefined): SynthesisClaimReadiness["locator"] {
  if (prior === "stale" || status === "stale" || status === "withdrawn") return "stale";
  if (prior === "unavailable" || status === "unavailable") return "unavailable";
  return prior === "unknown" || status !== "resolved" ? "unknown" : "resolved";
}
function declaredClaims(current: SynthesisCurrent): readonly SynthesisCurrentClaim[] | undefined {
  try {
    const rows = array(current.claims, SYNTHESIS_LIMITS.claims), seen = new Set<string>();
    let revision: string | undefined;
    for (const value of rows) {
      if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return undefined;
      const row = value as SynthesisCurrentClaim;
      const id = claimIdentity(row.claimId, current.taskId, current.taskCreated), currentRevision = token(row.claimRevision, REVISION);
      if (seen.has(id) || revision !== undefined && currentRevision !== revision) return undefined;
      seen.add(id); revision = currentRevision;
    }
    return rows as SynthesisCurrentClaim[];
  } catch { return undefined; }
}

/** Pure structural/provenance check over current HOST observations; no fact, entailment or model certification. */
export function checkSynthesis(input: unknown, current: SynthesisCurrent): SynthesisReadiness {
  const manifest = parseSynthesisManifest(input);
  if (current.private === true) return { taskId: manifest.taskId, status: "private" };
  const manifestSha256 = synthesisManifestHash(manifest), sameTask = current.taskId === manifest.taskId && current.taskCreated === manifest.taskCreated;
  const declared = sameTask ? declaredClaims(current) : undefined, safeClaims = declared ?? [];
  if (safeClaims.some(claim => Array.isArray(claim.resolutions) && claim.resolutions.some(row => row?.status === "private"))) return { taskId: manifest.taskId, status: "private" };
  const deliverable = artifactState(manifest.deliverable, current.deliverable), bibliography = artifactState(manifest.bibliography, current.bibliography);
  let citations: Extract<SynthesisReadiness, { scope: string }>["citations"] = { state: "unknown" }, cited = new Set<string>(), missing = new Set<string>();
  if (deliverable === "unchanged" && bibliography === "unchanged" && typeof current.deliverable?.text === "string" && typeof current.bibliography?.text === "string") {
    try { const keys = citationKeys(current.deliverable.text, current.bibliography.text); cited = new Set(keys.cited); missing = new Set(keys.missing); citations = { state: keys.missing.length ? "missing" : "resolved", cited: keys.cited.length, missing: keys.missing.length }; }
    catch { /* Bounded/unknown text never establishes citation completeness. */ }
  }
  const manifestClaims = new Set(manifest.claims.map(claim => claim.claimId));
  const claimCoverage = declared === undefined ? "unknown" : declared.length === manifestClaims.size && declared.every(claim => manifestClaims.has(claim.claimId)) ? "complete" : "partial";
  const claims: SynthesisClaimReadiness[] = manifest.claims.map(claim => {
    const observed = sameTask ? safeClaims.find(row => row.claimId === claim.claimId) : undefined;
    const identity = !sameTask || observed && observed.claimRevision !== claim.claimRevision ? "stale" : observed ? "current" : "unknown";
    const rows = observed?.inventory && identity === "current" ? inventoryRows(observed.inventory.links, observed.inventory.complete) : undefined;
    const matching = rows?.every(row => row.link.claimId === claim.claimId && row.link.claimRevision === claim.claimRevision && row.link.taskId === manifest.taskId);
    const binding = observed?.inventory && matching ? inventoryBinding(observed.inventory.links, observed.inventory.complete) : undefined;
    const inventory = identity === "stale" ? "stale" : !binding ? "unknown" : binding.revision === claim.inventory.revision && binding.sha256 === claim.inventory.sha256 ? "current" : "stale";
    let evidenceLink: SynthesisClaimReadiness["evidenceLink"] = rows && matching ? "present" : "unknown";
    let locator: SynthesisClaimReadiness["locator"] = "resolved";
    if (!claim.evidence.length) { evidenceLink = "missing"; locator = "unknown"; }
    const resolutions = observed?.resolutions;
    const completeResolutions = Array.isArray(resolutions) && resolutions.length <= SYNTHESIS_LIMITS.links && new Set(resolutions.map(row => row.id)).size === resolutions.length ? resolutions : [];
    let provenance: SynthesisClaimReadiness["provenance"] = rows && matching ? "resolved" : "unknown";
    for (const row of rows ?? []) if (row.status === "active") {
      const resolution = completeResolutions.find(item => item.id === row.link.id && item.revision === row.link.revision);
      provenance = mergeResolution(provenance, resolution?.status);
    }
    for (const ref of claim.evidence) {
      const row = rows?.find(row => row.link.id === ref.id);
      if (rows && matching && !row) evidenceLink = evidenceLink === "stale" ? "stale" : "missing";
      else if (row && (row.link.revision !== ref.revision || row.status === "withdrawn")) evidenceLink = "stale";
      const resolution = completeResolutions.find(row => row.id === ref.id && row.revision === ref.revision);
      locator = mergeResolution(locator, resolution?.status);
    }
    const citationKey = citations.state === "unknown" ? "unknown" : claim.evidence.length && claim.evidence.every(ref => cited.has(ref.citationKey) && !missing.has(ref.citationKey)) ? "resolved" : "missing";
    const judgment = observed?.judgment?.present === true ? "present" : observed?.judgment?.present === false ? "missing" : "unknown";
    let contradiction: SynthesisClaimReadiness["contradiction"] = !rows || !matching ? "unknown" : rows.some(row => row.status === "active" && row.link.relation === "contradicts") ? "open" : "none";
    if (contradiction === "open" && identity === "current" && inventory === "current" && evidenceLink === "present" && locator === "resolved" && provenance === "resolved"
      && deliverable === "unchanged" && bibliography === "unchanged"
      && judgment === "present" && observed?.judgment?.manifestSha256 === manifestSha256
      && (observed.judgment.disposition === "resolved" || observed.judgment.disposition === "qualified")) contradiction = observed.judgment.disposition;
    const next: SynthesisNext[] = [];
    if (identity === "stale" || inventory === "stale" || evidenceLink === "stale") next.push("refresh_manifest");
    if (inventory === "unknown") next.push("read_complete_inventory");
    if (citationKey !== "resolved") next.push("repair_citations");
    if (evidenceLink !== "present") next.push("record_evidence");
    if (locator !== "resolved" || provenance !== "resolved") next.push("resolve_locator");
    if (judgment !== "present") next.push("record_person_judgment");
    if (contradiction === "open" || contradiction === "unknown") next.push("resolve_contradiction");
    return { claimId: claim.claimId, claimRevision: claim.claimRevision, claim: identity, inventory, citationKey, evidenceLink, locator, provenance, judgment, contradiction, selected: claim.evidence.length, next: unique(next) };
  });
  const stale = !sameTask || deliverable === "changed" || bibliography === "changed" || claims.some(row => row.claim === "stale" || row.inventory === "stale" || row.evidenceLink === "stale" || row.locator === "stale" || row.provenance === "stale");
  const unknown = claimCoverage === "unknown" || deliverable === "unknown" || bibliography === "unknown" || citations.state === "unknown" || claims.some(row => row.claim === "unknown" || row.inventory === "unknown" || row.evidenceLink === "unknown" || row.locator === "unknown" || row.locator === "unavailable" || row.provenance === "unknown" || row.provenance === "unavailable" || row.judgment === "unknown" || row.contradiction === "unknown");
  const bindingUnknown = claimCoverage === "unknown" || deliverable === "unknown" || bibliography === "unknown" || claims.some(row => row.claim === "unknown" || row.inventory === "unknown" || row.evidenceLink === "unknown" || row.locator === "unknown" || row.locator === "unavailable" || row.provenance === "unknown" || row.provenance === "unavailable");
  const ready = !stale && !unknown && claimCoverage === "complete" && deliverable === "unchanged" && bibliography === "unchanged" && citations.state === "resolved" && claims.every(row => !row.next.length);
  const next = unique<SynthesisNext>([...(!sameTask || stale ? ["refresh_manifest" as const] : []), ...(claimCoverage !== "complete" ? ["complete_manifest_claims" as const] : []), ...(deliverable !== "unchanged" || bibliography !== "unchanged" ? ["provide_artifact" as const] : []), ...(citations.state !== "resolved" ? ["repair_citations" as const] : []), ...claims.flatMap(row => row.next)]);
  return { taskId: manifest.taskId, status: stale ? "stale" : ready ? "ready" : unknown ? "unknown" : "not_ready", scope: "structural_provenance", manifestSha256, binding: stale ? "stale" : bindingUnknown ? "unknown" : "current", claimCoverage, deliverable, bibliography, citations, claims, next };
}
