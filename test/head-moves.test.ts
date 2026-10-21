import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { changedPaths, headMoveCursor, headState, headTree, incomingHeadPaths, repoOf, snapshot, SnapshotBudgetExceeded, type Repo, type SnapshotBudget } from "../src/hub/snapshots.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(gitBinary = "git") {
  const root = mkdtempSync(join(tmpdir(), "ahub-head-moves-")); roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync([gitBinary, "-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=true", ...args], {
      env: { ...process.env, GIT_AUTHOR_DATE: "2001-01-01T00:00:00+0000", GIT_COMMITTER_DATE: "2001-01-01T00:00:00+0000" },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-qb", "main");
  const commit = (file: string, text = `${file}\n`) => { writeFileSync(join(root, file), text); git("add", "--", file); git("commit", "-qm", file); };
  commit("base.txt");
  const repo = repoOf(root)!;
  const capture = (target: Repo = repo) => {
    const tree = headTree(target); expect(tree).toBeDefined();
    const cursor = headMoveCursor(target, tree!); expect(cursor).toBeDefined();
    return cursor!;
  };
  const incoming = () => {
    git("switch", "-qc", "incoming"); commit("incoming.txt"); git("switch", "-q", "main");
  };
  return { root, git, commit, repo, capture, incoming, log: join(repo.dir, "logs", "HEAD") };
}

test("#576 a peer's ordinary commit is retained rather than classified as incoming", () => {
  const f = fixture(), before = f.capture();
  f.commit("own.txt");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual([]);
}, 10_000);

test("#576 a peer's amend is retained", () => {
  const f = fixture(); f.commit("own.txt"); const before = f.capture();
  writeFileSync(join(f.root, "own.txt"), "amended\n"); f.git("add", "own.txt"); f.git("commit", "--amend", "-qm", "amended");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual([]);
}, 10_000);

test("#576 a peer's cherry-pick is retained", () => {
  const f = fixture(); f.incoming(); f.commit("own.txt"); const before = f.capture();
  f.git("cherry-pick", "incoming");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual([]);
}, 10_000);

test("#612 a rebase onto advanced upstream excludes incoming paths and preserves own commits", () => {
  const f = fixture(); f.incoming(); f.commit("own.txt"); const before = f.capture();
  f.git("rebase", "incoming");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual(["incoming.txt"]);
}, 10_000);

test("#612 a rebase with mixed own and incoming edits to the same path is unknown", () => {
  const f = fixture();
  // base.txt has 10 lines
  writeFileSync(join(f.root, "base.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n"); f.git("add", "base.txt"); f.git("commit", "-qm", "multiline base");
  f.git("switch", "-qc", "incoming");
  writeFileSync(join(f.root, "base.txt"), "incoming1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n"); f.git("add", "base.txt"); f.git("commit", "-qm", "incoming edit");
  f.git("switch", "-q", "main");
  writeFileSync(join(f.root, "base.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nown10\n"); f.git("add", "base.txt"); f.git("commit", "-qm", "own edit");
  const before = f.capture();
  f.git("rebase", "incoming");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

for (const move of ["checkout", "merge", "pull", "ff-reset"] as const) test(`#576 incoming ${move} excludes its committed paths`, () => {
  const f = fixture(); f.incoming(); const before = f.capture();
  if (move === "checkout") f.git("checkout", "-q", "incoming");
  if (move === "merge") f.git("merge", "--ff-only", "incoming");
  if (move === "pull") f.git("pull", "--ff-only", ".", "incoming");
  if (move === "ff-reset") f.git("reset", "--hard", "incoming");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual(["incoming.txt"]);
}, 10_000);

test("#576 an incoming merge commit excludes only the merged paths", () => {
  const f = fixture(); f.incoming(); f.commit("own.txt"); const before = f.capture();
  f.git("merge", "--no-ff", "-m", "incoming merge", "incoming");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual(["incoming.txt"]);
}, 10_000);

test("#576 byte cursors distinguish mixed own and incoming operations in the same second", () => {
  const f = fixture(); f.incoming(); const before = f.capture();
  f.commit("own.txt"); f.git("merge", "--no-ff", "-m", "incoming merge", "incoming");
  const after = f.capture();
  expect(incomingHeadPaths(f.repo, before, after)).toEqual(["incoming.txt"]);
  expect(after.size).toBeGreaterThan(before.size);
  expect(JSON.stringify(after)).not.toContain("fixture@localhost");
}, 10_000);

test("#576 mixed own and incoming edits to the same path are unknown", () => {
  const f = fixture(), before = f.capture();
  f.commit("base.txt", "own edit\n");
  f.git("checkout", "-q", "HEAD~1");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 a reset rewind is unknown rather than incoming", () => {
  const f = fixture(); f.commit("own.txt"); const before = f.capture();
  f.git("reset", "--hard", "HEAD~1");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

for (const damage of ["missing", "rotated", "truncated", "anchor-rewritten", "linked", "hardlinked"] as const) test(`#576 ${damage} HEAD reflog cannot prove a move`, () => {
  const f = fixture(), before = f.capture(); f.commit("own.txt"); const after = f.capture();
  if (damage === "missing") rmSync(f.log);
  if (damage === "rotated") { const data = readFileSync(f.log); renameSync(f.log, `${f.log}.old`); writeFileSync(f.log, data); }
  if (damage === "truncated") writeFileSync(f.log, "");
  if (damage === "anchor-rewritten") { const data = readFileSync(f.log); data[0] = data[0] === 97 ? 98 : 97; writeFileSync(f.log, data); }
  if (damage === "linked") { renameSync(f.log, `${f.log}.old`); symlinkSync(`${f.log}.old`, f.log); }
  if (damage === "hardlinked") linkSync(f.log, `${f.log}.linked`);
  expect(incomingHeadPaths(f.repo, before, after)).toBeUndefined();
  const fresh = headMoveCursor(f.repo, headTree(f.repo)!);
  if (damage === "rotated" || damage === "anchor-rewritten") {
    expect(fresh).toBeDefined(); // A new capture cannot infer an earlier file identity or earlier history.
    expect(incomingHeadPaths(f.repo, before, fresh!)).toBeUndefined();
  } else expect(fresh).toBeUndefined();
}, 10_000);

test("#576 an unknown custom reflog action refuses attribution", () => {
  const f = fixture(), before = f.capture();
  f.git("-c", "alias.unknown=!GIT_REFLOG_ACTION=custom-action git commit --allow-empty -m custom", "unknown");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 HEAD movement cursors honor an already exhausted snapshot budget", () => {
  const f = fixture(), before = f.capture(); f.commit("own.txt"); const after = f.capture();
  const expired = { deadline: performance.now() - 1 };
  expect(() => headMoveCursor(f.repo, before.tree, expired)).toThrow(SnapshotBudgetExceeded);
  expect(() => incomingHeadPaths(f.repo, before, after, expired)).toThrow(SnapshotBudgetExceeded);
}, 10_000);

test("#576 HEAD cursors use a linked worktree's own reflog", () => {
  const f = fixture(); const worktree = join(f.root, "linked"); f.git("worktree", "add", "-qb", "linked", worktree);
  const linked = repoOf(worktree)!, before = f.capture(linked);
  f.commit("incoming.txt"); // The main checkout's HEAD log changes independently.
  expect(incomingHeadPaths(linked, before, f.capture(linked))).toEqual([]);
}, 10_000);

test("#576 cursor capture rejects a tree that does not belong to current HEAD", () => {
  const f = fixture(), before = f.capture(); f.commit("own.txt");
  expect(headMoveCursor(f.repo, before.tree)).toBeUndefined();
}, 10_000);

test("#576 a partial appended reflog row is unknown", () => {
  const f = fixture(), before = f.capture();
  appendFileSync(f.log, "unfinished row");
  expect(headMoveCursor(f.repo, before.tree)).toBeUndefined();
}, 10_000);

test("#576 an initial peer commit from a positively unborn HEAD is retained", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-head-unborn-")); roots.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.logAllRefUpdates=true", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-qb", "main"); const repo = repoOf(root)!;
  const before = headMoveCursor(repo, null); expect(before).toBeDefined();
  expect(incomingHeadPaths(repo, before!, headMoveCursor(repo, null)!)).toEqual([]);
  writeFileSync(join(root, "own.txt"), "initial\n"); git("add", "."); git("commit", "-qm", "initial");
  const after = headMoveCursor(repo, headTree(repo)!); expect(after).toBeDefined();
  expect(incomingHeadPaths(repo, before!, after!)).toEqual([]);
}, 10_000);

test("#576 more than 64 appended HEAD moves are unknown", () => {
  const f = fixture(), before = f.capture();
  const row = `${before.head} ${before.head} fixture <fixture@localhost> 1 +0000\tcommit: same tree\n`;
  appendFileSync(f.log, row.repeat(65));
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 more than 128 KiB of appended HEAD log is unknown", () => {
  const f = fixture(), before = f.capture();
  const prefix = `${before.head} ${before.head} fixture <fixture@localhost> 1 +0000\tcommit: `;
  appendFileSync(f.log, `${prefix}${"x".repeat(128 * 1024)}\n${prefix}last\n`);
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 an incomplete HEAD old/new chain is unknown", () => {
  const f = fixture(), before = f.capture(); f.commit("own.txt");
  const after = f.capture();
  appendFileSync(f.log, `${before.head} ${after.head} fixture <fixture@localhost> 1 +0000\tcommit: broken chain\n`);
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 a symlinked HEAD logs directory is refused", () => {
  const f = fixture(), before = f.capture();
  const logs = join(f.repo.dir, "logs"); renameSync(logs, `${logs}.old`); symlinkSync(`${logs}.old`, logs);
  expect(headMoveCursor(f.repo, before.tree)).toBeUndefined();
  expect(incomingHeadPaths(f.repo, before, before)).toBeUndefined();
}, 10_000);


test("#576 a proven head/tree state avoids a redundant cursor Git probe", () => {
  const f = fixture();
  const realGit = Bun.which("git")!;
  const bin = join(f.root, "count-bin"), counter = join(f.root, "git-count"); mkdirSync(bin);
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'probe\\n' >> ${quote(counter)}\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const reads = () => readFileSync(counter, "utf8").trim().split("\n").length;
  try {
    const state = headState(f.repo); expect(state).toBeDefined(); expect(state!.head).not.toBeNull();
    expect(reads()).toBe(1);
    expect(headMoveCursor(f.repo, state!.tree, undefined, state!.head)).toBeDefined();
    expect(reads()).toBe(1);
    expect(headMoveCursor(f.repo, state!.tree)).toBeDefined();
    expect(reads()).toBe(2); // Default callers still perform their own current HEAD/tree proof.
  } finally { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; }
}, 10_000);


for (const gitBinary of ["git", ...(existsSync("/opt/homebrew/bin/git") ? ["/opt/homebrew/bin/git"] : [])]) {
  for (const autostash of [false, true]) test(`#612 ${gitBinary} pull --rebase${autostash ? " --autostash" : ""} keeps own sequencer edits out of incoming classification`, () => {
    const f = fixture(gitBinary); f.incoming(); f.commit("own.txt"); const before = f.capture();
    if (autostash) writeFileSync(join(f.root, "own.txt"), "uncommitted in-turn edit\n");
    f.git("pull", "-q", "--rebase", ...(autostash ? ["--autostash"] : []), ".", "incoming");
    const after = f.capture();
    const actions = readFileSync(f.log).subarray(before.size, after.size).toString("utf8").trim().split("\n").map(line => line.slice(line.indexOf("\t") + 1));
    expect(actions.some(action => /\(start\): checkout /.test(action))).toBe(true);
    expect(actions.some(action => /\(pick\): /.test(action))).toBe(true);
    expect(incomingHeadPaths(f.repo, before, after)).toEqual(["incoming.txt"]);
    if (autostash) expect(readFileSync(join(f.root, "own.txt"), "utf8")).toBe("uncommitted in-turn edit\n");
  }, 10_000);
}

for (const phase of ["pick", "reword", "edit", "squash", "fixup", "continue", "finish"]) test(`#576 command-prefixed (${phase}) sequencer rows take precedence as own moves`, () => {
  const f = fixture(), before = f.capture();
  writeFileSync(join(f.root, "own.txt"), "replayed own work\n"); f.git("add", "own.txt");
  f.git("-c", `alias.phase=!GIT_REFLOG_ACTION='pull -q --rebase (${phase})' git commit -qm phase`, "phase");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual([]);
}, 10_000);

for (const phase of ["abort", "unrecognized"]) test(`#576 unknown command-prefixed (${phase}) actions stay unknown`, () => {
  const f = fixture(), before = f.capture();
  writeFileSync(join(f.root, "own.txt"), "unclassified work\n"); f.git("add", "own.txt");
  f.git("-c", `alias.phase=!GIT_REFLOG_ACTION='pull -q --rebase (${phase})' git commit -qm phase`, "phase");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toBeUndefined();
}, 10_000);

test("#576 phase-like text in a reflog message is not an own sequencer action", () => {
  const f = fixture(), before = f.capture();
  writeFileSync(join(f.root, "incoming.txt"), "incoming path\n"); f.git("add", "incoming.txt");
  f.git("-c", "alias.phase=!GIT_REFLOG_ACTION='pull: completed (pick): detail' git commit -qm incoming", "phase");
  expect(incomingHeadPaths(f.repo, before, f.capture())).toEqual(["incoming.txt"]);
}, 10_000);

test("#612 fetch + rebase origin/main with pre-turn own commit and in-turn edit attributes edit and excludes upstream", () => {
  const f = fixture();
  f.incoming();
  f.commit("own.txt", "own commit\n");
  const snapBefore = snapshot(f.repo);
  expect(snapBefore).toBeDefined();
  const before = f.capture();

  // In-turn uncommitted working tree edit
  writeFileSync(join(f.root, "in-turn.txt"), "in-turn edit\n");

  f.git("rebase", "incoming");
  const snapAfter = snapshot(f.repo);
  expect(snapAfter).toBeDefined();
  const after = f.capture();

  const incoming = incomingHeadPaths(f.repo, before, after);
  expect(incoming).toEqual(["incoming.txt"]);

  // End tree diff attributes in-turn edit while excluding upstream
  const changed = changedPaths(f.repo, snapBefore!, snapAfter!);
  expect(changed.sort()).toEqual(["in-turn.txt", "incoming.txt"]);
  const incomingSet = new Set(incoming);
  const attributed = changed.filter(p => !incomingSet.has(p));
  expect(attributed).toEqual(["in-turn.txt"]);
}, 10_000);

test("#612 a 20-pick rebase satisfies the constant-cost git process model within the budget", () => {
  const runPickCount = (n: number) => {
    const f = fixture();
    const realGit = Bun.which("git")!;
    const bin = join(f.root, "count-bin"), counter = join(f.root, "git-count");
    mkdirSync(bin);
    const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf 'probe\\n' >> ${quote(counter)}\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });

    f.incoming();
    for (let i = 1; i <= n; i++) {
      f.commit(`own${i}.txt`, `own${i}\n`);
    }
    const before = f.capture();
    f.git("rebase", "incoming");
    const after = f.capture();

    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    writeFileSync(counter, "");
    try {
      // Controlled clock (#661): the budget never expires regardless of runner speed.
      const budget: SnapshotBudget = { deadline: 10_000, now: () => 0 };
      const incoming = incomingHeadPaths(f.repo, before, after, budget);
      const probeLines = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").filter(Boolean).length : 0;
      return { incoming, probeLines };
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  };

  const two = runPickCount(2);
  const twenty = runPickCount(20);

  expect(two.incoming).toEqual(["incoming.txt"]);
  expect(twenty.incoming).toEqual(["incoming.txt"]);
  // Batching cost model: number of spawned Git processes stays constant as pick count grows
  expect(twenty.probeLines).toBe(two.probeLines);
}, 15_000);

test("#612 rebase -i fixup row cached diff equals exact old..next diff", () => {
  const f = fixture();
  f.incoming();
  f.commit("own1.txt", "own1\n");
  const before = f.capture();

  // Simulate an interactive rebase fixup step amending own1 with own2
  writeFileSync(join(f.root, "own2.txt"), "own2\n");
  f.git("add", "own2.txt");
  f.git("-c", "alias.phase=!GIT_REFLOG_ACTION='rebase -i (fixup)' git commit --amend -qm fixup", "phase");
  const after = f.capture();

  const incoming = incomingHeadPaths(f.repo, before, after);
  expect(incoming).toEqual([]);

  // Diff between before and after contains only own2.txt (the fixup addition)
  expect(before.tree).not.toBeNull();
  expect(after.tree).not.toBeNull();
  const diff = changedPaths(f.repo, before.tree!, after.tree!);
  expect(diff).toEqual(["own2.txt"]);
}, 10_000);

test("#612 batched pick rows separate commit headers from files named after commit IDs", () => {
  const f = fixture();
  f.incoming();
  f.commit("file1.txt", "content1\n");
  const commit1 = f.git("rev-parse", "HEAD");

  // Commit 2: creates a file whose name equals commit1's hash
  writeFileSync(join(f.root, commit1), "tricky filename\n");
  f.git("add", commit1);
  f.git("commit", "-m", "commit with hash-named file");

  const before = f.capture();
  f.git("rebase", "incoming");
  const after = f.capture();

  const incoming = incomingHeadPaths(f.repo, before, after);
  expect(incoming).toEqual(["incoming.txt"]);
}, 10_000);

test("#612 rebase start with criss-cross multiple merge bases stays unknown", () => {
  const f = fixture();
  f.commit("root.txt", "root\n");
  f.git("checkout", "-b", "branchA");
  f.commit("a.txt", "a\n");
  f.git("checkout", "main");
  f.git("checkout", "-b", "branchB");
  f.commit("b.txt", "b\n");

  f.git("checkout", "branchA");
  f.git("merge", "-m", "merge B into A", "branchB");
  const m1 = f.git("rev-parse", "HEAD");

  f.git("checkout", "branchB");
  f.git("merge", "-m", "merge A into B", "branchA~1");
  const m2 = f.git("rev-parse", "HEAD");

  const bases = f.git("merge-base", "--all", m1, m2).trim().split("\n").filter(Boolean);
  expect(bases.length).toBeGreaterThan(1);

  f.git("checkout", "branchA");
  const before = f.capture();
  f.git("-c", `alias.phase=!GIT_REFLOG_ACTION='rebase (start): checkout ${m2}' git reset --hard ${m2}`, "phase");
  const after = f.capture();

  const incoming = incomingHeadPaths(f.repo, before, after);
  expect(incoming).toBeUndefined();
}, 10_000);

