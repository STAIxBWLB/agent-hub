import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GitHubApi } from "../scripts/lib/github-api.ts";
import { BUDGET_SLACK, SHARD_BUDGET_MS, shardTimes, shardsOverBudget, timingsStale, type ShardJob } from "../scripts/lib/ci-shards.ts";
import {
  LEDGER_MARKER, LEDGER_TITLE, aggregateFlakes, candidateRuns, flakyJobs, parseFailures, pickTrackingIssue, renderLedger, rollupByFile, upsertIssue,
  type FailedTest, type JobRecord, type RunRecord,
} from "../scripts/flake-ledger.ts";

// #1257 item 3: the ledger's decisions are pure, so a fixture of job records and logs covers them; the API client is driven through an injected fetch.
let nextId = 1;
const job = (name: string, headSha: string, conclusion: "success" | "failure", at: string, extra: Partial<JobRecord> = {}): JobRecord =>
  ({ id: nextId++, runId: 1, runAttempt: 1, name, headSha, conclusion, completedAt: `2026-11-0${at}:00:00Z`, ...extra });
const MAC1 = "check (macos-latest) shard 1/4", MAC4 = "check (macos-latest) shard 4/4", UBU2 = "check (ubuntu-latest) shard 2/4";

test("#1257 parseFailures reads (fail) lines under their file header, once, and ignores the summary", () => {
  const log = [
    "2026-11-06T02:46:35.6703070Z ##[group]test/a.test.ts:",
    "2026-11-06T02:46:35.6703070Z (pass) fine [1.00ms]",
    "2026-11-06T02:46:36.5760860Z (fail) first broken [4.29ms]",
    "2026-11-06T02:46:36.5760860Z (fail) first broken [4.29ms]",
    "2026-11-06T02:46:36.5760860Z \u001b[31m(fail) \u001b[0msecond broken [1.2s]",
    "##[endgroup]",
    "2026-11-06T02:46:37.0Z ##[group]test/b.test.ts:",
    "2026-11-06T02:46:37.1Z (fail) first broken",
    "2026-11-06T02:49:43.0Z 2 tests failed:",
    "2026-11-06T02:49:43.1Z (fail) summary copy [4.29ms]",
  ].join("\n");
  expect(parseFailures(log)).toEqual([
    { file: "test/a.test.ts", test: "first broken" },
    { file: "test/a.test.ts", test: "second broken" },
    { file: "test/b.test.ts", test: "first broken" },
  ]);
  expect(parseFailures("nothing here")).toEqual([]);
  expect(parseFailures("(fail) before any header")[0]?.file).toBe("(no test file in the log)");
});

test("#1257 flakyJobs keeps a failed job only when the same job name later passed on the same head", () => {
  const failedThenPassed = [job(MAC1, "aaa", "failure", "1T01"), job(MAC1, "aaa", "success", "1T02")];
  const neverPassed = [job(MAC1, "bbb", "failure", "1T01"), job(MAC1, "bbb", "failure", "1T02")];
  const otherHead = [job(MAC1, "ccc", "failure", "1T01"), job(MAC1, "ddd", "success", "1T02")];
  const passedThenFailed = [job(MAC1, "eee", "success", "1T01"), job(MAC1, "eee", "failure", "1T02")];
  const otherShard = [job(MAC1, "fff", "failure", "1T01"), job(MAC4, "fff", "success", "1T02")];
  const aggregator = [job("check (macos-latest)", "ggg", "failure", "1T01"), job("check (macos-latest)", "ggg", "success", "1T02")];
  const skipped = [job(MAC1, "hhh", "failure", "1T01"), { ...job(MAC1, "hhh", "success", "1T02"), conclusion: null }];
  const flaky = flakyJobs([...failedThenPassed, ...neverPassed, ...otherHead, ...passedThenFailed, ...otherShard, ...aggregator, ...skipped]);
  expect(flaky.map((j) => j.id)).toEqual([failedThenPassed[0]!.id]);
  // a second failure before the pass is two failed instances of one flake
  const twice = [job(UBU2, "iii", "failure", "1T01"), job(UBU2, "iii", "failure", "1T02"), job(UBU2, "iii", "success", "1T03")];
  expect(flakyJobs(twice)).toHaveLength(2);
});

test("#1257 aggregateFlakes splits macOS-only, Ubuntu-only and both, ranks by distinct heads, and never goes silent on a job with no (fail) line", () => {
  const a = job(MAC1, "h1", "failure", "1T01"), b = job(MAC1, "h2", "failure", "1T02"), c = job(UBU2, "h3", "failure", "1T03"), d = job(MAC4, "h4", "failure", "1T04"), e = job(UBU2, "h2", "failure", "1T05");
  const f = (file: string, test: string): FailedTest => ({ file, test });
  const failures = new Map<number, FailedTest[]>([
    [a.id, [f("test/x.test.ts", "mac flake"), f("test/both.test.ts", "shared")]],
    [b.id, [f("test/x.test.ts", "mac flake")]],
    [c.id, [f("test/both.test.ts", "shared"), f("test/ubu.test.ts", "linux flake")]],
    [d.id, []],
  ]);
  const classes = aggregateFlakes([a, b, c, d, e], failures);
  const byTest = (test: string) => classes.find((x) => x.test === test)!;
  expect(byTest("mac flake")).toMatchObject({ os: "macos-only", heads: ["h1", "h2"] });
  expect(byTest("shared")).toMatchObject({ os: "both", heads: ["h1", "h3"] });
  expect(byTest("linux flake")).toMatchObject({ os: "ubuntu-only", heads: ["h3"] });
  expect(classes.some((x) => x.test.includes(`no (fail) line in ${MAC4}`) && x.os === "macos-only")).toBe(true);
  expect(classes.some((x) => x.test.includes(`no (fail) line in ${UBU2}`))).toBe(true); // e has no parsed failures either
  expect(classes[0]!.heads.length).toBeGreaterThanOrEqual(classes.at(-1)!.heads.length);
  expect(classes.slice(0, 2).map((x) => x.os)).toContain("both");
  expect(aggregateFlakes([], new Map())).toEqual([]);
});

test("#1257 rollupByFile ranks a file by distinct heads then failing tests, so one broken file is one entry", () => {
  const cls = (file: string, test: string, heads: string[], os: "macos-only" | "both" = "macos-only") => ({ file, test, os, heads, jobs: [] });
  const rows = rollupByFile([cls("a.ts", "1", ["h1", "h2"]), cls("a.ts", "2", ["h2"]), cls("b.ts", "1", ["h1", "h2"]), cls("b.ts", "2", ["h1"], "both"), cls("c.ts", "1", ["h9"])]);
  expect(rows.map((r) => [r.file, r.heads, r.tests, r.os])).toEqual([["a.ts", 2, 2, "macos-only"], ["b.ts", 2, 2, "both"], ["c.ts", 1, 1, "macos-only"]]); // a tie on heads and tests falls to the file name
});

test("#1257 candidateRuns keeps reruns and failed runs whose head also passed, newest first, bounded", () => {
  const run = (id: number, headSha: string, conclusion: string, runAttempt = 1, day = 1): RunRecord => ({ id, runAttempt, headSha, event: "pull_request", conclusion, createdAt: `2026-11-0${day}T00:00:00Z` });
  const runs = [run(1, "a", "failure", 1, 1), run(2, "a", "success", 1, 2), run(3, "b", "failure", 1, 3), run(4, "c", "success", 2, 4), run(5, "d", "success", 1, 5)];
  expect(candidateRuns(runs).map((r) => r.id)).toEqual([4, 1]);
  expect(candidateRuns(runs, 1).map((r) => r.id)).toEqual([4]);
});

test("#1257 renderLedger carries the marker, the top files, the OS split and a cut at the body limit", () => {
  const classes = aggregateFlakes([job(MAC1, "h1", "failure", "1T01")], new Map([[nextId - 1, [{ file: "test/x.test.ts", test: "pipe | name\nline" }]]]));
  const meta = { repo: "o/r", days: 28, generatedAt: "2026-11-07T00:00:00Z", runsExamined: 3, flakyJobs: 1, truncated: false };
  const body = renderLedger(classes, meta);
  expect(body.startsWith(LEDGER_MARKER)).toBe(true);
  expect(body).toContain("## Top 1 files");
  expect(body).toContain("## macOS only");
  expect(body).toContain("pipe \\| name line");
  expect(body).not.toContain("## Both OSes");
  expect(renderLedger([], meta)).toContain("No flaky job in the window.");
  const many = Array.from({ length: 2000 }, (_, i) => ({ file: `test/f${i}.test.ts`, test: "t".repeat(150), os: "both" as const, heads: ["h"], jobs: ["check (macos-latest) shard 1/4", "check (ubuntu-latest) shard 1/4"] }));
  const cut = renderLedger(many, { ...meta, truncated: true });
  expect(cut.length).toBeLessThan(61_000);
  expect(cut).toContain("(cut:");
});

test("#1257 pickTrackingIssue finds the one marked ledger issue, never a pull request, an unmarked twin or another title", () => {
  const item = (number: number, extra: object = {}) => ({ number, title: LEDGER_TITLE, body: `${LEDGER_MARKER}\nx`, state: "open", ...extra });
  expect(pickTrackingIssue([])).toBeUndefined();
  expect(pickTrackingIssue([item(9, { pull_request: {} }), item(8, { body: "no marker" }), item(7, { title: "other" })])).toBeUndefined();
  expect(pickTrackingIssue([item(12), item(5, { state: "closed" }), item(6)])?.number).toBe(6);
  expect(pickTrackingIssue([item(5, { state: "closed" })])?.number).toBe(5);
});

function fakeFetch(handlers: Record<string, (init: RequestInit | undefined) => unknown>, calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    calls.push(key);
    const handler = handlers[key];
    if (!handler) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(handler(init)), { status: 200 });
  }) as typeof fetch;
}

test("#1257 upsertIssue finds the ledger issue by search even when the repository has far more issues than any listing shows, and never opens a second", async () => {
  const calls: string[] = [];
  const urls: string[] = [];
  let existing: object[] = [];
  const handlers = {
    // The old version paged this listing (the 500 oldest items, pull requests included) and so never saw an issue created after #1259; it must not be read at all.
    "GET /repos/o/r/issues": () => Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "unrelated", body: "", state: "open" })),
    "GET /search/issues": () => ({ items: existing }),
    "POST /repos/o/r/issues": (init: RequestInit | undefined) => { const made = { number: 4242, ...JSON.parse(String(init!.body)), state: "open" }; existing = [made]; return made; },
    "PATCH /repos/o/r/issues/4242": () => ({}),
  };
  const spy = fakeFetch(handlers, calls);
  const api = new GitHubApi("o/r", "token", (async (url: string | URL | Request, init?: RequestInit) => { urls.push(String(url)); return spy(url, init); }) as typeof fetch);
  expect(await upsertIssue(api, `${LEDGER_MARKER}\nfirst`)).toEqual({ number: 4242, created: true });
  expect(await upsertIssue(api, `${LEDGER_MARKER}\nsecond`)).toEqual({ number: 4242, created: false });
  expect(await upsertIssue(api, `${LEDGER_MARKER}\nthird`)).toEqual({ number: 4242, created: false });
  expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(2);
  expect(calls.some((c) => c === "GET /repos/o/r/issues")).toBe(false);
  expect(decodeURIComponent(urls[0]!)).toContain(`repo:o/r is:issue in:title "${LEDGER_TITLE}"`);
  // a search hit that is a twin (no marker) or a pull request is not the ledger issue: a new one is created
  existing = [{ number: 7, title: LEDGER_TITLE, body: "no marker", state: "open" }, { number: 8, title: LEDGER_TITLE, body: LEDGER_MARKER, state: "open", pull_request: {} }];
  expect((await upsertIssue(api, `${LEDGER_MARKER}\nfourth`)).created).toBe(true);
});

test("#1257 test names reach the issue body inside code spans, so @mentions and #links in PR-head test names do not ping or link", () => {
  const evil = "ping @someone and link #123 `tick` | pipe";
  const classes = aggregateFlakes([job(MAC1, "h1", "failure", "1T01")], new Map([[nextId - 1, [{ file: "test/x.test.ts", test: evil }]]]));
  const body = renderLedger(classes, { repo: "o/r", days: 28, generatedAt: "2026-11-07T00:00:00Z", runsExamined: 1, flakyJobs: 1, truncated: false });
  const row = body.split("\n").find((line) => line.startsWith("| `test/x.test.ts`"))!;
  expect(row).toContain("`ping @someone and link #123 'tick' \\| pipe`");
  expect(body.replace(/`[^`]*`/g, "")).not.toMatch(/@someone|#123/);
});


test("#1257 GitHubApi.log stops reading at the byte bound, treats an expired log as empty and never prints the token", async () => {
  const chunk = "x".repeat(1000);
  let pulled = 0;
  const big = (async () => new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode(chunk)); if (pulled > 10_000) controller.close(); } }), { status: 200 })) as unknown as typeof fetch;
  const text = await new GitHubApi("o/r", "secret-token", big).log(1, 5_000);
  expect(text.length).toBeLessThan(20_000);
  expect(pulled).toBeLessThan(100);
  const gone = (async () => new Response("", { status: 410 })) as unknown as typeof fetch;
  expect(await new GitHubApi("o/r", "secret-token", gone).log(1, 100)).toBe("");
  // the logs endpoint's redirect goes to a signed blob URL: it is followed by hand, and the token goes to the API host only
  const hops: { url: string; auth: string | null }[] = [];
  const redirecting = (async (url: string | URL | Request, init?: RequestInit) => {
    hops.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return hops.length === 1 ? new Response(null, { status: 302, headers: { location: "https://blob.example/logs/1?sig=abc" } }) : new Response("log text", { status: 200 });
  }) as unknown as typeof fetch;
  expect(await new GitHubApi("o/r", "secret-token", redirecting).log(1, 1000)).toBe("log text");
  expect(hops.map((hop) => hop.url)).toEqual(["https://api.github.com/repos/o/r/actions/jobs/1/logs", "https://blob.example/logs/1?sig=abc"]);
  expect(hops[0]!.auth).toBe("Bearer secret-token");
  expect(hops[1]!.auth).toBeNull();
  const plain = (async () => new Response(null, { status: 302, headers: { location: "http://insecure.example/x" } })) as unknown as typeof fetch;
  await expect(new GitHubApi("o/r", "secret-token", plain).log(1, 10)).rejects.toThrow(/no https location/);
  const denied = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
  await expect(new GitHubApi("o/r", "secret-token", denied).json("/repos/o/r/issues?per_page=1")).rejects.toThrow(/403.*token's permissions/);
  await expect(new GitHubApi("o/r", "secret-token", denied).json("/x")).rejects.not.toThrow(/secret-token/);
});

test("#1257 the weekly workflow asks for contents: read and issues: write only, runs on a schedule, and creates no issue per run", () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/flake-ledger.yml", import.meta.url), "utf8")) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown }; permissions: Record<string, string>; jobs: Record<string, { permissions?: Record<string, string>; steps: { run?: string }[] }>;
  };
  expect(workflow.permissions).toEqual({ contents: "read", issues: "write", actions: "read" });
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.on.workflow_dispatch).toBeDefined();
  for (const j of Object.values(workflow.jobs)) expect(j.permissions).toBeUndefined();
  expect(Object.values(workflow.jobs).flatMap((j) => j.steps).some((s) => s.run?.includes("bun scripts/flake-ledger.ts"))).toBe(true);
});

const shardJob = (id: number, name: string, conclusion: string | null, start: string | null, end: string | null): ShardJob => ({ id, name, conclusion, startedAt: start, completedAt: end });

test("#1257 item 4: shardTimes keeps only timed, successful gate shards, and shardsOverBudget flags those 25 % above the budget", () => {
  const t0 = "2026-11-07T00:00:00Z";
  const at = (minutes: number) => new Date(Date.parse(t0) + minutes * 60_000).toISOString();
  const times = shardTimes([
    shardJob(1, "check (macos-latest) shard 1/4", "success", t0, at(12)),
    shardJob(2, "check (macos-latest) shard 2/4", "success", t0, at(19)),
    shardJob(3, "check (macos-latest) shard 3/4", "success", t0, at(18.76)),
    shardJob(4, "check (macos-latest) shard 4/4", "failure", t0, at(30)),
    shardJob(5, "check (macos-latest)", "success", t0, at(1)),
    shardJob(6, "check (ubuntu-latest) shard 1/4", "success", null, null),
    shardJob(7, "check (ubuntu-latest) shard 2/4", "skipped", t0, t0),
  ]);
  expect(times.map((t) => t.name)).toEqual(["check (macos-latest) shard 1/4", "check (macos-latest) shard 2/4", "check (macos-latest) shard 3/4"]);
  expect(SHARD_BUDGET_MS * (1 + BUDGET_SLACK)).toBe(18.75 * 60_000);
  expect(shardsOverBudget(times)).toEqual(["check (macos-latest) shard 2/4", "check (macos-latest) shard 3/4"]);
  expect(shardsOverBudget([{ name: "s", ms: 18.75 * 60_000 }])).toEqual([]);
});

test("#1257 item 4: timingsStale reads the monthly cadence and an unknown date as unknown", () => {
  const now = new Date("2026-11-07T00:00:00Z");
  expect(timingsStale("2026-10-20T00:00:00Z", now)).toBe(false);
  expect(timingsStale("2026-09-20T00:00:00Z", now)).toBe(true);
  expect(timingsStale(undefined, now)).toBeUndefined();
  expect(timingsStale("not a date", now)).toBeUndefined();
});
