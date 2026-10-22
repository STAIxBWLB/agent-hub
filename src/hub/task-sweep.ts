import type { Task } from "./board.ts";
import { normalizePlanSymbol, symbolsOverlap } from "./symbol-normalizer.ts";

export type SweepKind = "unaccepted-assignment" | "idle-owner" | "review-pending" | "ready-unassigned";
export interface SweepRecord {
  kind: SweepKind;
  /** Index of the last real activity, distinguishing even events at the same time. */
  activity: number;
  step: 1 | 2 | 3;
  at: number;
}
export interface TaskSweepConfig {
  enabled: boolean;
  no_writes_turns?: number;
  interval_s: number;
  unaccepted_min: number;
  idle_min: number;
  review_min: number;
  ready_min?: number;
  ladder_min: number;
  auto_reassign: boolean;
}
export const DEFAULT_TASK_SWEEP: TaskSweepConfig = {
  enabled: false, no_writes_turns: 2, ready_min: 60, interval_s: 300, unaccepted_min: 60, idle_min: 120, review_min: 120, ladder_min: 30, auto_reassign: false,
};

/** Config cannot silently enable a sweep or reassignment through a truthy string. */
export function taskSweepConfig(input: unknown): TaskSweepConfig {
  if (input === undefined) return { ...DEFAULT_TASK_SWEEP };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("task_sweep must be an object");
  const out = { ...DEFAULT_TASK_SWEEP };
  const values = input as Record<string, unknown>;
  for (const key of ["enabled", "auto_reassign"] as const) {
    if (values[key] === undefined) continue;
    if (typeof values[key] !== "boolean") throw new Error(`task_sweep.${key} must be a boolean`);
    out[key] = values[key];
  }
  if (values.no_writes_turns !== undefined) {
    const limit = values.no_writes_turns;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) throw new Error("task_sweep.no_writes_turns must be a safe nonnegative integer");
    out.no_writes_turns = limit;
  }
  for (const key of ["interval_s", "unaccepted_min", "idle_min", "review_min", "ready_min", "ladder_min"] as const) {
    if (values[key] === undefined) continue;
    const value = values[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value * (key === "interval_s" ? 1000 : 60_000) > 2_147_483_647) throw new Error(`task_sweep.${key} must be a bounded number of at least 1`);
    out[key] = value;
  }
  return out;
}

/** Pure time/kind ladder; Tasks decides whether the responsible peer is available. */
export function nextSweep(task: Task, config: TaskSweepConfig, now: number, ready = true): SweepRecord | undefined {
  if (!config.enabled || !Number.isFinite(now)) return undefined;
  const kind = task.state === "proposed" && task.owner ? "unaccepted-assignment"
    : task.state === "in_progress" && task.owner ? "idle-owner"
      : task.state === "in_review" && task.reviewer ? "review-pending" : task.state === "proposed" && !task.owner && !task.reviewer && ready ? "ready-unassigned" : undefined;
  if (!kind) return undefined;
  let activity = task.history.length - 1;
  while (activity >= 0 && (task.history[activity]?.sweep || task.history[activity]?.event === "memory reference started")) activity--;
  const at = task.history[activity]?.at ?? task.created;
  const threshold = kind === "ready-unassigned" ? config.ready_min ?? 60 : kind === "unaccepted-assignment" ? config.unaccepted_min : kind === "idle-owner" ? config.idle_min : config.review_min;
  if (now - at < threshold * 60_000) return undefined;
  const previous = task.history.flatMap((h) => h.sweep?.kind === kind && h.sweep.activity === activity ? [h.sweep] : []).at(-1);
  if (previous && (previous.step === 3 || now - previous.at < config.ladder_min * 60_000)) return undefined;
  return { kind, activity, step: previous ? (previous.step + 1) as 2 | 3 : 1, at: now };
}

export interface GroomingItem {
  kind: "text-dependency" | "overlap" | "duplicate" | "over-wip" | "stale" | "superseded" | "blocked" | "closed-issue";
  task: number;
  related?: number[];
  code?: string;
  personCommand?: string;
}
export interface PlannerGroomingOptions {
  repository: string;
  limits: Record<string, number>;
  wip: Record<string, number>;
  states: Record<string, string>;
  blockers?: readonly { task: number; code: string }[];
  issues?: ReadonlyMap<string, { repo: string; issue: number; state: "OPEN" | "CLOSED"; editedAt: string; lastEditedAt?: string | null }>;
  reviewedIssues?: ReadonlyMap<number, { editedAt: string }>;
  acceptedIssues?: ReadonlyMap<number, { repo: string; issue: number; lastEditedAt: string | null }>;
}
const GROOMING_TASK_LIMIT = 500, GROOMING_ITEM_LIMIT = 256;
const GROOMING_CODES = new Set(["tests", "spec", "roster", "pull-only", "not-attached", "excluded", "owner-admission", "offline", "paused", "failing", "pii", "policy", "cancelled", "unavailable", "runner", "approvals", "quota", "dependency", "no-writes"]);
const groomingRepo = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("path:/") && value.length <= 4096 && !/\p{Cc}/u.test(value)) return value;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.startsWith("-") ? value.toLowerCase() : undefined;
};
const groomingOwn = <T>(values: Record<string, T>, key: string): T | undefined => Object.hasOwn(values, key) ? values[key] : undefined;
function groomingPath(value: string): string | undefined {
  if (!value || value.length > 1000 || /\p{Cc}/u.test(value)) return;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else parts.push(part);
  }
  return parts.length ? (value.startsWith("/") ? "/" : "") + parts.join("/") : value.startsWith("/") ? "/" : ".";
}

/** Read-only ids/codes projection. Callers retain authority, privacy screening and the current metadata snapshot. */
export function plannerGrooming(tasks: readonly Task[], options: PlannerGroomingOptions): { items: GroomingItem[]; unknown: number[]; truncated: boolean } {
  const items: GroomingItem[] = [], unknown = new Set<number>(), seen = new Set<string>();
  let truncated = tasks.length > GROOMING_TASK_LIMIT;
  const repository = groomingRepo(options.repository);
  // ponytail: bounded O(500²) snapshot; add revision-keyed paging/indexing before supporting larger complete boards.
  const snapshot = tasks.slice(0, GROOMING_TASK_LIMIT).filter(task => task.state !== "approved" && (task.state !== "cancelled" || task.history.some(entry => entry.supersededBy))).sort((a, b) => a.id - b.id);
  const add = (item: GroomingItem) => {
    const key = JSON.stringify(item);
    if (seen.has(key)) return;
    seen.add(key);
    if (items.length >= GROOMING_ITEM_LIMIT) { truncated = true; return; }
    items.push(item);
  };
  const repositories = new Map<number, string>();
  const scoped = snapshot.flatMap(task => {
    const scopes = [task.refs.repo, task.external?.repo, task.sdlc?.repo].filter(value => value !== undefined);
    const normalized = scopes.map(groomingRepo);
    if (normalized.some(value => !value) || new Set(normalized).size > 1 || (!repository && !normalized.length)) { unknown.add(task.id); return []; }
    // ponytail: without project-root/Git identity, unqualified absolute paths cannot be attributed safely.
    // A future hardened repository resolver (#169) may prove their scope instead of leaving it unknown.
    if (!normalized.length && [...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])].some(path => path.startsWith("/"))) { unknown.add(task.id); return []; }
    repositories.set(task.id, (normalized[0] ?? repository)!);
    return [task];
  });
  const ids = new Set(scoped.map(task => task.id));
  const issueIds = new Map<number, Set<number>>();
  for (const task of scoped) {
    const taskRepository = repositories.get(task.id)!;
    const replacements = new Set<number>();
    for (const entry of task.history) {
      if (!entry.supersededBy) continue;
      const match = /^#([1-9][0-9]*)$/.exec(entry.supersededBy);
      const id = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(id) && id !== task.id && ids.has(id) && repositories.get(id) === taskRepository) replacements.add(id);
      else unknown.add(task.id);
    }
    if (replacements.size) add({ kind: "superseded", task: task.id, related: [...replacements].sort((a, b) => a - b) });
    if (task.state === "cancelled") continue; // Closed rows contribute supersession evidence only.
    const issues = new Set<number>();
    for (const issue of [task.external?.issue, task.sdlc?.issue]) {
      if (issue === undefined) continue;
      if (Number.isSafeInteger(issue) && issue > 0) issues.add(issue); else unknown.add(task.id);
    }
    // A bare title reference is an issue. Bare detail numbers remain board task references.
    for (const match of task.title.matchAll(/(?<![A-Za-z0-9_./-])(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\b|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b|#([1-9][0-9]*)\b)/g)) {
      const scope = match[1] ?? match[3], issue = Number(match[2] ?? match[4] ?? match[5]);
      if (scope && groomingRepo(scope) !== taskRepository) { unknown.add(task.id); continue; }
      if (Number.isSafeInteger(issue)) issues.add(issue); else unknown.add(task.id);
    }
    issueIds.set(task.id, issues);
    const missing = new Set<number>();
    for (const match of task.detail.matchAll(/^\s*(?:after|waits for)\s+#([1-9][0-9]*)\b/gim)) {
      const id = Number(match[1]);
      if (id !== task.id && Number.isSafeInteger(id) && !(task.deps ?? []).includes(id)) {
        if (ids.has(id)) missing.add(id); else unknown.add(task.id);
      }
    }
    if (missing.size) add({ kind: "text-dependency", task: task.id, related: [...missing].sort((a, b) => a - b) });
    const owner = task.owner ?? task.reserved;
    if (owner) {
      const count = groomingOwn(options.wip, owner), limit = groomingOwn(options.limits, owner), state = groomingOwn(options.states, owner);
      if (count === undefined || limit === undefined || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(limit) || limit < 0) unknown.add(task.id);
      else if (task.owner && count > limit) add({ kind: "over-wip", task: task.id, personCommand: `ahub task unassign ${task.id}` });
      if (state === "offline" || state === "paused") add({ kind: "blocked", task: task.id, code: state });
      else if (state === undefined) unknown.add(task.id);
    }
    for (const issue of issues) {
      const metadata = options.issues?.get(`${taskRepository}#${issue}`);
      if (!metadata || groomingRepo(metadata.repo) !== taskRepository || metadata.issue !== issue || !["OPEN", "CLOSED"].includes(metadata.state) || !Number.isFinite(Date.parse(metadata.editedAt))) { unknown.add(task.id); continue; }
      if (metadata.state === "CLOSED") add({ kind: "closed-issue", task: task.id });
      const reviewed = options.reviewedIssues?.get(task.id), accepted = options.acceptedIssues?.get(task.id);
      if (reviewed) {
        if (!Number.isFinite(Date.parse(reviewed.editedAt))) unknown.add(task.id);
        else if (Date.parse(metadata.editedAt) > Date.parse(reviewed.editedAt)) add({ kind: "stale", task: task.id });
      }
      if (accepted) {
        const stamp = (value: unknown): value is string | null => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
        // An old metadata snapshot has no lastEditedAt: its createdAt fallback cannot prove S1's null body stamp.
        if (groomingRepo(accepted.repo) !== taskRepository || accepted.issue !== issue || !stamp(accepted.lastEditedAt)
          || !Object.hasOwn(metadata, "lastEditedAt") || !stamp(metadata.lastEditedAt)) unknown.add(task.id);
        else if (accepted.lastEditedAt !== metadata.lastEditedAt) add({ kind: "stale", task: task.id });
      }
      if (!reviewed && !accepted) unknown.add(task.id);
    }
  }
  const places = (task: Task) => ({ paths: new Set([...(task.refs.paths ?? []), ...(task.plan?.paths ?? [])].map(groomingPath).filter((path): path is string => path !== undefined)), symbols: new Set((task.plan?.symbols ?? []).map(normalizePlanSymbol)) });
  const open = scoped.filter(task => task.state !== "cancelled");
  const positions = new Map(open.map(task => [task.id, places(task)]));
  const overlaps = (left: string, right: string): boolean => left === right || left === "." || right === "."
    || left.startsWith(right.endsWith("/") ? right : right + "/") || right.startsWith(left.endsWith("/") ? left : left + "/");
  for (let left = 0; left < open.length; left++) for (const right of open.slice(left + 1)) {
    const task = open[left]!;
    if (repositories.get(task.id) !== repositories.get(right.id)) continue;
    const a = positions.get(task.id)!, b = positions.get(right.id)!;
    if ([...a.paths].some(path => [...b.paths].some(other => overlaps(path, other))) || [...a.symbols].some(symbol => [...b.symbols].some(other => symbolsOverlap(symbol, other)))) add({ kind: "overlap", task: task.id, related: [right.id] });
    if ([...issueIds.get(task.id)!].some(issue => issueIds.get(right.id)!.has(issue))) add({ kind: "duplicate", task: task.id, related: [right.id] });
  }
  for (const blocker of (options.blockers ?? []).slice(0, GROOMING_TASK_LIMIT)) {
    if (!positions.has(blocker.task)) continue;
    if (GROOMING_CODES.has(blocker.code)) add({ kind: "blocked", task: blocker.task, code: blocker.code });
    else unknown.add(blocker.task);
  }
  if ((options.blockers?.length ?? 0) > GROOMING_TASK_LIMIT) truncated = true;
  return { items, unknown: [...unknown].sort((a, b) => a - b), truncated };
}
