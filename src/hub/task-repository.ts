import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TaskPlan, TaskRefs } from "./board.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "./git.ts";
import { hostExecutable } from "./host-executable.ts";
import { canonicalPath, realPath } from "./project.ts";
import { isGitHubRepository } from "./spec-read.ts";

export interface TaskRepository { key: string; root?: string; aliases: string[]; }
const GIT_TIMEOUT_MS = 1000, GIT_MAX_BYTES = 16 * 1024, MAX_ANCESTORS = 64;
const beneath = (root: string, path: string) => { const rel = relative(root, path); return !rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
const canonical = (path: string) => { try { return realPath(path); } catch { try { return canonicalPath(path); } catch { return resolve(path); } } };
function slug(value: string): string | undefined {
  const raw = value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (isGitHubRepository(raw)) return raw.toLowerCase();
  const scp = /^(?:[^/@:]+@)?github\.com:(.+)$/i.exec(raw);
  if (scp && isGitHubRepository(scp[1])) return scp[1].toLowerCase();
  try {
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "github.com" || !["https:", "http:", "ssh:"].includes(url.protocol) || url.port && !(url.protocol === "ssh:" && url.port === "22")) return undefined;
    const name = url.pathname.replace(/^\//, "");
    return isGitHubRepository(name) ? name.toLowerCase() : undefined;
  } catch { return undefined; }
}

/** Share the advisory reader's bounds; only authority reads pin Git and isolate the actual checkout. */
function boundedGit(dir: string, args: string[], isolated = false): string | undefined {
  try {
    const options = { encoding: "utf8" as const, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BYTES };
    const argv = ["-C", dir, ...args];
    const found = isolated
      ? spawnSync(hostExecutable("git", dir), hubGitArgv(argv).slice(1), { ...options, cwd: dir, env: hubGitEnv(process.env, { repositoryIsolation: true }) })
      : hubGitSync(argv, options);
    return found.status === 0 && typeof found.stdout === "string" && found.stdout.trim() ? isolated ? found.stdout : found.stdout.trim() : undefined;
  } catch { return undefined; } // Unknown identity never grants; never log remote URLs or stderr.
}

/** The project-local GitHub repository a remote URL names, or undefined: only GitHub https, http or ssh URLs and scp forms, no query, no fragment, no whitespace. */
export function githubRemoteRepository(remote: string): string | undefined {
  if (!remote || /[\s?#]/.test(remote)) return undefined;
  const scp = /^(?:[^/@:]+@)?github\.com:[^/]+\/[^/]+\/?$/i.test(remote);
  if (!scp) {
    if (!/^(?:https?|ssh):\/\/(?:[^/@]+@)?github\.com(?::[0-9]+)?\//i.test(remote)) return undefined;
    try { const url = new URL(remote); if (url.search || url.hash) return undefined; } catch { return undefined; }
  }
  return slug(remote);
}

/** Actual project-local GitHub origin only, never task refs, a bare slug or global-config fallback. */
export function githubOriginRepository(cwd: string): string | undefined {
  let root: string;
  try { root = realPath(cwd); } catch { return undefined; }
  const reply = boundedGit(root, ["config", "--show-scope", "--get", "remote.origin.url"], true);
  const remote = reply && /^(?:local|worktree)\t([^\r\n]+)\n$/.exec(reply)?.[1];
  return remote ? githubRemoteRepository(remote) : undefined;
}

/** Repository metadata is advisory, never an execution root or a grant. Git reads are bounded, local and cached. */
export class TaskRepositories {
  readonly project: TaskRepository;
  private readonly scopes = new Map<string, TaskRepository>();
  private readonly directories = new Map<string, TaskRepository>();
  private readonly roots = new Map<string, TaskRepository>();
  private readonly paths = new Map<string, string>();
  private projectNamed: boolean;
  constructor(private readonly cwd: string, repository?: string) {
    const root = canonical(cwd), named = repository && slug(repository);
    this.projectNamed = !!named;
    this.project = { key: named ? `repo:${named}` : `path:${root}`, root, aliases: [...new Set([resolve(cwd), root])] };
    this.roots.set(root, this.project);
  }
  private git(dir: string, args: string[]): string | undefined {
    return boundedGit(dir, args);
  }
  private directory(path: string): string {
    let cursor = resolve(path);
    for (let count = 0; count < MAX_ANCESTORS; count++) {
      try { if (statSync(cursor).isDirectory()) return canonical(cursor); } catch { /* Try the next ancestor, never scan a directory. */ }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return canonical(dirname(path));
  }
  private at(path: string): TaskRepository {
    const directory = this.directory(path), cached = this.directories.get(directory);
    if (cached) return cached;
    const top = this.git(directory, ["rev-parse", "--show-toplevel"]);
    const root = top ? canonical(top) : directory;
    let scope = this.roots.get(root);
    if (!scope) {
      const remote = top && this.git(root, ["config", "--get", "remote.origin.url"]);
      const named = remote && slug(remote);
      scope = { key: named ? `repo:${named}` : `path:${root}`, root, aliases: [root] };
      this.roots.set(root, scope);
    }
    this.directories.set(directory, scope);
    return scope;
  }
  private common(paths: string[]): TaskRepository {
    let root = this.directory(paths[0]!);
    for (const path of paths.slice(1)) {
      const dir = this.directory(path);
      while (!beneath(root, dir)) { const parent = dirname(root); if (parent === root) break; root = parent; }
    }
    return this.roots.get(root) ?? { key: `path:${root}`, root, aliases: [root] };
  }
  /** Resolve only once per refs identity. Default project-only tasks never invoke Git. Negative probes are cached too. */
  scope(refs: TaskRefs): TaskRepository {
    const absolute = (refs.paths ?? []).filter(isAbsolute);
    const fingerprint = JSON.stringify([refs.repo ?? null, absolute]);
    const prior = this.scopes.get(fingerprint); if (prior) return prior;
    const outside = absolute.length > 0 && absolute.every(path => !beneath(this.project.root!, canonical(path)));
    let scope = this.project;
    if (refs.repo) {
      const named = slug(refs.repo);
      if (named) {
        // A retained project may not have a host-supplied slug. Probe only when an explicit slug needs that alias.
        if (!this.projectNamed) {
          const remote = this.git(this.project.root!, ["config", "--get", "remote.origin.url"]);
          const projectSlug = remote && slug(remote);
          if (projectSlug) this.project.key = `repo:${projectSlug}`;
          this.projectNamed = true;
        }
        const key = `repo:${named}`;
        for (const path of absolute) this.at(path);
        const matching = [...this.roots.values()].filter(repo => repo.key === key);
        scope = matching.length ? { key, root: matching[0]!.root, aliases: [...new Set(matching.flatMap(repo => repo.aliases))] } : { key, aliases: [] };
      } else scope = this.at(resolve(this.cwd, refs.repo));
    } else if (outside) {
      const found = absolute.map(path => this.at(path));
      scope = found.every(repo => repo.key === found[0]!.key)
        ? { key: found[0]!.key, root: found[0]!.root, aliases: [...new Set(found.flatMap(repo => repo.aliases))] }
        : this.common(absolute);
    }
    this.scopes.set(fingerprint, scope);
    return scope;
  }
  /** External absolute spellings are normalized once, not by probing files on every overlap read. */
  relativePath(scope: TaskRepository, path: string): string {
    if (!isAbsolute(path)) return path;
    const initialKey = JSON.stringify([scope.root, scope.aliases, path]);
    const prior = this.paths.get(initialKey); if (prior !== undefined) return prior;
    // Absolute plan evidence may be the first local checkout known for an explicit slug.
    if (!scope.root || !scope.aliases.some(alias => beneath(alias, path))) {
      const actual = this.at(path);
      if (actual.key === scope.key) {
        scope.root ??= actual.root;
        scope.aliases = [...new Set([...scope.aliases, ...actual.aliases])];
      }
    }
    if (!scope.root) { this.paths.set(initialKey, path); return path; }
    const key = JSON.stringify([scope.root, scope.aliases, path]), cached = this.paths.get(key); if (cached !== undefined) return cached;
    const physical = canonical(path);
    const root = scope.aliases.find(alias => beneath(alias, path)) ?? (beneath(scope.root, physical) ? scope.root : undefined);
    const value = root ? relative(root, beneath(root, path) ? path : physical) || "." : path;
    this.paths.set(key, value);
    this.paths.set(initialKey, value);
    return value;
  }
  mismatch(refs: TaskRefs, plan?: TaskPlan): boolean {
    const scope = this.scope(refs);
    return [...(refs.paths ?? []), ...(plan?.paths ?? [])].filter(isAbsolute).some(path => {
      const actual = beneath(this.project.root!, canonical(path)) ? this.project : this.at(path);
      return actual.key !== scope.key;
    });
  }
}
