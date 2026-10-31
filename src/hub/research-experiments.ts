import { createHash } from "node:crypto";
import { types } from "node:util";
import { looksSecret } from "@staix/agent-mem";
import { canonicalJson } from "./packs.ts";
import { parseDeliverableClaims, parseDeliverableRecords, deliverableId, DELIVERABLE_LIMITS, type DeliverableClaim, type DeliverableRecord } from "./deliverables.ts";

export type ExperimentScalar = string | number | boolean | null;
export type ExperimentProvenance = "declared" | "host-observed" | "runner-attested" | "person-attested";
export type ExperimentValue<T> = { value: T; provenance: ExperimentProvenance; evidence?: string }
  | { value: null; provenance: "unknown" };
export interface ExperimentProtocolContract {
  campaignId: string;
  campaignRevision: number;
  lineage: string;
  supersedes?: string;
  claimIds: string[];
  inputs: { sourceId: string; sha256: string }[];
  code: { commit: string } | { deliverable: { id: string; sha256: string } };
  /** Descriptor and optional text-hash claim are declared, never a measured host environment. */
  environment: { descriptor: string; hash?: string };
  method: string;
  parameters: Record<string, ExperimentScalar | ExperimentScalar[]>;
  seeds: number[];
  evaluator: { id: string; version: string; hash?: string };
  metrics: { name: string; unit: string; direction: "higher" | "lower" }[];
  role: "baseline" | "variant";
  variantOf?: string;
  splits: string[];
  resourceLimits: { name: string; value: number; unit: string }[];
  sealed: boolean;
}
export interface ExperimentAttemptInput {
  protocolHash: string;
  taskId: number;
  phase: "development" | "final";
  idempotencyKey: string;
  retryOf?: string;
  reproducesAttemptId?: string;
}
export type ExperimentOutput = { id: string; sha256?: string } | DeliverableClaim;
export type DeclaredExperimentEventInput =
  | { kind: "start"; body: { startedAt?: number } }
  | { kind: "end"; body: { status: "succeeded" | "failed" | "cancelled"; exitStatus?: number; reason?: string; run?: string } }
  | { kind: "metric"; body: { name: string; value: number } }
  | { kind: "output"; body: ExperimentOutput }
  | { kind: "note"; body: { text: string } };
/** Host supplies ordering/time; this T1 parser never admits caller-written evidence elevation. */
export type DeclaredExperimentEvent = DeclaredExperimentEventInput & { seq: number; at: number; provenance: "declared" };
export type ExperimentStatus = "declared" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, HASH = /^[0-9a-f]{64}$/, SOURCE = /^src:[0-9a-f]{16}$/;
const CAMPAIGN = /^rc-[0-9a-f]{12}$/, ATTEMPT = /^ra-[0-9a-f]{12}$/, DELIVERABLE = /^d-[0-9a-f]{12}$/;
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT = 512, LONG = 4096, BODY = 64 * 1024;
function fail(field: string, reason: string): never { throw new Error(`${field}: ${reason}`); }
function object(input: unknown, keys: readonly string[] | undefined, field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    fail(field, "expected a plain data object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some(value => !Object.hasOwn(value, "value"))) fail(field, "accessors are unavailable");
  if (keys && Object.keys(descriptors).some(key => !keys.includes(key))) fail(field, "unknown field");
  return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}
function array(input: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > max || Object.getOwnPropertySymbols(input).length)
    fail(field, `expected a list of at most ${max} items`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) fail(field, "unknown list fields");
  return Array.from({ length: input.length }, (_, index) => {
    const value = descriptors[String(index)];
    if (!value || !Object.hasOwn(value, "value")) fail(field, "expected a dense data list");
    return value.value;
  });
}
function text(input: unknown, max: number, field: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > max || Buffer.byteLength(input, "utf8") > max
    || Buffer.from(input, "utf8").toString("utf8") !== input) fail(field, `expected non-empty UTF-8 text of at most ${max} bytes`);
  return input;
}
function pattern(input: unknown, rule: RegExp, field: string): string {
  if (typeof input !== "string" || rule.exec(input)?.[0] !== input) fail(field, "invalid identifier or hash");
  return input;
}
function integer(input: unknown, field: string, min = 0): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min) fail(field, "expected a bounded integer");
  return input;
}
function number(input: unknown, field: string, nonnegative = false): number {
  if (typeof input !== "number" || !Number.isFinite(input) || nonnegative && input < 0) fail(field, "expected a finite number");
  return input;
}
function choice<T extends string>(input: unknown, values: readonly T[], field: string): T {
  if (typeof input !== "string" || !values.includes(input as T)) fail(field, "unsupported value");
  return input as T;
}
function unique<T>(values: T[], key: (value: T) => string | number, field: string): T[] {
  if (new Set(values.map(key)).size !== values.length) fail(field, "duplicate values");
  return values;
}
function strings(input: unknown, max: number, field: string, rule = ID): string[] {
  return unique(array(input, max, field).map((value, index) => pattern(value, rule, `${field}[${index}]`)), value => value, field);
}
function bounded<T>(value: T, field: string): T {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > BODY) fail(field, "stored body exceeds 64 KiB");
  return value;
}
function scalar(input: unknown, field: string): ExperimentScalar {
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") return number(input, field);
  // Empty string is a useful scalar parameter, unlike an empty method or descriptor.
  if (typeof input === "string" && input.length <= SHORT && Buffer.byteLength(input, "utf8") <= SHORT
    && Buffer.from(input, "utf8").toString("utf8") === input) return input;
  return fail(field, "expected a finite scalar");
}
function environment(input: unknown): ExperimentProtocolContract["environment"] {
  const value = object(input, ["descriptor", "hash"], "protocol.environment"), descriptor = text(value.descriptor, LONG, "protocol.environment.descriptor");
  // ponytail: assignment/Bearer/known-secret forms only, never proof of secret absence. Upgrade to structured key/version fields or a #1018 runner receipt; flagged text is refused, never redacted and stored.
  if (/(?:^|[\s,;{])["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*(?:=|:)\s*\S/.test(descriptor) || /\bBearer\s+\S+/i.test(descriptor) || looksSecret(descriptor))
    fail("protocol.environment.descriptor", "environment values and secret-shaped text are unavailable");
  return { descriptor, ...(value.hash !== undefined ? { hash: pattern(value.hash, HASH, "protocol.environment.hash") } : {}) };
}

/** Structural validation only; campaign/source/task ownership and evidence reads belong to Tasks. */
export function parseExperimentProtocol(input: unknown): ExperimentProtocolContract {
  const raw = object(input, ["campaignId", "campaignRevision", "lineage", "supersedes", "claimIds", "inputs", "code", "environment", "method", "parameters", "seeds", "evaluator", "metrics", "role", "variantOf", "splits", "resourceLimits", "sealed"], "protocol");
  const inputs = unique(array(raw.inputs, 64, "protocol.inputs").map((value, index) => {
    const field = `protocol.inputs[${index}]`, row = object(value, ["sourceId", "sha256"], field);
    return { sourceId: pattern(row.sourceId, SOURCE, `${field}.sourceId`), sha256: pattern(row.sha256, HASH, `${field}.sha256`) };
  }), value => value.sourceId, "protocol.inputs");
  const rawCode = object(raw.code, ["commit", "deliverable"], "protocol.code");
  if ((rawCode.commit !== undefined) === (rawCode.deliverable !== undefined)) fail("protocol.code", "choose one commit or deliverable");
  let code: ExperimentProtocolContract["code"];
  if (rawCode.commit !== undefined) code = { commit: pattern(rawCode.commit, /^[0-9a-f]{40}$/, "protocol.code.commit") };
  else {
    const value = object(rawCode.deliverable, ["id", "sha256"], "protocol.code.deliverable");
    code = { deliverable: { id: pattern(value.id, DELIVERABLE, "protocol.code.deliverable.id"), sha256: pattern(value.sha256, HASH, "protocol.code.deliverable.sha256") } };
  }
  const rawParameters = object(raw.parameters, undefined, "protocol.parameters");
  const entries = Object.entries(rawParameters);
  if (entries.length > 64) fail("protocol.parameters", "at most 64 keys");
  const parameters = Object.fromEntries(entries.map(([key, value]) => {
    pattern(key, ID, "protocol.parameters.key");
    if (["__proto__", "constructor", "prototype"].includes(key)) fail("protocol.parameters.key", "reserved key");
    return [key, Array.isArray(value) ? array(value, 64, "protocol.parameters.value").map(item => scalar(item, "protocol.parameters.value")) : scalar(value, "protocol.parameters.value")];
  }));
  const evaluator = object(raw.evaluator, ["id", "version", "hash"], "protocol.evaluator");
  const metrics = unique(array(raw.metrics, 32, "protocol.metrics").map((value, index) => {
    const field = `protocol.metrics[${index}]`, row = object(value, ["name", "unit", "direction"], field);
    return { name: text(row.name, SHORT, `${field}.name`), unit: text(row.unit, SHORT, `${field}.unit`), direction: choice(row.direction, ["higher", "lower"], `${field}.direction`) };
  }), value => value.name, "protocol.metrics");
  const resourceLimits = unique(array(raw.resourceLimits, 16, "protocol.resourceLimits").map((value, index) => {
    const field = `protocol.resourceLimits[${index}]`, row = object(value, ["name", "value", "unit"], field);
    return { name: text(row.name, SHORT, `${field}.name`), value: number(row.value, `${field}.value`, true), unit: text(row.unit, SHORT, `${field}.unit`) };
  }), value => value.name, "protocol.resourceLimits");
  const role = choice(raw.role, ["baseline", "variant"], "protocol.role");
  if (raw.variantOf !== undefined && role !== "variant") fail("protocol.variantOf", "only a variant may name a baseline");
  if (typeof raw.sealed !== "boolean") fail("protocol.sealed", "expected a declared boolean");
  return bounded({ campaignId: pattern(raw.campaignId, CAMPAIGN, "protocol.campaignId"), campaignRevision: integer(raw.campaignRevision, "protocol.campaignRevision", 1),
    lineage: pattern(raw.lineage, ID, "protocol.lineage"), ...(raw.supersedes !== undefined ? { supersedes: pattern(raw.supersedes, HASH, "protocol.supersedes") } : {}),
    claimIds: strings(raw.claimIds, 32, "protocol.claimIds"), inputs, code, environment: environment(raw.environment), method: text(raw.method, LONG, "protocol.method"), parameters,
    seeds: array(raw.seeds, 256, "protocol.seeds").map(value => integer(value, "protocol.seeds", Number.MIN_SAFE_INTEGER)),
    evaluator: { id: pattern(evaluator.id, ID, "protocol.evaluator.id"), version: text(evaluator.version, SHORT, "protocol.evaluator.version"), ...(evaluator.hash !== undefined ? { hash: pattern(evaluator.hash, HASH, "protocol.evaluator.hash") } : {}) },
    metrics, role, ...(raw.variantOf !== undefined ? { variantOf: pattern(raw.variantOf, HASH, "protocol.variantOf") } : {}),
    splits: strings(raw.splits, 16, "protocol.splits"), resourceLimits, sealed: raw.sealed }, "protocol");
}

export function protocolHash(contract: ExperimentProtocolContract): string {
  return createHash("sha256").update(canonicalJson(parseExperimentProtocol(contract))).digest("hex");
}

export function parseExperimentAttempt(input: unknown): ExperimentAttemptInput {
  const raw = object(input, ["protocolHash", "taskId", "phase", "idempotencyKey", "retryOf", "reproducesAttemptId"], "attempt");
  return bounded({ protocolHash: pattern(raw.protocolHash, HASH, "attempt.protocolHash"), taskId: integer(raw.taskId, "attempt.taskId", 1),
    phase: choice(raw.phase, ["development", "final"], "attempt.phase"), idempotencyKey: text(raw.idempotencyKey, 64, "attempt.idempotencyKey"),
    ...(raw.retryOf !== undefined ? { retryOf: pattern(raw.retryOf, ATTEMPT, "attempt.retryOf") } : {}),
    ...(raw.reproducesAttemptId !== undefined ? { reproducesAttemptId: pattern(raw.reproducesAttemptId, ATTEMPT, "attempt.reproducesAttemptId") } : {}) }, "attempt");
}

/** Caller input cannot set sequence, hub time or provenance; metric membership is checked against the named protocol. */
export function parseExperimentEvent(input: unknown, protocol?: ExperimentProtocolContract): DeclaredExperimentEventInput {
  const raw = object(input, ["kind", "body"], "event");
  switch (raw.kind) {
    case "start": {
      const body = object(raw.body, ["startedAt"], "event.start");
      return { kind: "start", body: { ...(body.startedAt !== undefined ? { startedAt: integer(body.startedAt, "event.start.startedAt") } : {}) } };
    }
    case "end": {
      const body = object(raw.body, ["status", "exitStatus", "reason", "run"], "event.end");
      return { kind: "end", body: { status: choice(body.status, ["succeeded", "failed", "cancelled"], "event.end.status"),
        ...(body.exitStatus !== undefined ? { exitStatus: integer(body.exitStatus, "event.end.exitStatus", Number.MIN_SAFE_INTEGER) } : {}),
        ...(body.reason !== undefined ? { reason: text(body.reason, SHORT, "event.end.reason") } : {}), ...(body.run !== undefined ? { run: pattern(body.run, RUN, "event.end.run") } : {}) } };
    }
    case "metric": {
      const body = object(raw.body, ["name", "value"], "event.metric"), name = text(body.name, SHORT, "event.metric.name");
      if (protocol && !protocol.metrics.some(metric => metric.name === name)) fail("event.metric.name", "not declared by the protocol");
      return { kind: "metric", body: { name, value: number(body.value, "event.metric.value") } };
    }
    case "output": {
      const body = object(raw.body, ["id", "sha256", "path", "format", "version"], "event.output");
      if (body.id !== undefined) {
        if ([body.path, body.format, body.version].some(value => value !== undefined)) fail("event.output", "choose one declared reference or host hash request");
        return { kind: "output", body: { id: pattern(body.id, DELIVERABLE, "event.output.id"), ...(body.sha256 !== undefined ? { sha256: pattern(body.sha256, HASH, "event.output.sha256") } : {}) } };
      }
      if (body.sha256 !== undefined) fail("event.output", "a host hash request cannot supply a hash");
      text(body.path, SHORT, "event.output.path"); text(body.format, 32, "event.output.format");
      if (body.version !== undefined) text(body.version, 64, "event.output.version");
      const claim = parseDeliverableClaims([body])[0]!;
      return { kind: "output", body: claim };
    }
    case "note": {
      const body = object(raw.body, ["text"], "event.note");
      return { kind: "note", body: { text: text(body.text, SHORT, "event.note.text") } };
    }
    default: return fail("event.kind", "unsupported declared event; attestation needs a separate authority path");
  }
}

function ordered(events: readonly DeclaredExperimentEvent[]): DeclaredExperimentEvent[] {
  const rows = [...events].sort((a, b) => a.seq - b.seq), seen = new Set<number>();
  for (const row of rows) {
    integer(row.seq, "event.seq", 1); integer(row.at, "event.at");
    if (seen.has(row.seq) || row.provenance !== "declared") fail("event", "invalid ordering or caller evidence elevation");
    seen.add(row.seq);
  }
  if (rows.filter(row => row.kind === "end").length > 1) fail("event.end", "an attempt has at most one terminal event");
  return rows;
}

/** Task completion is never experiment success; only a recorded end supplies a terminal experiment status. */
export function experimentStatus(events: readonly DeclaredExperimentEvent[], taskState: string | undefined): ExperimentStatus {
  const rows = ordered(events), end = rows.find(row => row.kind === "end");
  if (end?.kind === "end") return end.body.status;
  if (["approved", "cancelled", "closed"].includes(taskState ?? "")) return "unknown";
  return rows.some(row => row.kind === "start") ? "running" : "declared";
}

const declared = <T>(value: T | undefined): ExperimentValue<T> => value === undefined ? { value: null, provenance: "unknown" } : { value, provenance: "declared" };
/** Declared-only projection. Verified host observations belong to an independent authority-bound evidence path. */
export function projectExperimentEvidence(protocol: ExperimentProtocolContract, events: readonly DeclaredExperimentEvent[]) {
  const rows = ordered(events), starts = rows.filter(row => row.kind === "start"), end = rows.find(row => row.kind === "end");
  return {
    environment: { descriptor: declared(protocol.environment.descriptor), hash: declared(protocol.environment.hash), hashOf: "declared descriptor text" as const }, sealed: declared(protocol.sealed),
    startedAt: declared(starts.at(-1)?.body.startedAt), endedAt: declared<number>(undefined),
    exitStatus: declared(end?.kind === "end" ? end.body.exitStatus : undefined),
    run: declared(end?.kind === "end" ? end.body.run : undefined),
    durationMs: declared<number>(undefined), createdAt: declared<number>(undefined), timedOut: declared<boolean>(undefined), cancelled: declared<boolean>(undefined),
    metrics: protocol.metrics.map(metric => {
      const observations = rows.flatMap(row => row.kind === "metric" && row.body.name === metric.name ? [declared(row.body.value)] : []);
      return { name: metric.name, unit: metric.unit, observations, latest: observations.at(-1) ?? declared<number>(undefined) };
    }),
    outputs: rows.flatMap(row => row.kind !== "output" ? [] : ["id" in row.body
      ? { id: declared(row.body.id), sha256: declared(row.body.sha256) }
      : { id: declared<string>(undefined), sha256: declared<string>(undefined) }]),
  };
}

/** Independent measured facts, linked to one declared event; caller record bodies never accept this shape. */
export interface ExperimentHostEvidence {
  source: "check" | "deliverable";
  evidence: string;
  values: Partial<Record<"exitStatus" | "timedOut" | "cancelled" | "durationMs" | "createdAt" | "sha256" | "bytes" | "deliverableId", number | boolean | string>>;
}

/** Validate only measured fields from the host's receipt reader. This helper grants no authority to a supplied receipt. */
export function checkRunObservation(input: unknown, run: string, taskId: number, protocol: ExperimentProtocolContract): ExperimentHostEvidence | undefined {
  try {
    pattern(run, RUN, "check.run");
    const row = object(input, undefined, "check");
    if (!("commit" in protocol.code) || row.run !== run || row.task !== taskId || row.sha !== protocol.code.commit || row.status !== "finished") return undefined;
    if (row.exit !== null && (typeof row.exit !== "number" || !Number.isSafeInteger(row.exit))) return undefined;
    if (typeof row.timed_out !== "boolean" || typeof row.cancelled !== "boolean") return undefined;
    const durationMs = number(row.duration_ms, "check.duration_ms", true), createdAt = number(row.created, "check.created", true);
    return { source: "check", evidence: run, values: { ...(row.exit === null ? {} : { exitStatus: row.exit }), timedOut: row.timed_out, cancelled: row.cancelled, durationMs, createdAt } };
  } catch { return undefined; }
}


/** Validate persisted measured facts. Only host-side Tasks code creates these rows, never an RPC record body. */
export function parseExperimentHostEvidence(input: unknown): ExperimentHostEvidence {
  const row = object(input, ["source", "evidence", "values"], "observation");
  const source = choice(row.source, ["check", "deliverable"], "observation.source");
  const values = object(row.values, source === "check" ? ["exitStatus", "timedOut", "cancelled", "durationMs", "createdAt"] : ["deliverableId", "sha256", "bytes"], "observation.values");
  if (source === "check") {
    if (typeof values.timedOut !== "boolean" || typeof values.cancelled !== "boolean") fail("observation.values", "missing measured check flags");
    return { source, evidence: pattern(row.evidence, RUN, "observation.evidence"), values: {
      ...(values.exitStatus === undefined ? {} : { exitStatus: integer(values.exitStatus, "observation.exitStatus", Number.MIN_SAFE_INTEGER) }),
      timedOut: values.timedOut, cancelled: values.cancelled, durationMs: number(values.durationMs, "observation.durationMs", true), createdAt: number(values.createdAt, "observation.createdAt", true),
    } };
  }
  const deliverableId = pattern(values.deliverableId, DELIVERABLE, "observation.deliverableId");
  if (row.evidence !== deliverableId) fail("observation.evidence", "must name the measured deliverable");
  const bytes = integer(values.bytes, "observation.bytes");
  if (bytes > DELIVERABLE_LIMITS.fileBytes) fail("observation.bytes", "exceeds the deliverable file limit");
  return { source, evidence: deliverableId, values: { deliverableId, sha256: pattern(values.sha256, HASH, "observation.sha256"), bytes } };
}

/** The record is the result of #509 host hashing, never an agent's output reference. */
export function deliverableObservation(record: DeliverableRecord): ExperimentHostEvidence {
  const measured = parseDeliverableRecords([object(record, ["id", "path", "format", "version", "sha256", "bytes", "private"], "deliverable")])[0]!;
  return parseExperimentHostEvidence({ source: "deliverable", evidence: measured.id, values: { deliverableId: measured.id, sha256: measured.sha256, bytes: measured.bytes } });
}

/** Keep conflicting declarations and measurements side by side; neither changes the attempt's declared terminal event. */
export function projectExperimentWithObservations(protocol: ExperimentProtocolContract, events: readonly DeclaredExperimentEvent[], observations: readonly { eventSeq: number; observation: ExperimentHostEvidence }[]) {
  const declared = projectExperimentEvidence(protocol, events), seqs = new Set(events.map(event => event.seq));
  return { declared, measured: observations.map(row => {
    integer(row.eventSeq, "observation.eventSeq", 1);
    if (!seqs.has(row.eventSeq)) fail("observation.eventSeq", "declared event is unavailable");
    const observation = parseExperimentHostEvidence(row.observation), event = events.find(event => event.seq === row.eventSeq)!;
    if (observation.source === "check" && (event.kind !== "end" || event.body.run !== observation.evidence)) fail("observation", "check evidence must name its declared end run");
    if (observation.source === "deliverable" && (event.kind !== "output" || !("path" in event.body) || deliverableId(event.body.path, event.body.format) !== observation.evidence)) fail("observation", "output evidence must match a host hash request");
    return { eventSeq: row.eventSeq, source: observation.source, evidence: observation.evidence,
      values: Object.fromEntries(Object.entries(observation.values).map(([field, value]) => [field, { value, provenance: "host-observed" as const, evidence: observation.evidence }])) };
  }) };
}

/** Storage records carry host-issued identity separately from the immutable caller body. */
export interface ExperimentProtocolRecord {
  hash: string;
  project: string;
  recordedForTaskId: number;
  protocol: ExperimentProtocolContract;
  by: string;
  at: number;
  private: boolean;
}
export interface ExperimentAttemptRecord {
  attemptId: string;
  project: string;
  attempt: ExperimentAttemptInput;
  bodyHash: string;
  by: string;
  at: number;
  private: boolean;
}
export interface ExperimentEventRecord {
  attemptId: string;
  idempotencyKey: string;
  event: DeclaredExperimentEvent;
  bodyHash: string;
  by: string;
  private: boolean;
  observations: { eventSeq: number; observation: ExperimentHostEvidence }[];
}
export interface ExperimentWriteFence {
  project: string;
  taskId: number;
  taskFlowRevision: number;
  owner: string;
  campaignId: string;
  campaignRevision: number;
  campaignHash: string;
}

export type ComparisonVaryingField = "code" | "parameters" | "seeds" | "role";
export interface ComparisonPlanV1 {
  campaignId: string;
  fixed: Pick<ExperimentProtocolContract, "inputs" | "splits" | "evaluator" | "metrics">;
  varying: ComparisonVaryingField[];
  rule: { kind: "tolerance"; value: number } | { kind: "test"; name: string; alpha: number };
}
export type ComparisonCompatibility = { compatible: true }
  | { compatible: false; field: string; side: "baseline" | "variant" | "pair" };

/** A plan declares comparison invariants and a rule; parsing never runs the statistical rule. */
export function parseComparisonPlan(input: unknown): ComparisonPlanV1 {
  const raw = object(input, ["campaignId", "fixed", "varying", "rule"], "comparison");
  const fixed = object(raw.fixed, ["inputs", "splits", "evaluator", "metrics"], "comparison.fixed");
  const inputs = unique(array(fixed.inputs, 64, "comparison.fixed.inputs").map((value, index) => {
    const field = `comparison.fixed.inputs[${index}]`, row = object(value, ["sourceId", "sha256"], field);
    return { sourceId: pattern(row.sourceId, SOURCE, `${field}.sourceId`), sha256: pattern(row.sha256, HASH, `${field}.sha256`) };
  }), value => value.sourceId, "comparison.fixed.inputs");
  const evaluator = object(fixed.evaluator, ["id", "version", "hash"], "comparison.fixed.evaluator");
  const metrics = unique(array(fixed.metrics, 32, "comparison.fixed.metrics").map((value, index) => {
    const field = `comparison.fixed.metrics[${index}]`, row = object(value, ["name", "unit", "direction"], field);
    return { name: text(row.name, SHORT, `${field}.name`), unit: text(row.unit, SHORT, `${field}.unit`), direction: choice(row.direction, ["higher", "lower"], `${field}.direction`) };
  }), value => value.name, "comparison.fixed.metrics");
  const varying = unique(array(raw.varying, 4, "comparison.varying").map(value => choice<ComparisonVaryingField>(value, ["code", "parameters", "seeds", "role"], "comparison.varying")), value => value, "comparison.varying");
  const rawRule = object(raw.rule, ["kind", "value", "name", "alpha"], "comparison.rule");
  let rule: ComparisonPlanV1["rule"];
  if (rawRule.kind === "tolerance") {
    object(raw.rule, ["kind", "value"], "comparison.rule");
    rule = { kind: "tolerance", value: number(rawRule.value, "comparison.rule.value", true) };
  } else if (rawRule.kind === "test") {
    object(raw.rule, ["kind", "name", "alpha"], "comparison.rule");
    const alpha = number(rawRule.alpha, "comparison.rule.alpha");
    if (alpha <= 0 || alpha >= 1) fail("comparison.rule.alpha", "expected a probability strictly between zero and one");
    rule = { kind: "test", name: text(rawRule.name, SHORT, "comparison.rule.name"), alpha };
  } else fail("comparison.rule.kind", "expected tolerance or test");
  return bounded({ campaignId: pattern(raw.campaignId, CAMPAIGN, "comparison.campaignId"), fixed: { inputs, splits: strings(fixed.splits, 16, "comparison.fixed.splits"),
    evaluator: { id: pattern(evaluator.id, ID, "comparison.fixed.evaluator.id"), version: text(evaluator.version, SHORT, "comparison.fixed.evaluator.version"),
      ...(evaluator.hash !== undefined ? { hash: pattern(evaluator.hash, HASH, "comparison.fixed.evaluator.hash") } : {}) }, metrics }, varying, rule }, "comparison");
}

export function comparisonPlanHash(plan: ComparisonPlanV1): string {
  return createHash("sha256").update(canonicalJson(parseComparisonPlan(plan))).digest("hex");
}


/** Identity of the declared evaluator object, not a measurement of evaluator execution. */
export function evaluatorIdentityHash(protocol: ExperimentProtocolContract): string {
  return createHash("sha256").update(canonicalJson(parseExperimentProtocol(protocol).evaluator)).digest("hex");
}

/** Matches host-read approval identity only; Tasks remains responsible for person authority and persistence. */
export function protocolApprovalBindingMatches(protocol: ExperimentProtocolContract, binding: { protocolHash: string; evaluatorHash: string } | undefined): boolean {
  const hash = protocolHash(protocol), evaluator = evaluatorIdentityHash(protocol);
  if (!binding) return false;
  try {
    const record = object(binding, undefined, "approval");
    return record.protocolHash === hash && record.evaluatorHash === evaluator;
  } catch { return false; }
}
