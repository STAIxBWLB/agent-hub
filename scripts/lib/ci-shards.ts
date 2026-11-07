// #1257 item 4: what the shard-timing cadence reads. Pure; the scripts that call the API pass the jobs in.
/** About 15 minutes, the figure docs/agent-notes/tests.md gives for a shard that has outgrown its timings. */
export const SHARD_BUDGET_MS = 15 * 60 * 1000;
/** A shard is over budget past this share above the budget (25 %, issue #1257). */
export const BUDGET_SLACK = 0.25;
/** The weights are regenerated about monthly (issue #1257): older than this reads as stale. */
export const TIMINGS_MAX_AGE_DAYS = 35;

export interface ShardJob { id: number; name: string; conclusion: string | null; startedAt: string | null; completedAt: string | null }
export interface ShardTime { id: number; name: string; ms: number }

const SHARD_NAME = /^check \((ubuntu|macos)-latest\) shard \d+\/\d+$/;

/** Successful, timed shard jobs of one run, by name. A reused gate leaves its shard jobs skipped, which are not timed. */
export function shardTimes(jobs: readonly ShardJob[]): ShardTime[] {
  return jobs
    .filter((job) => SHARD_NAME.test(job.name) && job.conclusion === "success" && job.startedAt && job.completedAt)
    .map((job) => ({ id: job.id, name: job.name, ms: Date.parse(job.completedAt!) - Date.parse(job.startedAt!) }))
    .filter((time) => Number.isFinite(time.ms) && time.ms >= 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The shards whose time exceeds the budget by more than `slack`. */
export function shardsOverBudget(times: readonly { name: string; ms: number }[], budgetMs = SHARD_BUDGET_MS, slack = BUDGET_SLACK): string[] {
  return times.filter((time) => time.ms > budgetMs * (1 + slack)).map((time) => time.name);
}

/** True when the timings file was last changed more than `maxAgeDays` before `now`; undefined when its date is unknown. */
export function timingsStale(lastChangedAt: string | undefined, now: Date, maxAgeDays = TIMINGS_MAX_AGE_DAYS): boolean | undefined {
  const at = lastChangedAt ? Date.parse(lastChangedAt) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  return now.getTime() - at > maxAgeDays * 24 * 60 * 60 * 1000;
}
