#!/usr/bin/env node
// #610: the tests a change touches, for `scripts/check.sh --changed [<base>]`. Prints `ALL` (run the full suite), or
// one test file per line (possibly none: a docs-only change runs no tests). The full suite stays CI's gate.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const DOCS = /(^docs\/|\.md$|^LICENSE)/;

/** Every `*.test.ts` under test/, nested suites included. */
function allTests(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".test.ts")) out.push(rel);
    }
  };
  walk("test");
  return out;
}

/**
 * `ALL`, or the test files to run: changed tests plus every test that names a changed file directly (an import or a
 * path it reads). Docs need no test; any other changed file that no test names is unknown, so everything runs.
 */
// ponytail: direct references only; a change reached through another module runs in CI's full gate, or add a
// transitive import walk if the selection misses too often.
export function selectTests(changed, root = ".") {
  if (changed.some(file => FULL.some(pattern => pattern.test(file)))) return "ALL";
  const tests = allTests(root).map(test => ({ test, text: readFileSync(join(root, test), "utf8") }));
  const picked = new Set(changed.filter(file => /^test\/.*\.test\.ts$/.test(file) && existsSync(join(root, file))));
  for (const file of changed) {
    if (DOCS.test(file) || /^test\/.*\.test\.ts$/.test(file)) continue;
    const users = tests.filter(({ text }) => text.includes(`/${file}"`) || text.includes(`/${file}'`) || text.includes(`/${file}\``));
    if (!users.length) return "ALL";
    for (const { test } of users) picked.add(test);
  }
  return [...picked].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selected = selectTests(changedFiles(process.argv[2]));
  console.log(selected === "ALL" ? "ALL" : selected.join("\n"));
}
