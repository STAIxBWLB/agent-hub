import { createHash } from "node:crypto";
import { types } from "node:util";
import { executionText, EXECUTION_REFERENCE_LIMITS } from "./execution-reference.ts";

/** Published V1 format/admission bounds, not native execution guarantees. */
export const GUIDANCE_PROBE_LIMITS = Object.freeze({ recordBytes: 32768, snapshotBytes: 32768,
  storageBytes: 1073741824, workerAttempts: 4, editorAttempts: 5, slots: 9, hashLength: 64 });
const registrationScaffoldBytes = Buffer.byteLength(JSON.stringify({ manifest: 0, snapshots: { task: "", baselineContext: "", dataPolicy: 0, systemPolicy: "", improverContext: "" } }));
/** Closed composition bounds, separate from each admitted manifest/snapshot ceiling. */
export const GUIDANCE_PROBE_REGISTRATION_BYTES = GUIDANCE_PROBE_LIMITS.recordBytes + GUIDANCE_PROBE_LIMITS.snapshotBytes
  + 4 * 2 * GUIDANCE_PROBE_LIMITS.snapshotBytes + registrationScaffoldBytes;
export const GUIDANCE_PROBE_SESSION_BYTES = 4 * GUIDANCE_PROBE_LIMITS.recordBytes;
export const GUIDANCE_PROBE_STOP_TIMEOUT_MS = 5000;
export const GUIDANCE_PROBE_FENCE_INTERVAL_MS = 250;
export const GUIDANCE_PROBE_MODEL = "qwen27b/qwen3.8-27b";
export type ProbeInteger = number;
export type ProbeSha256 = string;
export type ProbeId = string;
export type ProbeTree = { objectFormat: "sha1"; oid: string } | { objectFormat: "sha256"; oid: string };
export interface ProbeSnapshotRef { sha256: string; bytes: number }
export interface ProbeRoleIdentity { id: string; layer: "shipped" | "project"; baselineSha256: string }
export type ProbeArm = "baseline" | "candidate1" | "candidate2" | "successor";
export type ProbeStage = "baseline" | "proposal1" | "candidate1" | "proposal2" | "candidate2" | "compose" | "successor" | "select" | "reflect";
export interface ProbeSlot { id: string; stage: ProbeStage; role: "worker" | "proposal" | "compose" | "select" | "reflect"; arm: ProbeArm | "none"; retryOf?: string }
export interface GuidanceProbeManifestV1 {
  v: 1; projectKey: string; experimentId: string;
  task: { id: number; created: number; flowRevision: number };
  role: ProbeRoleIdentity;
  inputs: { task: ProbeSnapshotRef; baselineContext: ProbeSnapshotRef; dataPolicy: ProbeSnapshotRef; systemPolicy: ProbeSnapshotRef; codeTree: ProbeTree };
  runtime: { runtimeSha256: string; toolsetSha256: string; modelConfigSha256: string };
  model: { requested: typeof GUIDANCE_PROBE_MODEL; expectedServed: typeof GUIDANCE_PROBE_MODEL };
  guidance: { baselineSha256: string };
  improverContextHash?: string; improverContextBytes?: number;
  slots: readonly ProbeSlot[];
  limits: { modelCalls: number; toolCalls: number; elapsedMs: number; tokens?: number; inputBytes: number; scratchBytes: number; outputBytes: number };
  taskOrderSeed?: number;
}
export interface ProbeDataPolicyV1 {
  v: 1;
  allowedWrites: readonly { root: "scratch" | "output"; relative: string }[];
  admittedData: readonly { id: string; sha256: string; bytes: number }[];
  roles: {
    worker: { dataIds: readonly string[]; guidanceOnlyExperience: true };
    proposal: { dataIds: readonly string[]; improverContext: boolean };
    compose: { dataIds: readonly string[]; improverContext: boolean };
    select: { dataIds: readonly string[]; anonymizedDeliverables: true };
    reflect: { dataIds: readonly string[]; closedRoundOnly: true };
  };
}
export interface ProbePrivateSnapshots { task: string; baselineContext: string; dataPolicy: ProbeDataPolicyV1; systemPolicy: string; improverContext?: string }
export interface ProbeRegistrationV1 { manifest: GuidanceProbeManifestV1; snapshots: ProbePrivateSnapshots }
export type ProbeState = "declared" | "active" | "closing" | "closed_fixture" | "failed_fixture" | "unknown_held";
export type ProbeSessionState = "planned" | "reserved" | "running" | "failed_known" | "closed_fixture" | "not_needed" | "unknown_held";
export type ProbeBudgetUnit = "model_calls" | "tool_calls" | "tokens" | "input_bytes" | "scratch_bytes" | "output_bytes";
export interface ProbeKey { projectKey: string; id: string }
export interface ProbeHostBinding {
  projectKey: string; actor: string; task: { id: number; created: number; flowRevision: number }; role: ProbeRoleIdentity;
  baselineGuidance: string; sessionGeneration: number | string; nativeSession: string | null; requestConnectionId: string;
}
export interface ProbeChildBinding {
  variantId: string; candidateSha256: string; guidanceSha256: string; task: ProbeHostBinding["task"]; role: ProbeRoleIdentity; guidance: string;
  authoring: "admitted_fixture" | "uncontrolled"; sourceSessionId: string | null;
}
export interface ProbeAdmissionRecheck { host: ProbeHostBinding; child?: ProbeChildBinding }
export interface ProbeSessionAdmission {
  key: ProbeKey; expectedRevision: number; host: ProbeHostBinding; child?: ProbeChildBinding; now: number;
}
export interface ProbeReservation { key: ProbeKey; slotId: string; generation: number; revision: number }
export interface ProbeStartSelector { requestedRevision: number; slotId: string; variantId: string | null; actor: string; sessionGeneration: number | string; nativeSession: string | null; requestConnectionId: string }
export interface ProbeReceipt { id: string; revision: number; state: ProbeState; already: boolean }
export type ProbeReservationResult = { kind: "granted"; reservation: ProbeReservation } | { kind: "existing"; receipt: ProbeReceipt };
export interface ProbeEffectAdmission { reservation: ProbeReservation; sequence: number; unit: ProbeBudgetUnit; amount: number; reservedTokens?: number; descriptorSha256: string; now: number }
export type ProbeEffectAdmissionResult = { kind: "granted"; admission: ProbeEffectAdmission } | { kind: "existing"; state: "pending" | "settled" | "unknown" };
export interface ProbeEffectSettlement { admission: ProbeEffectAdmission; outcome: "settled" | "unknown" }
export interface ProbeSessionSettlement { reservation: ProbeReservation; outcome: "closed_fixture" | "failed_known" | "unknown"; candidateArtifactSha256: string | null; now: number }
export interface ProbeUsageObservation { admission: ProbeEffectAdmission; observed: number | null; observationSha256: string }
export interface ProbeCancellation { key: ProbeKey; expectedRevision: number; host: ProbeHostBinding }
export interface ProbeCounters {
  workerAttempts: number; editorAttempts: number; modelCalls: number; toolCalls: number; tokensReserved: number; tokensObservedKnown: number;
  inputBytes: number; scratchBytes: number; outputBytes: number; elapsedHighWaterMs: number; usageUnknown: boolean;
}
export interface ProbeSession {
  slotId: string; generation: number; revision: number; state: ProbeSessionState; candidateArtifactSha256: string | null;
  child?: ProbeChildBinding;
  start?: ProbeStartSelector;
}
export interface ProbeStoredState {
  registration: ProbeRegistrationV1; binding: ProbeHostBinding; receipt: ProbeReceipt; counters: ProbeCounters;
  firstReservedAt: number | null; admissionHold: "none" | "elapsed" | "observation" | "usage"; cancelRequested: boolean; notNeeded: number; sessions: readonly ProbeSession[];
}
export interface ProbeIntegrity { experiments: number; sessions: number; digest: string }
export interface ProbeFakeLaunch { reservation: ProbeReservation; slot: ProbeSlot; manifest: GuidanceProbeManifestV1; inputFrame: string; inputSha256: string; nonGuidanceInputSha256: string; purpose: "guidance_probe" }
export interface ProbeFakeObservation {
  reservation: ProbeReservation; outcome: "closed_fixture" | "failed_known" | "unknown"; servedModel: string | null;
  inputFrameHash: string | null;
  workerEffectiveInputHash: string | null; nonGuidanceInputSha256: string | null; candidateArtifactSha256: string | null; usage: "known_fixture" | "unknown";
}
export interface ProbeFakeStop { reservation: ProbeReservation }
export interface ProbeFakeStopObservation { reservation: ProbeReservation; stopped: "known_fixture" | "unknown" }
export interface ProbeFakeEffectRequest { sequence: number; unit: "model_calls" | "tool_calls"; descriptorSha256: string; reservedTokens?: number }
export interface ProbeFakeEffectValue<T> { value: T; usage: number | null; observationSha256: string }
export type ProbeFakeEffectResult<T> = { kind: "executed"; value: T } | { kind: "existing"; state: "pending" | "settled" | "unknown" };
export interface ProbeFakeEffects {
  runEffect<T>(request: ProbeFakeEffectRequest, effect: (signal: AbortSignal) => Promise<ProbeFakeEffectValue<T>>): Promise<ProbeFakeEffectResult<T>>;
}
/** Host test constructor only: never selected by manifest, configuration or a wire field. */
export interface GuidanceProbeFakePorts {
  launch(input: ProbeFakeLaunch, effects: ProbeFakeEffects, signal: AbortSignal): Promise<ProbeFakeObservation>;
  stop(input: ProbeFakeStop, signal: AbortSignal): Promise<ProbeFakeStopObservation>;
}
export interface ProbePublicReceipt extends ProbeReceipt { experimentId: string; taskId: number; evidence: "declaration" | "fixture" | "unknown" }
export interface ProbePublicStatus extends ProbePublicReceipt { counters: ProbeCounters; cancelRequested: boolean; notNeeded: number; comparable: boolean; authoring: "admitted_fixture" | "uncontrolled" | "unknown" }
export type GuidanceProbeCommand = { op: "register"; file: string; json: boolean }
  | { op: "start"; id: string; revision: number; variantId?: string; json: boolean }
  | { op: "show"; id: string; json: boolean } | { op: "cancel"; id: string; revision: number; json: boolean };

export class GuidanceProbeError extends Error {
  constructor(readonly reason: "invalid" | "changed" | "budget" | "held" | "runner" | "storage") {
    super({ invalid: "invalid probe fields or bounds; reload the closed V1 declaration before retrying",
      changed: "probe binding or revision changed; read the current task, G1 and probe before retrying",
      budget: "probe aggregate budget is exhausted or unknown; inspect the retained accounting before a separate experiment",
      held: "probe outcome is uncertain or already active; inspect retained state without replaying work",
      runner: "probe runner is unavailable in production T1; use fake-only fixtures, not a live launch",
      storage: "probe storage is invalid or unavailable; inspect retained probe state before retrying" }[reason]);
    this.name = "GuidanceProbeError";
  }
}
const invalid = (): never => { throw new GuidanceProbeError("invalid"); };
export const probeHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const probeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const probeSha256 = (value: unknown): value is string => typeof value === "string" && value.length === GUIDANCE_PROBE_LIMITS.hashLength && /^[a-f0-9]+$/.test(value);
const identity = (value: unknown): value is string => executionText(value, EXECUTION_REFERENCE_LIMITS.id) && !/\p{Cf}/u.test(value);
export const probeSessionGeneration = (value: unknown): value is number | string => probeInteger(value) || identity(value);
const required = (condition: unknown): void => { if (!condition) invalid(); };

/** Bounded inert copy: no getter, iterator, proxy, toJSON, sparse array or cycle is evaluated. */
function inert(value: unknown, maximum: number): unknown {
  let remaining = maximum;
  const seen = new Set<object>();
  const charge = (bytes: number) => { remaining -= bytes; if (remaining < 0) invalid(); };
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) { charge(Buffer.byteLength(JSON.stringify(item))); return item; }
    if (typeof item === "string") { if (item.length > remaining) invalid(); charge(Buffer.byteLength(JSON.stringify(item))); return item; }
    if (!item || typeof item !== "object" || types.isProxy(item) || seen.has(item)) return invalid();
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > remaining) return invalid();
    seen.add(item); charge(2);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, "length")?.value;
      if (!probeInteger(length) || keys.length !== length + 1) return invalid();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, String(index));
        if (!field || !("value" in field) || !field.enumerable) return invalid();
        if (index) charge(1); result.push(copy(field.value));
      }
      seen.delete(item); return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let index = 0;
    for (const key of keys) {
      if (typeof key !== "string") return invalid();
      const field = Object.getOwnPropertyDescriptor(item, key);
      if (!field || !("value" in field) || !field.enumerable) return invalid();
      charge(Buffer.byteLength(JSON.stringify(key)) + 1 + (index++ ? 1 : 0)); result[key] = copy(field.value);
    }
    seen.delete(item); return result;
  };
  return copy(value);
}
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(fields, key))) return invalid();
  return fields;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const guidanceProbeCanonical = (value: unknown, maximum: number = GUIDANCE_PROBE_LIMITS.recordBytes): string => canonical(inert(value, maximum));
function ref(value: unknown): void { const fields = object(value, ["sha256", "bytes"]); required(probeSha256(fields.sha256) && probeInteger(fields.bytes) && fields.bytes <= GUIDANCE_PROBE_LIMITS.snapshotBytes); }
function role(value: unknown): void { const fields = object(value, ["id", "layer", "baselineSha256"]); required(identity(fields.id) && ["shipped", "project"].includes(fields.layer as string) && probeSha256(fields.baselineSha256)); }
const graph: readonly [ProbeStage, ProbeSlot["role"], ProbeSlot["arm"]][] = [
  ["baseline", "worker", "baseline"], ["proposal1", "proposal", "none"], ["candidate1", "worker", "candidate1"],
  ["proposal2", "proposal", "none"], ["candidate2", "worker", "candidate2"], ["compose", "compose", "none"],
  ["successor", "worker", "successor"], ["select", "select", "none"], ["reflect", "reflect", "none"] ];
function slots(value: unknown): void {
  required(Array.isArray(value) && value.length > 0 && value.length <= GUIDANCE_PROBE_LIMITS.slots);
  const list = value as ProbeSlot[], ids = new Set<string>(), counts = new Map<string, number>();
  let last = -1;
  for (const slot of list) {
    const fields = object(slot, ["id", "stage", "role", "arm"], ["retryOf"]), position = graph.findIndex(item => item[0] === fields.stage);
    required(identity(fields.id) && !ids.has(fields.id as string) && position >= 0);
    required(graph[position]![1] === fields.role && graph[position]![2] === fields.arm);
    if (Object.hasOwn(fields, "retryOf")) {
      const prior = list[ids.size - 1];
      required(identity(fields.retryOf) && prior && prior.id === fields.retryOf && prior.stage === fields.stage && position === last);
    } else { required(position > last); last = position; }
    ids.add(slot.id); counts.set(slot.role, (counts.get(slot.role) ?? 0) + 1);
  }
  required(list[0]!.stage === "baseline" && list.some(item => item.stage === "candidate1"));
  required(!list.some(item => item.stage === "proposal2") || list.some(item => item.stage === "candidate2"));
  required(!list.some(item => item.stage === "compose") || list.some(item => item.stage === "successor"));
  required((counts.get("worker") ?? 0) <= GUIDANCE_PROBE_LIMITS.workerAttempts && (counts.get("proposal") ?? 0) <= 2
    && ["compose", "select", "reflect"].every(key => (counts.get(key) ?? 0) <= 1)
    && list.filter(item => item.role !== "worker").length <= GUIDANCE_PROBE_LIMITS.editorAttempts);
}
function manifest(value: unknown): GuidanceProbeManifestV1 {
  const fields = object(value, ["v", "projectKey", "experimentId", "task", "role", "inputs", "runtime", "model", "guidance", "slots", "limits"], ["improverContextHash", "improverContextBytes", "taskOrderSeed"]);
  required(fields.v === 1 && identity(fields.projectKey) && identity(fields.experimentId));
  const task = object(fields.task, ["id", "created", "flowRevision"]); required(probeInteger(task.id) && task.id > 0 && probeInteger(task.created) && probeInteger(task.flowRevision)); role(fields.role);
  const inputs = object(fields.inputs, ["task", "baselineContext", "dataPolicy", "systemPolicy", "codeTree"]);
  for (const key of ["task", "baselineContext", "dataPolicy", "systemPolicy"]) ref(inputs[key]);
  const tree = object(inputs.codeTree, ["objectFormat", "oid"]), oidLength = tree.objectFormat === "sha1" ? 40 : tree.objectFormat === "sha256" ? GUIDANCE_PROBE_LIMITS.hashLength : 0;
  required(typeof tree.oid === "string" && oidLength > 0 && tree.oid.length === oidLength && /^[a-f0-9]+$/.test(tree.oid));
  const runtime = object(fields.runtime, ["runtimeSha256", "toolsetSha256", "modelConfigSha256"]); required(Object.values(runtime).every(probeSha256));
  const model = object(fields.model, ["requested", "expectedServed"]); required(model.requested === GUIDANCE_PROBE_MODEL && model.expectedServed === GUIDANCE_PROBE_MODEL);
  required(probeSha256(object(fields.guidance, ["baselineSha256"]).baselineSha256));
  const limits = object(fields.limits, ["modelCalls", "toolCalls", "elapsedMs", "inputBytes", "scratchBytes", "outputBytes"], ["tokens"]);
  required(Object.values(limits).every(probeInteger));
  let bytes = GUIDANCE_PROBE_LIMITS.storageBytes;
  for (const key of ["inputBytes", "scratchBytes", "outputBytes"]) { required((limits[key] as number) <= bytes); bytes -= limits[key] as number; }
  required(Object.hasOwn(fields, "improverContextHash") === Object.hasOwn(fields, "improverContextBytes"));
  if (Object.hasOwn(fields, "improverContextHash")) { required(probeSha256(fields.improverContextHash)); required(probeInteger(fields.improverContextBytes) && fields.improverContextBytes <= GUIDANCE_PROBE_LIMITS.snapshotBytes); }
  if (Object.hasOwn(fields, "taskOrderSeed")) required(probeInteger(fields.taskOrderSeed));
  slots(fields.slots);
  return fields as unknown as GuidanceProbeManifestV1;
}
export function parseGuidanceProbeManifest(value: unknown): GuidanceProbeManifestV1 | undefined {
  try { return manifest(inert(value, GUIDANCE_PROBE_LIMITS.recordBytes)); } catch { return undefined; }
}
export function guidanceProbeManifestKey(value: GuidanceProbeManifestV1): string {
  const parsed = parseGuidanceProbeManifest(value); if (!parsed) return invalid();
  return probeHash(`agent-hub.guidance-probe.v1\n${guidanceProbeCanonical(parsed)}`);
}
function policy(value: unknown): ProbeDataPolicyV1 {
  const fields = object(value, ["v", "allowedWrites", "admittedData", "roles"]); required(fields.v === 1 && Array.isArray(fields.allowedWrites) && Array.isArray(fields.admittedData));
  const ids = new Set<string>(), writes = new Set<string>();
  for (const write of fields.allowedWrites as unknown[]) {
    const row = object(write, ["root", "relative"]); required(["scratch", "output"].includes(row.root as string) && identity(row.relative));
    const name = row.relative as string; required(!name.includes("\\") && !name.startsWith("/") && !/^[a-z]:/i.test(name) && name.split("/").every(part => part && part !== "." && part !== ".."));
    const key = `${row.root}/${name}`; required(!writes.has(key)); writes.add(key);
  }
  for (const data of fields.admittedData as unknown[]) { const row = object(data, ["id", "sha256", "bytes"]); required(identity(row.id) && !ids.has(row.id as string) && probeSha256(row.sha256) && probeInteger(row.bytes)); ids.add(row.id as string); }
  const roles = object(fields.roles, ["worker", "proposal", "compose", "select", "reflect"]);
  for (const [name, flag] of [["worker", "guidanceOnlyExperience"], ["proposal", "improverContext"], ["compose", "improverContext"], ["select", "anonymizedDeliverables"], ["reflect", "closedRoundOnly"]] as const) {
    const row = object(roles[name], ["dataIds", flag]); required(Array.isArray(row.dataIds) && typeof row[flag] === "boolean" && (flag === "improverContext" || row[flag] === true));
    const used = new Set<string>(); for (const id of row.dataIds as unknown[]) { required(identity(id) && ids.has(id as string) && !used.has(id as string)); used.add(id as string); }
  }
  return fields as unknown as ProbeDataPolicyV1;
}
export function parseGuidanceProbeRegistration(value: unknown): ProbeRegistrationV1 | undefined {
  try {
    // Inspect envelope/snapshot descriptors before any potentially large nested traversal.
    if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
    const names = Reflect.ownKeys(value);
    if (names.length !== 2 || !names.includes("manifest") || !names.includes("snapshots")) return undefined;
    const envelope = Object.getOwnPropertyDescriptors(value);
    if (Object.values(envelope).some(item => !("value" in item) || !item.enumerable)) return undefined;
    const parsed = parseGuidanceProbeManifest(envelope.manifest?.value); if (!parsed) return undefined;
    const raw = envelope.snapshots?.value;
    if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return undefined;
    const snapshots: Record<string, unknown> = Object.create(null), keys = Reflect.ownKeys(raw);
    if (keys.length > 5) return undefined;
    for (const key of keys) {
      if (typeof key !== "string" || !["task", "baselineContext", "dataPolicy", "systemPolicy", "improverContext"].includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key); if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      if (key === "dataPolicy") snapshots[key] = policy(inert(descriptor.value, GUIDANCE_PROBE_LIMITS.snapshotBytes));
      else { const text = descriptor.value; required(typeof text === "string" && Buffer.byteLength(text) <= GUIDANCE_PROBE_LIMITS.snapshotBytes
        && !/[\p{Cc}\p{Cs}]/u.test(text.replace(/[\t\r\n]/g, ""))); snapshots[key] = text; }
    }
    object(snapshots, ["task", "baselineContext", "dataPolicy", "systemPolicy"], ["improverContext"]);
    required(Object.hasOwn(snapshots, "improverContext") === Object.hasOwn(parsed, "improverContextHash"));
    let total = 0;
    for (const key of ["task", "baselineContext", "dataPolicy", "systemPolicy", "improverContext"] as const) {
      if (!Object.hasOwn(snapshots, key)) continue;
      const text = key === "dataPolicy" ? guidanceProbeCanonical(snapshots[key]) : snapshots[key] as string;
      const expected = key === "improverContext" ? { sha256: parsed.improverContextHash, bytes: parsed.improverContextBytes } : parsed.inputs[key];
      required(Buffer.byteLength(text) === expected.bytes && probeHash(text) === expected.sha256); total += Buffer.byteLength(text);
    }
    required(total <= parsed.limits.inputBytes);
    const result = { manifest: parsed, snapshots: snapshots as unknown as ProbePrivateSnapshots };
    if (Buffer.byteLength(JSON.stringify(result)) > GUIDANCE_PROBE_REGISTRATION_BYTES) return undefined;
    return result;
  } catch { return undefined; }
}

export function parseGuidanceProbeCommand(args: readonly string[]): GuidanceProbeCommand | undefined {
  const op = args[0]; if (!["register", "start", "show", "cancel"].includes(op ?? "")) return undefined;
  const fields = new Map<string, string>(), allowed = op === "register" ? ["--file"] : op === "show" ? ["--id"] : op === "start" ? ["--id", "--revision", "--variant"] : ["--id", "--revision"];
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!; if (key === "--json" && !json) { json = true; continue; }
    const value = args[++index]; if (!allowed.includes(key) || fields.has(key) || !value || value.startsWith("--")) return undefined; fields.set(key, value);
  }
  if (op === "register") return fields.has("--file") ? { op, file: fields.get("--file")!, json } : undefined;
  const id = fields.get("--id"); if (!probeSha256(id)) return undefined;
  if (op === "show") return { op, id, json };
  const raw = fields.get("--revision"), revision = raw && /^(?:0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : NaN;
  if (!probeInteger(revision)) return undefined;
  if (op === "cancel") return { op, id, revision, json };
  const variantId = fields.get("--variant"); if (variantId !== undefined && !probeSha256(variantId)) return undefined;
  return { op: "start", id, revision, ...(variantId === undefined ? {} : { variantId }), json };
}
export function parseGuidanceProbeSubcommand(args: readonly string[]): GuidanceProbeCommand | undefined {
  if (args[0] !== "probe") return undefined;
  return parseGuidanceProbeCommand(args.slice(1)) ?? invalid();
}

const probeStates: readonly ProbeState[] = ["declared", "active", "closing", "closed_fixture", "failed_fixture", "unknown_held"];
const publicEvidence = (value: unknown): value is ProbePublicReceipt["evidence"] => ["declaration", "fixture", "unknown"].includes(value as string);
function publicReceipt(value: unknown, status: boolean): ProbePublicReceipt | ProbePublicStatus | undefined {
  try {
    const extra = status ? ["counters", "cancelRequested", "notNeeded", "comparable", "authoring"] : [];
    const fields = object(value, ["id", "revision", "state", "already", "taskId", "experimentId", "evidence", ...extra]);
    required(probeSha256(fields.id) && probeInteger(fields.revision) && probeStates.includes(fields.state as ProbeState)
      && typeof fields.already === "boolean" && probeInteger(fields.taskId) && fields.taskId > 0
      && typeof fields.experimentId === "string" && fields.experimentId.length <= 256 && publicEvidence(fields.evidence));
    if (!status) return fields as unknown as ProbePublicReceipt;
    const counters = object(fields.counters, ["workerAttempts", "editorAttempts", "modelCalls", "toolCalls", "tokensReserved", "tokensObservedKnown",
      "inputBytes", "scratchBytes", "outputBytes", "elapsedHighWaterMs", "usageUnknown"]);
    required(Object.entries(counters).every(([key, item]) => key === "usageUnknown" ? typeof item === "boolean" : probeInteger(item))
      && typeof fields.cancelRequested === "boolean" && probeInteger(fields.notNeeded) && typeof fields.comparable === "boolean"
      && ["admitted_fixture", "uncontrolled", "unknown"].includes(fields.authoring as string));
    return fields as unknown as ProbePublicStatus;
  } catch { return undefined; }
}
export const parseGuidanceProbePublicReceipt = (value: unknown): ProbePublicReceipt | undefined => publicReceipt(value, false) as ProbePublicReceipt | undefined;
export const parseGuidanceProbePublicStatus = (value: unknown): ProbePublicStatus | undefined => publicReceipt(value, true) as ProbePublicStatus | undefined;

/** Explicit worker-visible bytes; no host identity, arm label or improver side channel. */
export function guidanceProbeWorkerFrame(task: string, baselineContext: string, systemPolicy: string, guidance: string): string {
  if ([task, baselineContext, systemPolicy].some(text => typeof text !== "string" || Buffer.byteLength(text) > GUIDANCE_PROBE_LIMITS.snapshotBytes)
    || typeof guidance !== "string") return invalid();
  return JSON.stringify({ task, baselineContext, systemPolicy, guidance });
}
export const guidanceProbeNonGuidanceInputHash = (task: string, baselineContext: string, systemPolicy: string): string => probeHash(JSON.stringify({ task, baselineContext, systemPolicy }));
