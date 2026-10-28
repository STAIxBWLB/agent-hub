import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { validateSmokeTarget } from "../src/cli/smoke-target.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true }); });

function initGit(cwd: string): void {
  const template = join(cwd, ".empty-template");
  mkdirSync(template);
  const git = hubGitSync(["-C", cwd, "init", "--quiet", `--template=${template}`], { encoding: "utf8", timeout: 3000 });
  rmSync(template, { recursive: true, force: true });
  if (git.status !== 0) throw new Error("fixture git init failed");
}

function fixture(prefix = true) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), prefix ? "ahub-smoke-" : "ordinary-project-")));
  roots.push(cwd);
  const hubHome = join(cwd, ".smoke-home"), stateDir = join(cwd, ".state");
  mkdirSync(hubHome); mkdirSync(stateDir);
  initGit(cwd);
  const project = { id: "p_fixture", root: cwd, stateDir };
  const input = (overrides: Partial<{ cwd: string; hubHome: string; project: typeof project; expectedProjectId: string; liveTest: boolean }> = {}) => ({
    cwd, hubHome, project, expectedProjectId: "p_fixture", liveTest: true, ...overrides,
  });
  return { cwd, hubHome, stateDir, project, input };
}

function refuse(action: () => unknown): void {
  expect(action).toThrow("smoke target refused");
}

test("accepts only a registered live-test project in its own fresh temp checkout", () => {
  const f = fixture();
  const target = validateSmokeTarget(f.input());
  expect(target).toMatchObject({ cwd: f.cwd, hubHome: f.hubHome, stateDir: f.stateDir, projectId: f.project.id });
  expect(target.check()).toBeUndefined();
});

test("refuses disabled live testing, project id mismatch, ordinary roots, and paths outside the checkout", () => {
  const f = fixture();
  refuse(() => validateSmokeTarget(f.input({ liveTest: false })));
  refuse(() => validateSmokeTarget(f.input({ expectedProjectId: "p_other" })));
  refuse(() => validateSmokeTarget(f.input({ project: { ...f.project, id: "p_other" } })));
  refuse(() => validateSmokeTarget(f.input({ project: { ...f.project, stateDir: join(tmpdir(), "foreign-state") } })));
  refuse(() => validateSmokeTarget({ ...f.input(), hubHome: join(tmpdir(), "foreign-home") }));

  const ordinary = fixture(false);
  refuse(() => validateSmokeTarget(ordinary.input()));
});

test("refuses missing home or state directories and a linked-worktree .git file", () => {
  const f = fixture();
  rmSync(f.hubHome, { recursive: true, force: true });
  refuse(() => validateSmokeTarget(f.input()));
  mkdirSync(f.hubHome);
  rmSync(f.stateDir, { recursive: true, force: true });
  refuse(() => validateSmokeTarget(f.input()));

  const worktree = fixture();
  rmSync(join(worktree.cwd, ".git"), { recursive: true, force: true });
  writeFileSync(join(worktree.cwd, ".git"), "gitdir: /tmp/shared-worktree\n");
  refuse(() => validateSmokeTarget(worktree.input()));
});

test("refuses symlinked checkout, home, state, or git paths", () => {
  const cwdLinkFixture = fixture();
  const cwdAlias = join(realPath(tmpdir()), `ahub-smoke-alias-${process.pid}`);
  symlinkSync(cwdLinkFixture.cwd, cwdAlias, "dir");
  roots.push(cwdAlias);
  refuse(() => validateSmokeTarget(cwdLinkFixture.input({ cwd: cwdAlias })));

  const homeLinkFixture = fixture();
  const realHome = join(homeLinkFixture.cwd, "real-home"); mkdirSync(realHome);
  rmSync(homeLinkFixture.hubHome, { recursive: true }); symlinkSync(realHome, homeLinkFixture.hubHome, "dir");
  refuse(() => validateSmokeTarget(homeLinkFixture.input()));

  const stateLinkFixture = fixture();
  const realState = join(stateLinkFixture.cwd, "real-state"); mkdirSync(realState);
  rmSync(stateLinkFixture.stateDir, { recursive: true }); symlinkSync(realState, stateLinkFixture.stateDir, "dir");
  refuse(() => validateSmokeTarget(stateLinkFixture.input()));

  const gitLinkFixture = fixture();
  const realGit = join(gitLinkFixture.cwd, "real-git"); renameSync(join(gitLinkFixture.cwd, ".git"), realGit);
  symlinkSync(realGit, join(gitLinkFixture.cwd, ".git"), "dir");
  refuse(() => validateSmokeTarget(gitLinkFixture.input()));
});

test("check refuses replacement of the validated root, git, home, or state directory", () => {
  for (const replaced of ["root", "git", "home", "state"] as const) {
    const f = fixture(), target = validateSmokeTarget(f.input());
    const swap = (path: string) => {
      const old = `${path}.old`;
      renameSync(path, old); mkdirSync(path);
    };
    if (replaced === "root") {
      const moved = `${f.cwd}.old`;
      roots.push(moved);
      renameSync(f.cwd, moved); mkdirSync(f.cwd);
      mkdirSync(f.hubHome); mkdirSync(f.stateDir);
      initGit(f.cwd);
    } else if (replaced === "git") {
      const old = join(f.cwd, ".git.old"); renameSync(join(f.cwd, ".git"), old);
      initGit(f.cwd);
    } else if (replaced === "home") swap(f.hubHome);
    else swap(f.stateDir);
    refuse(() => target.check());
  }
});
