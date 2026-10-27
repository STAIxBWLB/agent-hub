// #481 S7: SDLC metrics and deterministic control bands. Pure: board history in, numbers out. No I/O, no clock, no model.
// A metric that cannot be derived is `unknown` and counted as such, never 0.
// `first_pass_check` reads the hub's own completion check (`check passed` / `check failed` at hub_task_done), not PR CI: it is unknown where completion checks are off.

export const BAND_METRICS = ["acceptance_to_plan_ms", "acceptance_to_first_review_ms", "first_pass_approval", "rework_rounds", "first_pass_check", "stale_head_re_reviews", "hotfix_rate", "security_open_alerts"] as const;
export type BandMetric = typeof BAND_METRICS[number];
/** Metrics whose series is not made of tasks: one value per shipped release (`hotfix_rate`, 1 for a hotfix) or per recorded security scan (`security_open_alerts`). The caller supplies them; the point's `task` is then a release or scan id. */
export const EXTERNAL_METRICS: readonly BandMetric[] = ["hotfix_rate", "security_open_alerts"];
export type SeriesPoint = { value: number; task: number };
export const BAND_TIERS = ["ok", "log", "diagnose", "propose"] as const;
export type BandTier = typeof BAND_TIERS[number];

/** The slice of a board task the metrics read. History entries carry ids, times and event names only. */
export interface MetricTask {
  id: number;
  private?: boolean;
  /** `evidenceOnly` marks a code-scope verdict with no open finding (#852): it is not a rework round. `requestHead` is the head a `done` asked review for (reviewCost.head); `verdictHead` the head a verdict was bound to (reviewFindings.head). Compared for equality only, never printed. */
  history: { at: number; event: string; requestHead?: string; verdictHead?: string; evidenceOnly?: true }[];
}

/** Per-task values; `null` is unknown. */
export interface TaskSample {
  id: number;
  /** When the sample counts: its first verdict, else its acceptance, else its first event. */
  at: number;
  /** When the task was approved, else null: `rework_rounds` and `stale_head_re_reviews` are final only then, and sit at this time in their series. */
  approved_at: number | null;
  acceptance_to_plan_ms: number | null;
  acceptance_to_first_review_ms: number | null;
  acceptance_to_merge_ms: number | null;
  first_pass_approval: 0 | 1 | null;
  rework_rounds: number | null;
  first_pass_check: 0 | 1 | null;
  same_head_ci_reruns: number | null;
  stale_head_re_reviews: number | null;
  /** #481 S7 merge-time readback: review handoffs (dones) up to the merge, CI runs of the merged PR and GitHub reviews on it. Null where the merge was not read. */
  review_rounds_at_merge: number | null;
  ci_runs_at_merge: number | null;
  github_reviews_at_merge: number | null;
}

export interface Summary { n: number; unknown: number; mean: number | null; median: number | null; p90: number | null; max: number | null }
export interface StallCounts { open: number; byKind: Record<string, number>; doneWithoutWrites: number }
export interface BandConfig { window: number; minSamples: number; logSigma: number; diagnoseSigma: number; proposeSigma: number; driftRun: number; minDelta: number }
export type BandsConfig = Partial<Record<BandMetric, BandConfig>>;
export interface BandResult {
  metric: BandMetric;
  tier: BandTier;
  /** Why the tier is what it is, in fixed words and numbers only. */
  reason: string;
  baseline: number;
  mean: number | null;
  sd: number | null;
  last: number | null;
  z: number | null;
  /** The task that produced the last value: the breach's evidence. */
  lastTask: number | null;
  /** The task whose value started the run of non-ok values this one belongs to, else null: one breach episode has one card. */
  episode: number | null;
  /** What `lastTask` and `episode` number: a task unless the metric is an external series (a release or a security scan). */
  subject?: "task" | "release" | "scan";
}
export const SUBJECT: Partial<Record<BandMetric, "release" | "scan">> = { hotfix_rate: "release", security_open_alerts: "scan" };

/** Which way is worse. A rate that falls and a time that grows are both breaches. */
export const BAD_DIRECTION: Record<BandMetric, "up" | "down"> = {
  acceptance_to_plan_ms: "up", acceptance_to_first_review_ms: "up", first_pass_approval: "down", rework_rounds: "up", first_pass_check: "down", stale_head_re_reviews: "up", hotfix_rate: "up", security_open_alerts: "up",
};
const HOUR = 3_600_000;
/** Per-metric floor on the absolute deviation, so a flat baseline does not make every wobble a breach. */
export const DEFAULT_MIN_DELTA: Record<BandMetric, number> = {
  acceptance_to_plan_ms: HOUR, acceptance_to_first_review_ms: HOUR, first_pass_approval: 0.5, rework_rounds: 1, first_pass_check: 0.5, stale_head_re_reviews: 1, hotfix_rate: 0.5, security_open_alerts: 1,
};
/** Per-metric floor on the baseline deviation: a flat baseline (every value the same) must not turn one step into thousands of deviations. */
export const SD_FLOOR: Record<BandMetric, number> = {
  acceptance_to_plan_ms: HOUR / 2, acceptance_to_first_review_ms: HOUR / 2, first_pass_approval: 0.5, rework_rounds: 0.5, first_pass_check: 0.5, stale_head_re_reviews: 0.5, hotfix_rate: 0.5, security_open_alerts: 0.5,
};
export const DEFAULT_BAND: Omit<BandConfig, "minDelta"> = { window: 20, minSamples: 8, logSigma: 2, diagnoseSigma: 3, proposeSigma: 4, driftRun: 6 };

const first = (task: MetricTask, events: readonly string[], after = -Infinity) => task.history.find(entry => entry.at >= after && events.includes(entry.event));
const VERDICTS = ["approved", "changes_requested"];

/**
 * Review rounds whose verdict was bound to a different head than the review was requested for: the head moved while the review ran.
 * Known only for a round with both heads recorded; a task with no such round is unknown, never 0. (A `done` after an `approved` is not
 * evidence: the board cannot produce one.)
 * ponytail: the request head is `reviewCost.head` (the commit the done named first) while a verdict's head prefers the lifecycle receipt's
 * `head`/`localHead` over `refs.commit` (`findingHead`), so a receipt head that differs from the commit can read as stale. Ceiling: a
 * spurious stale round for a task whose receipt head and commit disagree; the upgrade is one shared head rule for both sides.
 */
function staleHeadRounds(history: MetricTask["history"]): number | null {
  let pending: string | undefined, known = false, stale = 0;
  for (const entry of history) {
    if (entry.event === "done") pending = entry.requestHead;
    else if (VERDICTS.includes(entry.event)) {
      if (pending !== undefined && entry.verdictHead !== undefined) { known = true; if (entry.verdictHead !== pending) stale++; }
      pending = undefined;
    }
  }
  return known ? stale : null;
}

/** One task's values from its own history. A private task never reaches here. */
export function taskSample(task: MetricTask, extra: { mergedAt?: number; ciReruns?: number | null; ciRuns?: number | null; reviews?: number | null } = {}): TaskSample {
  const history = [...task.history].filter(entry => Number.isFinite(entry.at) && entry.at >= 0).sort((a, b) => a.at - b.at);
  const view: MetricTask = { id: task.id, history };
  const accepted = first(view, ["accepted"]);
  const spec = first(view, ["spec accepted"]);
  const plan = spec ? first(view, ["plan reviewed"], spec.at) : undefined;
  const verdict = accepted ? first(view, VERDICTS, accepted.at) : first(view, VERDICTS);
  // Evidence-only still ends the actual wait for a first review, but says nothing about whether the work passed.
  const substantiveVerdict = history.find(entry => entry.at >= (accepted?.at ?? -Infinity) && VERDICTS.includes(entry.event) && entry.evidenceOnly !== true);
  const dones = history.filter(entry => entry.event === "done");
  const ci = first(view, ["check passed", "check failed"]);
  const approvedAt = history.find(entry => entry.event === "approved")?.at ?? null;
  return {
    id: task.id,
    at: verdict?.at ?? accepted?.at ?? history[0]?.at ?? 0,
    approved_at: approvedAt,
    acceptance_to_plan_ms: spec && plan ? plan.at - spec.at : null,
    acceptance_to_first_review_ms: accepted && verdict ? verdict.at - accepted.at : null,
    acceptance_to_merge_ms: accepted && extra.mergedAt !== undefined && Number.isFinite(extra.mergedAt) && extra.mergedAt >= accepted.at ? extra.mergedAt - accepted.at : null,
    first_pass_approval: substantiveVerdict ? (substantiveVerdict.event === "approved" ? 1 : 0) : null,
    // Rework grows with every round, so it is a value only once the task is approved: a task still in flight has no final one, and a
    // provisional point would move at each verdict and could start a second breach episode inside one shift.
    rework_rounds: dones.length && approvedAt !== null ? history.filter(entry => entry.event === "changes_requested" && entry.evidenceOnly !== true).length : null,
    first_pass_check: ci ? (ci.event === "check passed" ? 1 : 0) : null,
    same_head_ci_reruns: extra.ciReruns === undefined ? null : extra.ciReruns,
    // Counted only for a merged PR whose figures were read: a done before the merge is one review round.
    review_rounds_at_merge: extra.mergedAt !== undefined && Number.isFinite(extra.mergedAt) ? dones.filter(entry => entry.at <= extra.mergedAt!).length : null,
    ci_runs_at_merge: extra.ciRuns === undefined ? null : extra.ciRuns,
    github_reviews_at_merge: extra.reviews === undefined ? null : extra.reviews,
    stale_head_re_reviews: approvedAt !== null ? staleHeadRounds(history) : null,
  };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
export function summarize(values: readonly (number | null)[]): Summary {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  const unknown = values.length - known.length;
  if (!known.length) return { n: 0, unknown, mean: null, median: null, p90: null, max: null };
  const mean = known.reduce((sum, value) => sum + value, 0) / known.length;
  return { n: known.length, unknown, mean: round(mean), median: round(percentile(known, 0.5)), p90: round(percentile(known, 0.9)), max: known.at(-1)! };
}
const round = (value: number) => Math.round(value * 1000) / 1000;

/** The values of one metric in the order they happened, unknown ones left out. */
export type TaskMetric = Exclude<BandMetric, "hotfix_rate" | "security_open_alerts">;
export function series(samples: readonly TaskSample[], metric: TaskMetric): SeriesPoint[] {
  const final = metric === "rework_rounds" || metric === "stale_head_re_reviews";
  const when = (sample: TaskSample) => final ? sample.approved_at ?? sample.at : sample.at;
  return [...samples].sort((a, b) => when(a) - when(b) || a.id - b.id).flatMap(sample => sample[metric] === null ? [] : [{ value: sample[metric] as number, task: sample.id }]);
}

/**
 * The newest value against the `window` values before it: mean, population standard deviation, and a tier from how many
 * deviations the newest value sits on the bad side. A run of `driftRun` newest values all more than one deviation on the bad
 * side is a drift and is at least `diagnose`. With fewer than `minSamples` before it, nothing fires.
 */
export function controlBands(points: readonly { value: number; task: number }[], metric: BandMetric, config: BandConfig): BandResult {
  const baselineCount = Math.max(0, Math.min(config.window, points.length - 1));
  const none = (reason: string, extra: Partial<BandResult> = {}): BandResult => ({ metric, tier: "ok", reason, baseline: baselineCount, mean: null, sd: null, last: points.at(-1)?.value ?? null, z: null, lastTask: points.at(-1)?.task ?? null, episode: null, ...extra });
  if (points.length < 2 || baselineCount < config.minSamples) return none(`baseline of ${baselineCount} is below the ${config.minSamples} needed`);
  const last = points.at(-1)!, base = points.slice(-1 - baselineCount, -1).map(point => point.value);
  const mean = base.reduce((sum, value) => sum + value, 0) / base.length;
  const sd = Math.sqrt(base.reduce((sum, value) => sum + (value - mean) ** 2, 0) / base.length);
  const sign = BAD_DIRECTION[metric] === "up" ? 1 : -1;
  const deviation = sign * (last.value - mean);
  const z = deviation <= 0 ? 0 : deviation / Math.max(sd, SD_FLOOR[metric]);
  const result = { metric, baseline: base.length, mean: round(mean), sd: round(sd), last: last.value, z: round(Math.min(z, 1e6)), lastTask: last.task, episode: null as number | null };
  const drifting = deviation >= config.minDelta && deviation > 0 && points.length - 1 >= config.driftRun && points.slice(-config.driftRun).every(point => sign * (point.value - mean) > sd);
  let tier: BandTier = "ok", reason = `${round(Math.min(z, 1e6))} deviations on the bad side`;
  if (deviation >= config.minDelta && deviation > 0) {
    if (z >= config.proposeSigma) { tier = "propose"; reason = `${round(Math.min(z, 1e6))} deviations beyond the baseline (propose at ${config.proposeSigma})`; }
    else if (z >= config.diagnoseSigma) { tier = "diagnose"; reason = `${round(z)} deviations beyond the baseline (diagnose at ${config.diagnoseSigma})`; }
    else if (z >= config.logSigma) { tier = "log"; reason = `${round(z)} deviations beyond the baseline (log at ${config.logSigma})`; }
  }
  if (drifting && BAND_TIERS.indexOf(tier) < BAND_TIERS.indexOf("diagnose")) { tier = "diagnose"; reason = `the last ${config.driftRun} values are all more than one deviation on the bad side`; }
  return { ...result, tier, reason };
}

/** How far back an episode is searched. ponytail: a run longer than this restarts its key every sample, so the open-card rule in Tasks holds it to one card. */
export const EPISODE_LOOKBACK = 200;
/**
 * `controlBands` for the newest value, plus the breach episode it belongs to: the trailing run of values whose own tier (computed from
 * the values before each, with nothing after) was not `ok`. The episode is the task that started the run, so a sustained shift keeps one
 * key for as long as it lasts, and it is derived from history alone, so it survives a restart.
 */
export function controlEpisode(points: readonly { value: number; task: number }[], metric: BandMetric, config: BandConfig): BandResult {
  const subject = SUBJECT[metric];
  const now = { ...controlBands(points, metric, config), ...(subject ? { subject } : {}) };
  if (now.tier === "ok") return now;
  let start = points.length - 1;
  for (let end = points.length - 2; end >= 0 && points.length - 1 - end <= EPISODE_LOOKBACK; end--) {
    if (controlBands(points.slice(0, end + 1), metric, config).tier === "ok") break;
    start = end;
  }
  return { ...now, episode: points[start]!.task };
}

export interface MetricsReport {
  since: number | null;
  tasks: number;
  withheldPrivate: number;
  metrics: {
    acceptance_to_plan_ms: Summary; acceptance_to_first_review_ms: Summary; acceptance_to_merge_ms: Summary;
    first_pass_approval: { n: number; unknown: number; rate: number | null };
    rework_rounds: Summary;
    first_pass_check: { n: number; unknown: number; rate: number | null };
    same_head_ci_reruns: Summary;
    stale_head_re_reviews: Summary;
    review_rounds_at_merge: Summary; ci_runs_at_merge: Summary; github_reviews_at_merge: Summary;
  };
  /** Merged PRs whose review and CI figures were read at merge, and how many of the counted tasks have none (unknown, never 0). */
  merged: { read: number; unknown: number };
  stalls: StallCounts;
  bands: BandResult[] | "off";
}

const rate = (values: readonly (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return { n: known.length, unknown: values.length - known.length, rate: known.length ? round(known.reduce((sum, value) => sum + value, 0) / known.length) : null };
};

/**
 * The whole report from board tasks. `since` keeps samples that count at or after it; `mergedAt` and `ciReruns` come from bounded
 * PR readbacks keyed by task id and are optional. Private tasks are counted as withheld and read for nothing else.
 */
export function sdlcMetrics(tasks: readonly MetricTask[], opts: { since?: number; bands?: BandsConfig; stalls?: StallCounts; mergedAt?: Readonly<Record<number, number>>; ciReruns?: Readonly<Record<number, number | null>>; ciRuns?: Readonly<Record<number, number | null>>; reviews?: Readonly<Record<number, number | null>>; external?: Partial<Record<BandMetric, readonly SeriesPoint[]>> } = {}): MetricsReport {
  const visible = tasks.filter(task => !task.private);
  const all = visible.map(task => taskSample(task, { mergedAt: opts.mergedAt?.[task.id], ciReruns: opts.ciReruns?.[task.id], ciRuns: opts.ciRuns?.[task.id], reviews: opts.reviews?.[task.id] }));
  const samples = opts.since === undefined ? all : all.filter(sample => sample.at >= opts.since!);
  const bands: BandResult[] | "off" = opts.bands && Object.keys(opts.bands).length
    ? BAND_METRICS.flatMap(metric => opts.bands![metric] ? [controlEpisode(EXTERNAL_METRICS.includes(metric) ? [...(opts.external?.[metric] ?? [])] : series(samples, metric as TaskMetric), metric, opts.bands![metric]!)] : [])
    : "off";
  return {
    since: opts.since ?? null, tasks: samples.length, withheldPrivate: tasks.length - visible.length,
    metrics: {
      acceptance_to_plan_ms: summarize(samples.map(s => s.acceptance_to_plan_ms)), acceptance_to_first_review_ms: summarize(samples.map(s => s.acceptance_to_first_review_ms)),
      acceptance_to_merge_ms: summarize(samples.map(s => s.acceptance_to_merge_ms)),
      first_pass_approval: rate(samples.map(s => s.first_pass_approval)), rework_rounds: summarize(samples.map(s => s.rework_rounds)),
      first_pass_check: rate(samples.map(s => s.first_pass_check)), same_head_ci_reruns: summarize(samples.map(s => s.same_head_ci_reruns)),
      stale_head_re_reviews: summarize(samples.map(s => s.stale_head_re_reviews)),
      review_rounds_at_merge: summarize(samples.map(s => s.review_rounds_at_merge)), ci_runs_at_merge: summarize(samples.map(s => s.ci_runs_at_merge)),
      github_reviews_at_merge: summarize(samples.map(s => s.github_reviews_at_merge)),
    },
    merged: { read: samples.filter(s => s.ci_runs_at_merge !== null || s.github_reviews_at_merge !== null).length, unknown: samples.filter(s => s.ci_runs_at_merge === null && s.github_reviews_at_merge === null).length },
    stalls: opts.stalls ?? { open: 0, byKind: {}, doneWithoutWrites: 0 }, bands,
  };
}

const BAND_KEYS = ["window", "min_samples", "log_sigma", "diagnose_sigma", "propose_sigma", "drift_run", "min_delta"] as const;
/**
 * `[bands.<metric>]` tables of sdlc.toml. Every field is optional and bounded; an unknown metric or field is refused with its
 * path, and the tiers must be ordered log <= diagnose <= propose so a breach never skips a tier it is meant to pass through.
 */
export function bandsConfig(value: unknown): BandsConfig {
  if (value === undefined) return {};
  const fail = (path: string, why: string): never => { throw new Error(`sdlc.bands${path}: ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("", "expected a table");
  const out: BandsConfig = {};
  for (const [metric, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(BAND_METRICS as readonly string[]).includes(metric)) fail(`.${metric}`, `unknown metric (use ${BAND_METRICS.join(", ")})`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`.${metric}`, "expected a table");
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row)) if (!(BAND_KEYS as readonly string[]).includes(key)) fail(`.${metric}.${key}`, "unknown field");
    const number = (key: typeof BAND_KEYS[number], fallback: number, min: number, max: number, integer: boolean) => {
      const given = row[key] ?? fallback;
      if (typeof given !== "number" || !Number.isFinite(given) || given < min || given > max || integer && !Number.isSafeInteger(given)) fail(`.${metric}.${key}`, `expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
      return given as number;
    };
    const m = metric as BandMetric;
    const config: BandConfig = {
      window: number("window", DEFAULT_BAND.window, 4, 200, true), minSamples: number("min_samples", DEFAULT_BAND.minSamples, 3, 200, true),
      logSigma: number("log_sigma", DEFAULT_BAND.logSigma, 0.5, 20, false), diagnoseSigma: number("diagnose_sigma", DEFAULT_BAND.diagnoseSigma, 0.5, 20, false),
      proposeSigma: number("propose_sigma", DEFAULT_BAND.proposeSigma, 0.5, 20, false), driftRun: number("drift_run", DEFAULT_BAND.driftRun, 3, 50, true),
      minDelta: number("min_delta", DEFAULT_MIN_DELTA[m], 0, 1e12, false),
    };
    if (config.minSamples > config.window) fail(`.${metric}.min_samples`, "must not exceed window");
    if (!(config.logSigma <= config.diagnoseSigma && config.diagnoseSigma <= config.proposeSigma)) fail(`.${metric}`, "tiers must be ordered log_sigma <= diagnose_sigma <= propose_sigma");
    out[m] = config;
  }
  return out;
}
