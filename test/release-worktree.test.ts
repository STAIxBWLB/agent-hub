import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { releaseTrackedClean } from "../src/hub/release-worktree.ts";
import type { ReleaseGit } from "../src/hub/sdlc-release.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-clean-")); roots.push(root);
  const git: ReleaseGit = args => { const result = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 2000 }); return { code: result.status ?? 1, stdout: result.stdout ?? "" }; };
  const command = (...args: string[]) => { const result = git(args); expect(result.code).toBe(0); return result.stdout; };
  command("init", "-q");
  writeFileSync(join(root, "file.txt"), "tracked\n");
  command("add", "file.txt");
  command("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return { root, git, command };
}

test("release tracked comparison ignores untracked files but refuses dirty, staged and missing tracked files", () => {
  const f = fixture();
  expect(releaseTrackedClean(f.root, f.git)).toBe(true);
  writeFileSync(join(f.root, "untracked"), "ignored\n");
  expect(releaseTrackedClean(f.root, f.git)).toBe(true);
  writeFileSync(join(f.root, "file.txt"), "dirty\n");
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
  f.command("add", "file.txt");
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
  f.command("reset", "--hard", "HEAD"); rmSync(join(f.root, "file.txt"));
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
});

test("release tracked comparison never executes a configured clean/process filter", () => {
  const f = fixture(), marker = join(f.root, "filter-ran"), filter = join(f.root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\nprintf ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  f.command("config", "filter.release.clean", filter);
  f.command("config", "filter.release.process", filter);
  writeFileSync(join(f.root, ".gitattributes"), "file.txt filter=release\n");
  // Keep attributes untracked: this still selects the filter for ordinary status,
  // while avoiding setup invoking the very driver under observation.
  expect(releaseTrackedClean(f.root, f.git)).toBe(true);
  expect(existsSync(marker)).toBe(false);
  writeFileSync(join(f.root, "file.txt"), "dirty\n");
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(readFileSync(filter, "utf8")).toContain("printf ran");
});

test("release tracked comparison handles raw symlink targets and executable modes", () => {
  const f = fixture();
  symlinkSync("file.txt", join(f.root, "alias")); f.command("add", "alias");
  f.command("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "link");
  expect(releaseTrackedClean(f.root, f.git)).toBe(true);
  rmSync(join(f.root, "alias")); symlinkSync("untracked", join(f.root, "alias"));
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
  rmSync(join(f.root, "alias")); symlinkSync("file.txt", join(f.root, "alias"));
  chmodSync(join(f.root, "file.txt"), 0o755);
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
});

test("release tracked comparison refuses symlinked parents and unknown inventory", () => {
  const f = fixture();
  mkdirSync(join(f.root, "nested")); writeFileSync(join(f.root, "nested/file"), "x");
  f.command("add", "nested/file"); f.command("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "nested");
  rmSync(join(f.root, "nested"), { recursive: true }); symlinkSync(".", join(f.root, "nested"));
  expect(releaseTrackedClean(f.root, f.git)).toBe(false);
  const inventory = (value: string): ReleaseGit => args => ({ code: 0, stdout: args[0] === "ls-files" ? value : "" });
  for (const value of ["bad", `160000 ${"a".repeat(40)} 0\tfile\0`, `100644 ${"a".repeat(40)} 1\tfile\0`, `100644 ${"a".repeat(40)} 0\t../outside\0`, `100644 ${"a".repeat(40)} 0\tfile\0`.repeat(4097)]) expect(releaseTrackedClean(f.root, inventory(value))).toBe(false);
});
