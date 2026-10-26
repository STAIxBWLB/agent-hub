import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { taskShellSandboxRestrictions } from "../src/hub/task-shell-sandbox.ts";
import { hubGitArgv, hubGitSync } from "../src/hub/git.ts";
import { hostExecutable, hostShellPath } from "../src/hub/host-executable.ts";
import { realPath } from "../src/hub/project.ts";
import { hostShellEnvironment } from "../src/local/shell-environment.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";
import { sbplString } from "../src/local/deny.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const project = realPath(mkdtempSync(join(tmpdir(), "ahub-task-git-sandbox-"))), root = join(project, ".worktrees", "worker");
  cleanup.push(() => rmSync(project, { recursive: true, force: true }));
  // The execution directory must exist before canonical PATH screening, but Git worktree add owns its contents.
  mkdirSync(root, { recursive: true });
  const env = hostShellEnvironment({ HOME: project, PATH: hostShellPath(project, root)! });
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, ...args], { env, encoding: "utf8", timeout: 1000 });
    expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
  };
  git("init", "-q"); git("symbolic-ref", "HEAD", "refs/heads/main");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial");
  git("worktree", "add", "-qb", "task/worker", root);
  git("worktree", "add", "-qb", "task/other", join(project, ".worktrees", "other"));
  const common = realPath(join(project, ".git")), own = realPath(resolve(root, git("-C", root, "rev-parse", "--git-dir")));
  return { project, root, env, git, common, own, options: { projectRoot: project, env } };
}

test("task sandbox returns only additive denies for a proven linked worktree and bound branch", () => {
  const f = fixture(), restrictions = taskShellSandboxRestrictions(f.root, "task/worker", f.options)!;
  expect(restrictions).toBeDefined(); expect(restrictions).not.toContain("(allow ");
  expect(restrictions).toContain(`(subpath ${sbplString(f.common)})`);
  for (const file of [join(f.common, "refs/heads/task/worker"), join(f.common, "logs/refs/heads/task/worker"), join(f.own, "HEAD"), join(f.own, "index"), join(f.own, "COMMIT_EDITMSG"), join(f.own, "logs/HEAD")]) {
    expect(restrictions).toContain(`(literal ${sbplString(file)})`);
    expect(restrictions).toContain(`(literal ${sbplString(`${file}.lock`)})`);
  }
  expect(restrictions).toContain(`(literal ${sbplString(join(f.common, "objects"))})`);
  expect(restrictions).toContain(`(literal ${sbplString(dirname(join(f.common, "refs/heads/task/worker")))})`);
  expect(taskShellSandboxRestrictions(f.root, "task/other", f.options)).toBeUndefined();
  expect(taskShellSandboxRestrictions(f.project, "main", f.options)).toBeUndefined();
  expect(taskShellSandboxRestrictions(f.root, "task/worker", { ...f.options, env: { ...f.env, PATH: ".:/usr/bin:/bin" } })).toBeUndefined();
});

test("task sandbox refuses unknown reflog parents and hardlinked allowed metadata rather than widening directory writes", () => {
  const f = fixture();
  const logParent = join(f.common, "logs/refs/heads/task");
  rmSync(logParent, { recursive: true });
  expect(taskShellSandboxRestrictions(f.root, "task/worker", f.options)).toBeUndefined();
  mkdirSync(logParent);
  linkSync(join(f.own, "HEAD"), join(f.own, "HEAD.lock"));
  expect(taskShellSandboxRestrictions(f.root, "task/worker", f.options)).toBeUndefined();
});

test.skipIf(!sandboxAvailable())("Darwin task sandbox blocks other Git state and both module trees while own-branch add and commit work", async () => {
  const f = fixture(), restrictions = taskShellSandboxRestrictions(f.root, "task/worker", f.options)!;
  expect(restrictions).toBeDefined();
  const sandbox = `${profile(f.root, false)}\n${restrictions}`;
  const exec = (argv: string[]) => sandboxedExec(argv, { cwd: f.root, profile: sandbox, env: f.env, timeoutMs: 2000 });
  const other = join(f.common, "worktrees/other"), mainHead = readFileSync(join(f.common, "HEAD"), "utf8");
  const mainCommit = f.git("rev-parse", "refs/heads/main"), otherCommit = f.git("rev-parse", "refs/heads/task/other");
  for (const modules of [join(f.common, "modules"), join(f.own, "modules")]) {
    const target = join(modules, "precreate", "hooks"), result = await exec(["/bin/mkdir", "-p", target]);
    expect(result.code, target).not.toBe(0); expect(existsSync(target), target).toBe(false);
  }
  const targets = [
    join(f.common, "HEAD"), join(f.common, "index"), join(f.common, "packed-refs"), join(f.common, "config"),
    join(f.common, "config.worktree"), join(f.own, "config"), join(f.own, "hooks/pre-commit"),
    join(f.common, "refs/heads/main"), join(f.common, "refs/heads/task/other"), join(f.common, "refs/remotes/origin/main"),
    join(other, "HEAD"), join(other, "index"), join(f.own, "commondir"), join(f.own, "config.worktree"),
    join(f.common, "hooks/pre-commit"), join(f.common, "modules/new/config"), join(f.common, "modules/new/hooks/pre-commit"),
    join(f.own, "modules/new/config"), join(f.own, "modules/new/hooks/pre-commit"), join(f.common, "objects/info/alternates"),
  ];
  for (const target of targets) {
    // Create fixture parents outside the sandbox; the deny-only scope must protect both existing and newly named metadata.
    mkdirSync(dirname(target), { recursive: true });
    const before = existsSync(target) ? readFileSync(target) : undefined;
    const result = await exec(["/bin/sh", "-c", `printf unsafe > ${shellQuote(target)}`]);
    expect(result.code, target).not.toBe(0);
    if (before) expect(readFileSync(target), target).toEqual(before);
    else expect(existsSync(target), target).toBe(false);
  }
  for (const directory of [join(f.common, "refs/heads/task"), join(f.common, "objects"), f.own, other, join(f.common, "modules"), join(f.own, "modules")]) {
    const result = await exec(["/bin/mv", directory, `${directory}-replaced`]);
    expect(result.code, directory).not.toBe(0); expect(existsSync(directory), directory).toBe(true);
  }
  expect(readFileSync(join(f.common, "HEAD"), "utf8")).toBe(mainHead);
  writeFileSync(join(f.root, "owned.txt"), "own branch data\n");
  const executable = hostExecutable("git", f.root, f.env.PATH);
  const add = await exec([executable, ...hubGitArgv(["add", "--", "owned.txt"]).slice(1)]);
  expect(add.code, add.output).toBe(0);
  const commit = await exec([executable, ...hubGitArgv(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "own branch commit"]).slice(1)]);
  expect(commit.code, commit.output).toBe(0);
  expect(f.git("-C", f.root, "log", "-1", "--format=%s")).toBe("own branch commit");
  expect(f.git("rev-parse", "refs/heads/main")).toBe(mainCommit);
  expect(f.git("rev-parse", "refs/heads/task/other")).toBe(otherCommit);
  expect(readFileSync(join(f.common, "HEAD"), "utf8")).toBe(mainHead);
}, 20_000);

test.skipIf(!sandboxAvailable())("Darwin task sandbox cannot create a hardlink alias to overwrite readable protected Git metadata", async () => {
  const f = fixture(), otherConfig = join(f.common, "worktrees/other/config");
  writeFileSync(otherConfig, "[core]\n bare = false\n");
  const restrictions = taskShellSandboxRestrictions(f.root, "task/worker", f.options)!;
  expect(restrictions).toBeDefined();
  const sandbox = `${profile(f.root, false)}\n${restrictions}`;
  for (const original of [join(f.common, "HEAD"), join(f.common, "refs/heads/main"), otherConfig]) {
    const before = readFileSync(original);
    for (const alias of [join(f.root, "metadata-alias"), join(f.common, "objects", "metadata-alias")]) {
      const command = `/bin/ln ${shellQuote(original)} ${shellQuote(alias)} && printf unsafe > ${shellQuote(alias)}`;
      const result = await sandboxedExec(["/bin/sh", "-c", command], { cwd: f.root, profile: sandbox, env: f.env, timeoutMs: 2000 });
      expect(result.code, `${original} -> ${alias}`).not.toBe(0);
      expect(readFileSync(original), original).toEqual(before);
      rmSync(alias, { force: true });
    }
  }
}, 20_000);
