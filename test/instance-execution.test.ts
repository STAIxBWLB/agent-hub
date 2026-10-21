import { createProjectAdapterCatalog as builtinProjectCatalog } from "../src/adapters/registry.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstanceExecutionCwd } from "../src/hub/instance-execution.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub execution "))); roots.push(base);
  const project = join(base, "project"); mkdirSync(project);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  const worktree = (id = "codex-2", detached = false, destination = join(project, ".worktrees", id)) => {
    git("worktree", "add", ...(detached ? ["--detach"] : ["-b", id]), destination, "HEAD"); return destination;
  };
  return { base, project, git, worktree };
}

test("builtin execution keeps its exact original root and extra read-only roles can share it", () => {
  const project = "/unchanged/project/path";
  expect(resolveInstanceExecutionCwd(project, "codex", undefined, ["implementer"], builtinProjectCatalog())).toBe(project);
  expect(resolveInstanceExecutionCwd(project, "codex-review", { "codex-review": { kind: "codex" } }, ["reviewer", "verifier"], builtinProjectCatalog())).toBe(project);
  expect(() => resolveInstanceExecutionCwd(project, "codex-unknown", undefined, ["reviewer"], builtinProjectCatalog())).toThrow();
});

test("extra implementers need an explicit worktree even when a directory would exist", () => {
  const f = fixture(); f.worktree();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex" } }, ["implementer"], builtinProjectCatalog())).toThrow();
});

test("extra execution resolves exact relative and absolute registered worktree paths", () => {
  const f = fixture(), path = f.worktree();
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: ".worktrees/codex-2" } }, ["implementer"], builtinProjectCatalog())).toBe(realPath(path));
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"], builtinProjectCatalog())).toBe(realPath(path));
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["reviewer"], builtinProjectCatalog())).toBe(realPath(path));
});

test("ordinary directories, nested paths and a different registered worktree are refused", () => {
  const f = fixture(), own = join(f.project, ".worktrees", "codex-2"); mkdirSync(own, { recursive: true });
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: own } }, ["implementer"], builtinProjectCatalog())).toThrow();
  rmSync(own, { recursive: true }); f.worktree(); mkdirSync(join(own, "nested"));
  for (const path of [join(own, "nested"), f.project, f.worktree("codex-3")]) expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"], builtinProjectCatalog())).toThrow();
});

test("an explicitly supplied reviewer worktree is validated instead of falling back silently", () => {
  const f = fixture();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-review", { "codex-review": { kind: "codex", worktree: ".worktrees/codex-review" } }, ["reviewer"], builtinProjectCatalog())).toThrow();
});

test("a registered external worktree reached through a symlink cannot escape the project", () => {
  const f = fixture(), outside = f.worktree("codex-2", false, join(f.base, "outside"));
  mkdirSync(join(f.project, ".worktrees")); symlinkSync(outside, join(f.project, ".worktrees", "codex-2"), "dir");
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: ".worktrees/codex-2" } }, ["implementer"], builtinProjectCatalog())).toThrow();
});

test("a detached worktree does not satisfy the implementer branch requirement", () => {
  const f = fixture(), path = f.worktree("codex-2", true);
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"], builtinProjectCatalog())).toThrow();
});

test("a stale registration cannot authorize a foreign repository occupying that directory", () => {
  const f = fixture(), path = f.worktree(); rmSync(join(path, ".git"));
  const result = hubGitSync(["-C", path, "init", "-q"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"], builtinProjectCatalog())).toThrow();
});

test("an explicitly selected read-only reviewer may use a registered detached worktree", () => {
  const f = fixture(), path = f.worktree("codex-review", true);
  expect(resolveInstanceExecutionCwd(f.project, "codex-review", { "codex-review": { kind: "codex", worktree: path } }, ["reviewer", "verifier"], builtinProjectCatalog())).toBe(realPath(path));
});

// #225 N4: resolveInstanceExecutionCwd runs on the daemon's event loop (an extra-instance start and turn_revert) and makes up to four git
// calls. Each had its own 5 s timeout, so a hung git could hold the loop for 20 s; the four now share one budget.
test("the git calls of one resolution share a single budget instead of one timeout each (#225)", () => {
  const f = fixture(); f.worktree();
  const decl = { "codex-2": { kind: "codex" as const, worktree: ".worktrees/codex-2" } };
  const catalog = builtinProjectCatalog(), want = join(f.project, ".worktrees", "codex-2");
  // A clock that moves 100 ms every time the resolution reads it: no sleeping and no real timing, so the result cannot flake.
  const ticking = () => { let t = 0, reads = 0; return { now: () => { reads++; const at = t; t += 100; return at; }, reads: () => reads }; };
  // Budget 250 ms: the deadline is read once (t=0), then each git call reads the clock before it starts: 100 ms (150 left, runs), 200 ms
  // (50 left, runs), 300 ms (spent: refused without starting git). The third of the resolution's calls never runs.
  const spent = ticking();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", decl, ["implementer"], catalog, 250, spent.now)).toThrow("Git workspace evidence unavailable");
  expect(spent.reads()).toBe(4);
  // A budget that covers all four calls (deadline read, then 100, 200, 300, 400 ms of 1000) resolves to the same directory as the default.
  const roomy = ticking();
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", decl, ["implementer"], catalog, 1000, roomy.now)).toBe(want);
  expect(roomy.reads()).toBe(5);
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", decl, ["implementer"], catalog)).toBe(want);
  // Each git call is handed what is LEFT of the allowance as its own timeout, so a hung git cannot hold the loop past the allowance.
  const timeouts: number[] = [], seen = ticking();
  const recording = ((args: string[], options: { timeout?: number }) => { timeouts.push(options.timeout!); return hubGitSync(args, options as never); }) as typeof hubGitSync;
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", decl, ["implementer"], catalog, 1000, seen.now, recording)).toBe(want);
  expect(timeouts).toEqual([900, 800, 700, 600]); // 1000 ms minus 100 ms per read of the clock before each of the four calls
  // No allowance at all refuses before any git runs.
  const none = ticking();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", decl, ["implementer"], catalog, 0, none.now)).toThrow("Git workspace evidence unavailable");
  expect(none.reads()).toBe(2);
});

test("the default budget is one 5 s allowance for all of a resolution's git calls, never 4 x 5 s (#225)", () => {
  const source = readFileSync(new URL("../src/hub/instance-execution.ts", import.meta.url), "utf8");
  expect(source).toMatch(/GIT_BUDGET_MS = 5000/);
  expect(source).not.toMatch(/timeout: GIT_TIMEOUT_MS/); // no per-call 5 s any more
});
