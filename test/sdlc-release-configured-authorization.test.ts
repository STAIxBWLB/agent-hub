import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { runBoundedReceiptCommand } from "../scripts/compat-receipts/runner.ts";
import { ReleaseAuthorizations, type ReleaseAuthorization } from "../src/hub/sdlc-release-authorization.ts";
import { readCommittedReleasePolicy } from "../src/hub/sdlc-release-policy.ts";
import { renderAuthorization } from "../src/cli/sdlc-output.ts";
import type { DocEvidence } from "../src/hub/sdlc-release.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const ZERO = "0".repeat(40);
function fixtureEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, "home"), tmp = join(root, "tmp");
  mkdirSync(home, { recursive: true }); mkdirSync(tmp, { recursive: true });
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function fixture(options: { release?: Record<string, unknown>; packageVersion?: string; notes?: string; packageFile?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-auth-")); roots.push(root);
  const environment = fixtureEnv(root);
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: environment, timeout: 5000 }).trim();
  run(["init", "-q"]);
  const remote = join(root, "..", `remote-${Math.random().toString(16).slice(2)}.git`);
  execFileSync("git", ["init", "--bare", "-q", remote], { cwd: root, encoding: "utf8", env: environment, timeout: 5000 }); roots.push(remote);
  run(["remote", "add", "origin", remote]);
  const config = options.release ? { release: options.release } : {};
  mkdirSync(join(root, ".agenthub"), { recursive: true });
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify(config) + "\n");
  if (options.packageFile !== false) writeFileSync(join(root, "package.json"), JSON.stringify({ version: options.packageVersion ?? "1.2.3" }) + "\n");
  if (options.notes) { mkdirSync(dirname(join(root, options.notes)), { recursive: true }); writeFileSync(join(root, options.notes), "release notes\n"); }
  run(["add", "--all"]);
  run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "candidate"]);
  const commit = run(["rev-parse", "HEAD"]);
  const git = (args: string[]) => {
    try { return { code: 0, stdout: execFileSync("git", args, { cwd: root, encoding: "utf8", env: environment, timeout: 5000 }) }; }
    catch (error) { return { code: 1, stdout: (error as { stdout?: string }).stdout?.toString() ?? "" }; }
  };
  const docs: DocEvidence = { schemaVersion: 1, head: commit, version: options.packageVersion ?? "1.2.3", fresh: true, errors: 0,
    documents: [{ path: "README.md", state: "fresh", verifiedAgainst: commit, commits: 0, dirty: false }] };
  const recorded: ReleaseAuthorization[] = [];
  let docsCalls = 0;
  const host = new ReleaseAuthorizations(root, {
    git,
    policy: (candidate, reader) => readCommittedReleasePolicy(reader, candidate),
    docs: async () => { docsCalls++; return docs; },
    record: receipt => { recorded.push(receipt); return true; },
  });
  const tagPush = (version: string, target = commit) => {
    const ref = `refs/tags/v${version}`;
    run(["tag", "-f", `v${version}`, target]);
    return host.guardPush("origin", remote, [{ localRef: ref, localOid: target, remoteRef: ref, remoteOid: ZERO, version }]);
  };
  return { root, remote, run, git, commit, host, docsCalls: () => docsCalls, recorded, tagPush };
}

test("#1381 release-notes source authorizes its committed version and rejects missing notes, wrong version and another commit", async () => {
  const f = fixture({ release: { version: "release-notes", docs: "none" }, notes: "docs/releases/v1.2.3.md", packageFile: false });
  try {
    await expect(f.host.authorize("user", "1.2.4", f.commit)).rejects.toThrow("add docs/releases/v1.2.4.md");
    const receipt = await f.host.authorize("user", "1.2.3", f.commit);
    expect(receipt).toMatchObject({ commit: f.commit, version: "1.2.3", docs: { source: "none" } });
    expect("digest" in receipt.docs).toBe(false);
    expect(f.docsCalls()).toBe(0);
    expect((await f.tagPush("1.2.3")).ok).toBe(true);
    const ref = "refs/tags/v1.2.3";
    expect(f.host.guardPush("origin", "/wrong/remote", [{ localRef: ref, localOid: f.commit, remoteRef: ref, remoteOid: ZERO, version: "1.2.3" }]).ok).toBe(false);
    expect((await f.tagPush("1.2.4")).ok).toBe(false);
    f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "different candidate"]);
    const next = f.run(["rev-parse", "HEAD"]);
    expect((await f.tagPush("1.2.3", next)).ok).toBe(false);
  } finally { /* afterEach owns both repositories */ }

  const missing = fixture({ release: { version: "release-notes" }, packageFile: false });
  await expect(missing.host.authorize("user", "1.2.3", missing.commit)).rejects.toThrow("add docs/releases/v1.2.3.md");
});

test("#1381 release-notes keeps checker evidence required by default", async () => {
  const f = fixture({ release: { version: "release-notes" }, notes: "docs/releases/v1.2.3.md" });
  const receipt = await f.host.authorize("user", "1.2.3", f.commit);
  expect(receipt.docs).toMatchObject({ fresh: true, errors: 0, documents: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(f.docsCalls()).toBe(1);
  expect((await f.tagPush("1.2.3")).ok).toBe(true);
  expect(f.docsCalls()).toBe(1);
});

test("#1381 version none binds the requested semantic version and still enforces the person or configured conductor", async () => {
  const f = fixture({ release: { version: "none", docs: "none" }, packageFile: false });
  const actorGuard = new ReleaseAuthorizations(f.root, { git: f.git, policy: (commit, git) => readCommittedReleasePolicy(git, commit),
    conductor: () => "codex", record: () => true });
  await expect(actorGuard.authorize("claude", "1.2.3", f.commit)).rejects.toThrow("only the person");
  const receipt = await actorGuard.authorize("codex", "1.2.3", f.commit);
  expect(receipt).toMatchObject({ by: "codex", version: "1.2.3", docs: { source: "none" } });
});

test("#1381 package.json source errors name the committed policy next step when version evidence is absent", async () => {
  const f = fixture({ packageFile: false });
  await expect(f.host.authorize("user", "1.2.3", f.commit)).rejects.toThrow("set release.version to release-notes or none in .agenthub/config.json");
});

test("#1381 docs none skips only the checker; npm still needs a clean tree and package version matching notes", async () => {
  const f = fixture({ release: { version: "release-notes", docs: "none" }, notes: "docs/releases/v1.2.3.md" });
  const receipt = await f.host.authorize("user", "1.2.3", f.commit);
  expect(receipt.docs).toEqual({ source: "none" });
  expect(renderAuthorization(receipt).flat().map(span => span.text).join(" ")).toContain("none (explicit exemption)");
  expect(f.docsCalls()).toBe(0);
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: true });

  const mismatch = fixture({ release: { version: "release-notes", docs: "none" }, packageVersion: "9.9.9", notes: "docs/releases/v1.2.3.md" });
  await mismatch.host.authorize("user", "1.2.3", mismatch.commit);
  expect(await mismatch.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });

  const dirty = fixture({ release: { version: "none", docs: "none" } });
  await dirty.host.authorize("user", "1.2.3", dirty.commit);
  writeFileSync(join(dirty.root, "package.json"), '{"version":"1.2.4"}\n');
  expect(await dirty.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });

  const noPackage = fixture({ release: { version: "none", docs: "none" }, packageFile: false });
  await noPackage.host.authorize("user", "1.2.3", noPackage.commit);
  expect(await noPackage.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false, error: expect.stringContaining("committed package.json version") });
});

test("#1381 malformed committed policy fails closed and uncommitted config cannot change an issued receipt", async () => {
  const f = fixture({ release: { version: "none", docs: "none" } });
  const receipt = await f.host.authorize("user", "1.2.3", f.commit);
  writeFileSync(join(f.root, ".agenthub/config.json"), '{"release":{"version":"package.json"}}\n');
  expect(await f.host.guardRequest({ kind: "tag-push", version: receipt.version, tag: "v1.2.3", sourceRef: "HEAD", remote: "origin" })).toMatchObject({ ok: true });

  const malformed = fixture({ release: { version: "bad" } });
  const malformedHost = new ReleaseAuthorizations(malformed.root, { git: malformed.git, policy: (commit, git) => readCommittedReleasePolicy(git, commit), record: () => true });
  await expect(malformedHost.authorize("user", "1.2.3", malformed.commit)).rejects.toThrow("committed release policy unavailable");
});

test("#1381 authorization snapshots a policy object before awaiting documentation evidence", async () => {
  const f = fixture();
  const policy = { version: { source: "package.json" } as const, docs: { source: "checker" } as const };
  const evidence: DocEvidence = { schemaVersion: 1, head: f.commit, version: "1.2.3", fresh: true, errors: 0,
    documents: [{ path: "README.md", state: "fresh", verifiedAgainst: f.commit, commits: 0, dirty: false }] };
  const unstable = new ReleaseAuthorizations(f.root, {
    git: f.git,
    policy: () => policy,
    docs: async () => { (policy as { version: { source: "package.json" }; docs: { source: "checker" | "none" } }).docs = { source: "none" }; return evidence; },
    record: () => true,
  });
  await expect(unstable.authorize("user", "1.2.3", f.commit)).rejects.toThrow("committed release policy changed");
});

test("#1381 committed release-notes policy authorizes the real CLI and pre-push hook without package.json or checker evidence", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-release-policy-flow-")); roots.push(temp);
  const root = join(temp, "repo"), stateDir = join(temp, "state"), home = join(temp, "home"), remote = join(temp, "remote.git");
  mkdirSync(root); mkdirSync(stateDir); mkdirSync(home);
  const runGit = (...args: string[]) => {
    const result = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 3000, env: childEnv });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const childEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: join(temp, "tmp"), LANG: "C", LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    AGENTHUB_HOME: join(home, "hub"), AGENTHUB_PROJECT_DIR: root, AGENTHUB_STATE_DIR: stateDir };
  mkdirSync(childEnv.TMPDIR, { recursive: true });
  const isolatedHomes: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), AGENTHUB_HOME: childEnv.AGENTHUB_HOME,
    AMEM_HOME: join(home, "amem"), CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude"), KIMI_CODE_HOME: join(home, "kimi"),
    QWEN_CODE_HOME: join(home, "qwen"), JCODE_HOME: join(home, "jcode"), TMPDIR: childEnv.TMPDIR };
  for (const path of Object.values(isolatedHomes)) mkdirSync(path, { recursive: true });
  const originalEnv = { ...process.env };
  let daemon: { stop: () => Promise<void> } | undefined, person: ControlClient | undefined;
  async function run(argv: string[]) {
    const result = await runBoundedReceiptCommand(argv, { cwd: root, env: { ...childEnv, ...isolatedHomes },
      signal: AbortSignal.timeout(20_000), timeoutMs: 15_000, maxBytes: 64 * 1024 });
    return { code: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr,
      timedOut: result.timedOut, ownedStopConfirmed: result.ownedStopConfirmed };
  }
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, childEnv, isolatedHomes);
    const { DEFAULT_CONFIG, startDaemon } = await import("../src/hub/daemon.ts");
    const { init } = await import("../src/cli/init.ts");
    runGit("init", "-q");
    execFileSync("git", ["init", "--bare", "-q", remote], { cwd: temp, env: childEnv, timeout: 5000 });
    runGit("remote", "add", "origin", remote);
    mkdirSync(join(root, ".agenthub"), { recursive: true });
    mkdirSync(join(root, "docs/releases"), { recursive: true });
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ release: { version: "release-notes", docs: "none" } }) + "\n");
    writeFileSync(join(root, "docs/releases/v1.2.3.md"), "Committed release notes\n");
    init(root, undefined, false, true);
    // This release-only fixture omits model routing; an empty routing file is not a valid configured policy.
    unlinkSync(join(root, ".agenthub/routing.toml"));
    runGit("add", "--all");
    runGit("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "release candidate without package manifest");
    const commit = runGit("rev-parse", "HEAD");
    runGit("tag", "v1.2.3");
    const hook = join(root, ".git/hooks/pre-push");
    expect(existsSync(hook)).toBe(true);
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      releaseDocEvidence: async () => { throw new Error("docs:none must skip the checker"); },
      config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 }, start: { agents: [] } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    const cli = join(import.meta.dir, "../src/cli/main.ts");
    const approval = await run([process.execPath, cli, "sdlc", "authorize-release", "1.2.3", "--json"]);
    expect(approval.timedOut).toBe(false); expect(approval.ownedStopConfirmed).toBe(true);
    expect(approval.code, approval.stderr).toBe(0);
    expect(JSON.parse(approval.stdout)).toMatchObject({ by: "user", commit, version: "1.2.3", docs: { source: "none" } });
    const push = await run(["git", "push", "origin", "v1.2.3"]);
    expect(push.timedOut).toBe(false); expect(push.ownedStopConfirmed).toBe(true);
    expect(push.code, push.stderr).toBe(0);
    expect(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/tags/v1.2.3"], { cwd: temp, env: childEnv, encoding: "utf8", timeout: 5000 }).trim()).toBe(commit);
  } finally {
    person?.close();
    try { await daemon?.stop(); }
    finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
    }
  }
  // Two receipt-bounded commands plus daemon and owned-home cleanup.
}, 60_000);

test("#1381 docs none cannot exempt a candidate with a committed verification manifest", async () => {
  const f = fixture({ release: { version: "package.json", docs: "none" } });
  mkdirSync(join(f.root, "docs"), { recursive: true });
  writeFileSync(join(f.root, "docs/verified.json"), "{}\n");
  f.run(["add", "docs/verified.json"]);
  f.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "verification manifest"]);
  const commit = f.run(["rev-parse", "HEAD"]);
  const refusal = "release.docs is none but the candidate commits docs/verified.json; remove release.docs from .agenthub/config.json or delete the manifest, then authorize again";
  expect(() => readCommittedReleasePolicy(f.git, commit)).toThrow(refusal);
  await expect(f.host.authorize("user", "1.2.3", commit)).rejects.toThrow(refusal);
  expect(f.recorded).toEqual([]);
  expect(f.docsCalls()).toBe(0);
  expect(f.host.reportPolicy(commit, "example/repo")?.authorization).toBe("unavailable");
  expect(await f.host.guardRequest({ kind: "npm-publish" })).toMatchObject({ ok: false });
});
