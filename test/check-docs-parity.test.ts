import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SpecsEngine, type SpecsFreshnessState } from "../src/hub/specs.ts";
import { parseSpecsConfig } from "../src/hub/specs-config.ts";
import { realPath } from "../src/hub/project.ts";

// #1064 T3 (AC9): scripts/check-docs.mjs and the shared freshness engine (src/hub/specs.ts) must give the same verdict on the same stamps. check-docs.mjs stays a self-contained Node script
// because the release workflow runs it on Node 22 without Bun or an install (the engine imports TypeScript that plain Node cannot load), so this differential test, not shared code, is what keeps them equal.
const checker = resolve(import.meta.dir, "../scripts/check-docs.mjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const made = mkdtempSync(join(tmpdir(), "ahub-docs-diff-")); roots.push(made); // registered before anything that can throw
  const root = realPath(made);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(join(root, "docs/agent-notes"), { recursive: true }); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/covered.ts"), "initial\n"); writeFileSync(join(root, "src/other.ts"), "initial\n");
  writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}\n');
  const docs = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"];
  for (const doc of docs) writeFileSync(join(root, doc), doc === "README.md" ? "Status: 1.2.3, control protocol 13.\n" : "Fixture\n");
  git("init", "-q"); git("add", "."); git("commit", "-qm", "initial");
  return { root, git, docs, head: () => git("rev-parse", "HEAD") };
}
const writeStamps = (root: string, entries: Record<string, unknown>) => writeFileSync(join(root, "docs/verified.json"), JSON.stringify({ schemaVersion: 1, documents: entries }));
const scriptVerdicts = (root: string) => {
  const run = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" });
  const report = JSON.parse(run.stdout) as { documents: { path?: string; state: string; commits?: number; dirty?: boolean }[]; errors: number };
  return Object.fromEntries(report.documents.filter(row => row.path).map(row => [row.path!, { state: row.state, commits: row.commits ?? null, dirty: row.dirty ?? null }]));
};
const engineVerdicts = (root: string) => {
  const report = new SpecsEngine(root, parseSpecsConfig({ stamps_file: "docs/verified.json" })).check();
  return Object.fromEntries(report.freshness.map(row => [row.path, { state: row.state as SpecsFreshnessState, commits: row.commitsSince, dirty: row.dirty }]));
};

test("check-docs.mjs and the shared engine give the same state, commit count and dirty flag for fresh, stale, dirty and non-ancestor stamps (#1064 AC9)", () => {
  const { root, git, docs, head } = repo();
  const first = head();
  // a commit that touches the covered file, then stamps taken at different points
  writeFileSync(join(root, "src/covered.ts"), "changed once\n"); git("add", "."); git("commit", "-qm", "change covered");
  writeFileSync(join(root, "src/covered.ts"), "changed twice\n"); git("add", "."); git("commit", "-qm", "change covered again");
  const now = head();
  const unrelated = git("commit-tree", git("write-tree"), "-m", "another history");
  writeStamps(root, {
    "README.md": { verifiedAgainst: now, paths: ["src/covered.ts"] },                // fresh
    "docs/security.md": { verifiedAgainst: first, paths: ["src/covered.ts"] },       // stale, two commits
    "docs/operations.md": { verifiedAgainst: first, paths: ["src/other.ts"] },       // fresh: the covered file never changed
    "docs/quickstart.md": { verifiedAgainst: unrelated, paths: ["src/covered.ts"] }, // not an ancestor
    "docs/agent-notes/example.md": { verifiedAgainst: now, paths: ["src/other.ts"] }, // made dirty below
  });
  git("add", "."); git("commit", "-qm", "stamps");
  writeFileSync(join(root, "src/other.ts"), "uncommitted edit\n");
  const script = scriptVerdicts(root), engine = engineVerdicts(root);
  expect(Object.keys(script).sort()).toEqual([...docs].sort());
  expect(script["README.md"]).toEqual({ state: "fresh", commits: 0, dirty: false });
  expect(script["docs/security.md"]).toEqual({ state: "stale", commits: 2, dirty: false });
  expect(script["docs/quickstart.md"]!.state).toBe("nonancestor");
  expect(script["docs/agent-notes/example.md"]).toEqual({ state: "stale", commits: 0, dirty: true });
  // the engine says the same about every document, field by field
  for (const doc of docs) {
    const a = script[doc]!, b = engine[doc]!;
    expect({ doc, state: b.state as string }).toEqual({ doc, state: a.state });
    if (a.state === "fresh" || a.state === "stale") expect({ doc, commits: b.commits, dirty: b.dirty }).toEqual({ doc, commits: a.commits, dirty: a.dirty });
  }
});

test("both refuse the same malformed entries: an unresolvable stamp and a covered path that no longer exists (#1064 AC9)", () => {
  const { root, git, head } = repo();
  const stamp = head();
  writeStamps(root, {
    "README.md": { verifiedAgainst: "f".repeat(40), paths: ["src/covered.ts"] },     // does not resolve
    "docs/security.md": { verifiedAgainst: stamp, paths: ["src/missing.ts"] },        // covers nothing tracked
    "docs/operations.md": { verifiedAgainst: stamp, paths: ["src/covered.ts"] },      // fine
  });
  git("add", "."); git("commit", "-qm", "stamps");
  const script = spawnSync("node", [checker, root, "--json"], { encoding: "utf8" });
  expect(script.status).toBe(1); // check-docs fails on a malformed entry
  const report = new SpecsEngine(root, parseSpecsConfig({ stamps_file: "docs/verified.json" })).check();
  expect(report.errors).toBeGreaterThan(0); // and so does the engine
  const codes = report.items.map(row => row.code);
  expect(codes).toContain("invalid-verified-against");
  expect(codes).toContain("stamps-invalid-entry");
  // the well-formed entry is judged the same by both
  expect(scriptVerdicts(root)["docs/operations.md"]!.state).toBe("fresh");
  expect(engineVerdicts(root)["docs/operations.md"]!.state).toBe("fresh");
});
