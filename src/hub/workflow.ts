import { createHash } from "node:crypto";
import type { Task } from "./board.ts";
import type { SdlcConfig } from "./sdlc.ts";

export interface PhaseReceipt {
  id: string;
  head?: string;
  tasks: { id: number; after: number[] }[];
  criteria: { id: string; required: boolean; result: "verified" | "failed" | "unverified"; refs: string[] }[];
}
const taskId = (n: unknown): n is number => Number.isSafeInteger(n) && typeof n === "number" && n > 0;
const name = (s: unknown): s is string => typeof s === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(s);
const hash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
const fields = (v: unknown, keys: string[], label: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error(`${label}: invalid fields`);
  return v as Record<string, unknown>;
};
export function phaseReceipt(value: unknown): PhaseReceipt {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("phase: invalid fields");
  if (Buffer.byteLength(serialized) > 32768) throw new Error("phase: receipt exceeds 32 KiB");
  const p = fields(value, ["id", "head", "tasks", "criteria"], "phase");
  if (!name(p.id) || (p.head !== undefined && !hash(p.head))) throw new Error("phase: expected bounded id and full head SHA");
  if (!Array.isArray(p.tasks) || p.tasks.length > 64 || !Array.isArray(p.criteria) || !p.criteria.length || p.criteria.length > 32) throw new Error("phase: at most 64 tasks and 1..32 criteria");
  const tasks = p.tasks.map(raw => {
    const t = fields(raw, ["id", "after"], "phase task");
    if (!taskId(t.id) || !Array.isArray(t.after) || t.after.length > 16 || !t.after.every(taskId) || new Set(t.after).size !== t.after.length || t.after.includes(t.id)) throw new Error("phase task: invalid id or predecessors");
    return { id: t.id, after: [...t.after] as number[] };
  });
  const criteria = p.criteria.map(raw => {
    const c = fields(raw, ["id", "required", "result", "refs"], "phase criterion");
    if (!name(c.id) || typeof c.required !== "boolean" || !["verified", "failed", "unverified"].includes(String(c.result)) || !Array.isArray(c.refs) || c.refs.length > 8 || new Set(c.refs).size !== c.refs.length || c.refs.some(ref => typeof ref !== "string" || !/^(sha256:[0-9a-f]{64}|(artifact|check|source):[A-Za-z0-9._/-]{1,160}@[0-9a-f]{64})$/.test(ref)) || (c.result === "verified" && !c.refs.length)) throw new Error("phase criterion: invalid outcome or hashed evidence refs");
    return { id: c.id, required: c.required, result: c.result as PhaseReceipt["criteria"][number]["result"], refs: [...c.refs] as string[] };
  });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || new Set(criteria.map(c => c.id)).size !== criteria.length) throw new Error("phase: duplicate task or criterion");
  return { id: p.id, ...(p.head ? { head: p.head as string } : {}), tasks, criteria };
}
export type TaskLookup = (id: number) => Task | null | undefined;
/** An import names existing Tasks.after edges, it never edits dependencies or ownership. */
export function validatePhaseLinks(parent: Task, phase: PhaseReceipt, get: TaskLookup, isPrivate: (t: Task) => boolean): void {
  const seen = new Set<number>(), active = new Set<number>();
  const visit = (id: number): void => {
    if (id === parent.id) throw new Error("phase: parent cannot be its own prerequisite or child");
    if (active.has(id)) throw new Error("phase: dependency cycle");
    if (seen.has(id)) return;
    if (seen.size >= 256) throw new Error("phase: dependency closure exceeds 256 tasks");
    const task = get(id); if (!task) throw new Error("phase: referenced task missing");
    if (!isPrivate(parent) && isPrivate(task)) throw new Error("phase: ordinary parent cannot reference private work");
    seen.add(id); active.add(id);
    for (const predecessor of task.deps ?? []) visit(predecessor);
    active.delete(id);
  };
  for (const link of phase.tasks) {
    visit(link.id);
    const actual = get(link.id)!.deps ?? [];
    if (actual.length !== link.after.length || actual.some(id => !link.after.includes(id))) throw new Error("phase: predecessor ids must match current Tasks.after edges");
  }
}
export interface PhaseView { workflow: "gsd-lite"; id?: string; ready: boolean; blockers: string[]; tasks?: { id: number; after: number[]; state: string }[]; criteria?: PhaseReceipt["criteria"]; }
export function phaseView(config: SdlcConfig, parent: Task, get: TaskLookup, isPrivate: (t: Task) => boolean): PhaseView | undefined {
  if (config.workflow !== "gsd-lite") return;
  const blockers: string[] = [], phase = parent.sdlc?.phase;
  if (isPrivate(parent)) return { workflow: "gsd-lite", ready: false, blockers: ["private phase evidence unknown"] };
  if (!phase) return { workflow: "gsd-lite", ready: false, blockers: ["phase checklist missing"] };
  try { validatePhaseLinks(parent, phase, get, isPrivate); } catch { return { workflow: "gsd-lite", id: phase.id, ready: false, blockers: ["phase dependency evidence changed or unavailable"] }; }
  for (const criterion of phase.criteria) if (criterion.required && criterion.result !== "verified") blockers.push(`phase criterion ${criterion.id}: ${criterion.result}`);
  const tasks = phase.tasks.map(link => ({ id: link.id, after: [...(get(link.id)?.deps ?? [])], state: get(link.id)?.state ?? "unknown" }));
  if (tasks.some(task => task.state !== "approved")) blockers.push("phase child tasks not approved");
  return { workflow: "gsd-lite", id: phase.id, ready: blockers.length === 0, blockers, tasks, criteria: phase.criteria.map(c => ({ ...c, refs: [...c.refs] })) };
}
export function workflowHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
