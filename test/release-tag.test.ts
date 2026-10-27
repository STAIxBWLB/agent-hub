import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AGENT_TODO, realRun, releaseTag, tagPreflight, tagPushArgv, type Cmd, type TagPorts } from "../scripts/lib/release-plan.ts";

// #787 P3b: the guarded tag. Every git operation runs in a scratch repository whose only remote is a bare directory on this disk, so a push
// can only ever reach that directory. The person's consent is a port the test controls: nothing here calls `ahub sdlc authorize-release`.
const ROOT = resolve(import.meta.dir, "..");
const VERSION = "0.2.0";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const gitIn = (cwd: string) => (...args: string[]) => {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const DOCS = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"];

/** main at a merged release: v0.1.0, work, then release/0.2.0 merged with a merge commit, pushed to the bare remote. */
function released(options: { squash?: boolean; todo?: boolean; staleStamp?: boolean; changelog?: boolean; skipReport?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-tag-")), work = join(dir, "work"), remote = join(dir, "remote.git");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(work); mkdirSync(remote);
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const git = gitIn(work), write = (path: string, data: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), data); };
  git("init", "-q", "-b", "main"); git("remote", "add", "origin", remote);
  write("package.json", `{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n`);
  write("README.md", "Status: 0.1.0, control protocol 13.\n");
  for (const doc of DOCS.slice(1)) write(doc, "Fixture\n");
  write("src/covered.ts", "initial\n"); write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- first\n");
  mkdirSync(join(work, "scripts"), { recursive: true }); copyFileSync(join(ROOT, "scripts/check-docs.mjs"), join(work, "scripts/check-docs.mjs"));
  git("add", "."); git("commit", "-qm", "chore: initial"); git("tag", "v0.1.0"); git("push", "-q", "origin", "main", "v0.1.0");
  git("checkout", "-qb", `release/${VERSION}`);
  write("src/covered.ts", "release source\n");
  write("package.json", `{\n  "name": "fixture",\n  "version": "${VERSION}"\n}\n`);
  write("README.md", `Status: ${VERSION}, control protocol 13.\n`);
  write("CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n${options.changelog === false ? "" : `## ${VERSION}\n\n- a change\n\n`}## 0.1.0\n\n- first\n`);
  if (!options.skipReport) write(`docs/verification/2026-10-27-${VERSION}.md`, options.todo ? `# ${VERSION}\n\n${AGENT_TODO}: fill\n` : `# ${VERSION}\n\nDone.\n`);
  git("add", "."); git("commit", "-qm", "release: prepare");
  const reviewed = git("rev-parse", "HEAD");
  write("docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: Object.fromEntries(DOCS.map(doc => [doc, { verifiedAgainst: options.staleStamp ? git("rev-parse", "v0.1.0") : reviewed, paths: ["src/covered.ts"] }])) }, null, 2) + "\n");
  git("add", "."); git("commit", "-qm", "docs: stamp");
  const release = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  if (options.squash) { git("merge", "--squash", release); git("commit", "-qm", `release: ${VERSION} (squashed)`); }
  else git("merge", "--no-ff", "-m", `Merge pull request #900 from owner/release/${VERSION}`, release);
  git("push", "-q", "origin", "main");
  return { dir, work, remote, git, write, head: () => git("rev-parse", "HEAD") };
}

type Consent = { grant: boolean; calls: string[][] };
function ports(consent: Consent, over: Partial<TagPorts> = {}): TagPorts {
  return { run: realRun, guard: (argv): Cmd => { consent.calls.push(argv); return consent.grant ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "no matching person release authorization; ask the person to authorize this commit and version" }; }, ...over };
}
const remoteTags = (r: { remote: string }) => spawnSync("git", ["--git-dir", r.remote, "tag", "--list"], { encoding: "utf8" }).stdout.trim();
const refusalText = (result: { status: string; refusals?: string[] }) => (result.refusals ?? []).join(" | ");

test("a prepared and merged release passes the preflight; the dry run pushes nothing and reports whether consent is there", () => {
  const r = released(), none: Consent = { grant: false, calls: [] };
  const first = releaseTag(r.work, VERSION, { execute: false }, ports(none));
  expect(first).toMatchObject({ status: "dry-run", commit: r.head(), consent: false });
  expect(none.calls).toEqual([tagPushArgv("origin", r.head(), VERSION)]); // consent was asked for this exact commit and version
  const some: Consent = { grant: true, calls: [] };
  expect(releaseTag(r.work, VERSION, { execute: false }, ports(some))).toMatchObject({ status: "dry-run", consent: true });
  expect(remoteTags(r)).toBe("v0.1.0"); expect(r.git("tag", "--list")).toBe("v0.1.0"); // a dry run changes nothing, even with consent
});

test("execute refuses without the person's consent and pushes nothing", () => {
  const r = released(), consent: Consent = { grant: false, calls: [] };
  const result = releaseTag(r.work, VERSION, { execute: true }, ports(consent));
  expect(result.status).toBe("refused");
  expect(refusalText(result as never)).toContain(`no person release consent for v${VERSION}`);
  expect(refusalText(result as never)).toContain(`ahub sdlc authorize-release ${VERSION}`);
  expect(remoteTags(r)).toBe("v0.1.0");
});

test("execute with consent pushes exactly the one preflighted commit as the one tag, to the local bare remote", () => {
  const r = released(), consent: Consent = { grant: true, calls: [] }, commit = r.head();
  const result = releaseTag(r.work, VERSION, { execute: true }, ports(consent));
  expect(result).toEqual({ status: "tagged", commit, tag: `v${VERSION}` });
  expect(remoteTags(r)).toBe(`v0.1.0\nv${VERSION}`);
  expect(spawnSync("git", ["--git-dir", r.remote, "rev-parse", `v${VERSION}^{commit}`], { encoding: "utf8" }).stdout.trim()).toBe(commit);
  // The preflight is repeated: consent was read before the first check and again right before the push.
  expect(consent.calls.length).toBe(2);
  expect(consent.calls.every(argv => argv.join(" ") === tagPushArgv("origin", commit, VERSION).join(" "))).toBe(true);
});

test("a second run after the tag exists refuses (one shot), locally and on the remote", () => {
  const r = released(), consent: Consent = { grant: true, calls: [] };
  expect(releaseTag(r.work, VERSION, { execute: true }, ports(consent)).status).toBe("tagged");
  // The push created the tag on the remote only (it pushes a commit to refs/tags, so no local tag exists): that alone refuses a second run.
  expect(r.git("tag", "--list", `v${VERSION}`)).toBe("");
  const again = releaseTag(r.work, VERSION, { execute: true }, ports(consent));
  expect(again.status).toBe("refused");
  expect(refusalText(again as never)).toContain(`tag v${VERSION} already exists on origin`);
  // And a tag that exists only locally refuses too.
  const local = released(); local.git("tag", `v${VERSION}`);
  expect(refusalText(releaseTag(local.work, VERSION, { execute: true }, ports(consent)) as never)).toContain(`tag v${VERSION} already exists locally`);
});

test("every preflight refusal, each on its own: not main, dirty tree, squash merge, unmerged HEAD, version mismatches, stale stamps, missing report, TODO markers", () => {
  const consent: Consent = { grant: true, calls: [] };
  const preflight = (r: ReturnType<typeof released>, version = VERSION) => { const result = tagPreflight(r.work, version, ports(consent)); return result.ok ? "ok" : result.refusals.join(" | "); };

  expect(preflight(released())).toBe("ok");

  const branch = released(); branch.git("checkout", "-qb", "elsewhere");
  expect(preflight(branch)).toContain("not main");

  const dirty = released(); writeFileSync(join(dirty.work, "stray.txt"), "x");
  expect(preflight(dirty)).toContain("working tree is not clean");
  const staged = released(); writeFileSync(join(staged.work, "src/covered.ts"), "edited\n"); staged.git("add", ".");
  expect(preflight(staged)).toContain("working tree is not clean");

  const squash = released({ squash: true });
  expect(preflight(squash)).toContain("not the merge commit of the release/0.2.0 PR");

  const unpushed = released(); unpushed.write("src/covered.ts", "later\n"); unpushed.git("add", "."); unpushed.git("commit", "-qm", "later");
  expect(preflight(unpushed)).toContain("not the merge commit");
  expect(preflight(unpushed)).toContain("not on origin/main");

  expect(preflight(released(), "0.3.0")).toContain("package.json at HEAD is 0.2.0, not 0.3.0");
  expect(preflight(released(), "0.3.0")).toContain("README.md Status line at HEAD is 0.2.0, not 0.3.0");
  expect(preflight(released(), "0.3.0")).toContain("CHANGELOG.md at HEAD has no 0.3.0 section");
  expect(preflight(released(), "v0.2.0")).toContain("not a release version");
  expect(preflight(released(), "0.2.0+build")).toContain("not a release version");

  expect(preflight(released({ changelog: false }))).toContain("CHANGELOG.md at HEAD has no 0.2.0 section");
  expect(preflight(released({ staleStamp: true }))).toContain("documentation stamps are not fresh at HEAD");
  expect(preflight(released({ skipReport: true }))).toContain("expected one docs/verification/<date>-0.2.0.md at HEAD, found 0");
  expect(preflight(released({ todo: true }))).toContain(`still has ${AGENT_TODO} markers`);

  const unreachable = released(); unreachable.git("remote", "set-url", "origin", join(unreachable.dir, "does-not-exist.git"));
  expect(preflight(unreachable)).toContain("could not read origin/main");
}, 20_000);

test("the preflight reports every problem at once, so one run says all there is to fix", () => {
  const r = released({ squash: true, todo: true, staleStamp: true }); writeFileSync(join(r.work, "stray.txt"), "x");
  const result = tagPreflight(r.work, VERSION, ports({ grant: true, calls: [] }));
  expect(result.ok).toBe(false);
  const text = result.ok ? "" : result.refusals.join(" | ");
  for (const part of ["working tree is not clean", "not the merge commit", "stamps are not fresh", "TODO(agent)"]) expect(text).toContain(part);
});

test("consent that goes away or HEAD that moves between the preflight and the push refuses and pushes nothing", () => {
  const r = released();
  // Consent that disappears on the second read (the hub restarted): the first read grants, the re-read after the repeated preflight refuses.
  let reads = 0;
  const flaky = ports({ grant: true, calls: [] }, { guard: () => (++reads === 1 ? { code: 0, stdout: "ok", stderr: "" } : { code: 1, stdout: "", stderr: "restart revoked it" }) });
  const lost = releaseTag(r.work, VERSION, { execute: true }, flaky);
  expect(lost.status).toBe("refused");
  expect(refusalText(lost as never)).toContain("consent no longer matches");
  expect(remoteTags(r)).toBe("v0.1.0");

  // HEAD moves right after the first preflight: the second preflight sees a different commit (and a dirty/unmerged tree).
  let moved = false;
  const racing = ports({ grant: true, calls: [] }, { guard: argv => { if (!moved) { moved = true; r.write("src/covered.ts", "moved\n"); r.git("add", "."); r.git("commit", "-qm", "moved"); } return { code: 0, stdout: argv.join(" "), stderr: "" }; } });
  const result = releaseTag(r.work, VERSION, { execute: true }, racing);
  expect(result.status).toBe("refused");
  expect(remoteTags(r)).toBe("v0.1.0");
});

test("a rejected push is reported and leaves no tag; the script never passes --no-verify or --force", () => {
  const r = released();
  // A remote that refuses the push: a hook on the bare repository.
  writeFileSync(join(r.remote, "hooks/pre-receive"), "#!/bin/sh\necho 'rejected by the remote' >&2\nexit 1\n", { mode: 0o755 });
  const consent: Consent = { grant: true, calls: [] };
  const pushes: string[][] = [];
  const spy = ports(consent, { run: (argv, opts) => { if (argv[1] === "push") pushes.push(argv); return realRun(argv, opts); } });
  const result = releaseTag(r.work, VERSION, { execute: true }, spy);
  expect(result.status).toBe("refused");
  expect(refusalText(result as never)).toContain(`git push of v${VERSION} failed`);
  expect(remoteTags(r)).toBe("v0.1.0");
  expect(pushes).toHaveLength(1); // one push attempt, never a retry
  const text = pushes.flat().join(" ");
  expect(text).not.toContain("--no-verify"); expect(text).not.toContain("--force"); expect(text).not.toContain("+refs");
  expect(pushes[0]).toEqual(tagPushArgv("origin", r.head(), VERSION));
});

test("the CLI: usage errors exit 1 and a repository that is not a prepared release is refused without pushing", () => {
  const r = released();
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "scripts/release-tag.ts"), ...args], { cwd: r.work, encoding: "utf8", env: { ...process.env, AHUB_CLI: "/nonexistent/ahub" } });
  expect(cli().status).toBe(1);
  expect(cli("0.2.0", "--force").status).toBe(1);
  expect(cli("0.2.0", "0.3.0").status).toBe(1);
  // The script under test is this repository's, which is not a prepared release: the preflight refuses (main is not a release merge here).
  const refused = cli("9.9.9");
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("release-tag: refused:");
  expect(refused.stdout).not.toContain("pushed");
}, 20_000);
