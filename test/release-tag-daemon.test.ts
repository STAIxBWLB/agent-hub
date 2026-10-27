import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { init } from "../src/cli/init.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

// #787 P3b through the real path: a started daemon with its default committed-docs reader, the person's real `ahub sdlc authorize-release`
// (the real CLI as a person, no agent markers), the real release pre-push hook from `ahub init --release-guard`, and the real
// scripts/release-tag.ts run as an agent. The only remote is a bare directory on this disk, so the push can reach nothing else.
const ROOT = resolve(import.meta.dir, "..");
const VERSION = "0.2.0";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
/** The daemon runs in this process, so every child that talks to it must be spawned without blocking the event loop. */
async function runAsync(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: stdout + stderr, stdout, stderr };
  } finally { clearTimeout(timer); }
}
const DOCS = ["README.md", "docs/security.md", "docs/operations.md", "docs/quickstart.md", "docs/agent-notes/example.md"];

test("the real tag run refuses until the person authorizes through the real daemon, then pushes once through the real pre-push hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-e2e-")), work = join(dir, "work"), remote = join(dir, "remote.git"), stateDir = join(work, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(work); mkdirSync(remote);
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: work, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path: string, data: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), data); };
  git("init", "-q", "-b", "main"); git("remote", "add", "origin", remote);
  write("package.json", `{\n  "name": "fixture",\n  "version": "0.1.0"\n}\n`);
  write("README.md", "Status: 0.1.0, control protocol 13.\n");
  for (const doc of DOCS.slice(1)) write(doc, "Fixture\n");
  write("src/covered.ts", "initial\n"); write("CHANGELOG.md", "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- first\n");
  // The release scripts live in the project they release; the hub's own default doc reader runs the checker it ships.
  mkdirSync(join(work, "scripts/lib"), { recursive: true });
  for (const file of ["scripts/release-tag.ts", "scripts/lib/release-plan.ts", "scripts/check-docs.mjs"]) copyFileSync(join(ROOT, file), join(work, file));
  git("add", "-A"); git("commit", "-qm", "chore: initial"); git("tag", "v0.1.0"); git("push", "-q", "origin", "main", "v0.1.0"); // before the hook exists: a real hook refuses an unauthorized v* push
  init(work, undefined, false, true); // writes .agenthub, AGENTS.md, .gitignore and the real release pre-push hook
  const routing = join(work, ".agenthub/routing.toml");
  writeFileSync(routing, readFileSync(routing, "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  git("add", "-A"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "chore: hub project files"); // -f: a global gitignore may cover .agenthub/
  expect(git("status", "--porcelain")).toBe(""); // the release checkout is clean, so a refusal below is never about the fixture
  git("checkout", "-qb", `release/${VERSION}`);
  write("src/covered.ts", "release source\n");
  write("package.json", `{\n  "name": "fixture",\n  "version": "${VERSION}"\n}\n`);
  write("README.md", `Status: ${VERSION}, control protocol 13.\n`);
  write("CHANGELOG.md", `# Changelog\n\n## Unreleased\n\n## ${VERSION}\n\n- a change\n\n## 0.1.0\n\n- first\n`);
  write(`docs/verification/2026-10-27-${VERSION}.md`, `# ${VERSION}\n\nDone.\n`);
  git("add", "-A"); git("commit", "-qm", "release: prepare");
  const reviewed = git("rev-parse", "HEAD");
  write("docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: Object.fromEntries(DOCS.map(doc => [doc, { verifiedAgainst: reviewed, paths: ["src/covered.ts"] }])) }, null, 2) + "\n");
  git("add", "-A"); git("commit", "-qm", "docs: stamp");
  const release = git("rev-parse", "HEAD");
  git("checkout", "-q", "main"); git("merge", "--no-ff", "-m", `Merge pull request #900 from owner/release/${VERSION}`, release); git("push", "-q", "origin", "main");
  const head = git("rev-parse", "HEAD");

  const daemon = await startDaemon({ cwd: work, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {},
    config: { ...DEFAULT_CONFIG, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false }, batch_ms: 0,
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { enabled: false, keep: 1 }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
      task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());

  const cli = join(ROOT, "src/cli/main.ts");
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), AGENTHUB_HOME: join(dir, "home/hub"), AGENTHUB_PROJECT_DIR: work, AGENTHUB_STATE_DIR: stateDir };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID", "AGENTHUB_DELIVERY_ONLY"]) delete baseEnv[name];
  const asAgent = { ...baseEnv, AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "fixture-thread", AHUB_CLI: cli };
  const run = (argv: string[], env: NodeJS.ProcessEnv) => runAsync([process.execPath, ...argv], work, env);
  const tagOnRemote = () => spawnSync("git", ["--git-dir", remote, "tag", "--list"], { encoding: "utf8" }).stdout.trim();
  const tagScript = join(work, "scripts/release-tag.ts");

  // 1. No consent: the real guard says no, a dry run says so (exit 2), and --execute refuses and pushes nothing.
  const dry = await run([tagScript, VERSION], asAgent);
  expect(dry.out).toContain(`preflight passed for v${VERSION} at ${head}`);
  expect(dry.out).toContain(`ahub sdlc authorize-release ${VERSION}`);
  expect(dry.code).toBe(2);
  const refused = await run([tagScript, VERSION, "--execute"], asAgent);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`no person release consent for v${VERSION}`);
  expect(tagOnRemote()).toBe("v0.1.0");

  // 2. An agent cannot grant consent, and the tag script does not try to.
  expect((await run([cli, "sdlc", "authorize-release", VERSION], asAgent)).code).toBe(1);
  expect(tagOnRemote()).toBe("v0.1.0");

  // 3. The person authorizes through the real CLI and the real daemon (committed docs read by the daemon's default reader).
  const approval = await run([cli, "sdlc", "authorize-release", VERSION, "--json"], baseEnv);
  expect(approval.code, approval.out).toBe(0);
  expect(JSON.parse(approval.out)).toMatchObject({ by: "user", version: VERSION, commit: head, docs: { fresh: true } });

  // 4. Dry run now reports consent (exit 0); --execute pushes exactly one tag, at that commit, through the real pre-push hook.
  expect((await run([tagScript, VERSION], asAgent)).code).toBe(0);
  expect(tagOnRemote()).toBe("v0.1.0");
  const tagged = await run([tagScript, VERSION, "--execute"], asAgent);
  expect(tagged.code, tagged.out).toBe(0);
  expect(tagged.out).toContain(`pushed v${VERSION} at ${head}`);
  expect(tagOnRemote()).toBe(`v0.1.0\nv${VERSION}`);
  expect(spawnSync("git", ["--git-dir", remote, "rev-parse", `v${VERSION}^{commit}`], { encoding: "utf8" }).stdout.trim()).toBe(head);

  // 5. One shot: a second run refuses because the tag now exists, whatever the consent.
  const again = await run([tagScript, VERSION, "--execute"], asAgent);
  expect(again.code).toBe(1);
  expect(again.out).toContain(`tag v${VERSION} already exists on origin`);
  expect(readFileSync(join(stateDir, "events.jsonl"), "utf8")).toContain('"type":"release_authorization"');
  expect(existsSync(join(work, ".git/hooks/pre-push"))).toBe(true); // the guard that ran on the push was the real installed hook
}, 60_000);

test("a hub restart revokes the person's consent, so the tag run refuses again and pushes nothing", async () => {
  // The consent ledger is daemon memory: this proves the real restart behavior reaches the tag script. Reuses no state from the test above.
  const dir = mkdtempSync(join(tmpdir(), "ahub-release-e2e-restart-")), work = join(dir, "work"), remote = join(dir, "remote.git"), stateDir = join(work, ".agenthub/state");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(work); mkdirSync(remote);
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: work, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path: string, data: string) => { mkdirSync(join(work, path, ".."), { recursive: true }); writeFileSync(join(work, path), data); };
  git("init", "-q", "-b", "main"); git("remote", "add", "origin", remote);
  write("package.json", `{\n  "name": "fixture",\n  "version": "${VERSION}"\n}\n`);
  write("README.md", `Status: ${VERSION}, control protocol 13.\n`);
  for (const doc of DOCS.slice(1)) write(doc, "Fixture\n");
  write("src/covered.ts", "x\n");
  mkdirSync(join(work, "scripts/lib"), { recursive: true });
  for (const file of ["scripts/check-docs.mjs"]) copyFileSync(join(ROOT, file), join(work, file));
  init(work, undefined, false, true);
  writeFileSync(join(work, ".agenthub/routing.toml"), readFileSync(join(work, ".agenthub/routing.toml"), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"'));
  git("add", "-A"); git("add", "-f", ".agenthub/config.json", ".agenthub/routing.toml"); git("commit", "-qm", "init");
  const reviewed = git("rev-parse", "HEAD");
  write("docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: Object.fromEntries(DOCS.map(doc => [doc, { verifiedAgainst: reviewed, paths: ["src/covered.ts"] }])) }, null, 2) + "\n");
  git("add", "-A"); git("commit", "-qm", "stamp");
  const head = git("rev-parse", "HEAD");
  const config = { ...DEFAULT_CONFIG, roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    snapshots: { enabled: false, keep: 1 }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
    task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } };
  const start = async () => { const daemon = await startDaemon({ cwd: work, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, notifier: () => {}, config }); cleanup.push(() => daemon.stop()); return daemon; };
  const cli = join(ROOT, "src/cli/main.ts");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(dir, "home"), AGENTHUB_HOME: join(dir, "home/hub"), AGENTHUB_PROJECT_DIR: work, AGENTHUB_STATE_DIR: stateDir };
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID", "AGENTHUB_DELIVERY_ONLY"]) delete env[name];
  const guard = (agent: boolean) => runAsync([process.execPath, cli, "sdlc", "release-guard", "--", "git", "push", "origin", `${head}:refs/tags/v${VERSION}`], work, agent ? { ...env, AGENTHUB_PEER_ID: "codex", CODEX_THREAD_ID: "t" } : env);

  const first = await start();
  expect((await guard(true)).code).toBe(1); // no consent yet
  const approval = await runAsync([process.execPath, cli, "sdlc", "authorize-release", VERSION, "--json"], work, env);
  expect(approval.code, approval.out).toBe(0);
  expect((await guard(true)).code).toBe(0); // the person's consent is in force for this exact commit and version
  await first.stop();
  const second = await start(); void second;
  expect((await guard(true)).code).toBe(1); // a restart revoked it
  expect(spawnSync("git", ["--git-dir", remote, "tag", "--list"], { encoding: "utf8" }).stdout.trim()).toBe("");
}, 60_000);
