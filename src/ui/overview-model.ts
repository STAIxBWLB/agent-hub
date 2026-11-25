/**
 * #1514: the dashboard Overview view's pure projection. The daemon hands it the public board history it already holds (the same
 * rows `ahub sdlc metrics` reads), and it returns the five widgets as plain numbers and ids, so the page holds no rule of its
 * own and a test pins every figure without a browser.
 *
 * Self-contained on purpose: the dashboard injects this function's source into the page (`renderDashboard` in
 * `src/hub/ui.ts`), so it keeps every helper inside itself and closes over nothing from this module.
 *
 * A figure the board cannot derive is `null` and the page prints `unknown`, never 0. A private task never reaches a widget: it
 * is counted once in `withheld` and contributes no title, detail, owner or time.
 */

/** The slice of a board task the Overview reads: ids, enums and times, never text from a private task. */
export interface OverviewTask {
  id: number;
  private?: boolean;
  /** Public title; the caller passes `tasks.publicView(task).title`, never the raw one. */
  title: string;
  state: string;
  owner: string | null;
  created: number;
  history: { at: number; by?: string; event: string; evidenceOnly?: true }[];
  /**
   * The task's first-pass approval and the time it counts at, taken by the caller from `taskSample` (src/hub/sdlc-metrics.ts), the
   * one definition `ahub sdlc metrics` uses. Null is unknown. The model never re-derives it, so the two views cannot disagree.
   */
  firstPass?: 0 | 1 | null;
  sampleAt?: number;
}

export interface OverviewInput {
  tasks: readonly OverviewTask[];
  /** Open stalls (task id and kind), already limited to visible tasks by the caller. */
  stalls?: readonly { task: number; kind: string; at?: number }[];
  now: number;
}

export interface OverviewWeek { start: number; proposed: number; done: number }
export interface OverviewDay { start: number; events: number }
export interface OverviewPeerHealth {
  peer: string;
  /** First-pass approvals over the window: `n` known tasks, `unknown` tasks with no verdict yet, `rate` null when none is known. */
  firstPass: { n: number; unknown: number; rate: number | null };
  /** Turns ended in error is not on the board (it lives in the event log), so it is unknown here, never 0. */
  turnErrors: null;
}
export interface OverviewWorkload { peer: string; states: Record<string, number>; open: number }
export interface OverviewTrouble { task: number; title: string; kind: "check failed" | "changes_requested" | "stall"; at: number | null }
export interface OverviewView {
  throughput: OverviewWeek[];
  pulse: OverviewDay[];
  health: OverviewPeerHealth[];
  workload: OverviewWorkload[];
  trouble: OverviewTrouble[];
  /** Private tasks, counted and nothing else. */
  withheld: number;
}

export function overviewModel(input: OverviewInput): OverviewView {
  const DAY = 86_400_000, WEEK = 7 * DAY;
  const now = Number.isFinite(input.now) ? input.now : 0;
  const visible = input.tasks.filter(task => task.private !== true);
  const withheld = input.tasks.length - visible.length;
  const at = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  // Weeks and days are aligned to UTC midnight so a figure does not move with the reader's zone.
  const dayStart = (time: number) => Math.floor(time / DAY) * DAY;
  const today = dayStart(now);

  // Throughput: tasks proposed vs done per week, the last 8 weeks, oldest first. A task counts as done at its first approval.
  const throughput: OverviewWeek[] = [];
  for (let i = 7; i >= 0; i--) throughput.push({ start: today - (i * 7 + 6) * DAY, proposed: 0, done: 0 });
  const weekOf = (time: number) => {
    const from = throughput[0]!.start, to = throughput[7]!.start + WEEK;
    return time < from || time >= to ? undefined : throughput[Math.floor((time - from) / WEEK)];
  };
  for (const task of visible) {
    const proposed = at(task.created) ?? at(task.history[0]?.at);
    if (proposed !== null) { const week = weekOf(proposed); if (week) week.proposed++; }
    const approved = task.history.find(entry => entry.event === "approved");
    const doneAt = approved ? at(approved.at) : null;
    if (doneAt !== null) { const week = weekOf(doneAt); if (week) week.done++; }
  }

  // Pulse: board events per day, the last 12 weeks (84 days), oldest first.
  const pulse: OverviewDay[] = [];
  for (let i = 83; i >= 0; i--) pulse.push({ start: today - i * DAY, events: 0 });
  for (const task of visible) for (const entry of task.history) {
    const time = at(entry.at);
    if (time === null) continue;
    const index = Math.floor((dayStart(time) - pulse[0]!.start) / DAY);
    if (index >= 0 && index < pulse.length) pulse[index]!.events++;
  }

  // Peer health: per owner, first-pass approvals over the last 30 days, from the caller's `taskSample` values. A task whose sample
  // falls before the window is not part of it; a task with no verdict yet counts as unknown, never as a failure.
  const cutoff = now - 30 * DAY;
  const owners = new Map<string, (0 | 1 | null)[]>();
  for (const task of visible) {
    if (!task.owner) continue;
    const sampleAt = at(task.sampleAt);
    if (sampleAt !== null && sampleAt < cutoff) continue;
    const list = owners.get(task.owner) ?? [];
    list.push(task.firstPass === 0 || task.firstPass === 1 ? task.firstPass : null);
    owners.set(task.owner, list);
  }
  const health: OverviewPeerHealth[] = [...owners.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([peer, values]) => {
    const known = values.filter((value): value is 0 | 1 => value !== null);
    const rate = known.length ? Math.round((known.reduce<number>((sum, value) => sum + value, 0) / known.length) * 1000) / 1000 : null;
    return { peer, firstPass: { n: known.length, unknown: values.length - known.length, rate }, turnErrors: null };
  });

  // Peer workload: open tasks per owner by state. An unowned open task is not any peer's workload and is left out.
  const open = new Set(["backlog", "proposed", "in_progress", "in_review", "changes_requested"]);
  const byOwner = new Map<string, Record<string, number>>();
  for (const task of visible) {
    if (!task.owner || !open.has(task.state)) continue;
    const states = byOwner.get(task.owner) ?? {};
    states[task.state] = (states[task.state] ?? 0) + 1;
    byOwner.set(task.owner, states);
  }
  const workload: OverviewWorkload[] = [...byOwner.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([peer, states]) => ({ peer, states, open: Object.values(states).reduce((sum, count) => sum + count, 0) }));

  // Recent trouble: the last 20 failed checks, changes_requested verdicts and open stalls, newest first. A stall that has no
  // time of its own sorts last and shows its time as unknown.
  const trouble: OverviewTrouble[] = [];
  for (const task of visible) for (const entry of task.history) {
    const time = at(entry.at);
    if (time === null) continue;
    if (entry.event === "check failed" || entry.event === "check run failed") trouble.push({ task: task.id, title: task.title, kind: "check failed", at: time });
    else if (entry.event === "changes_requested" && entry.evidenceOnly !== true) trouble.push({ task: task.id, title: task.title, kind: "changes_requested", at: time });
  }
  const titles = new Map(visible.map(task => [task.id, task.title] as const));
  for (const stall of input.stalls ?? []) if (titles.has(stall.task)) trouble.push({ task: stall.task, title: titles.get(stall.task)!, kind: "stall", at: at(stall.at) });
  trouble.sort((a, b) => (b.at ?? -1) - (a.at ?? -1) || a.task - b.task);

  return { throughput, pulse, health, workload, trouble: trouble.slice(0, 20), withheld };
}
