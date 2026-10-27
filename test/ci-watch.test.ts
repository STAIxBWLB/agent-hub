import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { CiWatchers, pollCi } from "../src/hub/ci-watch.ts";
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
    if (args[0] === "pr" && args.includes("headRefOid,state,statusCheckRollup")) {
      state.polls++;
      return { code: 0, stdout: JSON.stringify({ headRefOid: state.prHead, state: state.prState, statusCheckRollup: NAMES.map(name => ({ name, status: state.conclusion === "IN_PROGRESS" ? "IN_PROGRESS" : "COMPLETED", conclusion: state.conclusion === "IN_PROGRESS" ? "" : state.conclusion })) }) };
    }
    if (args[0] === "pr") return { code: 0, stdout: JSON.stringify({ headRefOid: head, state: "OPEN", statusCheckRollup: [], reviewRequests: [], files: [], changedFiles: 0 }) };
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
  expect(r.watchers().size).toBe(0);
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
