export async function findVerifiedRun(api, tree) {
  const { workflow_runs: runs } = await api("actions/workflows/check.yml/runs?status=success&per_page=100");
  for (const run of runs) {
    if (run.conclusion !== "success" || !["pull_request", "push"].includes(run.event)) continue;
    const commit = await api(`git/commits/${run.head_sha}`);
    if (commit.tree.sha !== tree) continue;
    const { jobs } = await api(`actions/runs/${run.id}/jobs?per_page=100`);
    if (["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"].every(name => jobs.some(job => job.name === name && job.conclusion === "success"))) return run;
  }
}
