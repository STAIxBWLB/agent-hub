import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, planUndo, repoOf, restore, snapshot, Turns, type Repo } from "../src/hub/snapshots.ts";

// issue #33: per-turn snapshots as git trees, and undo that refuses to destroy work it should keep.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function repo(sub = "") {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-snap-")));
  cleanup.push(() => rmSync(top, { recursive: true, force: true }));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", top, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe" });
  git("init", "-q");
  const root = join(top, sub);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "b.txt"), "keep\n");
  writeFileSync(join(top, ".gitignore"), "ignored/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { top, root, git, r: repoOf(root)! };
}
/** A turn: snapshot, let `work` change the tree, snapshot again. */
function turn(r: Repo, work: () => void) {
  const start = snapshot(r)!;
  work();
  const end = snapshot(r)!;
  return { start_tree: start, end_tree: end, changed: changedPaths(r, start, end) };
}

test("a snapshot sees shell-made changes, leaves the index alone and skips ignored files and hub state", () => {
  const { top, git, r } = repo();
  const indexBefore = git("diff", "--cached", "--name-only").stdout.toString();
  const t = turn(r, () => {
    writeFileSync(join(top, "a.txt"), "two\n"); // what a shell command does
    writeFileSync(join(top, "new.txt"), "fresh\n");
    rmSync(join(top, "b.txt"));
    mkdirSync(join(top, "ignored"));
    writeFileSync(join(top, "ignored", "x"), "no");
    mkdirSync(join(top, ".agenthub", "state"), { recursive: true });
    writeFileSync(join(top, ".agenthub", "state", "events.jsonl"), "{}");
  });
  expect(t.changed.sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
  expect(git("diff", "--cached", "--name-only").stdout.toString()).toBe(indexBefore);
  expect(git("status", "--porcelain").stdout.toString()).toContain("?? new.txt"); // still untracked for the user
});

test("undo puts a turn's files back, and refuses files somebody changed afterwards", () => {
  const { top, r } = repo();
  const t = turn(r, () => {
    writeFileSync(join(top, "a.txt"), "two\n");
    writeFileSync(join(top, "new.txt"), "fresh\n");
    rmSync(join(top, "b.txt"));
  });
  writeFileSync(join(top, "a.txt"), "three\n"); // a later turn by another agent
  const plan = planUndo(r, t);
  expect(plan.changedSince).toEqual(["a.txt"]);
  expect(plan.restore.sort()).toEqual(["b.txt", "new.txt"]);
  restore(r, t.start_tree, plan.restore);
  expect(readFileSync(join(top, "b.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(top, "new.txt"))).toBe(false);
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("three\n");
});

test("a path with glob characters restores only itself (review of #47, F2)", () => {
  const { top, r } = repo();
  mkdirSync(join(top, "app", "[s]"), { recursive: true });
  mkdirSync(join(top, "app", "s"), { recursive: true });
  writeFileSync(join(top, "app", "[s]", "page.tsx"), "dynamic\n");
  writeFileSync(join(top, "app", "s", "page.tsx"), "static\n");
  const t = turn(r, () => writeFileSync(join(top, "app", "[s]", "page.tsx"), "dynamic, edited\n"));
  writeFileSync(join(top, "app", "s", "page.tsx"), "static, later work\n");
  const plan = planUndo(r, t);
  expect(plan.restore).toEqual(["app/[s]/page.tsx"]);
  restore(r, t.start_tree, plan.restore);
  expect(readFileSync(join(top, "app", "[s]", "page.tsx"), "utf8")).toBe("dynamic\n");
  expect(readFileSync(join(top, "app", "s", "page.tsx"), "utf8")).toBe("static, later work\n");
});

test("the current state is read like a snapshot: a directory where the turn deleted a file, or a later mode change, is refused (F3)", () => {
  const { top, r } = repo();
  const deleted = turn(r, () => rmSync(join(top, "b.txt")));
  mkdirSync(join(top, "b.txt"));
  writeFileSync(join(top, "b.txt", "new.txt"), "later work\n");
  expect(planUndo(r, deleted)).toMatchObject({ restore: [], changedSince: ["b.txt"] });
  rmSync(join(top, "b.txt"), { recursive: true });

  const edited = turn(r, () => writeFileSync(join(top, "a.txt"), "two\n"));
  chmodSync(join(top, "a.txt"), 0o755);
  expect(planUndo(r, edited).changedSince).toEqual(["a.txt"]);
  chmodSync(join(top, "a.txt"), 0o644);
  expect(planUndo(r, edited).restore).toEqual(["a.txt"]);
});

test("a symlink the turn created is undone, not refused", () => {
  const { top, r } = repo();
  const t = turn(r, () => symlinkSync("a.txt", join(top, "link")));
  const plan = planUndo(r, t);
  expect(plan.restore).toEqual(["link"]);
  restore(r, t.start_tree, plan.restore);
  expect(existsSync(join(top, "link"))).toBe(false);
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("one\n"); // the target is untouched
});

test("files another peer's overlapping turn changed are refused as concurrent; a turn already undone says so (F1)", () => {
  const { top, r } = repo();
  const t = turn(r, () => {
    writeFileSync(join(top, "a.txt"), "mine\n");
    writeFileSync(join(top, "b.txt"), "theirs, written meanwhile\n");
  });
  expect(planUndo(r, t, ["b.txt"])).toMatchObject({ restore: ["a.txt"], concurrent: ["b.txt"], changedSince: [], undone: false });
  restore(r, t.start_tree, t.changed);
  expect(planUndo(r, t).undone).toBe(true);
});

test("a project in a subdirectory snapshots only its own files (F7)", () => {
  const { top, root, r } = repo("pkg/app");
  expect(r.prefix).toBe("pkg/app/");
  const t = turn(r, () => {
    writeFileSync(join(root, "a.txt"), "inside\n");
    writeFileSync(join(top, "elsewhere.txt"), "outside the project\n");
  });
  expect(t.changed).toEqual(["pkg/app/a.txt"]);
});

test("turn records keep the last N per peer, close turns a stopped hub left open, and know which turns overlapped", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-turns-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let turns = new Turns(join(dir, "hub.db"));
  for (let i = 1; i <= 4; i++) {
    turns.begin(`kimi#r.${i}`, "kimi", "t0");
    turns.end(`kimi#r.${i}`, "t1", ["a.txt"], 2);
  }
  turns.begin("codex#r.9", "codex", "t0");
  turns.native("codex#r.9", "turn7");
  turns.native("codex#r.9", "turn8"); // only the first native turn counts
  expect(turns.list("kimi").map((t) => t.id)).toEqual(["kimi#r.4", "kimi#r.3"]);
  expect(turns.get("codex#r.9")).toMatchObject({ native: "turn7", ended: null });
  expect(turns.latest("codex")?.id).toBe("codex#r.9");
  expect(turns.overlapping(turns.get("kimi#r.4")!)).toEqual([]); // codex's turn is open but changed nothing yet
  turns.close();
  turns = new Turns(join(dir, "hub.db")); // the next hub run
  expect(turns.get("codex#r.9")).toMatchObject({ end_tree: null });
  expect(turns.get("codex#r.9")!.ended).not.toBeNull();
  turns.close();
});

test("outside a repository there is nothing to snapshot", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-norepo-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(repoOf(dir)).toBeUndefined();
});
