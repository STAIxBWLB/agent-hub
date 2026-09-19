import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { denyRegexes } from "./deny.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const OUTPUT_CAP = 20_000;

export const sandboxAvailable = () => process.platform === "darwin" && existsSync(SANDBOX_EXEC);

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Seatbelt profile for everything the local worker executes (bash, git). Path checks cannot scope a shell,
 * so the kernel does: writes only under cwd and temp, no reads of credential stores or denylisted files,
 * no network unless asked. In SBPL the last matching rule wins, so the denies come last.
 */
/** Toolchains and git identity: the only parts of the home directory a sandboxed command may read besides the project. */
const HOME_READABLE = [".bun", ".cargo", ".rustup", ".local", ".npm", ".cache", ".pyenv", ".nvm", ".deno", "go", ".gitconfig", ".config/git", "Library/Caches"];

/** A submodule or worktree keeps its git dir outside the project; git needs it, minus the parts that execute or reconfigure. */
function externalGitDirs(root: string): string[] {
  const out = spawnSync("git", ["-C", root, "rev-parse", "--absolute-git-dir", "--git-common-dir"], { encoding: "utf8" });
  if (out.status !== 0) return [];
  const dirs = out.stdout.trim().split("\n").map((d) => resolve(root, d));
  return [...new Set(dirs)].filter((d) => !d.startsWith(`${root}/`));
}

export function profile(cwd: string, network: boolean, readAllow: string[] = [], deny: string[] = []): string {
  const home = homedir();
  const inHome = (p: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const root = realpathSync(cwd);
  const tmp = realpathSync(tmpdir());
  const gitDirs = externalGitDirs(root);
  const creds = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".kube", ".docker", ".netrc", ".npmrc", ".omniroute", ".claude", ".codex", ".kimi-code", "Library/Keychains"];
  return [
    "(version 1)",
    "(allow default)",
    ...(network ? [] : ["(deny network*)"]),
    // Home is default-deny for reads: whatever a command reads can end up in the model's answer, and that answer
    // is shared with agents that run on cloud subscriptions (~/.claude.json, app tokens, browser profiles ...).
    `(deny file-read* (subpath ${q(home)}))`,
    `(allow file-read-metadata (subpath ${q(home)}))`,
    `(allow file-read* (subpath ${q(root)}) ${[...HOME_READABLE.map((p) => join(home, p)), ...readAllow.map(inHome), ...gitDirs].map((p) => `(subpath ${q(p)})`).join(" ")})`,
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(root)}) (subpath ${q(tmp)}) (subpath "/private/tmp") (regex #"^/dev/") ${gitDirs.map((d) => `(subpath ${q(d)})`).join(" ")})`,
    // Inside cwd: nothing that runs later outside the sandbox, nothing that reconfigures the hub.
    `(deny file-write* (subpath ${q(join(root, ".agenthub"))}) ${[join(root, ".git"), ...gitDirs].map((d) => `(subpath ${q(join(d, "hooks"))}) (literal ${q(join(d, "config"))})`).join(" ")})`,
    `(deny file-read* file-write* ${creds.map((c) => `(subpath ${q(join(home, c))})`).join(" ")})`,
    `(deny file-read* file-write* ${denyRegexes(root, deny).join(" ")})`,
  ].join("\n");
}

export interface ExecResult {
  code: number | null;
  output: string;
}

/** Run argv under seatbelt with a scrubbed environment. Never runs unsandboxed: no sandbox, no exec. */
export function sandboxedExec(argv: string[], opts: { cwd: string; profile: string; timeoutMs?: number }): Promise<ExecResult> {
  if (!sandboxAvailable()) return Promise.resolve({ code: null, output: "error: command execution needs macOS sandbox-exec and is disabled on this host" });
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: "dumb", TMPDIR: tmpdir() };
    // Own process group: a timeout has to take the grandchildren too, or they keep the pipes open and the project writable.
    const child = spawn(SANDBOX_EXEC, ["-p", opts.profile, ...argv], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const take = (d: Buffer) => {
      if (output.length < OUTPUT_CAP) output += d.toString();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(killGroup, opts.timeoutMs ?? 120_000);
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const clipped = output.length >= OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n(output truncated)` : output;
      resolve({ code, output: signal ? `${clipped}\n(killed: ${signal}, timeout?)` : clipped });
    };
    child.on("error", (e) => (done || ((done = true), resolve({ code: null, output: `error: ${e.message}` }))));
    child.on("close", finish);
    // `close` waits for every holder of the pipes; after `exit` give stragglers a moment, then stop waiting and reap them.
    child.on("exit", (code, signal) => setTimeout(() => (killGroup(), finish(code, signal)), 500).unref());
  });
}
