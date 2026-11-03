import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { HFS_IGNORABLE_POINTS, hubWriteRegexes } from "../src/local/deny.ts";
import { profile, sandboxAvailable, sandboxedExec } from "../src/local/sandbox.ts";

// #1123: a hub-sandboxed peer may not move what a branch, HEAD or a linked worktree points at. Real sandbox-exec, in the main checkout and in a hub-made worktree (#1115).
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const ZWJ = HFS_IGNORABLE_POINTS[1]!;

function repo(parent = "") {
  const made = mkdtempSync(join(tmpdir(), "ahub-git-refs-")); cleanup.push(() => rmSync(made, { recursive: true, force: true })); // registered before anything can throw
  const dir = realPath(made), outer = parent ? join(dir, parent) : dir, root = join(outer, "main"), state = join(dir, "state");
  mkdirSync(root, { recursive: true }); mkdirSync(state);
  const git = (cwd: string, ...args: string[]): string => {
    const run = hubGitSync(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 30_000 });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(root, "init", "-q", "-b", "main"); git(root, "config", "core.excludesFile", "/dev/null");
  writeFileSync(join(root, "a.txt"), "a\n"); writeFileSync(join(root, ".gitignore"), ".worktrees/\n"); git(root, "add", "-A"); git(root, "commit", "-qm", "base");
  git(root, "tag", "v1"); git(root, "pack-refs", "--all"); // a real packed-refs file to try to overwrite
  // The layout #1115 makes (`.worktrees/<peer>-<task>` on `task/<task>-<peer>`), made here with the hub's own hardened git so this file does not depend on that module.
  const wt = join(root, ".worktrees", "pi-1");
  git(root, "worktree", "add", "-q", "-b", "task/1-pi", wt, "HEAD");
  return { root, wt, git, common: join(root, ".git"), admin: git(wt, "rev-parse", "--absolute-git-dir"), base: git(root, "rev-parse", "HEAD") };
}
const sh = (cwd: string, command: string) => sandboxedExec(["/bin/sh", "-c", command], { cwd, profile: profile(cwd, false), timeoutMs: 40_000 }).then(result => result.output);
const attempt = (path: string, label: string) => `(mkdir -p '${path.replace(/\/[^/]*$/, "")}' && echo x > '${path}') 2>/dev/null && echo WROTE-${label} || echo refused-${label}`;

test.skipIf(!sandboxAvailable())("the profile refuses refs, HEAD, packed-refs and the worktree admin dir, from the main checkout and from a hub-made worktree (#1123 AC1)", async () => {
  const f = repo();
  const paths: [string, string][] = [
    ["new-branch", join(f.common, "refs/heads/zz")], ["main-branch", join(f.common, "refs/heads/main")], ["nested-branch", join(f.common, "refs/heads/a/b/c")], ["tag", join(f.common, "refs/tags/zz")],
    ["stash", join(f.common, "refs/stash")], ["remote-ref", join(f.common, "refs/remotes/origin/main")], ["packed-refs", join(f.common, "packed-refs")], ["packed-refs-lock", join(f.common, "packed-refs.lock")],
    ["common-HEAD", join(f.common, "HEAD")], ["common-HEAD-lock", join(f.common, "HEAD.lock")],
    ["wt-HEAD", join(f.admin, "HEAD")], ["wt-index", join(f.admin, "index")], ["wt-logs", join(f.admin, "logs/HEAD")], ["wt-new-file", join(f.admin, "zz")], ["wt-ORIG_HEAD", join(f.admin, "ORIG_HEAD")],
    ["a-new-worktree-admin-dir", join(f.common, "worktrees/evil/HEAD")],
  ];
  for (const [rootName, cwd] of [["main checkout", f.root], ["hub-made worktree", f.wt]] as const) {
    const out = await sh(cwd, paths.map(([label, path]) => attempt(path, label)).join("; "));
    for (const [label] of paths) expect(out, `${rootName}: ${label}\n${out}`).toContain(`refused-${label}`);
    expect(out, rootName).not.toMatch(/WROTE-/);
  }
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base);
  expect(f.git(f.root, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort()).toEqual(["refs/heads/main", "refs/heads/task/1-pi"]);
  expect(existsSync(join(f.common, "worktrees/evil"))).toBe(false);
});

test.skipIf(!sandboxAvailable())("a sandboxed commit, branch, tag, stash and switch are refused with no ref moved, and the hub's own commit still lands (#1123, #1115)", async () => {
  const f = repo();
  const ident = "-c user.name=t -c user.email=t@t.invalid -c commit.gpgsign=false";
  for (const [name, cwd] of [["main checkout", f.root], ["hub-made worktree", f.wt]] as const) {
    const out = await sh(cwd, ["echo dirty >> a.txt", `git ${ident} commit -q --allow-empty -m x && echo COMMITTED || echo blocked-commit`, "git branch zz && echo BRANCHED || echo blocked-branch", "git tag zz && echo TAGGED || echo blocked-tag", `git ${ident} stash -q && echo STASHED || echo blocked-stash`, "git switch -q -c yy && echo SWITCHED || echo blocked-switch", "git update-ref refs/heads/zz HEAD && echo UPDATED || echo blocked-update-ref", "git symbolic-ref HEAD refs/heads/other && echo MOVED-HEAD || echo blocked-symbolic-ref"].join("; "));
    for (const expected of ["blocked-commit", "blocked-branch", "blocked-tag", "blocked-stash", "blocked-switch", "blocked-update-ref", "blocked-symbolic-ref"]) expect(out, `${name}\n${out}`).toContain(expected);
    expect(out, name).not.toMatch(/\b(COMMITTED|BRANCHED|TAGGED|STASHED|SWITCHED|UPDATED|MOVED-HEAD)\b/);
  }
  expect(f.git(f.root, "rev-parse", "main")).toBe(f.base);
  // The hub's own git runs outside the sandbox, so its add, commit and branch writes still land after the peer's edits. (#1115's TaskWorktrees.commitAndPush is that same hardened git; its own
  // tests, including test/task-worktree-sandbox.test.ts under the real profile, are run against this profile in the PR's verification.)
  writeFileSync(join(f.wt, "a.txt"), "edited by the peer\n");
  f.git(f.wt, "add", "a.txt"); f.git(f.wt, "commit", "-qm", "hub commit after the peer's edits"); f.git(f.root, "branch", "hub-made");
  expect(f.git(f.root, "diff", "--name-status", f.base, "refs/heads/task/1-pi")).toBe("M\ta.txt");
  expect(f.git(f.root, "rev-parse", "refs/heads/hub-made")).toBe(f.base);
});

test.skipIf(!sandboxAvailable())("git status, diff, log, show, blame and ls-files still work in the sandbox, in the main checkout and in a worktree; git add works in the main checkout only (#1123 AC2)", async () => {
  const f = repo();
  for (const [name, cwd] of [["main checkout", f.root], ["hub-made worktree", f.wt]] as const) {
    const out = await sh(cwd, ["echo more >> a.txt", ...["git status --short", "git diff --stat", "git log --oneline -2", "git show --stat HEAD", "git blame a.txt", "git ls-files", "git rev-parse HEAD", "git for-each-ref", "git cat-file -p HEAD"].map(c => `(${c}) >/dev/null 2>&1 && echo ok-${c.split(" ")[1]} || echo FAILED-${c.split(" ")[1]}`)].join("; "));
    expect(out, `${name}\n${out}`).not.toContain("FAILED-");
    for (const word of ["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "for-each-ref", "cat-file"]) expect(out, `${name}: ${word}`).toContain(`ok-${word}`);
  }
  expect(await sh(f.root, "echo n >> a.txt; git add a.txt && echo added-in-main || echo FAILED-add")).toContain("added-in-main");
  const inWorktree = await sh(f.wt, "echo n >> a.txt; git add a.txt && echo ADDED || echo blocked-add-in-worktree");
  expect(inWorktree).toContain("blocked-add-in-worktree"); // its index lives under .git/worktrees/<name>, which is refused: the hub stages for it at hub_task_done
  expect(readFileSync(join(f.wt, "a.txt"), "utf8")).toContain("n"); // the file edit itself works
});

test.skipIf(!sandboxAvailable())("what stays writable under .git is exactly what ordinary work needs, named here with its reason (#1123 AC2)", async () => {
  const f = repo();
  // The main checkout's own index, reflog, ORIG_HEAD/MERGE_HEAD/COMMIT_EDITMSG, info/exclude and description stay writable: `git add` and `git restore` need the index and its lock, and
  // nothing there can make a program run or move a branch (hooks, config, commondir are refused by #270, refs/HEAD/packed-refs by this change).
  const allowed: [string, string][] = [["index", join(f.common, "index")], ["index-lock", join(f.common, "index.lock")], ["logs-HEAD", join(f.common, "logs/HEAD")], ["ORIG_HEAD", join(f.common, "ORIG_HEAD")], ["MERGE_HEAD", join(f.common, "MERGE_HEAD")], ["COMMIT_EDITMSG", join(f.common, "COMMIT_EDITMSG")], ["info-exclude", join(f.common, "info/exclude")]];
  const out = await sh(f.root, allowed.map(([label, path]) => attempt(path, label)).join("; "));
  for (const [label] of allowed) expect(out, `${label}\n${out}`).toContain(`WROTE-${label}`);
  // Still refused as before #1123: what executes or reconfigures.
  const still = await sh(f.root, [attempt(join(f.common, "config"), "config"), attempt(join(f.common, "hooks/pre-commit"), "hooks"), attempt(join(f.common, "commondir"), "commondir"), attempt(join(f.common, "objects/info/alternates"), "alternates"), attempt(join(f.common, "objects/pack/p.pack"), "pack")].join("; "));
  for (const label of ["config", "hooks", "commondir", "alternates", "pack"]) expect(still, label).toContain(`refused-${label}`);
});

test.skipIf(!sandboxAvailable())("the rules are adjacent to .git: a project under a directory named refs, worktrees, HEAD or packed-refs keeps working, and the profile still parses (#1123)", async () => {
  for (const parent of ["refs", "worktrees", "HEAD", "packed-refs", "a/refs/b/worktrees"]) {
    const f = repo(parent);
    const out = await sh(f.root, ["echo hi > ok.txt && echo wrote-file", "echo n >> a.txt; git add a.txt && echo added-in-main", "git status --short >/dev/null && echo status-ok", attempt(join(f.common, "refs/heads/zz"), "ref")].join("; "));
    for (const expected of ["wrote-file", "added-in-main", "status-ok", "refused-ref"]) expect(out, `${parent}\n${out}`).toContain(expected);
    expect(out, parent).not.toContain("Error reading string");
    const inWorktree = await sh(f.wt, ["echo hi > ok.txt && echo wrote-file", attempt(join(f.admin, "HEAD"), "head")].join("; "));
    expect(inWorktree, parent).toContain("wrote-file"); expect(inWorktree, parent).toContain("refused-head");
  }
});

// A project with a submodule, a submodule nested in it, and a linked worktree of the project that has its own copy of both (`.git/worktrees/<wt>/modules/**`).
function withSubmodules() {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-git-refs-sub-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const git = (cwd: string, ...a: string[]) => { const r = hubGitSync(["-C", cwd, "-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", timeout: 60_000 }); if (r.status !== 0) throw new Error(a.join(" ") + r.stderr); return r.stdout.trim(); };
  const inner = join(base, "inner"), up = join(base, "up"), main = join(base, "main"), state = join(base, "state"); mkdirSync(inner); mkdirSync(up); mkdirSync(main); mkdirSync(state);
  git(inner, "init", "-q", "-b", "main"); writeFileSync(join(inner, "i"), "i"); git(inner, "add", "-A"); git(inner, "commit", "-qm", "i");
  git(up, "init", "-q", "-b", "main"); writeFileSync(join(up, "u"), "u"); git(up, "add", "-A"); git(up, "commit", "-qm", "u"); git(up, "submodule", "add", "-q", inner, "n"); git(up, "commit", "-qm", "n");
  git(main, "init", "-q", "-b", "main"); git(main, "config", "core.excludesFile", "/dev/null"); writeFileSync(join(main, "a"), "a"); git(main, "add", "-A"); git(main, "commit", "-qm", "a");
  git(main, "submodule", "add", "-q", up, "s"); git(main, "submodule", "update", "--init", "--recursive", "-q"); git(main, "commit", "-qm", "s");
  const wt = join(main, "wt"); git(main, "worktree", "add", "-q", "-b", "t", wt); git(wt, "submodule", "update", "--init", "--recursive", "-q");
  return { main, wt, git, sub: git(join(main, "s"), "rev-parse", "--absolute-git-dir"), nested: git(join(main, "s", "n"), "rev-parse", "--absolute-git-dir"), wtSub: git(join(wt, "s"), "rev-parse", "--absolute-git-dir"), wtNested: git(join(wt, "s", "n"), "rev-parse", "--absolute-git-dir") };
}

test.skipIf(!sandboxAvailable())("a submodule's own git dir refuses refs, HEAD, packed-refs and worktrees like the project's, at every nesting and in a linked worktree (#1123, ruling 2026-11-03)", async () => {
  const f = withSubmodules();
  const dirs: [string, string][] = [["sub", f.sub], ["nested", f.nested], ["wt-sub", f.wtSub], ["wt-nested", f.wtNested]];
  const tails: [string, string][] = [["refs", "refs/heads/zz"], ["tag", "refs/tags/zz"], ["head", "HEAD"], ["head-lock", "HEAD.lock"], ["packed", "packed-refs"], ["worktrees", "worktrees/evil/HEAD"]];
  const out = await sh(f.main, dirs.flatMap(([d, dir]) => tails.map(([t, tail]) => attempt(join(dir, tail), `${d}-${t}`))).join("; "));
  for (const [d] of dirs) for (const [t] of tails) expect(out, `${d}-${t}\n${out}`).toContain(`refused-${d}-${t}`);
  expect(out).not.toMatch(/WROTE-/);
});

test.skipIf(!sandboxAvailable())("a sandboxed commit, branch and tag inside a submodule fail with no ref moved, while its working tree, status and the ordinary reads work (#1123)", async () => {
  const f = withSubmodules();
  const tipBefore = f.git(join(f.main, "s"), "rev-parse", "HEAD");
  const out = await sh(f.main, [
    "echo hi > s/ok.txt && echo wrote-sub-file", "git -C s status --short >/dev/null && echo sub-status-ok", "git -C s log -1 --format=%H >/dev/null && echo sub-log-ok", "git -C s diff >/dev/null && echo sub-diff-ok",
    "git -C s branch zz && echo SUB-BRANCHED || echo blocked-sub-branch", "git -C s tag zz && echo SUB-TAGGED || echo blocked-sub-tag",
    "git -C s -c user.name=x -c user.email=x@x -c commit.gpgsign=false commit -q --allow-empty -m x && echo SUB-COMMITTED || echo blocked-sub-commit",
    "git -C s/n branch zz && echo NESTED-BRANCHED || echo blocked-nested-branch",
  ].join("; "));
  for (const expected of ["wrote-sub-file", "sub-status-ok", "sub-log-ok", "sub-diff-ok", "blocked-sub-branch", "blocked-sub-tag", "blocked-sub-commit", "blocked-nested-branch"]) expect(out, out).toContain(expected);
  expect(out).not.toMatch(/SUB-BRANCHED|SUB-TAGGED|SUB-COMMITTED|NESTED-BRANCHED/);
  expect(f.git(join(f.main, "s"), "rev-parse", "HEAD")).toBe(tipBefore);
  expect(f.git(join(f.main, "s"), "branch", "--list", "zz")).toBe("");
});

test.skipIf(!sandboxAvailable())("what a sandboxed command still writes in a submodule git dir is only what a read needs: index, logs and ORIG_HEAD, no ref (#1123)", async () => {
  const f = withSubmodules();
  const names: [string, string][] = [["index", "index"], ["index-lock", "index.lock"], ["logs-head", "logs/HEAD"], ["orig-head", "ORIG_HEAD"], ["merge-head", "MERGE_HEAD"], ["commit-msg", "COMMIT_EDITMSG"], ["exclude", "info/exclude"]];
  const out = await sh(f.main, names.map(([label, tail]) => attempt(join(f.sub, tail), label)).join("; "));
  // Probed with the real profile: these stay open because git writes them while it reads (`git status` refreshes the index) or they carry no ref and run nothing.
  for (const [label] of names) expect(out, `${label}\n${out}`).toContain(`WROTE-${label}`);
});

test.skipIf(!sandboxAvailable())("a linked worktree OUTSIDE its project: the common dir and the worktree's admin dir are refused from there (the external git dir rules, #1123)", async () => {
  const made = mkdtempSync(join(tmpdir(), "ahub-git-refs-ext-")); cleanup.push(() => rmSync(made, { recursive: true, force: true }));
  const base = realPath(made), main = join(base, "main"), wt = join(base, "wt"); mkdirSync(main);
  const git = (cwd: string, ...a: string[]) => { const r = hubGitSync(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", timeout: 30_000 }); if (r.status !== 0) throw new Error(a.join(" ") + r.stderr); return r.stdout.trim(); };
  git(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "a"), "a"); git(main, "add", "-A"); git(main, "commit", "-qm", "b"); git(main, "worktree", "add", "-q", "-b", "t", wt);
  const common = join(main, ".git"), admin = git(wt, "rev-parse", "--absolute-git-dir"), base0 = git(main, "rev-parse", "main");
  const paths: [string, string][] = [["refs", join(common, "refs/heads/zz")], ["head", join(common, "HEAD")], ["packed", join(common, "packed-refs")], ["worktrees", join(common, "worktrees/evil/HEAD")], ["admin-head", join(admin, "HEAD")], ["admin-index", join(admin, "index")], ["admin-refs", join(admin, "refs/x")]];
  const out = await sh(wt, [...paths.map(([label, path]) => attempt(path, label)), "echo hi > ok.txt && echo wrote-file", "git status --short >/dev/null && echo status-ok", "git commit -q --allow-empty -m x && echo COMMITTED || echo blocked-commit"].join("; "));
  for (const [label] of paths) expect(out, `${label}\n${out}`).toContain(`refused-${label}`);
  for (const expected of ["wrote-file", "status-ok", "blocked-commit"]) expect(out, out).toContain(expected);
  expect(out).not.toMatch(/WROTE-|COMMITTED/);
  expect(git(main, "rev-parse", "main")).toBe(base0);
});

test.skipIf(!sandboxAvailable())("a bare repository's worktree: its common dir is not named .git, so the external git dir rules refuse refs, HEAD, packed-refs and the admin dir (#1123)", async () => {
  const made = mkdtempSync(join(tmpdir(), "ahub-git-refs-bare-")); cleanup.push(() => rmSync(made, { recursive: true, force: true }));
  const base = realPath(made), seed = join(base, "seed"), bare = join(base, "store.git"), wt = join(base, "wt"); mkdirSync(seed);
  const git = (cwd: string, ...a: string[]) => { const r = hubGitSync(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", timeout: 30_000 }); if (r.status !== 0) throw new Error(a.join(" ") + r.stderr); return r.stdout.trim(); };
  git(seed, "init", "-q", "-b", "main"); writeFileSync(join(seed, "a"), "a"); git(seed, "add", "-A"); git(seed, "commit", "-qm", "b");
  git(base, "clone", "-q", "--bare", seed, bare); git(bare, "worktree", "add", "-q", "-b", "t", wt, "main"); git(bare, "pack-refs", "--all");
  const admin = git(wt, "rev-parse", "--absolute-git-dir"), before = git(bare, "rev-parse", "main");
  expect(admin.startsWith(`${bare}/worktrees/`)).toBe(true); expect(bare.endsWith(".git") && !bare.endsWith("/.git")).toBe(true);
  const paths: [string, string][] = [["refs", join(bare, "refs/heads/zz")], ["head", join(bare, "HEAD")], ["packed", join(bare, "packed-refs")], ["worktrees", join(bare, "worktrees/evil/HEAD")], ["admin-head", join(admin, "HEAD")], ["admin-index", join(admin, "index")], ["admin-refs", join(admin, "refs/x")]];
  const out = await sh(wt, [...paths.map(([label, path]) => attempt(path, label)), "echo hi > ok.txt && echo wrote-file", "git status --short >/dev/null && echo status-ok", "git commit -q --allow-empty -m x && echo COMMITTED || echo blocked-commit"].join("; "));
  for (const [label] of paths) expect(out, `${label}\n${out}`).toContain(`refused-${label}`);
  for (const expected of ["wrote-file", "status-ok", "blocked-commit"]) expect(out, out).toContain(expected);
  expect(out).not.toMatch(/WROTE-|COMMITTED/);
  expect(git(bare, "rev-parse", "main")).toBe(before);
});

test("the new rules fit seatbelt's 1024-byte regex literal limit at any project depth, and fold the names HFS+ ignores (#1123)", () => {
  for (const root of ["/p", `/${"d".repeat(60)}/${"e".repeat(60)}/main`, `/${"x".repeat(400)}/main`, `/${"x".repeat(900)}/main`]) {
    const common = `${root}/.git`, admin = `${common}/worktrees/pi-1`;
    for (const rule of hubWriteRegexes(root, [admin, common], [{ root: `${common}/modules`, entries: [`${common}/modules`], dirs: [] }], `${common}/worktrees`)) {
      for (const literal of rule.match(/"(?:[^"\\]|\\.)*"/g) ?? []) expect(Buffer.byteLength(literal), `${root.length}-byte root: ${literal.slice(0, 60)}`).toBeLessThan(1024);
    }
  }
  const joined = hubWriteRegexes("/p", [], [], undefined).join("\n");
  expect(joined).toContain(ZWJ); // the names are folded, so the rules are not plain literals
});

test.skipIf(!sandboxAvailable())("a name spelled with a code point HFS+ ignores is refused like the plain name: refs, HEAD, packed-refs and worktrees (#1123, #270)", async () => {
  const f = repo();
  const fold = (name: string) => `${name.slice(0, 2)}${ZWJ}${name.slice(2)}`;
  const paths: [string, string][] = [["refs", join(f.common, fold("refs"), "heads/zz")], ["head", join(f.common, fold("HEAD"))], ["packed", join(f.common, fold("packed-refs"))], ["worktrees", join(f.common, fold("worktrees"), "evil/HEAD")], ["wt-admin-head", join(f.admin, fold("HEAD"))], ["wt-admin-refs", join(f.admin, fold("refs"), "x")]];
  for (const cwd of [f.root, f.wt]) {
    const out = await sh(cwd, paths.map(([label, path]) => attempt(path, label)).join("; "));
    for (const [label] of paths) expect(out, `${label}\n${out}`).toContain(`refused-${label}`);
    expect(out).not.toMatch(/WROTE-/);
  }
});

test.skipIf(!sandboxAvailable())("the local git tool says why a refused commit failed and what to do, and adds nothing to an unrelated failure (#1123)", async () => {
  const { runTool } = await import("../src/local/tools.ts");
  const f = repo();
  writeFileSync(join(f.wt, "a.txt"), "edit\n");
  const ctx = { cwd: f.wt, deny: [] as string[], sandboxProfile: profile(f.wt, false), sandboxEnv: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }, permit: async () => true as const, send: () => "sent" };
  const commit = await runTool("git", JSON.stringify({ args: ["commit", "-am", "x"] }), ctx);
  expect(commit).toContain("not permitted"); expect(commit).toContain("hub_task_done"); expect(commit).toContain("stages, commits and pushes");
  expect(f.git(f.root, "rev-parse", "refs/heads/task/1-pi")).toBe(f.base);
  const unrelated = await runTool("git", JSON.stringify({ args: ["show", "no-such-ref"] }), ctx);
  expect(unrelated).toContain("(exit"); expect(unrelated).not.toContain("hub_task_done");
  const fine = await runTool("git", JSON.stringify({ args: ["status", "--short"] }), ctx);
  expect(fine).toContain("a.txt"); expect(fine).not.toContain("hub_task_done");
});

test("the git tool's description states what the sandbox no longer lets a peer do and who commits instead (#1123, ruling 2)", async () => {
  const { TOOL_SCHEMAS } = await import("../src/local/tools.ts");
  const description = (TOOL_SCHEMAS.find(tool => tool.function.name === "git")?.function.description ?? "").replace(/\s+/g, " ");
  for (const word of ["commit", "branch", "tag", "stash", "switch", "rebase", "submodules", "linked worktree", "hub_task_done", "commits and pushes"]) expect(description, word).toContain(word);
});

test.skipIf(!sandboxAvailable())("the git tool's hint also fires for a commit refused inside a submodule's git dir (#1123)", async () => {
  const { runTool } = await import("../src/local/tools.ts");
  const f = withSubmodules();
  writeFileSync(join(f.main, "s", "u"), "edit\n");
  const ctx = { cwd: join(f.main, "s"), deny: [] as string[], sandboxProfile: profile(f.main, false), sandboxEnv: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid", GIT_CONFIG_GLOBAL: "/dev/null" }, permit: async () => true as const, send: () => "sent" };
  const commit = await runTool("git", JSON.stringify({ args: ["commit", "-am", "x"] }), ctx);
  expect(commit).toContain("hub_task_done"); expect(commit).toContain("not permitted");
});
