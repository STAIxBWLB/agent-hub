import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDenied } from "../local/deny.ts";
import { childEnv } from "./child-process.ts";
import type { PeerId } from "./envelope.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "./git.ts";
import { grantablePath } from "./permission-mode.ts";
import { realPath } from "./project.ts";

/**
 * #1115: a hub-sandboxed peer (Pi, the local worker) cannot run `git worktree add` or commit, because its profile refuses `.git` writes that
 * matter (#270). The hub makes the task worktree for it at the fixed root `.worktrees/<peer>-<task>`, the peer edits files there, and the hub
 * stages, commits and pushes at `hub_task_done`. The sandbox profile is NOT changed. It already lets a sandboxed command write
 * `.git/worktrees/<name>/{HEAD,index}` and `.git/refs/heads` (#864 only closes config, hooks, commondir and packs), so this module never trusts
 * what the peer could have written there: the base commit is recorded at creation, and a hub commit needs the worktree still registered at
 * its path, HEAD still the task branch, and the branch tip still the recorded base (or the hub's own previous commit).
 */
const PEER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_PATHS = 512;
const GIT_TIMEOUT_MS = 30_000, PUSH_TIMEOUT_MS = 90_000, AVAILABLE_TTL_MS = 30_000;
/** Repository configuration that would make a hub git call run a program, read through a helper or reach another remote. The #845 host path refuses the same keys. */
const CONFIG_REFUSED = "^(include\\.path|includeif\\..*\\.path|extensions\\.partialclone|remote\\..*\\.promisor|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|core\\.(sshcommand|gitproxy)|remote\\.origin\\.(vcs|proxy|receivepack|push|mirror)|push\\.pushoption)$";

export const taskWorktreePath = (root: string, peer: PeerId, task: number): string => join(root, ".worktrees", `${peer}-${task}`);
export const taskWorktreeBranch = (peer: PeerId, task: number): string => `task/${task}-${peer}`;

export interface TaskWorktreeEntry { peer: string; task: number; path: string; branch: string; base: string; /** The hub's own last commit on the branch, once it made one. */ head?: string }
export type TaskWorktreeAvailability = { ok: true } | { ok: false; reason: string; next: string };
export type TaskWorktreeResult = { ok: true; path: string; branch: string; base: string; created: boolean } | { ok: false; reason: string };
export type TaskWorktreeCommit = { ok: true; commit: string; branch: string; pushed: boolean; note?: string } | { ok: false; reason: string; commit?: string };
export interface TaskWorktreeRemoval { removed: boolean; branchDeleted: boolean; kept?: string }

export interface TaskWorktreePort {
  /** Only a peer whose own sandbox cannot make the worktree is served by the hub; every other peer keeps making its own. */
  applies(peer: PeerId): boolean;
  available(): TaskWorktreeAvailability;
  create(input: { peer: PeerId; task: number }): TaskWorktreeResult;
  describe(peer: PeerId, task: number): Pick<TaskWorktreeEntry, "path" | "branch" | "base"> | undefined;
  commitAndPush(input: { peer: PeerId; task: number; title: string }): Promise<TaskWorktreeCommit>;
  remove(input: { peer: PeerId; task: number }): TaskWorktreeRemoval;
}

/**
 * Whether the hub may push for this project, from the GitHub repository it learned at startup (`expected`) and the URLs `origin` has now. `undefined` means the project has no GitHub
 * origin the hub trusts, so the hub commits and does not push; `false` means an origin that is not this project's repository (changed since startup), which refuses the push.
 */
export function originVerdict(expected: string | undefined, urls: string[], repositoryOf: (url: string) => string | undefined): boolean | undefined {
  if (!expected) return undefined;
  const wanted = expected.toLowerCase();
  return urls.length > 0 && urls.length <= 16 && urls.every(url => repositoryOf(url)?.toLowerCase() === wanted);
}

export interface TaskWorktreeOptions {
  /** The project root: the repository's top level, and the sandbox root of every hub-sandboxed peer. */
  root: string;
  /** Hub-owned record file, outside anything a peer's sandbox may write (`.agenthub` is refused to it, #270). */
  stateFile: string;
  applies: (peer: PeerId) => boolean;
  deny: () => string[];
  protectInstructions: () => boolean;
  /** `originVerdict`: true pushes, false refuses, undefined (or no callback) commits without pushing. */
  pushAllowed?: (urls: string[]) => boolean | undefined;
  now?: () => number;
  /** Test seam: runs after the staged change was validated and before the hub commits it, where a sandboxed peer could race the worktree's own index. */
  beforeCommit?: () => void;
}

interface Run { status: number | null; stdout: string; stderr: string }
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
/** Peer-written bytes never reach an error text whole: bounded and without control characters. */
const shown = (text: string, limit = 160): string => clean(text).slice(0, limit);

export class TaskWorktrees implements TaskWorktreePort {
  private readonly root: string;
  private chain: Promise<unknown> = Promise.resolve();
  private cached?: { at: number; value: TaskWorktreeAvailability };
  constructor(private readonly o: TaskWorktreeOptions) { this.root = realPath(o.root); }

  applies = (peer: PeerId): boolean => this.o.applies(peer);

  /** `extra` is merged after the isolation, which strips GIT_INDEX_FILE: only the hub's own private index passes through it. */
  private git(args: string[], cwd = this.root, timeout = GIT_TIMEOUT_MS, extra: Record<string, string> = {}): Run {
    const run = hubGitSync(["-C", cwd, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: { ...hubGitEnv(childEnv(), { repositoryIsolation: true }), ...extra } });
    return { status: run.error ? null : run.status, stdout: String(run.stdout ?? ""), stderr: String(run.stderr ?? "") };
  }
  private gitAsync(args: string[], cwd: string, timeoutMs: number, extra: Record<string, string> = {}): Promise<Run> {
    return new Promise(resolve => {
      const argv = hubGitArgv(["-C", cwd, "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args]);
      const child = spawn(argv[0]!, argv.slice(1), { env: { ...hubGitEnv(childEnv(), { repositoryIsolation: true }), ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let stdout = "", stderr = "", done = false;
      const finish = (status: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ status, stdout, stderr }); };
      const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } finish(null); }, timeoutMs);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { if (stdout.length < 8 * 1024 * 1024) stdout += chunk; });
      child.stderr.on("data", chunk => { if (stderr.length < 64 * 1024) stderr += chunk; });
      child.once("error", () => finish(null));
      child.once("close", code => finish(code));
    });
  }

  private readRecords(): Record<string, TaskWorktreeEntry> {
    let text: string;
    try { text = readFileSync(this.o.stateFile, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("the task worktree record file is unreadable; the person can delete it after checking .worktrees");
    }
    try {
      const parsed = JSON.parse(text) as Record<string, TaskWorktreeEntry>;
      for (const entry of Object.values(parsed)) if (!PEER.test(entry.peer) || !Number.isSafeInteger(entry.task) || !SHA.test(entry.base) || (entry.head !== undefined && !SHA.test(entry.head))) throw new Error("bad record");
      return parsed;
    } catch { throw new Error("the task worktree record file is malformed; the person can delete it after checking .worktrees"); }
  }
  private writeRecords(records: Record<string, TaskWorktreeEntry>): void {
    mkdirSync(dirname(this.o.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.o.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
    renameSync(temporary, this.o.stateFile);
  }
  /**
   * Every record change reads the file fresh and writes it back in one synchronous step, so a change made while another call awaits git is never overwritten by an older
   * snapshot of the file (create, commit and remove all go through it).
   */
  private mutate<T>(change: (records: Record<string, TaskWorktreeEntry>) => T): T {
    const records = this.readRecords();
    const result = change(records);
    this.writeRecords(records);
    return result;
  }
  private key = (peer: PeerId, task: number) => `${peer}-${task}`;

  /**
   * Whether the REPOSITORY's own configuration lets the hub run git on it (F-worktree-config-scope). The guard is against configuration a repository or a peer can plant:
   * the shared `.git/config` (`--local`, which a linked worktree reads too) and, where `extensions.worktreeConfig` is on, the worktree's own `config.worktree`. The person's
   * global and system config is theirs and is left alone: git-lfs alone puts `filter.lfs.*` there on most machines, and refusing it would switch the feature off for them.
   * The hardened git helper's isolation still applies to that config.
   */
  private configProblem(cwd: string): string | undefined {
    const scopes: string[][] = [["--local"]];
    const extension = this.git(["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"], cwd);
    if (extension.status === 0 && extension.stdout.trim() === "true") scopes.push(["--worktree"]);
    for (const scope of scopes) {
      const found = this.git(["config", ...scope, "--get-regexp", CONFIG_REFUSED], cwd);
      if (found.status === 0 && found.stdout.trim()) return `the repository configuration names a helper, filter, include or remote override (${shown(found.stdout.split("\n")[0] ?? "", 60)}); the hub will not run git with it. Ask the person to remove it, or run this work with a peer that makes its own worktree`;
      if (found.status !== 0 && found.status !== 1) return "the repository configuration could not be read";
    }
    return undefined;
  }

  /** Whether the hub can make a worktree here: read-only, cached for 30 seconds, so a status read never waits on git twice. */
  available(): TaskWorktreeAvailability {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < AVAILABLE_TTL_MS) return this.cached.value;
    const value = this.probe();
    this.cached = { at: now, value };
    return value;
  }
  private probe(): TaskWorktreeAvailability {
    const no = (reason: string, next: string): TaskWorktreeAvailability => ({ ok: false, reason, next });
    const top = this.git(["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) return no("the project is not a git repository", "run `git init` there, or use a peer that does not need a worktree");
    let toplevel: string;
    try { toplevel = realPath(top.stdout.trim()); } catch { return no("the repository root could not be resolved", "check the project directory"); }
    if (toplevel !== this.root) return no("the project root is not the repository root", "start the hub in the repository's top directory");
    if (this.git(["rev-parse", "--is-bare-repository"]).stdout.trim() === "true") return no("the repository is bare", "use a non-bare checkout");
    if (!this.base()) return no("the repository has no commit to branch from", "make a first commit");
    try { const info = lstatSync(join(this.root, ".worktrees")); if (info.isSymbolicLink() || !info.isDirectory()) return no(".worktrees is not a plain directory", "replace it with a real directory"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return no(".worktrees could not be inspected", "check its permissions"); }
    const config = this.configProblem(this.root);
    return config ? no(config, "see the cause") : { ok: true };
  }
  /** `origin/HEAD` when the repository has one, else the main checkout's HEAD. No fetch: the hub's network calls stay with the push. */
  private base(): string | undefined {
    for (const ref of ["refs/remotes/origin/HEAD", "HEAD"]) {
      const out = this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      const sha = out.stdout.trim();
      if (out.status === 0 && SHA.test(sha)) return sha;
    }
    return undefined;
  }
  private tip(branch: string): string | undefined {
    const out = this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    return out.status === 0 && SHA.test(out.stdout.trim()) ? out.stdout.trim() : undefined;
  }

  describe(peer: PeerId, task: number): Pick<TaskWorktreeEntry, "path" | "branch" | "base"> | undefined {
    try { const entry = this.readRecords()[this.key(peer, task)]; return entry ? { path: entry.path, branch: entry.branch, base: entry.base } : undefined; } catch { return undefined; }
  }

  create(input: { peer: PeerId; task: number }): TaskWorktreeResult {
    const { peer, task } = input;
    const fail = (reason: string): TaskWorktreeResult => ({ ok: false, reason });
    if (!PEER.test(peer) || !Number.isSafeInteger(task) || task < 1) return fail("the peer or task id cannot name a worktree");
    let records: Record<string, TaskWorktreeEntry>;
    try { records = this.readRecords(); } catch (error) { return fail((error as Error).message); }
    const path = taskWorktreePath(this.root, peer, task), branch = taskWorktreeBranch(peer, task);
    const existing = records[this.key(peer, task)];
    if (existing) {
      // A repeated accept of the same task: the worktree is the one made before, never a second one.
      try { if (!lstatSync(existing.path).isDirectory()) throw new Error("not a directory"); } catch { return fail(`the recorded worktree ${existing.path} is missing; decline the task so the hub clears it, then accept it again`); }
      return { ok: true, path: existing.path, branch: existing.branch, base: existing.base, created: false };
    }
    this.cached = undefined;
    const avail = this.available();
    if (!avail.ok) return fail(`${avail.reason}; ${avail.next}`);
    if (this.tip(branch)) return fail(`the branch ${branch} already exists; delete it or decline the task so the person can clear it`);
    try { lstatSync(path); return fail(`${path} already exists; remove it or decline the task so the person can clear it`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(`${path} could not be inspected`); }
    const base = this.base();
    if (!base) return fail("the repository has no commit to branch from");
    try { mkdirSync(join(this.root, ".worktrees"), { recursive: true }); } catch { return fail(".worktrees could not be created; check the project directory permissions"); }
    const added = this.git(["worktree", "add", "--quiet", "-b", branch, path, base]);
    // The tree and branch are the hub's own, a moment old, with nothing a peer wrote: `--force` here only clears a half-made one.
    const undo = () => { this.git(["worktree", "remove", "--force", path]); this.git(["branch", "-D", branch]); this.git(["worktree", "prune"]); };
    if (added.status !== 0) { undo(); return fail(`git worktree add failed: ${shown(added.stderr)}`); }
    const head = this.git(["rev-parse", "HEAD"], path).stdout.trim(), symbolic = this.git(["symbolic-ref", "-q", "HEAD"], path).stdout.trim();
    if (head !== base || symbolic !== `refs/heads/${branch}` || this.tip(branch) !== base) { undo(); return fail("the new worktree did not come up on the expected base; nothing was kept"); }
    try { this.mutate(current => { current[this.key(peer, task)] = { peer, task, path, branch, base }; }); } catch { undo(); return fail("the worktree record could not be written; nothing was kept"); }
    return { ok: true, path, branch, base, created: true };
  }

  /** One hub commit at a time per worktree: a repeated or parallel `hub_task_done` queues behind the first. */
  commitAndPush(input: { peer: PeerId; task: number; title: string }): Promise<TaskWorktreeCommit> {
    const next = this.chain.then(() => this.commit(input), () => this.commit(input));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async commit(input: { peer: PeerId; task: number; title: string }): Promise<TaskWorktreeCommit> {
    const { peer, task } = input;
    const fail = (reason: string, commit?: string): TaskWorktreeCommit => ({ ok: false, reason, ...(commit ? { commit } : {}) });
    let records: Record<string, TaskWorktreeEntry>;
    try { records = this.readRecords(); } catch (error) { return fail((error as Error).message); }
    const entry = records[this.key(peer, task)];
    if (!entry) return fail("the hub made no worktree for this task");
    const { path, branch, base } = entry, expectedTip = entry.head ?? base;
    // 1. Registered at the fixed path, on the task branch, and the tip is where the hub left it. The peer can write HEAD and refs, so none of it is trusted unread.
    let real: string;
    try { real = realPath(path); } catch { return fail(`the worktree ${path} is missing; the hub cannot commit it. Decline the task so the hub clears it`); }
    if (real !== path) return fail(`the worktree path now resolves to ${shown(real)}, not ${path}; the hub will not commit it. Decline the task`);
    const listed = this.git(["worktree", "list", "--porcelain", "-z"]).stdout.split("\0\0").filter(Boolean).map(block => block.split("\0"));
    const mine = listed.find(fields => { const at = fields.find(f => f.startsWith("worktree "))?.slice(9); try { return !!at && realPath(at) === real; } catch { return false; } });
    if (!mine || mine.some(f => f === "prunable" || f.startsWith("prunable "))) return fail("the worktree is no longer registered with git; the hub will not commit it. Decline the task so the hub clears it");
    if (mine.find(f => f.startsWith("branch "))?.slice(7) !== `refs/heads/${branch}`) return fail(`the worktree is no longer on ${branch} (HEAD was changed); the hub will not commit it. Decline the task so the hub clears it`);
    if (this.git(["symbolic-ref", "-q", "HEAD"], path).stdout.trim() !== `refs/heads/${branch}`) return fail(`HEAD of the worktree is not ${branch}; the hub will not commit it. Decline the task so the hub clears it`);
    const tip = this.tip(branch);
    if (tip !== expectedTip) return fail(`${branch} is at ${tip?.slice(0, 12) ?? "nothing"}, not at the commit the hub recorded (${expectedTip.slice(0, 12)}); the peer must not move the branch. The hub will not commit or push it. Decline the task so the hub clears it`);
    const problem = this.configProblem(path);
    if (problem) return fail(problem);
    // 2. The peer can write the worktree's own index (#864), so the hub never reads it: it builds a PRIVATE index in its state dir (outside every sandbox root) from the recorded tip,
    // adds the working tree to that, hashes it with write-tree, and validates and commits that exact tree. Swapping the worktree's index after the check cannot change what is committed.
    const index = join(dirname(this.o.stateFile), `task-index-${randomUUID()}`), own = { GIT_INDEX_FILE: index };
    try {
      if (this.git(["read-tree", expectedTip], path, GIT_TIMEOUT_MS, own).status !== 0) return fail("the hub's private index could not be built from the recorded commit");
      const added = await this.gitAsync(["add", "-A", "--", "."], path, GIT_TIMEOUT_MS, own);
      if (added.status !== 0) return fail(`staging the worktree failed: ${shown(added.stderr)}`);
      const written = this.git(["write-tree"], path, GIT_TIMEOUT_MS, own), tree = written.stdout.trim();
      if (written.status !== 0 || !SHA.test(tree)) return fail("the staged tree could not be written");
      const raw = this.git(["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", expectedTip, tree], path);
      if (raw.status !== 0) return fail("the staged change could not be listed");
      const parts = raw.stdout.split("\0").filter(Boolean), changed: { mode: string; path: string }[] = [];
      for (let i = 0; i + 1 < parts.length; i += 2) { const meta = /^:(\d{6}) (\d{6}) /.exec(parts[i]!); if (!meta) return fail("the staged change has an unreadable entry"); changed.push({ mode: meta[2]!, path: parts[i + 1]! }); }
      // Nothing new since the hub's own commit: this is a retry after a failed push, so push the commit it already made.
      if (!changed.length && entry.head) return this.push(path, branch, entry.head, peer);
      if (!changed.length) return fail(`no changes under ${path}: edit files there, then call hub_task_done again`);
      if (changed.length > MAX_PATHS) return fail(`${changed.length} paths changed, more than the ${MAX_PATHS} the hub commits for a sandboxed peer; split the work into smaller tasks`);
      // 3. The same path policy a person's grant uses: the denylist, the agent and hub write names, and (when the policy is on) the instruction files.
      const deny = this.o.deny(), protect = this.o.protectInstructions();
      const refused = changed.filter(c => c.mode === "160000" || isDenied(c.path, deny) || !grantablePath(path, join(path, c.path), c.path, protect));
      if (refused.length) return fail(`the hub will not commit ${refused.length} changed path${refused.length === 1 ? "" : "s"} (${refused.slice(0, 3).map(c => shown(c.path, 60)).join(", ")}): a secret, a git or hub or agent configuration name, a protected instruction file or a submodule. Revert ${refused.length === 1 ? "it" : "them"} in the worktree and call hub_task_done again`);
      this.o.beforeCommit?.();
      // 4. The commit object is made from the validated tree by the hub (no hook, no signing, no index read), and the branch moves to it only if it still sits at the recorded tip.
      const title = shown(input.title, 200) || `task ${task}`;
      const made = this.git(["-c", `user.name=${peer}`, "-c", `user.email=${peer}@agent-hub.invalid`, "-c", "commit.gpgSign=false", "commit-tree", tree, "-p", expectedTip, "-m", title, "-m", `Task #${task} by ${peer}. Committed by the hub for a sandboxed peer.`], path), commit = made.stdout.trim();
      if (made.status !== 0 || !SHA.test(commit)) return fail(`git commit-tree failed: ${shown(made.stderr)}`);
      if (this.git(["update-ref", `refs/heads/${branch}`, commit, expectedTip], path).status !== 0) return fail(`${branch} moved while the hub was committing; nothing was kept. Decline the task so the hub clears it`);
      if (this.tip(branch) !== commit || this.git(["rev-parse", `${commit}^{tree}`], path).stdout.trim() !== tree) return fail("the commit did not land on the task branch as expected; the hub will not push it");
      // The worktree's own index (peer-writable) is brought in line with the new HEAD, and refreshed (read-tree leaves no stat data, so diff-index would call every file modified), so `git status`
      // there is clean and `remove` can tell finished work from uncommitted work. Nothing is ever committed from it.
      this.git(["read-tree", commit], path); this.git(["update-index", "-q", "--refresh"], path);
      try { this.mutate(current => { current[this.key(peer, task)] = { ...(current[this.key(peer, task)] ?? entry), head: commit }; }); } catch { return fail("the commit was made but the hub could not record it; call hub_task_done again", commit); }
      return this.push(path, branch, commit, peer);
    } finally { rmSync(index, { force: true }); }
  }

  /** 5. One explicit refspec for this branch, only to an origin that is this project's repository. */
  private async push(path: string, branch: string, commit: string, _peer: PeerId): Promise<TaskWorktreeCommit> {
    const fail = (reason: string, sha?: string): TaskWorktreeCommit => ({ ok: false, reason, ...(sha ? { commit: sha } : {}) });
    if (this.tip(branch) !== commit) return fail(`${branch} no longer points at the hub's commit ${commit.slice(0, 12)}; the hub will not push it. Decline the task so the hub clears it`);
    const urls = [...this.git(["remote", "get-url", "--push", "--all", "origin"], path).stdout.trim().split("\n"), ...this.git(["remote", "get-url", "--all", "origin"], path).stdout.trim().split("\n")].filter(Boolean);
    const verdict = this.o.pushAllowed?.(urls);
    // No GitHub origin was configured when the hub started (a local repository, or another host): the commit is the result, and `hub_task_done` carries it without a push.
    // An origin that is not this project's repository (changed since startup, or two URLs that disagree) is refused with the commit kept.
    if (verdict === undefined) return { ok: true, commit, branch, pushed: false, note: "the project has no GitHub origin the hub trusts, so the branch was committed but not pushed" };
    if (verdict !== true) return fail(`committed ${commit.slice(0, 12)} on ${branch} but origin is not this project's repository, so nothing was pushed; ask the person to check the origin URL, then call hub_task_done again`, commit);
    const pushed = await this.gitAsync(["-c", "push.followTags=false", "-c", "remote.origin.mirror=false", "-c", "push.recurseSubmodules=no", "-c", "push.gpgSign=false", "push", "--no-verify", "origin", `refs/heads/${branch}:refs/heads/${branch}`], path, PUSH_TIMEOUT_MS);
    if (pushed.status !== 0) return fail(`committed ${commit.slice(0, 12)} on ${branch} but the push failed (${shown(pushed.stderr, 120) || "no output"}); the commit is kept, call hub_task_done again to retry the push`, commit);
    return { ok: true, commit, branch, pushed: true };
  }

  /**
   * Decline, cancel or a failed accept: remove the worktree and delete the branch, so no empty ref stays. A worktree with uncommitted work is
   * reported and kept, never force-removed, and a branch the hub committed to is kept (its commit may be pushed and under review).
   */
  remove(input: { peer: PeerId; task: number }): TaskWorktreeRemoval {
    const { peer, task } = input;
    let records: Record<string, TaskWorktreeEntry>;
    try { records = this.readRecords(); } catch (error) { return { removed: false, branchDeleted: false, kept: (error as Error).message }; }
    const entry = records[this.key(peer, task)];
    if (!entry) return { removed: false, branchDeleted: false };
    const { path, branch, base } = entry;
    let present = true;
    try { lstatSync(path); } catch { present = false; }
    if (present) {
      const untracked = this.git(["ls-files", "--others", "--exclude-standard", "-z"], path);
      const changed = this.git(["diff-index", "--quiet", "--no-ext-diff", "--no-textconv", entry.head ?? base], path);
      const staged = this.git(["diff-index", "--cached", "--quiet", "--no-ext-diff", "--no-textconv", entry.head ?? base], path);
      if (untracked.status !== 0 || untracked.stdout.length || changed.status !== 0 || staged.status !== 0) {
        return { removed: false, branchDeleted: false, kept: `${path} has uncommitted changes or could not be checked, so it was kept with branch ${branch}; the person can review it, then run \`git worktree remove\` there` };
      }
      const gone = this.git(["worktree", "remove", path]);
      if (gone.status !== 0) return { removed: false, branchDeleted: false, kept: `${path} could not be removed (${shown(gone.stderr, 100)}); it was kept with branch ${branch}` };
    } else this.git(["worktree", "prune"]);
    let branchDeleted = false;
    const tip = this.tip(branch);
    if (tip === undefined) branchDeleted = true;
    else if (tip === base && entry.head === undefined) branchDeleted = this.git(["branch", "-D", branch]).status === 0;
    try { this.mutate(current => { delete current[this.key(peer, task)]; }); } catch { return { removed: true, branchDeleted, kept: "the worktree record could not be updated" }; }
    return { removed: true, branchDeleted, ...(branchDeleted ? {} : { kept: `branch ${branch} has the hub's commit and was kept` }) };
  }
}
