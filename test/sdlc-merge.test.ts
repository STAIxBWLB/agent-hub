import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import type { DeliveryTask } from "../src/hub/sdlc-queue.ts";
import { assertMergeArgv, decideMerge, guardedMerge, mergeArgv, mergeModeFor, requiredChecksFor, type MergeInput } from "../src/hub/sdlc-merge.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";

// agent-hub#786 T1: the guarded merge. A fake gh stands for GitHub: it records every argv, so the tests read what would have run.
const A = "a".repeat(40), B = "b".repeat(40), BASE = "c".repeat(40), MERGED = "d".repeat(40);
const cleanups: (() => void)[] = [];
const allCalls: string[][] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

interface World { head: string; draft: boolean; branch: string; state: "OPEN" | "MERGED"; review: "APPROVED" | "CHANGES_REQUESTED" | null; threads: number; requests: number | null; paths: string[]; checks: { name: string; conclusion?: string; status?: string }[] }
const pr = (patch: Partial<World> = {}): World => ({ head: A, draft: false, branch: "feat/786", state: "OPEN", review: null, threads: 0, requests: 0, paths: ["src/a.ts"], checks: [{ name: "gate", conclusion: "SUCCESS" }], ...patch });

function fakeGh(prs: Record<number, World>, options: { mergeExit?: number; mergeLands?: boolean; hold?: Promise<void>; /** Runs before each call is answered: how a test moves GitHub between two reads. */ onCall?: (args: string[], index: number) => void } = {}) {
  const calls: string[][] = [];
  const view = (n: number) => { const p = prs[n]!; return { headRefOid: p.head, headRefName: p.branch, isDraft: p.draft, baseRefName: "main", baseRefOid: BASE, state: p.state, changedFiles: p.paths.length, statusCheckRollup: p.checks, reviewDecision: p.review, ...(p.requests === null ? {} : { reviewRequests: Array.from({ length: p.requests }, () => ({ requestedReviewer: { __typename: "User" } })) }), files: p.paths.map(path => ({ path, changeType: "MODIFIED" })), mergeCommit: p.state === "MERGED" ? { oid: MERGED } : undefined }; };
  const run: SdlcGh = async args => {
    await options.hold;
    options.onCall?.(args, calls.length);
    calls.push(args); allCalls.push(args);
    if (args[0] === "pr" && args[1] === "merge") {
      const n = Number(args[2]);
      if (options.mergeLands !== false && (options.mergeExit ?? 0) === 0) prs[n]!.state = "MERGED";
      return { code: options.mergeExit ?? 0, stdout: "" };
    }
    const open = Object.entries(prs).filter(([, p]) => p.state === "OPEN").map(([n, p]) => ({ number: Number(n), headRefOid: p.head, baseRefName: "main", baseRefOid: BASE }));
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify(open) };
    if (args[0] === "pr" && args[1] === "view") return prs[Number(args[2])] ? { code: 0, stdout: JSON.stringify(view(Number(args[2]))) } : { code: 1, stdout: "" };
    const finalQuery = args.find(arg => arg.startsWith("query=") && arg.includes("queue_p"));
    if (finalQuery) {
      const repository: Record<string, unknown> = {};
      for (const match of finalQuery.matchAll(/queue_p([0-9]+):/g)) {
        const n = Number(match[1]), p = prs[n]!;
        repository[`queue_p${n}`] = { headRefOid: p.head, state: p.state, isDraft: p.draft, baseRefName: "main", baseRefOid: BASE, changedFiles: p.paths.length, reviewDecision: p.review,
          reviewRequests: { nodes: Array.from({ length: p.requests ?? 0 }, () => ({ requestedReviewer: { __typename: "User" } })), pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false })), pageInfo: { hasNextPage: false } },
          statusCheckRollup: { contexts: { nodes: p.checks, pageInfo: { hasNextPage: false } } } };
      }
      for (const match of finalQuery.matchAll(/queue_i([0-9]+):issue\(number:([0-9]+)\)/g)) repository[`queue_i${match[1]}`] = { number: Number(match[2]), labels: { nodes: [], pageInfo: { hasNextPage: false } } };
      repository.pullRequests = { nodes: open, pageInfo: { hasNextPage: false } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }) };
    }
    const n = Number(args.at(-1)?.split("=")[1]), issueArg = args.find(arg => arg.startsWith("issue="));
    const p = prs[n];
    if (!p) return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: p.head, reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false })), pageInfo: { hasNextPage: false } } },
      ...(issueArg ? { issue: { number: Number(issueArg.split("=")[1]), labels: { nodes: [], pageInfo: { hasNextPage: false } } } } : {}) } } }) };
  };
  return { run, calls, merges: () => calls.filter(c => c[0] === "pr" && c[1] === "merge") };
}

const config = (extra: Record<string, unknown> = {}) => sdlcConfig({ mode: "advise", required_checks: ["gate"], auto_merge: "on", ...extra });
const task = (id: number, n: number, over: Partial<DeliveryTask> = {}, receipt: Partial<NonNullable<DeliveryTask["receipt"]>> = {}): DeliveryTask => ({ id, after: [], private: false, receipt: { repo: "owner/repo", issue: id, pr: n, stage: "merge", reviewedHead: A, localHead: A, localResult: "passed", ...receipt }, ...over });
function input(prs: Record<number, World>, tasks: DeliveryTask[], over: Partial<MergeInput> = {}, gh = fakeGh(prs)) {
  return { gh, args: { subject: tasks[0]!, state: "approved", taskState: (id: number) => (tasks.find(t => t.id === id) ? "approved" : undefined), config: config(), tasks, run: gh.run, ...over } satisfies MergeInput };
}
const refusals = async (i: ReturnType<typeof input>) => { const d = await decideMerge(i.args); return "refused" in d ? d.refused : ["MERGE"]; };

test("a clean approved PR at its approved head gets exactly one guarded merge argv, and nothing else is written", async () => {
  const i = input({ 1: pr() }, [task(1, 1)]);
  const decision = await decideMerge(i.args);
  expect(decision).toEqual({ action: "merge", argv: ["pr", "merge", "1", "--repo", "owner/repo", "--squash", "--match-head-commit", A], repo: "owner/repo", pr: 1, head: A });
  expect(i.gh.merges()).toHaveLength(0);                                                       // deciding runs no write
  const outcome = await guardedMerge({ ...i.args, mode: "on" });
  expect(outcome.ran).toBe(true); expect(outcome.result).toEqual({ exit: 0, state: "merged", mergeCommit: MERGED });
  expect(i.gh.merges()).toEqual([["pr", "merge", "1", "--repo", "owner/repo", "--squash", "--match-head-commit", A]]);
});

test("AC2: every gate refuses and names itself: head, checks (failing, pending, missing), change request, thread, Important finding, draft, release, order, dependency", async () => {
  const one = async (world: Partial<World>, over: Partial<MergeInput> = {}, t = task(1, 1)) => refusals(input({ 1: pr(world) }, [t], over));
  expect((await one({ head: B }))).toEqual([expect.stringContaining("head changed")]);
  expect(await one({ checks: [{ name: "gate", conclusion: "FAILURE" }] })).toEqual(["required check gate: failing"]);
  expect(await one({ checks: [{ name: "gate", status: "IN_PROGRESS" }] })).toEqual(["required check gate: pending"]);
  expect(await one({ checks: [{ name: "other", conclusion: "SUCCESS" }] })).toEqual(["required check gate: missing"]);
  expect(await one({ review: "CHANGES_REQUESTED" })).toEqual(["change request pending"]);
  expect(await one({ threads: 2 })).toEqual(["2 unresolved review threads"]);
  expect(await one({ draft: true })).toEqual(["draft (or draft status unknown)"]);
  expect(await one({ branch: "release/0.18.0" })).toEqual(["release PR: person consent required"]);
  expect(await one({}, {}, task(1, 1, {}, { stage: "release" }))).toEqual(["release PR: person consent required"]);
  expect(await one({ state: "MERGED" })).toEqual(expect.arrayContaining(["PR is merged"]));
  const important = task(1, 1, { findings: [{ head: A, items: [{ id: "f1", pass: "bugs", severity: "important", disposition: "open" }] }] });
  expect(await one({}, {}, important)).toEqual(["open Important finding"]);
  const settled = task(1, 1, { findings: [{ head: A, items: [{ id: "f1", pass: "bugs", severity: "important", disposition: "fixed" }] }] });
  expect(await one({}, {}, settled)).toEqual(["MERGE"]);                                        // a settled finding does not block
  expect(await one({}, { state: "in_review" })).toEqual(["task not approved (state in_review)"]);
  expect(await one({}, {}, task(1, 1, {}, { reviewedHead: undefined }))).toEqual([expect.stringContaining("reviewed head not recorded")]);
  expect(await one({}, {}, task(1, 1, { private: true }))).toEqual(["private task: a person merges"]);
  // Several failing gates are all named in one answer, not the first only.
  const many = await one({ head: B, draft: true, threads: 1, checks: [{ name: "gate", conclusion: "FAILURE" }] });
  expect(many).toEqual(expect.arrayContaining([expect.stringContaining("head changed"), "draft (or draft status unknown)", "1 unresolved review thread", "required check gate: failing"]));
  // GitHub unavailable is a refusal, never a pass.
  const down = input({ 1: pr() }, [task(1, 1)], { run: async () => ({ code: 1, stdout: "" }) });
  expect(await refusals(down)).toEqual(["PR evidence unavailable"]);
});

/** Which read of one PR this call is: the 1st `pr view` is the decision's, the 2nd the queue's, the 3rd the last one. */
const viewCounter = () => { let n = 0; return { next: (args: string[]) => (args[0] === "pr" && args[1] === "view" ? ++n : n) }; };

test("review requests: a pending request, and an unknown count, refuse", async () => {
  expect(await refusals(input({ 1: pr({ requests: 1 }) }, [task(1, 1)]))).toEqual(["1 review request pending"]);
  expect(await refusals(input({ 1: pr({ requests: 3 }) }, [task(1, 1)]))).toEqual(["3 review requests pending"]);
  expect(await refusals(input({ 1: pr({ requests: null }) }, [task(1, 1)]))).toEqual(expect.arrayContaining(["review requests unknown"]));
  expect(await refusals(input({ 1: pr({ requests: 0 }) }, [task(1, 1)]))).toEqual(["MERGE"]);
});

test("a gate that changes between the reads refuses at the SAME head: check, review request, thread, draft, change request", async () => {
  // Each case: the first read sees a clean PR, and GitHub moves at the given read; the head never changes, so `--match-head-commit` would not catch any of it.
  const cases: [string, number, Partial<World>, string][] = [
    ["a check fails before the queue read", 2, { checks: [{ name: "gate", conclusion: "FAILURE" }] }, "required check gate: failing"],
    ["a check fails after the queue read", 3, { checks: [{ name: "gate", conclusion: "FAILURE" }] }, "required check gate: failing"],
    ["a check turns pending before the queue read", 2, { checks: [{ name: "gate", status: "IN_PROGRESS" }] }, "required check gate: pending"],
    ["a review is requested before the queue read", 2, { requests: 1 }, "1 review request pending"],
    ["a review is requested after the queue read", 3, { requests: 1 }, "1 review request pending"],
    ["a thread opens before the queue read", 2, { threads: 1 }, "1 unresolved review thread"],
    ["a thread opens after the queue read", 3, { threads: 1 }, "1 unresolved review thread"],
    ["the PR becomes a draft before the queue read", 2, { draft: true }, "draft (or draft status unknown)"],
    ["the PR becomes a draft after the queue read", 3, { draft: true }, "draft (or draft status unknown)"],
    ["a change request lands before the queue read", 2, { review: "CHANGES_REQUESTED" }, "change request pending"],
    ["a change request lands after the queue read", 3, { review: "CHANGES_REQUESTED" }, "change request pending"],
  ];
  for (const [label, at, change, gate] of cases) {
    for (const protectedRepo of [true, false]) {
      // An unprotected repository is gated by its [repos] table, which the queue never reads: only the final read can catch a failing repo-table check.
      const prs = { 1: pr() }, counter = viewCounter();
      const gh = fakeGh(prs, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && counter.next(args) === at) Object.assign(prs[1]!, change); } });
      const cfg = protectedRepo ? config() : sdlcConfig({ mode: "advise", auto_merge: "on", repos: { "owner/repo": { required_checks: ["gate"] } } });
      const result = await refusals(input(prs, [task(1, 1)], { config: cfg }, gh));
      expect(result, `${label} (${protectedRepo ? "top-level" : "repo table"} checks)`).toContain(gate);
      expect(result).not.toContain("MERGE");
      // The same case through guardedMerge in on mode: nothing is run.
      const prs2 = { 1: pr() }, counter2 = viewCounter();
      const gh2 = fakeGh(prs2, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && counter2.next(args) === at) Object.assign(prs2[1]!, change); } });
      const outcome = await guardedMerge({ ...input(prs2, [task(1, 1)], { config: cfg }, gh2).args, mode: "on" });
      expect(outcome.ran, label).toBe(false); expect(gh2.merges(), label).toHaveLength(0);
    }
  }
  // A final read that fails is a refusal too, never a pass.
  const prs = { 1: pr() }, counter = viewCounter();
  const gh = fakeGh(prs, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && counter.next(args) === 3) prs[1]!.head = "e".repeat(40); } });
  expect(await refusals(input(prs, [task(1, 1)], {}, gh))).toEqual(expect.arrayContaining([expect.stringContaining("head changed")]));
  const dead = fakeGh({ 1: pr() }, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && counter.next(args) >= 4) throw new Error("gh vanished"); } });
  expect(await decideMerge(input({ 1: pr() }, [task(1, 1)], {}, dead).args).catch(() => ({ refused: ["threw"] }))).not.toHaveProperty("action");
});

/**
 * One board-side input per case flips during the HELD final PR read (the 3rd `pr view` of the subject), and the test asserts no merge argv. The inputs are the ones the
 * decision rested on: the task's state, repo, PR and reviewed head, its privacy, every dependency's state and its edges, its open Important findings for the head, the
 * merge mode and required checks in force, and the asker's authority. `quiet` proves the same rig merges when nothing flips.
 */
interface LiveBoard { states: Record<number, string>; state: string; findings: NonNullable<DeliveryTask["findings"]>; private: boolean; after: number[]; repo: string; pr: number; reviewedHead: string | undefined; stage: string; config: ReturnType<typeof config>; mode: "on" | "dry-run"; allowed: boolean; gone: boolean }
const liveBoard = (): LiveBoard => ({ states: { 2: "approved" }, state: "approved", findings: [], private: false, after: [2], repo: "owner/repo", pr: 1, reviewedHead: A, stage: "merge", config: config(), mode: "on", allowed: true, gone: false });
async function heldFinalRead(flip: (board: LiveBoard) => void) {
  const prs: Record<number, World> = { 1: pr({ paths: ["src/a.ts"] }), 2: pr({ state: "MERGED", paths: ["src/b.ts"] }) };
  const board = liveBoard(), counter = viewCounter();
  const subject = task(1, 1, { after: [2] }), dependency = task(2, 2);
  const gh = fakeGh(prs, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && args[2] === "1" && counter.next(args) === 3) flip(board); } });
  const fresh = () => board.gone ? undefined : { subject: { ...subject, after: board.after, findings: board.findings, private: board.private, receipt: { ...subject.receipt!, repo: board.repo, pr: board.pr, ...(board.reviewedHead ? { reviewedHead: board.reviewedHead } : { reviewedHead: undefined }), stage: board.stage } }, state: board.state, config: board.config, mode: board.mode, allowed: board.allowed };
  const outcome = await guardedMerge({ ...input(prs, [subject, dependency], { taskState: id => board.states[id], tasks: [subject, dependency] }, gh).args, mode: "on", fresh });
  return { outcome, gh };
}
const flips: [string, (board: LiveBoard) => void, string | RegExp][] = [
  ["the task's state changes", board => { board.state = "changes_requested"; }, "task not approved (state changes_requested)"],
  ["the task becomes private", board => { board.private = true; }, "private task: a person merges"],
  ["a dependency leaves approved", board => { board.states[2] = "in_progress"; }, "dependency task #2 is not approved (in_progress)"],
  ["a dependency disappears", board => { delete board.states[2]; }, "dependency task #2 is not approved (unknown)"],
  ["a dependency edge is removed", board => { board.after = []; }, "task dependencies changed during the merge check: nothing was run"],
  ["a dependency edge is added", board => { board.after = [2, 3]; board.states[3] = "approved"; }, "task dependencies changed during the merge check: nothing was run"],
  ["an open Important finding appears for the head", board => { board.findings = [{ head: A, items: [{ id: "f9", pass: "security", severity: "important", disposition: "open" }] }]; }, "open Important finding"],
  ["the reviewed head moves", board => { board.reviewedHead = B; }, "task changed during the merge check: nothing was run"],
  ["the reviewed head is dropped", board => { board.reviewedHead = undefined; }, "task changed during the merge check: nothing was run"],
  ["the task is relinked to another PR", board => { board.pr = 9; }, "task changed during the merge check: nothing was run"],
  ["the task is relinked to another repository", board => { board.repo = "owner/other"; }, "task changed during the merge check: nothing was run"],
  ["the task moves to a release stage", board => { board.stage = "release"; }, "release PR: person consent required"],
  ["the task vanishes", board => { board.gone = true; }, "task changed during the merge check: nothing was run"],
  ["the merge mode is turned down to dry-run", board => { board.mode = "dry-run"; }, "merge mode changed during the merge check: nothing was run"],
  ["the required checks change", board => { board.config = config({ required_checks: ["gate", "extra"] }); }, "required checks changed during the merge check: nothing was run"],
  ["a repository table adds a required check", board => { board.config = config({ repos: { "owner/repo": { required_checks: ["extra"] } } }); }, "required checks changed during the merge check: nothing was run"],
  ["the asker loses authority or the hub is held", board => { board.allowed = false; }, "authority or hub availability changed during the merge check: nothing was run"],
];

test("every board-side input that flips during the held final read refuses with no merge argv, and the same rig merges when nothing flips", async () => {
  const quiet = await heldFinalRead(() => {});
  expect(quiet.outcome.ran).toBe(true); expect(quiet.gh.merges()).toHaveLength(1);
  for (const [label, flip, gate] of flips) {
    const { outcome, gh } = await heldFinalRead(flip);
    expect(outcome.ran, label).toBe(false);
    expect(gh.merges(), label).toHaveLength(0);
    expect(outcome.decision, label).toMatchObject({ refused: expect.arrayContaining([gate]) });
  }
});

test("the dispatch has no await between the fresh board read and the gh call", async () => {
  // The board flips INSIDE the gh call's own first tick: if anything were awaited between the read and the call, a flip scheduled on the microtask queue by the fresh read
  // would land before `run`. Here the flip runs when `run` starts, so the read must already have been compared: the merge goes out and records the argv.
  const order: string[] = [];
  const prs: Record<number, World> = { 1: pr() }, subject = task(1, 1);
  const gh = fakeGh(prs);
  const board = liveBoard(); board.after = []; subject.after = [];
  const run: SdlcGh = async (args, ...rest) => { if (args[1] === "merge") order.push("run"); return gh.run(args, ...rest); };
  const fresh = () => { order.push("fresh"); queueMicrotask(() => order.push("microtask")); return { subject, state: "approved", config: config(), mode: "on" as const, allowed: true }; };
  await guardedMerge({ ...input(prs, [subject], { run }, gh).args, mode: "on", fresh });
  const at = order.indexOf("fresh");
  expect(order.slice(at, at + 3)).toEqual(["fresh", "run", "microtask"]);                          // fresh read, then the call, with nothing between them
});

test("Tasks.guardedMerge flips: the real board is read at dispatch, and a person's own refusal paths still answer", async () => {
  const prs: Record<number, World> = { 1: pr(), 2: pr({ state: "MERGED", paths: ["src/b.ts"] }) };
  const counter = viewCounter();
  let board!: Board, tasksRef!: Tasks, subjectId = 0, flip: () => void = () => {};
  const gh = fakeGh(prs, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && args[2] === "1" && counter.next(args) === 3) flip(); } });
  const dir = mkdtempSync(join(tmpdir(), "ahub-merge-dep-"));
  board = new Board(join(dir, "hub.db")); const bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  let cfg: Record<string, unknown> = { mode: "off", required_checks: ["gate"], auto_merge: "on" };
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  tasksRef = new Tasks({ board, bus, cwd: dir, project: "test", repository: "owner/repo", roles: { claude: ["conductor"] }, routing: () => loadRouting(dir), notify: message => notices.push(message), sdlc: { config: () => sdlcConfig(cfg), gh: gh.run } });
  const dependency = board.propose(USER, { title: "first", class: "implement" });
  board.update(dependency.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" }); board.update(dependency.id, USER, "approved", { state: "approved" });
  const subject = board.propose(USER, { title: "second", class: "implement", deps: [dependency.id] });
  subjectId = subject.id;
  board.update(subject.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" }); board.update(subject.id, USER, "done", { state: "in_review" }); board.update(subject.id, USER, "approved", { state: "approved" });
  tasksRef.recordLifecycle(USER, dependency.id, { repo: "owner/repo", issue: 3, pr: 2, stage: "merge" });
  tasksRef.recordLifecycle(USER, subject.id, { repo: "owner/repo", issue: 2, pr: 1, reviewedHead: A, localHead: A, localResult: "passed", stage: "merge" });
  // A dependency cannot leave approved on the real board (the state machine refuses), so the merge goes out from the fresh read.
  let attempt = "not tried"; flip = () => { try { board.update(dependency.id, USER, "reopened", { state: "proposed" }, "took it back"); attempt = "moved"; } catch (error) { attempt = (error as Error).message; } };
  const ok = await tasksRef.guardedMerge(USER, subjectId);
  expect(attempt).toContain("cannot move to proposed"); expect(ok).toMatchObject({ ran: true, decision: "merge" }); expect(gh.merges()).toHaveLength(1);
  // The configuration in force at dispatch is the one that counts: auto_merge turned down during the held read means nothing runs (a second PR, same rig).
  const third = board.propose(USER, { title: "third", class: "implement" });
  board.update(third.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" }); board.update(third.id, USER, "done", { state: "in_review" }); board.update(third.id, USER, "approved", { state: "approved" });
  prs[3] = pr({ paths: ["src/c.ts"] });
  tasksRef.recordLifecycle(USER, third.id, { repo: "owner/repo", issue: 4, pr: 3, reviewedHead: A, localHead: A, localResult: "passed", stage: "merge" });
  gh.merges().length = 0;
  let views = 0; flip = () => {};
  const flipOnce = () => { cfg = { mode: "off", required_checks: ["gate"], auto_merge: "dry-run" }; };
  const watcher = fakeGh(prs, { onCall: args => { if (args[0] === "pr" && args[1] === "view" && args[2] === "3" && ++views === 3) flipOnce(); } });
  (tasksRef as unknown as { d: { sdlc: { gh: SdlcGh } } }).d.sdlc.gh = watcher.run;
  const turned = await tasksRef.guardedMerge(USER, third.id);
  expect(turned).toMatchObject({ ran: false, decision: "refused" }); expect(turned.refused).toEqual(["merge mode changed during the merge check: nothing was run"]);
  expect(watcher.merges()).toHaveLength(0);
});

test("Tasks.guardedMerge fences every local queue input after the last awaited PR read", async () => {
  type Move = (context: {board: Board; tasks: Tasks; subject: number; dependency: number; holder: number; changeConfig: () => void; withdrawConductor: () => void}) => void;
  const run = async (move: Move, by=USER) => {
    const prs: Record<number, World> = {1:pr(),2:pr({state:"MERGED",paths:["src/dep.ts"]}),3:pr({paths:["src/other.ts"]})};
    const dir=mkdtempSync(join(tmpdir(),"ahub-merge-queue-fence-")),board=new Board(join(dir,"hub.db")),bus=new Bus({batchMs:0});
    cleanups.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});
    const roles: Record<string,"conductor"[]>={claude:["conductor"]};
    let subjectReads=0, moved=false, mutationError:unknown;
    const gh=fakeGh(prs,{onCall:args=>{
      if (args[0]==="pr" && args[1]==="view" && args[2]==="1" && ++subjectReads===3) {
        moved=true;try {move({board,tasks,subject:subject.id,dependency:dependency.id,holder:holder.id,changeConfig:()=>{cfg=config({required_checks:["gate","new gate"]});},withdrawConductor:()=>{delete roles.claude;}});} catch(error) {mutationError=error;}
      }
    }});
    let cfg=config();
    const tasks=new Tasks({board,bus,cwd:dir,project:"test",repository:"owner/repo",roles,routing:()=>loadRouting(dir),notify:()=>{},sdlc:{config:()=>cfg,gh:gh.run}});
    const approve = (title:string,deps:number[]=[]) => {
      const t=board.propose(USER,{title,class:"implement",deps});
      board.update(t.id,USER,"accepted",{state:"in_progress",owner:"codex",reviewer:USER});
      board.update(t.id,USER,"done",{state:"in_review"});
      return board.update(t.id,USER,"approved",{state:"approved"});
    };
    const dependency=approve("dependency"),subject=approve("subject",[dependency.id]),holder=approve("other queue holder");
    tasks.recordLifecycle(USER,dependency.id,{repo:"owner/repo",issue:10,pr:2,stage:"merge"});
    tasks.recordLifecycle(USER,subject.id,{repo:"owner/repo",issue:11,pr:1,stage:"merge",reviewedHead:A,localHead:A,localResult:"passed"});
    tasks.recordLifecycle(USER,holder.id,{repo:"owner/repo",issue:12,pr:3,stage:"merge",reviewedHead:A,localHead:A,localResult:"passed"});
    const result=await tasks.guardedMerge(by,subject.id);
    expect(mutationError).toBeUndefined();
    expect(moved).toBe(true);
    expect(board.get(dependency.id)?.state).toBe("approved");
    return {result,gh};
  };
  const unchanged=await run(()=>{});
  expect(unchanged.result).toMatchObject({ran:true,decision:"merge"});
  expect(unchanged.gh.merges()).toEqual([mergeArgv("owner/repo",1,A)]);
  const conductor=await run(()=>{},"claude");
  expect(conductor.result).toMatchObject({ran:true,decision:"merge"});
  expect(conductor.gh.merges()).toEqual([mergeArgv("owner/repo",1,A)]);
  const withdrawn=await run(({withdrawConductor})=>withdrawConductor(),"claude");
  expect(withdrawn.result).toMatchObject({ran:false,decision:"refused",refused:["authority or hub availability changed during the merge check: nothing was run"]});
  expect(withdrawn.gh.merges()).toHaveLength(0);
  const queueChanged="merge queue inputs changed during the merge check: nothing was run";
  const cases: [Move,string][] = [
    // Legitimate approved-task receipt mutation: the cached queue verified PR2 merged, but the dependency now names open PR3.
    [({tasks,dependency})=>{tasks.recordLifecycle(USER,dependency,{repo:"owner/repo",issue:10,pr:3,stage:"merge"});},queueChanged],
    [({board,subject,holder})=>{board.plan(subject,USER,{deps:[holder]},0);},"task dependencies changed during the merge check: nothing was run"],
    [({board,holder,subject})=>{board.plan(holder,USER,{deps:[subject]},0);},queueChanged],
    [({board,holder})=>{board.update(holder,USER,"plan changed",{plan:{paths:["src/new.ts"]}});},queueChanged],
    [({board,holder})=>{board.update(holder,USER,"approved",{state:"approved"},undefined,{reviewFindings:{head:A,items:[{id:"queue-important",pass:"bugs",severity:"important",disposition:"open"}]}});},queueChanged],
    [({board,holder})=>{board.update(holder,USER,"privacy changed",{signals:["pii"]});},queueChanged],
    [({board,tasks})=>{const added=board.propose(USER,{title:"new queue holder",class:"implement"});tasks.recordLifecycle(USER,added.id,{stage:"merge",repo:"owner/repo",pr:3});},queueChanged],
    [({board,holder})=>{board.update(holder,USER,"receipt removed",{sdlc:undefined});},queueChanged],
    [({board})=>{board.propose(USER,{title:"unrelated unlinked task",class:"triage"});},queueChanged],
    [({changeConfig})=>{changeConfig();},"required checks changed during the merge check: nothing was run"],
  ];
  for (const [move,reason] of cases) {
    const {result,gh}=await run(move);
    expect(result).toMatchObject({ran:false,decision:"refused",refused:[reason]});
    expect(gh.merges()).toHaveLength(0);
  }
});

test("the final merge callback fences a mutation made by the fresh provider before dispatch", async () => {
  const subject=task(1,1),i=input({1:pr()},[subject]);
  let callbackSawFresh=false;
  const outcome=await guardedMerge({...i.args,mode:"on",
    fresh:()=>{i.args.tasks.push(task(2,2));return {subject,state:"approved",config:i.args.config,mode:"on",allowed:true};},
    beforeMerge:()=>{callbackSawFresh=i.args.tasks.length===2;return callbackSawFresh?"queue input changed by fresh provider":undefined;}});
  expect(callbackSawFresh).toBe(true);
  expect(outcome).toMatchObject({ran:false,decision:{refused:["queue input changed by fresh provider"]}});
  expect(i.gh.merges()).toHaveLength(0);
});

test("AC2: touching PRs merge in order, and a dependency task that is not approved refuses", async () => {
  const prs = { 1: pr({ paths: ["src/shared.ts"] }), 2: pr({ paths: ["src/shared.ts"] }) };
  // Same files and no declared order: a person orders them.
  expect(await refusals(input(prs, [task(1, 1), task(2, 2)]))).toEqual(["queue: touching PRs require a person order"]);
  // Declared order: the second waits for the first, naming it.
  const ordered = [task(1, 1), task(2, 2, { after: [1] })];
  const second = input(prs, [ordered[1]!, ordered[0]!], { taskState: id => (id === 1 ? "in_review" : undefined) });
  expect(await refusals(second)).toEqual(expect.arrayContaining(["dependency task #1 is not approved (in_review)", "not first among touching PRs: #1 merges first"]));
  // The first of the two is free to go.
  const first = input(prs, ordered);
  expect((await decideMerge(first.args))).toMatchObject({ action: "merge", pr: 1 });
  // A PR whose files nobody else touches is not held by the other.
  const apart = input({ 1: pr({ paths: ["src/a.ts"] }), 2: pr({ paths: ["src/b.ts"] }) }, [task(1, 1), task(2, 2)]);
  expect(await decideMerge(apart.args)).toMatchObject({ action: "merge" });
});

test("AC3: dry-run reports the decision, records the argv it would run, and runs nothing; off reads nothing", async () => {
  const i = input({ 1: pr() }, [task(1, 1)]);
  const dry = await guardedMerge({ ...i.args, mode: "dry-run" });
  expect(dry.ran).toBe(false); expect(dry.decision).toMatchObject({ action: "merge", argv: ["pr", "merge", "1", "--repo", "owner/repo", "--squash", "--match-head-commit", A] });
  expect(i.gh.merges()).toHaveLength(0);
  const reads = i.gh.calls.length;
  const refused = await guardedMerge({ ...input({ 1: pr({ draft: true }) }, [task(1, 1)]).args, mode: "dry-run" });
  expect(refused.ran).toBe(false); expect(refused.decision).toEqual({ refused: ["draft (or draft status unknown)"] });
  const off = await guardedMerge({ ...i.args, mode: "off" });
  expect(off).toEqual({ mode: "off", decision: { refused: ["auto_merge is off for this repository"] }, ran: false });
  expect(i.gh.calls).toHaveLength(reads);                                                       // off made no read at all
});

test("AC5: no recorded argv carries --admin, --auto, a ref update or any API write, and a widened argv is refused before it reaches gh", async () => {
  const i = input({ 1: pr() }, [task(1, 1)]);
  await guardedMerge({ ...i.args, mode: "on" });
  for (const argv of allCalls) {
    expect(argv).not.toContain("--admin"); expect(argv).not.toContain("--auto"); expect(argv).not.toContain("--rebase"); expect(argv).not.toContain("--merge");
    if (argv[0] === "api") expect(argv.some(a => /^(-X|--method)$/.test(a) || /^(PATCH|PUT|DELETE|POST)$/.test(a) || /git\/refs|\/merges|\/merge\b/.test(a))).toBe(false);
    if (argv[0] === "pr" && argv[1] === "merge") expect(argv).toEqual(mergeArgv("owner/repo", Number(argv[2]), A));
  }
  const good = mergeArgv("owner/repo", 7, A);
  expect(() => assertMergeArgv(good, A)).not.toThrow();
  for (const bad of [[...good, "--admin"], [...good, "--auto"], ["api", "-X", "PATCH", "repos/owner/repo/git/refs/heads/main"], good.map(a => a === "--squash" ? "--merge" : a), good.map(a => a === A ? B : a), good.slice(0, -2), good.map(a => a === "owner/repo" ? "--repo=x" : a)])
    expect(() => assertMergeArgv(bad, A), bad.join(" ")).toThrow("guarded shape");
  expect(() => mergeArgv("owner/repo", 7, "abc")).toThrow();
  expect(() => mergeArgv("--bad/repo", 7, A)).toThrow();
});

test("AC6: a repository without branch protection is gated by its own [repos] table: a missing required check refuses", async () => {
  const bare = sdlcConfig({ mode: "advise", auto_merge: "on" });                                // no top-level required_checks
  const table = sdlcConfig({ mode: "advise", auto_merge: "on", repos: { "Owner/Repo": { required_checks: ["check (ubuntu-latest)", "check (macos-latest)"] } } });
  const world = { 1: pr({ checks: [{ name: "check (ubuntu-latest)", conclusion: "SUCCESS" }] }) };   // macos never reported
  expect(await refusals(input(world, [task(1, 1)], { config: bare }))).toEqual(["required checks unknown: name them in sdlc.toml"]);
  expect(await refusals(input(world, [task(1, 1)], { config: table }))).toEqual(["required check check (macos-latest): missing"]);
  expect(await decideMerge(input({ 1: pr({ checks: [{ name: "check (ubuntu-latest)", conclusion: "SUCCESS" }, { name: "check (macos-latest)", conclusion: "SUCCESS" }] }) }, [task(1, 1)], { config: table }).args)).toMatchObject({ action: "merge" });
  // The repo table comes first, then the top-level list, each name once.
  const both = sdlcConfig({ mode: "advise", required_checks: ["gate", "extra"], repos: { "owner/repo": { required_checks: ["extra", "mine"] } } });
  expect(requiredChecksFor(both, "OWNER/repo")).toEqual(["extra", "mine", "gate"]); expect(requiredChecksFor(both, "other/repo")).toEqual(["gate", "extra"]);
});

test("config: auto_merge defaults to off, a repo table overrides it, and unknown keys and values are refused with a field path", () => {
  expect(sdlcConfig(undefined)).toEqual({ mode: "off", requiredChecks: [], stages: ["spec", "plan", "implement", "review", "verify", "merge", "release"] });   // the off default keeps its shape
  expect(mergeModeFor(sdlcConfig({ mode: "advise" }), "owner/repo")).toBe("off");
  const c = sdlcConfig({ mode: "advise", auto_merge: "dry-run", repos: { "owner/repo": { auto_merge: "on" }, "owner/other": { required_checks: ["x"] } } });
  expect(mergeModeFor(c, "owner/repo")).toBe("on"); expect(mergeModeFor(c, "Owner/Other")).toBe("dry-run"); expect(mergeModeFor(c, "elsewhere/x")).toBe("dry-run"); expect(mergeModeFor(c, undefined)).toBe("dry-run");
  expect(() => sdlcConfig({ auto_merge: "yes" })).toThrow("sdlc.auto_merge: expected off, dry-run or on");
  expect(() => sdlcConfig({ repos: { "owner/repo": { auto_merge: "maybe" } } })).toThrow("sdlc.repos.owner/repo.auto_merge");
  expect(() => sdlcConfig({ repos: { "owner/repo": { admin: true } } })).toThrow("sdlc.repos.owner/repo.admin: unknown field");
  expect(() => sdlcConfig({ repos: { "--bad": {} } })).toThrow("owner/repository name");
  expect(() => sdlcConfig({ repos: { "owner/repo": {}, "OWNER/repo": {} } })).toThrow("repeats");
  expect(() => sdlcConfig({ repos: { "owner/repo": { required_checks: ["a", "a"] } } })).toThrow("sdlc.repos.owner/repo.required_checks");
  expect(() => sdlcConfig({ repos: [] })).toThrow("sdlc.repos");
  expect(() => sdlcConfig({ repos: { "owner/repo": "on" } })).toThrow("expected a table");
});

test("a merge that exits nonzero but landed on GitHub reads as merged, and one that did not land reads as not merged", async () => {
  const landed = input({ 1: pr() }, [task(1, 1)], {}, fakeGh({ 1: pr() }, { mergeExit: 1, mergeLands: true }));
  // The fake only lands on exit 0, so make the PR merged behind the call: the readback, not the exit code, decides.
  const prs = { 1: pr() }; const gh = fakeGh(prs, { mergeExit: 1 }); const base = gh.run;
  const wrapped: SdlcGh = async (args, ...rest) => { const r = await base(args, ...rest); if (args[1] === "merge") prs[1]!.state = "MERGED"; return r; };
  expect((await guardedMerge({ ...input(prs, [task(1, 1)], { run: wrapped }, gh).args, mode: "on" })).result).toEqual({ exit: 1, state: "merged", mergeCommit: MERGED });
  void landed;
  const stuck = fakeGh({ 1: pr() }, { mergeExit: 1 });
  expect((await guardedMerge({ ...input({ 1: pr() }, [task(1, 1)], {}, stuck).args, mode: "on" })).result).toEqual({ exit: 1, state: "not_merged" });
});

function rig(configValue: Record<string, unknown>, prs: Record<number, World>, ghOptions: Parameters<typeof fakeGh>[1] = {}, mode = "off") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-merge-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanups.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  const gh = fakeGh(prs, ghOptions);
  const tasks = new Tasks({ board, bus, cwd: dir, project: "test", repository: "owner/repo", roles: { claude: ["conductor"] }, routing: () => loadRouting(dir), notify: message => notices.push(message), sdlc: { config: () => sdlcConfig({ mode, required_checks: ["gate"], ...configValue }), gh: gh.run } });
  const proposed = board.propose(USER, { title: "secret-title-marker", class: "implement" });
  board.update(proposed.id, USER, "accepted", { owner: "codex", reviewer: USER, state: "in_progress" });
  tasks.recordLifecycle(USER, proposed.id, { repo: "owner/repo", issue: 2, pr: 1, localHead: A, localResult: "passed", stage: "implement" });
  return { board, tasks, id: proposed.id, notices, gh, dir };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Bun.sleep(5); };

test("an approving verdict at the PR's head merges in on mode, asynchronously, and never waits for the merge check", async () => {
  let release!: () => void; const hold = new Promise<void>(r => { release = r; });
  const r = rig({ auto_merge: "on" }, { 1: pr() }, { hold });
  await r.tasks.done("codex", r.id, "done");
  const approved = await r.tasks.review(USER, r.id, "approved", undefined, undefined, A);     // gh is held: the verdict still returns
  expect(approved.state).toBe("approved");
  expect(r.gh.calls).toHaveLength(0);
  release(); await settle();
  expect(r.gh.merges()).toEqual([["pr", "merge", "1", "--repo", "owner/repo", "--squash", "--match-head-commit", A]]);
  expect(r.notices.join("\n")).toContain("merged (squash, commit dddddddd)");
});

test("an approval at a stale head, or in off and dry-run, merges nothing; dry-run says what it would do", async () => {
  const stale = rig({ auto_merge: "on" }, { 1: pr({ head: B }) });
  await stale.tasks.done("codex", stale.id, "done");
  expect((await stale.tasks.review(USER, stale.id, "approved", undefined, undefined, A)).state).toBe("approved");
  await settle();
  expect(stale.gh.merges()).toHaveLength(0);
  const off = rig({}, { 1: pr() });
  await off.tasks.done("codex", off.id, "done"); await off.tasks.review(USER, off.id, "approved", undefined, undefined, A); await settle();
  expect(off.gh.calls).toHaveLength(0);                                                          // off: not even a read
  const dry = rig({ auto_merge: "dry-run" }, { 1: pr() });
  await dry.tasks.done("codex", dry.id, "done"); await dry.tasks.review(USER, dry.id, "approved", undefined, undefined, A); await settle();
  expect(dry.gh.merges()).toHaveLength(0); expect(dry.gh.calls.length).toBeGreaterThan(0);
  expect(dry.notices.join("\n")).toContain("auto-merge dry-run: would merge at aaaaaaaa");
});

test("the verdict still returns when the merge check throws or the merge fails, and says so in a notice", async () => {
  const boom = rig({ auto_merge: "on" }, { 1: pr() });
  (boom.tasks as unknown as { guardedMerge: () => Promise<never> }).guardedMerge = async () => { throw new Error("storage exploded"); };
  await boom.tasks.done("codex", boom.id, "done");
  expect((await boom.tasks.review(USER, boom.id, "approved", undefined, undefined, A)).state).toBe("approved");
  await settle();
  expect(boom.notices.join("\n")).toContain("auto-merge check unavailable"); expect(boom.board.get(boom.id)?.state).toBe("approved");
  const sync = rig({ auto_merge: "on" }, { 1: pr() });
  (sync.tasks as unknown as { guardedMerge: () => never }).guardedMerge = () => { throw new Error("sync throw"); };
  await sync.tasks.done("codex", sync.id, "done");
  expect((await sync.tasks.review(USER, sync.id, "approved", undefined, undefined, A)).state).toBe("approved");
  await settle(); expect(sync.notices.join("\n")).toContain("auto-merge check unavailable");
  const failing = rig({ auto_merge: "on" }, { 1: pr() }, { mergeExit: 1 });
  await failing.tasks.done("codex", failing.id, "done");
  expect((await failing.tasks.review(USER, failing.id, "approved", undefined, undefined, A)).state).toBe("approved");
  await settle(); expect(failing.notices.join("\n")).toContain("gh pr merge exited 1; GitHub reports it not merged");
});

test("Tasks.guardedMerge: only the person or the one conductor asks, --dry-run forces a report, and a PII task and its title never appear", async () => {
  const r = rig({ auto_merge: "on" }, { 1: pr() });
  await r.tasks.done("codex", r.id, "done"); await r.tasks.review(USER, r.id, "approved", undefined, undefined, A); await settle();
  r.gh.merges().length = 0;
  await expect(r.tasks.guardedMerge("codex", r.id)).rejects.toThrow("only the console user or the configured conductor");
  const dry = await r.tasks.guardedMerge("claude", r.id, { dryRun: true });
  expect(dry).toMatchObject({ task: r.id, mode: "dry-run", ran: false });
  // Everything printed or returned names the task number and gates, never its title.
  const mergeNotices = () => r.notices.filter(line => /merge/.test(line)).join("\n");
  expect(JSON.stringify(dry) + mergeNotices()).not.toContain("secret-title-marker"); expect(mergeNotices()).toContain("task #" + r.id + ": merged");
  const pii = rig({ auto_merge: "on" }, { 1: pr() });
  pii.board.update(pii.id, USER, "labeled", { signals: ["pii"] });
  const refused = await pii.tasks.guardedMerge(USER, pii.id);
  expect(refused).toMatchObject({ decision: "refused", refused: ["private task: a person merges"], ran: false });
  expect(pii.gh.calls).toHaveLength(0); expect(JSON.stringify(refused) + pii.notices.filter(line => /merge/.test(line)).join("\n")).not.toContain("secret-title-marker");
});

test("the control op always replies: a bad id, a missing task, an off repository and a dry run each get an answer, and no other peer may ask", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-merge-daemon-")), project = join(root, "project"), stateDir = join(project, "state");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(join(project, ".agenthub"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "merge-fixture", version: "1.0.0" }));
  writeFileSync(join(project, ".agenthub", "sdlc.toml"), 'mode = "advise"\nrequired_checks = ["gate"]\n');
  const board = new Board(join(stateDir, "hub.db")), made = board.propose(USER, { title: "fixture", class: "implement" });
  board.update(made.id, USER, "lifecycle", { sdlc: { repo: "owner/repo", issue: 2, pr: 1, stage: "merge" } }); board.close();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
    client = await ControlClient.connect(stateDir, { role: "console" });
    for (const id of [0, -1, 1.5, "x", undefined]) expect(await client.request({ t: "sdlc", op: "merge", id })).toMatchObject({ ok: false, error: "usage: ahub sdlc merge <task> [--dry-run]" });
    expect(await client.request({ t: "sdlc", op: "merge", id: 999 })).toMatchObject({ ok: false, error: expect.stringContaining("no task #999") });
    expect(await client.request({ t: "sdlc", op: "merge", id: made.id, dryRun: "yes" })).toMatchObject({ ok: false });
    // auto_merge is off in this file: the answer is a refusal that says so, and --dry-run reads (no gh here, so evidence is unavailable) without running anything.
    expect(await client.request({ t: "sdlc", op: "merge", id: made.id })).toMatchObject({ ok: true, decision: "refused", refused: ["auto_merge is off for this repository"], ran: false });
    expect(await client.request({ t: "sdlc", op: "merge", id: made.id, dryRun: true })).toMatchObject({ ok: true, mode: "dry-run", ran: false, decision: "refused" });
  } finally { client?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
});
