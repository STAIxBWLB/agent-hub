/** R3 (#1481): pure placement math. No clock, no I/O, no authority: Tasks gathers the inputs and decides who may see them. */
import type { Task } from "./board.ts";
import type { Milestone, MilestoneLink } from "./roadmap.ts";
import type { GitHubIssueRow } from "./github-import.ts";
import type { MilestoneView } from "./roadmap-view.ts";
import { sanitize } from "./envelope.ts";

export const UNPLACED_CAP = 100;
/** Why an item is on the unplaced list. Closed, so a renderer and a test can match on it. */
export const UNPLACED_REASONS = {
  issue: "open issue: no milestone links it and no linked task inherits a milestone from it",
  task: "open task: no explicit link and its source issue is on no milestone",
  taskNoIssue: "open task: no explicit link and it has no source issue to inherit from",
  spec: "spec: no milestone links it",
} as const;
export type UnplacedReason = typeof UNPLACED_REASONS[keyof typeof UNPLACED_REASONS];

export interface UnplacedInput {
  milestones: readonly Milestone[];
  links: readonly MilestoneLink[];
  tasks: readonly Task[];
  /** Open issues the paged read returned for one repository (lower-cased `owner/name`). */
  issues: { repo: string; rows: readonly GitHubIssueRow[]; partial: boolean } | undefined;
  /** Specs with status `active` or `draft`. `undefined` means the spec graph was unavailable, never "no specs". */
  specs: readonly { id: string; title: string; status: string | null }[] | undefined;
  issueOf(task: Task): string | undefined;
  privateTask(task: Task): boolean;
  publicText(text: string): boolean;
}
export interface UnplacedIssue { ref: string; title: string; reason: UnplacedReason }
export interface UnplacedTask { id: number; title: string; state: Task["state"]; reason: UnplacedReason; issue?: string }
export interface UnplacedSpec { id: string; title: string; status: string | null; reason: UnplacedReason }
export interface UnplacedResult {
  issues: UnplacedIssue[]; tasks: UnplacedTask[]; specs: UnplacedSpec[];
  /** Private tasks that would be listed: counted, never named (R1 rule). */
  privateTasks: number;
  /** True when the GitHub read stopped early or the list was cut: the lists are a lower bound. */
  partial: boolean;
  /** Evidence that was unavailable: named so an empty list is never read as "all placed". */
  unavailable: ("issues" | "specs")[];
  more: { issues: number; tasks: number; specs: number };
}
const safe = (input: Pick<UnplacedInput, "publicText">, text: string) => { try { return input.publicText(text); } catch { return false; } };
const open = (task: Task) => task.state !== "approved" && task.state !== "cancelled";

/**
 * What the roadmap places: every link, except those into a dropped milestone (abandoned work is unplaced again; a done milestone still places what it shipped).
 * Tasks inherit through issues exactly as R1's views say, so a task whose source issue is placed is placed.
 */
export function placedSets(input: Pick<UnplacedInput, "milestones" | "links" | "tasks" | "issueOf">) {
  const live = new Set(input.milestones.filter(milestone => milestone.state !== "dropped").map(milestone => milestone.id));
  const issues = new Set<string>(), specs = new Set<string>(), explicit = new Set<number>(), placedTasks = new Set<number>();
  for (const link of input.links) {
    if (!live.has(link.milestone)) continue;
    if (link.kind === "issue") issues.add(link.ref);
    else if (link.kind === "spec") specs.add(link.ref);
    else if (link.kind === "task") { explicit.add(Number(link.ref)); placedTasks.add(Number(link.ref)); }
  }
  for (const task of input.tasks) {
    if (explicit.has(task.id)) continue;
    const issue = input.issueOf(task);
    if (issue && issues.has(issue)) placedTasks.add(task.id);
  }
  return { issues, specs, explicit, placedTasks };
}

export function computeUnplaced(input: UnplacedInput): UnplacedResult {
  const placed = placedSets(input);
  const byIssue = new Map<string, Task[]>();
  for (const task of input.tasks) { const issue = input.issueOf(task); if (issue) byIssue.set(issue, [...(byIssue.get(issue) ?? []), task]); }
  let privateTasks = 0;
  const tasks: UnplacedTask[] = [];
  for (const task of [...input.tasks].sort((a, b) => a.id - b.id)) {
    if (!open(task) || placed.placedTasks.has(task.id)) continue;
    if (input.privateTask(task) || !safe(input, task.title)) { privateTasks++; continue; }
    const issue = input.issueOf(task);
    tasks.push({ id: task.id, title: sanitize(task.title), state: task.state, reason: issue ? UNPLACED_REASONS.task : UNPLACED_REASONS.taskNoIssue, ...(issue && safe(input, issue) ? { issue } : {}) });
  }
  const issues: UnplacedIssue[] = [];
  if (input.issues) {
    for (const row of input.issues.rows) {
      const ref = `${input.issues.repo}#${row.number}`;
      if (placed.issues.has(ref) || !safe(input, row.title) || !safe(input, ref)) continue;
      // A task for this issue decides it, private ones included, and no row ever names a private task: placed means the issue has dropped off
      // (inheritance), and an open task means the issue is reported once, as that task (its row, or the private count).
      const tasksFor = byIssue.get(ref) ?? [];
      if (tasksFor.some(task => placed.placedTasks.has(task.id) || open(task))) continue;
      issues.push({ ref, title: sanitize(row.title), reason: UNPLACED_REASONS.issue });
    }
  }
  const specs: UnplacedSpec[] = [];
  if (input.specs) {
    for (const spec of input.specs) {
      if (!spec.id || placed.specs.has(spec.id) || !["active", "draft"].includes(spec.status ?? "") || !safe(input, spec.id) || !safe(input, spec.title)) continue;
      specs.push({ id: spec.id, title: sanitize(spec.title), status: spec.status, reason: UNPLACED_REASONS.spec });
    }
  }
  const cut = <T>(rows: T[]) => ({ rows: rows.slice(0, UNPLACED_CAP), more: Math.max(0, rows.length - UNPLACED_CAP) });
  const i = cut(issues), t = cut(tasks), s = cut(specs);
  const unavailable: ("issues" | "specs")[] = [...(input.issues ? [] : ["issues" as const]), ...(input.specs ? [] : ["specs" as const])];
  const more = { issues: i.more, tasks: t.more, specs: s.more };
  return { issues: i.rows, tasks: t.rows, specs: s.rows, privateTasks, unavailable, more,
    partial: input.issues?.partial === true || more.issues + more.tasks + more.specs > 0 };
}

/** The R1 per-milestone roll-up figures, summed over a milestone and its children by `withTree`. */
export interface Rollup {
  tasks: { approved: number; total: number };
  issues: { closed: number; total: number; unknown: number };
  specs: { fresh: number; stale: number; unverified: number; unknown: number; total: number };
  releases: { shipped: number; total: number; unknown: number };
}
export interface TreeRollup extends Rollup { withheld: number; children: number }
/**
 * Parent roll-up includes its children (R3). R1 kept parent membership out of the parent's own roll-up on purpose;
 * `rollup` stays that own figure and `tree` is the new total. A task or issue linked to a parent and its child counts once.
 */
export function withTree(views: readonly MilestoneView[]): (MilestoneView & { tree: TreeRollup; readyToClose: ReadyToClose })[] {
  return views.map(view => {
    const family = [view, ...views.filter(child => child.parent === view.id)];
    const tasks = new Map<number, MilestoneView["tasks"][number]>(), issues = new Map<string, MilestoneView["issues"][number]>();
    const specs = new Map<string, MilestoneView["specs"][number]>(), releases = new Map<number, MilestoneView["releases"][number]>();
    let withheld = 0;
    for (const member of family) {
      for (const task of member.tasks) tasks.set(task.id, task);
      for (const issue of member.issues) issues.set(issue.ref, issue);
      for (const spec of member.specs) specs.set(spec.id, spec);
      for (const release of member.releases) releases.set(release.id, release);
      withheld += member.withheld;
    }
    const sum: Rollup = {
      tasks: { approved: [...tasks.values()].filter(task => task.state === "approved").length, total: tasks.size },
      issues: { closed: [...issues.values()].filter(issue => issue.state === "closed").length, total: issues.size, unknown: [...issues.values()].filter(issue => issue.state === "unknown").length },
      specs: { fresh: [...specs.values()].filter(spec => spec.state === "fresh").length, stale: [...specs.values()].filter(spec => spec.state === "stale").length,
        unverified: [...specs.values()].filter(spec => spec.state === "unverified").length, unknown: [...specs.values()].filter(spec => spec.state === "unknown").length, total: specs.size },
      releases: { shipped: [...releases.values()].filter(release => release.state === "shipped").length, total: releases.size, unknown: [...releases.values()].filter(release => release.state === "unknown").length },
    };
    return { ...view, tree: { ...sum, withheld, children: family.length - 1 }, readyToClose: readyToClose(view, family) };
  });
}

export interface ReadyToClose { ready: boolean; reasons: string[] }
/**
 * Ready only when there is something to be ready about and nothing open, unknown or withheld. Specs are not a closing condition:
 * a spec's freshness is about the document, not about the work. A done or dropped milestone is already settled.
 */
export function readyToClose(view: MilestoneView, family: readonly MilestoneView[] = [view]): ReadyToClose {
  if (view.state === "done" || view.state === "dropped") return { ready: false, reasons: [`already ${view.state}`] };
  const reasons: string[] = [], tasks = new Map<number, MilestoneView["tasks"][number]>(), issues = new Map<string, MilestoneView["issues"][number]>();
  const releases = new Map<number, MilestoneView["releases"][number]>();
  let withheld = 0;
  for (const member of family) {
    for (const task of member.tasks) tasks.set(task.id, task);
    for (const issue of member.issues) issues.set(issue.ref, issue);
    for (const release of member.releases) releases.set(release.id, release);
    withheld += member.withheld;
    if (member !== view && member.state !== "done" && member.state !== "dropped") reasons.push(`child milestone ${member.id} is ${member.state}`);
  }
  if (!tasks.size && !issues.size && !releases.size) reasons.push("nothing linked yet");
  const openTasks = [...tasks.values()].filter(task => task.state !== "approved" && task.state !== "cancelled").length;
  if (openTasks) reasons.push(`${openTasks} task${openTasks === 1 ? "" : "s"} not approved`);
  if (withheld) reasons.push(`${withheld} private task${withheld === 1 ? "" : "s"} withheld, so their state is not shown`);
  const openIssues = [...issues.values()].filter(issue => issue.state === "open").length, unknownIssues = [...issues.values()].filter(issue => issue.state === "unknown").length;
  if (openIssues) reasons.push(`${openIssues} issue${openIssues === 1 ? "" : "s"} open`);
  if (unknownIssues) reasons.push(`${unknownIssues} issue state${unknownIssues === 1 ? "" : "s"} unknown`);
  const notShipped = [...releases.values()].filter(release => release.state !== "shipped" && release.state !== "dropped").length;
  if (notShipped) reasons.push(`${notShipped} release train${notShipped === 1 ? "" : "s"} not shipped`);
  return { ready: reasons.length === 0, reasons };
}
