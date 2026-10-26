import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { guardPath } from "../local/tools.ts";
import { hostExecutable } from "./host-executable.ts";
import { hubGitArgv, hubGitEnv } from "./git.ts";
import { grantablePath } from "./permission-mode.ts";
import { realPath } from "./project.ts";
import { taskShellBindingValid, taskShellCommand, type TaskShellBinding, type TaskShellCommand } from "./task-shell-command.ts";

const within = (root: string, path: string) => { const rel = relative(root, path); return !rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
const stamp = (path: string) => { const s = lstatSync(path, { throwIfNoEntry: false }); return s ? [path, s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs] : [path, "missing"]; };

/** One bounded synchronous metadata read. No network, ambient repository selectors or repository helper execution.
 * ponytail: each reader's synchronous Git burst can block the hub for up to 1.5 seconds; move to asynchronous reads with one shared proof budget. */
function gitReader(root: string, env: Record<string, string>, current: () => boolean, projectRoot = root) {
  if (!env.PATH || env.PATH.length > 16384 || env.PATH.split(":").some(dir => !isAbsolute(dir) || dir.split("/").includes(".."))) throw new Error("unavailable");
  const executable = hostExecutable("git", root, env.PATH), deadline = performance.now() + 1500;
  if (within(realPath(projectRoot), executable)) throw new Error("unavailable");
  return (args: string[], absent = false): string => {
    const left = Math.floor(deadline - performance.now());
    if (!current() || left <= 0) throw new Error("unavailable");
    const result = spawnSync(executable, hubGitArgv(["-C", root, ...args]).slice(1), {
      cwd: root, env: hubGitEnv(env, { repositoryIsolation: true }), encoding: "utf8", timeout: left, maxBuffer: 64 * 1024,
    });
    if (!current() || result.error || result.status !== 0 && !(absent && result.status === 1)) throw new Error("unavailable");
    return result.stdout;
  };
}

/** Unknown default refs and detached HEAD never become a guessed task binding. */
export function readTaskShellBinding(root: string, env: Record<string, string>, current: () => boolean, projectRoot = root): TaskShellBinding | undefined {
  try {
    const git = gitReader(realPath(root), env, current, projectRoot);
    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).replace(/\n$/, "");
    const defaultRef = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).replace(/\n$/, "");
    if (!defaultRef.startsWith("refs/remotes/origin/")) return;
    if (!/^[0-9a-f]{40}\n$/.test(git(["rev-parse", "--verify", "--end-of-options", `${defaultRef}^{commit}`]))) return;
    const binding = { branch, defaultBranch: defaultRef.slice("refs/remotes/origin/".length) };
    return taskShellBindingValid(binding) && current() ? binding : undefined;
  } catch { return undefined; }
}

export interface TaskShellProofOptions {
  root: string; projectRoot: string; deny: string[]; readOnly?: string[]; protectInstructions: boolean;
  binding: TaskShellBinding; env: Record<string, string>; repository?: string;
  /** Host privacy screen for the captured PR body. Missing or unknown screening never grants a body-file upload. */
  publicText?: (text: string) => boolean;
}
export interface TaskShellProof {
  fingerprint: string; program: TaskShellCommand["program"]; executable: string; argv: readonly string[];
  env: Readonly<Record<string, string>>; requiresSandbox: boolean;
}

/** Capture only a bounded regular file; the privileged CLI receives these screened bytes, never a path it can reopen later. */
function bodyFileText(file: string): string {
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.size > 12000) throw new Error("unavailable");
  const before = stamp(file), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 12000 || JSON.stringify(before) !== JSON.stringify([file, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs])) throw new Error("unavailable");
    const bytes = Buffer.alloc(12001), count = readSync(fd, bytes, 0, bytes.length, 0), after = fstatSync(fd);
    if (count !== stat.size || JSON.stringify(stamp(file)) !== JSON.stringify(before)
      || [after.dev, after.ino, after.mode, after.size, after.mtimeMs, after.ctimeMs].some((value, index) => value !== [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs][index])) throw new Error("unavailable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    if (!text.trim() || text.length > 3000 || text.includes("\0")) throw new Error("unavailable");
    return text;
  } finally { closeSync(fd); }
}

/** Reuse the core's command-line hardening as environment config for Git children spawned internally by gh. */
function gitChildEnvironment(env: Record<string, string>): Record<string, string> {
  const result = Object.fromEntries(Object.entries(hubGitEnv(env, { repositoryIsolation: true })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const argv = hubGitArgv([]).slice(1), configs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--no-pager") continue;
    if (argv[index] !== "-c" || !argv[index + 1]?.includes("=")) throw new Error("unavailable");
    configs.push(argv[++index]!);
  }
  result.GIT_CONFIG_COUNT = String(configs.length);
  configs.forEach((config, index) => {
    const split = config.indexOf("=");
    result[`GIT_CONFIG_KEY_${index}`] = config.slice(0, split);
    result[`GIT_CONFIG_VALUE_${index}`] = config.slice(split + 1);
  });
  return result;
}

/** Host task-command proof only; read-only commands continue to use the existing #816 proof. */
export function proveTaskShell(command: unknown, options: TaskShellProofOptions, current: () => boolean): TaskShellProof | undefined {
  try {
    if (!current() || options.readOnly?.length) return;
    const form = taskShellCommand(command, options.binding);
    if (!form) return;
    const root = realPath(options.root), project = realPath(options.projectRoot), env = options.env;
    if (!env.PATH || env.PATH.length > 16384 || env.PATH.split(":").some(dir => !isAbsolute(dir) || dir.split("/").includes(".."))) return;
    const binding = readTaskShellBinding(root, env, current, project);
    if (!binding || binding.branch !== options.binding.branch || binding.defaultBranch !== options.binding.defaultBranch) return;
    const paths = new Set<string>();
    const path = (value: string, writing = false) => {
      const target = guardPath({ cwd: root, deny: options.deny, readOnly: options.readOnly }, value, "read");
      if (writing && !grantablePath(root, target, value, options.protectInstructions)) throw new Error("unavailable");
      paths.add(resolve(root, value)); paths.add(target); return target;
    };
    for (const value of form.paths) path(value, form.kind === "add");
    const executable = form.program === "scripts/check.sh" ? path("scripts/check.sh") : hostExecutable(form.program, root, env.PATH);
    if (form.program !== "scripts/check.sh" && within(project, executable)) return;
    accessSync(executable, constants.X_OK);
    if (!lstatSync(executable).isFile()) return;
    paths.add(executable);
    let argv = [...form.argv.slice(1)], repository: string | undefined;
    let effectiveEnv: Record<string, string> = { ...env };
    let bodyFileIndex = -1;
    if (form.kind === "pr-create") for (let index = 3; index < form.argv.length; index += 2) {
      if (form.argv[index] === "--body-file") bodyFileIndex = index - 1; // Effective argv excludes the program.
    }
    if (bodyFileIndex >= 0) {
      if (!options.publicText) return;
      const body = bodyFileText(path(argv[bodyFileIndex + 1]!));
      if (options.publicText(body) !== true) return;
      argv.splice(bodyFileIndex, 2, "--body", body);
    }
    if (form.program === "git" || form.program === "gh") {
      const git = gitReader(root, env, current, project);
      if (form.kind === "add") {
        const selected = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...form.paths]).split("\0").filter(Boolean);
        if (selected.length > 256) return;
        for (const value of selected) path(value, true);
      }
      if (form.kind === "commit") {
        const staged = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
        if (staged.length > 256) return;
        for (const value of staged) path(value, true);
      }
      if (form.kind === "push" || form.program === "gh") {
        const expected = options.repository?.toLowerCase();
        if (!expected || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected)) return;
        const urls = [...git(["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n"), ...git(["remote", "get-url", "--all", "origin"]).trim().split("\n")];
        if (!urls.length || urls.length > 16 || urls.some(url => {
          const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
          return match?.[1]?.toLowerCase() !== expected;
        })) return;
        // No remote-selected helper or implicit extra push effect is part of the closed command shape.
        if (git(["config", "--get-regexp", "^(core\\.(sshcommand|gitproxy)|remote\\.origin\\.(vcs|proxy|receivepack|push|mirror)|push\\.pushoption)$"], true).trim()) return;
        repository = expected;
      }
      if (form.kind === "push") argv[argv.length - 1] = `refs/heads/${binding.branch}:refs/heads/${binding.branch}`;
      if (form.program === "git") {
        effectiveEnv = Object.fromEntries(Object.entries(hubGitEnv(env, { repositoryIsolation: true })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        argv = hubGitArgv([
          ...(form.kind === "push" ? ["-c", "push.followTags=false", "-c", "remote.origin.mirror=false", "-c", "push.recurseSubmodules=no"] : []), ...argv,
        ]).slice(1);
      } else {
        effectiveEnv = gitChildEnvironment(env);
        argv.push("--repo", `https://github.com/${repository}`);
      }
    }
    const requiresSandbox = form.kind !== "push" && form.program !== "gh";
    const rootStat = lstatSync(root);
    const fingerprint = createHash("sha256").update(JSON.stringify([root, rootStat.dev, rootStat.ino, binding, effectiveEnv, executable, argv, repository, requiresSandbox, [...paths].map(stamp)])).digest("hex");
    return current() ? { fingerprint, program: form.program, executable, argv: Object.freeze(argv), env: Object.freeze(effectiveEnv), requiresSandbox } : undefined;
  } catch { return undefined; }
}
