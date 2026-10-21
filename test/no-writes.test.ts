import type { Task } from "../src/hub/board.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { expect, test } from "bun:test";
import { DEFAULT_TASK_SWEEP, taskSweepConfig } from "../src/hub/task-sweep.ts";

type Observation = { task: number; generation: string; limit: number; changed: boolean | undefined; effect: boolean };
type Counter = {
  observe(input: Observation): number | undefined;
  reset(task: number): void;
  retain(activeTaskIds: readonly number[]): void;
};
// Load the new helper per case, so the existing config's red assertions still run before implementation exists.
const counter = async (): Promise<Counter> => new (await import("../src/hub/no-writes.ts")).NoWriteTurns();
const observe = (turns: Counter, overrides: Partial<Observation> = {}) => turns.observe({ task: 17, generation: "codex:accepted:1", limit: 2, changed: false, effect: false, ...overrides });

test("#498 two proven no-write turns emit the streak count once", async () => {
  const turns = await counter();
  expect(observe(turns)).toBeUndefined();
  expect(observe(turns)).toBe(2);
  for (let i = 0; i < 10; i++) expect(observe(turns)).toBeUndefined();
});

test("#498 a one-turn threshold emits on the first proven no-write turn only", async () => {
  const turns = await counter();
  expect(observe(turns, { limit: 1 })).toBe(1);
  expect(observe(turns, { limit: 1 })).toBeUndefined();
});

for (const [name, reset] of [
  ["a changed workspace", { changed: true }],
  ["a proven non-file effect", { effect: true }],
  ["unknown workspace evidence", { changed: undefined }],
  ["the disabled threshold", { limit: 0 }],
] as const) test(`#498 ${name} clears an emitted no-write streak`, async () => {
  const turns = await counter();
  expect(observe(turns)).toBeUndefined(); expect(observe(turns)).toBe(2);
  expect(observe(turns, reset)).toBeUndefined();
  expect(observe(turns)).toBeUndefined(); expect(observe(turns)).toBe(2);
  expect(observe(turns)).toBeUndefined();
});

for (const reset of [{ changed: true }, { effect: true }, { changed: undefined }, { limit: 0 }]) test(`#498 reset before warning discards the partial streak (${JSON.stringify(reset)})`, async () => {
  const turns = await counter();
  expect(observe(turns)).toBeUndefined();
  expect(observe(turns, reset)).toBeUndefined();
  expect(observe(turns)).toBeUndefined();
  expect(observe(turns)).toBe(2);
});

test("#498 a changed owner or latest acceptance starts a new generation", async () => {
  const turns = await counter();
  expect(observe(turns)).toBeUndefined();
  expect(observe(turns, { generation: "kimi:accepted:2" })).toBeUndefined();
  expect(observe(turns, { generation: "kimi:accepted:2" })).toBe(2);
  expect(observe(turns, { generation: "kimi:accepted:3" })).toBeUndefined();
  expect(observe(turns, { generation: "kimi:accepted:3" })).toBe(2);
});

test("#498 independent tasks retain independent no-write streaks", async () => {
  const turns = await counter();
  expect(observe(turns, { task: 1 })).toBeUndefined();
  expect(observe(turns, { task: 2 })).toBeUndefined();
  expect(observe(turns, { task: 1 })).toBe(2);
  expect(observe(turns, { task: 2 })).toBe(2);
});

test("#498 explicit reset removes only the named task's streak", async () => {
  const turns = await counter();
  observe(turns, { task: 1 }); observe(turns, { task: 2 });
  turns.reset(1); turns.reset(99);
  expect(observe(turns, { task: 1 })).toBeUndefined();
  expect(observe(turns, { task: 2 })).toBe(2);
  expect(observe(turns, { task: 1 })).toBe(2);
});

test("#498 retain prunes inactive task generations without losing active streaks", async () => {
  const turns = await counter();
  observe(turns, { task: 1 }); observe(turns, { task: 2 });
  turns.retain([1]);
  expect(observe(turns, { task: 1 })).toBe(2);
  expect(observe(turns, { task: 2 })).toBeUndefined();
  turns.retain([]);
  expect(observe(turns, { task: 1 })).toBeUndefined();
  expect(observe(turns, { task: 2 })).toBeUndefined();
});

test("#498 a live threshold change emits the actual count without duplicate warnings", async () => {
  const turns = await counter();
  expect(observe(turns, { limit: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  expect(observe(turns, { limit: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  const count = observe(turns, { limit: 2 });
  expect(count).toBe(3); expect(Number.isSafeInteger(count)).toBe(true);
  expect(observe(turns, { limit: 1 })).toBeUndefined();
  expect(observe(turns, { limit: Number.MAX_SAFE_INTEGER })).toBeUndefined();
});

test("#498 no-write detection defaults to two turns independently of the disabled time sweep", () => {
  expect(DEFAULT_TASK_SWEEP).toMatchObject({ enabled: false, no_writes_turns: 2 });
  expect(taskSweepConfig(undefined)).toMatchObject({ enabled: false, no_writes_turns: 2 });
  expect(taskSweepConfig({ enabled: false, no_writes_turns: 3 })).toMatchObject({ enabled: false, no_writes_turns: 3 });
  expect(taskSweepConfig({ enabled: true, no_writes_turns: 0 })).toMatchObject({ enabled: true, no_writes_turns: 0 });
});

for (const value of [0, 1, 2, 1000, Number.MAX_SAFE_INTEGER]) test(`#498 no-write threshold accepts safe nonnegative integer ${value}`, () => {
  expect(taskSweepConfig({ no_writes_turns: value })).toMatchObject({ no_writes_turns: value });
});

for (const [name, value] of [
  ["negative", -1], ["fractional", 1.5], ["NaN", NaN], ["infinite", Infinity], ["negative infinite", -Infinity],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["huge finite", Number.MAX_VALUE],
  ["numeric string", "2"], ["zero string", "0"], ["truthy string", "true"], ["true", true], ["false", false],
  ["null", null], ["array", []], ["object", {}],
] as const) test(`#498 no-write threshold refuses ${name} without coercion`, () => {
  expect(() => taskSweepConfig({ no_writes_turns: value })).toThrow(/no_writes_turns/);
});

test("#498 omission and explicit undefined retain the default without mutating caller config", () => {
  const input = Object.freeze({ enabled: false, no_writes_turns: undefined });
  expect(taskSweepConfig(input)).toMatchObject({ enabled: false, no_writes_turns: 2 });
  expect(taskSweepConfig({})).toMatchObject({ no_writes_turns: 2 });
  expect(input.no_writes_turns).toBeUndefined();
});

for (const op of ["hub_check_start", "hub_check_cancel", "hub_task_escalate", "hub_memory_correct"]) test(`#498 ${op} is an owner-turn effect`, async () => {
  const { ownerToolEffect } = await import("../src/hub/no-writes.ts");
  expect(ownerToolEffect(op, {})).toBe(true);
});
test("#498 owner-turn effects exclude reads and a bare accept", async () => {
  const { ownerToolEffect } = await import("../src/hub/no-writes.ts");
  for (const op of ["hub_task_list", "hub_check_result", "hub_memory_search", "hub_task_accept"]) expect(ownerToolEffect(op, {})).toBe(false);
  expect(ownerToolEffect("hub_task_accept", { plan: { paths: ["src/a.ts"] } })).toBe(true);
});


for (const evidence of [
  { refs: { branch: "feat/work" } }, { refs: { commit: "a".repeat(40) } },
  { refs: { paths: ["/project/.worktrees/owner/a.ts"] } }, { refs: {}, plan: { paths: [".worktrees/owner/a.ts"] } },
  { refs: {}, sdlc: { stage: "build", head: "a".repeat(40) } },
  { refs: {}, sdlc: { stage: "build", localHead: "b".repeat(40) } }, { refs: {}, sdlc: { stage: "build", pr: 2 } },
] satisfies Pick<Task, "refs" | "plan" | "sdlc">[]) test(`#498 recorded work outside the canonical capture is unknown: ${JSON.stringify(evidence)}`, async () => {
  const { canonicalWriteUnknown } = await import("../src/hub/no-writes.ts");
  expect(canonicalWriteUnknown(evidence)).toBe(true);
  expect(canonicalWriteUnknown({ refs: { paths: ["src/worktrees.ts"] } })).toBe(false);
  // A case-insensitive disk opens .WORKTREES as .worktrees: the hint must match in any case.
  expect(canonicalWriteUnknown({ refs: { paths: [".WORKTREES/owner/file.ts"] } })).toBe(true);
  expect(canonicalWriteUnknown({ refs: {}, plan: { paths: ["a\\.Worktrees\\x"] } })).toBe(true);
});

test("#498 branch fingerprints cover shared local/remote refs and never expose names", async () => {
  const { branchHeads, soleWorktree, headState, repoOf, SnapshotBudgetExceeded } = await import("../src/hub/snapshots.ts");
  const root = mkdtempSync(join(tmpdir(), "ahub-no-write-refs-"));
  try {
    const git = (...args: string[]) => {
      const result = hubGitSync(["-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
      expect(result.status).toBe(0); return result.stdout.trim();
    };
    git("init", "-qb", "main"); git("commit", "--allow-empty", "-qm", "base");
    const repo = repoOf(root)!, first = branchHeads(repo), head = headState(repo);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(soleWorktree(repo)).toBe(true);
    git("tag", "not-an-owner-branch");
    expect(branchHeads(repo)).toBe(first);
    git("branch", "private-name-is-not-exported");
    const second = branchHeads(repo);
    expect(second).not.toBe(first); expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(headState(repo)).toEqual(head);
    expect(soleWorktree(repo)).toBe(true); // An unchecked-out branch is not another execution root.
    git("worktree", "add", "--detach", join(root, "detached"), "HEAD");
    expect(branchHeads(repo)).toBe(second); // Detached worktrees need scope evidence beyond refs/heads.
    git("update-ref", "refs/remotes/origin/push-progress", git("rev-parse", "HEAD"));
    expect(branchHeads(repo)).not.toBe(second); // Push-only progress also changes the shared-ref evidence.
    expect(soleWorktree(repo)).toBe(false);
    expect(() => soleWorktree(repo, { deadline: performance.now() - 1 })).toThrow(SnapshotBudgetExceeded);
    expect(soleWorktree({ ...repo, top: join(root, "missing") })).toBeUndefined();
    expect(() => branchHeads(repo, { deadline: performance.now() - 1 })).toThrow(SnapshotBudgetExceeded);
    expect(branchHeads({ ...repo, top: join(root, "missing") })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("#498 a valid project-bound shadow repository has known sole-worktree scope", async () => {
  const { initShadow, repoOf, snapshot, soleWorktree, SnapshotBudgetExceeded } = await import("../src/hub/snapshots.ts");
  const root = mkdtempSync(join(tmpdir(), "ahub-no-write-shadow-"));
  try {
    mkdirSync(join(root, ".agenthub"));
    writeFileSync(join(root, "owned.txt"), "shadow work\n");
    expect(initShadow(root)).toBe(true);
    const repo = repoOf(root)!;
    expect(repo.shadow).toBe(true); expect(snapshot(repo)).toMatch(/^[a-f0-9]{40,64}$/);
    expect(soleWorktree(repo)).toBe(true);
    expect(() => soleWorktree(repo, { deadline: performance.now() - 1 })).toThrow(SnapshotBudgetExceeded);
    // A shadow flag alone never bypasses its metadata/path guard.
    symlinkSync(join(root, "owned.txt"), join(repo.dir, "unsafe-link"));
    expect(() => soleWorktree(repo)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
