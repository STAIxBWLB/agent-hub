import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedPaths, planUndo, repoOf, restore, snapshot, Turns } from "../src/hub/snapshots.ts";

// issue #33: per-turn snapshots as git trees, and undo that refuses to destroy later work.
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function repo() {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-snap-")));
  cleanup.push(() => rmSync(top, { recursive: true, force: true }));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", top, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { stdout: "pipe" });
  git("init", "-q");
  writeFileSync(join(top, "a.txt"), "one\n");
  writeFileSync(join(top, "b.txt"), "keep\n");
  writeFileSync(join(top, ".gitignore"), "ignored/\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { top, git };
}

test("a snapshot sees shell-made changes, leaves the index alone and skips ignored files and hub state", () => {
  const { top, git } = repo();
  const r = repoOf(top)!;
  const indexBefore = git("diff", "--cached", "--name-only").stdout.toString();
  const start = snapshot(r)!;
  writeFileSync(join(top, "a.txt"), "two\n"); // what a shell command does
  writeFileSync(join(top, "new.txt"), "fresh\n");
  rmSync(join(top, "b.txt"));
  mkdirSync(join(top, "ignored"));
  writeFileSync(join(top, "ignored", "x"), "no");
  mkdirSync(join(top, ".agenthub", "state"), { recursive: true });
  writeFileSync(join(top, ".agenthub", "state", "events.jsonl"), "{}");
  const end = snapshot(r)!;
  expect(changedPaths(top, start, end).sort()).toEqual(["a.txt", "b.txt", "new.txt"]);
  expect(git("diff", "--cached", "--name-only").stdout.toString()).toBe(indexBefore);
  expect(git("status", "--porcelain").stdout.toString()).toContain("?? new.txt"); // still untracked for the user
});

test("undo puts a turn's files back and refuses files somebody changed afterwards", () => {
  const { top } = repo();
  const r = repoOf(top)!;
  const start = snapshot(r)!;
  writeFileSync(join(top, "a.txt"), "two\n");
  writeFileSync(join(top, "new.txt"), "fresh\n");
  rmSync(join(top, "b.txt"));
  const end = snapshot(r)!;
  const turn = { start_tree: start, end_tree: end, changed: changedPaths(top, start, end) };
  writeFileSync(join(top, "a.txt"), "three\n"); // a later turn by another agent
  const plan = planUndo(top, turn);
  expect(plan.conflicts).toEqual(["a.txt"]);
  expect(plan.restore.sort()).toEqual(["b.txt", "new.txt"]);
  restore(top, start, plan.restore);
  expect(readFileSync(join(top, "b.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(top, "new.txt"))).toBe(false);
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("three\n");
});

test("turn records keep the last N per peer", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-turns-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const turns = new Turns(join(dir, "hub.db"));
  for (let i = 1; i <= 4; i++) {
    turns.begin(`kimi#r.${i}`, "kimi", "t0");
    turns.end(`kimi#r.${i}`, "t1", ["a.txt"], 2);
  }
  turns.begin("codex#r.9", "codex", "t0");
  turns.native("codex#r.9", "turn7");
  expect(turns.list("kimi").map((t) => t.id)).toEqual(["kimi#r.4", "kimi#r.3"]);
  expect(turns.get("codex#r.9")).toMatchObject({ native: "turn7", ended: null });
  expect(turns.latest("codex")?.id).toBe("codex#r.9");
  turns.close();
});

test("outside a repository there is nothing to snapshot", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-norepo-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  expect(repoOf(dir)).toBeUndefined();
});
