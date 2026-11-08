/** ExecutionReferenceV1 is an opaque address, never authority or a resolver instruction. */
export const EXECUTION_PRODUCERS = ["ahub", "ares", "amem", "vmem"] as const;
export interface ExecutionReferenceV1 {
  v: 1;
  tool: typeof EXECUTION_PRODUCERS[number];
  projectKey: string;
  kind: string;
  id: string;
  revision?: string;
  sha256?: string;
}
export const EXECUTION_REFERENCE_LIMITS = Object.freeze({ id: 256, projectKey: 256, revision: 128, kind: 64 });
const invalid = (): never => { throw new Error("execution reference has invalid fields or bounds; use the ExecutionReferenceV1 contract"); };
export function executionText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    Buffer.byteLength(value, "utf8") <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
export function parseExecutionReference(input: unknown): ExecutionReferenceV1 {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length) return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  const keys = ["v", "tool", "projectKey", "kind", "id", "revision", "sha256"];
  if (Object.entries(fields).some(([key, field]) => !keys.includes(key) || !("value" in field))) return invalid();
  const get = (key: string): unknown => fields[key]?.value;
  const tool = get("tool"), projectKey = get("projectKey"), kind = get("kind"), id = get("id");
  if (get("v") !== 1 || !EXECUTION_PRODUCERS.includes(tool as ExecutionReferenceV1["tool"]) ||
      !executionText(projectKey, EXECUTION_REFERENCE_LIMITS.projectKey) || !executionText(id, EXECUTION_REFERENCE_LIMITS.id) ||
      !executionText(kind, EXECUTION_REFERENCE_LIMITS.kind) || !/^[a-z][a-z0-9._-]*$/.test(kind)) return invalid();
  const revision = get("revision"), sha256 = get("sha256");
  if ((Object.hasOwn(fields, "revision") && !executionText(revision, EXECUTION_REFERENCE_LIMITS.revision)) ||
      (Object.hasOwn(fields, "sha256") && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)))) return invalid();
  return { v: 1, tool: tool as ExecutionReferenceV1["tool"], projectKey, kind, id,
    ...(revision === undefined ? {} : { revision: revision as string }), ...(sha256 === undefined ? {} : { sha256: sha256 as string }) };
}
export const executionReferenceKey = (ref: ExecutionReferenceV1): string => JSON.stringify(parseExecutionReference(ref));
