#!/usr/bin/env node
// #610: the tests a change touches, for `scripts/check.sh --changed [<base>]`. Prints `ALL` (run the full suite), or
// one test file per line (possibly none: a docs-only change runs no tests). The full suite stays CI's gate.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Files changed against `base` (committed, staged, unstaged and untracked), as repo-relative paths. */
export function changedFiles(base, root = ".") {
  const from = base ?? git(root, "merge-base", "origin/main", "HEAD");
  const lines = [git(root, "diff", "--name-only", from), git(root, "ls-files", "--others", "--exclude-standard")].join("\n");
  return [...new Set(lines.split("\n").filter(Boolean))];
}

// The gate itself, the runtime and shared fixtures: anything here can change any test's outcome.
const FULL = [/^scripts\/(check\.sh|changed-tests\.mjs|record-test-process\.mjs|hang-watch\.sh|check-owned-processes\.mjs)$/,
  /^(package\.json|bun\.lock|bunfig\.toml|tsconfig\.json|\.bun-version)$/, /^test\/(?!.*\.test\.ts$)/];

/** `ALL`, or the test files to run: changed tests plus tests that import a changed src module directly. */
// ponytail: direct imports only; a change reached through another module runs in CI's full gate, or add a
// transitive import walk if the selection misses too often.
export function selectTests(changed, root = ".") {
  if (changed.some(file => FULL.some(pattern => pattern.test(file)))) return "ALL";
  const tests = readdirSync(join(root, "test")).filter(name => name.endsWith(".test.ts")).map(name => `test/${name}`);
  const picked = new Set(changed.filter(file => /^test\/.*\.test\.ts$/.test(file) && existsSync(join(root, file))));
  const modules = changed.filter(file => /^src\/.*\.(ts|js)$/.test(file));
  for (const test of tests) {
    const text = readFileSync(join(root, test), "utf8");
    if (modules.some(module => text.includes(`/${module}"`) || text.includes(`/${module}'`))) picked.add(test);
  }
  // A code change that maps to no test is unknown, not "nothing to run".
  if (!picked.size && changed.some(file => /^(src|test)\//.test(file) && (!existsSync(join(root, file)) || statSync(join(root, file)).isFile()))) return "ALL";
  return [...picked].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selected = selectTests(changedFiles(process.argv[2]));
  console.log(selected === "ALL" ? "ALL" : selected.join("\n"));
}
