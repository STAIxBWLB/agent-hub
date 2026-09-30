import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectContext, projectRoot, realPath } from "../src/hub/project.ts";

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

// issue #26: Bun 1.3.14's realpathSync throws ENOENT for an existing path with a backslash in it.
test("realPath resolves paths with a backslash like realpathSync would, and still refuses missing ones", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-realpath-")));
  const root = join(base, "back\\slash");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "a.txt"), "x");
  symlinkSync(join(root, "sub"), join(root, "in\\link"));
  symlinkSync("sub", join(root, "rel\\link"));
  symlinkSync(base, join(root, "out\\link"));
  symlinkSync(join(root, "missing"), join(root, "dang\\ling"));
  expect(realPath(root)).toBe(root);
  expect(realPath(join(root, "a.txt"))).toBe(join(root, "a.txt"));
  expect(realPath(join(root, "in\\link"))).toBe(join(root, "sub"));
  expect(realPath(join(root, "rel\\link"))).toBe(join(root, "sub"));
  expect(realPath(join(root, "out\\link"))).toBe(base);
  expect(() => realPath(join(root, "dang\\ling"))).toThrow();
  expect(() => realPath(join(root, "nope"))).toThrow();
  expect(realPath(base)).toBe(realpathSync(base)); // ordinary paths take realpathSync's answer
  // `..` after a directory is resolved on disk; a link through a missing directory is dangling, not "inside".
  mkdirSync(join(root, "t"));
  writeFileSync(join(root, "t", "x.txt"), "x");
  // Raw strings: join() would collapse the `..` before realPath ever saw it.
  expect(realPath(`${root}/sub/../t/x.txt`)).toBe(join(root, "t", "x.txt"));
  symlinkSync(`${root}/gone/../a.txt`, join(root, "dot\\dot"));
  expect(() => realPath(join(root, "dot\\dot"))).toThrow();
  // Each component comes back as stored on disk: a case-insensitive file system opens other spellings of the same file.
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "x");
  writeFileSync(join(root, "id_rsa"), "x");
  for (const [asked, stored] of [[".GIT/config", ".git/config"], ["id_rſa" /* long s, U+017F */, "id_rsa"]] as const) {
    const folds = existsSync(join(root, asked));
    if (folds) expect(realPath(join(root, asked))).toBe(join(root, stored));
    else expect(() => realPath(join(root, asked))).toThrow();
  }
});
