import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { repoOf, snapshot } from "../src/hub/snapshots.ts";

/** A repository whose config names a program for every mechanism the helper disables; each writes its own marker. */
function rigged(): { repo: string; markers: { fsmonitor: string; hook: string; extdiff: string }; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-hubgit-"));
  const repo = join(dir, "repo");
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
  const script = (name: string) => {
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\necho ran >> ${join(dir, `${name}.marker`)}\nexit 0\n`, { mode: 0o755 });
    return p;
  };
  const markers = { fsmonitor: join(dir, "fsmonitor.marker"), hook: join(dir, "hook.marker"), extdiff: join(dir, "extdiff.marker") };
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho ran >> ${markers.hook}\nexit 0\n`, { mode: 0o755 });
  expect(spawnSync("git", ["-C", repo, "config", "core.fsmonitor", script("fsmonitor")]).status).toBe(0);
  expect(spawnSync("git", ["-C", repo, "config", "core.hooksPath", hooks]).status).toBe(0);
  expect(spawnSync("git", ["-C", repo, "config", "diff.external", script("extdiff")]).status).toBe(0);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  expect(spawnSync("git", ["-C", repo, "add", "tracked.txt"]).status).toBe(0);
  // The full identity, pinned: where the account has no full name, git exits 128 before the hook, and a missing
  // marker would prove nothing.
  expect(spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]).status).toBe(0);
  return { repo, markers, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const COMMIT_IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];

test("a repo-configured fsmonitor, hooks or external-diff program runs for a plain git call but not for the hub's (#281)", () => {
  const { repo, markers, clean } = rigged();
  try {
    // Control: the planted programs really do run when git is called bare.
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"]).status).toBe(0);
    expect(spawnSync("git", ["-C", repo, ...COMMIT_IDENTITY, "commit", "-qm", "plain", "--allow-empty"]).status).toBe(0);
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    expect(spawnSync("git", ["-C", repo, "--no-pager", "diff", "--no-index", join(repo, "tracked.txt"), "/dev/null"]).status).toBe(1); // differences
    expect(existsSync(markers.fsmonitor)).toBe(true);
    expect(existsSync(markers.hook)).toBe(true);
    expect(existsSync(markers.extdiff)).toBe(true);
    rmSync(markers.fsmonitor); rmSync(markers.hook); rmSync(markers.extdiff);
    // The hub's calls go through the helper: same operations, no marker. The pager, and the credential and askpass
    // helpers, need no plant: every hub call pipes stdout (git pages only to a terminal, and --no-pager is set) and
    // no hub command authenticates (GIT_TERMINAL_PROMPT=0 fails any such prompt closed).
    expect(hubGitSync(["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", repo, ...COMMIT_IDENTITY, "commit", "-qm", "hardened", "--allow-empty"], { encoding: "utf8" }).status).toBe(0);
    expect(hubGitSync(["-C", repo, "-c", "core.quotepath=off", "diff", "--no-index", "--no-color", "--no-ext-diff", "--unified=2", "--", join(repo, "tracked.txt"), "/dev/null"], { encoding: "utf8" }).status).toBe(1); // facts.ts's exact shape: differences, no external diff
    expect(existsSync(markers.fsmonitor)).toBe(false);
    expect(existsSync(markers.hook)).toBe(false);
    expect(existsSync(markers.extdiff)).toBe(false);
    // And through a real hub call site, the per-turn snapshot (its add/write-tree touch the index).
    writeFileSync(join(repo, "a.txt"), "one\n");
    const repo_ = repoOf(repo);
    expect(repo_).toBeDefined();
    expect(snapshot(repo_!)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markers.fsmonitor)).toBe(false);
    expect(existsSync(markers.hook)).toBe(false);
    expect(existsSync(markers.extdiff)).toBe(false);
  } finally {
    clean();
  }
});

test("no direct git spawn under src/ outside the helper and the sandboxed tool (#281)", () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  const direct = /\bspawn(?:Sync)?\(\s*(?:\[\s*)?["'`]git["'`]/;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && p !== join(src, "hub", "git.ts") && p !== join(src, "local", "tools.ts") && direct.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
  // What this guard does not catch: a variable holding "git", execFile, or an absolute path to the binary. It is a
  // tripwire for the two spawn idioms this codebase uses, not a proof. src/local/tools.ts is exempt: its git argv
  // runs inside the sandbox through sandboxedExec.
});
