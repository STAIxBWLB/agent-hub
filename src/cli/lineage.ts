import { executionReferenceKey, executionText, parseExecutionReference, type ExecutionReferenceV1 } from "../hub/execution-reference.ts";
import { LINEAGE_LIMITS, type LineageResult } from "../hub/execution-lineage.ts";
import { executionLineageLines } from "../ui/lineage-view.ts";
import { terminalText } from "./console-state.ts";

export const LINEAGE_USAGE = "usage: ahub lineage show (--task N | --attempt ra-id | --root JSON [--task-scope N --task-created MS]) [--cursor TOKEN] [--nodes N --edges N --bytes N] [--json] | link --task N --task-created MS --revision N --ref JSON [--from JSON] [--json]";
type Show = { op: "show"; json: boolean; taskId?: number; attemptId?: string; root?: ExecutionReferenceV1; task?: { id: number; created: number }; cursor?: string; nodes?: number; edges?: number; bytes?: number };
type Link = { op: "link"; json: boolean; taskId: number; taskCreated: number; flowRevision: number; reference: ExecutionReferenceV1; from?: ExecutionReferenceV1 };
const invalid = (): never => { throw new Error(`invalid lineage arguments; ${LINEAGE_USAGE}`); };
const integer = (raw: string | undefined, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) return invalid();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
};
function reference(raw: string | undefined): ExecutionReferenceV1 {
  if (raw === undefined || Buffer.byteLength(raw) > 8192) return invalid();
  try { return parseExecutionReference(JSON.parse(raw)); } catch { return invalid(); }
}
/** Shortcuts remain selectors: only the source host can supply their project identity. */
export function parseLineageCommand(args: readonly string[]): Show | Link {
  const [op, ...rest] = args;
  if (op !== "show" && op !== "link") return invalid();
  const values = new Map<string, string>(); let json = false;
  const allowed = op === "show"
    ? ["--task", "--attempt", "--root", "--task-scope", "--task-created", "--cursor", "--nodes", "--edges", "--bytes"]
    : ["--task", "--task-created", "--revision", "--ref", "--from"];
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--json") { if (json) return invalid(); json = true; continue; }
    if (!allowed.includes(flag) || values.has(flag)) return invalid();
    const value = rest[++i]; if (value === undefined || value.startsWith("--")) return invalid();
    values.set(flag, value);
  }
  if (op === "link") return { op, json, taskId: integer(values.get("--task"), 1), taskCreated: integer(values.get("--task-created"), 0),
    flowRevision: integer(values.get("--revision"), 0), reference: reference(values.get("--ref")),
    ...(values.has("--from") ? { from: reference(values.get("--from")) } : {}) };
  if (["--task", "--attempt", "--root"].filter(key => values.has(key)).length !== 1) return invalid();
  const result: Show = { op, json };
  if (values.has("--task")) result.taskId = integer(values.get("--task"), 1);
  if (values.has("--attempt")) {
    const attemptId = values.get("--attempt")!;
    if (!/^ra-[0-9a-f]{12}$/.test(attemptId)) return invalid();
    result.attemptId = attemptId;
  }
  if (values.has("--root")) result.root = reference(values.get("--root"));
  if (values.has("--task-scope") || values.has("--task-created")) {
    if (!result.root) return invalid();
    result.task = { id: integer(values.get("--task-scope"), 1), created: integer(values.get("--task-created"), 0) };
  }
  if (values.has("--cursor")) {
    const cursor = values.get("--cursor")!;
    if (cursor.length > LINEAGE_LIMITS.cursor || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
    result.cursor = cursor;
  }
  if (values.has("--nodes")) result.nodes = integer(values.get("--nodes"), 1, LINEAGE_LIMITS.nodes);
  if (values.has("--edges")) result.edges = integer(values.get("--edges"), 1, LINEAGE_LIMITS.edges);
  if (values.has("--bytes")) result.bytes = integer(values.get("--bytes"), LINEAGE_LIMITS.minimumBytes, LINEAGE_LIMITS.bytes);
  return result;
}

/** The closed shape check lives in the hub module, beside the reader that produces it, so the console reads it identically (#1220 T3). */
export { parseLineageResult as validateLineageReply } from "../hub/execution-lineage.ts";
export interface LineageLinkReceipt { id: string; taskId: number; reference: ExecutionReferenceV1; strength: "declared"; already: boolean }
export function validateLineageLink(value: unknown, command: { taskId: number; reference: ExecutionReferenceV1 }): LineageLinkReceipt {
  const bad = (): never => { throw new Error("lineage link reply is unconfirmed; inspect ahub lineage show before retrying the link"); };
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 8192) return bad();
    const row = value as Record<string, unknown>, keys = ["id", "taskId", "reference", "strength", "already"];
    if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key)) || !executionText(row.id, 256) ||
        row.taskId !== command.taskId || row.strength !== "declared" || typeof row.already !== "boolean" ||
        executionReferenceKey(parseExecutionReference(row.reference)) !== executionReferenceKey(command.reference)) return bad();
    return value as LineageLinkReceipt;
  } catch { return bad(); }
}
/** The CLI is a terminal: the shared view crosses `terminalText` here, at this surface's own boundary. */
export const renderExecutionLineage = (result: LineageResult): string[] =>
  executionLineageLines(result).map(line => terminalText(line).replace(/[\r\n]+/g, " "));
