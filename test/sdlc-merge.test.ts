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

interface World { head: string; draft: boolean; branch: string; state: "OPEN" | "MERGED"; review: "APPROVED" | "CHANGES_REQUESTED" | null; threads: number; paths: string[]; checks: { name: string; conclusion?: string; status?: string }[] }
const pr = (patch: Partial<World> = {}): World => ({ head: A, draft: false, branch: "feat/786", state: "OPEN", review: null, threads: 0, paths: ["src/a.ts"], checks: [{ name: "gate", conclusion: "SUCCESS" }], ...patch });

function fakeGh(prs: Record<number, World>, options: { mergeExit?: number; mergeLands?: boolean; hold?: Promise<void> } = {}) {
  const calls: string[][] = [];
  const view = (n: number) => { const p = prs[n]!; return { headRefOid: p.head, headRefName: p.branch, isDraft: p.draft, baseRefName: "main", baseRefOid: BASE, state: p.state, changedFiles: p.paths.length, statusCheckRollup: p.checks, reviewDecision: p.review, reviewRequests: [], files: p.paths.map(path => ({ path, changeType: "MODIFIED" })), mergeCommit: p.state === "MERGED" ? { oid: MERGED } : undefined }; };
  const run: SdlcGh = async args => {
    await options.hold;
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
          reviewRequests: { nodes: [], pageInfo: { hasNextPage: false } }, reviewThreads: { nodes: Array.from({ length: p.threads }, () => ({ isResolved: false })), pageInfo: { hasNextPage: false } },
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
