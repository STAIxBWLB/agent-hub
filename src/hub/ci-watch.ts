import { parsePrEvidence, type SdlcGh } from "./sdlc.ts";

/**
 * #785 P1b: one bounded watcher per exact PR head. It starts when `hub_task_done` names a head whose CI was not green,
 * ends on a passed CI result or on this deadline (a failed or incomplete one is told and then watched for a rerun), and is cancelled by a newer head or any task move. It is a timer in the
 * hub, never a peer turn, and its gh reads (one `gh pr view` per poll) are the only periodic gh calls the hub makes.
 * The longest hosted run is about 30 minutes (the job limits in `.github/workflows/check.yml` are 35 and 40 minutes).
 */
export const CI_WATCH_DEADLINE_MS = 45 * 60_000;
export const CI_WATCH_POLL_MS = 60_000;
/** Same default set as `readReviewReadiness`, which is the authoritative read the review admission makes. */
const DEFAULT_CHECKS = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** How many finished heads are remembered, so one head never tells the same outcome twice. */
const SETTLED_CAP = 256;

/** What one poll found. `incomplete` is every required check finished with none failed and not all passed (skipped, neutral, duplicated). */
export type CiPoll = "pending" | "passed" | "failed" | "incomplete" | "superseded" | "closed";
export type CiOutcome = "passed" | "failed" | "incomplete" | "deadline";

export interface CiWatch { id: number; head: string; repo: string; pr: number; deadlineAt: number }
type Entry = { watch: CiWatch; timer?: ReturnType<typeof setTimeout>; reported?: boolean };

/** One read of the PR: the head, its state and the required checks of that head. A failed or unreadable read is `pending`; the deadline bounds the retries. */
export async function pollCi(target: { repo: string; pr: number }, head: string, required: readonly string[], run: SdlcGh): Promise<CiPoll> {
  if (!REPO.test(target.repo) || !Number.isSafeInteger(target.pr) || target.pr < 1) return "closed";
  try {
    const view = await run(["pr", "view", String(target.pr), "--repo", target.repo, "--json", "headRefOid,state,statusCheckRollup"], 10_000, undefined, 512 * 1024);
    if (view.code !== 0) return "pending";
    const body = JSON.parse(view.stdout);
    if (body?.headRefOid !== head) return "superseded";
    if (body.state !== "OPEN") return "closed";
    // The same check-state mapping as every other PR read; files are not requested here.
    const evidence = parsePrEvidence({ ...body, files: [], changedFiles: 0 });
    const rows = (required.length ? required : DEFAULT_CHECKS).map(name => evidence.checks.filter(check => check.name === name));
    if (rows.some(row => row.some(check => check.state === "failed"))) return "failed";
    if (rows.some(row => row.length === 0 || row.some(check => check.state === "pending"))) return "pending";
    return rows.every(row => row.length === 1 && row[0]!.state === "passed") ? "passed" : "incomplete";
  } catch { return "pending"; }
}

export interface CiWatchersOptions {
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  poll: (watch: CiWatch) => Promise<CiPoll>;
  /** False once the task moved or its head changed: the watcher ends without a notice. */
  current: (watch: CiWatch) => boolean;
  finish: (watch: CiWatch, outcome: CiOutcome) => void | Promise<void>;
}

/**
 * At most one watcher per task, and one per exact head. Only `passed` settles a head for good (#540): after `failed` or
 * `incomplete` the watcher keeps reading until its deadline, so a rerun of the same head (a new run attempt reads as pending,
 * which renews the deadline) is reported too, and a later `start` at that head watches again. Each (head, outcome) is told once. Timers are chained `setTimeout`s (never an interval), unref'd, and cleared
 * on every end, so nothing outlives its deadline, a newer head or `stopAll`. Watchers are not restored after a hub restart:
 * the next `hub_task_done` starts one (ponytail: persist them only if restarts during CI turn out to be common).
 */
export class CiWatchers {
  private readonly active = new Map<number, Entry>();
  private readonly settled = new Map<number, { head: string; outcomes: Set<CiOutcome>; last: CiOutcome }>();
  private readonly deadlineMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly o: CiWatchersOptions) {
    this.deadlineMs = o.deadlineMs ?? CI_WATCH_DEADLINE_MS;
    this.pollMs = o.pollMs ?? CI_WATCH_POLL_MS;
    this.now = o.now ?? Date.now;
  }

  get size(): number { return this.active.size; }

  /** Starts a watcher for this exact head; false when this head is already watched or already passed. A different head replaces the old watcher. */
  start(target: { id: number; head: string; repo: string; pr: number }): boolean {
    const have = this.active.get(target.id), done = this.reported(target.id, target.head);
    if (have?.watch.head === target.head || done?.has("passed")) return false;
    if (have) this.cancel(target.id);
    const entry: Entry = { watch: { ...target, deadlineAt: this.now() + this.deadlineMs }, reported: !!done?.size };
    this.active.set(target.id, entry);
    this.schedule(entry);
    return true;
  }

  /** The latest result reported for this exact head, if any. */
  outcomeOf(id: number, head: string): CiOutcome | undefined {
    const done = this.settled.get(id);
    return done?.head === head ? done.last : undefined;
  }

  private reported(id: number, head: string): Set<CiOutcome> | undefined {
    const done = this.settled.get(id);
    return done?.head === head ? done.outcomes : undefined;
  }

  /** Ends the task's watcher (a given head only when `head` is named). No notice. */
  cancel(id: number, head?: string): void {
    const entry = this.active.get(id);
    if (!entry || head !== undefined && entry.watch.head !== head) return;
    clearTimeout(entry.timer);
    this.active.delete(id);
  }

  stopAll(): void {
    for (const entry of this.active.values()) clearTimeout(entry.timer);
    this.active.clear();
  }

  private schedule(entry: Entry): void {
    const delay = Math.max(0, Math.min(this.pollMs, entry.watch.deadlineAt - this.now()));
    entry.timer = setTimeout(() => { void this.tick(entry); }, delay);
    entry.timer.unref?.();
  }

  private end(entry: Entry): boolean {
    if (this.active.get(entry.watch.id) !== entry) return false;
    clearTimeout(entry.timer);
    this.active.delete(entry.watch.id);
    return true;
  }

  private report(entry: Entry, outcome: CiOutcome): void {
    if (outcome !== "deadline") {
      const outcomes = this.reported(entry.watch.id, entry.watch.head) ?? new Set<CiOutcome>();
      outcomes.add(outcome);
      entry.reported = true;
      this.settled.delete(entry.watch.id);
      this.settled.set(entry.watch.id, { head: entry.watch.head, outcomes, last: outcome });
      while (this.settled.size > SETTLED_CAP) this.settled.delete(this.settled.keys().next().value as number);
    }
    void Promise.resolve().then(() => this.o.finish(entry.watch, outcome)).catch(() => { /* the finisher guards its own notices */ });
  }

  /** A watcher never throws out of its timer: a `current` or `finish` that fails (a closed board at shutdown) ends it. */
  private async tick(entry: Entry): Promise<void> {
    try { await this.step(entry); } catch { this.end(entry); }
  }

  private async step(entry: Entry): Promise<void> {
    entry.timer = undefined;
    if (this.active.get(entry.watch.id) !== entry) return;
    if (!this.o.current(entry.watch)) { this.end(entry); return; }
    // A deadline after a reported result ends silently: that result was already told.
    if (this.now() >= entry.watch.deadlineAt) { if (this.end(entry) && !entry.reported) this.report(entry, "deadline"); return; }
    let result: CiPoll;
    try { result = await this.o.poll(entry.watch); } catch { result = "pending"; }
    if (this.active.get(entry.watch.id) !== entry) return; // cancelled or replaced during the read
    if (!this.o.current(entry.watch) || result === "superseded" || result === "closed") { this.end(entry); return; }
    if (result === "pending") {
      // Pending after a reported result is a new run attempt of this head: it gets a full deadline of its own.
      if (entry.reported) entry.watch.deadlineAt = this.now() + this.deadlineMs;
      this.schedule(entry); return;
    }
    if (result === "passed") { if (this.end(entry)) this.report(entry, result); return; }
    // failed or incomplete: told once per outcome, then keep reading for a rerun of the same head.
    if (!this.reported(entry.watch.id, entry.watch.head)?.has(result)) this.report(entry, result);
    this.schedule(entry);
  }
}
