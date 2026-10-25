import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubOriginRepository } from "../src/hub/task-repository.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-origin-authority-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => { const result = hubGitSync(args, { cwd: root, encoding: "utf8", timeout: 1000 }); expect(result.status).toBe(0); };
  git(["init", "-q"]);
  return { root, git };
}
function environment(values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  cleanup.push(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

test("host origin normalizes only actual GitHub remote URL forms", () => {
  const f = fixture();
  for (const remote of ["https://github.com/Owner/Repo.git", "git@github.com:OWNER/REPO.git", "ssh://git@github.com:22/Owner/Repo.git", "https://github.com/Owner/Repo/", "https://fixture:credential@github.com/Owner/Repo.git"]) {
    f.git(["config", "--local", "remote.origin.url", remote]);
    expect(githubOriginRepository(f.root)).toBe("owner/repo");
  }
});

test("missing, non-GitHub and ambiguous origins grant no repository", () => {
  const f = fixture(); expect(githubOriginRepository(f.root)).toBeUndefined();
  for (const remote of ["owner/repo", "../repo", "/tmp/repo", "https://gitlab.com/Owner/Repo.git", "https://github.com.evil.invalid/Owner/Repo.git", "https://github.com/Owner/Repo?query", "https://github.com/Owner/Repo#fragment", "https://github.com:444/Owner/Repo", " https://github.com/Owner/Repo.git"]) {
    f.git(["config", "--local", "remote.origin.url", remote]);
    expect(githubOriginRepository(f.root), remote).toBeUndefined();
  }
  expect(githubOriginRepository(join(f.root, "missing"))).toBeUndefined();
});

test("global origin configuration is not checkout authority", () => {
  const f = fixture(), global = join(f.root, "global-config");
  writeFileSync(global, "[remote \"origin\"]\nurl = https://github.com/forged/repo.git\n");
  environment({ GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" });
  expect(githubOriginRepository(f.root)).toBeUndefined();
});

test("ambient repository and command-scope selectors cannot mint a different origin", () => {
  const f = fixture(), other = fixture();
  f.git(["config", "--local", "remote.origin.url", "https://github.com/Owner/Repo.git"]);
  other.git(["config", "--local", "remote.origin.url", "https://github.com/forged/repo.git"]);
  environment({ GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.url", GIT_CONFIG_VALUE_0: "https://github.com/forged/repo.git", GIT_CONFIG_PARAMETERS: "'remote.origin.url=https://github.com/forged/repo.git'" });
  expect(githubOriginRepository(f.root)).toBe("owner/repo");
});

test("standalone GIT_CONFIG cannot turn a selected file into checkout authority", () => {
  const f = fixture(), selected = join(f.root, "selected-config");
  f.git(["config", "--local", "remote.origin.url", "https://github.com/Owner/Repo.git"]);
  writeFileSync(selected, "[remote \"origin\"]\nurl = https://github.com/forged/repo.git\n");
  environment({ GIT_CONFIG: selected });
  expect([undefined, "owner/repo"]).toContain(githubOriginRepository(f.root));
});

test("project PATH shims cannot forge host origin metadata", () => {
  const f = fixture(), bin = join(f.root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), "#!/bin/sh\nprintf 'local\thttps://github.com/forged/repo.git\n'\n", { mode: 0o755 });
  environment({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
  expect(githubOriginRepository(f.root)).toBeUndefined();
});

test("linked worktree origins use local and worktree configuration scopes", () => {
  const f = fixture(), worktree = `${f.root}-worktree`;
  cleanup.push(() => rmSync(worktree, { recursive: true, force: true }));
  f.git(["config", "--local", "remote.origin.url", "git@github.com:Owner/Repo.git"]);
  f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fixture"]);
  f.git(["worktree", "add", "--detach", worktree]);
  expect(githubOriginRepository(worktree)).toBe("owner/repo");
  f.git(["config", "extensions.worktreeConfig", "true"]);
  f.git(["-C", worktree, "config", "--worktree", "remote.origin.url", "https://github.com/Worktree/Repo.git"]);
  expect(githubOriginRepository(worktree)).toBe("worktree/repo");
});
