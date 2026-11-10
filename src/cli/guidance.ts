import { executionText } from "../hub/execution-reference.ts";
import { GUIDANCE_HASH_HEX_LENGTH, GUIDANCE_CURSOR_MAX_BYTES, parseGuidanceWriteReceipt, type GuidanceDiffResult, type GuidancePageResult, type GuidanceWriteReceipt } from "../hub/guidance-variants.ts";
import { guidanceLines, guidanceReceiptLines } from "../ui/guidance-view.ts";
import { terminalText } from "./console-state.ts";

export const GUIDANCE_USAGE = "usage: ahub guidance create --file FILE [--json] | list --task N --task-created MS [--cursor TOKEN] [--json] | show --task N --task-created MS --id HASH [--json] | withdraw --task N --task-created MS --revision R --id HASH [--json]";
type Create = { op: "create"; json: boolean; file: string };
type List = { op: "list"; json: boolean; taskId: number; taskCreated: number; cursor?: string };
type Show = { op: "show"; json: boolean; taskId: number; taskCreated: number; id: string };
type Withdraw = { op: "withdraw"; json: boolean; taskId: number; taskCreated: number; flowRevision: number; id: string };
export type GuidanceCommand = Create | List | Show | Withdraw;
const invalid = (): never => { throw new Error(`invalid guidance arguments; ${GUIDANCE_USAGE}`); };
const integer = (raw: string | undefined, minimum: number): number => {
  if (raw === undefined || !/^(0|[1-9][0-9]*)$/.test(raw)) return invalid();
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : invalid();
};
const contentId = (raw: string | undefined): string =>
  typeof raw === "string" && raw.length === GUIDANCE_HASH_HEX_LENGTH && /^[a-f0-9]+$/.test(raw) ? raw : invalid();
/** The explicit filename remains a selector; main owns its bounded read and the complete V1 parse. */
export function parseGuidanceCommand(args: readonly string[]): GuidanceCommand {
  const [op, ...rest] = args;
  if (op !== "create" && op !== "list" && op !== "show" && op !== "withdraw") return invalid();
  const allowed = op === "create" ? ["--file"] : op === "list" ? ["--task", "--task-created", "--cursor"]
    : op === "show" ? ["--task", "--task-created", "--id"] : ["--task", "--task-created", "--revision", "--id"];
  const values = new Map<string, string>(); let json = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (flag === "--json") { if (json) return invalid(); json = true; continue; }
    if (!allowed.includes(flag) || values.has(flag)) return invalid();
    const value = rest[++index];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--") || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return invalid();
    values.set(flag, value);
  }
  if (op === "create") {
    const file = values.get("--file");
    if (!file) return invalid();
    return { op, json, file };
  }
  const taskId = integer(values.get("--task"), 1), taskCreated = integer(values.get("--task-created"), 0);
  if (op === "list") {
    if (!values.has("--cursor")) return { op, json, taskId, taskCreated };
    const cursor = values.get("--cursor")!;
    // V1 wire bound: authentication and task/actor binding belong to the source host.
    if (!executionText(cursor, GUIDANCE_CURSOR_MAX_BYTES) || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalid();
    return { op, json, taskId, taskCreated, cursor };
  }
  const id = contentId(values.get("--id"));
  return op === "show" ? { op, json, taskId, taskCreated, id }
    : { op, json, taskId, taskCreated, flowRevision: integer(values.get("--revision"), 0), id };
}

export { parseGuidancePageResult as validateGuidancePageReply, parseGuidanceDiffResult as validateGuidanceDiffReply } from "../hub/guidance-variants.ts";
/** An unconfirmed write never authorizes an automatic retry or reinterprets a displayed experiment label as a selector. */
export function validateGuidanceReceipt(value: unknown, expected: { id?: string; taskId?: number; status?: "withdrawn" }): GuidanceWriteReceipt {
  const unconfirmed = (): never => { throw new Error("guidance write reply is unconfirmed; inspect ahub guidance list for the task before retrying the write"); };
  try {
    const receipt = parseGuidanceWriteReceipt(value);
    if (expected.id !== undefined && receipt.id !== expected.id || expected.taskId !== undefined && receipt.taskId !== expected.taskId
      || expected.status !== undefined && receipt.status !== expected.status) return unconfirmed();
    return receipt;
  } catch { return unconfirmed(); }
}
/** The shared view contains public data only; terminal controls are stripped at this surface. */
const terminalLines = (lines: readonly string[]): string[] => lines.map(line => terminalText(line).replace(/[\r\n]+/g, " "));
export const renderGuidance = (result: GuidancePageResult | GuidanceDiffResult): string[] => terminalLines(guidanceLines(result));
export const renderGuidanceReceipt = (receipt: GuidanceWriteReceipt): string[] => terminalLines(guidanceReceiptLines(receipt));
