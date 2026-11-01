import { createPublicKey, verify } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./packs.ts";

export interface RegisteredRunnerV1 { publicKey: string; projects: string[]; revoked: boolean }
export interface RunnerContainer { id: string; role: "candidate" | "evaluator" | "other" }
export interface RunnerMount { container: string; path: string; readOnly: boolean; purpose: "evaluator-code" | "evaluator-data" | "candidate-output" | "other" }
export interface RunnerOutput { name: string; sha256: string }
export interface AttemptReceiptV1 {
  receiptId: string; runner: string; projectId: string; attemptId: string; protocolHash: string;
  codeCommit?: string; imageDigest?: string; containers?: RunnerContainer[]; mounts?: RunnerMount[];
  network?: "none" | "restricted" | "open";
  resourceLimits?: { name: string; value: number; unit: string }[];
  startedAt?: number; endedAt?: number; exitStatus?: number; outputs?: RunnerOutput[]; metricsFile?: RunnerOutput;
}
export interface RunnerVerificationContext {
  runners: unknown;
  projectId: string;
  attempt: { id: string; projectId: string; protocolHash: string; codeCommit?: string } | undefined;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, HASH = /^[0-9a-f]{64}$/, ATTEMPT = /^ra-[0-9a-f]{12}$/;
const BODY = 64 * 1024, SHORT = 512;
/** Exactly the receipt domain and its NUL separator; no executable runner protocol. */
export const RUNNER_RECEIPT_DOMAIN = "agent-hub.runner-receipt/v1" + String.fromCharCode(0);
function fail(field: string, reason: string): never { throw new Error(`${field}: ${reason}`); }
function object(input: unknown, keys: readonly string[] | undefined, field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length)
    fail(field, "expected a plain data object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some(value => !Object.hasOwn(value, "value"))) fail(field, "accessors are unavailable");
  if (keys && Object.keys(descriptors).some(key => !keys.includes(key))) fail(field, "unknown field");
  if (Object.values(descriptors).some(value => value.value === undefined)) fail(field, "omit absent fields");
  return Object.fromEntries(Object.entries(descriptors).map(([key, value]) => [key, value.value]));
}
function array(input: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype
    || input.length > max || Object.getOwnPropertySymbols(input).length) fail(field, `expected a list of at most ${max} items`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) fail(field, "unknown list fields");
  return Array.from({ length: input.length }, (_, index) => {
    const value = descriptors[String(index)];
    if (!value || !Object.hasOwn(value, "value")) fail(field, "expected a dense data list");
    return value.value;
  });
}
function text(input: unknown, field: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > SHORT || Buffer.byteLength(input, "utf8") > SHORT
    || Buffer.from(input, "utf8").toString("utf8") !== input) fail(field, "expected non-empty UTF-8 text of at most 512 bytes");
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
function choice<T extends string>(input: unknown, values: readonly T[], field: string): T {
  if (typeof input !== "string" || !values.includes(input as T)) fail(field, "unsupported value");
  return input as T;
}
function bounded<T>(value: T, field: string): T {
  if (Buffer.byteLength(canonicalJson(value), "utf8") > BODY) fail(field, "stored body exceeds 64 KiB");
  return value;
}
function base64(input: unknown, bytes: number, field: string): Buffer {
  if (typeof input !== "string" || input.length !== 4 * Math.ceil(bytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(input))
    fail(field, "invalid canonical base64");
  const decoded = Buffer.from(input, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== input) fail(field, "invalid canonical base64");
  return decoded;
}
function publicKey(input: unknown, field: string): string {
  const bytes = base64(input, 44, field);
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !key.export({ format: "der", type: "spki" }).equals(bytes))
      fail(field, "expected an Ed25519 SPKI public key");
  } catch { fail(field, "expected an Ed25519 SPKI public key"); }
  return input as string;
}

/** Data validation only. Person-only registration and machine-local placement belong to the host. */
export function parseResearchRunners(input: unknown): Record<string, RegisteredRunnerV1> {
  const raw = object(input, undefined, "research.runners"), entries = Object.entries(raw);
  if (entries.length > 16) fail("research.runners", "at most 16 runners");
  return bounded(Object.fromEntries(entries.map(([name, value]) => {
    const field = `research.runners.${pattern(name, ID, "research.runners.name")}`, row = object(value, ["publicKey", "projects", "revoked"], field);
    const projects = array(row.projects, 64, `${field}.projects`).map(value => text(value, `${field}.projects`));
    if (new Set(projects).size !== projects.length) fail(`${field}.projects`, "duplicate projects");
    if (typeof row.revoked !== "boolean") fail(`${field}.revoked`, "expected a boolean");
    return [name, { publicKey: publicKey(row.publicKey, `${field}.publicKey`), projects, revoked: row.revoked }];
  })), "research.runners");
}

function output(input: unknown, field: string): RunnerOutput {
  const row = object(input, ["name", "sha256"], field);
  return { name: text(row.name, `${field}.name`), sha256: pattern(row.sha256, HASH, `${field}.sha256`) };
}

/** Absent observations stay absent. Isolation inconsistencies are signed evidence, not schema failures. */
export function parseAttemptReceipt(input: unknown): AttemptReceiptV1 {
  const raw = object(input, ["receiptId", "runner", "projectId", "attemptId", "protocolHash", "codeCommit", "imageDigest", "containers", "mounts", "network", "resourceLimits", "startedAt", "endedAt", "exitStatus", "outputs", "metricsFile"], "receipt");
  const receipt: AttemptReceiptV1 = { receiptId: pattern(raw.receiptId, ID, "receipt.receiptId"), runner: pattern(raw.runner, ID, "receipt.runner"),
    projectId: text(raw.projectId, "receipt.projectId"), attemptId: pattern(raw.attemptId, ATTEMPT, "receipt.attemptId"), protocolHash: pattern(raw.protocolHash, HASH, "receipt.protocolHash") };
  if (raw.codeCommit !== undefined) receipt.codeCommit = pattern(raw.codeCommit, /^[0-9a-f]{40}$/, "receipt.codeCommit");
  if (raw.imageDigest !== undefined) receipt.imageDigest = pattern(raw.imageDigest, /^sha256:[0-9a-f]{64}$/, "receipt.imageDigest");
  if (raw.containers !== undefined) receipt.containers = array(raw.containers, 64, "receipt.containers").map((value, index) => {
    const field = `receipt.containers[${index}]`, row = object(value, ["id", "role"], field);
    return { id: pattern(row.id, ID, `${field}.id`), role: choice(row.role, ["candidate", "evaluator", "other"], `${field}.role`) };
  });
  if (raw.mounts !== undefined) receipt.mounts = array(raw.mounts, 256, "receipt.mounts").map((value, index) => {
    const field = `receipt.mounts[${index}]`, row = object(value, ["container", "path", "readOnly", "purpose"], field);
    if (typeof row.readOnly !== "boolean") fail(`${field}.readOnly`, "expected a boolean");
    return { container: pattern(row.container, ID, `${field}.container`), path: text(row.path, `${field}.path`), readOnly: row.readOnly,
      purpose: choice(row.purpose, ["evaluator-code", "evaluator-data", "candidate-output", "other"], `${field}.purpose`) };
  });
  if (raw.network !== undefined) receipt.network = choice(raw.network, ["none", "restricted", "open"], "receipt.network");
  if (raw.resourceLimits !== undefined) receipt.resourceLimits = array(raw.resourceLimits, 16, "receipt.resourceLimits").map((value, index) => {
    const field = `receipt.resourceLimits[${index}]`, row = object(value, ["name", "value", "unit"], field);
    if (typeof row.value !== "number" || !Number.isFinite(row.value) || row.value < 0) fail(`${field}.value`, "expected a nonnegative finite number");
    return { name: text(row.name, `${field}.name`), value: row.value, unit: text(row.unit, `${field}.unit`) };
  });
  if (raw.startedAt !== undefined) receipt.startedAt = integer(raw.startedAt, "receipt.startedAt");
  if (raw.endedAt !== undefined) receipt.endedAt = integer(raw.endedAt, "receipt.endedAt");
  if (receipt.startedAt !== undefined && receipt.endedAt !== undefined && receipt.endedAt < receipt.startedAt) fail("receipt.endedAt", "precedes startedAt");
  if (raw.exitStatus !== undefined) receipt.exitStatus = integer(raw.exitStatus, "receipt.exitStatus", Number.MIN_SAFE_INTEGER);
  if (raw.outputs !== undefined) receipt.outputs = array(raw.outputs, 64, "receipt.outputs").map((value, index) => output(value, `receipt.outputs[${index}]`));
  if (raw.metricsFile !== undefined) receipt.metricsFile = output(raw.metricsFile, "receipt.metricsFile");
  return bounded(receipt, "receipt");
}

/** Predicate on evidence only; callers must verify its signature before treating sealing as attested. */
export function runnerSealing(receipt: AttemptReceiptV1): boolean {
  const parsed = parseAttemptReceipt(receipt), containers = parsed.containers ?? [], mounts = parsed.mounts ?? [];
  const roles = new Map(containers.map(container => [container.id, container.role]));
  if (roles.size !== containers.length || !containers.some(container => container.role === "candidate")
    || !containers.some(container => container.role === "evaluator") || !mounts.length) return false;
  let evaluatorEvidence = false;
  for (const mount of mounts) {
    const role = roles.get(mount.container);
    if (!role) return false;
    if (mount.purpose === "evaluator-code" || mount.purpose === "evaluator-data") {
      if (role !== "evaluator" || !mount.readOnly) return false;
      evaluatorEvidence = true;
    }
  }
  return evaluatorEvidence;
}

/** Pure verification against the current host-supplied registration and attempt identity. No host-observed or scientific claim. */
export function verifyAttemptReceipt(input: unknown, signature: unknown, context: RunnerVerificationContext): {
  receipt: AttemptReceiptV1; provenance: "runner-attested"; sealed: boolean;
} {
  const receipt = parseAttemptReceipt(input), runners = parseResearchRunners(context.runners);
  if (!Object.hasOwn(runners, receipt.runner)) fail("receipt.runner", "unknown runner");
  const runner = runners[receipt.runner]!;
  if (runner.revoked) fail("receipt.runner", "revoked runner");
  if (receipt.projectId !== context.projectId || !runner.projects.includes(receipt.projectId)) fail("receipt.projectId", "project is not allowed");
  const attempt = context.attempt;
  if (!attempt || attempt.id !== receipt.attemptId || attempt.projectId !== context.projectId || attempt.protocolHash !== receipt.protocolHash)
    fail("receipt.attemptId", "attempt or protocol identity mismatch");
  if (receipt.codeCommit !== undefined && attempt.codeCommit !== undefined && receipt.codeCommit !== attempt.codeCommit)
    fail("receipt.codeCommit", "protocol commit mismatch");
  const bytes = base64(signature, 64, "receipt.signature");
  const key = createPublicKey({ key: Buffer.from(runner.publicKey, "base64"), format: "der", type: "spki" });
  if (!verify(null, Buffer.from(RUNNER_RECEIPT_DOMAIN + canonicalJson(receipt), "utf8"), key, bytes)) fail("receipt.signature", "invalid signature");
  return { receipt, provenance: "runner-attested", sealed: runnerSealing(receipt) };
}
