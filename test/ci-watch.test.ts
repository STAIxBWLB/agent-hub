import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { CiWatchers, pollCi, type CiOutcome, type CiPoll } from "../src/hub/ci-watch.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// #785 P1b: one bounded CI watcher per exact PR head, with a fake gh. Intervals are a few milliseconds; nothing here waits on a real runner.
const head = "a".repeat(40), newer = "b".repeat(40);
const NAMES = ["check (ubuntu-latest)", "check (macos-latest)", "seeded guards"];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await sleep(5); return condition(); };

class Recorder extends BasePeer {
  received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.received.push(...envs); }
}

function rig(mode: "advise" | "enforce", watch = { deadlineMs: 5000, pollMs: 10 }) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-ci-watch-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const state = { conclusion: "IN_PROGRESS" as string, prHead: head, prState: "OPEN", polls: 0 };
  const notices: string[] = [];
  const gh: SdlcGh = async args => {
    if (args[0] === "pr" && args.includes("headRefOid,state,statusCheckRollup,isDraft")) {
      state.polls++;
      return { code: 0, stdout: JSON.stringify({ headRefOid: state.prHead, state: state.prState, statusCheckRollup: NAMES.map(name => ({ name, status: state.conclusion === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED", conclusion: state.conclusion === "IN_PROGRESS" ? "" : state.conclusion })) }) };
    }
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: state.prHead, state: state.prState, statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: state.prHead, state: "OPEN",
      commits: { nodes: [{ commit: { oid: state.prHead, tree: { oid: "c".repeat(40) }, statusCheckRollup: { contexts: { nodes: NAMES.map(name => ({ name, status: state.conclusion === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED", conclusion: state.conclusion })), pageInfo: { hasNextPage: false } } } } }] },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) };
  };
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], director: ["conductor"] };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", routing: () => loadRouting(cwd), notify: text => notices.push(text), ciWatch: watch,
    sdlc: { config: () => sdlcConfig({ mode, required_checks: NAMES }), gh } });
  const task = board.propose("user", { title: "finished implementation", class: "implement" });
  board.update(task.id, "user", "accepted", { owner: "codex", reviewer: "claude", state: "in_progress", refs: { commit: head }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head, localHead: head, localResult: "passed" } });
  const owner = new Recorder("codex"), reviewer = new Recorder("claude");
  bus.add(owner); bus.add(reviewer);
  cleanup.push(() => { tasks.stopCiWatchers(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  const watchers = () => (tasks as unknown as { ciWatchers: CiWatchers }).ciWatchers;
  const ciNotices = (peer: Recorder) => peer.received.filter(env => env.body.startsWith("ci_completed:"));
  const reviews = () => reviewer.received.filter(env => env.kind === "review");
  return { tasks, board, bus, task, state, notices, owner, reviewer, watchers, ciNotices, reviews, start: async () => { await owner.start(); await reviewer.start(); } };
}

test("a done at a head whose CI is pending starts one watcher; green tells the owner and the reviewer once, and no gh read follows (#785 AC3, AC5)", async () => {
  const r = rig("advise"); await r.start();
  const done = await r.tasks.done("codex", r.task.id, "ready");
  expect(done.state).toBe("in_review");
  expect(r.watchers().size).toBe(1);
  await sleep(60);
  expect(r.ciNotices(r.owner)).toHaveLength(0); // still pending: nothing is told
  r.state.conclusion = "SUCCESS";
  expect(await until(() => r.ciNotices(r.owner).length === 1 && r.ciNotices(r.reviewer).length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[0]!.body).toContain(`ci_completed: #${r.task.id} head ${head.slice(0, 12)} passed`);
  expect(r.ciNotices(r.owner)[0]!.priority).toBe("status");
  expect(r.watchers().size).toBe(0);
  const polls = r.state.polls;
  await sleep(120);
  expect(r.state.polls).toBe(polls); // the watcher is gone: no periodic gh call
  expect(r.ciNotices(r.owner)).toHaveLength(1); expect(r.ciNotices(r.reviewer)).toHaveLength(1); // one notice per head
});

test("a failed CI is told once and does not re-offer a review (#785 AC3)", async () => {
  const r = rig("advise"); await r.start();
  await r.tasks.done("codex", r.task.id, "ready");
  r.state.conclusion = "FAILURE";
  expect(await until(() => r.ciNotices(r.owner).length === 1 && r.ciNotices(r.reviewer).length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[0]!.body).toContain("failed");
  expect(r.ciNotices(r.owner)[0]!.priority).toBe("status");
  await sleep(60);
  expect(r.ciNotices(r.owner)).toHaveLength(1); // still failed on later reads: not told again
  expect(r.watchers().size).toBe(1); // a failed head stays watched for a rerun (#540)
});

test("a failed CI, then a rerun of the same head going green: one failed notice, one passed notice and the held review re-offered (#540)", async () => {
  const r = rig("enforce"); await r.start();
  r.board.update(r.task.id, "codex", "done", { state: "in_review" });
  const task = r.board.get(r.task.id)!;
  expect((r.tasks as unknown as { sendReview(t: typeof task, reviewer: string, why: string): boolean }).sendReview(task, "claude", "")).toBe(false);
  r.state.conclusion = "FAILURE";
  expect(await until(() => r.ciNotices(r.owner).length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[0]!.body).toContain(`${head.slice(0, 12)} failed`);
  await sleep(60);
  expect(r.reviews()).toHaveLength(0); // a failed result re-offers nothing
  r.state.conclusion = "IN_PROGRESS"; // attempt 2 of the same head starts
  await sleep(40);
  r.state.conclusion = "SUCCESS";
  expect(await until(() => r.ciNotices(r.owner).length === 2 && r.reviews().length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[1]!.body).toContain(`${head.slice(0, 12)} passed`);
  expect(r.reviews()[0]!.body).toContain("it is green now");
  expect(r.watchers().size).toBe(0);
  await sleep(120);
  expect([r.ciNotices(r.owner).length, r.ciNotices(r.reviewer).length, r.reviews().length]).toEqual([2, 2, 1]);
});

test("a review the hub held as premature is re-offered once CI is green, once (#785 AC3)", async () => {
  const r = rig("enforce"); await r.start();
  r.board.update(r.task.id, "codex", "done", { state: "in_review" });
  const task = r.board.get(r.task.id)!;
  // What a background reviewer change does: a review request with no admission, which enforce holds.
  expect((r.tasks as unknown as { sendReview(t: typeof task, reviewer: string, why: string): boolean }).sendReview(task, "claude", "")).toBe(false);
  expect(r.reviews()).toHaveLength(0);
  expect(r.watchers().size).toBe(1);
  await sleep(60);
  expect(r.reviews()).toHaveLength(0); // CI still pending: still held
  r.state.conclusion = "SUCCESS";
  expect(await until(() => r.reviews().length === 1)).toBe(true);
  expect(r.reviews()[0]!.body).toContain("it is green now");
  await sleep(120);
  expect(r.reviews()).toHaveLength(1);
  expect(r.ciNotices(r.reviewer)).toHaveLength(1);
});

test("a newer head, a verdict and a cancellation each end the watcher without a notice (#785 AC5)", async () => {
  for (const move of ["newer head", "approved", "cancelled"] as const) {
    const r = rig("advise"); await r.start();
    await r.tasks.done("codex", r.task.id, "ready");
    expect(r.watchers().size).toBe(1);
    if (move === "newer head") r.board.update(r.task.id, "codex", "done", { refs: { commit: newer }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head: newer } });
    else if (move === "approved") await r.tasks.review("claude", r.task.id, "approved", "fine", undefined, head);
    else await r.tasks.cancel(r.task.id, "user", { reason: "dropped" });
    r.state.conclusion = "SUCCESS";
    await sleep(100);
    expect([move, r.watchers().size, r.ciNotices(r.owner).length, r.ciNotices(r.reviewer).length]).toEqual([move, 0, 0, 0]);
    const polls = r.state.polls;
    await sleep(60);
    expect(r.state.polls).toBe(polls);
  }
});

test("a done again at a newer head replaces the watcher: one watcher, and only the newer head is reported (#785 AC5)", async () => {
  const r = rig("advise"); await r.start();
  await r.tasks.done("codex", r.task.id, "ready");
  r.board.update(r.task.id, "claude", "changes_requested", { state: "changes_requested" });
  r.board.update(r.task.id, "codex", "accepted", { state: "in_progress", refs: { commit: newer }, sdlc: { stage: "build", repo: "o/r", issue: 1, pr: 1, head: newer, localHead: newer, localResult: "passed" } });
  r.state.prHead = newer;
  await r.tasks.done("codex", r.task.id, "again");
  expect(r.watchers().size).toBe(1);
  r.state.conclusion = "SUCCESS";
  expect(await until(() => r.ciNotices(r.owner).length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[0]!.body).toContain(newer.slice(0, 12));
  expect(r.ciNotices(r.owner).some(env => env.body.includes(head.slice(0, 12)))).toBe(false);
});

test("no watcher outlives its deadline: it stops reading and tells the console only (#785 AC5)", async () => {
  const r = rig("advise", { deadlineMs: 80, pollMs: 10 }); await r.start();
  await r.tasks.done("codex", r.task.id, "ready");
  expect(await until(() => r.watchers().size === 0)).toBe(true);
  expect(r.notices.join("\n")).toContain("CI did not finish within the watch deadline");
  expect(r.ciNotices(r.owner)).toHaveLength(0);
  const polls = r.state.polls;
  expect(polls).toBeGreaterThan(0);
  r.state.conclusion = "SUCCESS";
  await sleep(100);
  expect(r.state.polls).toBe(polls);
});

test("stopCiWatchers (daemon shutdown) ends every watcher; a green admission and a lifecycle that is off start none (#785 AC5)", async () => {
  const r = rig("advise"); await r.start();
  await r.tasks.done("codex", r.task.id, "ready");
  expect(r.watchers().size).toBe(1);
  r.tasks.stopCiWatchers();
  expect(r.watchers().size).toBe(0);
  const polls = r.state.polls;
  await sleep(60);
  expect(r.state.polls).toBe(polls);

  const green = rig("advise"); await green.start(); green.state.conclusion = "SUCCESS";
  await green.tasks.done("codex", green.task.id, "ready");
  expect(green.watchers().size).toBe(0); // admission was ready: nothing to wait for
  expect(green.reviews()).toHaveLength(1);

  const off = rig("advise"); await off.start();
  (off.tasks as unknown as { d: { sdlc: { config: () => ReturnType<typeof sdlcConfig> } } }).d.sdlc.config = () => sdlcConfig({ mode: "off" });
  await off.tasks.done("codex", off.task.id, "ready");
  expect(off.watchers().size).toBe(0);
  expect(off.state.polls).toBe(0);
});

test("pollCi reads one pr view and maps head, state and the required checks", async () => {
  const reply = (extra: object, rows = NAMES.map(name => ({ name, status: "COMPLETED", conclusion: "SUCCESS" }))) => async () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: rows, ...extra }) });
  const target = { repo: "o/r", pr: 1 };
  expect(await pollCi(target, head, NAMES, reply({}))).toBe("passed");
  expect(await pollCi(target, newer, NAMES, reply({}))).toBe("superseded");
  expect(await pollCi(target, head, NAMES, reply({ state: "MERGED" }))).toBe("closed");
  expect(await pollCi(target, head, NAMES, reply({}, NAMES.map((name, i) => ({ name, status: i ? "COMPLETED" : "IN_PROGRESS", conclusion: "SUCCESS" }))))).toBe("pending");
  expect(await pollCi(target, head, NAMES, reply({}, NAMES.slice(1).map(name => ({ name, status: "COMPLETED", conclusion: "SUCCESS" }))))).toBe("pending"); // a required check not reported yet
  expect(await pollCi(target, head, NAMES, reply({}, NAMES.map((name, i) => ({ name, status: "COMPLETED", conclusion: i ? "SUCCESS" : "FAILURE" }))))).toBe("failed");
  expect(await pollCi(target, head, NAMES, reply({}, NAMES.map((name, i) => ({ name, status: "COMPLETED", conclusion: i ? "SUCCESS" : "SKIPPED" }))))).toBe("incomplete");
  expect(await pollCi(target, head, NAMES, async () => ({ code: 1, stdout: "" }))).toBe("pending");
  expect(await pollCi(target, head, NAMES, async () => ({ code: 0, stdout: "not json" }))).toBe("pending");
  expect(await pollCi({ repo: "--bad", pr: 1 }, head, NAMES, reply({}))).toBe("closed");
});

test("CiWatchers: one watcher per head, a settled head never starts again, a different head replaces", async () => {
  const finished: string[] = [];
  const w = new CiWatchers({ deadlineMs: 5000, pollMs: 5, poll: async () => "passed", current: () => true, finish: (watch, outcome) => { finished.push(`${watch.head}:${outcome}`); } });
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(true);
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(false); // already watched
  expect(await until(() => finished.length === 1)).toBe(true);
  expect(w.outcomeOf(1, head)).toBe("passed");
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(false); // already reported
  expect(w.start({ id: 1, head: newer, repo: "o/r", pr: 1 })).toBe(true);
  expect(await until(() => finished.length === 2)).toBe(true);
  expect(finished).toEqual([`${head}:passed`, `${newer}:passed`]);
  expect(w.size).toBe(0);
});

test("CiWatchers: only passed settles a head; a failed head is watched again and each outcome is told once (#540)", async () => {
  const finished: string[] = [];
  let result: "failed" | "pending" | "passed" = "failed";
  const w = new CiWatchers({ deadlineMs: 150, pollMs: 5, poll: async () => result, current: () => true, finish: (watch, outcome) => { finished.push(`${watch.head}:${outcome}`); } });
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(true);
  expect(await until(() => finished.length === 1)).toBe(true);
  expect(await until(() => w.size === 0)).toBe(true); // the deadline after a told result ends silently
  expect(finished).toEqual([`${head}:failed`]);
  expect(w.outcomeOf(1, head)).toBe("failed");
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(true); // a later done at the same head watches again
  await sleep(20);
  expect(finished).toHaveLength(1); // the same failed result is not told twice
  result = "pending"; await sleep(20); result = "passed";
  expect(await until(() => finished.length === 2)).toBe(true);
  expect(finished).toEqual([`${head}:failed`, `${head}:passed`]);
  expect(w.size).toBe(0);
  expect(w.start({ id: 1, head, repo: "o/r", pr: 1 })).toBe(false); // passed settles it for good
});

test("CiWatchers: after a told failed or incomplete result, sustained pending, unreadable or flapping reads still end at a bounded deadline (#540)", async () => {
  const deadlineMs = 60;
  const cases: [string, CiOutcome, (n: number) => Promise<CiPoll>][] = [
    ["failed then pending forever", "failed", async n => n === 1 ? "failed" : "pending"],
    ["incomplete then pending forever", "incomplete", async n => n === 1 ? "incomplete" : "pending"],
    ["failed then unreadable gh", "failed", async n => { if (n === 1) return "failed"; throw new Error("gh down"); }],
    ["failed and pending alternating", "failed", async n => n % 2 ? "failed" : "pending"],
  ];
  for (const [name, first, poll] of cases) {
    const finished: string[] = [];
    let n = 0, polls = 0;
    const w = new CiWatchers({ deadlineMs, pollMs: 5, poll: () => { polls++; return poll(++n); }, current: () => true, finish: (_watch, outcome) => { finished.push(outcome); } });
    const started = Date.now();
    w.start({ id: 1, head, repo: "o/r", pr: 1 });
    expect([name, await until(() => w.size === 0, 2000)]).toEqual([name, true]);
    // one renewal for the one new attempt after the told result: at most about two deadlines in all
    expect([name, Date.now() - started < deadlineMs * 2 + 200]).toEqual([name, true]);
    expect([name, finished]).toEqual([name, [first]]); // told once; the deadline after it is silent
    const after = polls;
    await sleep(40);
    expect([name, polls]).toEqual([name, after]);
  }
});

// #1490 AC5: a draft PR defers its macOS check (the aggregate fails on purpose until `gh pr ready`) and a superseded run is cancelled. Neither is a CI failure the implementer has to fix, so
// neither tells it "failed"; a real failure of the same head still does.
test("#1490 AC5: pollCi reads a cancelled required check and a draft PR's deferred macOS check as pending, never failed", async () => {
  const MAC = "check (macos-latest)";
  const rows = (conclusion: (name: string) => string) => NAMES.map(name => ({ name, status: "COMPLETED", conclusion: conclusion(name) }));
  const reply = (extra: object, checks: object[]) => async (args: string[]) => {
    expect(args.join(" ")).toContain("headRefOid,state,statusCheckRollup,isDraft");
    return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: checks, ...extra }) };
  };
  const target = { repo: "o/r", pr: 1 };
  // draft: the deferred macOS aggregate failed on purpose, the others passed: still waiting, not failed
  expect(await pollCi(target, head, NAMES, reply({ isDraft: true }, rows(name => name === MAC ? "FAILURE" : "SUCCESS")))).toBe("pending");
  // the same rows on a ready PR are a real failure
  expect(await pollCi(target, head, NAMES, reply({ isDraft: false }, rows(name => name === MAC ? "FAILURE" : "SUCCESS")))).toBe("failed");
  expect(await pollCi(target, head, NAMES, reply({}, rows(name => name === MAC ? "FAILURE" : "SUCCESS")))).toBe("failed"); // no isDraft field: not a draft
  // a draft's real failure elsewhere is still told
  expect(await pollCi(target, head, NAMES, reply({ isDraft: true }, rows(name => name === "seeded guards" ? "FAILURE" : name === MAC ? "FAILURE" : "SUCCESS")))).toBe("failed");
  expect(await pollCi(target, head, NAMES, reply({ isDraft: true }, rows(name => name === "check (ubuntu-latest)" ? "FAILURE" : "SUCCESS")))).toBe("failed");
  // a draft whose macOS check passed (a reused proof cannot, but a manual rerun could) is not held back
  expect(await pollCi(target, head, NAMES, reply({ isDraft: true }, rows(() => "SUCCESS")))).toBe("passed");
  // a cancelled run of this head (superseded or replaced by the ready run) is waiting for the next run, on a draft or a ready PR
  for (const isDraft of [true, false]) expect(await pollCi(target, head, NAMES, reply({ isDraft }, rows(name => name === "seeded guards" ? "CANCELLED" : "SUCCESS")))).toBe("pending");
  // a timed-out or action-required check is a real problem, not a cancellation
  expect(await pollCi(target, head, NAMES, reply({}, rows(name => name === "seeded guards" ? "TIMED_OUT" : "SUCCESS")))).toBe("failed");
});

test("#1490 AC5: a draft run's deferred macOS failure tells the owner nothing, the ready run's pass tells once, and a real failure after it is told", async () => {
  const r = rig("advise"); await r.start();
  const macos = "check (macos-latest)";
  const rollup = (draft: boolean) => ({ headRefOid: head, state: "OPEN", isDraft: draft, statusCheckRollup: NAMES.map(name => ({ name, status: "COMPLETED", conclusion: name === macos && draft ? "FAILURE" : "SUCCESS" })) });
  let draft = true;
  const watcherPoll = (r.tasks as unknown as { d: { sdlc: { gh: SdlcGh } } }).d.sdlc;
  const original = watcherPoll.gh;
  watcherPoll.gh = async (args, ...rest) => args[0] === "pr" && args.includes("headRefOid,state,statusCheckRollup,isDraft") ? { code: 0, stdout: JSON.stringify(rollup(draft)) } : original(args, ...rest);
  await r.tasks.done("codex", r.task.id, "ready");
  await sleep(120);
  expect(r.ciNotices(r.owner)).toHaveLength(0); // the draft deferral is not a failure
  expect(r.ciNotices(r.reviewer)).toHaveLength(0);
  draft = false; // gh pr ready: the ready run passes
  expect(await until(() => r.ciNotices(r.owner).length === 1)).toBe(true);
  expect(r.ciNotices(r.owner)[0]!.body).toContain(`${head.slice(0, 12)} passed`);
});

// #1490 AC5, the case PR #1527 hit on its own run: after `gh pr ready` one head carries the rows of two runs of the same workflow. The draft run's aggregates failed (its macOS one on
// purpose, the others because it was cancelled) while the ready run is going green. The newest run says what the head's CI is; the older run's rows are no failure to fix.
import { latestCheckRuns, parsePrEvidence, readReviewReadiness } from "../src/hub/sdlc.ts";
const row = (name: string, startedAt: string, conclusion: string, status = "COMPLETED", workflowName = "check") => ({ name, status, conclusion, startedAt, workflowName });
const draftRun = (at = "2026-11-15T21:13:28Z") => NAMES.map(name => row(name, at, "FAILURE"));
const readyRun = (conclusion: string, status = "COMPLETED", at = "2026-11-15T21:14:43Z") => NAMES.map(name => row(name, at, conclusion, status));

test("#1490 AC5: latestCheckRuns keeps only the newest run's row of a check name, and keeps every row when it cannot be sure", () => {
  const older = row("check (ubuntu-latest)", "2026-11-15T21:13:28Z", "CANCELLED"), newer = row("check (ubuntu-latest)", "2026-11-15T21:14:43Z", "SUCCESS");
  expect(latestCheckRuns([older, newer])).toEqual([newer]);
  expect(latestCheckRuns([newer, older])).toEqual([newer]); // order never decides
  expect(latestCheckRuns([older])).toEqual([older]);
  const other = row("seeded guards", "2026-11-15T21:00:00Z", "SUCCESS");
  expect(latestCheckRuns([older, other, newer])).toEqual([other, newer]); // other names are untouched, in order
  // not sure: keep both, so the readers still say `duplicate` and unknown stays unknown
  expect(latestCheckRuns([older, { ...newer, workflowName: "release" }])).toHaveLength(2); // another workflow with the same job name
  expect(latestCheckRuns([older, { ...newer, workflowName: undefined }])).toHaveLength(2); // no workflow identity
  expect(latestCheckRuns([older, { ...newer, startedAt: undefined }])).toHaveLength(2); // no start time
  expect(latestCheckRuns([older, { ...newer, startedAt: "not a time" }])).toHaveLength(2);
  expect(latestCheckRuns([older, { ...newer, startedAt: older.startedAt }])).toHaveLength(2); // a tie
  // a commit status has no run: kept as is, and two with one context stay a duplicate
  expect(latestCheckRuns([{ context: "ci/x", state: "FAILURE" }, { context: "ci/x", state: "SUCCESS" }])).toHaveLength(2);
  expect(latestCheckRuns([])).toEqual([]);
  // the GraphQL shape (workflow under the check suite) is understood too
  const graph = (at: string, conclusion: string) => ({ name: "n", status: "COMPLETED", conclusion, startedAt: at, checkSuite: { workflowRun: { workflow: { resourcePath: "/o/r/actions/workflows/check.yml" } } } });
  expect(latestCheckRuns([graph("2026-11-15T21:13:28Z", "CANCELLED"), graph("2026-11-15T21:14:43Z", "SUCCESS")]).map(item => item.conclusion)).toEqual(["SUCCESS"]);
});

test("#1490 AC5: the head's evidence is the newest run's, so a replaced draft run is no CI failure, in every reader", async () => {
  const state = (rows: object[]) => parsePrEvidence({ headRefOid: head, state: "OPEN", files: [], statusCheckRollup: latestCheckRuns(rows) }).checks;
  // the ready run is still going: pending, not failed by the draft run's rows
  expect(state([...draftRun(), ...readyRun("", "IN_PROGRESS")]).map(check => check.state)).toEqual(["pending", "pending", "pending"]);
  // the ready run is green: passed
  expect(state([...draftRun(), ...readyRun("SUCCESS")]).map(check => check.state)).toEqual(["passed", "passed", "passed"]);
  // the ready run really failed: failed
  expect(state([...draftRun(), ...readyRun("FAILURE")]).map(check => check.state)).toEqual(["failed", "failed", "failed"]);
  // the same rows without the filter are the false failure this guards against
  expect(parsePrEvidence({ headRefOid: head, state: "OPEN", files: [], statusCheckRollup: [...draftRun(), ...readyRun("SUCCESS")] }).checks.some(check => check.state === "failed")).toBe(true);

  // pollCi (the watcher): the draft run's rows never make the watcher say "failed" while the ready run is green or running
  const target = { repo: "o/r", pr: 1 };
  const poll = (rows: object[], isDraft = false) => pollCi(target, head, NAMES, async () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", isDraft, statusCheckRollup: rows }) }));
  expect(await poll([...draftRun(), ...readyRun("", "IN_PROGRESS")])).toBe("pending");
  expect(await poll([...draftRun(), ...readyRun("SUCCESS")])).toBe("passed");
  expect(await poll([...draftRun(), ...readyRun("FAILURE")])).toBe("failed");

  // readReviewReadiness (the review admission, GraphQL): ready only when the newest run is green
  const graph = (rows: object[]) => async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, state: "OPEN",
    commits: { nodes: [{ commit: { oid: head, tree: { oid: "b".repeat(40) }, statusCheckRollup: { contexts: { nodes: rows.map(item => ({ ...item, workflowName: undefined, checkSuite: { workflowRun: { workflow: { resourcePath: "/o/r/actions/workflows/check.yml" } } } })), pageInfo: { hasNextPage: false } } } } }] },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) });
  const receipt = { stage: "build", repo: "o/r", pr: 1 };
  expect(await readReviewReadiness(receipt, head, graph([...draftRun(), ...readyRun("SUCCESS")]), NAMES)).toMatchObject({ ready: true, checks: NAMES });
  expect((await readReviewReadiness(receipt, head, graph([...draftRun(), ...readyRun("", "IN_PROGRESS")]), NAMES)).blockers.join(" ")).toContain("pending");
  expect((await readReviewReadiness(receipt, head, graph([...draftRun(), ...readyRun("FAILURE")]), NAMES)).blockers.join(" ")).toContain("failed");
  // not sure (no start times): both runs' rows stay, the draft run's failures still count, and the head is never ready
  const unsure = await readReviewReadiness(receipt, head, graph([...draftRun(), ...readyRun("SUCCESS")].map(item => ({ ...item, startedAt: undefined }))), NAMES);
  expect(unsure.ready).toBe(false);
  expect(unsure.blockers.join(" ")).toContain("not green");
});
