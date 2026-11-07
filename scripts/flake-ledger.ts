// #1257 item 3: the weekly flake ledger. It reads the Actions runs API for check.yml and lists the gate jobs that failed and then passed on the same head SHA, per test
// file and failing test name (the `(fail)` lines of the failed job's log), split into macOS-only, Ubuntu-only and both-OS classes. It writes one tracking issue (created once,
// then edited, never one issue per run). Everything it reads is bounded: run pages, runs examined, logs fetched and bytes per log. The aggregation is pure (test/flake-ledger.test.ts).
// Usage: bun scripts/flake-ledger.ts [--repo owner/name] [--days 28] [--dry-run]   (token: GITHUB_TOKEN or GH_TOKEN, or `gh auth token`)
import { GitHubApi, githubToken } from "./lib/github-api.ts";

export const LEDGER_TITLE = "CI flake ledger (check.yml)";
export const LEDGER_MARKER = "<!-- agent-hub:flake-ledger -->";
export const LOOKBACK_DAYS = 28;
export const MAX_RUN_PAGES = 5;
export const MAX_RUNS_EXAMINED = 60;
export const MAX_LOGS = 40;
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_SEARCH_RESULTS = 20;
/** GitHub refuses an issue body past 65536 characters. */
export const MAX_BODY_CHARS = 60_000;
export const TOP_CLASSES = 3;
const UNATTRIBUTED_FILE = "(no test file in the log)";

export interface RunRecord { id: number; runAttempt: number; headSha: string; event: string; conclusion: string | null; createdAt: string }
export interface JobRecord { id: number; runId: number; runAttempt: number; name: string; headSha: string; conclusion: string | null; completedAt: string | null }
export interface FailedTest { file: string; test: string }
export type FlakeOs = "macos-only" | "ubuntu-only" | "both";
export interface FlakeClass { file: string; test: string; os: FlakeOs; heads: string[]; jobs: string[] }
export interface IssueItem { number: number; title: string; body: string | null; state: string; pull_request?: unknown }
export interface LedgerMeta { repo: string; days: number; generatedAt: string; runsExamined: number; flakyJobs: number; truncated: boolean }

const ANSI = /\x1b\[[0-9;]*m/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const GROUP = /^##\[group\](test\/\S+\.test\.ts):$/;
const FAILED_SUMMARY = /^\d+ tests? failed:$/;
const FAIL = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;

/**
 * The failing tests of one job log: `(fail) name [N ms]` under the `##[group]test/x.test.ts:` header it ran in. Bun prints every failure again in a summary after
 * `N tests failed:`, which carries no file, so nothing after that line counts. A name is counted once per file.
 */
export function parseFailures(log: string): FailedTest[] {
  const seen = new Set<string>();
  const out: FailedTest[] = [];
  let file = UNATTRIBUTED_FILE;
  for (const raw of log.replace(ANSI, "").split("\n")) {
    const line = raw.replace(STAMP, "").trimEnd();
    if (FAILED_SUMMARY.test(line)) break;
    const group = GROUP.exec(line);
    if (group) { file = group[1]!; continue; }
    const fail = FAIL.exec(line);
    if (!fail) continue;
    const key = `${file}\u0000${fail[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, test: fail[1]! });
  }
  return out;
}

/** The OS a gate shard job runs on, or undefined for any other job (an aggregator, the decision, a skipped leg): only shards carry a test. */
export function shardOs(name: string): "macos" | "ubuntu" | undefined {
  const match = /^check \((ubuntu|macos)-latest\) shard \d+\/\d+$/.exec(name);
  if (match) return match[1] as "macos" | "ubuntu";
  return /^seeded guards \(\d+\/\d+\)$/.test(name) ? "ubuntu" : undefined;
}

/** A job that failed and was followed by a success of the same job name on the same head SHA: the failed instances, by head. */
export function flakyJobs(jobs: readonly JobRecord[]): JobRecord[] {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    if (!shardOs(job.name) || !job.completedAt || (job.conclusion !== "failure" && job.conclusion !== "success")) continue;
    const key = `${job.headSha}\u0000${job.name}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const flaky: JobRecord[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!) || a.id - b.id);
    const lastSuccess = group.map((job) => job.conclusion).lastIndexOf("success");
    if (lastSuccess < 0) continue;
    flaky.push(...group.slice(0, lastSuccess).filter((job) => job.conclusion === "failure"));
  }
  return flaky.sort((a, b) => a.id - b.id);
}

/**
 * The flake classes: one per failing test (file and name) across the flaky job instances. `jobs` are the instances `flakyJobs` returned, `failures` the parsed log of each by job id
 * (a missing or unreadable log, or a log with no `(fail)` line such as a hang, becomes one class for that job name, never silence). A class is macOS-only or Ubuntu-only when every
 * instance ran on that OS, else both. Most distinct head SHAs first, then both-OS, then macOS-only, then file and name.
 */
export function aggregateFlakes(jobs: readonly JobRecord[], failures: ReadonlyMap<number, readonly FailedTest[]>): FlakeClass[] {
  const classes = new Map<string, { file: string; test: string; os: Set<"macos" | "ubuntu">; heads: Set<string>; jobs: Set<string> }>();
  for (const job of jobs) {
    const os = shardOs(job.name);
    if (!os) continue;
    const found = failures.get(job.id) ?? [];
    const tests = found.length ? found : [{ file: UNATTRIBUTED_FILE, test: `no (fail) line in ${job.name}` }];
    for (const { file, test } of tests) {
      const key = `${file}\u0000${test}`;
      const entry = classes.get(key) ?? { file, test, os: new Set(), heads: new Set(), jobs: new Set() };
      entry.os.add(os);
      entry.heads.add(job.headSha);
      entry.jobs.add(job.name);
      classes.set(key, entry);
    }
  }
  const rank: Record<FlakeOs, number> = { both: 0, "macos-only": 1, "ubuntu-only": 2 };
  return [...classes.values()]
    .map((entry): FlakeClass => ({ file: entry.file, test: entry.test, os: entry.os.size === 2 ? "both" : entry.os.has("macos") ? "macos-only" : "ubuntu-only", heads: [...entry.heads].sort(), jobs: [...entry.jobs].sort() }))
    .sort((a, b) => b.heads.length - a.heads.length || rank[a.os] - rank[b.os] || a.file.localeCompare(b.file) || a.test.localeCompare(b.test));
}

/**
 * The runs worth reading jobs for, as whole head groups: a head qualifies when one of its runs is a rerun (attempt above 1) or when it has both a failed and a successful run (a
 * failure and its pass in separate runs of one SHA, such as a reopened PR or a dispatch). Every failed or successful run of a qualifying head is kept, so `flakyJobs` sees both sides.
 * Newest group first; the runs of all groups together count toward `limit`.
 */
export function candidateRuns(runs: readonly RunRecord[], limit = MAX_RUNS_EXAMINED): RunRecord[] {
  const byHead = new Map<string, RunRecord[]>();
  for (const run of runs) if (run.conclusion === "failure" || run.conclusion === "success") byHead.set(run.headSha, [...(byHead.get(run.headSha) ?? []), run]);
  const newest = (a: RunRecord, b: RunRecord) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id;
  return [...byHead.values()]
    .filter((group) => group.some((run) => run.runAttempt > 1) || (group.some((run) => run.conclusion === "failure") && group.some((run) => run.conclusion === "success")))
    .map((group) => group.sort(newest))
    .sort((a, b) => newest(a[0]!, b[0]!))
    .flat()
    .slice(0, limit);
}

export interface FileRollup { file: string; os: FlakeOs; heads: number; tests: number }

/** The classes rolled up by test file (one broken file fails many tests at once): distinct heads first, then the number of failing tests. */
export function rollupByFile(classes: readonly FlakeClass[]): FileRollup[] {
  const files = new Map<string, { heads: Set<string>; os: Set<FlakeOs>; tests: number }>();
  for (const c of classes) {
    const entry = files.get(c.file) ?? { heads: new Set<string>(), os: new Set<FlakeOs>(), tests: 0 };
    for (const head of c.heads) entry.heads.add(head);
    entry.os.add(c.os);
    entry.tests++;
    files.set(c.file, entry);
  }
  return [...files.entries()]
    .map(([file, e]): FileRollup => ({ file, os: e.os.size === 1 ? [...e.os][0]! : "both", heads: e.heads.size, tests: e.tests }))
    .sort((a, b) => b.heads - a.heads || b.tests - a.tests || a.file.localeCompare(b.file));
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 160);
/** Text from a test name is PR-head code (a fork's too): in a code span, so an `@user` or `#123` in it neither pings nor links. A backtick would end the span, so it becomes an apostrophe. */
const code = (text: string) => `\`${cell(text).replace(/`/g, "'")}\``;

/** The issue body: a marker, the window, the top classes, then every class by OS split. Cut at `MAX_BODY_CHARS` with a note. */
export function renderLedger(classes: readonly FlakeClass[], meta: LedgerMeta, top = TOP_CLASSES): string {
  const lines = [
    LEDGER_MARKER,
    `Generated by \`bun scripts/flake-ledger.ts\` (weekly workflow \`flake-ledger\`, #1257). Window: the last ${meta.days} days of \`check.yml\` runs in ${meta.repo}, read at ${meta.generatedAt}.`,
    "",
    `A flake here is a gate shard job that failed and then passed on the same head SHA. ${meta.flakyJobs} such failed job${meta.flakyJobs === 1 ? "" : "s"} in ${meta.runsExamined} examined run${meta.runsExamined === 1 ? "" : "s"}${meta.truncated ? " (the read bounds cut the window short)" : ""}.`,
    "",
  ];
  if (!classes.length) lines.push("No flaky job in the window.", "");
  else {
    lines.push(`## Top ${Math.min(top, rollupByFile(classes).length)} files`, "", ...rollupByFile(classes).slice(0, top).map((r, i) => `${i + 1}. ${code(r.file)} (${r.os}, ${r.heads} head${r.heads === 1 ? "" : "s"}, ${r.tests} failing test${r.tests === 1 ? "" : "s"})`), "");
    for (const [os, title] of [["macos-only", "macOS only"], ["both", "Both OSes"], ["ubuntu-only", "Ubuntu only"]] as const) {
      const rows = classes.filter((c) => c.os === os);
      if (!rows.length) continue;
      lines.push(`## ${title}`, "", "| File | Test | Heads | Jobs |", "| --- | --- | ---: | --- |", ...rows.map((c) => `| ${code(c.file)} | ${code(c.test)} | ${c.heads.length} | ${cell(c.jobs.join(", "))} |`), "");
    }
  }
  lines.push("Each class needs an owner and a deadline: a fix, or a quarantine with its issue (rerun policy: docs/agent-notes/tests.md).", "");
  const body = lines.join("\n");
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS)}\n\n(cut: the ledger is longer than an issue body may be; the top entries above are complete)\n`;
}

/** The tracking issue: the lowest-numbered issue (not a pull request) that carries the marker in its body and the exact title. An open one wins over a closed one. */
export function pickTrackingIssue(items: readonly IssueItem[]): IssueItem | undefined {
  return items
    .filter((item) => !item.pull_request && item.title === LEDGER_TITLE && (item.body ?? "").includes(LEDGER_MARKER))
    .sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open") || a.number - b.number)[0];
}

interface RunsPage { workflow_runs: { id: number; run_attempt: number; head_sha: string; event: string; conclusion: string | null; created_at: string }[] }
interface JobsPage { jobs: { id: number; run_id: number; run_attempt: number; name: string; head_sha: string; conclusion: string | null; completed_at: string | null }[] }

/** Reads the window from the API, within every bound. */
export async function collect(api: GitHubApi, now: Date, days = LOOKBACK_DAYS): Promise<{ flaky: JobRecord[]; failures: Map<number, FailedTest[]>; runsExamined: number; truncated: boolean }> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const runs: RunRecord[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const data = await api.json<RunsPage>(`/repos/${api.repo}/actions/workflows/check.yml/runs?per_page=100&page=${page}&status=completed&created=%3E%3D${since}`);
    runs.push(...data.workflow_runs.map((run) => ({ id: run.id, runAttempt: run.run_attempt, headSha: run.head_sha, event: run.event, conclusion: run.conclusion, createdAt: run.created_at })));
    if (data.workflow_runs.length < 100) break;
    if (page === MAX_RUN_PAGES) truncated = true;
  }
  const candidates = candidateRuns(runs);
  if (candidateRuns(runs, Number.POSITIVE_INFINITY).length > candidates.length) truncated = true; // only the run bound cuts candidates; a failed run whose head never passed is not one
  const jobs: JobRecord[] = [];
  for (const run of candidates) {
    for (let page = 1; page <= 2; page++) {
      const data = await api.json<JobsPage>(`/repos/${api.repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=${page}`);
      jobs.push(...data.jobs.map((job) => ({ id: job.id, runId: job.run_id, runAttempt: job.run_attempt, name: job.name, headSha: job.head_sha, conclusion: job.conclusion, completedAt: job.completed_at })));
      if (data.jobs.length < 100) break;
    }
  }
  // Same-SHA matching spans runs (a closed and reopened PR, a dispatch), so it runs over everything read.
  const flaky = flakyJobs(jobs);
  const failures = new Map<number, FailedTest[]>();
  for (const job of flaky.slice(0, MAX_LOGS)) failures.set(job.id, parseFailures(await api.log(job.id, MAX_LOG_BYTES).catch(() => "")));
  if (flaky.length > MAX_LOGS) truncated = true;
  return { flaky, failures, runsExamined: candidates.length, truncated };
}

/**
 * The tracking issue is found by search (the title in the query, then `pickTrackingIssue`'s exact title and body marker), never by paging the repository's issues: a listing is bounded
 * and includes pull requests, so a repository past that bound would not show the issue and every weekly run would open another one. The search index lags a new issue by seconds,
 * which a weekly run never meets.
 */
export async function upsertIssue(api: GitHubApi, body: string): Promise<{ number: number; created: boolean }> {
  const query = encodeURIComponent(`repo:${api.repo} is:issue in:title "${LEDGER_TITLE}"`);
  const found = await api.json<{ items?: IssueItem[] }>(`/search/issues?q=${query}&per_page=${MAX_SEARCH_RESULTS}&sort=created&order=asc`);
  const existing = pickTrackingIssue(found.items ?? []);
  if (existing) {
    await api.json(`/repos/${api.repo}/issues/${existing.number}`, { method: "PATCH", body: { body, state: "open" } });
    return { number: existing.number, created: false };
  }
  const created = await api.json<{ number: number }>(`/repos/${api.repo}/issues`, { method: "POST", body: { title: LEDGER_TITLE, body } });
  return { number: created.number, created: true };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
  const repo = option("--repo") ?? process.env.GITHUB_REPOSITORY;
  const days = Number(option("--days") ?? LOOKBACK_DAYS);
  const dry = args.includes("--dry-run");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(days) || days < 1 || days > 90) {
    console.error("usage: bun scripts/flake-ledger.ts [--repo owner/name] [--days 1-90] [--dry-run]  (GITHUB_REPOSITORY names the repo when --repo is absent)");
    process.exit(2);
  }
  const token = githubToken();
  if (!token && !dry) { console.error("flake-ledger: no GITHUB_TOKEN or GH_TOKEN; set one with issues: write, or use --dry-run"); process.exit(2); }
  const api = new GitHubApi(repo, token);
  const now = new Date();
  const found = await collect(api, now, days);
  const classes = aggregateFlakes(found.flaky, found.failures);
  const body = renderLedger(classes, { repo, days, generatedAt: now.toISOString(), runsExamined: found.runsExamined, flakyJobs: found.flaky.length, truncated: found.truncated });
  if (dry) { console.log(body); process.exit(0); }
  const result = await upsertIssue(api, body);
  console.log(`flake-ledger: ${result.created ? "created" : "updated"} issue #${result.number} (${classes.length} classes, ${found.flaky.length} flaky jobs)`);
}
