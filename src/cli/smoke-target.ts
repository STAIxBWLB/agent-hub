import { lstatSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Project } from "../hub/registry.ts";
import { hubGitSync } from "../hub/git.ts";
import { realPath } from "../hub/project.ts";

const REFUSAL = "smoke target refused";

export interface SmokeTarget {
  cwd: string;
  hubHome: string;
  stateDir: string;
  projectId: string;
  check(): void;
}

type Identity = { dev: number; ino: number };
type Snapshot = { cwd: string; hubHome: string; stateDir: string; projectId: string; identities: { cwd: Identity; git: Identity; home: Identity; state: Identity } };

function refuse(): never { throw new Error(REFUSAL); }

function realDirectory(path: string): { path: string; stat: Stats } {
  if (!isAbsolute(path)) refuse();
  assertNoSymlink(path);
  const canonical = realPath(path);
  const stat = lstatSync(canonical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse();
  return { path: canonical, stat };
}

/** Check the caller's spelling too: resolving a symlink before the check would hide a redirected path. */
function assertNoSymlink(path: string): void {
  if (path.split(sep).includes("..")) refuse();
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) refuse();
  }
  if (lstatSync(root).isSymbolicLink()) refuse();
}

function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function identity(stat: Stats): Identity { return { dev: stat.dev, ino: stat.ino }; }
function sameIdentity(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino; }

function gitPath(cwd: string, args: string[]): string {
  const result = hubGitSync(["-C", cwd, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) refuse();
  const path = result.stdout.trim();
  if (!path) refuse();
  return realPath(path);
}

function inspect(input: {
  cwd: string;
  hubHome: string;
  project: Pick<Project, "id" | "root" | "stateDir">;
  expectedProjectId: string;
  liveTest: boolean;
}): Snapshot {
  if (input.liveTest !== true || !input.expectedProjectId || input.project.id !== input.expectedProjectId) refuse();

  const root = realDirectory(input.cwd);
  const registeredRoot = realDirectory(input.project.root);
  if (root.path !== registeredRoot.path) refuse();

  const tempRoot = realPath(tmpdir());
  const temp = realDirectory(tempRoot);
  if (dirname(root.path) !== temp.path || !basename(root.path).startsWith("ahub-smoke-") || root.path === temp.path) refuse();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && root.stat.uid !== uid) refuse();

  const gitDirPath = join(root.path, ".git");
  const gitDir = lstatSync(gitDirPath);
  if (gitDir.isSymbolicLink() || !gitDir.isDirectory()) refuse();
  if (gitPath(root.path, ["rev-parse", "--show-toplevel"]) !== root.path) refuse();
  if (gitPath(root.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== gitDirPath) refuse();

  // ponytail: first slice accepts an uncommitted, untracked scratch index only; a future explicit disposable manifest can admit fixture histories.
  for (const args of [["for-each-ref", "--count=1", "--format=%(refname)"], ["ls-files"], ["remote"]]) {
    const result = hubGitSync(["-C", root.path, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024 });
    if (result.status !== 0 || result.stdout.trim()) refuse();
  }

  const home = realDirectory(input.hubHome);
  const state = realDirectory(input.project.stateDir);
  if (!inside(root.path, home.path) || !inside(root.path, state.path)) refuse();

  return {
    cwd: root.path,
    hubHome: home.path,
    stateDir: state.path,
    projectId: input.project.id,
    identities: { cwd: identity(root.stat), git: identity(gitDir), home: identity(home.stat), state: identity(state.stat) },
  };
}

export function validateSmokeTarget(input: {
  cwd: string;
  hubHome: string;
  project: Pick<Project, "id" | "root" | "stateDir">;
  expectedProjectId: string;
  liveTest: boolean;
}): SmokeTarget {
  let original: Snapshot;
  try { original = inspect(input); } catch { return refuse(); }
  return {
    cwd: original.cwd,
    hubHome: original.hubHome,
    stateDir: original.stateDir,
    projectId: original.projectId,
    check() {
      try {
        const current = inspect(input);
        if (current.cwd !== original.cwd || current.hubHome !== original.hubHome || current.stateDir !== original.stateDir
          || current.projectId !== original.projectId || !sameIdentity(current.identities.cwd, original.identities.cwd)
          || !sameIdentity(current.identities.git, original.identities.git) || !sameIdentity(current.identities.home, original.identities.home)
          || !sameIdentity(current.identities.state, original.identities.state)) refuse();
      } catch { refuse(); }
    },
  };
}
