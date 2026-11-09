import { createHash } from "node:crypto";
import { types } from "node:util";
import { executionReferenceKey, executionText, parseExecutionReference, EXECUTION_REFERENCE_LIMITS, type ExecutionReferenceV1 } from "./execution-reference.ts";

export const EXECUTION_LINK_LIMITS = Object.freeze({ perTask: 64, read: 65, referenceBytes: 2048, actor: 32 });
export interface ExecutionLinkInput {
  taskId: number; taskCreated: number; flowRevision: number;
  from?: ExecutionReferenceV1; reference: ExecutionReferenceV1;
}
export interface ExecutionLinkRecord {
  id: string; projectKey: string; taskId: number; taskCreated: number;
  from: ExecutionReferenceV1; reference: ExecutionReferenceV1;
  strength: "declared"; recordedBy: string; recordedAt: number;
}
export interface ExecutionLinkFence { by: string; at: number }
export class ExecutionLinkError extends Error {
  constructor(readonly code: "invalid" | "changed" | "limit" | "corrupt") {
    super({
      invalid: "invalid execution reference metadata; read the current task and supply its identity, revision and bounded ExecutionReferenceV1 fields before retrying",
      changed: "execution reference task authority or revision changed; read the current task and retry with an authorized current role outside private context",
      limit: "execution reference task limit reached; inspect the recorded lineage and reuse an existing reference before adding another",
      corrupt: "execution reference storage is invalid; stop the hub, restore a trusted hub.db backup, then restart and retry",
    }[code]);
    this.name = "ExecutionLinkError";
  }
}
const invalid = (): never => { throw new ExecutionLinkError("invalid"); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length > keys.length) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== "string" || !keys.includes(key)) return invalid();
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) return invalid();
    result[key] = field.value;
  }
  return result;
}
export const executionLinkInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
export const executionLinkActor = (value: unknown): value is string =>
  typeof value === "string" && value.length <= EXECUTION_LINK_LIMITS.actor && /^[a-z][a-z0-9-]*$/.test(value);
export function parseExecutionLinkInput(value: unknown): ExecutionLinkInput {
  try {
    const input = object(value, ["taskId", "taskCreated", "flowRevision", "from", "reference"]);
    if (!executionLinkInteger(input.taskId, 1) || !executionLinkInteger(input.taskCreated) || !executionLinkInteger(input.flowRevision)) return invalid();
    return { taskId: input.taskId, taskCreated: input.taskCreated, flowRevision: input.flowRevision,
      ...(Object.hasOwn(input, "from") ? { from: parseExecutionReference(input.from) } : {}), reference: parseExecutionReference(input.reference) };
  } catch { return invalid(); }
}
/** Task epoch is an existing source identity. Mutable history revision remains a separate write fence. */
export function taskExecutionReference(projectKey: string, taskId: number, taskCreated: number): ExecutionReferenceV1 {
  if (!executionLinkInteger(taskId, 1) || !executionLinkInteger(taskCreated)) return invalid();
  try { return parseExecutionReference({ v: 1, tool: "ahub", projectKey, kind: "task", id: `${taskId}:${taskCreated}` }); }
  catch { return invalid(); }
}
export function executionLinkReferences(projectKey: string, value: ExecutionLinkInput): { from: ExecutionReferenceV1; reference: ExecutionReferenceV1 } {
  if (!executionText(projectKey, EXECUTION_REFERENCE_LIMITS.projectKey)) return invalid();
  const input = parseExecutionLinkInput(value), from = input.from ?? taskExecutionReference(projectKey, input.taskId, input.taskCreated);
  if (from.tool !== "ahub" || from.projectKey !== projectKey || input.reference.tool === "ahub" && input.reference.projectKey !== projectKey) return invalid();
  return { from, reference: input.reference };
}
export const executionReferenceDigest = (ref: ExecutionReferenceV1): string => createHash("sha256").update(executionReferenceKey(ref)).digest("hex");
/** Actor, time and observed task revision are guards/audit, not dedup identity. */
export function executionLinkId(projectKey: string, value: ExecutionLinkInput): string {
  const input = parseExecutionLinkInput(value), refs = executionLinkReferences(projectKey, input);
  return createHash("sha256").update(JSON.stringify(["agent-hub.execution-link/v1", projectKey, input.taskId, input.taskCreated, refs.from, refs.reference])).digest("hex");
}
/** Stored rows are authenticated by their owner read, not by this address/digest validation. */
export function parseExecutionLinkRecord(value: unknown): ExecutionLinkRecord {
  try {
    const row = object(value, ["id", "projectKey", "taskId", "taskCreated", "from", "reference", "strength", "recordedBy", "recordedAt"]);
    if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) || !executionText(row.projectKey, EXECUTION_REFERENCE_LIMITS.projectKey)
      || !executionLinkInteger(row.taskId, 1) || !executionLinkInteger(row.taskCreated) || row.strength !== "declared"
      || !executionLinkActor(row.recordedBy) || !executionLinkInteger(row.recordedAt)) throw new Error();
    const input = { taskId: row.taskId, taskCreated: row.taskCreated, flowRevision: 0, from: parseExecutionReference(row.from), reference: parseExecutionReference(row.reference) };
    const refs = executionLinkReferences(row.projectKey, input);
    if (executionLinkId(row.projectKey, input) !== row.id) throw new Error();
    return { id: row.id, projectKey: row.projectKey, taskId: row.taskId, taskCreated: row.taskCreated, ...refs,
      strength: "declared", recordedBy: row.recordedBy, recordedAt: row.recordedAt };
  } catch { throw new ExecutionLinkError("corrupt"); }
}
