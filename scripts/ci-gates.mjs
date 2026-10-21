export const REUSE_MARKER = "Reuse verified identical-tree full gate";
const reusedJob = job => Array.isArray(job.steps) && job.steps.some(step => step.name === REUSE_MARKER && step.conclusion === "success");

const FULL_GATES = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
class GateReadLimitError extends Error {}
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
export async function readFullGateAdmission(api, tree, { currentRunId, deadline = Date.now() + 60_000, now = Date.now } = {}) {
  const evidence = [], commits = new Map();
  let requests = 0;
  const checkDeadline = () => {
    const at = now();
    if (!Number.isFinite(deadline) || !Number.isFinite(at) || at >= deadline) throw new GateReadLimitError("gate read deadline exhausted");
  };
  const read = async path => {
    checkDeadline();
    if (requests >= 240) throw new GateReadLimitError("gate read budget exhausted");
    requests++;
    try { return await api(path); }
    finally { checkDeadline(); } // A failed or late successful request cannot turn global exhaustion into lost proof.
  };
  const page = (value, key) => {
    if (!value || !Array.isArray(value[key]) || value[key].length > 100 || !Number.isSafeInteger(value.total_count) || value.total_count < value[key].length) throw new Error("gate page unavailable");
    return { rows: value[key], complete: value.total_count === value[key].length };
  };
  const treeOf = async run => {
    if (typeof run.head_sha !== "string" || !run.head_sha) throw new Error("run commit unavailable");
    if (!commits.has(run.head_sha)) {
      const commit = await read(`git/commits/${encodeURIComponent(run.head_sha)}`);
      if (typeof commit?.tree?.sha !== "string" || !commit.tree.sha) throw new Error("run tree unavailable");
      commits.set(run.head_sha, commit.tree.sha);
    }
    return commits.get(run.head_sha);
  };
  const jobsOf = async run => page(await read(`actions/runs/${run.id}/jobs?per_page=100`), "jobs");
  const gateJob = name => FULL_GATES.includes(name) || /^seeded-shard(?: \([1-4]\))?$/.test(name);
  try {
    let successful;
    try { successful = page(await read("actions/workflows/check.yml/runs?status=success&per_page=100"), "workflow_runs"); }
    catch (error) { if (error instanceof GateReadLimitError) throw error; }
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
      } catch (error) { if (error instanceof GateReadLimitError) throw error; }
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
