import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import { RELEASE_CHECKER, packageDigest, stageCurrentRuntime } from "../src/cli/recovery-package.ts";
import { readDocEvidenceDetailed } from "../src/hub/sdlc-release.ts";
import { VERSION } from "../src/version.ts";

// #667 AC1: a captured runtime (~/.agenthub/releases/<v>/source-<digest>/) must carry the documentation checker that release consent spawns.
const REPO = realPath(resolve(import.meta.dir, ".."));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const temp = (prefix: string) => { const made = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(made, { recursive: true, force: true })); return realPath(made); }; // registered before anything can throw
const put = (root: string, name: string, text: string) => { const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

function tinySource(withChecker: boolean) {
  const source = join(temp("ahub-checker-src-"), "package");
  put(source, "package.json", JSON.stringify({ name: "@staix/agent-hub", version: VERSION }));
  put(source, "src/cli/main.js", "// fixture\n");
  put(source, "plugins/agent-hub/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-hub", version: VERSION }));
  put(source, "plugins/agent-hub/server.js", "// fixture\n"); put(source, "templates/fixture.txt", "fixture\n"); put(source, ".claude-plugin/marketplace.json", "{}\n");
  for (const name of ["README.md", "LICENSE", "CHANGELOG.md"]) put(source, name, `fixture ${name}\n`);
  if (withChecker) put(source, RELEASE_CHECKER, "// checker fixture\n");
  return source;
}
function capture(source: string) {
  const home = join(temp("ahub-checker-home-"), "home"); mkdirSync(home);
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  return { home, registry, value: stageCurrentRuntime(source, VERSION, home, registry) };
}

test("#667 a capture of this checkout carries the documentation checker byte for byte, and its digest still verifies", () => {
  const { value } = capture(REPO);
  const copy = join(value.root, RELEASE_CHECKER);
  expect(lstatSync(copy).isFile()).toBe(true);
  expect(readFileSync(copy)).toEqual(readFileSync(join(REPO, RELEASE_CHECKER)));
  // The digest is deliberately unchanged by the checker (ponytail in recovery-package.ts): the capture verifies against the source digest.
  expect(packageDigest(value.root, { ownDependencies: true })).toBe(value.digest);
});

test("#667 the checker in a capture reads real committed evidence, so consent can be recorded from a captured hub", async () => {
  const { value } = capture(REPO);
  const repo = temp("ahub-checker-repo-");
  const git = (...args: string[]) => { const run = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null" } }); if (run.status !== 0) throw new Error(run.stderr); return run.stdout.trim(); };
  put(repo, "package.json", '{"version":"1.2.3"}\n'); put(repo, "README.md", "Status: 1.2.3, control protocol 13.\n");
  for (const doc of ["docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"]) put(repo, doc, "Fixture\n");
  put(repo, "src/covered.ts", "initial\n");
  git("init", "-q"); git("add", "."); git("commit", "-qm", "initial");
  const head = git("rev-parse", "HEAD");
  const stamps = Object.fromEntries(["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"].map(doc => [doc, { verifiedAgainst: head, paths: ["src/covered.ts"] }]));
  put(repo, "docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: stamps })); git("add", "."); git("commit", "-qm", "stamps");
  const read = await readDocEvidenceDetailed(repo, 10_000, join(value.root, RELEASE_CHECKER));
  expect(read).toMatchObject({ evidence: { schemaVersion: 1, head: git("rev-parse", "HEAD"), version: "1.2.3", fresh: true, errors: 0 } });
});

test("#667 a source without the checker still captures, and the capture then reports the checker as unavailable, never as stale", async () => {
  const { value } = capture(tinySource(false));
  expect(existsSync(join(value.root, RELEASE_CHECKER))).toBe(false);
  expect(existsSync(join(value.root, "scripts"))).toBe(false);
  expect(await readDocEvidenceDetailed(temp("ahub-checker-empty-"), 10_000, join(value.root, RELEASE_CHECKER))).toEqual({ unavailable: expect.stringContaining("is missing from the running hub") });
});

test("#667 a source whose checker is a symlink is refused with the cause and next step, so it cannot produce a capture prune would never accept", () => {
  const source = tinySource(false), outside = join(temp("ahub-checker-out-"), "elsewhere.mjs");
  writeFileSync(outside, "// outside\n"); mkdirSync(join(source, "scripts")); symlinkSync(outside, join(source, RELEASE_CHECKER));
  expect(() => capture(source)).toThrow("must be a regular file to be preserved in a runtime capture; replace it with a regular file");
});

test("#667 the capture checker is the same program the hub reader spawns by default", () => {
  const reader = readFileSync(join(REPO, "src/hub/sdlc-release.ts"), "utf8");
  expect(reader).toContain(`new URL("../../${RELEASE_CHECKER}", import.meta.url)`);
});
