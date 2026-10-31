import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_TODO, bumpFor, fileReader, moveUnreleased, nextVersion, prepareRelease, realRun, reportSkeleton, restampDocuments, setPackageVersion, setReadmeStatus, type Run } from "../scripts/lib/release-plan.ts";

// #787 P3b: release preparation, with every git operation in a scratch repository whose only remote is a bare directory on this disk.
// Nothing here can reach GitHub, push a tag anywhere real, publish, or grant the person's consent: the consent port is a fake the test sets.
const ROOT = resolve(import.meta.dir, "..");
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const gitIn = (cwd: string) => (...args: string[]) => {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const DOCS = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"];

/** A repository that looks like the project at a release: main with v0.1.0 tagged, then work, then a release/0.2.0 branch. */
function repo(options: { version?: string; subjects?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-prep-")), work = join(dir, "work"), remote = join(dir, "remote.git");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(work); mkdirSync(remote);
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const git = gitIn(work), write = (path: string, data: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), data); };
  git("init", "-q", "-b", "main"); git("remote", "add", "origin", remote);
  write("package.json", `{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n`);
  write("README.md", "Status: 0.1.0, control protocol 13.\n");
  for (const doc of DOCS.slice(1)) write(doc, "Fixture\n");
  write("src/covered.ts", "initial\n");
  write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- first\n");
  mkdirSync(join(work, "scripts"), { recursive: true });
  copyFileSync(join(ROOT, "scripts/check-docs.mjs"), join(work, "scripts/check-docs.mjs"));
  git("add", "."); git("commit", "-qm", "chore: initial"); git("tag", "v0.1.0");
  for (const subject of options.subjects ?? ["fix: a fix (#11)", "feat: a feature (#12)"]) { write("src/covered.ts", `${subject}\n`); git("add", "."); git("commit", "-qm", subject); }
  write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- a feature (#12)\n- a fix (#11)\n\n## 0.1.0\n\n- first\n");
  git("add", "."); git("commit", "-qm", "docs: changelog"); git("push", "-q", "origin", "main");
  const stamp = (revision: string) => write("docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: Object.fromEntries(DOCS.map(doc => [doc, { verifiedAgainst: revision, paths: ["src/covered.ts"] }])) }, null, 2) + "\n");
  return { dir, work, remote, git, write, stamp, read: fileReader(work) };
}

test("the bump rule: any feat bumps the minor, a fix-only release the patch; versions and prereleases are refused when malformed", () => {
  expect(bumpFor(["fix: a", "feat: b", "chore: c"])).toBe("minor");
  expect(bumpFor(["feat(hub): scoped", "fix: x"])).toBe("minor");
  expect(bumpFor(["feat!: breaking"])).toBe("minor");
  expect(bumpFor(["fix: a", "docs: b", "refactor: c", "test: d"])).toBe("patch");
  expect(bumpFor(["feature: not a conventional feat", "fix: x"])).toBe("patch");
  expect(nextVersion("0.19.0", "minor")).toBe("0.20.0");
  expect(nextVersion("0.19.3", "patch")).toBe("0.19.4");
  expect(() => nextVersion("not-a-version", "minor")).toThrow("not a version");
});

test("CHANGELOG, README and package.json edits are exact, and refuse a missing or empty section", () => {
  const changelog = "# Changelog\n\nintro\n\n## Unreleased\n\n- one\n- two\n\n## 0.1.0\n\n- first\n";
  expect(moveUnreleased(changelog, "0.2.0")).toBe("# Changelog\n\nintro\n\n## Unreleased\n\n## 0.2.0\n\n- one\n- two\n\n## 0.1.0\n\n- first\n");
  expect(() => moveUnreleased("# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- x\n", "0.2.0")).toThrow("`## Unreleased` is empty");
  expect(() => moveUnreleased("# Changelog\n\n## 0.1.0\n\n- x\n", "0.2.0")).toThrow("no `## Unreleased` section");
  expect(() => moveUnreleased("## Unreleased\n\n- x\n\n## 0.2.0\n\n- y\n", "0.2.0")).toThrow("already has a 0.2.0 section");
  expect(setReadmeStatus("Status: 0.1.0, control protocol 16.\nmore\n", "0.2.0")).toBe("Status: 0.2.0, control protocol 16.\nmore\n");
  expect(() => setReadmeStatus("no status here\n", "0.2.0")).toThrow("no `Status:");
  expect(setPackageVersion('{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "1.0.0" }\n}\n', "0.2.0")).toContain('"version": "0.2.0"');
  expect(setPackageVersion('{\n  "name": "x",\n  "version": "0.1.0",\n  "dependencies": { "a": "1.0.0" }\n}\n', "0.2.0")).toContain('"a": "1.0.0"');
});

test("preparation on a release branch writes version, README, CHANGELOG and a report with the receipts listed from the repository, and runs the build", () => {
  const r = repo(); r.git("checkout", "-qb", "release/0.2.0");
  r.write("docs/verification/2026-10-20-some-receipt.md", "# a native receipt\n"); r.git("add", "."); r.git("commit", "-qm", "docs: a receipt");
  const calls: string[][] = [];
  const run: Run = (argv, opts) => { if (argv[0] === "bun") { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; } return realRun(argv, opts); };
  const result = prepareRelease(r.work, { dryRun: false, today: "2026-10-27", write: (path, data) => writeFileSync(join(r.work, path), data), read: r.read, run });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan).toMatchObject({ current: "0.1.0", version: "0.2.0", bump: "minor", lastTag: "v0.1.0", branch: "release/0.2.0" });
  expect(result.plan.prs).toEqual([12, 11]);
  expect(result.plan.receipts).toEqual(["docs/verification/2026-10-20-some-receipt.md"]);
  expect(calls).toEqual([["bun", "run", "build"]]);
  expect(JSON.parse(r.read("package.json")).version).toBe("0.2.0");
  expect(r.read("README.md")).toContain("Status: 0.2.0,");
  expect(r.read("CHANGELOG.md")).toContain("## Unreleased\n\n## 0.2.0\n\n- a feature (#12)");
  const report = r.read("docs/verification/2026-10-27-0.2.0.md");
  expect(report).toContain("# 0.2.0 release verification");
  expect(report).toContain("`docs/verification/2026-10-20-some-receipt.md`");
  expect(report).toContain("#12, #11");
  expect(report).toContain(AGENT_TODO);
  expect(report).toContain("ahub sdlc authorize-release 0.2.0");
  expect(report).not.toMatch(/consent (granted|given|recorded as)/);
  // Preparation never restamps and never tags.
  expect(existsSync(join(r.work, "docs/verified.json"))).toBe(false);
  expect(r.git("tag", "--list")).toBe("v0.1.0");
});

test("a dry run reports the plan and writes nothing", () => {
  const r = repo(); r.git("checkout", "-qb", "release/0.2.0");
  const before = r.git("status", "--porcelain");
  const result = prepareRelease(r.work, { dryRun: true, today: "2026-10-27", write: () => { throw new Error("dry run wrote"); }, read: r.read, run: realRun });
  expect(result.ok && !result.wrote && result.plan.version).toBe("0.2.0");
  expect(r.git("status", "--porcelain")).toBe(before);
});

test("preparation refuses: main, a wrong branch, a dirty tree, a version below the rule, a version not newer, an empty Unreleased, a failed build", () => {
  const r = repo();
  const attempt = (opts: Partial<Parameters<typeof prepareRelease>[1]> = {}) => prepareRelease(r.work, { dryRun: true, today: "2026-10-27", write: () => {}, read: r.read, run: realRun, ...opts });
  const refusals = (result: ReturnType<typeof prepareRelease>) => result.ok ? [] : result.refusals.join(" | ");
  expect(refusals(attempt())).toContain("this is main");
  r.git("checkout", "-qb", "feature/x");
  expect(refusals(attempt())).toContain("expected release/0.2.0");
  r.git("checkout", "-q", "-B", "release/0.2.0");
  expect(attempt().ok).toBe(true);
  expect(refusals(attempt({ version: "0.1.5" }))).toContain("below the version the rule gives (0.2.0");
  expect(refusals(attempt({ version: "0.1.0" }))).toContain("not newer than v0.1.0");
  expect(refusals(attempt({ version: "v0.2.0" }))).toContain("not a release version");
  expect(refusals(attempt({ version: "0.2.0+build" }))).toContain("not a release version");
  expect(attempt({ version: "0.3.0" }).ok).toBe(false); // the branch is release/0.2.0, not release/0.3.0
  writeFileSync(join(r.work, "stray.txt"), "x");
  expect(refusals(attempt())).toContain("working tree is not clean");
  rmSync(join(r.work, "stray.txt"));
  r.write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- first\n"); r.git("add", "."); r.git("commit", "-qm", "docs: empty");
  expect(refusals(attempt())).toContain("`## Unreleased` is empty");
  const failing: Run = (argv, opts) => argv[0] === "bun" ? { code: 1, stdout: "", stderr: "build exploded" } : realRun(argv, opts);
  r.write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n- x\n\n## 0.1.0\n\n- first\n"); r.git("add", "."); r.git("commit", "-qm", "docs: x");
  const built = prepareRelease(r.work, { dryRun: false, today: "2026-10-27", write: (p, d) => writeFileSync(join(r.work, p), d), read: r.read, run: failing });
  expect(built.ok ? "" : built.refusals.join(" ")).toContain("bun run build failed");
});

test("a fix-only history gives a patch bump and a version below that is refused", () => {
  const r = repo({ subjects: ["fix: one (#1)", "docs: two"] }); r.git("checkout", "-qb", "release/0.1.1");
  const result = prepareRelease(r.work, { dryRun: true, today: "2026-10-27", write: () => {}, read: r.read, run: realRun });
  expect(result.ok && result.plan.version).toBe("0.1.1");
  expect(result.ok && result.plan.bump).toBe("patch");
});

test("restamp sets only the named documents to HEAD, only with --reviewed, and refuses unknown names and staged changes", () => {
  const r = repo(); r.stamp(r.git("rev-parse", "HEAD")); r.git("add", "."); r.git("commit", "-qm", "docs: stamps");
  const head = r.git("rev-parse", "HEAD"), old = JSON.parse(r.read("docs/verified.json")).documents["docs/security.md"].verifiedAgainst;
  const write = (path: string, data: string) => writeFileSync(join(r.work, path), data);
  expect(restampDocuments(r.work, ["README.md"], { reviewed: false, run: realRun, read: r.read, write })).toMatchObject({ ok: false });
  expect(restampDocuments(r.work, [], { reviewed: true, run: realRun, read: r.read, write })).toMatchObject({ ok: false });
  expect(restampDocuments(r.work, ["docs/ghost.md"], { reviewed: true, run: realRun, read: r.read, write })).toMatchObject({ ok: false });
  expect(JSON.parse(r.read("docs/verified.json")).documents["README.md"].verifiedAgainst).not.toBe(head);
  const done = restampDocuments(r.work, ["README.md"], { reviewed: true, run: realRun, read: r.read, write });
  expect(done).toMatchObject({ ok: true, stamped: ["README.md"], head });
  const after = JSON.parse(r.read("docs/verified.json")).documents;
  expect(after["README.md"].verifiedAgainst).toBe(head);
  expect(after["docs/security.md"].verifiedAgainst).toBe(old);
  r.git("add", "docs/verified.json");
  expect(restampDocuments(r.work, ["docs/security.md"], { reviewed: true, run: realRun, read: r.read, write })).toMatchObject({ ok: false });
});

test("the report skeleton claims no consent and names the person's command", () => {
  const text = reportSkeleton({ current: "0.1.0", version: "0.2.0", bump: "minor", lastTag: "v0.1.0", subjects: ["feat: a (#1)"], prs: [1], receipts: [], branch: "release/0.2.0" }, "abcd1234");
  expect(text).toContain("none");
  expect(text).toContain("person only");
  expect(text).toContain(AGENT_TODO);
});


test("#1004 release preparation retains native version receipts and excludes only whole dated release-report basenames", () => {
  const r = repo();
  const receipt = "docs/verification/2026-10-31-claude-implementer-2.1.314.md";
  const report = "docs/verification/2026-10-31-0.1.0.md";
  r.write(receipt, "Native implementer receipt\n");
  r.write(report, "Earlier release report\n");
  r.git("add", "."); r.git("commit", "-qm", "docs: native receipt and release report");
  r.git("checkout", "-qb", "release/0.2.0");
  const result = prepareRelease(r.work, { dryRun: true, today: "2026-11-01", write: () => { throw new Error("dry run wrote"); }, read: r.read, run: realRun });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.plan.receipts).toEqual([receipt]);
  expect(reportSkeleton(result.plan, r.git("rev-parse", "HEAD"))).toContain(receipt);
  expect(result.plan.receipts).not.toContain(report);
});
