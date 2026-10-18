/** S10 cost evidence is metadata only. Legacy scope and incomplete readback remain unknown. */
export interface ReviewScope { scope: "none" | "delta" | "full"; reviewers: number }
export interface CostPlan { review?: ReviewScope; ci?: "focused" | "full" | "reuse" }
export interface ReviewCost extends CostPlan { head?: string }
export interface CostTask { repo: string; pr: number; private?: boolean; history: { event: string; at: number; reviewCost?: ReviewCost }[] }
export interface CostPr { repo: string; pr: number; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt?: number; complete: boolean; ciRuns?: { id: number; attempt: number }[]; reviews?: number }
export interface CostRow { repo: string; pr: number; reviewRounds: number; ciRuns: number | null; ciReruns: number | null; fullReReviews: number; deltaReviews: number; reviewMs: number | null; unknownReviewScopes: number; githubReviews: number | null; complete: boolean }
export interface CostReport { rows: CostRow[]; truncated: boolean }
export function cleanCostPlan(input: unknown): CostPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid cost scope");
  const value = input as Record<string, unknown>;
  const result: CostPlan = {};
  if (value.review !== undefined) {
    const review = value.review as Record<string, unknown>;
    if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).some(key => !["scope", "reviewers"].includes(key))
      || !["none", "delta", "full"].includes(review.scope as string) || !Number.isSafeInteger(review.reviewers)
      || (review.scope === "none" ? review.reviewers !== 0 : (review.reviewers as number) < 1 || (review.reviewers as number) > 8)) throw new Error("invalid review cost scope");
    result.review = { scope: review.scope as ReviewScope["scope"], reviewers: review.reviewers as number };
  }
  if (value.ci !== undefined) {
    if (!["focused", "full", "reuse"].includes(value.ci as string)) throw new Error("invalid CI cost scope");
    result.ci = value.ci as CostPlan["ci"];
  }
  return result;
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
          if (event.reviewCost?.review?.scope === "none") continue;
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
