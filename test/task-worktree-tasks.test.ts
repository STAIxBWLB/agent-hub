import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
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

async function rig() {
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
  const tasks = new Tasks({ cwd, board, bus, project: "fixture", roles: { claude: ["planner"] }, routing: () => loadRouting(cwd), notify: line => notices.push(line), wipLimit: () => 5,
    sdlc: { config: () => sdlcConfig({ mode: "off" }) }, taskWorktree: worktrees,
    capabilities: () => ({ pi: { tests: true, spec: true, network: true, worktree: true }, codex: { tests: true, spec: true, network: true, worktree: true } }) });
  const offer = (owner: string, signals: string[] = ["needs_worktree"]) => { const row = board.propose("user", { title: "raise the pin", class: "implement", signals: signals as any }); board.update(row.id, "user", "assigned", { owner }); return row; };
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

test("a peer that makes its own worktree, and work that does not declare the need, get no hub worktree", async () => {
  const f = await rig();
  const own = f.offer("codex"); f.tasks.accept("codex", own.id);
  const plain = f.offer("pi", []); f.tasks.accept("pi", plain.id);
  expect(existsSync(join(f.cwd, ".worktrees"))).toBe(false); expect(f.branches()).toBe("");
  expect(f.tasks.worktreeNote(f.board.get(plain.id)!, "pi")).toBeUndefined();
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
