import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { stopOwnedProcess, trackGroup } from "./child-process.ts";
import { hostExecutable } from "./host-executable.ts";
import { hubGitArgv, hubGitEnv } from "./git.ts";
import { realPath } from "./project.ts";
import { isGitHubRepository } from "./spec-read.ts";
import { shortBranch } from "./task-shell-command.ts";

const OUTPUT_LIMIT = 64 * 1024;
function remoteHead(bytes: Buffer): string | undefined {
  const output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!output.endsWith("\n")) return;
  const lines = output.slice(0, -1).split("\n");
  if (lines.length !== 2) return;
  const symbolic = lines.filter(line => /^ref: refs\/heads\/.+\tHEAD$/.test(line));
  const oid = lines.filter(line => /^[0-9a-f]{40}\tHEAD$/.test(line));
  if (symbolic.length !== 1 || oid.length !== 1) return;
  const branch = symbolic[0]!.slice("ref: refs/heads/".length, -"\tHEAD".length);
  return shortBranch(branch) ? branch : undefined;
}

/** Startup authority comes from the fixed GitHub remote, never a mutable local origin/HEAD or repository config.
 * No task/native environment or account credentials are inherited. Unknown remote evidence keeps automatic execution unavailable. */
export async function readTaskShellDefaultBranch(root: string, env: Record<string, string>, current: () => boolean, projectRoot: string, repository?: string, timeoutMs = 5000): Promise<string | undefined> {
  let temporary: string | undefined, proc: ChildProcess | undefined;
  try {
    if (!isGitHubRepository(repository) || !current() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !env.PATH || env.PATH.length > 16384 || env.PATH.split(":").some(dir => !isAbsolute(dir) || dir.split("/").includes(".."))) return;
    root = realPath(root);
    const project = realPath(projectRoot), executable = hostExecutable("git", root, env.PATH), rel = relative(project, executable);
    if (!rel || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel) || !lstatSync(executable).isFile()) return;
    temporary = realPath(mkdtempSync(join(realPath("/tmp"), "ahub-default-"))); chmodSync(temporary, 0o700);
    const own = temporary, stat = lstatSync(own), identity = JSON.stringify([stat.dev, stat.ino, stat.mode]);
    const remove = () => {
      const held = lstatSync(own);
      if (!held.isDirectory() || realPath(own) !== own || JSON.stringify([held.dev, held.ino, held.mode]) !== identity) throw new Error("unavailable");
      rmSync(own, { recursive: true, force: true }); temporary = undefined;
    };
    const environment = hubGitEnv({ PATH: env.PATH, HOME: own, XDG_CONFIG_HOME: own, LANG: env.LANG ?? "C", TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: own }, { repositoryIsolation: true });
    const argv = hubGitArgv(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "ls-remote", "--symref", "--exit-code", `https://github.com/${repository}.git`, "HEAD"]);
    if (!current()) { remove(); return; }
    return await new Promise<string | undefined>(resolve => {
      let done = false, bytes = 0, overflowed = false;
      const output: Buffer[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined, watcher: ReturnType<typeof setInterval> | undefined;
      const finish = async (code: number | null) => {
        if (done) return; done = true; clearTimeout(timer); clearInterval(watcher);
        // Do not remove a private cwd/HOME while an owned group may still use it. The existing helper refuses unknown ownership.
        try { if (proc) await stopOwnedProcess(proc, { group: true }); remove(); }
        catch { resolve(undefined); return; }
        try { resolve(code === 0 && !overflowed && current() ? remoteHead(Buffer.concat(output)) : undefined); }
        catch { resolve(undefined); }
      };
      try { proc = spawn(executable, argv.slice(1), { cwd: own, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
      catch { void finish(null); return; }
      timer = setTimeout(() => void finish(null), timeoutMs);
      watcher = setInterval(() => { try { if (!current()) void finish(null); } catch { void finish(null); } }, 50); watcher.unref();
      proc.once("spawn", () => trackGroup(proc!));
      const take = (chunk: Buffer, stdout: boolean) => {
        if (done) return;
        bytes += chunk.length;
        if (bytes > OUTPUT_LIMIT) { overflowed = true; void finish(null); return; }
        if (stdout) output.push(Buffer.from(chunk));
      };
      proc.stdout!.on("data", (chunk: Buffer) => take(chunk, true));
      proc.stderr!.on("data", (chunk: Buffer) => take(chunk, false));
      proc.once("error", () => void finish(null));
      proc.once("exit", code => { if (code !== 0) void finish(null); });
      proc.once("close", code => void finish(code));
    });
  } catch {
    // A spawn/setup failure owns no live group; otherwise only confirmed stop above permits removing the private directory.
    if (!proc && temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch { /* unknown cleanup remains private */ } }
    return undefined;
  }
}
