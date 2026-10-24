import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { readMemoryCodeHead } from "../src/hub/memory-code-head.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-code-head-")), repo = join(root, "repo"); mkdirSync(repo); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => { const result = hubGitSync(["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }); expect(result.status).toBe(0); return result.stdout.trim(); };
  git("init", "-qb", "main"); writeFileSync(join(repo, "a.ts"), "export function retained() {}\n"); git("add", "."); git("commit", "-qm", "first");
  return { root, repo, git, head: git("rev-parse", "HEAD") };
}
test("#367 cached HEAD proof notices branch movement and packed refs without launching Git per read", () => {
  const f = fixture(), bin = join(f.root, "bin"), calls = join(f.root, "git-calls"), original = process.env.PATH, actual = Bun.which("git")!;
  mkdirSync(bin); const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(bin, "git"), ["#!/bin/sh", `printf git >> ${quote(calls)}`, `exec ${quote(actual)} "$@"`, ""].join("\n")); chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${original}`;
  let proof: ReturnType<typeof readMemoryCodeHead>;
  try { proof = readMemoryCodeHead(f.repo); expect(proof?.head).toBe(f.head);
    for (let i = 0; i < 20; i++) expect(proof?.current()).toBe(f.head);
    expect(readFileSync(calls, "utf8")).toBe("git");
  } finally { process.env.PATH = original; }
  for (let i = 0; i < 20; i++) expect(proof?.current()).toBe(f.head);
  f.git("pack-refs", "--all", "--prune"); expect(proof?.current()).toBe(f.head);
  writeFileSync(join(f.repo, "a.ts"), "export function changed() {}\n"); f.git("add", "."); f.git("commit", "-qm", "second");
  expect(proof?.current()).toBe(f.git("rev-parse", "HEAD")); expect(proof?.current()).not.toBe(proof?.head);
  f.git("checkout", "-qb", "other"); expect(proof?.current()).toBeUndefined();
});
test("#367 detached and linked worktree HEADs are bound to their actual Git directory", () => {
  const f = fixture(), worktree = join(f.root, "linked"); f.git("worktree", "add", "--detach", worktree, f.head);
  const proof = readMemoryCodeHead(worktree); expect(proof?.head).toBe(f.head); expect(proof?.current()).toBe(f.head);
  writeFileSync(join(worktree, ".git"), "gitdir: /missing\n"); expect(proof?.current()).toBeUndefined();
  f.git("worktree", "prune");
});
test("#367 malformed, symbolic-link and oversized ref evidence stays unknown", () => {
  const f = fixture(), proof = readMemoryCodeHead(f.repo), ref = join(f.repo, ".git", "refs", "heads", "main");
  expect(proof?.current()).toBe(f.head); writeFileSync(ref, "not a hash\n"); expect(proof?.current()).toBeUndefined();
  writeFileSync(ref, f.head + "\n"); const other = join(f.root, "other"); writeFileSync(other, f.head + "\n"); rmSync(ref); symlinkSync(other, ref); expect(proof?.current()).toBeUndefined();
  rmSync(ref); writeFileSync(ref, "a".repeat(1000)); expect(proof?.current()).toBeUndefined();
});
