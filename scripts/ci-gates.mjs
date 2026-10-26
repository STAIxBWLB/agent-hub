export const REUSE_MARKER = "Reuse verified identical-tree full gate";
const reusedJob = job => Array.isArray(job.steps) && job.steps.some(step => step.name === REUSE_MARKER && step.conclusion === "success");

const FULL_GATES = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
class GateReadLimitError extends Error {}
class MalformedGateProofError extends Error {}
const lostProofError = error => !(error instanceof GateReadLimitError) && (
  error instanceof MalformedGateProofError || error instanceof SyntaxError
  || error?.status === 404 || error?.status === undefined && error?.name === "TimeoutError"
);
// A transient GitHub 5xx or a 429 is not lost proof and not an answer: the runs API returned 502 on about half of all calls for stretches of 2026-10-26 (#872), and failing closed on the
// first one refused every PR before any gate job ran. It is retried, twice at most, with a short backoff, and only while the shared deadline leaves room. Everything else (any other status, a
// timeout, malformed data) is untouched, and a read that stays failed still ends as unknown, which is never permission to run or reuse.
const RETRY_BACKOFF_MS = [500, 1000];
const retryableStatus = error => Number.isInteger(error?.status) && (error.status === 429 || error.status >= 500 && error.status <= 599);
const ACTIVE_RUN = new Set(["in_progress", "queued", "waiting", "pending", "requested"]);
const sameRun = (left, right) => right !== undefined && String(left) === String(right);
const successfulFullGate = run => run.status === "completed" && run.conclusion === "success"
  && ["pull_request", "push"].includes(run.event) && run.jobsComplete === true && Array.isArray(run.jobs)
  && FULL_GATES.every(name => {
    const matches = run.jobs.filter(job => job.name === name);
    return matches.length === 1 && matches[0].conclusion === "success" && !reusedJob(matches[0]);
  });

/** Pure decision over host-read evidence; a full scope means gate jobs, not merely a workflow controller, were admitted. */
export function fullGateAdmission(tree, runs, { currentRunId, complete = false } = {}) {
  if (typeof tree !== "string" || !tree || !Array.isArray(runs)) return { kind: "unknown", reason: "invalid gate evidence" };
  const candidates = runs.filter(run => run && !sameRun(run.id, currentRunId) && run.scope !== "other");
  const verified = candidates.find(run => run.tree === tree && run.scope === "full" && successfulFullGate(run));
  if (verified) return { kind: "reuse", run: verified };
  const duplicate = candidates.find(run => run.tree === tree && run.scope === "full" && ACTIVE_RUN.has(run.status));
  if (duplicate) return { kind: "duplicate", run: duplicate };
  if (!complete || candidates.some(run => ACTIVE_RUN.has(run.status) && (!run.tree || run.tree === tree && run.scope !== "full"))) {
    return { kind: "unknown", reason: "active full-gate coverage unavailable" };
  }
  return { kind: "run" };
}

/**
 * Read-only bounded admission snapshot under the whole-controller lock for this PR, or the separate main group.
 * Different groups may observe the same empty snapshot and run a tree twice (#609: redundant work, never false green).
 * Lost successful proof can require a fresh gate; incomplete active coverage and global read ceilings stay unknown.
 */
export async function readFullGateAdmission(api, tree, { currentRunId, deadline = Date.now() + 60_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const evidence = [], commits = new Map();
  let requests = 0;
  const checkDeadline = () => {
    const at = now();
    if (!Number.isFinite(deadline) || !Number.isFinite(at) || at >= deadline) throw new GateReadLimitError("gate read deadline exhausted");
  };
  const read = async path => {
    for (let attempt = 0; ; attempt++) {
      checkDeadline();
      if (requests >= 240) throw new GateReadLimitError("gate read budget exhausted"); // a retry is a request: it counts against the same budget
      requests++;
      try { return await api(path); }
      catch (error) {
        const backoff = RETRY_BACKOFF_MS[attempt];
        // The backoff must fit before the deadline, with room left for the retry itself; otherwise the original error stands and the read fails closed as before.
        if (!retryableStatus(error) || backoff === undefined || !(now() + backoff < deadline)) throw error;
        await sleep(backoff);
      } finally { checkDeadline(); } // A failed or late successful request cannot turn global exhaustion into lost proof.
    }
  };
  const page = (value, key) => {
    if (!value || !Array.isArray(value[key]) || value[key].length > 100 || !Number.isSafeInteger(value.total_count) || value.total_count < value[key].length) throw new MalformedGateProofError("gate page unavailable");
    return { rows: value[key], complete: value.total_count === value[key].length };
  };
  const treeOf = async run => {
    if (typeof run.head_sha !== "string" || !run.head_sha) throw new MalformedGateProofError("run commit unavailable");
    if (!commits.has(run.head_sha)) {
      const commit = await read(`git/commits/${encodeURIComponent(run.head_sha)}`);
      if (typeof commit?.tree?.sha !== "string" || !commit.tree.sha) throw new MalformedGateProofError("run tree unavailable");
      commits.set(run.head_sha, commit.tree.sha);
    }
    return commits.get(run.head_sha);
  };
  const jobsOf = async run => {
    const jobs = page(await read(`actions/runs/${run.id}/jobs?per_page=100`), "jobs");
    if (jobs.rows.some(job => !job || typeof job.name !== "string" || !job.name
      || job.steps !== undefined && (!Array.isArray(job.steps) || job.steps.some(step => !step || typeof step.name !== "string")))) {
      throw new MalformedGateProofError("run jobs malformed");
    }
    return jobs;
  };
  const gateJob = name => FULL_GATES.includes(name) || /^seeded-shard(?: \([1-4]\))?$/.test(name);
  try {
    let successful;
    try { successful = page(await read("actions/workflows/check.yml/runs?status=success&per_page=100"), "workflow_runs"); }
    catch (error) { if (!lostProofError(error)) throw error; }
    // Lost success inventory or one lost candidate is absence of reuse proof, never permission to skip active coverage.
    // Older successes outside this bounded page can cause redundant work, never a false green or duplicate admission.
    for (const run of successful?.rows ?? []) {
      try {
        if (!run || !Number.isSafeInteger(run.id) || run.id < 1 || sameRun(run.id, currentRunId)
          || run.conclusion !== "success" || !["pull_request", "push"].includes(run.event)) continue;
        if (await treeOf(run) !== tree) continue;
        const jobs = await jobsOf(run);
        const normalized = { ...run, tree, status: "completed", scope: "full", jobs: jobs.rows, jobsComplete: jobs.complete };
        if (successfulFullGate(normalized)) return { kind: "reuse", run: normalized };
      } catch (error) { if (!lostProofError(error)) throw error; }
    }
    let complete = true;
    const visited = new Set();
    // A queued/waiting controller has started no job, so it cannot have admitted gate jobs and needs no API read.
    // Gate jobs queued for a runner after decision admission are under an in_progress workflow instead.
    for (const status of ["in_progress"]) {
      const active = page(await read(`actions/workflows/check.yml/runs?status=${status}&per_page=100`), "workflow_runs");
      complete &&= active.complete;
      if (!active.complete) throw new Error("active gate inventory incomplete");
      for (const run of active.rows) {
        if (sameRun(run.id, currentRunId) || visited.has(run.id)) continue;
        visited.add(run.id);
        if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error("run identity unavailable");
        const jobs = await jobsOf(run);
        if (!jobs.complete) throw new Error("active gate jobs incomplete");
        const gates = jobs.rows.filter(job => gateJob(job.name));
        const decisionDone = jobs.rows.some(job => job.name === "decision" && job.status === "completed" && job.conclusion === "success");
        const launched = gates.some(job => job.status === "in_progress" || decisionDone && job.status === "queued");
        const other = jobs.complete && (jobs.rows.some(job => ["macos-timing", "prepare-bundle"].includes(job.name) && job.status !== "completed")
          || !launched && (status !== "in_progress" || jobs.rows.length > 0 && jobs.rows.every(job => job.name === "decision" || job.status === "completed")));
        // A controller that launched no full-gate job (decision still running, or no gate) admits nothing yet.
        if (other) continue;
        const candidateTree = await treeOf(run);
        evidence.push({ ...run, tree: candidateTree, status, scope: launched ? "full" : "unknown", jobs: jobs.rows, jobsComplete: jobs.complete });
      }
    }
    return fullGateAdmission(tree, evidence, { currentRunId, complete });
  } catch {
    return { kind: "unknown", reason: "GitHub full-gate evidence unavailable or incomplete" };
  }
}
