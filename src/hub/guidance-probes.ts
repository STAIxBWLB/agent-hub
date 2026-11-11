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
/** Hash/size of the exact frame built once by the trusted host before atomic admission. */
export interface ProbePreparedFrame { slotId: string; sha256: string; bytes: number }
export interface ProbePreparedWorkerFrame { inputFrame: string; nonGuidanceInputSha256: string }
export type ProbeWorkerFramePreparer = (state: ProbeStoredState, slot: ProbeSlot, guidance: string) => ProbePreparedWorkerFrame | Promise<ProbePreparedWorkerFrame>;
export interface ProbeResourceCharges { inputBytes?: number; scratchBytes?: number; outputBytes?: number }
export interface ProbeSessionAdmission {
  key: ProbeKey; expectedRevision: number; host: ProbeHostBinding; child?: ProbeChildBinding; preparedFrame?: ProbePreparedFrame; now: number;
}
export interface ProbeReservation { key: ProbeKey; slotId: string; generation: number; revision: number }
export interface ProbeStartSelector {
  requestedRevision: number; slotId: string; variantId: string | null; inputFrameSha256: string | null; inputFrameBytes: number;
  actor: string; sessionGeneration: number | string; nativeSession: string | null; requestConnectionId: string;
}
export interface ProbeReceipt { id: string; revision: number; state: ProbeState; already: boolean }
export type ProbeReservationResult = { kind: "granted"; reservation: ProbeReservation } | { kind: "existing"; receipt: ProbeReceipt };
export interface ProbeEffectAdmission { reservation: ProbeReservation; sequence: number; unit: ProbeBudgetUnit; amount: number; reservedTokens?: number; charges?: ProbeResourceCharges; descriptorSha256: string; now: number }
export type ProbeEffectAdmissionResult = { kind: "granted"; admission: ProbeEffectAdmission } | { kind: "existing"; state: "pending" | "settled" | "unknown" };
export interface ProbeEffectSettlement { admission: ProbeEffectAdmission; outcome: "settled" | "unknown" }
export interface ProbeSessionSettlement { reservation: ProbeReservation; outcome: "closed_fixture" | "failed_known" | "unknown"; candidateArtifactSha256: string | null; now: number }
export interface ProbeSessionCoverage {
  inputFrameSha256: string | null; inputFrameBytes: number; launchExposed: boolean; preLaunchFailure: boolean;
  modelCalls: number; modelUsageKnown: number; toolCalls: number; toolUsageKnown: number;
  usageUnknown: boolean; coverageVerified: boolean;
}
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
  coverage: ProbeSessionCoverage;
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
  /** What the host measured of the finished session (T3). The adapter cannot supply `startedAt`: the host samples it when it exposes the launch. */
  measured?: Omit<ProbeMeasuredSession, "startedAt">;
}
export interface ProbeFakeStop { reservation: ProbeReservation }
export interface ProbeFakeStopObservation { reservation: ProbeReservation; stopped: "known_fixture" | "unknown" }
export interface ProbeFakeEffectRequest { sequence: number; unit: "model_calls" | "tool_calls" | "resources"; descriptorSha256: string; reservedTokens?: number; charges?: ProbeResourceCharges }
export interface ProbeFakeEffectValue<T> { value: T; usage: number | null; observationSha256: string }
export type ProbeFakeEffectResult<T> = { kind: "executed"; value: T } | { kind: "existing"; state: "pending" | "settled" | "unknown" };
export interface ProbeFakeEffects {
  /** Fresh captured actor/G1/ledger fence; no authority is reconstructed from metadata. */
  current(): void;
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// T3 (#1226): host-observed receipts, the outcome denominator and comparability. Contract: docs/design/guidance-probes.md "T3 receipts, reconcile and cleanup contract".
// Everything here is pure: no storage, process or clock. The Store seals and hydrates; these functions only shape, check and classify.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Retained output is eligible for a prune this long after its receipt seals. A constant, not a setting; nothing deletes automatically. */
export const PROBE_RETENTION_DAYS = 14;
export const PROBE_RETENTION_MS = PROBE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const PROBE_OUTPUT_LIMITS = Object.freeze({ entries: 64, fileBytes: 1024 * 1024, receiptBytes: 16384 });

export type ProbeReceiptState = "succeeded" | "failed" | "cancelled" | "timed_out" | "unavailable" | "unknown";
export type ProbeReceiptLimit = "usage_unknown" | "served_model_unobserved" | "served_model_mismatch" | "teardown_unverified" | "output_truncated" | "storage_over_cap" | "coverage_unverified";
export type ProbeExcludedReason = "not_regular" | "linked" | "outside_declared_writes" | "over_file_cap" | "changed_while_read" | "over_entry_cap";
export interface ProbeOutputEntry { relative: string; sha256: string; bytes: number }
export interface ProbeOutputExcluded { relative: string; reason: ProbeExcludedReason }
export interface ProbeOutputManifestV1 { v: 1; entries: readonly ProbeOutputEntry[]; excluded: readonly ProbeOutputExcluded[]; totalBytes: number }
export interface ProbeReceiptUsage { modelCalls: number; modelUsageKnown: number; toolCalls: number; toolUsageKnown: number; tokensObserved: number | null }
/** The host's immutable record of one finished session. Every field is host-computed; none is a provider claim. */
export interface ProbeReceiptV1 {
  v: 1;
  experimentId: string;
  slotId: string;
  generation: number;
  revision: number;
  requestedModel: string;
  servedModel: string | null;
  inputFrameSha256: string | null;
  workerEffectiveInputSha256: string | null;
  nonGuidanceInputSha256: string | null;
  guidanceSha256: string | null;
  runtimeSha256: string;
  toolsetSha256: string;
  modelConfigSha256: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  state: ProbeReceiptState;
  usage: ProbeReceiptUsage;
  limits: readonly ProbeReceiptLimit[];
  output: ProbeOutputManifestV1;
  /** Seal time plus PROBE_RETENTION_MS. A prune never removes retained output before this instant. */
  expiresAt: number;
  digest: string;
}
export type ProbeIncomparableReason = "served_model_mismatch" | "served_model_unobserved" | "input_drift" | "usage_unknown" | "incomplete_coverage"
  | "teardown_unverified" | "authoring_uncontrolled" | "missing_receipt";
export interface ProbeComparability { comparable: boolean; reasons: readonly ProbeIncomparableReason[] }
/** Private status: the outcome denominator by receipt state, plus slots that never started. Never part of the public projection (T4 owns that). */
export interface ProbeOutcomeCounts { succeeded: number; failed: number; cancelled: number; timed_out: number; unavailable: number; unknown: number; planned: number; not_needed: number }

const RECEIPT_STATES: readonly ProbeReceiptState[] = ["succeeded", "failed", "cancelled", "timed_out", "unavailable", "unknown"];
const RECEIPT_LIMITS: readonly ProbeReceiptLimit[] = ["usage_unknown", "served_model_unobserved", "served_model_mismatch", "teardown_unverified", "output_truncated", "storage_over_cap", "coverage_unverified"];
const EXCLUDED_REASONS: readonly ProbeExcludedReason[] = ["not_regular", "linked", "outside_declared_writes", "over_file_cap", "changed_while_read", "over_entry_cap"];

/** Digest over the canonical record without its own digest field. */
export function probeReceiptDigest(receipt: Omit<ProbeReceiptV1, "digest">): string {
  return probeHash(guidanceProbeCanonical(receipt, PROBE_OUTPUT_LIMITS.receiptBytes));
}
const nullableSha = (value: unknown): boolean => value === null || probeSha256(value);
/** Closed, inert parse. Returns undefined for any shape, bound or digest violation; never repairs. */
export function parseProbeReceipt(value: unknown): ProbeReceiptV1 | undefined {
  try {
    const f = object(inert(value, PROBE_OUTPUT_LIMITS.receiptBytes), ["v", "experimentId", "slotId", "generation", "revision", "requestedModel", "servedModel", "inputFrameSha256",
      "workerEffectiveInputSha256", "nonGuidanceInputSha256", "guidanceSha256", "runtimeSha256", "toolsetSha256", "modelConfigSha256", "startedAt", "endedAt", "elapsedMs", "state",
      "usage", "limits", "output", "expiresAt", "digest"]);
    required(f.v === 1 && identity(f.experimentId) && identity(f.slotId) && probeInteger(f.generation) && probeInteger(f.revision));
    required(f.requestedModel === GUIDANCE_PROBE_MODEL && (f.servedModel === null || typeof f.servedModel === "string" && Buffer.byteLength(f.servedModel) <= 256));
    required(nullableSha(f.inputFrameSha256) && nullableSha(f.workerEffectiveInputSha256) && nullableSha(f.nonGuidanceInputSha256) && nullableSha(f.guidanceSha256));
    required(probeSha256(f.runtimeSha256) && probeSha256(f.toolsetSha256) && probeSha256(f.modelConfigSha256));
    // elapsed time is wall time between the Store's trusted-clock samples, so it can never exceed the span between them.
    required(probeInteger(f.startedAt) && probeInteger(f.endedAt) && probeInteger(f.elapsedMs) && f.endedAt >= f.startedAt && f.elapsedMs <= f.endedAt - f.startedAt
      && probeInteger(f.expiresAt) && f.expiresAt === f.endedAt + PROBE_RETENTION_MS);
    required(RECEIPT_STATES.includes(f.state as ProbeReceiptState));
    const usage = object(f.usage, ["modelCalls", "modelUsageKnown", "toolCalls", "toolUsageKnown", "tokensObserved"]);
    required(probeInteger(usage.modelCalls) && probeInteger(usage.modelUsageKnown) && usage.modelUsageKnown <= usage.modelCalls
      && probeInteger(usage.toolCalls) && probeInteger(usage.toolUsageKnown) && usage.toolUsageKnown <= usage.toolCalls && (usage.tokensObserved === null || probeInteger(usage.tokensObserved)));
    required(Array.isArray(f.limits) && f.limits.length <= RECEIPT_LIMITS.length && new Set(f.limits).size === f.limits.length && f.limits.every(item => RECEIPT_LIMITS.includes(item as ProbeReceiptLimit)));
    const output = object(f.output, ["v", "entries", "excluded", "totalBytes"]);
    required(output.v === 1 && Array.isArray(output.entries) && output.entries.length <= PROBE_OUTPUT_LIMITS.entries && Array.isArray(output.excluded) && output.excluded.length <= PROBE_OUTPUT_LIMITS.entries
      && probeInteger(output.totalBytes));
    let total = 0; const names = new Set<string>();
    for (const entry of output.entries as unknown[]) {
      const e = object(entry, ["relative", "sha256", "bytes"]);
      required(typeof e.relative === "string" && e.relative.length > 0 && Buffer.byteLength(e.relative) <= 512 && !e.relative.startsWith("/") && !e.relative.split("/").includes("..")
        && probeSha256(e.sha256) && probeInteger(e.bytes) && e.bytes <= PROBE_OUTPUT_LIMITS.fileBytes && !names.has(e.relative));
      names.add(e.relative as string); total += e.bytes as number;
    }
    required(total === output.totalBytes);
    for (const entry of output.excluded as unknown[]) {
      const e = object(entry, ["relative", "reason"]);
      required(typeof e.relative === "string" && e.relative.length > 0 && Buffer.byteLength(e.relative) <= 512 && EXCLUDED_REASONS.includes(e.reason as ProbeExcludedReason));
    }
    required(probeSha256(f.digest));
    const { digest, ...rest } = f as unknown as ProbeReceiptV1;
    required(probeReceiptDigest(rest) === digest);
    // A success is never recorded alongside a limit or an exclusion that the contract says forbids it.
    if (f.state === "succeeded") required((f.limits as unknown[]).length === 0 && (output.excluded as unknown[]).length === 0 && f.servedModel === GUIDANCE_PROBE_MODEL);
    return f as unknown as ProbeReceiptV1;
  } catch { return undefined; }
}

/**
 * Pure comparability over an experiment's receipts and the slots that should have produced them (AC4). One reason is enough to make the
 * pair incomparable; reasons are listed, not ranked. Never an upgrade of the older inline expression: every case that expression called
 * incomparable is incomparable here too.
 */
export function classifyProbeComparability(input: {
  slots: readonly { slotId: string; role: ProbeSlot["role"]; arm: ProbeSlot["arm"]; reserved: boolean; coverageVerified: boolean; authoring?: "admitted_fixture" | "uncontrolled" }[];
  receipts: readonly ProbeReceiptV1[];
  /** The manifest's runtime fingerprints, which every receipt must match. */
  runtime: { runtimeSha256: string; toolsetSha256: string; modelConfigSha256: string };
  holds: boolean;
}): ProbeComparability {
  const reasons = new Set<ProbeIncomparableReason>();
  if (input.holds) reasons.add("usage_unknown");
  const bySlot = new Map(input.receipts.map(item => [item.slotId, item]));
  for (const slot of input.slots) {
    if (!slot.reserved) continue;
    if (slot.authoring === "uncontrolled") reasons.add("authoring_uncontrolled");
    if (!slot.coverageVerified) reasons.add("incomplete_coverage");
    const receipt = bySlot.get(slot.slotId);
    if (!receipt) { reasons.add("missing_receipt"); continue; }
    if (receipt.servedModel === null) reasons.add("served_model_unobserved");
    else if (receipt.servedModel !== receipt.requestedModel) reasons.add("served_model_mismatch");
    if (receipt.runtimeSha256 !== input.runtime.runtimeSha256 || receipt.toolsetSha256 !== input.runtime.toolsetSha256 || receipt.modelConfigSha256 !== input.runtime.modelConfigSha256) reasons.add("input_drift");
    if (receipt.limits.includes("usage_unknown") || receipt.usage.tokensObserved === null || receipt.usage.modelUsageKnown !== receipt.usage.modelCalls || receipt.usage.toolUsageKnown !== receipt.usage.toolCalls) reasons.add("usage_unknown");
    if (receipt.limits.includes("teardown_unverified")) reasons.add("teardown_unverified");
    if (receipt.state !== "succeeded") reasons.add("incomplete_coverage");
  }
  // Worker arms differ only in the admitted guidance slot: any other input byte differing is drift.
  const workers = input.receipts.filter(item => input.slots.some(slot => slot.slotId === item.slotId && slot.role === "worker"));
  const baseline = workers[0];
  for (const worker of workers) if (baseline && (worker.nonGuidanceInputSha256 === null || worker.nonGuidanceInputSha256 !== baseline.nonGuidanceInputSha256)) reasons.add("input_drift");
  return { comparable: reasons.size === 0, reasons: [...reasons].sort() };
}

/** The outcome denominator: every reserved slot counts, whatever became of it. Slots never started are reported apart, never as success or failure. */
export function probeOutcomeCounts(slots: readonly { slotId: string; state: ProbeSessionState }[], receipts: readonly ProbeReceiptV1[]): ProbeOutcomeCounts {
  const counts: ProbeOutcomeCounts = { succeeded: 0, failed: 0, cancelled: 0, timed_out: 0, unavailable: 0, unknown: 0, planned: 0, not_needed: 0 };
  const bySlot = new Map(receipts.map(item => [item.slotId, item]));
  for (const slot of slots) {
    if (slot.state === "planned") { counts.planned++; continue; }
    if (slot.state === "not_needed") { counts.not_needed++; continue; }
    // A reserved slot with no sealed receipt is unknown: the host cannot vouch for it. It is never counted as failed.
    counts[bySlot.get(slot.slotId)?.state ?? "unknown"]++;
  }
  return counts;
}

/** What the host measured about one finished session, before the Store adds the fields only it can know. None of this comes from the provider. */
export interface ProbeMeasuredSession {
  /** Store-trusted-clock sample taken when this session's launch was exposed, as reported back by the host that took it. Never the experiment's first reservation. */
  startedAt: number;
  servedModel: string | null;
  workerEffectiveInputSha256: string | null;
  nonGuidanceInputSha256: string | null;
  /** True only when the peer, the confinement and every owned child reported known quiescence. */
  teardownVerified: boolean;
  cancelled: boolean;
  timedOut: boolean;
  /** The session could not start or reach the model for a host-known reason (for example confinement unavailable). */
  unavailable: boolean;
  /** Limits the host observed itself, such as `output_truncated`. The Store adds the ones it can derive. */
  limits: readonly ProbeReceiptLimit[];
  /** Bytes the session actually left in scratch, measured, not the declared reservation. */
  scratchBytes: number;
  output: ProbeOutputManifestV1;
  /** The host-created retention directory for `output`, if any. Stored beside the receipt, never inside it. */
  retained?: ProbeRetainedRecord;
}
/** Stored rows hold a canonical receipt, which is bounded well below this; the SQL length check guards against a hostile row. */
export const PROBE_RECEIPT_ROW_BYTES = PROBE_OUTPUT_LIMITS.receiptBytes;
/**
 * The runtime half of the 1 GiB cap: output past the slot's declared bound is not retained, hashed or counted as the session's output. Entries are
 * kept in order until the bound would be crossed; the rest are recorded as excluded, so the receipt can never claim more than was declared.
 */
export function capOutput(output: ProbeOutputManifestV1, maximum: number): ProbeOutputManifestV1 {
  const entries: ProbeOutputEntry[] = [], excluded: ProbeOutputExcluded[] = [...output.excluded];
  let total = 0;
  for (const entry of output.entries) {
    if (entries.length >= PROBE_OUTPUT_LIMITS.entries || total + entry.bytes > maximum) { excluded.push({ relative: entry.relative, reason: entries.length >= PROBE_OUTPUT_LIMITS.entries ? "over_entry_cap" : "over_file_cap" }); continue; }
    entries.push(entry); total += entry.bytes;
  }
  return { v: 1, entries, excluded: excluded.slice(0, PROBE_OUTPUT_LIMITS.entries), totalBytes: total };
}

/**
 * A retained output directory the host created, with the identity it recorded at creation. Kept beside the receipt in its own column and out of the
 * digested receipt body: a receipt never carries a physical path. Prune acts on nothing that is not recorded here and still matches by identity.
 */
/**
 * A host-created retention directory and the identity of each file in it. Inode numbers are recycled (Linux reuses one straight after an unlink), so a file's
 * identity is its device, inode AND change time in nanoseconds: a replacement created later always has a later `ctimeNs`, even when it reuses the inode.
 * ponytail: ctime granularity is the filesystem's (a few milliseconds on Linux), so a replacement created in the very same tick as the original with a recycled
 * inode would match; retention-to-prune is days, so the window is the retention call itself. A per-file content hash re-check at prune is the upgrade path.
 * ponytail: a directory has no stable change time (it moves with every entry), so its identity is device and inode only. Deleting a replaced empty directory
 * under the host's own random-named retention root is the ceiling; a stable directory identity (a host-written marker file) is the upgrade path.
 */
export interface ProbeRetainedRecord { directory: string; dev: number; ino: number; files: readonly { relative: string; dev: number; ino: number; bytes: number; ctimeNs: string }[] }
/** The filesystem half of prune, injected so the Store (src/hub) never imports src/local. Both calls are identity-checked by their implementation. */
export interface ProbeRetentionFs {
  preview(retained: ProbeRetainedRecord): { remove: { relative: string; bytes: number }[]; keep: { relative: string; reason: string }[] };
  remove(retained: ProbeRetainedRecord): { removed: string[]; kept: { relative: string; reason: string }[] };
}
export function parseProbeRetained(value: unknown): ProbeRetainedRecord | undefined {
  try {
    const f = object(inert(value, PROBE_OUTPUT_LIMITS.receiptBytes), ["directory", "dev", "ino", "files"]);
    required(typeof f.directory === "string" && f.directory.startsWith("/") && Buffer.byteLength(f.directory) <= 1024 && !/[\u0000-\u001f]/.test(f.directory));
    required(probeInteger(f.dev) && probeInteger(f.ino) && Array.isArray(f.files) && f.files.length <= PROBE_OUTPUT_LIMITS.entries);
    const seen = new Set<string>();
    for (const item of f.files as unknown[]) {
      const e = object(item, ["relative", "dev", "ino", "bytes", "ctimeNs"]);
      required(typeof e.relative === "string" && e.relative.length > 0 && Buffer.byteLength(e.relative) <= 512 && !e.relative.startsWith("/") && !e.relative.split("/").includes("..")
        && probeInteger(e.dev) && probeInteger(e.ino) && probeInteger(e.bytes) && e.bytes <= PROBE_OUTPUT_LIMITS.fileBytes && !seen.has(e.relative)
        && typeof e.ctimeNs === "string" && /^[0-9]{1,24}$/.test(e.ctimeNs));
      seen.add(e.relative as string);
    }
    return f as unknown as ProbeRetainedRecord;
  } catch { return undefined; }
}
export type ProbePruneKeepReason = "experiment_active" | "experiment_held" | "not_expired" | "already_pruned" | "no_retained_output" | "directory_replaced_or_missing" | "identity_changed" | "not_empty";
export interface ProbePrunePlan {
  /** SHA-256 over the canonical plan: a prune takes this and refuses if the owned set changed since the person saw it. */
  digest: string;
  retainedBytes: number;
  slots: readonly { slotId: string; expiresAt: number; remove: readonly { relative: string; bytes: number }[]; keep: readonly { relative: string; reason: ProbePruneKeepReason }[] }[];
}
export interface ProbePruneResult { pruned: readonly string[]; kept: readonly { slotId: string; relative: string; reason: ProbePruneKeepReason }[]; planDigest: string }
