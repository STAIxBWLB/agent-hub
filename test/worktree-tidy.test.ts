import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { classifyPeerCommand, cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
import { assertRemovalArgv, confirmTidy, defaultBranchOf, fingerprintOf, planTidy, realTidyGit, refusals, removalArgv, rowsFromReply, type TidyGit, type TidyRow } from "../src/cli/worktree-tidy.ts";
import { renderTidyPreview, renderTidyResult, renderWorktrees } from "../src/cli/worktrees-output.ts";
import { gitProject } from "./fakes/git-project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const src = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---- AC3: the argv shape. `--force` and `-D` never appear in any argv.
test("the two removal argv shapes are fixed and carry no force flag", () => {
  const [worktree, branch] = removalArgv("/root", "/root/.worktrees/a", "task/a");
  expect(worktree).toEqual(["-C", "/root", "worktree", "remove", "/root/.worktrees/a"]);
  expect(branch).toEqual(["-C", "/root", "branch", "-d", "task/a"]);
  for (const argv of [worktree, branch]) { expect(() => assertRemovalArgv(argv)).not.toThrow(); expect(argv.some(word => word === "--force" || word === "-f" || word === "-D")).toBe(false); }
});

test("assertRemovalArgv refuses every other shape: force, -D, extra words, a flag as the target, a missing root, other verbs", () => {
  const bad: string[][] = [
    ["-C", "/r", "worktree", "remove", "--force", "/r/w"], ["-C", "/r", "worktree", "remove", "-f", "/r/w"], ["-C", "/r", "worktree", "remove", "/r/w", "--force"],
    ["-C", "/r", "branch", "-D", "b"], ["-C", "/r", "branch", "--delete", "b"], ["-C", "/r", "branch", "-d", "--force", "b"], ["-C", "/r", "branch", "-d", "-D"],
    ["-C", "/r", "worktree", "remove", "--", "/r/w"], ["-C", "/r", "worktree", "remove", "-x"], ["-C", "/r", "worktree", "prune"], ["-C", "/r", "update-ref", "-d", "refs/heads/b"],
    ["-C", "-r", "worktree", "remove", "/r/w"], ["worktree", "remove", "/r/w"], ["-C", "/r", "worktree", "remove"], ["-C", "/r", "branch", "-d"], ["-C", "/r", "push", "origin", ":b"],
  ];
  for (const argv of bad) expect(() => assertRemovalArgv(argv), argv.join(" ")).toThrow("refused");
});

test("the real git port runs a removal only through assertRemovalArgv, and every other argv reaches the spawner unchanged", () => {
  const seen: string[][] = [];
  const git = realTidyGit(argv => { seen.push(argv); return { status: 0, stdout: "" }; });
  git.run("/r", ["worktree", "remove", "/r/w"]); git.run("/r", ["branch", "-d", "b"]); git.run("/r", ["status", "--porcelain"]);
  expect(seen.map(argv => argv.slice(0, 6))).toEqual(Array(3).fill(["-C", "/r", "-c", "gc.auto=0", "-c", "maintenance.auto=false"]));
  expect(seen.map(argv => argv.slice(6))).toEqual([["worktree", "remove", "/r/w"], ["branch", "-d", "b"], ["status", "--porcelain"]]);
  for (const args of [["worktree", "remove", "--force", "/r/w"], ["branch", "-d", "-D", "b"], ["worktree", "remove", "-f", "/r/w"]]) expect(() => git.run("/r", args), args.join(" ")).toThrow("refused");
  expect(seen).toHaveLength(3);   // a refused argv never reaches the spawner
});

test("no source file in src/ contains --force, -D, or a branch/worktree removal other than the CLI tidy module and the pre-existing hub-owned ones", () => {
  const tidy = code(src("src/cli/worktree-tidy.ts"));
  // the tidy module names the force flags only to refuse them
  expect(tidy.match(/"--force"|"-D"|"-f"/g)?.length).toBe(3);
  expect(tidy).toMatch(/word === "--force" \|\| word === "-f" \|\| word === "-D"/);
  expect(tidy).not.toMatch(/\["-C", [^\]]*"--force"|run\([^)]*"--force"|"-D"\s*,/);
  const files = (dir: string): string[] => readdirSync(join(import.meta.dir, "..", dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []);
  // a removal ARGV (the words as separate strings) exists only in these three; the help line and the preview text mention the commands in prose
  const removers = files("src").filter(f => /"worktree",\s*"remove"|"branch",\s*"-d"|\["worktree", "remove"|worktree", "remove"/.test(code(src(f)))).sort();
  expect(removers).toEqual(["src/cli/worktree-tidy.ts", "src/hub/code-facts.ts", "src/hub/task-worktree.ts"]);
  for (const file of ["src/cli/help.ts", "src/cli/worktrees-output.ts"]) expect(code(src(file)), file).not.toMatch(/"worktree",\s*"remove"|"branch",\s*"-d"/);
});

// ---- AC4: the daemon never imports the module that removes anything.
test("the daemon, the shelf and the UI never import or call the tidy module or its removal", () => {
  for (const file of ["src/hub/daemon.ts", "src/hub/worktree-shelf.ts", "src/hub/board.ts", "src/ui/plugin.ts", "src/hub/ui.ts"]) {
    const text = code(src(file));
    expect(text, file).not.toMatch(/worktree-tidy|confirmTidy|removalArgv|assertRemovalArgv|realTidyGit/);
  }
  const main = src("src/cli/main.ts");
  expect(main.match(/worktree-tidy/g)?.length).toBe(1);   // imported by the CLI process only
});

test("authority: listing and previewing are reads an agent may run, --confirm is console class and refused under --live-test", () => {
  expect(classifyPeerCommand("worktrees", [])).toBe("allowed");
  expect(classifyPeerCommand("worktrees", ["--json"])).toBe("allowed");
  expect(classifyPeerCommand("worktrees", ["tidy"])).toBe("allowed");
  expect(classifyPeerCommand("worktrees", ["tidy", "--json"])).toBe("allowed");
  for (const args of [["tidy", "--confirm", "0123456789abcdef"], ["tidy", "--confirm=0123456789abcdef"], ["--confirm", "x"], ["tidy", "--yes"], ["park", "x"], ["remove"], ["tidy", "x"]]) expect(classifyPeerCommand("worktrees", args), args.join(" ")).toBe("console");
  for (const args of [["tidy", "--confirm", "0123456789abcdef"], ["tidy", "--confirm=0123456789abcdef"]]) expect(liveTestRefusal("worktrees", args), args.join(" ")).toBe(true);
  for (const args of [[], ["--json"], ["tidy"], ["tidy", "--json"]]) expect(liveTestRefusal("worktrees", args), args.join(" ")).toBe(false);
  expect(cliCommandLabel("worktrees", ["tidy", "--confirm", "secretfingerprint"])).toBe("worktrees tidy confirm");
  expect(cliCommandLabel("worktrees", ["tidy"])).toBe("worktrees tidy");
  expect(cliCommandLabel("worktrees", [])).toBe("worktrees");
  expect(cliCommandLabel("worktrees", ["tidy", "--confirm", "x"])).not.toContain("x");
});

// ---- A real repository: refusals and the confirm flow with real git.
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "f", GIT_AUTHOR_EMAIL: "f@l", GIT_COMMITTER_NAME: "f", GIT_COMMITTER_EMAIL: "f@l" };
const g = (cwd: string, ...args: string[]) => {
  const run = hubGitSync(["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000, env: { ...hubGitEnv(gitEnv, { repositoryIsolation: true }) } });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return String(run.stdout).trim();
};
const gitPort = (): TidyGit => realTidyGit((argv, dir) => { const run = hubGitSync(argv, { cwd: dir, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: hubGitEnv(gitEnv, { repositoryIsolation: true }) }); return run.error ? undefined : { status: run.status, stdout: String(run.stdout ?? "") }; });

/** A project with a bare "origin" so branches have upstreams: main, plus one worktree per scenario. */
function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-tidy-"))); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project"), origin = join(base, "origin.git");
  mkdirSync(root); gitProject(root);
  g(root, "branch", "-M", "main");
  g(base, "init", "-q", "--bare", origin);
  g(root, "remote", "add", "origin", origin); g(root, "push", "-q", "-u", "origin", "main");
  g(root, "remote", "set-head", "origin", "main");
  const add = (name: string) => { g(root, "branch", name); g(root, "worktree", "add", "-q", join(root, ".worktrees", name), name); g(root, "push", "-q", "-u", "origin", name); return join(root, ".worktrees", name); };
  return { base, root, add };
}
const rowOf = (root: string, name: string, over: Partial<TidyRow> = {}): TidyRow => {
  const path = join(root, ".worktrees", name);
  const list = g(root, "worktree", "list", "--porcelain");
  const head = new RegExp(`worktree ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nHEAD ([0-9a-f]+)`).exec(list)?.[1] ?? "";
  return { path, shown: `.worktrees/${name}`, branch: name, head, locked: false, reason: "merged", instance: false, ...over };
};

test("AC3: a clean, fully pushed, merged worktree is safe; dirty, locked, unpushed, unmerged and the main checkout are refused with named reasons", () => {
  const { root, add } = repo(); const git = gitPort();
  // safe: pushed, merged into main (its tip is an ancestor of main)
  add("safe");
  // dirty: an untracked file
  const dirty = add("dirty"); writeFileSync(join(dirty, "scratch.txt"), "x");
  // locked: git itself marks it
  add("locked"); g(root, "worktree", "lock", join(root, ".worktrees", "locked"));
  // unpushed: a local commit not on its upstream (and not merged into main either)
  const unpushed = add("unpushed"); writeFileSync(join(unpushed, "u.txt"), "u"); g(unpushed, "add", "."); g(unpushed, "commit", "-q", "-m", "u");
  // unmerged but pushed
  const unmerged = add("unmerged"); writeFileSync(join(unmerged, "m.txt"), "m"); g(unmerged, "add", "."); g(unmerged, "commit", "-q", "-m", "m"); g(unmerged, "push", "-q");
  // no upstream
  g(root, "branch", "noup"); g(root, "worktree", "add", "-q", join(root, ".worktrees", "noup"), "noup");
  const rows = ["safe", "dirty", "locked", "unpushed", "unmerged", "noup"].map(n => rowOf(root, n, n === "locked" ? { locked: true } : {}));
  const plan = planTidy(rows, root, git);
  const why = Object.fromEntries(plan.entries.map(e => [e.shown.replace(".worktrees/", ""), e.refused]));
  expect(why.safe).toEqual([]);
  expect(why.dirty).toEqual(["dirty"]);
  expect(why.locked).toEqual(["locked"]);
  expect(why.unpushed).toContain("unpushed commits"); expect(why.unpushed).toContain("branch not merged into the default branch");
  expect(why.unmerged).toEqual(["branch not merged into the default branch"]);
  expect(why.noup).toContain("no upstream");
  expect(plan.removable.map(e => e.shown)).toEqual([".worktrees/safe"]);
  // the main checkout is refused outright, whatever else is true
  expect(refusals({ ...rowOf(root, "safe"), path: root, shown: "." }, root, git, "origin/main")).toEqual(["main checkout"]);
  expect(refusals({ ...rowOf(root, "safe"), instance: true }, root, git, "origin/main")).toEqual(["instance worktree"]);
});

test("AC3: a task that is not approved or cancelled refuses, an unknown answer from git refuses, and a missing directory refuses", () => {
  const { root, add } = repo(); const git = gitPort();
  add("t");
  expect(refusals(rowOf(root, "t", { taskState: "in_review" }), root, git, "origin/main")).toEqual(["task not approved or cancelled"]);
  expect(refusals(rowOf(root, "t", { taskState: "approved" }), root, git, "origin/main")).toEqual([]);
  expect(refusals(rowOf(root, "t", { taskState: "cancelled" }), root, git, "origin/main")).toEqual([]);
  // no default branch known: unknown is never safe
  expect(refusals(rowOf(root, "t"), root, git, undefined)).toEqual(["git could not tell"]);
  // a git that fails every call: every check is unknown, so the row is refused
  const broken: TidyGit = { run: () => undefined };
  expect(refusals(rowOf(root, "t"), root, broken, "origin/main")).toContain("git could not tell");
  expect(refusals({ ...rowOf(root, "t"), path: join(root, ".worktrees", "gone"), shown: ".worktrees/gone" }, root, git, "origin/main")).toContain("path missing");
  // a path outside the project and a hostile branch name are refused before git is asked
  expect(refusals({ ...rowOf(root, "t"), path: "/elsewhere/x" }, root, git, "origin/main")).toContain("outside the project");
  for (const branch of ["-x", "a..b", "x.lock", "a b", "", "a/", "$(touch x)"]) expect(refusals(rowOf(root, "t", { branch }), root, git, "origin/main"), branch).toContain("no branch");
  expect(defaultBranchOf(root, git)).toBe("origin/main");
});

test("AC3: the preview ends in a fingerprint, a changed row set after the preview refuses the whole confirm, and nothing is removed", () => {
  const { root, add } = repo(); const git = gitPort();
  add("a"); add("b");
  const before = planTidy([rowOf(root, "a"), rowOf(root, "b")], root, git);
  expect(before.removable).toHaveLength(2); expect(before.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  // between the preview and the confirm, `b` gets a dirty file
  writeFileSync(join(root, ".worktrees", "b", "late.txt"), "late");
  const after = planTidy([rowOf(root, "a"), rowOf(root, "b")], root, git);
  expect(after.fingerprint).not.toBe(before.fingerprint);
  const out = confirmTidy(after, before.fingerprint, root, git);
  expect(out.ok).toBe(false); expect(out.ok === false && out.error).toContain("changed since the preview");
  expect(g(root, "worktree", "list", "--porcelain")).toContain(".worktrees/a");          // nothing was removed
  expect(g(root, "branch", "--list", "a")).toContain("a");
  // a new commit on the same branch also changes the fingerprint (it covers HEAD)
  expect(fingerprintOf([{ path: "/p", branch: "b", head: "1", refused: [] }])).not.toBe(fingerprintOf([{ path: "/p", branch: "b", head: "2", refused: [] }]));
  expect(fingerprintOf([{ path: "/p", branch: "b", head: "1", refused: [] }])).not.toBe(fingerprintOf([{ path: "/p", branch: "b", head: "1", refused: ["dirty"] }]));
  // row order never changes it
  const x = { path: "/a", branch: "a", head: "1", refused: [] }, y = { path: "/b", branch: "b", head: "2", refused: [] };
  expect(fingerprintOf([x, y])).toBe(fingerprintOf([y, x]));
  // a malformed fingerprint is refused before anything else
  expect(confirmTidy(before, "nothex", root, git)).toMatchObject({ ok: false });
});

test("AC3: a matching confirm removes exactly the safe worktrees and their merged branches without force, and reads each result back", () => {
  const { root, add } = repo(); const git = gitPort();
  add("a"); add("b"); const dirty = add("c"); writeFileSync(join(dirty, "x.txt"), "x");
  const plan = planTidy([rowOf(root, "a"), rowOf(root, "b"), rowOf(root, "c")], root, git);
  expect(plan.removable.map(e => e.shown)).toEqual([".worktrees/a", ".worktrees/b"]);
  const result = confirmTidy(plan, plan.fingerprint, root, git);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.outcomes.map(o => [o.shown, o.worktreeRemoved, o.branchDeleted])).toEqual([[".worktrees/a", true, true], [".worktrees/b", true, true]]);
  const list = g(root, "worktree", "list", "--porcelain");
  expect(list).not.toContain(".worktrees/a"); expect(list).not.toContain(".worktrees/b"); expect(list).toContain(".worktrees/c");
  expect(g(root, "branch", "--list", "a", "b")).toBe(""); expect(g(root, "branch", "--list", "c")).toContain("c");
  // the dirty one was refused and is untouched
  expect(readFileSync(join(dirty, "x.txt"), "utf8")).toBe("x");
});

test("AC3: git's -d guard is weaker than the plan's, so the plan refuses a branch merged only into its upstream; and git itself keeps a branch with commits on no remote", () => {
  const { root, add } = repo(); const git = gitPort();
  // pushed, so merged into its own upstream (git branch -d would delete it), but NOT merged into main: the plan must refuse it
  const w = add("k"); writeFileSync(join(w, "k.txt"), "k"); g(w, "add", "."); g(w, "commit", "-q", "-m", "k"); g(w, "push", "-q");
  const plan = planTidy([rowOf(root, "k")], root, git);
  expect(plan.removable).toHaveLength(0);
  expect(plan.entries[0]!.refused).toEqual(["branch not merged into the default branch"]);
  // a plan that wrongly judged it safe would still have its worktree removed and, because the branch is on its upstream, git -d would delete it: the plan is the guard that matters here
  const forced = { entries: plan.entries, removable: plan.entries, fingerprint: plan.fingerprint };
  const result = confirmTidy(forced, plan.fingerprint, root, git);
  expect(result.ok && result.outcomes[0]).toMatchObject({ worktreeRemoved: true, branchDeleted: true });
  // a branch whose commit exists on no remote and is merged nowhere: git -d refuses it, and the worktree removal succeeded first
  const lone = add("lone"); writeFileSync(join(lone, "l.txt"), "l"); g(lone, "add", "."); g(lone, "commit", "-q", "-m", "l");
  const row = rowOf(root, "lone"); const plan2 = planTidy([row], root, git);
  const forced2 = { entries: plan2.entries, removable: plan2.entries, fingerprint: plan2.fingerprint };
  const result2 = confirmTidy(forced2, plan2.fingerprint, root, git);
  expect(result2.ok && result2.outcomes[0]).toMatchObject({ worktreeRemoved: true, branchDeleted: false });
  expect(result2.ok && result2.outcomes[0]!.note).toContain("kept the branch");
  expect(g(root, "branch", "--list", "lone")).toContain("lone");   // no -D was ever tried
});

test("confirm with nothing safe to remove says so and removes nothing", () => {
  const { root, add } = repo(); const git = gitPort();
  const w = add("d"); writeFileSync(join(w, "x.txt"), "x");
  const plan = planTidy([rowOf(root, "d")], root, git);
  expect(confirmTidy(plan, plan.fingerprint, root, git)).toMatchObject({ ok: false, error: expect.stringContaining("nothing is safe to remove") });
  expect(g(root, "worktree", "list", "--porcelain")).toContain(".worktrees/d");
});

test("rows come from git's own list: a path the daemon names that git does not list, an outside row and a dotdot path are dropped", () => {
  const { root, add } = repo(); const git = gitPort();
  add("real");
  const rows = rowsFromReply([
    { path: ".worktrees/real", branch: "real", reason: "merged" }, { path: ".worktrees/ghost", branch: "ghost", reason: "quiet" },
    { path: "../../etc", branch: "x", reason: "quiet" }, { path: "outside", branch: "o", reason: "quiet", outside: true }, { path: ".worktrees/real/../real", branch: "real", reason: "quiet" }, { path: 7 as never },
  ], root, git);
  expect(rows.map(r => r.shown)).toEqual([".worktrees/real"]);
  expect(rows[0]!.head).toMatch(/^[0-9a-f]{40}$/);
});

// ---- renderers are pure and cover every state; --json is the caller's branch.
test("the renderers print live and settled rows, refusals, the fingerprint line and the result", () => {
  const text = (lines: { text: string }[][]) => lines.map(l => l.map(s => s.text).join("")).join("\n");
  const list = text(renderWorktrees({ live: [{ path: ".", branch: "main", lastActiveAt: 1 }], settled: [{ path: ".worktrees/a", branch: "a", reason: "merged", task: 4, pr: 9, lastActiveAt: 1 }], complete: false }, 100, 2));
  expect(list).toContain("1 live, 1 settled"); expect(list).toContain("PR merged"); expect(list).toContain("#4 PR 9"); expect(list).toContain("cut off");
  expect(text(renderWorktrees({ live: [], settled: [], complete: true }, 100, 2))).toContain("no worktrees");
  const preview = text(renderTidyPreview({ entries: [{ shown: ".worktrees/a", branch: "a", reason: "quiet", refused: [] }, { shown: ".worktrees/b", branch: "b", reason: "quiet", refused: ["dirty", "locked"] }], removable: [{ shown: ".worktrees/a", branch: "a", reason: "quiet", refused: [] }], fingerprint: "0123456789abcdef" }, 120));
  expect(preview).toContain("1 safe to remove, 1 refused"); expect(preview).toContain("dirty; locked"); expect(preview).toContain("ahub worktrees tidy --confirm 0123456789abcdef"); expect(preview).toContain("without force");
  expect(text(renderTidyPreview({ entries: [], removable: [], fingerprint: "x" }, 120))).toContain("nothing is on the shelf");
  expect(text(renderTidyResult([{ shown: ".worktrees/a", branch: "a", worktreeRemoved: true, branchDeleted: false, note: "git kept the branch" }], 120))).toContain("1 of 1 removed");
});

test("help lists the command and the command table has an entry for it", () => {
  expect(src("src/cli/help.ts")).toContain("ahub worktrees [--json] | tidy [--json] | tidy --confirm <fingerprint>");
  expect(src("src/cli/main.ts")).toContain("worktrees: async () => {");
});
