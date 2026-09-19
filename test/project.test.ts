import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContext, projectRoot } from "../src/hub/project.ts";

const git = (dir: string) => {
  Bun.spawnSync(["git", "init", "-q", dir]);
};

test("projectRoot uses the nearest ahub config inside the git boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-project-"));
  git(root);
  mkdirSync(join(root, "nested", ".agenthub"), { recursive: true });
  mkdirSync(join(root, "nested", "child"), { recursive: true });
  writeFileSync(join(root, "nested", ".agenthub", "config.json"), "{}\n");
  expect(projectRoot(join(root, "nested", "child"))).toBe(realpathSync(join(root, "nested")));
});

test("projectRoot resolves symlinks and rejects invalid targets", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-project-"));
  git(root);
  const link = join(mkdtempSync(join(tmpdir(), "ahub-link-")), "repo");
  symlinkSync(root, link);
  expect(projectRoot(link)).toBe(realpathSync(root));
  expect(() => projectRoot(join(root, "missing"))).toThrow(/cannot resolve project directory/);
});

test("inherited state is accepted only with a matching marker or pinned project", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-project-"));
  git(root);
  mkdirSync(join(root, "src"));
  const state = join(root, ".agenthub", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "project.json"), JSON.stringify({ root }));
  expect(projectContext(join(root, "src"), { AGENTHUB_STATE_DIR: state }).root).toBe(realpathSync(root));
  expect(projectContext(root, { AGENTHUB_STATE_DIR: state, AGENTHUB_PROJECT_DIR: root }).stateDir).toBe(realpathSync(state));
  expect(projectContext(root, { AGENTHUB_STATE_DIR: "/other/state" }).stateDir).toBe(join(realpathSync(root), ".agenthub", "state"));
  const other = mkdtempSync(join(tmpdir(), "ahub-other-state-"));
  writeFileSync(join(other, "project.json"), JSON.stringify({ root: "/different/project" }));
  expect(projectContext(root, { AGENTHUB_STATE_DIR: other, AGENTHUB_PROJECT_DIR: root }).stateDir).toBe(join(realpathSync(root), ".agenthub", "state"));
});

test("worktrees and nested repositories do not inherit parent project config", () => {
  const parent = mkdtempSync(join(tmpdir(), "ahub-worktree-parent-"));
  git(parent);
  Bun.spawnSync(["git", "-C", parent, "config", "user.email", "test@example.com"]);
  Bun.spawnSync(["git", "-C", parent, "config", "user.name", "Test"]);
  writeFileSync(join(parent, "README"), "root\n");
  Bun.spawnSync(["git", "-C", parent, "add", "README"]);
  Bun.spawnSync(["git", "-C", parent, "commit", "-qm", "init"]);
  mkdirSync(join(parent, ".agenthub"), { recursive: true });
  writeFileSync(join(parent, ".agenthub", "config.json"), "{}\n");
  const worktree = join(mkdtempSync(join(tmpdir(), "ahub-worktree-")), "branch");
  expect(Bun.spawnSync(["git", "-C", parent, "worktree", "add", "-q", "-b", "branch", worktree]).exitCode).toBe(0);
  expect(projectRoot(worktree)).toBe(realpathSync(worktree));

  const nested = join(mkdtempSync(join(tmpdir(), "ahub-nested-parent-")), "parent");
  git(nested);
  mkdirSync(join(nested, ".agenthub"), { recursive: true });
  writeFileSync(join(nested, ".agenthub", "config.json"), "{}\n");
  const child = join(nested, "child");
  git(child);
  expect(projectRoot(child)).toBe(realpathSync(child));
});
