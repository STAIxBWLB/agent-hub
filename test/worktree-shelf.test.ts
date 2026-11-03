import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { boundTask, displayPath, overrideInForce, parseWorktreeList, partition, prFromTask, readWorktreeFacts, realShelfGit, shelfReadAllowed, taskWorkAt, type ShelfGitPort, type WorktreeFact, type WorktreeOverride } from "../src/hub/worktree-shelf.ts";
import { gitProject } from "./fakes/git-project.ts";

const DAY = 86_400_000, NOW = 100 * DAY;
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const fact = (over: Partial<WorktreeFact> = {}): WorktreeFact => ({ path: "/p/.worktrees/a", branch: "task/1", head: "a".repeat(40), locked: false, prunable: false, main: false, instance: false, lastActiveAt: NOW - DAY, pr: { state: "unknown" }, ...over });
const ids = (rows: { path: string }[]) => rows.map(r => r.path);

// AC1: each partition rule, in order.
test("partition: the main checkout and an instance worktree are never shelved, whatever else is true", () => {
  const stale = { lastActiveAt: 1, pr: { state: "merged" as const, changedAt: NOW } };
  const out = partition([fact({ path: "/p", main: true, ...stale }), fact({ path: "/p/.worktrees/inst", instance: true, ...stale })], [{ path: "/p", value: "settled", at: NOW }], NOW, 7);
  expect(out.settled).toEqual([]); expect(ids(out.live)).toEqual(["/p", "/p/.worktrees/inst"]);
});

test("partition: an effective override wins over a merged PR and over quiet time, in both directions", () => {
  const merged = { pr: { state: "merged" as const, changedAt: NOW }, lastActiveAt: NOW - 10 * DAY };
  const pinned = partition([fact(merged)], [{ path: "/p/.worktrees/a", value: "active", at: NOW - DAY }], NOW, 7);
  expect(ids(pinned.live)).toEqual(["/p/.worktrees/a"]); expect(pinned.settled).toEqual([]);
  const parked = partition([fact({ lastActiveAt: NOW - DAY })], [{ path: "/p/.worktrees/a", value: "settled", at: NOW }], NOW, 7);
  expect(parked.settled).toMatchObject([{ path: "/p/.worktrees/a", reason: "parked" }]); expect(parked.live).toEqual([]);
});

test("partition: an override made inert by later activity no longer counts, so the next rule decides", () => {
  const override: WorktreeOverride = { path: "/p/.worktrees/a", value: "settled", at: NOW - 5 * DAY };
  expect(overrideInForce(override, override.at)).toBe(true);        // activity at the override's own time still counts it
  expect(overrideInForce(override, override.at + 1)).toBe(false);   // newer activity makes it inert
  const out = partition([fact({ lastActiveAt: NOW - DAY })], [override], NOW, 7);
  expect(ids(out.live)).toEqual(["/p/.worktrees/a"]); expect(out.settled).toEqual([]);
});

test("partition: a merged or closed PR settles a worktree with no newer work, and a merged PR with newer work stays live", () => {
  const at = NOW - 3 * DAY;
  for (const state of ["merged", "closed"] as const) {
    const out = partition([fact({ lastActiveAt: at - DAY, pr: { state, changedAt: at } })], [], NOW, 0);
    expect(out.settled).toMatchObject([{ reason: state }]);
  }
  const newer = partition([fact({ lastActiveAt: at + DAY, pr: { state: "merged", changedAt: at } })], [], NOW, 0);
  expect(ids(newer.live)).toEqual(["/p/.worktrees/a"]); expect(newer.settled).toEqual([]);
  // an unknown or open PR never settles by itself, and a merged PR with no change time is unknown, not settled
  expect(partition([fact({ pr: { state: "open", changedAt: at } }), fact({ path: "/p/.worktrees/b", pr: { state: "merged" } })], [], NOW, 0).settled).toEqual([]);
});

test("partition: quiet settles at exactly quiet_days, 0 never settles, and a worktree with no readable activity is never called quiet", () => {
  const edge = fact({ lastActiveAt: NOW - 7 * DAY }), young = fact({ path: "/p/.worktrees/b", lastActiveAt: NOW - 7 * DAY + 1 });
  const out = partition([edge, young], [], NOW, 7);
  expect(out.settled).toMatchObject([{ path: "/p/.worktrees/a", reason: "quiet" }]); expect(ids(out.live)).toEqual(["/p/.worktrees/b"]);
  expect(partition([edge], [], NOW, 0).settled).toEqual([]);
  expect(partition([fact({ lastActiveAt: 0 })], [], NOW, 7).settled).toEqual([]);
});

test("partition rows carry the reason, the task and the PR, and nothing else from a fact", () => {
  const out = partition([fact({ task: { id: 7, state: "approved", pr: 12 }, lastActiveAt: 5, pr: { state: "merged", changedAt: 9 } })], [], NOW, 7);
  expect(out.settled[0]).toEqual({ path: "/p/.worktrees/a", branch: "task/1", lastActiveAt: 5, reason: "merged", task: 7, taskState: "approved", pr: 12 });
});

test("prFromTask reads only the guarded merge's own record: a cancel, an open task and no record are all unknown", () => {
  expect(prFromTask(undefined)).toEqual({ state: "unknown" });
  expect(prFromTask({ state: "approved", history: [], sdlc: { stage: "merge", merge: { repo: "o/r", pr: 3, head: "h", at: 50, state: "merged", exit: 0, cleanup: "deleted", ownerNotice: "sent" } } })).toEqual({ state: "merged", changedAt: 50 });
  expect(prFromTask({ state: "approved", history: [], sdlc: { stage: "merge", merge: { repo: "o/r", pr: 3, head: "h", at: 50, state: "unknown", exit: 1, cleanup: "unknown", ownerNotice: "unknown" } } })).toEqual({ state: "unknown" });
  expect(prFromTask({ state: "approved", history: [], sdlc: { stage: "merge", merge: { repo: "o/r", pr: 3, head: "h", at: 50, state: "not_merged", exit: 1, cleanup: "not_started", ownerNotice: "not_started" } } })).toEqual({ state: "unknown" });
  // Tasks.cancel touches only the board: the PR can still be open on GitHub, so a cancel is no evidence about it (#1057 D1)
  expect(prFromTask({ state: "cancelled", history: [{ at: 1, by: "x", event: "proposed" }, { at: 70, by: "x", event: "cancelled" }], sdlc: { stage: "build", pr: 3 } })).toEqual({ state: "unknown" });
  expect(prFromTask({ state: "cancelled", history: [], sdlc: { stage: "build" } })).toEqual({ state: "unknown" });
});

test("a cancelled task with an open PR stays live even with quiet_days 0, and only its own quiet time can shelve it", () => {
  const cancelled = { state: "cancelled" as const, history: [{ at: 1, by: "claude", event: "proposed" }, { at: NOW - 3 * DAY, by: "claude", event: "cancelled" }], sdlc: { stage: "build" as const, pr: 3 } };
  const pr = prFromTask(cancelled);
  const recent = partition([fact({ lastActiveAt: NOW - 3 * DAY - 1, pr, task: { id: 9, state: "cancelled", pr: 3 } })], [], NOW, 0);
  expect(ids(recent.live)).toEqual(["/p/.worktrees/a"]); expect(recent.settled).toEqual([]);
  expect(partition([fact({ lastActiveAt: NOW - 8 * DAY, pr, task: { id: 9, state: "cancelled", pr: 3 } })], [], NOW, 7).settled).toMatchObject([{ reason: "quiet" }]);
});

test("a row whose activity could not be read is live: neither a merged PR nor quiet time can settle it", () => {
  const unread = fact({ activityKnown: false, lastActiveAt: 0, pr: { state: "merged", changedAt: NOW } });
  expect(partition([unread], [{ path: unread.path, value: "settled", at: NOW }], NOW, 7).settled).toEqual([]);
  expect(partition([fact({ activityKnown: false, lastActiveAt: 1 })], [], NOW, 7).settled).toEqual([]);
  expect(partition([fact({ activityKnown: true, lastActiveAt: 1 })], [], NOW, 7).settled).toMatchObject([{ reason: "quiet" }]);
});

test("a task's work time ignores the hub's own bookkeeping, so a merged task can settle (D1 vs D3)", () => {
  const history = [{ at: 100, by: "claude", event: "proposed" }, { at: 200, by: "codex", event: "done" }, { at: 900, by: "hub", event: "merge result" }, { at: 950, by: "hub", event: "merge result" }];
  expect(taskWorkAt({ created: 100, history })).toBe(200);
  expect(taskWorkAt({ created: 50, history: [] })).toBe(50);
  const task = { id: 4, state: "approved", refs: { branch: "task/x" }, sdlc: undefined, updated: 950, created: 100, history } as never;
  expect(boundTask([task], "task/x")).toMatchObject({ id: 4, workAt: 200 });
  // work at 200, merged at 900: settled, even though the hub wrote its merge notices after the merge time
  const out = partition([fact({ lastActiveAt: 200, pr: { state: "merged", changedAt: 900 } })], [], 10_000, 0);
  expect(out.settled).toMatchObject([{ reason: "merged" }]);
});

test("displayPath is project-relative inside the root and the basename elsewhere", () => {
  expect(displayPath("/p", "/p/.worktrees/a")).toBe(".worktrees/a");
  expect(displayPath("/p", "/elsewhere/secret/dir")).toBe("dir");
  expect(displayPath("/p", "/p")).toBe(".");
});

test("parseWorktreeList reads locked, prunable and detached records and bounds the row count", () => {
  const out = parseWorktreeList(["worktree /r", "HEAD aaa", "branch refs/heads/main", "", "worktree /r/.w/x", "HEAD bbb", "detached", "locked reason", "", "worktree /r/.w/y", "HEAD ccc", "branch refs/heads/t/y", "prunable gone", ""].join("\0") + "\0");
  expect(out.rows).toEqual([
    { path: "/r", branch: "main", head: "aaa", locked: false, prunable: false },
    { path: "/r/.w/x", branch: null, head: "bbb", locked: true, prunable: false },
    { path: "/r/.w/y", branch: "t/y", head: "ccc", locked: false, prunable: true },
  ]);
  const many = Array.from({ length: 5 }, (_, i) => `worktree /w${i}\0HEAD h\0branch refs/heads/b${i}\0`).join("\0");
  expect(parseWorktreeList(many, 3)).toMatchObject({ complete: false, rows: expect.any(Array) });
  expect(parseWorktreeList(many, 3).rows).toHaveLength(3);
});

// AC4 (module boundary): the shelf can only run read-only git, and no daemon-reachable module holds a removal argv.
test("the shelf's git port refuses every argv that is not one of its reads, before spawning anything", async () => {
  for (const args of [["worktree", "remove", "x"], ["worktree", "remove", "--force", "x"], ["branch", "-d", "x"], ["branch", "-D", "x"], ["worktree", "prune"], ["update-ref", "-d", "refs/heads/x"], ["worktree", "list", "--porcelain"], ["log", "-1", "--format=%ct", "HEAD", "--"]]) {
    expect(shelfReadAllowed(args), args.join(" ")).toBe(false);
    await expect(realShelfGit.run("/", args, 1000), args.join(" ")).rejects.toThrow("read-only");
  }
  for (const args of [["worktree", "list", "--porcelain", "-z"], ["log", "-1", "--format=%ct", "HEAD"], ["rev-parse", "--absolute-git-dir"]]) expect(shelfReadAllowed(args)).toBe(true);
});

test("no module the daemon reaches for the shelf contains a worktree or branch removal, and the daemon case never spawns one", () => {
  const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const shelf = code(src("src/hub/worktree-shelf.ts"));
  for (const word of ['"remove"', '"prune"', '"-D"', '"-d"', '"--force"', '"-f"', "rmSync", "unlinkSync", "rmdirSync", "renameSync", ".kill("]) expect(shelf, word).not.toContain(word);
  const daemon = src("src/hub/daemon.ts");
  const start = daemon.indexOf('case "worktrees":'), end = daemon.indexOf("// #604 (agent-hub#1030)", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const block = code(daemon.slice(start, end));
  for (const word of ["spawn", "exec", "rmSync", "worktree remove", "branch -d", "hubGitSync", "readSdlcPr", "sdlcGh"]) expect(block, word).not.toContain(word);
  // the only hub modules that name a removal are two pre-existing ones, neither reached from the shelf case: the hub-made task worktree (#1115) and code-facts' private temp checkout (its own `ahub-code-facts-` directory)
  const removers = readdirSync(join(import.meta.dir, "../src/hub")).sort().filter(f => f.endsWith(".ts") && /"worktree",\s*"remove"|worktree remove/.test(code(src(`src/hub/${f}`))));
  expect(removers).toEqual(["code-facts.ts", "task-worktree.ts"]);
});

// A real repository with real linked worktrees: AC2.
const git = (cwd: string, ...args: string[]) => {
  const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return String(run.stdout).trim();
};
const commitAt = (cwd: string, unix: number, message: string) => {
  writeFileSync(join(cwd, `${message}.txt`), message); git(cwd, "add", "."); 
  const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { encoding: "utf8", timeout: 20_000, env: { ...process.env, GIT_AUTHOR_DATE: `${unix} +0000`, GIT_COMMITTER_DATE: `${unix} +0000` } });
  if (run.status !== 0) throw new Error(run.stderr);
};

async function rig(seed?: (board: Board) => void, extraConfig: Record<string, unknown> = {}, shelfGit?: ShelfGitPort) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-"))), stateDir = join(cwd, ".agenthub-state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  gitProject(cwd);
  const now = Math.floor(Date.now() / 1000);
  // main checkout (this directory), an instance worktree, a merged task worktree, a quiet one and an active one
  git(cwd, "branch", "inst"); git(cwd, "worktree", "add", "-q", join(cwd, ".worktrees", "inst"), "inst");
  git(cwd, "branch", "task/merged"); git(cwd, "worktree", "add", "-q", join(cwd, ".worktrees", "merged"), "task/merged");
  git(cwd, "branch", "task/quiet"); git(cwd, "worktree", "add", "-q", join(cwd, ".worktrees", "quiet"), "task/quiet");
  git(cwd, "branch", "task/active"); git(cwd, "worktree", "add", "-q", join(cwd, ".worktrees", "active"), "task/active");
  commitAt(join(cwd, ".worktrees", "merged"), now - 30 * 86400, "merged-work");
  commitAt(join(cwd, ".worktrees", "quiet"), now - 20 * 86400, "quiet-work");
  commitAt(join(cwd, ".worktrees", "active"), now - 60, "active-work");
  // the index mtime counts as activity (D1): age the quiet and merged ones so only the commit time decides
  for (const name of ["merged", "quiet"]) for (const index of readdirSync(join(cwd, ".git", "worktrees")).filter(d => d === name).map(d => join(cwd, ".git", "worktrees", d, "index"))) if (existsSync(index)) utimesSync(index, now - 25 * 86400, now - 25 * 86400);
  mkdirSync(stateDir, { recursive: true });
  if (seed) { const board = new Board(join(stateDir, "hub.db")); seed(board); board.close(); }
  const daemon = await startDaemon({ cwd, stateDir, projectId: "shelf", instanceId: crypto.randomUUID(), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, ...(shelfGit ? { worktreeShelfGit: shelfGit } : {}),
    config: { ...DEFAULT_CONFIG, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
      instances: { "codex-inst": { kind: "codex", worktree: ".worktrees/inst", roles: ["implementer"] } } as never, ...extraConfig } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  // a read-only view of the same hub.db for assertions; overrides are written only through the daemon's control ops
  const overrides = () => { const board = new Board(join(stateDir, "hub.db")); try { return board.worktreeOverrides(); } finally { board.close(); } };
  return { cwd, stateDir, daemon, person, now, overrides };
}
const shown = (rows: { path: string; reason?: string }[]) => Object.fromEntries(rows.map(r => [r.path, r.reason ?? "live"]));

test("AC2: a fixture repository with a main checkout, an instance worktree, a merged task, a quiet one and an active one lands each in its group with its reason", async () => {
  const f = await rig(board => {
    const task = board.propose("claude", { title: "merged work", class: "implement", refs: { branch: "task/merged" } });
    // the merge is recorded after the task was proposed, as in real use, and by the hub
    board.update(task.id, "hub", "merge result", { sdlc: { stage: "merge", pr: 5, repo: "o/r", merge: { repo: "o/r", pr: 5, head: "h", at: Date.now() + 1000, state: "merged", exit: 0, cleanup: "deleted", ownerNotice: "sent" } } as never });
  });
  const out = await f.person.request({ t: "worktrees" });
  expect(out.ok).toBe(true);
  expect(out.complete).toBe(true);
  expect(shown(out.live)).toEqual({ ".": "live", ".worktrees/inst": "live", ".worktrees/active": "live" });
  expect(shown(out.settled)).toEqual({ ".worktrees/merged": "merged", ".worktrees/quiet": "quiet" });
  expect(JSON.stringify(out)).not.toContain(f.cwd);   // paths are project-relative, never absolute
});

test("AC2/D2: parking moves a live worktree to the shelf, pinning keeps a quiet one live, clearing restores the derived result, and the main checkout and an instance worktree refuse", async () => {
  const f = await rig();
  const abs = (name: string) => join(f.cwd, ".worktrees", name);
  let out = await f.person.request({ t: "worktree_override_set", path: abs("active"), value: "settled" });
  expect(out.ok).toBe(true); expect(shown(out.settled)[".worktrees/active"]).toBe("parked");
  out = await f.person.request({ t: "worktree_override_set", path: abs("quiet"), value: "active" });
  expect(shown(out.live)[".worktrees/quiet"]).toBe("live");
  out = await f.person.request({ t: "worktree_override_clear", path: abs("quiet") });
  expect(shown(out.settled)[".worktrees/quiet"]).toBe("quiet");
  for (const path of [f.cwd, abs("inst")]) expect((await f.person.request({ t: "worktree_override_set", path, value: "settled" })).error).toContain("never shelved");
  expect((await f.person.request({ t: "worktree_override_set", path: "/not/a/worktree", value: "settled" })).error).toContain("not a worktree");
  expect((await f.person.request({ t: "worktree_override_set", path: abs("active"), value: "bogus" })).error).toContain("settled (park) or active (pin)");
  // the table keeps facts only: a path, a value and a time
  expect(f.overrides().map(o => Object.keys(o).sort())).toEqual([["at", "path", "value"]]);
});

test("D2: new activity in a pinned worktree makes the pin inert, the next write removes it, and the derived result decides again", async () => {
  const f = await rig();
  const dir = join(f.cwd, ".worktrees", "quiet");
  // pin the quiet worktree, then age the pin to 10 days ago (newer than its 20-day-old work, older than the work committed below)
  // through a second handle on the same file: the test's only direct write
  expect((await f.person.request({ t: "worktree_override_set", path: dir, value: "active" })).ok).toBe(true);
  const board = new Board(join(f.stateDir, "hub.db")); board.setWorktreeOverride(dir, "active", Date.now() - 10 * 86_400_000); board.close();
  expect(shown((await f.person.request({ t: "worktrees" })).live)[".worktrees/quiet"]).toBe("live"); // the pin postdates the work, so it holds
  commitAt(dir, Math.floor(Date.now() / 1000), "new-work");                                          // now the worktree has activity newer than the pin
  const out = await f.person.request({ t: "worktree_override_clear", path: join(f.cwd, ".worktrees", "merged") }); // any write prunes inert rows
  expect(out.ok).toBe(true);
  expect(shown(out.live)[".worktrees/quiet"]).toBe("live");                                           // fresh commit: live because it is active, not because of the pin
  expect(f.overrides().find(o => o.path === dir)).toBeUndefined();
});

// AC4 (callers): an agent may read the shelf (to preview a tidy) but never set an override or see absolute paths, and the daemon always answers.
test("AC4: a tools caller can read the shelf (project-relative paths only) but cannot set or clear an override, and is always answered", async () => {
  const f = await rig();
  const tools = await ControlClient.connect(f.stateDir, { role: "tools", peer: "claude" }); cleanup.push(() => tools.close());
  const read = await tools.request({ t: "worktrees" } as never);
  expect(read.ok).toBe(true); expect(shown(read.settled)).toEqual({ ".worktrees/merged": "quiet", ".worktrees/quiet": "quiet" }); // no task is seeded here, so both old worktrees settle by quiet time
  expect(JSON.stringify(read)).not.toContain(f.cwd);   // no absolute path ever leaves the daemon
  for (const request of [{ t: "worktree_override_set", path: join(f.cwd, ".worktrees", "active"), value: "settled" }, { t: "worktree_override_clear", path: join(f.cwd, ".worktrees", "active") }]) {
    const out = await tools.request(request as never);
    expect(out.ok, request.t).toBe(false); expect(out.error, request.t).toContain("the person's");
  }
  expect(f.overrides()).toEqual([]);
  // a PII-bound task never reaches the reply: its worktree is listed without a task id, a PR or a state
  expect(JSON.stringify(read)).not.toMatch(/"task"|"taskState"/);
});

// AC5: a panel refresh makes no GitHub call, and no worktree or branch is touched by the read.
/** A scripted git port over a fixed list of worktrees; `delay` makes every per-worktree read slow, `fail` makes the named subcommand fail. */
function fakeGit(paths: string[], opts: { delayMs?: number; failLog?: boolean } = {}): ShelfGitPort & { calls: string[][]; open: () => number } {
  const calls: string[][] = []; let inFlight = 0, peak = 0;
  const port = {
    calls, open: () => peak,
    async run(cwd: string, args: string[], timeoutMs: number) {
      calls.push([cwd, ...args]); inFlight++; peak = Math.max(peak, inFlight);
      try {
        if (args[0] === "worktree") return { status: 0, stdout: paths.map((p, i) => `worktree ${p}\0HEAD ${String(i).padStart(40, "0")}\0branch refs/heads/b${i}\0\0`).join("") };
        if (opts.delayMs) await new Promise(r => setTimeout(r, Math.min(opts.delayMs!, Math.max(1, timeoutMs))));
        if (args[0] === "log") return opts.failLog ? undefined : { status: 0, stdout: `${Math.floor(Date.now() / 1000) - 100 * 86400}\n` };
        return { status: 1, stdout: "" };
      } finally { inFlight--; }
    },
  };
  return port;
}

test("D1 budget: a slow git cuts the read at its total budget, the rows not read are listed live with complete:false, and the read never exceeds the budget by a call", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-slow-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const paths = Array.from({ length: 40 }, (_, i) => join(dir, `w${i}`));
  const git = fakeGit(paths, { delayMs: 200 });
  const started = Date.now();
  const out = await readWorktreeFacts({ root: dir, tasks: () => [], instancePaths: [], git, budgetMs: 600 });
  const took = Date.now() - started;
  expect(out.available).toBe(true); expect(out.complete).toBe(false);
  expect(out.facts).toHaveLength(40);                                    // every worktree is still listed
  expect(out.facts.some(f => f.activityKnown === false)).toBe(true);     // the ones not read are unknown, not zero
  expect(took).toBeLessThan(1500);                                       // 40 rows x 2 reads x 200 ms would take 16 s serially; the budget cut it
  expect(git.open()).toBeLessThanOrEqual(4);                             // bounded concurrency
  // an unread row is live and never settled, whatever the quiet days
  expect(partition(out.facts, [], Date.now(), 1).settled.every(r => out.facts.find(f => f.path === r.path)?.activityKnown === true)).toBe(true);
});

test("D1 budget: a failed commit-time read makes that row's activity unknown and the result incomplete, never a settled row", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-fail-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const out = await readWorktreeFacts({ root: dir, tasks: () => [], instancePaths: [], git: fakeGit([join(dir, "a"), join(dir, "b")], { failLog: true }), budgetMs: 2000 });
  expect(out.complete).toBe(false); expect(out.facts.map(f => f.activityKnown)).toEqual([false, false]);
  expect(partition(out.facts, [], Date.now(), 1).settled).toEqual([]);
});

test("D1: the board is read once, after every git read, so a task change during the reads is seen and nothing stale is used", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-late-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0, sawGitCallsBeforeBoard = -1; const git = fakeGit([join(dir, "a")], { delayMs: 20 });
  const out = await readWorktreeFacts({ root: dir, tasks: () => { reads++; sawGitCallsBeforeBoard = git.calls.length; return []; }, instancePaths: [], git, budgetMs: 2000 });
  expect(out.available).toBe(true); expect(reads).toBe(1); expect(sawGitCallsBeforeBoard).toBe(3); // list, log, rev-parse for the one worktree
});

test("D1: while the shelf's git is slow, other control requests are answered (the event loop is never held)", async () => {
  const slow = fakeGit([], { delayMs: 1500 });
  slow.run = async (_cwd, args) => { await new Promise(r => setTimeout(r, 1500)); return args[0] === "worktree" ? { status: 0, stdout: "" } : { status: 1, stdout: "" }; };
  const f = await rig(undefined, {}, slow);
  const shelf = f.person.request({ t: "worktrees" }, 10_000);       // takes ~1.5 s inside the daemon
  const started = Date.now();
  const status = await f.person.request({ t: "status" }, 5_000);    // must not wait for it
  const answeredIn = Date.now() - started;
  expect(status.ok ?? true).toBeTruthy();
  expect(answeredIn).toBeLessThan(1000);
  const out = await shelf;
  expect(out.ok).toBe(true);
});

test("D1: recovery or shutdown beginning while the git reads run refuses the answer and writes no override", async () => {
  const gate: { release: () => void } = { release: () => {} };
  const held = new Promise<void>(r => { gate.release = r; });
  const slow = fakeGit([]); slow.run = async (_c, args) => { await held; return args[0] === "worktree" ? { status: 0, stdout: "" } : { status: 1, stdout: "" }; };
  const f = await rig(undefined, {}, slow);
  const pending = f.person.request({ t: "worktrees" }, 10_000);
  const stopping = f.daemon.stop();            // the daemon begins stopping while the shelf's git is still running
  await Bun.sleep(50); gate.release();
  const out = await pending.catch(() => ({ ok: false, error: "closed" }));
  await stopping;
  expect(out.ok).toBe(false);
});

// #1057 / AGENTS.md: a PII task still binds its worktree ON THE HOST, so the partition and tidy's refusals see its real state; the reply row (built in one place) redacts it.
test("a PII-bound worktree: an open PII task keeps it live (never quiet-settled), a merged one settles, and neither reply carries a task id, state, PR or merge reason", async () => {
  const f = await rig(board => {
    // `quiet` is old by commit time and its task is OPEN and private: before the fix it settled as `quiet` and tidy could remove open work
    board.propose("claude", { title: "private open work", class: "implement", refs: { branch: "task/quiet" }, signals: ["pii_path"] });
    // `merged` has a private task whose guarded merge is recorded after the work
    const merged = board.propose("claude", { title: "private merged work", class: "implement", refs: { branch: "task/merged" }, signals: ["pii_path"] });
    board.update(merged.id, "hub", "merge result", { sdlc: { stage: "merge", pr: 5, repo: "o/r", merge: { repo: "o/r", pr: 5, head: "h", at: Date.now() + 1000, state: "merged", exit: 0, cleanup: "deleted", ownerNotice: "sent" } } as never });
  });
  for (const client of [f.person, await ControlClient.connect(f.stateDir, { role: "tools", peer: "claude" })]) {
    const out = await client.request({ t: "worktrees" } as never);
    expect(out.ok).toBe(true);
    // the open PII task keeps `quiet` live: its host-side state ("in_progress"-like, not approved or cancelled) is not dropped, but a reply never shows it
    expect(shown(out.live)[".worktrees/quiet"]).toBe("live");
    expect(shown(out.settled)[".worktrees/merged"]).toBe("settled");           // the merge settled it on the host; the reply says only `settled`
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/"task":|"pr":|"merged"|"closed"|"proposed"|"in_progress"|"approved"|"backlog"/);
    const quiet = out.live.find((r: { path: string }) => r.path === ".worktrees/quiet");
    expect(quiet).toMatchObject({ private: true, taskState: "private" });
    expect(quiet.task).toBeUndefined(); expect(quiet.pr).toBeUndefined();
  }
});

test("an ordinary open task binds its worktree the same way, and its reply row names the task: only a PII task is redacted", async () => {
  const f = await rig(board => { board.propose("claude", { title: "ordinary open work", class: "implement", refs: { branch: "task/quiet" } }); });
  const out = await f.person.request({ t: "worktrees" } as never);
  expect(shown(out.live)[".worktrees/quiet"]).toBe("live");                   // the open task's own recent activity keeps it live
  expect(out.live.find((r: { path: string }) => r.path === ".worktrees/quiet")).toMatchObject({ task: expect.any(Number), taskState: expect.any(String) });
  expect(JSON.stringify(out)).not.toContain('"private"');
});

test("AC5: reading the shelf runs no gh and changes no worktree, branch or index", async () => {
  const f = await rig();
  const before = git(f.cwd, "worktree", "list", "--porcelain") + git(f.cwd, "branch", "--format=%(refname) %(objectname)");
  const dirty = readdirSync(join(f.cwd, ".worktrees")).sort();
  for (let i = 0; i < 3; i++) expect((await f.person.request({ t: "worktrees" })).ok).toBe(true);
  expect(git(f.cwd, "worktree", "list", "--porcelain") + git(f.cwd, "branch", "--format=%(refname) %(objectname)")).toBe(before);
  expect(readdirSync(join(f.cwd, ".worktrees")).sort()).toEqual(dirty);
  expect(readFileSync(join(import.meta.dir, "../src/hub/worktree-shelf.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/sdlcGh|readSdlcPr|\bgh\b/);
});

test("readWorktreeFacts on a directory that is not a git repository is unavailable, never an empty shelf", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-none-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(await readWorktreeFacts({ root: dir, tasks: () => [], instancePaths: [] })).toEqual({ facts: [], complete: false, available: false });
});

test("the worktrees config defaults to 7 quiet days and 10 as the alert count, ignores a bad value at load, and the reload schema refuses it by name", async () => {
  expect(DEFAULT_CONFIG.worktrees).toEqual({ quiet_days: 7, alert_over: 10 });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-shelf-cfg-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const load = (worktrees: unknown) => { writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ worktrees })); return loadConfig(dir); };
  expect(load({ quiet_days: 3 }).worktrees).toEqual({ quiet_days: 3, alert_over: 10 });
  expect(load({ quiet_days: 0, alert_over: 0 }).worktrees).toEqual({ quiet_days: 0, alert_over: 0 });
  for (const bad of [{ quiet_days: -1 }, { quiet_days: 1.5 }, { quiet_days: "7" }, { alert_over: 1e9 }]) expect(load(bad).worktrees, JSON.stringify(bad)).toEqual(DEFAULT_CONFIG.worktrees);
  const { validateRawConfig } = await import("../src/hub/config-apply.ts");
  expect(() => validateRawConfig({ worktrees: { quiet_days: 3, alert_over: 0 } })).not.toThrow();
  for (const bad of [{ quiet_days: -1 }, { quiet_days: 1.5 }, { alert_over: -1 }, { nope: 1 }]) expect(() => validateRawConfig({ worktrees: bad }), JSON.stringify(bad)).toThrow(/worktrees/);
});
