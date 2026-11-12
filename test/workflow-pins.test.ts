import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// #1403 A6: a tag can be moved; a commit cannot. Dependabot (github-actions) raises the SHA and the version comment together.
test("every workflow action is pinned by a full commit SHA with its version in a comment", () => {
  const dir = join(import.meta.dir, "..", ".github", "workflows");
  const uses = readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).flatMap(name =>
    readFileSync(join(dir, name), "utf8").split("\n").flatMap((line, index) => /^\s*(?:- )?uses:\s/.test(line) ? [{ at: `${name}:${index + 1}`, ref: line.replace(/^\s*(?:- )?uses:\s*/, "") }] : []));
  expect(uses.length).toBeGreaterThan(0);
  for (const { at, ref } of uses) {
    if (ref.startsWith("./")) continue; // a local action or reusable workflow of this repository is pinned by the checkout itself
    expect(ref, at).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  }
  expect(readFileSync(join(import.meta.dir, "..", "SECURITY.md"), "utf8")).toContain("private vulnerability reporting");
});
