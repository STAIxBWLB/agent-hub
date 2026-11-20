import type { SdlcGh } from "./sdlc.ts";

/** Bounded GitHub evidence; missing or ambiguous coverage never becomes a count. */
export interface BranchCi {
  runs: { id: number; attempt: number }[];
  fullGateRuns: number;
  successfulGateRuns: number;
  failedGateRuns: number;
  cancelledGateRuns: number;
  otherGateRuns: number;
  macosShardRuns: number;
  firstPass: 0 | 1 | null;
}

type Row = Record<string, any>;
const PAGE_SIZE = 100;
const PAGE_LIMIT = 10;
const TIMEOUT = 10_000;
const CAP = 256 * 1024;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const timestamp = (v: unknown): number => typeof v === "string" ? Date.parse(v) : NaN;

/** Read all pages, failing closed on an error, malformed page, changed total or a bounded overflow. */
async function pages(run: SdlcGh, endpoint: string, fields: string[], projection: string, key?: string): Promise<Row[] | undefined> {
  const all: Row[] = []; let total: number | undefined;
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const reply = await run(["api", "-X", "GET", endpoint, ...fields, "-F", `per_page=${PAGE_SIZE}`, "-F", `page=${page}`, "--jq", projection], TIMEOUT, undefined, CAP);
    if (reply.code !== 0) return;
    const parsed = JSON.parse(reply.stdout), rows = key ? parsed?.[key] : parsed;
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE || rows.some(row => !row || typeof row !== "object")) return;
    if (key) {
      if (!Number.isSafeInteger(parsed.total_count) || parsed.total_count < 0 || (total !== undefined && total !== parsed.total_count)) return;
      total = parsed.total_count;
    }
    all.push(...rows);
    if (total !== undefined ? all.length === total : rows.length < PAGE_SIZE) return all;
    if (total !== undefined && (all.length > total || rows.length < PAGE_SIZE)) return;
  }
}

/** Associate PR workflow runs by verified same-repository branch and lifetime, not pull_requests (often empty). */
export async function readBranchCi(repo: string, number: number, firstHead: string | undefined, run: SdlcGh): Promise<BranchCi | undefined> {
  try {
    const response = await run(["api", `repos/${repo}/pulls/${number}`, "--jq", "{number,state,created_at,merged_at,head:{ref:.head.ref,repo:{full_name:.head.repo.full_name}},base:{repo:{full_name:.base.repo.full_name}}}"], TIMEOUT, undefined, CAP);
    if (response.code !== 0) return;
    const pr = JSON.parse(response.stdout), branch = pr?.head?.ref, start = timestamp(pr?.created_at), end = timestamp(pr?.merged_at);
    if (pr.number !== number || pr.state !== "closed" || typeof branch !== "string" || !branch || !Number.isFinite(start) || !Number.isFinite(end) || end < start
      || pr.head?.repo?.full_name?.toLowerCase() !== repo.toLowerCase() || pr.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()) return;
    const owner = repo.split("/")[0];
    const prs = await pages(run, `repos/${repo}/pulls`, ["-f", "state=all", "-f", `head=${owner}:${branch}`], "[.[]|{number,created_at,closed_at}]");
    if (!prs || !prs.some(row => row.number === number)) return;
    for (const other of prs) {
      if (other.number === number) continue;
      const created = timestamp(other.created_at), closed = other.closed_at === null ? Infinity : timestamp(other.closed_at);
      if (!Number.isFinite(created) || !(Number.isFinite(closed) || closed === Infinity)) return;
      if (created <= end && closed >= start) return;
    }
    const rows = await pages(run, `repos/${repo}/actions/runs`, ["-f", `branch=${branch}`, "-f", "event=pull_request"], "{total_count,workflow_runs:[.workflow_runs[]|{id,path,created_at,head_sha,status,conclusion,run_attempt,pull_requests:[.pull_requests[].number]}]}", "workflow_runs");
    if (!rows) return;
    if (rows.some(row => typeof row.path !== "string" || !Number.isFinite(timestamp(row.created_at)) || !Array.isArray(row.pull_requests) || row.pull_requests.some((value: unknown) => !integer(value)))) return;
    const checks = rows.filter(row => row.path === ".github/workflows/check.yml" && timestamp(row.created_at) >= start && timestamp(row.created_at) <= end && (row.pull_requests.length === 0 || row.pull_requests.includes(number)));
    if (checks.some(row => row.pull_requests.some((value: number) => value !== number))) return;
    // ponytail: inspect at most one page of check runs and ten attempts each; raise the bounds with a provider-side summary.
    if (checks.length > PAGE_SIZE || checks.some(row => !integer(row.id) || !integer(row.run_attempt) || row.run_attempt > PAGE_LIMIT || !/^[a-f0-9]{40}$/.test(row.head_sha) || typeof row.status !== "string")) return;
    if (new Set(checks.map(row => row.id)).size !== checks.length) return;
    const timeline = await pages(run, `repos/${repo}/issues/${number}/timeline`, [], "[.[]|{event,created_at}]");
    if (!timeline) return;
    const changes = timeline.filter(row => row.event === "ready_for_review" || row.event === "converted_to_draft").map(row => ({ event: row.event, at: timestamp(row.created_at) })).sort((a, b) => a.at - b.at);
    if (changes.some(change => !Number.isFinite(change.at))) return;
    const initialDraft = changes.length > 0 && changes[0]!.event === "ready_for_review";
    let finalDraft = initialDraft;
    for (const change of changes) {
      if ((change.event === "ready_for_review") !== finalDraft) return;
      finalDraft = change.event === "converted_to_draft";
    }
    if (finalDraft) return;
    const draftAt = (at: number): boolean | undefined => {
      let draft = initialDraft;
      for (const change of changes) {
        if (change.at === at) return;
        if (change.at > at) break;
        if ((change.event === "ready_for_review") !== draft) return;
        draft = change.event === "converted_to_draft";
      }
      return draft;
    };
    let macosShardRuns = 0, firstPass: 0 | 1 | null = null, firstDecided = false;
    const observedRuns: { id: number; attempt: number; conclusion: string }[] = [];
    const ordered = checks.sort((a, b) => timestamp(a.created_at) - timestamp(b.created_at) || a.id - b.id);
    const firstHeadTimes = ordered.filter(row => firstHead && row.head_sha === firstHead).map(row => timestamp(row.created_at));
    const firstOrderAmbiguous = new Set(firstHeadTimes).size !== firstHeadTimes.length;
    for (const check of ordered) {
      let atMerge: { id: number; attempt: number; conclusion: string } | undefined;
      for (let attempt = 1; attempt <= check.run_attempt; attempt++) {
        const attemptReply = await run(["api", `repos/${repo}/actions/runs/${check.id}/attempts/${attempt}`, "--jq", "{id,run_attempt,status,conclusion,created_at,updated_at}"], TIMEOUT, undefined, CAP);
        if (attemptReply.code !== 0) return;
        const observed = JSON.parse(attemptReply.stdout), created = timestamp(observed.created_at), updated = timestamp(observed.updated_at);
        if (observed.id !== check.id || observed.run_attempt !== attempt || !Number.isFinite(created) || !Number.isFinite(updated) || created === end || updated === end) return;
        if (created > end) continue;
        if (observed.status !== "completed" || typeof observed.conclusion !== "string" || updated > end) return;
        atMerge = { id: check.id, attempt, conclusion: observed.conclusion };
        const jobs = await pages(run, `repos/${repo}/actions/runs/${check.id}/attempts/${attempt}/jobs`, [], "{total_count,jobs:[.jobs[]|{name,status,conclusion,runner_id}]}", "jobs");
        if (!jobs || jobs.some(job => typeof job.name !== "string")) return;
        const shards = jobs.filter(job => /^check \(macos-latest\) shard [1-4]\/4$/.test(job.name));
        if (shards.some(job => job.status !== "completed" || typeof job.conclusion !== "string" || !(job.runner_id === null || integer(job.runner_id)) || job.runner_id === null && job.conclusion !== "skipped" && job.conclusion !== "cancelled")) return;
        const ran = shards.filter(job => job.conclusion !== "skipped" && integer(job.runner_id));
        macosShardRuns += ran.length;
        if (attempt !== 1 || firstDecided || !firstHead || check.head_sha !== firstHead) continue;
        const draft = draftAt(timestamp(check.created_at));
        if (draft === undefined) return;
        if (draft || ran.length === 0 || observed.status !== "completed" || observed.conclusion === "cancelled") continue;
        if (observed.conclusion === "success") firstPass = 1;
        else if (observed.conclusion === "failure" || observed.conclusion === "timed_out") firstPass = 0;
        else return;
        firstDecided = true;
      }
      if (!atMerge) return;
      observedRuns.push(atMerge);
    }
    const successfulGateRuns = observedRuns.filter(row => row.conclusion === "success").length;
    const failedGateRuns = observedRuns.filter(row => row.conclusion === "failure" || row.conclusion === "timed_out").length;
    const cancelledGateRuns = observedRuns.filter(row => row.conclusion === "cancelled").length;
    return { runs: observedRuns.map(row => ({ id: row.id, attempt: row.attempt })), fullGateRuns: observedRuns.length,
      successfulGateRuns, failedGateRuns, cancelledGateRuns, otherGateRuns: observedRuns.length - successfulGateRuns - failedGateRuns - cancelledGateRuns, macosShardRuns, firstPass: firstOrderAmbiguous ? null : firstPass };
  } catch { return; }
}
