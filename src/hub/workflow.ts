import { createHash } from "node:crypto";
import type { Task } from "./board.ts";
import { checklistOf, criteriaRequired, type SdlcConfig } from "./sdlc.ts";

/** The spec's head-bound acceptance-criteria checklist, recorded by the reviewer or person (#481 S8, Compliance pass). */
export interface CriteriaReceipt {
  id: string;
  head?: string;
  criteria: { id: string; required: boolean; result: "verified" | "failed" | "unverified"; refs: string[] }[];
}
/** A checklist stored under `phase` before #481 S8. Its task list is shown as ignored; board split-undo still treats it as a reference. */
export interface LegacyPhaseReceipt extends CriteriaReceipt { tasks: { id: number; after: number[] }[]; }
const name = (s: unknown): s is string => typeof s === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(s);
const criterionId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z][A-Za-z0-9-]{0,47}$/.test(s);
const hash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const fields = (v: unknown, keys: string[], label: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error(`${label}: invalid fields`);
  return v as Record<string, unknown>;
};
export function criteriaReceipt(value: unknown): CriteriaReceipt {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("criteria: invalid fields");
  if (Buffer.byteLength(serialized) > 32768) throw new Error("criteria: receipt exceeds 32 KiB");
  const p = fields(value, ["id", "head", "tasks", "criteria"], "criteria");
  if (!name(p.id) || (p.head !== undefined && !hash(p.head))) throw new Error("criteria: expected bounded id and full head SHA");
  // The phase import re-validated Tasks.after edges only; dependencies stay with `ahub task propose --after`.
  if (p.tasks !== undefined && (!Array.isArray(p.tasks) || p.tasks.length)) throw new Error("criteria: checklist task import was retired (#481); record dependencies with ahub task propose --after");
  if (!Array.isArray(p.criteria) || !p.criteria.length || p.criteria.length > 32) throw new Error("criteria: 1..32 criteria");
  const criteria = p.criteria.map(raw => {
    const c = fields(raw, ["id", "required", "result", "refs"], "criterion");
    if (!criterionId(c.id) || typeof c.required !== "boolean" || !["verified", "failed", "unverified"].includes(String(c.result)) || !Array.isArray(c.refs) || c.refs.length > 8 || new Set(c.refs).size !== c.refs.length || c.refs.some(ref => typeof ref !== "string" || !/^(sha256:[0-9a-f]{64}|(artifact|check|source):[A-Za-z0-9._/-]{1,160}@[0-9a-f]{64})$/.test(ref)) || (c.result === "verified" && !c.refs.length)) throw new Error("criterion: invalid outcome or hashed evidence refs");
    return { id: c.id, required: c.required, result: c.result as CriteriaReceipt["criteria"][number]["result"], refs: [...c.refs] as string[] };
  });
  if (new Set(criteria.map(c => c.id)).size !== criteria.length) throw new Error("criteria: duplicate criterion");
  return { id: p.id, ...(p.head ? { head: p.head as string } : {}), criteria };
}
export interface CriteriaView { id?: string; ready: boolean; blockers: string[]; criteria?: CriteriaReceipt["criteria"]; note?: string; }
/** The board-owned checklist as shown; undefined when nothing asks for one. */
export function criteriaView(config: SdlcConfig, task: Task, isPrivate: (t: Task) => boolean): CriteriaView | undefined {
  const checklist = checklistOf(task.sdlc);
  const gated = !!config.definitions && Object.values(config.definitions).some(d => [...d.entry_gates, ...d.exit_gates].includes("criteria"));
  if (!criteriaRequired(config, task.sdlc) && !gated) return;
  if (isPrivate(task)) return { ready: false, blockers: ["private criteria evidence unknown"] };
  if (!checklist) return { ready: false, blockers: ["criteria checklist missing"] };
  const blockers: string[] = [];
  for (const criterion of checklist.criteria) if (criterion.required && criterion.result !== "verified") blockers.push(`criterion ${criterion.id}: ${criterion.result}`);
  return { id: checklist.id, ready: blockers.length === 0, blockers, criteria: checklist.criteria.map(c => ({ ...c, refs: [...c.refs] })), ...("tasks" in checklist && (checklist as LegacyPhaseReceipt).tasks.length ? { note: "stored checklist task list ignored: task import was retired (#481)" } : {}) };
}
/**
 * #507b: which of a task's recorded acceptance criteria (the #481 S8 checklist, the only criteria model) a reviewer's unmet items name.
 * An item names a criterion when it STARTS with that criterion's id, exactly (case and all), followed by the end of the item or a delimiter:
 * `AC3: the overwrite case has no test`, or just `AC3`. An id the checklist does not hold is plain text, never a criterion, and an id in the
 * middle of a sentence is not a claim. Pure: items in, ids out (in the order first named, each once).
 */
export function unmetCriteriaIds(items: readonly string[], checklist: Pick<CriteriaReceipt, "criteria"> | undefined): string[] {
  if (!checklist) return [];
  const known = new Set(checklist.criteria.map(c => c.id));
  const named: string[] = [];
  for (const item of items) {
    const id = /^\s*([A-Za-z][A-Za-z0-9-]{0,47})(?=$|[\s:.,;)\]])/.exec(item)?.[1];
    if (id !== undefined && known.has(id) && !named.includes(id)) named.push(id);
  }
  return named;
}
export function workflowHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
