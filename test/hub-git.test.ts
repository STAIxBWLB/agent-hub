import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { repoOf, snapshot } from "../src/hub/snapshots.ts";

/** A repository whose config names a program for every mechanism the helper disables; each writes its own marker. */
function rigged(): { repo: string; markers: { fsmonitor: string; hook: string }; clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-hubgit-"));
  const repo = join(dir, "repo");
  expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
  const script = (name: string) => {
    const p = join(dir, `${name}.sh`);
    writeFileSync(p, `#!/bin/sh\necho ran >> ${join(dir, `${name}.marker`)}\nexit 0\n`, { mode: 0o755 });
    return p;
  };
  const markers = { fsmonitor: join(dir, "fsmonitor.marker"), hook: join(dir, "hook.marker") };
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho ran >> ${markers.hook}\nexit 0\n`, { mode: 0o755 });
  expect(spawnSync("git", ["-C", repo, "config", "core.fsmonitor", script("fsmonitor")]).status).toBe(0);
  expect(spawnSync("git", ["-C", repo, "config", "core.hooksPath", hooks]).status).toBe(0);
  return { repo, markers, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const commit = (git: (args: string[]) => number | null, repo: string, message: string) => git(["-C", repo, "-c", "user.email=t@t", "commit", "-qm", message, "--allow-empty"]);

test("a repo-configured fsmonitor or hooks program runs for a plain git call but not for the hub's (#281)", () => {
  const { repo, markers, clean } = rigged();
  try {
    // Control: the planted programs really do run when git is called bare.
    spawnSync("git", ["-C", repo, "status", "--porcelain"]);
    commit((args) => spawnSync("git", args).status, repo, "plain");
    expect(existsSync(markers.fsmonitor)).toBe(true);
    expect(existsSync(markers.hook)).toBe(true);
    rmSync(markers.fsmonitor); rmSync(markers.hook);
    // The hub's calls go through the helper: same operations, no marker.
    expect(hubGitSync(["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).status).toBe(0);
    commit((args) => hubGitSync(args, { encoding: "utf8" }).status, repo, "hardened");
    expect(existsSync(markers.fsmonitor)).toBe(false);
    expect(existsSync(markers.hook)).toBe(false);
    // And through a real hub call site, the per-turn snapshot (its add/write-tree touch the index).
    writeFileSync(join(repo, "a.txt"), "one\n");
    const repo_ = repoOf(repo);
    expect(repo_).toBeDefined();
    expect(snapshot(repo_!)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(markers.fsmonitor)).toBe(false);
    expect(existsSync(markers.hook)).toBe(false);
  } finally {
    clean();
  }
});

test("no direct git spawn under src/ outside the helper and src/local/ (#281)", () => {
  const src = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  const direct = /\bspawn(?:Sync)?\(\s*(?:\[\s*)?["'`]git["'`]/;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== join(src, "local")) walk(p); // the sandboxed git tool runs inside the sandbox: a different path
      } else if (e.name.endsWith(".ts") && p !== join(src, "hub", "git.ts") && direct.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});
