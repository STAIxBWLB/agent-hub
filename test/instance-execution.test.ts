import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
  expect(resolveInstanceExecutionCwd(project, "codex", undefined, ["implementer"])).toBe(project);
  expect(resolveInstanceExecutionCwd(project, "codex-review", { "codex-review": { kind: "codex" } }, ["reviewer", "verifier"])).toBe(project);
  expect(() => resolveInstanceExecutionCwd(project, "codex-unknown", undefined, ["reviewer"])).toThrow();
});

test("extra implementers need an explicit worktree even when a directory would exist", () => {
  const f = fixture(); f.worktree();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex" } }, ["implementer"])).toThrow();
});

test("extra execution resolves exact relative and absolute registered worktree paths", () => {
  const f = fixture(), path = f.worktree();
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: ".worktrees/codex-2" } }, ["implementer"])).toBe(realPath(path));
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"])).toBe(realPath(path));
  expect(resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["reviewer"])).toBe(realPath(path));
});

test("ordinary directories, nested paths and a different registered worktree are refused", () => {
  const f = fixture(), own = join(f.project, ".worktrees", "codex-2"); mkdirSync(own, { recursive: true });
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: own } }, ["implementer"])).toThrow();
  rmSync(own, { recursive: true }); f.worktree(); mkdirSync(join(own, "nested"));
  for (const path of [join(own, "nested"), f.project, f.worktree("codex-3")]) expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"])).toThrow();
});

test("an explicitly supplied reviewer worktree is validated instead of falling back silently", () => {
  const f = fixture();
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-review", { "codex-review": { kind: "codex", worktree: ".worktrees/codex-review" } }, ["reviewer"])).toThrow();
});

test("a registered external worktree reached through a symlink cannot escape the project", () => {
  const f = fixture(), outside = f.worktree("codex-2", false, join(f.base, "outside"));
  mkdirSync(join(f.project, ".worktrees")); symlinkSync(outside, join(f.project, ".worktrees", "codex-2"), "dir");
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: ".worktrees/codex-2" } }, ["implementer"])).toThrow();
});

test("a detached worktree does not satisfy the implementer branch requirement", () => {
  const f = fixture(), path = f.worktree("codex-2", true);
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"])).toThrow();
});

test("a stale registration cannot authorize a foreign repository occupying that directory", () => {
  const f = fixture(), path = f.worktree(); rmSync(join(path, ".git"));
  const result = hubGitSync(["-C", path, "init", "-q"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(() => resolveInstanceExecutionCwd(f.project, "codex-2", { "codex-2": { kind: "codex", worktree: path } }, ["implementer"])).toThrow();
});

test("an explicitly selected read-only reviewer may use a registered detached worktree", () => {
  const f = fixture(), path = f.worktree("codex-review", true);
  expect(resolveInstanceExecutionCwd(f.project, "codex-review", { "codex-review": { kind: "codex", worktree: path } }, ["reviewer", "verifier"])).toBe(realPath(path));
});
