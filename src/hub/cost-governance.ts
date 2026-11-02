/** S10 cost evidence is metadata only. Legacy scope and incomplete readback remain unknown. */
export interface ReviewScope { scope: "none" | "delta" | "full"; reviewers: number }
export interface CostPlan { review?: ReviewScope; ci?: "focused" | "full" | "reuse" }
export interface ReviewCost extends CostPlan { head?: string }
export interface CostTask { repo: string; pr: number; private?: boolean; history: { event: string; at: number; reviewCost?: ReviewCost }[] }
export interface CostPr { repo: string; pr: number; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt?: number; complete: boolean; ciRuns?: { id: number; attempt: number }[]; reviews?: number }
export interface CostRow { repo: string; pr: number; reviewRounds: number; ciRuns: number | null; ciReruns: number | null; fullReReviews: number; deltaReviews: number; reviewMs: number | null; unknownReviewScopes: number; githubReviews: number | null; complete: boolean }
export interface CostReport { rows: CostRow[]; truncated: boolean }
/**
 * #1087: why a cost scope was refused. The message is fixed text that names the field and its allowed values and never the value given, so a call site may show it
 * as it is. Only this class is passed through; any other error keeps the generic refusal.
 */
export class CostScopeError extends Error {
  constructor(message: string) { super(message); this.name = "CostScopeError"; }
}
/**
 * `field` says how the caller's own argument is named, so the refusal points at what the caller actually wrote: `plan` for a task plan (`plan.review.scope`), empty for the
 * plan-review tool's own `review` and `ci` arguments (`review.scope`). One string covers both keys; an object names each key's source separately, for a call that mixes them.
 */
export function cleanCostPlan(input: unknown, field: string | { review: string; ci: string } = "plan"): CostPlan {
  const at = (name: string) => { const prefix = typeof field === "string" ? field : field[name.split(".")[0] as "review" | "ci"]; return prefix ? `${prefix}.${name}` : name; };
  const refuse = (message: string): never => { throw new CostScopeError(message); };
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse(`${typeof field === "string" && field ? field : "the request"} must be an object; review and ci are its cost scope fields`);
  const value = input as Record<string, unknown>;
  const result: CostPlan = {};
  if (value.review !== undefined) {
    const review = value.review as Record<string, unknown>;
    if (!review || typeof review !== "object" || Array.isArray(review)) refuse(`${at("review")} must be an object with scope (none, delta or full) and reviewers (a whole number)`);
    if (Object.keys(review).some(key => !["scope", "reviewers"].includes(key))) refuse(`${at("review")} takes only scope and reviewers`);
    if (!["none", "delta", "full"].includes(review.scope as string)) refuse(`${at("review.scope")} must be none, delta or full`);
    if (!Number.isSafeInteger(review.reviewers)) refuse(`${at("review.reviewers")} must be a whole number: 0 when scope is none, 1 to 8 when scope is delta or full`);
    if (review.scope === "none" && review.reviewers !== 0) refuse(`${at("review.reviewers")} must be 0 when scope is none`);
    if (review.scope !== "none" && ((review.reviewers as number) < 1 || (review.reviewers as number) > 8)) refuse(`${at("review.reviewers")} must be 1 to 8 when scope is delta or full`);
    result.review = { scope: review.scope as ReviewScope["scope"], reviewers: review.reviewers as number };
  }
  if (value.ci !== undefined) {
    if (!["focused", "full", "reuse"].includes(value.ci as string)) refuse(`${at("ci")} must be focused, full or reuse`);
    result.ci = value.ci as CostPlan["ci"];
  }
  return result;
}
/**
 * #481 S7: what the guarded merge records about a merged PR, from the PR read once at merge. Every field is `null` when the read could not establish it, never 0.
 * CI figures need the complete read (runs linked by every head of the PR); a rerun is an attempt after the first of one run id, i.e. the same head run again.
 */
export interface MergeCost { mergedAt: number | null; ciRuns: number | null; ciReruns: number | null; reviews: number | null }
export function ciRunCounts(runs: readonly { id: number; attempt: number }[] | undefined): { runs: number; reruns: number } | null {
  if (!runs || runs.length > 100) return null;
  const attempts = new Map<number, number>();
  for (const run of runs) {
    if (!Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || run.attempt > 10_000) return null;
    attempts.set(run.id, Math.max(attempts.get(run.id) ?? 0, run.attempt));
  }
  return { runs: attempts.size, reruns: [...attempts.values()].reduce((sum, n) => sum + n - 1, 0) };
}
export function mergeCostFrom(pr: CostPr | undefined): MergeCost | undefined {
  if (!pr || pr.state !== "MERGED") return undefined;
  const counts = pr.complete ? ciRunCounts(pr.ciRuns) : null;
  return { mergedAt: Number.isSafeInteger(pr.mergedAt) && pr.mergedAt! >= 0 ? pr.mergedAt! : null, ciRuns: counts?.runs ?? null, ciReruns: counts?.reruns ?? null,
    reviews: Number.isSafeInteger(pr.reviews) && pr.reviews! >= 0 ? pr.reviews! : null };
}
/** Bounded, finite or absent: a stored record is data, never trusted shape. */
export function cleanMergeCost(value: unknown): MergeCost | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>, field = (key: string) => Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0 ? raw[key] as number : null;
  return { mergedAt: field("mergedAt"), ciRuns: field("ciRuns"), ciReruns: field("ciReruns"), reviews: field("reviews") };
}
const validRepo = (repo: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.startsWith("-");
const key = (repo: string, pr: number) => `${repo.toLowerCase()}#${pr}`;
/** One round is a board review handoff, not one reviewer in a multi-reviewer round. CI attempts share a run id. */
export function costMetrics(tasks: CostTask[], prs: CostPr[]): CostReport {
  const withheld = new Set(tasks.filter(task => task.private).map(task => key(task.repo, task.pr)));
  const rows: CostRow[] = [];
  let truncated = tasks.length > 500 || prs.length > 200, historyLeft = 10_000;
  const seen = new Set<string>();
  for (const pr of prs.slice(0, 200)) {
    const identity = key(pr.repo, pr.pr);
    if (!validRepo(pr.repo) || !Number.isSafeInteger(pr.pr) || pr.pr < 1 || pr.state !== "MERGED" || withheld.has(identity) || seen.has(identity)) continue;
    if (!tasks.some(task => !task.private && key(task.repo, task.pr) === identity)) continue;
    seen.add(identity);
    const rounds: { at: number; scope?: ReviewScope["scope"]; elapsed?: number }[] = [];
    let complete = pr.complete && Number.isFinite(pr.mergedAt);
    for (const task of tasks.slice(0, 500).filter(task => key(task.repo, task.pr) === identity)) {
      const history = task.history.slice(0, Math.max(0, historyLeft)); historyLeft -= history.length;
      if (history.length < task.history.length) { complete = false; truncated = true; }
      let pending: typeof rounds[number] | undefined;
      for (const event of [...history].sort((a, b) => a.at - b.at)) {
        if (!Number.isFinite(event.at) || event.at < 0 || !Number.isFinite(pr.mergedAt) || event.at > pr.mergedAt!) continue;
        if (event.event === "done") {
          pending = { at: event.at, scope: event.reviewCost?.review?.scope }; rounds.push(pending);
        } else if (pending && ["approved", "changes_requested"].includes(event.event)) { pending.elapsed = event.at - pending.at; pending = undefined; }
      }
    }
    rounds.sort((a, b) => a.at - b.at);
    const attempts = new Map<number, number>();
    if (pr.ciRuns) for (const run of pr.ciRuns.slice(0, 100)) {
      if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.attempt) || run.attempt < 1 || run.attempt > 10_000) { complete = false; continue; }
      attempts.set(run.id, Math.max(attempts.get(run.id) ?? 0, run.attempt));
    }
    if (pr.ciRuns && pr.ciRuns.length > 100) { complete = false; truncated = true; }
    if (!pr.ciRuns || pr.reviews === undefined || rounds.some(round => round.elapsed === undefined || round.scope === undefined)) complete = false;
    rows.push({ repo: pr.repo.toLowerCase(), pr: pr.pr, reviewRounds: rounds.length,
      ciRuns: pr.ciRuns ? attempts.size : null, ciReruns: pr.ciRuns ? [...attempts.values()].reduce((sum, n) => sum + n - 1, 0) : null,
      fullReReviews: rounds.filter((round, index) => index > 0 && round.scope === "full").length,
      deltaReviews: rounds.filter(round => round.scope === "delta").length,
      reviewMs: rounds.every(round => round.elapsed !== undefined) ? rounds.reduce((sum, round) => sum + round.elapsed!, 0) : null,
      unknownReviewScopes: rounds.filter(round => round.scope === undefined).length, githubReviews: pr.reviews ?? null, complete });
  }
  return { rows: rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr), truncated };
}
export function costBandProposals(report: CostReport, upper: Partial<Record<"reviewRounds" | "ciRuns" | "ciReruns" | "fullReReviews" | "deltaReviews" | "reviewMs", number>>): { repo: string; pr: number; metric: string; observed: number; upper: number }[] {
  if (report.truncated) return [];
  return report.rows.filter(row => row.complete).flatMap(row => Object.entries(upper).flatMap(([metric, limit]) => {
    if (!["reviewRounds", "ciRuns", "ciReruns", "fullReReviews", "deltaReviews", "reviewMs"].includes(metric) || !Number.isFinite(limit) || limit! < 0) return [];
    const observed = row[metric as keyof CostRow];
    return typeof observed === "number" && observed > limit! ? [{ repo: row.repo, pr: row.pr, metric, observed, upper: limit! }] : [];
  }));
}
