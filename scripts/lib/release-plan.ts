import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #787 P3b: the pure and port-driven parts of release preparation and the guarded tag. `scripts/release-prepare.ts` and
 * `scripts/release-tag.ts` are thin shells over this module, so the tests run the code the scripts run.
 *
 * Nothing here grants consent. The person's `ahub sdlc authorize-release` is read back through `ahub sdlc release-guard`
 * (read only); a missing receipt refuses the tag. Nothing here pushes except `releaseTag` with `execute: true`.
 */
export interface Cmd { code: number; stdout: string; stderr: string }
export type Run = (argv: string[], opts?: { cwd?: string; allowHooks?: boolean }) => Cmd;

/** A release tag is `v` plus a semantic version with an optional prerelease; build metadata is never part of a tag. */
export const RELEASE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
export const AGENT_TODO = "TODO(agent)";

// Read-only git must not run repository-configured helpers (the same list scripts/check-docs.mjs uses).
const SAFE = ["core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "core.pager=cat", "credential.helper=", "core.askpass="];
export const realRun: Run = (argv, opts = {}) => {
  const [program, ...rest] = argv;
  // Only the push itself may run the repository's hooks (the release pre-push guard); every read is hardened.
  const args = program === "git" ? ["--no-pager", ...(opts.allowHooks ? [] : SAFE.flatMap(value => ["-c", value])), ...rest] : rest;
  const result = spawnSync(program!, args, { cwd: opts.cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export function parseVersion(text: string): [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error(`not a version: ${!left ? a : b}`);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  return 0;
}

/** AGENTS.md: a release with any `feat` change bumps the minor, a fix-only release bumps the patch. */
export function bumpFor(subjects: readonly string[]): "minor" | "patch" {
  return subjects.some(subject => /^feat(?:\([^)]*\))?!?:/.test(subject.trim())) ? "minor" : "patch";
}
export function nextVersion(current: string, bump: "minor" | "patch"): string {
  const parts = parseVersion(current);
  if (!parts) throw new Error(`not a version: ${current}`);
  return bump === "minor" ? `${parts[0]}.${parts[1] + 1}.0` : `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

/** Subjects of the commits (first parent) merged since the last tag, newest first, and the PR numbers they name. */
export function prNumbers(subjects: readonly string[]): number[] {
  const seen = new Set<number>();
  for (const subject of subjects) for (const match of subject.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)/g)) seen.add(Number(match[1] ?? match[2]));
  return [...seen];
}

/** Moves the Unreleased entries under a new version heading and leaves an empty Unreleased section. Refuses an empty one. */
export function moveUnreleased(changelog: string, version: string): string {
  const heading = /^## Unreleased[ \t]*$/m.exec(changelog);
  if (!heading) throw new Error("CHANGELOG.md has no `## Unreleased` section");
  const start = heading.index + heading[0].length, rest = changelog.slice(start), next = /^## /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).trim();
  if (!body) throw new Error("CHANGELOG.md `## Unreleased` is empty: a release needs its entries");
  if (new RegExp(`^## ${version.replaceAll(".", "\\.")}[ \\t]*$`, "m").test(changelog)) throw new Error(`CHANGELOG.md already has a ${version} section`);
  return `${changelog.slice(0, heading.index)}## Unreleased\n\n## ${version}\n\n${body}\n${next ? `\n${rest.slice(next.index)}` : ""}`;
}
export function setReadmeStatus(readme: string, version: string): string {
  if (!/^Status: [^,\s]+,/m.test(readme)) throw new Error("README.md has no `Status: <version>,` line");
  return readme.replace(/^Status: [^,\s]+,/m, `Status: ${version},`);
}
export function setPackageVersion(packageJson: string, version: string): string {
  if (!/^(\s*"version":\s*")[^"]+(")/m.test(packageJson)) throw new Error("package.json has no version field");
  return packageJson.replace(/^(\s*"version":\s*")[^"]+(")/m, `$1${version}$2`);
}
export const readmeStatusVersion = (readme: string): string | undefined => /^Status: ([^,\s]+),/m.exec(readme)?.[1];

/** The argv the person's consent is read through; the tag push itself is the same argv with `git push`. Pushes the exact preflighted commit. */
export const tagPushArgv = (remote: string, commit: string, version: string): string[] => ["git", "push", remote, `${commit}:refs/tags/v${version}`];

export interface TagPorts {
  run: Run;
  /** `ahub sdlc release-guard -- <argv>`: exit 0 only when the person's authorization matches this commit and version. Read only. */
  guard: (argv: string[]) => Cmd;
  remote?: string;
}
export type Preflight = { ok: true; commit: string } | { ok: false; refusals: string[] };

const text = (result: Cmd) => result.stdout.trim();
/** Every refusal at once, so one run tells the agent all it has to fix. Read only except a fetch of the remote's main. */
export function tagPreflight(root: string, version: string, ports: TagPorts): Preflight {
  const remote = ports.remote ?? "origin", refusals: string[] = [];
  const git = (...args: string[]) => ports.run(["git", ...args], { cwd: root });
  if (!RELEASE_VERSION.test(version)) return { ok: false, refusals: [`not a release version: ${version}`] };
  const head = git("rev-parse", "--verify", "HEAD^{commit}"), commit = text(head);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return { ok: false, refusals: ["HEAD does not resolve to a commit"] };
  const show = (path: string) => { const result = git("show", `${commit}:${path}`); return result.code === 0 ? result.stdout : undefined; };

  let packaged: string | undefined;
  try { packaged = JSON.parse(show("package.json") ?? "").version; } catch { /* reported below */ }
  if (packaged !== version) refusals.push(`package.json at HEAD is ${packaged ?? "unreadable"}, not ${version}`);
  const readme = show("README.md");
  if (readme === undefined || readmeStatusVersion(readme) !== version) refusals.push(`README.md Status line at HEAD is ${readme === undefined ? "unreadable" : readmeStatusVersion(readme) ?? "missing"}, not ${version}`);
  const changelog = show("CHANGELOG.md");
  if (changelog === undefined || !new RegExp(`^## ${version.replaceAll(".", "\\.")}[ \\t]*$`, "m").test(changelog)) refusals.push(`CHANGELOG.md at HEAD has no ${version} section`);

  const branch = git("symbolic-ref", "--short", "-q", "HEAD");
  if (branch.code !== 0 || text(branch) !== "main") refusals.push(`HEAD is on ${branch.code === 0 ? text(branch) : "no branch"}, not main: tag the merged release on main`);
  const staged = git("diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--"), worktree = git("diff-index", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--");
  const untracked = git("ls-files", "--others", "--exclude-standard");
  if (staged.code !== 0 || worktree.code !== 0 || untracked.code !== 0 || untracked.stdout.trim()) refusals.push("the working tree is not clean (tracked changes, staged changes or untracked files)");

  // The tag must be a merge commit of the release PR: documentation stamps name a commit of the release branch.
  const parents = text(git("rev-list", "--parents", "-n", "1", commit)).split(" ").length - 1;
  const subject = text(git("log", "-1", "--format=%s", commit));
  if (parents !== 2 || !new RegExp(`^Merge pull request #\\d+ from \\S+/release/${version.replaceAll(".", "\\.")}$`).test(subject)) refusals.push(`HEAD is not the merge commit of the release/${version} PR (a release PR is merged with a merge commit, never squashed)`);

  const fetched = git("fetch", "--quiet", remote, "main");
  if (fetched.code !== 0) refusals.push(`could not read ${remote}/main: ${fetched.stderr.trim().split("\n")[0] ?? "fetch failed"}`);
  else if (git("merge-base", "--is-ancestor", commit, `${remote}/main`).code !== 0) refusals.push(`HEAD is not on ${remote}/main: push or merge it first`);
  if (git("tag", "--list", `v${version}`).stdout.trim()) refusals.push(`tag v${version} already exists locally`);
  const remoteTag = git("ls-remote", "--tags", remote, `refs/tags/v${version}`);
  if (remoteTag.code !== 0) refusals.push(`could not read tags on ${remote}`);
  else if (remoteTag.stdout.trim()) refusals.push(`tag v${version} already exists on ${remote}`);

  const docs = ports.run([process.execPath, join(root, "scripts/check-docs.mjs"), "--require-fresh", "--committed", root], { cwd: root });
  if (docs.code !== 0) refusals.push(`documentation stamps are not fresh at HEAD (${(docs.stderr || docs.stdout).trim().split("\n").filter(line => /ERROR|stale/.test(line)).slice(0, 3).join("; ") || "check-docs failed"})`);

  const report = git("ls-tree", "-r", "--name-only", commit, "docs/verification");
  const reports = report.stdout.split("\n").filter(path => new RegExp(`/\\d{4}-\\d{2}-\\d{2}-${version.replaceAll(".", "\\.")}\\.md$`).test(path));
  if (reports.length !== 1) refusals.push(`expected one docs/verification/<date>-${version}.md at HEAD, found ${reports.length}`);
  else { const body = show(reports[0]!) ?? ""; if (body.includes(AGENT_TODO)) refusals.push(`${reports[0]} still has ${AGENT_TODO} markers`); }

  return refusals.length ? { ok: false, refusals } : { ok: true, commit };
}

export type TagResult =
  | { status: "refused"; refusals: string[] }
  | { status: "dry-run"; commit: string; consent: boolean }
  | { status: "tagged"; commit: string; tag: string };

/**
 * One guarded run. It never trusts an earlier preflight: it repeats it, reads the person's consent, and with `execute` repeats the
 * preflight once more right before the single push, refusing if HEAD moved. Without `execute` it changes nothing.
 */
export function releaseTag(root: string, version: string, opts: { execute: boolean }, ports: TagPorts): TagResult {
  const remote = ports.remote ?? "origin";
  const first = tagPreflight(root, version, ports);
  if (!first.ok) return { status: "refused", refusals: first.refusals };
  const argv = tagPushArgv(remote, first.commit, version);
  const consent = ports.guard(argv);
  if (!opts.execute) return { status: "dry-run", commit: first.commit, consent: consent.code === 0 };
  if (consent.code !== 0) return { status: "refused", refusals: [`no person release consent for v${version} at ${first.commit.slice(0, 12)}: ${(consent.stderr || consent.stdout).trim().split("\n")[0] || "the guard refused"}. Ask the person to run \`ahub sdlc authorize-release ${version}\` from this checkout`] };
  const second = tagPreflight(root, version, ports);
  if (!second.ok) return { status: "refused", refusals: second.refusals };
  if (second.commit !== first.commit) return { status: "refused", refusals: ["HEAD moved between the preflight and the push"] };
  const again = ports.guard(argv);
  if (again.code !== 0) return { status: "refused", refusals: ["the person's consent no longer matches (the hub restarted or the candidate changed)"] };
  const pushed = ports.run(argv, { cwd: root, allowHooks: true });
  if (pushed.code !== 0) return { status: "refused", refusals: [`git push of v${version} failed: ${(pushed.stderr || pushed.stdout).trim().split("\n")[0] ?? ""}`] };
  return { status: "tagged", commit: first.commit, tag: `v${version}` };
}

export interface PreparationPlan { current: string; version: string; bump: "minor" | "patch"; lastTag: string; subjects: string[]; prs: number[]; receipts: string[]; branch: string }
export type Preparation = { ok: true; plan: PreparationPlan; wrote: boolean; stale: string[] } | { ok: false; refusals: string[] };

/**
 * Release preparation, the mechanical half of AGENTS.md "Releasing" steps 1 and 2: the version bump, the README Status line, the
 * bundle build, the CHANGELOG section and a verification report skeleton. It restamps nothing (a stamp records a human review: use
 * `restampDocuments`) and tags nothing. On a branch named `release/<version>`, never on main.
 */
export function prepareRelease(root: string, opts: { version?: string; dryRun: boolean; today: string; write: (path: string, data: string) => void; read: (path: string) => string; run: Run }): Preparation {
  const git = (...args: string[]) => opts.run(["git", ...args], { cwd: root });
  const refusals: string[] = [];
  let current: string;
  try { current = JSON.parse(opts.read("package.json")).version; } catch { return { ok: false, refusals: ["package.json is unreadable"] }; }
  if (!parseVersion(current)) return { ok: false, refusals: [`package.json version is not a version: ${current}`] };
  const tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"), lastTag = text(tag);
  if (tag.code !== 0 || !lastTag) return { ok: false, refusals: ["no earlier v* tag is reachable from HEAD: nothing to prepare a release against"] };
  const subjects = git("log", "--first-parent", "--format=%s", `${lastTag}..HEAD`).stdout.split("\n").map(line => line.trim()).filter(Boolean);
  if (!subjects.length) return { ok: false, refusals: [`no commits since ${lastTag}`] };
  const bump = bumpFor(subjects), ruled = nextVersion(lastTag.slice(1), bump);
  const version = opts.version ?? ruled;
  if (!RELEASE_VERSION.test(version)) refusals.push(`not a release version: ${version}`);
  else {
    if (compareVersions(version, lastTag.slice(1)) <= 0) refusals.push(`${version} is not newer than ${lastTag}`);
    if (compareVersions(version, ruled) < 0) refusals.push(`${version} is below the version the rule gives (${ruled}: any \`feat\` change since ${lastTag} bumps the minor, a fix-only release the patch)`);
  }
  const branch = text(git("symbolic-ref", "--short", "-q", "HEAD"));
  if (!branch) refusals.push("HEAD is detached: prepare the release on a release/<version> branch");
  else if (branch === "main") refusals.push("this is main: prepare the release on a release/<version> branch and open a PR (never commit to main)");
  else if (RELEASE_VERSION.test(version) && branch !== `release/${version}`) refusals.push(`the branch is ${branch}, expected release/${version}`);
  if (git("diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--").code !== 0 || git("diff-index", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--").code !== 0 || git("ls-files", "--others", "--exclude-standard").stdout.trim()) refusals.push("the working tree is not clean: commit or stash first");
  const changelog = opts.read("CHANGELOG.md");
  let nextChangelog = "", nextReadme = "", nextPackage = "";
  try { nextChangelog = moveUnreleased(changelog, version); nextReadme = setReadmeStatus(opts.read("README.md"), version); nextPackage = setPackageVersion(opts.read("package.json"), version); }
  catch (error) { refusals.push(error instanceof Error ? error.message : String(error)); }
  if (refusals.length) return { ok: false, refusals };

  const added = git("diff", "--name-only", "--diff-filter=A", `${lastTag}..HEAD`, "--", "docs/verification").stdout.split("\n").filter(path => path && !/-\d+\.\d+\.\d+\.md$/.test(path));
  const plan: PreparationPlan = { current, version, bump, lastTag, subjects, prs: prNumbers(subjects), receipts: added, branch };
  if (opts.dryRun) return { ok: true, plan, wrote: false, stale: [] };

  opts.write("package.json", nextPackage); opts.write("README.md", nextReadme); opts.write("CHANGELOG.md", nextChangelog);
  const built = opts.run(["bun", "run", "build"], { cwd: root });
  if (built.code !== 0) return { ok: false, refusals: [`bun run build failed: ${(built.stderr || built.stdout).trim().split("\n").slice(-2).join(" ")}`] };
  opts.write(`docs/verification/${opts.today}-${version}.md`, reportSkeleton(plan, git("rev-parse", "--short=8", "HEAD").stdout.trim()));
  return { ok: true, plan, wrote: true, stale: staleDocuments(root, opts.run) };
}

/** Documents `check-docs` reports stale, as the agent's review list. The script exits 0 for stale documents unless `--require-fresh`. */
export function staleDocuments(root: string, run: Run): string[] {
  const result = run([process.execPath, join(root, "scripts/check-docs.mjs"), root], { cwd: root });
  return (result.stdout + result.stderr).split("\n").map(line => /^docs: (\S+): stale/.exec(line)?.[1]).filter((path): path is string => !!path);
}

export function reportSkeleton(plan: PreparationPlan, head: string): string {
  const feat = plan.subjects.filter(subject => /^feat(?:\([^)]*\))?!?:/.test(subject)).length;
  return `# ${plan.version} release verification

This record covers release preparation and source review. It claims no installation, no running-hub upgrade to ${plan.version} and no live TUI launch.

## Candidate

Version ${plan.version}, prepared from main ${head} (${plan.subjects.length} commit${plan.subjects.length === 1 ? "" : "s"} since ${plan.lastTag}, ${feat} of them \`feat\`; bump rule: ${plan.bump}). The release commits carry the version, the CHANGELOG section, the bundle and the documentation stamps.

## Reviews

Pull requests named by the commits since ${plan.lastTag}: ${plan.prs.length ? plan.prs.map(pr => `#${pr}`).join(", ") : "none named"}.

${AGENT_TODO}: state, for each, that it merged after its hub review with exact-head CI green (the conductor reads it); name any merge bound to an approval at an earlier head.

## Native acceptance receipts

Receipts added under \`docs/verification/\` since ${plan.lastTag}: ${plan.receipts.length ? plan.receipts.map(path => `\`${path}\``).join(", ") : "none"}.

This list is read from the repository, never written by hand. Native acceptance and the person's release consent are separate records: consent is \`ahub sdlc authorize-release ${plan.version}\`, person only, and is not recorded in this file. The tag run refuses without it.

## Document review

${AGENT_TODO}: list the documents \`node scripts/check-docs.mjs\` reported stale, what changed under each and the stamp commit; restamp only the documents you read (\`bun scripts/release-prepare.ts restamp <document>... --reviewed\`).

## Checks

${AGENT_TODO}: \`node scripts/check-docs.mjs --require-fresh\`, \`bun x tsc --noEmit\`, \`bun scripts/build.mjs --check\`, \`node scripts/check-package.mjs\`, and the release PR's exact-head CI run.

## Known gaps, not blocking

${AGENT_TODO}: what was not run or not verified, and why.
`;
}

/** Sets verifiedAgainst to HEAD for the named documents only, after the agent attests it read them. Never `all`, never an unnamed document. */
export function restampDocuments(root: string, names: readonly string[], opts: { reviewed: boolean; run: Run; read: (path: string) => string; write: (path: string, data: string) => void }): { ok: true; stamped: string[]; head: string } | { ok: false; refusals: string[] } {
  const git = (...args: string[]) => opts.run(["git", ...args], { cwd: root });
  if (!opts.reviewed) return { ok: false, refusals: ["a stamp records a human source review: pass --reviewed once you read what changed under each document"] };
  if (!names.length) return { ok: false, refusals: ["name the documents to restamp (never all of them at once)"] };
  const head = text(git("rev-parse", "--verify", "HEAD^{commit}"));
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, refusals: ["HEAD does not resolve"] };
  if (git("diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", "HEAD", "--").code !== 0) return { ok: false, refusals: ["there are staged changes: the stamp names a commit, so commit first"] };
  let manifest: { documents: Record<string, { verifiedAgainst: string; paths: string[] }> };
  try { manifest = JSON.parse(opts.read("docs/verified.json")); } catch { return { ok: false, refusals: ["docs/verified.json is unreadable"] }; }
  const unknown = names.filter(name => !Object.hasOwn(manifest.documents, name));
  if (unknown.length) return { ok: false, refusals: [`not in docs/verified.json: ${unknown.join(", ")}`] };
  for (const name of names) manifest.documents[name]!.verifiedAgainst = head;
  opts.write("docs/verified.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, stamped: [...names], head };
}

export const fileReader = (root: string) => (path: string) => readFileSync(join(root, path), "utf8");
export const fileExists = (root: string, path: string) => existsSync(join(root, path));
