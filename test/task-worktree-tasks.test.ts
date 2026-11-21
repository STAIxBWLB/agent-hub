import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { TaskWorktrees } from "../src/hub/task-worktree.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import type { Envelope } from "../src/hub/envelope.ts";

// #1115: Tasks.accept makes the hub-sandboxed owner's worktree before any write, a refusal leaves no ref, decline and cancel clear it, and hub_task_done carries the hub's commit.
class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function rig(options: { pushed?: boolean; gh?: SdlcGh; mode?: "off" | "advise" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "ahub-task-worktree-tasks-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); // registered before anything can throw
  const dir = realPath(base), cwd = join(dir, "project"), state = join(dir, "state");
  mkdirSync(cwd); mkdirSync(state); mkdirSync(join(cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(cwd, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\",\"codex\"]\n");
  const git = (...args: string[]): string => {
    const run = hubGitSync(["-C", cwd, "-c", "user.name=f", "-c", "user.email=f@f.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git("init", "-q", "-b", "main"); git("config", "core.excludesFile", "/dev/null");
  writeFileSync(join(cwd, "a.txt"), "a\n"); writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n.agenthub/\n"); git("add", "-A"); git("commit", "-qm", "base");
  const board = new Board(join(state, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => { bus.closeJournal(); board.close(); });
  for (const id of ["pi", "codex"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const worktrees = new TaskWorktrees({ root: cwd, stateFile: join(state, "task-worktrees.json"), applies: peer => peer === "pi" || peer === "local", deny: () => [], protectInstructions: () => false });
  if (options.pushed) git("remote", "add", "origin", "https://github.com/example/repo.git");
  const port = options.pushed ? {
    applies: worktrees.applies, available: () => worktrees.available(), create: worktrees.create.bind(worktrees), describe: worktrees.describe.bind(worktrees), remove: worktrees.remove.bind(worktrees),
    commitAndPush: async (input: Parameters<TaskWorktrees["commitAndPush"]>[0]) => { const result = await worktrees.commitAndPush(input); return result.ok ? { ...result, pushed: true } : result; },
  } : worktrees;
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: line => notices.push(line), wipLimit: () => 5,
    ...(options.pushed ? { repository: "example/repo" } : {}), sdlc: { config: () => sdlcConfig({ mode: options.mode ?? "off" }), ...(options.gh ? { gh: options.gh } : {}) }, taskWorktree: port,
    capabilities: () => ({ pi: { tests: true, spec: true, network: true, worktree: true }, codex: { tests: true, spec: true, network: true, worktree: true } }) });
  const offer = (owner: string, signals: string[] = ["needs_worktree"], cls: "implement" | "bulk_edit" | "test" | "summarize" | "triage" | "review" | "plan" = "implement") => { const row = board.propose("user", { title: "raise the pin", class: cls, signals: signals as any }); board.update(row.id, "user", "assigned", { owner }); return row; };
  return { cwd, state, board, tasks, worktrees, notices, git, offer, branches: () => git("for-each-ref", "--format=%(refname)", "refs/heads/task/") };
}

test("accepting worktree work as a hub-sandboxed peer makes the worktree on the task branch before the accept, and the answer says where to edit", async () => {
  const f = await rig();
  const row = f.offer("pi");
  const task = f.tasks.accept("pi", row.id);
  expect(task.state).toBe("in_progress");
  const path = join(f.cwd, ".worktrees", `pi-${row.id}`);
  expect(existsSync(join(path, "a.txt"))).toBe(true);
  expect(f.git("-C", path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${row.id}-pi`);
  expect(f.tasks.worktreeNote(task, "pi")).toContain(`the hub made ${path} on branch task/${row.id}-pi`);
  expect(f.tasks.worktreeNote(task, "pi")).toContain("do not run git");
  expect(f.tasks.accept("pi", row.id).state).toBe("in_progress"); // a repeated accept reuses it
  expect(f.branches()).toBe(`refs/heads/task/${row.id}-pi`);
});

for (const mode of ["off", "advise"] as const) test(`managed pushed worktree opens a draft PR and records its verified identity only on done (${mode})`, async () => {
  let f: Awaited<ReturnType<typeof rig>>, state: "missing" | "draft" | "ready" = "missing"; const calls: string[][] = [];
  const gh: SdlcGh = async args => {
    calls.push(args);
    if (args[0] === "api") return { code: 0, stdout: "main" };
    if (args[1] === "create") { state = "draft"; return { code: 0, stdout: "" }; }
    if (args[1] === "ready") { state = "ready"; return { code: 0, stdout: "" }; }
    return { code: 0, stdout: JSON.stringify(state === "missing" ? [] : [{ number: 32, state: "OPEN", headRefName: "task/1-pi", headRefOid: f.git("rev-parse", "task/1-pi"), isDraft: state === "draft", isCrossRepository: false, headRepository: { nameWithOwner: "example/repo" } }]) };
  };
  f = await rig({ pushed: true, gh, mode });
  const row = f.offer("pi"); f.board.update(row.id, "user", "link issue", { sdlc: { stage: "build", repo: "example/repo", issue: 7 } }); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  const refs = await f.tasks.worktreeHandoff("pi", row.id, undefined);
  expect(f.board.get(row.id)?.sdlc?.pr).toBeUndefined();
  const done = await f.tasks.done("pi", row.id, "finished", refs);
  expect(done.sdlc?.pr).toBe(32); expect(done.sdlc?.issue).toBe(7);
  expect(calls.find(args => args[1] === "create")?.join(" ")).toContain("Refs #7");
});

test("an origin change after push refuses PR creation without recording an identity", async () => {
  let f: Awaited<ReturnType<typeof rig>>; const calls: string[][] = [];
  const gh: SdlcGh = async args => { calls.push(args); f.git("remote", "set-url", "origin", "https://github.com/other/repo.git"); return { code: 0, stdout: "[]" }; };
  f = await rig({ pushed: true, gh }); const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  await expect(f.tasks.worktreeHandoff("pi", row.id, undefined)).rejects.toThrow("origin changed");
  expect(calls).toHaveLength(1); expect(f.board.get(row.id)?.sdlc?.pr).toBeUndefined();
});

test("an untrusted origin cannot dispatch GitHub PR calls", async () => {
  const calls: string[][] = [];
  const gh: SdlcGh = async args => { calls.push(args); return { code: 0, stdout: "[]" }; };
  const f = await rig({ pushed: true, gh }); const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  f.git("remote", "set-url", "origin", "https://github.com/other/repo.git");
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  await expect(f.tasks.worktreeHandoff("pi", row.id, undefined)).rejects.toThrow("origin is unavailable or changed");
  expect(calls).toHaveLength(0); expect(f.board.get(row.id)?.sdlc?.pr).toBeUndefined();
});

test("lost owner authority after the push stops the PR write and is reported as post-effect", async () => {
  let f: Awaited<ReturnType<typeof rig>>; const calls: string[][] = [];
  const gh: SdlcGh = async args => { calls.push(args); f.board.update(1, "user", "reassigned", { owner: "codex" }); return { code: 0, stdout: "[]" }; };
  f = await rig({ pushed: true, gh }); const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  let failure: unknown; try { await f.tasks.worktreeHandoff("pi", row.id, undefined); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("authority changed after the commit");
  expect(calls).toHaveLength(1); expect(f.board.get(row.id)?.sdlc?.pr).toBeUndefined();
});

test("an existing task PR is reused and a later done refusal reports the prior commit effect", async () => {
  const calls: string[][] = [];
  const gh: SdlcGh = async args => { calls.push(args); return { code: 1, stdout: "" }; };
  const f = await rig({ pushed: true, gh }); const row = f.offer("pi");
  f.board.update(row.id, "user", "link PR", { sdlc: { stage: "build", repo: "example/repo", pr: 32 } }); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  const refs = await f.tasks.worktreeHandoff("pi", row.id, undefined);
  expect(calls).toHaveLength(0);
  let error: unknown;
  try { await f.tasks.done("pi", row.id, "finished", refs, [{ path: "/outside", format: "md" }]); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(PreEffectToolRefusal);
  expect((error as Error).message).toContain("managed worktree was committed");
  expect(f.board.get(row.id)?.sdlc?.pr).toBe(32); expect(f.board.get(row.id)?.state).toBe("in_progress");
});

test("failed GitHub lookup reports the retained commit and retry reuses it", async () => {
  let f: Awaited<ReturnType<typeof rig>>, unavailable = true; const calls: string[][] = [];
  const gh: SdlcGh = async args => {
    calls.push(args);
    if (unavailable) return { code: 1, stdout: "" };
    return { code: 0, stdout: JSON.stringify([{ number: 32, state: "OPEN", headRefName: "task/1-pi", headRefOid: f.git("rev-parse", "task/1-pi"), isDraft: false, isCrossRepository: false, headRepository: { nameWithOwner: "example/repo" } }]) };
  };
  f = await rig({ pushed: true, gh }); const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited\n");
  let failure: unknown; try { await f.tasks.worktreeHandoff("pi", row.id, undefined); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(PreEffectToolRefusal);
  expect((failure as Error).message).toContain("branch was pushed"); expect(f.board.get(row.id)?.sdlc?.pr).toBeUndefined();
  const first = f.git("rev-parse", "task/1-pi"); unavailable = false;
  const refs = await f.tasks.worktreeHandoff("pi", row.id, undefined);
  expect(refs?.commit).toBe(first); expect((await f.tasks.done("pi", row.id, "finished", refs)).sdlc?.pr).toBe(32);
  expect(calls.filter(args => args[1] === "create")).toHaveLength(0);
});

test("a peer that makes its own worktree gets no hub worktree, and a read-only class that does not declare the need gets none either (#1129 AC1)", async () => {
  const f = await rig();
  const own = f.offer("codex"); f.tasks.accept("codex", own.id);
  const own2 = f.offer("codex", []); f.tasks.accept("codex", own2.id); // unflagged write-class work by a peer that commits itself: no hub worktree
  for (const cls of ["test", "summarize", "triage", "plan"] as const) { const row = f.offer("pi", [], cls); f.tasks.accept("pi", row.id); expect(f.tasks.worktreeNote(f.board.get(row.id)!, "pi"), cls).toBeUndefined(); }
  expect(existsSync(join(f.cwd, ".worktrees"))).toBe(false); expect(f.branches()).toBe("");
});

test("an UNFLAGGED implement or bulk_edit task accepted by a hub-sandboxed peer gets the hub worktree, and a declared read-only class still gets one (#1129 AC1)", async () => {
  const f = await rig();
  for (const cls of ["implement", "bulk_edit"] as const) {
    const row = f.offer("pi", [], cls);
    expect(f.board.get(row.id)!.signals).not.toContain("needs_worktree");
    const task = f.tasks.accept("pi", row.id);
    const path = join(f.cwd, ".worktrees", `pi-${row.id}`);
    expect(existsSync(join(path, "a.txt")), cls).toBe(true);
    expect(f.git("-C", path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${row.id}-pi`);
    expect(f.tasks.worktreeNote(task, "pi")).toContain(`the hub made ${path}`);
  }
  const declared = f.offer("pi", ["needs_worktree"], "test"); f.tasks.accept("pi", declared.id);
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${declared.id}`))).toBe(true); // an explicit declaration still wins for a read-only class
});

test("the hub commits an unflagged task's worktree at hub_task_done, and decline and cancel clear it as for a flagged one (#1129 AC3)", async () => {
  const f = await rig();
  const row = f.offer("pi", []); f.tasks.accept("pi", row.id);
  writeFileSync(join(f.cwd, ".worktrees", `pi-${row.id}`, "a.txt"), "edited by the peer\n");
  const refs = await f.tasks.worktreeHandoff("pi", row.id, { paths: ["a.txt"] });
  expect(refs).toMatchObject({ branch: `task/${row.id}-pi`, commit: f.git("rev-parse", `refs/heads/task/${row.id}-pi`) });
  const declined = f.offer("pi", [], "bulk_edit"); f.tasks.accept("pi", declined.id);
  await f.tasks.decline("pi", declined.id, "cannot do this");
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${declined.id}`))).toBe(false);
  const cancelled = f.offer("pi", []); f.tasks.accept("pi", cancelled.id);
  await f.tasks.cancel(cancelled.id, "user", { reason: "no longer needed" });
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${cancelled.id}`))).toBe(false);
  expect(f.branches()).toBe(`refs/heads/task/${row.id}-pi`); // only the committed task's branch is left
});

test("a PII task gets no hub worktree even when it is write-class (#1129 AC1)", async () => {
  const f = await rig();
  const row = f.board.propose("user", { title: "fix the grade export", class: "implement", signals: ["pii"] });
  f.board.update(row.id, "user", "assigned", { owner: "pi" });
  f.tasks.accept("pi", row.id);
  expect(existsSync(join(f.cwd, ".worktrees"))).toBe(false); expect(f.branches()).toBe("");
  expect(f.tasks.worktreeNote(f.board.get(row.id)!, "pi")).toBeUndefined();
});

test("a self-claim of write-class work by a hub-sandboxed peer makes the worktree and carries the note; with no worktree possible the claim stays an assignment (#1129)", async () => {
  const f = await rig();
  const made = await f.tasks.propose("pi", { title: "rename a helper", class: "implement", owner: "pi" });
  expect(f.board.get(made.id)).toMatchObject({ state: "in_progress", owner: "pi" });
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${made.id}`))).toBe(true);
  expect(f.tasks.claimRoleGuidance(f.board.get(made.id)!, "pi")).toContain("the hub made");
  const blocked = await rig();
  blocked.git("branch", "task/1-pi"); // the first task id is 1, so the hub cannot make its worktree
  const refused = await blocked.tasks.propose("pi", { title: "rename another helper", class: "implement", owner: "pi" });
  expect(refused.id).toBe(1);
  expect(blocked.board.get(1)).toMatchObject({ state: "proposed", owner: "pi" });
  expect(blocked.notices.some(line => line.includes("the hub could not make one for pi") && line.includes("is not started"))).toBe(true);
  expect(existsSync(join(blocked.cwd, ".worktrees", "pi-1"))).toBe(false);
});

test("a refused accept leaves no ref and no directory, changes no task, and names the cause and the next step", async () => {
  const f = await rig();
  const row = f.offer("pi");
  f.git("branch", `task/${row.id}-pi`); // the branch name is taken, so the hub cannot make the worktree
  const before = JSON.stringify(f.board.get(row.id));
  let failure: unknown;
  try { f.tasks.accept("pi", row.id); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal);
  const text = (failure as Error).message;
  expect(text).toContain("the hub could not make one for pi"); expect(text).toContain(`task/${row.id}-pi already exists`); expect(text).toContain("no branch ref is left behind"); expect(text).toContain("Decline the task");
  expect(JSON.stringify(f.board.get(row.id))).toBe(before);
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${row.id}`))).toBe(false);
  expect(f.branches()).toBe(`refs/heads/task/${row.id}-pi`); // only the branch that was already there
});

test("an accept that fails after the hub made the worktree clears it again, so the failed accept leaves no ref", async () => {
  const f = await rig();
  const row = f.offer("pi");
  const update = f.board.update.bind(f.board);
  f.board.update = ((...args: Parameters<Board["update"]>) => { if (args[2] === "accepted") throw new Error("storage unavailable"); return update(...args); }) as Board["update"];
  expect(() => f.tasks.accept("pi", row.id)).toThrow("storage unavailable");
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${row.id}`))).toBe(false); expect(f.branches()).toBe("");
  expect(f.git("worktree", "list", "--porcelain")).not.toContain(`pi-${row.id}`);
});

test("decline and cancel clear the hub-made worktree and its empty branch, and uncommitted work is reported and kept", async () => {
  const f = await rig();
  const declined = f.offer("pi"); f.tasks.accept("pi", declined.id);
  await f.tasks.decline("pi", declined.id, "cannot do this");
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${declined.id}`))).toBe(false); expect(f.branches()).toBe("");
  const cancelled = f.offer("pi"); f.tasks.accept("pi", cancelled.id);
  await f.tasks.cancel(cancelled.id, "user", { reason: "no longer needed" });
  expect(existsSync(join(f.cwd, ".worktrees", `pi-${cancelled.id}`))).toBe(false); expect(f.branches()).toBe("");
  const dirty = f.offer("pi"); f.tasks.accept("pi", dirty.id);
  const path = join(f.cwd, ".worktrees", `pi-${dirty.id}`);
  writeFileSync(join(path, "scratch.txt"), "work in progress\n");
  await f.tasks.cancel(dirty.id, "user", { reason: "dropped" });
  expect(existsSync(join(path, "scratch.txt"))).toBe(true);
  expect(f.notices.some(line => line.includes(`task #${dirty.id}`) && line.includes("has uncommitted changes"))).toBe(true);
});

test("hub_task_done carries the hub's commit: the worktree is committed first, the refs name its head and branch, and a refusal leaves the board alone", async () => {
  const f = await rig();
  const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  const path = join(f.cwd, ".worktrees", `pi-${row.id}`);
  const before = JSON.stringify(f.board.get(row.id));
  let failure: unknown;
  try { await f.tasks.worktreeHandoff("pi", row.id, undefined); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(PreEffectToolRefusal); expect((failure as Error).message).toContain("edit files there, then call hub_task_done again");
  expect(JSON.stringify(f.board.get(row.id))).toBe(before);
  writeFileSync(join(path, "a.txt"), "edited by the peer\n");
  const refs = await f.tasks.worktreeHandoff("pi", row.id, { paths: ["a.txt"] });
  expect(refs).toMatchObject({ branch: `task/${row.id}-pi`, commit: f.git("rev-parse", `refs/heads/task/${row.id}-pi`), paths: ["a.txt"] });
  expect(f.git("log", "-1", "--format=%an|%s", refs!.commit!)).toBe("pi|raise the pin");
  expect(f.tasks.takeDoneNote(row.id)).toContain("not pushed");
  expect(await f.tasks.worktreeHandoff("codex", row.id, undefined)).toBeUndefined(); // codex makes its own worktree and commits itself
  let stranger: unknown;
  try { await f.tasks.worktreeHandoff("local", row.id, undefined); } catch (error) { stranger = error; }
  expect(stranger).toBeInstanceOf(PreEffectToolRefusal); // a sandboxed peer that does not own the task is refused before any git call
  expect(await f.tasks.worktreeHandoff("user", row.id, undefined)).toBeUndefined();
});


test("managed check commits the exact tree, reuses its head, and later handoff builds on it (#1549)", async () => {
  const f = await rig();
  const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  const worktree = join(f.cwd, ".worktrees", `pi-${row.id}`);
  writeFileSync(join(worktree, "a.txt"), "first edit\n");
  const first = await f.tasks.worktreeForCheck("pi", row.id, () => true);
  if (!first?.refs.commit) throw new Error("missing managed check commit");
  expect(first.refs.commit).toBe(f.git("rev-parse", `task/${row.id}-pi`));
  expect(first?.refs.branch).toBe(`task/${row.id}-pi`);
  const repeat = await f.tasks.worktreeForCheck("pi", row.id, () => true);
  expect(repeat?.refs.commit).toBe(first?.refs.commit);
  expect(repeat?.history.length).toBe(first?.history.length);
  writeFileSync(join(worktree, "a.txt"), "second edit\n");
  const final = await f.tasks.worktreeHandoff("pi", row.id, undefined);
  expect(f.git("rev-parse", `${final!.commit}^`)).toBe(first.refs.commit);
  expect(await f.tasks.worktreeForCheck("codex", row.id, () => true)).toBeUndefined();
});

test("managed check refuses protected paths and revoked authority without recording refs (#1549)", async () => {
  const f = await rig(); const row = f.offer("pi"); f.tasks.accept("pi", row.id);
  const worktree = join(f.cwd, ".worktrees", `pi-${row.id}`);
  writeFileSync(join(worktree, ".env"), "secret\n");
  await expect(f.tasks.worktreeForCheck("pi", row.id, () => true)).rejects.toThrow("will not commit");
  expect(f.board.get(row.id)?.refs.commit).toBeUndefined();
  await expect(f.tasks.worktreeForCheck("pi", row.id, () => false)).rejects.toThrow("check unavailable");
  expect(f.board.get(row.id)?.refs.commit).toBeUndefined();
});
