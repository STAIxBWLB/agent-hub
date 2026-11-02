import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { TaskWorktrees, taskWorktreeBranch, taskWorktreePath } from "../src/hub/task-worktree.ts";

// #1115: the hub makes the task worktree for a hub-sandboxed peer, commits and pushes it at hub_task_done, and clears it on decline or cancel. Real git, no mocks.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(options: { origin?: boolean; head?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), "ahub-task-worktree-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); // registered before anything can throw
  const dir = realPath(base), root = join(dir, "project"), bare = join(dir, "origin.git"), state = join(dir, "state");
  mkdirSync(root); mkdirSync(state);
  const git = (cwd: string, ...args: string[]): string => {
    const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=f@f.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.excludesFile", "/dev/null"); // a machine-wide ignore file must not decide what the hub stages in a test
  writeFileSync(join(root, "a.txt"), "a\n"); writeFileSync(join(root, "b.txt"), "b\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  if (options.origin !== false) {
    git(dir, "init", "-q", "--bare", "-b", "main", bare);
    git(root, "remote", "add", "origin", bare); git(root, "push", "-q", "origin", "main");
    if (options.head !== false) git(root, "remote", "set-head", "origin", "main");
  }
  let pushable = true;
  const worktrees = new TaskWorktrees({ root, stateFile: join(state, "task-worktrees.json"), applies: peer => peer === "pi" || peer === "local", deny: () => [], protectInstructions: () => false,
    pushAllowed: urls => pushable && urls.every(url => url === bare) });
  return { dir, root, bare, state, git, worktrees, setPushable: (value: boolean) => { pushable = value; }, base: git(root, "rev-parse", "HEAD") };
}
const refs = (git: ReturnType<typeof fixture>["git"], cwd: string) => git(cwd, "for-each-ref", "--format=%(refname)");

test("create makes the worktree at the fixed root on a new task branch at the recorded base, and a repeat is the same worktree", () => {
  const f = fixture();
  expect(f.worktrees.available()).toEqual({ ok: true });
  const made = f.worktrees.create({ peer: "pi", task: 7 });
  expect(made).toMatchObject({ ok: true, path: taskWorktreePath(f.root, "pi", 7), branch: taskWorktreeBranch("pi", 7), base: f.base, created: true });
  if (!made.ok) throw new Error("unreachable");
  expect(made.path).toBe(join(f.root, ".worktrees", "pi-7")); expect(made.branch).toBe("task/7-pi");
  expect(readFileSync(join(made.path, "a.txt"), "utf8")).toBe("a\n");
  expect(f.git(made.path, "rev-parse", "HEAD")).toBe(f.base); expect(f.git(made.path, "symbolic-ref", "HEAD")).toBe("refs/heads/task/7-pi");
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(f.base);
  expect(f.worktrees.create({ peer: "pi", task: 7 })).toMatchObject({ ok: true, created: false, path: made.path });
  expect(f.worktrees.describe("pi", 7)).toEqual({ path: made.path, branch: "task/7-pi", base: f.base });
  expect(refs(f.git, f.root).split("\n").filter(ref => ref.includes("task/"))).toEqual(["refs/heads/task/7-pi"]);
});

test("the base is origin/HEAD when the repository has one, not a local checkout that moved on", () => {
  const f = fixture();
  writeFileSync(join(f.root, "local-only.txt"), "x\n"); f.git(f.root, "add", "-A"); f.git(f.root, "commit", "-qm", "unpushed");
  const made = f.worktrees.create({ peer: "pi", task: 1 });
  expect(made).toMatchObject({ ok: true, base: f.base }); expect(f.git(f.root, "rev-parse", "HEAD")).not.toBe(f.base);
  expect(existsSync(join(f.root, ".worktrees", "pi-1", "local-only.txt"))).toBe(false);
});

test("create refuses before anything exists when the hub cannot make a worktree, naming the cause and the next step", () => {
  const plain = mkdtempSync(join(tmpdir(), "ahub-task-worktree-plain-")); cleanup.push(() => rmSync(plain, { recursive: true, force: true }));
  const root = realPath(plain), worktrees = new TaskWorktrees({ root, stateFile: join(root, "..", "never.json"), applies: () => true, deny: () => [], protectInstructions: () => false });
  const available = worktrees.available();
  expect(available).toMatchObject({ ok: false, reason: expect.stringContaining("not a git repository"), next: expect.stringContaining("git init") });
  const made = worktrees.create({ peer: "pi", task: 1 });
  expect(made).toMatchObject({ ok: false, reason: expect.stringContaining("not a git repository") });
  expect(existsSync(join(root, ".worktrees"))).toBe(false);
});

test("create refuses a branch or path that already exists, and a repository configuration that names a helper, and leaves nothing behind", () => {
  const f = fixture();
  f.git(f.root, "branch", "task/2-pi");
  expect(f.worktrees.create({ peer: "pi", task: 2 })).toMatchObject({ ok: false, reason: expect.stringContaining("branch task/2-pi already exists") });
  expect(existsSync(join(f.root, ".worktrees", "pi-2"))).toBe(false);
  mkdirSync(join(f.root, ".worktrees", "pi-3"), { recursive: true });
  expect(f.worktrees.create({ peer: "pi", task: 3 })).toMatchObject({ ok: false, reason: expect.stringContaining("already exists") });
  expect(f.git(f.root, "for-each-ref", "refs/heads/task/3-pi")).toBe("");
  f.git(f.root, "config", "filter.evil.clean", "cat");
  const refused = f.worktrees.create({ peer: "pi", task: 4 });
  expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("will not run git with it") });
  expect(f.git(f.root, "for-each-ref", "refs/heads/task/4-pi")).toBe("");
  expect(f.worktrees.create({ peer: "pi/../x", task: 5 })).toMatchObject({ ok: false });
});

test("after the peer's edits the hub stages, commits in the peer's name with no hook, and pushes exactly the task branch", async () => {
  const f = fixture();
  mkdirSync(join(f.root, ".git", "hooks"), { recursive: true });
  writeFileSync(join(f.root, ".git", "hooks", "pre-commit"), `#!/bin/sh\necho ran > "${join(f.dir, "hook-ran")}"\nexit 1\n`, { mode: 0o755 });
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "a changed\n"); writeFileSync(join(made.path, "new.txt"), "new\n"); rmSync(join(made.path, "b.txt"));
  mkdirSync(join(made.path, "deep/er"), { recursive: true }); writeFileSync(join(made.path, "deep/er/c.txt"), "c\n");
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "Raise the pin" });
  expect(done).toMatchObject({ ok: true, branch: "task/7-pi", pushed: true });
  if (!done.ok) throw new Error(done.reason);
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(done.commit);
  expect(f.git(f.root, "rev-parse", `${done.commit}^`)).toBe(f.base);
  expect(f.git(f.root, "log", "-1", "--format=%an|%ae|%s", done.commit)).toBe("pi|pi@agent-hub.invalid|Raise the pin");
  expect(f.git(f.root, "diff", "--name-status", f.base, done.commit).split("\n").sort()).toEqual(["A\tdeep/er/c.txt", "A\tnew.txt", "D\tb.txt", "M\ta.txt"]);
  expect(existsSync(join(f.dir, "hook-ran"))).toBe(false);
  expect(f.git(f.bare, "rev-parse", "refs/heads/task/7-pi")).toBe(done.commit);
  expect(f.git(f.bare, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/main", "refs/heads/task/7-pi"]);
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base); // the main checkout's branch was never touched
});

test("a branch the peer moved to another existing commit is refused: nothing is committed or pushed, and the cause names the next step", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "other.txt"), "o\n"); f.git(f.root, "add", "-A"); f.git(f.root, "commit", "-qm", "another commit");
  const other = f.git(f.root, "rev-parse", "HEAD");
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  f.git(f.root, "update-ref", "refs/heads/task/7-pi", other); // what a sandboxed command can do: .git/refs/heads is writable (#864)
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
  // ponytail: Bun replaces a received field that an asymmetric matcher matched; read it first (as test/runtime-capture-prune.test.ts does).
  const reason = done.ok ? "" : done.reason;
  expect(done.ok).toBe(false); expect(reason).toContain("not at the commit the hub recorded"); expect(reason).toContain("Decline the task");
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(other);
  expect(f.git(f.bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
});

test("a worktree whose HEAD the peer pointed elsewhere, or that is no longer registered, is refused", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  const admin = f.git(made.path, "rev-parse", "--absolute-git-dir");
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/main\n");
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("no longer on task/7-pi") });
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base);
  writeFileSync(join(admin, "HEAD"), "ref: refs/heads/task/7-pi\n");
  rmSync(admin, { recursive: true, force: true });
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("no longer registered") });
  expect(f.git(f.bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
});

test("a path the policy refuses blocks the whole commit: secrets, hub and agent names, a submodule, and the instruction files when protected", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  const cases: [string, (root: string) => void][] = [
    ["secret", root => writeFileSync(join(root, "deploy.key"), "KEY\n")],
    ["agent configuration", root => { mkdirSync(join(root, ".claude")); writeFileSync(join(root, ".claude/settings.json"), "{}\n"); }],
    ["hub name", root => { mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/config.json"), "{}\n"); }],
    ["submodule", root => { mkdirSync(join(root, "nested")); f.git(join(root, "nested"), "init", "-q"); f.git(join(root, "nested"), "commit", "-q", "--allow-empty", "-m", "n"); }],
  ];
  for (const [name, plant] of cases) {
    plant(made.path);
    const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
    expect(done, name).toMatchObject({ ok: false, reason: expect.stringContaining("will not commit 1 changed path") });
    expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi"), name).toBe(f.base);
    rmSync(join(made.path, name === "secret" ? "deploy.key" : name === "agent configuration" ? ".claude" : name === "hub name" ? ".agenthub" : "nested"), { recursive: true, force: true });
    expect(f.git(made.path, "diff", "--cached", "--name-only"), name).toBe(""); // the refused staging was undone
  }
  const guarded = new TaskWorktrees({ root: f.root, stateFile: join(f.state, "task-worktrees.json"), applies: () => true, deny: () => [], protectInstructions: () => true });
  writeFileSync(join(made.path, "AGENTS.md"), "x\n");
  expect(await guarded.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("protected instruction file") });
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: true });
});

test("a clean worktree is refused with the next step, and a repository configuration that names a helper refuses the commit", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("edit files there, then call hub_task_done again") });
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  f.git(f.root, "config", "diff.evil.textconv", "cat");
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("will not run git with it") });
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(f.base);
  expect(await f.worktrees.commitAndPush({ peer: "pi", task: 99, title: "t" })).toMatchObject({ ok: false, reason: expect.stringContaining("made no worktree") });
});

test("an origin that is not this project's repository blocks the push, the commit is kept, and a retry pushes that commit without a second one", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  f.setPushable(false);
  const first = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
  if (first.ok) throw new Error("unreachable");
  const firstCommit = first.commit!, firstReason = first.reason;
  expect(firstCommit).toMatch(/^[0-9a-f]{40}$/); expect(firstReason).toContain("origin is not this project's repository");
  expect(f.git(f.bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  f.setPushable(true);
  const retry = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
  expect(retry.ok).toBe(true); expect(retry.ok && retry.pushed).toBe(true); expect(retry.ok && retry.commit).toBe(firstCommit);
  expect(f.git(f.bare, "rev-parse", "refs/heads/task/7-pi")).toBe(firstCommit);
  expect(f.git(f.root, "rev-list", "--count", `${f.base}..${firstCommit}`)).toBe("1");
  // a later round of edits builds on the hub's own commit and is accepted, because the recorded tip moved with the hub's commit
  writeFileSync(join(made.path, "a.txt"), "second round\n");
  const second = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t2" });
  expect(second).toMatchObject({ ok: true, pushed: true }); if (!second.ok) throw new Error(second.reason);
  expect(f.git(f.root, "rev-parse", `${second.commit}^`)).toBe(firstCommit);
});

test("two parallel hub_task_done calls are serialized: one commit, and both answers carry it", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  const [one, two] = await Promise.all([f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" }), f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })]);
  expect(one).toMatchObject({ ok: true }); expect(two).toMatchObject({ ok: true });
  if (!one.ok || !two.ok) throw new Error("unreachable");
  expect(two.commit).toBe(one.commit); expect(f.git(f.root, "rev-list", "--count", `${f.base}..${one.commit}`)).toBe("1");
});

test("remove clears a clean worktree and its empty branch so no ref is left, and never force-removes uncommitted work", async () => {
  const f = fixture();
  const clean = f.worktrees.create({ peer: "pi", task: 1 }); if (!clean.ok) throw new Error(clean.reason);
  expect(f.worktrees.remove({ peer: "pi", task: 1 })).toEqual({ removed: true, branchDeleted: true });
  expect(existsSync(clean.path)).toBe(false); expect(f.git(f.root, "for-each-ref", "refs/heads/task/")).toBe("");
  expect(f.git(f.root, "worktree", "list", "--porcelain")).not.toContain("pi-1"); expect(f.worktrees.describe("pi", 1)).toBeUndefined();
  expect(f.worktrees.remove({ peer: "pi", task: 1 })).toEqual({ removed: false, branchDeleted: false });
  const dirty = f.worktrees.create({ peer: "pi", task: 2 }); if (!dirty.ok) throw new Error(dirty.reason);
  writeFileSync(join(dirty.path, "scratch.txt"), "work in progress\n");
  const kept = f.worktrees.remove({ peer: "pi", task: 2 });
  expect(kept).toMatchObject({ removed: false, branchDeleted: false, kept: expect.stringContaining("has uncommitted changes") });
  expect(readFileSync(join(dirty.path, "scratch.txt"), "utf8")).toBe("work in progress\n");
  expect(f.git(f.root, "rev-parse", "refs/heads/task/2-pi")).toBe(f.base); expect(f.worktrees.describe("pi", 2)).toBeDefined();
  writeFileSync(join(dirty.path, "a.txt"), "tracked edit\n"); rmSync(join(dirty.path, "scratch.txt"));
  expect(f.worktrees.remove({ peer: "pi", task: 2 })).toMatchObject({ removed: false, kept: expect.stringContaining("has uncommitted changes") });
});

test("remove keeps the branch the hub committed to, and a worktree that was deleted by hand is cleared", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" }); if (!done.ok) throw new Error(done.reason);
  expect(f.worktrees.remove({ peer: "pi", task: 7 })).toMatchObject({ removed: true, branchDeleted: false, kept: expect.stringContaining("has the hub's commit") });
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(done.commit); expect(existsSync(made.path)).toBe(false);
  const gone = f.worktrees.create({ peer: "pi", task: 8 }); if (!gone.ok) throw new Error(gone.reason);
  rmSync(gone.path, { recursive: true, force: true });
  expect(f.worktrees.remove({ peer: "pi", task: 8 })).toEqual({ removed: true, branchDeleted: true });
  expect(f.git(f.root, "for-each-ref", "refs/heads/task/8-pi")).toBe("");
});

test("a damaged record file is reported, never guessed at", () => {
  const f = fixture();
  writeFileSync(join(f.state, "task-worktrees.json"), "{not json");
  expect(f.worktrees.create({ peer: "pi", task: 1 })).toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
  expect(f.worktrees.remove({ peer: "pi", task: 1 })).toMatchObject({ removed: false, kept: expect.stringContaining("malformed") });
  expect(existsSync(join(f.root, ".worktrees"))).toBe(false);
});

test("an index the peer prepared is discarded: a skip-worktree flag it set cannot hide its own edit from the commit", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  // The peer can write the worktree's index (.git/worktrees/<name>/index is writable under the profile, #864). With skip-worktree set, `git add -A` leaves the edit out.
  f.git(made.path, "update-index", "--skip-worktree", "a.txt");
  writeFileSync(join(made.path, "a.txt"), "edit that the flag would hide\n"); writeFileSync(join(made.path, "b.txt"), "the other edit\n");
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" }); if (!done.ok) throw new Error(done.reason);
  expect(f.git(f.root, "diff", "--name-status", f.base, done.commit).split("\n").sort()).toEqual(["M\ta.txt", "M\tb.txt"]);
  expect(f.git(f.root, "show", `${done.commit}:a.txt`)).toBe("edit that the flag would hide");
});

// F-worktree-config-scope: the guard reads the REPOSITORY's config (--local, and --worktree where extensions.worktreeConfig is on), never the person's global or system config.
function lfsStyleConfig(): { file: string; restore: () => void } {
  const base = mkdtempSync(join(tmpdir(), "ahub-task-worktree-lfs-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); // registered before anything can throw
  const file = join(realPath(base), "gitconfig");
  writeFileSync(file, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n[diff "lfs"]\n\ttextconv = cat\n');
  const saved = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL };
  process.env.GIT_CONFIG_SYSTEM = file; process.env.GIT_CONFIG_GLOBAL = file;
  const restore = () => { for (const [key, value] of [["GIT_CONFIG_SYSTEM", saved.system], ["GIT_CONFIG_GLOBAL", saved.global]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  cleanup.push(restore);
  return { file, restore };
}

test("a git-lfs style filter in the person's system and global config does not switch the feature off: available, create and commit all work", async () => {
  const lfs = lfsStyleConfig();
  const f = fixture();
  expect(f.git(f.root, "config", "--get", "filter.lfs.clean")).toContain("git-lfs clean"); // the merged view does carry it, which is what the old guard refused
  expect(f.worktrees.available()).toEqual({ ok: true });
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
  expect(done.ok).toBe(true); if (!done.ok) throw new Error(done.reason);
  expect(f.git(f.root, "diff", "--name-status", f.base, done.commit)).toBe("M\ta.txt");
  expect(lfs.file.length).toBeGreaterThan(0);
});

test("a filter, textconv or include planted in the repository's own config still refuses, also beside a harmless global one", () => {
  lfsStyleConfig();
  for (const [key, value] of [["filter.evil.clean", "cat"], ["diff.evil.textconv", "cat"], ["include.path", "/tmp/evil.cfg"], ["core.sshCommand", "evil"], ["remote.origin.receivepack", "evil"]] as const) {
    const f = fixture();
    expect(f.worktrees.available(), "before").toEqual({ ok: true });
    f.git(f.root, "config", "--local", key, value);
    const fresh = new TaskWorktrees({ root: f.root, stateFile: join(f.state, "other.json"), applies: () => true, deny: () => [], protectInstructions: () => false });
    const available = fresh.available();
    expect(available.ok, key).toBe(false);
    expect(available.ok ? "" : available.reason, key).toContain("will not run git with it");
  }
});

test("a filter in a worktree's own config.worktree refuses when extensions.worktreeConfig is on, and is not read when it is off", async () => {
  lfsStyleConfig();
  const f = fixture();
  f.git(f.root, "config", "--local", "extensions.worktreeConfig", "true");
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  f.git(made.path, "config", "--worktree", "filter.wt.clean", "cat");
  const refused = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" });
  expect(refused.ok).toBe(false); expect(refused.ok ? "" : refused.reason).toContain("will not run git with it");
  expect(f.git(f.root, "rev-parse", "refs/heads/task/7-pi")).toBe(f.base);
  f.git(made.path, "config", "--worktree", "--unset", "filter.wt.clean");
  expect((await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" })).ok).toBe(true);
});
