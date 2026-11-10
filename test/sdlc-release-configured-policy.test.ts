import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { stripUntrusted } from "../src/hub/config-trust.ts";
import { configChanges } from "../src/hub/config-apply.ts";
import { DEFAULT_RELEASE_POLICY, hasCommittedReleaseNotes, parseReleasePolicy, readCommittedReleasePolicy } from "../src/hub/sdlc-release-policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-policy-")); roots.push(root);
  const home = join(root, "home"), tmp = join(root, "tmp");
  mkdirSync(home); mkdirSync(tmp);
  const gitEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, timeout: 5000 }).trim();
  run(["init", "-q"]);
  for (const [path, contents] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents); }
  run(["add", "--all"]);
  run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "candidate"]);
  const commit = run(["rev-parse", "HEAD"]);
  const git = (args: string[]) => {
    try { return { code: 0, stdout: execFileSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv, timeout: 5000 }) }; }
    catch (error) { return { code: 1, stdout: (error as { stdout?: string }).stdout?.toString() ?? "" }; }
  };
  return { root, run, commit, git };
}

test("#1381 release policy defaults only when shared config is absent and ignores working-tree or local policy", async () => {
  const f = repository({ "package.json": '{"version":"1.2.3"}\n' });
  expect(readCommittedReleasePolicy(f.git, f.commit)).toEqual(DEFAULT_RELEASE_POLICY);
  mkdirSync(join(f.root, ".agenthub"), { recursive: true });
  writeFileSync(join(f.root, ".agenthub/config.json"), '{"release":{"version":"none","docs":"none"}}\n');
  expect(readCommittedReleasePolicy(f.git, f.commit)).toEqual(DEFAULT_RELEASE_POLICY);

  const local = { release: { version: "invalid", docs: "invalid" } } as Record<string, unknown>;
  const notice = stripUntrusted(local, {}, f.root, "config.local.json");
  expect(local.release).toBeUndefined();
  expect(notice).toContain("release in .agenthub/config.local.json ignored");
  expect(notice).toContain("only committed .agenthub/config.json");
  writeFileSync(join(f.root, ".agenthub/config.local.json"), '{"release":{"version":"invalid","docs":"invalid"}}\n');
  const home = join(f.root, "isolated-home"), tmp = join(f.root, "isolated-tmp");
  mkdirSync(home); mkdirSync(tmp);
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmp, LANG: "C", LC_ALL: "C",
    XDG_CONFIG_HOME: join(home, ".config"), AGENTHUB_HOME: join(home, ".agenthub"), AMEM_HOME: join(home, ".amem"),
    CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), KIMI_CODE_HOME: join(home, ".kimi"),
    QWEN_CODE_HOME: join(home, ".qwen"), JCODE_HOME: join(home, ".jcode"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  const originalEnv = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    const { DEFAULT_CONFIG, loadConfig } = await import("../src/hub/daemon.ts");
    const loaded = loadConfig(f.root);
    expect("release" in loaded).toBe(false);
    expect(loaded.releasePolicyNotices?.some(line => line.includes("release in .agenthub/config.local.json ignored") && line.includes("only committed .agenthub/config.json"))).toBe(true);
    expect(configChanges(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, releasePolicyNotices: loaded.releasePolicyNotices }, [])).toEqual([]);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});

test("#1381 release source grammar defaults notesPath and rejects unknown or unsafe policy", () => {
  expect(parseReleasePolicy({ release: {} })).toEqual(DEFAULT_RELEASE_POLICY);
  expect(parseReleasePolicy({ release: { version: "release-notes", docs: "none" } })).toEqual({
    version: { source: "release-notes", notesPath: "docs/releases/v{version}.md" }, docs: { source: "none" },
  });
  for (const release of [
    { version: null }, { docs: null }, { notesPath: null }, { version: "latest" }, { version: "release-notes", other: true }, { version: "release-notes", notesPath: "../v{version}.md" },
    { version: "release-notes", notesPath: "/tmp/v{version}.md" }, { version: "release-notes", notesPath: "docs/v{version}/{version}.md" },
    { version: "release-notes", notesPath: "docs/*/{version}.md" }, { version: "none", docs: "skip" },
  ]) expect(() => parseReleasePolicy({ release })).toThrow();
});

test("#1381 committed release policy and release notes require regular blobs at the candidate", () => {
  const f = repository({
    ".agenthub/config.json": '{"release":{"version":"release-notes","docs":"none"}}\n',
    "docs/releases/v1.2.3.md": "Release notes\n",
  });
  const policy = readCommittedReleasePolicy(f.git, f.commit);
  expect(policy).toEqual({ version: { source: "release-notes", notesPath: "docs/releases/v{version}.md" }, docs: { source: "none" } });
  expect(hasCommittedReleaseNotes(f.git, f.commit, "docs/releases/v1.2.3.md")).toBe(true);
  expect(hasCommittedReleaseNotes(f.git, f.commit, "docs/releases/v1.2.4.md")).toBe(false);

  const malformed = repository({ ".agenthub/config.json": '{"release":{"version":"other"}}\n' });
  expect(() => readCommittedReleasePolicy(malformed.git, malformed.commit)).toThrow("release.version");

  const link = repository({ ".agenthub/config.json": '{"release":{"version":"release-notes"}}\n', "outside.md": "outside\n" });
  mkdirSync(join(link.root, "docs/releases"), { recursive: true });
  symlinkSync("../../outside.md", join(link.root, "docs/releases/v1.2.3.md"));
  link.run(["add", "--all"]);
  link.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "symlink notes"]);
  const linkedCommit = link.run(["rev-parse", "HEAD"]);
  expect(hasCommittedReleaseNotes(link.git, linkedCommit, "docs/releases/v1.2.3.md")).toBe(false);
});

test("#1381 unreadable or symlinked committed shared policy fails closed instead of using defaults", () => {
  const readable = repository({ ".agenthub/config.json": '{"release":{"version":"none"}}\n' });
  const unreadable = (args: string[]) => args[0] === "show" ? { code: 1, stdout: "" } : readable.git(args);
  expect(() => readCommittedReleasePolicy(unreadable, readable.commit)).toThrow("config.json is unreadable");

  const linked = repository({ ".agenthub/marker": "tree\n", "outside.json": '{"release":{"version":"none"}}\n' });
  symlinkSync("../outside.json", join(linked.root, ".agenthub/config.json"));
  linked.run(["add", "--all"]);
  linked.run(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "linked config"]);
  const commit = linked.run(["rev-parse", "HEAD"]);
  expect(() => readCommittedReleasePolicy(linked.git, commit)).toThrow("not a regular file");
});
