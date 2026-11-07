// #1257 item 4: regenerate scripts/test-timings.json from one green main run of check.yml, and say whether a shard is over its budget.
// Usage: bun scripts/refresh-test-timings.ts [run id] [--check]
//   no run id: the newest completed, successful `push` run of check.yml on main whose four macOS shard jobs were timed (a reused gate has none).
//   --check: only report (shard times, the 25 % rule, the age of the weights file); write nothing. Exit 1 when a shard is over budget or the weights are older than 35 days.
// Cadence: monthly, or when a shard exceeds its budget by 25 % (docs/agent-notes/tests.md). Needs GITHUB_TOKEN or GH_TOKEN, or `gh auth token`.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GitHubApi, githubToken } from "./lib/github-api.ts";
import { BUDGET_SLACK, SHARD_BUDGET_MS, shardTimes, shardsOverBudget, timingsStale, type ShardJob } from "./lib/ci-shards.ts";
import { mergeTimings, timingsFromLog } from "./make-test-timings.ts";

const root = resolve(import.meta.dir, "..");
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const runArg = args.find((arg) => /^\d+$/.test(arg));
const repo = process.env.GITHUB_REPOSITORY ?? "STAIxBWLB/agent-hub";
const api = new GitHubApi(repo, githubToken());

interface RunsPage { workflow_runs: { id: number; head_sha: string }[] }
interface JobsPage { jobs: { id: number; name: string; conclusion: string | null; started_at: string | null; completed_at: string | null }[] }

async function jobsOf(runId: number): Promise<ShardJob[]> {
  const data = await api.json<JobsPage>(`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  return data.jobs.map((job) => ({ id: job.id, name: job.name, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at }));
}

let runId = runArg ? Number(runArg) : undefined;
let jobs: ShardJob[] = [];
if (runId) jobs = await jobsOf(runId);
else {
  const runs = await api.json<RunsPage>(`/repos/${repo}/actions/workflows/check.yml/runs?branch=main&event=push&status=success&per_page=20`);
  for (const run of runs.workflow_runs) {
    const found = await jobsOf(run.id);
    if (shardTimes(found).filter((time) => time.name.startsWith("check (macos-latest)")).length === 4) { runId = run.id; jobs = found; break; }
  }
}
if (!runId) { console.error("refresh-test-timings: no recent green main run with four timed macOS shards; name a run id"); process.exit(1); }

const times = shardTimes(jobs);
const macos = times.filter((time) => time.name.startsWith("check (macos-latest)"));
console.log(`run ${runId}: ${times.map((time) => `${time.name.replace("check ", "")} ${(time.ms / 60000).toFixed(1)} min`).join(", ")}`);
const over = shardsOverBudget(times);
console.log(over.length ? `over budget (${SHARD_BUDGET_MS / 60000} min + ${BUDGET_SLACK * 100} %): ${over.join(", ")}` : `no shard over ${(SHARD_BUDGET_MS * (1 + BUDGET_SLACK)) / 60000} min`);

const last = Bun.spawnSync(["git", "log", "-1", "--format=%cI", "--", "scripts/test-timings.json"], { cwd: root, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() || undefined;
const stale = timingsStale(last, new Date());
console.log(`scripts/test-timings.json last changed ${last ?? "unknown"}${stale ? " (older than 35 days: regenerate)" : ""}`);

if (checkOnly) process.exit(over.length || stale ? 1 : 0);
if (macos.length !== 4) { console.error(`refresh-test-timings: run ${runId} has ${macos.length} timed macOS shard jobs, need 4`); process.exit(1); }
const logs = [];
for (const shard of macos) {
  const rows = timingsFromLog(await api.log(shard.id, MAX_LOG_BYTES));
  if (!rows) { console.error(`refresh-test-timings: the log of ${shard.name} is not a bun test leg log (expired, or cut at ${MAX_LOG_BYTES} bytes)`); process.exit(1); }
  logs.push(rows);
}
const files = mergeTimings(logs, (file) => existsSync(resolve(root, file)));
await Bun.write(resolve(root, "scripts/test-timings.json"), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
console.log(`wrote scripts/test-timings.json: ${Object.keys(files).length} files from ${logs.length} shard logs. Review the diff, then commit it in its own PR.`);
