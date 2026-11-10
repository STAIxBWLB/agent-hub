import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { ReleaseAuthorizations } from "../src/hub/sdlc-release-authorization.ts";
import { readCommittedReleasePolicy } from "../src/hub/sdlc-release-policy.ts";
import { readReleaseReadiness, type ReleaseGit } from "../src/hub/sdlc-release.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";
import { renderSdlcRelease } from "../src/cli/sdlc-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REPO = "example/repo";

function releaseProject(source: "release-notes" | "none", packageVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-report-")); roots.push(root);
  const home = join(root, "home"), tmp = join(root, "tmp"); mkdirSync(home); mkdirSync(tmp);
  const gitEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", timeout: 5000 }).trim();
  run(["init", "-q"]);
  run(["remote", "add", "origin", "https://github.com/example/repo.git"]);
  run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "published predecessor"]);
  const predecessor = run(["rev-parse", "HEAD"]); run(["tag", "v1.2.2"]);
  mkdirSync(join(root, ".agenthub"), { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ release: { version: source, docs: "none" } }) + "\n");
  if (packageVersion) writeFileSync(join(root, "package.json"), JSON.stringify({ version: packageVersion }) + "\n");
  if (source === "release-notes") {
    const notes = join(root, "docs/releases/v1.2.3.md"); mkdirSync(dirname(notes), { recursive: true }); writeFileSync(notes, "candidate notes\n");
  }
  run(["add", "--all"]);
  run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "release candidate"]);
  const head = run(["rev-parse", "HEAD"]);
  let hideNotes = false, docsCalls = 0, now = 100;
  const gitCalls: string[][] = [];
  const git: ReleaseGit = args => {
    gitCalls.push([...args]);
    if (hideNotes && args[0] === "--literal-pathspecs" && args.at(-1) === "docs/releases/v1.2.3.md") return { code: 0, stdout: "" };
    try { return { code: 0, stdout: execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8", timeout: 5000 }) }; }
    catch (error) { return { code: Number((error as { status?: number }).status ?? 1), stdout: (error as { stdout?: string }).stdout?.toString() ?? "" }; }
  };
  const host = new ReleaseAuthorizations(root, {
    git,
    policy: (commit, reader) => readCommittedReleasePolicy(reader, commit),
    docs: async () => { docsCalls++; return undefined; },
    now: () => now,
    record: () => true,
  });
  const fakeGh: SdlcGh = async args => {
    if (args[0] === "release") return { code: 0, stdout: JSON.stringify([{ tagName: "v1.2.2", isDraft: false, isPrerelease: false }]) };
    if (args[0] === "issue") return { code: 0, stdout: JSON.stringify({ number: 273, state: "CLOSED" }) };
    const query = args.find(arg => arg.startsWith("query=")) ?? "";
    if (query.includes("associatedPullRequests")) {
      const pairs = [...query.matchAll(/(c\d+):object\(oid:"([0-9a-f]{40})"\)/g)];
      return { code: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries(pairs.map(([, key, oid]) => [key, { oid, associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false } } }])) } }) };
    }
    if (query.includes("releases(first:100")) {
      const ledgers = Object.fromEntries([...query.matchAll(/(ledger_\d+):issue\(number:(\d+)\)/g)].map(([, key, id]) => [key, { number: Number(id), state: "CLOSED" }]));
      return { code: 0, stdout: JSON.stringify({ data: { repository: { ...ledgers, releases: { nodes: [{ tagName: "v1.2.2", isDraft: false }], pageInfo: { hasNextPage: false } }, ref: { target: { oid: predecessor } } } } }) };
    }
    return { code: 0, stdout: JSON.stringify({ data: { repository: { ref: { target: { oid: predecessor } } } } }) };
  };
  const readers = () => ({ git, gh: fakeGh, reportPolicy: (candidate: string, repo: string) => host.reportPolicy(candidate, repo),
    docs: async () => { docsCalls++; return undefined; } });
  return { root, run, host, head, predecessor, readers, gitCalls, docsCalls: () => docsCalls, hideNotes: (value: boolean) => { hideNotes = value; }, setNow: (value: number) => { now = value; } };
}

test("#1381 release-notes report uses the exact authorized version without package.json and skips docs:none evidence", async () => {
  const f = releaseProject("release-notes");
  const receipt = await f.host.authorize("user", "1.2.3", f.head);
  const raw = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(raw).toMatchObject({ head: f.head, version: receipt.version, sourceReady: true, ready: false,
    releasePolicy: { versionSource: "release-notes", docsSource: "none", authorization: "matched" } });
  expect(f.gitCalls.some(args => args[0] === "show" && args[1]?.endsWith(":package.json"))).toBe(false);
  expect(raw.documents).toBeUndefined(); expect(f.docsCalls()).toBe(0);
  expect(renderSdlcRelease({ report: raw }).flat().map(span => span.text).join(" ")).toContain("none (explicit exemption recorded)");
  const report = f.host.report(raw);
  expect(report.authorization).toMatchObject({ state: "matched", receipt: { id: receipt.id, version: "1.2.3" } });
  expect(report.blockers).toContain("native acceptance unverified"); expect(report.ready).toBe(false);
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false, error: expect.stringContaining("committed package.json version") }); // report version never supplies npm's package target
});

test("#1381 no alternate-source receipt leaves version undetermined and never guesses from notes or tag", async () => {
  const f = releaseProject("release-notes");
  const report = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(report.version).toBeUndefined();
  expect(report.tag).toBe("v1.2.2");
  expect(report.releasePolicy).toMatchObject({ versionSource: "release-notes", docsSource: "none", authorization: "missing" });
  expect(report.blockers).toContain("release version undetermined from configured release-notes source; run ahub sdlc authorize-release <version>");
  expect(report.documents).toBeUndefined(); expect(f.docsCalls()).toBe(0); expect(report.ready).toBe(false);
  expect(renderSdlcRelease({ report }).flat().map(span => span.text).join(" ")).toContain("undetermined");
  expect(f.host.report(report).authorization).toBeUndefined();
});

test("#1381 release-notes report uses the authorized notes version when package.json has a different version", async () => {
  const f = releaseProject("release-notes", "9.9.9");
  await f.host.authorize("user", "1.2.3", f.head);
  const report = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(report.version).toBe("1.2.3");
  expect(report.releasePolicy).toMatchObject({ versionSource: "release-notes", authorization: "matched" });
  expect(f.gitCalls.some(args => args[0] === "show" && args[1]?.endsWith(":package.json"))).toBe(false);
});

test("#1381 tag-only reports use a successful requested-version receipt, never the latest receipt from another candidate", async () => {
  const f = releaseProject("none");
  const receipt = await f.host.authorize("user", "1.2.3", f.head);
  const report = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(report).toMatchObject({ version: "1.2.3", releasePolicy: { versionSource: "none", docsSource: "none", authorization: "matched" } });
  expect(f.gitCalls.some(args => args[0] === "show" && args[1]?.endsWith(":package.json"))).toBe(false);
  expect(f.docsCalls()).toBe(0);
  const matched = f.host.report(report); expect(matched.authorization).toMatchObject({ state: "matched", receipt: { id: receipt.id } });

  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "new candidate"]);
  const next = f.run(["rev-parse", "HEAD"]);
  const noCurrentReceipt = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(next).not.toBe(receipt.commit); expect(noCurrentReceipt.version).toBeUndefined();
  expect(noCurrentReceipt.releasePolicy?.authorization).toBe("missing");
  expect(f.host.report(noCurrentReceipt).authorization).toBeUndefined();
});

test("#1381 report order follows successful authorization order rather than receipt timestamps", async () => {
  const f = releaseProject("none");
  const first = await f.host.authorize("user", "1.2.3", f.head); f.setNow(1);
  const second = await f.host.authorize("user", "1.2.4", f.head);
  expect(second.at).toBeLessThan(first.at);
  expect(f.host.reportPolicy(f.head, REPO)).toMatchObject({ authorization: "matched", version: "1.2.4" });
  const report = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(report.version).toBe("1.2.4");
});

test("#1381 report policy refuses wrong head, repository, origin, changed policy and unavailable notes", async () => {
  const f = releaseProject("release-notes"); await f.host.authorize("user", "1.2.3", f.head);
  expect(f.host.reportPolicy(f.head, "other/repo")?.authorization).toBe("missing");
  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "different report head"]);
  const otherHead = f.run(["rev-parse", "HEAD"]);
  expect(f.host.reportPolicy(otherHead, REPO)?.authorization).toBe("missing");
  f.run(["reset", "--hard", f.head]);
  f.run(["remote", "set-url", "--push", "origin", "ssh://git@github.com/example/repo.git"]);
  expect(f.host.reportPolicy(f.head, REPO)?.authorization).toBe("missing");
  f.run(["remote", "set-url", "--push", "origin", "https://github.com/example/repo.git"]);
  f.hideNotes(true); expect(f.host.reportPolicy(f.head, REPO)?.authorization).toBe("stale");

  f.hideNotes(false);
  writeFileSync(join(f.root, ".agenthub/config.json"), JSON.stringify({ release: { version: "none", docs: "none" } }) + "\n");
  f.run(["add", ".agenthub/config.json"]);
  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "policy changed"]);
  const changedHead = f.run(["rev-parse", "HEAD"]);
  expect(f.host.reportPolicy(changedHead, REPO)?.authorization).toBe("missing");
});

test("#1381 notes removed from a new committed HEAD cannot reuse a prior receipt", async () => {
  const f = releaseProject("release-notes"); await f.host.authorize("user", "1.2.3", f.head);
  rmSync(join(f.root, "docs/releases/v1.2.3.md"));
  f.run(["add", "--all"]);
  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "notes removed"]);
  const report = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(report.version).toBeUndefined(); expect(report.sourceReady).toBe(false); expect(report.ready).toBe(false);
  expect(report.releasePolicy?.authorization).toBe("missing");
  expect(report.blockers).toContain("release version undetermined from configured release-notes source; run ahub sdlc authorize-release <version>");
  expect(f.docsCalls()).toBe(0);
});

test("#1381 a notes source becoming unavailable after report collection leaves stale consent and sourceReady false", async () => {
  const f = releaseProject("release-notes"); await f.host.authorize("user", "1.2.3", f.head);
  const raw = await readReleaseReadiness(f.root, REPO, [273], f.readers());
  expect(raw.releasePolicy?.authorization).toBe("matched");
  f.hideNotes(true);
  const report = f.host.report(raw);
  expect(report.sourceReady).toBe(false); expect(report.ready).toBe(false);
  expect(report.releasePolicy?.authorization).toBe("stale");
  expect(report.blockers).toContain("release authorization source is stale; authorize the exact candidate version again");
});
