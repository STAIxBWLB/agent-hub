import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { TaskWorktrees } from "../src/hub/task-worktree.ts";

// #1115 AC3: with the REAL local sandbox profile (sandbox-exec), a hub-sandboxed peer edits the hub-made worktree and the commit is the hub's. Whether the peer's OWN `git commit` fails is not asserted here: main's profile does not refuse ref writes (#1123 does), so on a machine without commit signing it succeeds. The guarantee is the hub's commit-time check below.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ahub-task-worktree-sb-")); cleanup.push(() => rmSync(base, { recursive: true, force: true })); // registered before anything can throw
  const dir = realPath(base), root = join(dir, "project"), bare = join(dir, "origin.git"), state = join(dir, "state");
  mkdirSync(root); mkdirSync(state);
  const git = (cwd: string, ...args: string[]): string => {
    const run = hubGitSync(["-C", cwd, "-c", "user.name=fixture", "-c", "user.email=f@f.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main"); git(root, "config", "core.excludesFile", "/dev/null");
  writeFileSync(join(root, "a.txt"), "a\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(dir, "init", "-q", "--bare", "-b", "main", bare); git(root, "remote", "add", "origin", bare); git(root, "push", "-q", "origin", "main"); git(root, "remote", "set-head", "origin", "main");
  const worktrees = new TaskWorktrees({ root, stateFile: join(state, "task-worktrees.json"), applies: peer => peer === "pi", deny: () => [], protectInstructions: () => false, pushAllowed: urls => urls.every(url => url === bare) });
  return { dir, root, bare, git, worktrees, base: git(root, "rev-parse", "HEAD") };
}
const sh = (root: string, text: string, command: string) => sandboxedExec(["/bin/sh", "-c", command], { cwd: root, profile: text, timeoutMs: 30_000 }).then(result => result.output.trim());

test.skipIf(!sandboxAvailable())("#1115 the profile is the same before and after the hub makes a worktree, so nothing is rebuilt per task", () => {
  const f = fixture();
  const before = profile(f.root, false);
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  expect(profile(f.root, false)).toBe(before);
});

test.skipIf(!sandboxAvailable())("#1115 under the real sandbox profile the peer edits the hub-made worktree, and the commit is the hub's", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  const text = profile(f.root, false);
  // 1. the peer edits and creates files in the worktree, inside the profile's one writable root.
  expect(await sh(f.root, text, "echo peer-edit >> .worktrees/pi-7/a.txt && echo peer-new > .worktrees/pi-7/new.txt && echo EDITED")).toBe("EDITED");
  expect(readFileSync(join(made.path, "new.txt"), "utf8")).toBe("peer-new\n");
  // 2. it cannot give the worktree a gitfile or a config of its own.
  expect(await sh(f.root, text, "echo 'gitdir: /elsewhere' > .worktrees/pi-7/.git; echo $?")).toContain("Operation not permitted");
  const admin = f.git(made.path, "rev-parse", "--absolute-git-dir");
  expect(await sh(f.root, text, `echo '[core]' > '${admin}/config.worktree'; echo done`)).toContain("Operation not permitted");
  // 3. the hub stages and commits what the peer edited, and pushes the task branch.
  const done = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "Edit under the real profile" });
  expect(done.ok).toBe(true); if (!done.ok) throw new Error(done.reason);
  expect(done.pushed).toBe(true);
  expect(f.git(f.root, "rev-parse", `${done.commit}^`)).toBe(f.base);
  expect(f.git(f.root, "diff", "--name-status", f.base, done.commit).split("\n").sort()).toEqual(["A\tnew.txt", "M\ta.txt"]);
  expect(f.git(f.bare, "rev-parse", "refs/heads/task/7-pi")).toBe(done.commit);
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base);
});

test.skipIf(!sandboxAvailable())("#1115 what the profile still lets a sandboxed command write under .git is refused at commit time, never trusted: a moved ref and a moved HEAD", async () => {
  const f = fixture();
  const made = f.worktrees.create({ peer: "pi", task: 7 }); if (!made.ok) throw new Error(made.reason);
  const text = profile(f.root, false), admin = f.git(made.path, "rev-parse", "--absolute-git-dir");
  writeFileSync(join(made.path, "a.txt"), "edit\n");
  // The real profile allows these writes (it did before this feature: #864 closes config, hooks, commondir and packs, not refs or a worktree's HEAD).
  const planted = join(f.root, ".git/refs/heads/planted");
  expect(await sh(f.root, text, `echo ${"1".repeat(40)} > '${planted}' && echo REF-WRITTEN`)).toBe("REF-WRITTEN");
  expect(await sh(f.root, text, `echo 'ref: refs/heads/main' > '${join(admin, "HEAD")}' && echo HEAD-WRITTEN`)).toBe("HEAD-WRITTEN");
  const reason = await f.worktrees.commitAndPush({ peer: "pi", task: 7, title: "t" }).then(result => result.ok ? "" : result.reason);
  expect(reason).toContain("no longer on task/7-pi");
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base);
  expect(f.git(f.bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  expect(existsSync(join(f.root, ".git/refs/heads/planted"))).toBe(true); // reported by the refusal path above, not repaired by the hub: the person's call
});
