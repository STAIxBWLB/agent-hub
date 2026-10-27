import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as paths from "node:path";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { readTaskShellDefaultBranch } from "../src/hub/task-shell-default.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { readProcessTable, stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";
import { hostExecutable } from "../src/hub/host-executable.ts";
import { isGitHubRepository } from "../src/hub/spec-read.ts";
import { shortBranch } from "../src/hub/task-shell-command.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const receipt = `ref: refs/heads/release\tHEAD\n${"a".repeat(40)}\tHEAD\n`;
function fixture(output = receipt, code = 0, mode: "exit" | "wait" | "overflow" = "exit") {
  const project = realPath(mkdtempSync(join(tmpdir(), "ahub-default-project-"))), bin = realPath(mkdtempSync(join(tmpdir(), "ahub-default-host-")));
  cleanup.push(() => rmSync(project, { recursive: true, force: true }), () => rmSync(bin, { recursive: true, force: true }));
  const trace = join(bin, "trace.json"), executable = join(bin, "git");
  writeFileSync(executable, `#!${process.execPath}
import { writeFileSync, existsSync } from "node:fs";
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2),env:process.env,cwd:process.cwd(),git:existsSync(".git")}));
${mode === "wait" ? 'setInterval(()=>{},1000);' : mode === "overflow" ? 'process.stdout.write("x".repeat(65537));' : `process.stdout.write(${JSON.stringify(output)});process.exitCode=${code};`}
`, { mode: 0o700 });
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: project, LANG: "C", TERM: "fixture-term", FIXTURE_SECRET: "must-not-reach-child",
    GIT_DIR: project, GIT_EXEC_PATH: project, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.file:///fixture.insteadOf", GIT_CONFIG_VALUE_0: "https://github.com/",
    HTTPS_PROXY: "http://fixture.invalid", GH_TOKEN: "fixture-token", BUN_OPTIONS: "--preload /fixture-poison",
  };
  const probe = (current = () => true, repository: string | undefined = "fixture/repo", timeout = 1000) => readTaskShellDefaultBranch(project, env, current, project, repository, timeout);
  return { project, bin, trace, env, probe };
}

test("remote default probe uses the fixed remote release rather than a local origin main, in a private config-free environment", async () => {
  const f = fixture();
  // Set up genuine contradictory local metadata with the actual host Git before the fake is selected for the remote probe.
  for (const args of [["init", "-q"], ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], ["config", "url.file:///fixture.insteadOf", "https://github.com/"]]) {
    const result = hubGitSync(["-C", f.project, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: f.project }, timeout: 1000 });
    expect(result.status, result.stderr).toBe(0);
  }
  expect(await f.probe()).toBe("release");
  const call = JSON.parse(readFileSync(f.trace, "utf8")) as { pid: number; args: string[]; env: Record<string, string>; cwd: string; git: boolean };
  expect(call.args.slice(-5)).toEqual(["ls-remote", "--symref", "--exit-code", "https://github.com/fixture/repo.git", "HEAD"]);
  for (const value of ["protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null", "credential.helper="]) expect(call.args).toContain(value);
  expect(call.cwd).not.toBe(f.project); expect(call.git).toBe(false);
  expect(call.env.HOME).toBe(call.cwd); expect(call.env.XDG_CONFIG_HOME).toBe(call.cwd);
  expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1"); expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(call.env.GIT_CEILING_DIRECTORIES).toBe(dirname(call.cwd));
  expect(call.env.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  for (const key of ["FIXTURE_SECRET", "GIT_DIR", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HTTPS_PROXY", "GH_TOKEN", "BUN_OPTIONS"]) expect(call.env[key], key).toBeUndefined();
  expect(existsSync(call.cwd)).toBe(false);
  const rows = await readProcessTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.pgid === call.pid)).toBe(false);
}, 10_000);

test("#863 remote default probe ignores a parent repository's insteadOf config", async () => {
  const f = fixture(), parent = join(f.project, "parent"); mkdirSync(parent);
  for (const args of [["init", "-q", parent], ["-C", parent, "config", "url.file:///parent-poison/.insteadOf", "https://github.com/"]]) {
    const result = hubGitSync(args, { encoding: "utf8", timeout: 1000 });
    expect(result.status, result.stderr).toBe(0);
  }
  const child = join(parent, "control"); mkdirSync(child);
  const git = hostExecutable("git", f.project, "/usr/bin:/bin");
  const control = spawnSync(git, ["config", "--get", "url.file:///parent-poison/.insteadOf"], {
    cwd: child, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", timeout: 1000,
  });
  expect(control.status, control.stderr).toBe(0); expect(control.stdout.trim()).toBe("https://github.com/");
  writeFileSync(join(f.bin, "git"), `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const result = spawnSync(${JSON.stringify(git)}, ["config", "--get", "url.file:///parent-poison/.insteadOf"], { env: process.env, encoding: "utf8" });
writeFileSync(${JSON.stringify(f.trace)}, JSON.stringify({ status: result.status, stdout: result.stdout }));
if (result.status === 1) process.stdout.write(${JSON.stringify(receipt)}); else process.exitCode = 1;
`, { mode: 0o700 });
  // Run the actual probe with only its temporary-directory allocator relocated under a private parent repo.
  // Never plant .git in the shared OS temp directory; every other host/policy port stays real.
  const source = readFileSync(new URL("../src/hub/task-shell-default.ts", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export async function", "async function");
  const probe: typeof readTaskShellDefaultBranch = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(source) + "\nreadTaskShellDefaultBranch", {
    ...fs, ...paths, spawn, stopOwnedProcess, trackGroup, hostExecutable, hubGitArgv, hubGitEnv, realPath, isGitHubRepository, shortBranch,
    Buffer, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
    mkdtempSync: () => fs.mkdtempSync(join(parent, "probe-")),
  });
  expect(await probe(f.project, f.env, () => true, f.project, "fixture/repo", 1000)).toBe("release");
  expect(JSON.parse(readFileSync(f.trace, "utf8"))).toEqual({ status: 1, stdout: "" });
}, 10_000);

test("remote default probe refuses missing authority or invalid repository before any spawn", async () => {
  const f = fixture();
  expect(await f.probe(() => false)).toBeUndefined();
  expect(await readTaskShellDefaultBranch(f.project, f.env, () => true, f.project)).toBeUndefined();
  for (const repository of ["", "../repo", "fixture/repo?token=x", "https://github.com/fixture/repo", "fixture/repo/extra"]) expect(await f.probe(() => true, repository), repository).toBeUndefined();
  expect(existsSync(f.trace)).toBe(false);
});

test("remote default probe refuses malformed, duplicate, non-HEAD and failed receipts", async () => {
  for (const output of ["", receipt + receipt, receipt + "unexpected\n", `ref: refs/heads/release\tHEAD\n`, `${"a".repeat(40)}\tHEAD\n`, receipt.replace("refs/heads/release", "refs/tags/release"), receipt.replace("release", "../release"), receipt.replace(/\tHEAD/g, "\tother"), receipt.trimEnd()]) {
    const f = fixture(output); expect(await f.probe(), output).toBeUndefined();
    const call = JSON.parse(readFileSync(f.trace, "utf8")); expect(existsSync(call.cwd)).toBe(false);
  }
  expect(await fixture(receipt, 1).probe()).toBeUndefined();
}, 20_000);

test("remote default probe bounds output and stops its owned timeout group before removing the private home", async () => {
  for (const mode of ["overflow", "wait"] as const) {
    const f = fixture(receipt, 0, mode);
    expect(await f.probe(() => true, "fixture/repo", 1000)).toBeUndefined();
    const call = JSON.parse(readFileSync(f.trace, "utf8"));
    expect(existsSync(call.cwd)).toBe(false);
    const rows = await readProcessTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.pgid === call.pid)).toBe(false);
  }
}, 10_000);

test("remote default probe cancels a current-generation mismatch and refuses a project-owned Git shim", async () => {
  const f = fixture(receipt, 0, "wait");
  expect(await f.probe(() => !existsSync(f.trace))).toBeUndefined();
  const call = JSON.parse(readFileSync(f.trace, "utf8")); expect(existsSync(call.cwd)).toBe(false);
  const projectBin = join(f.project, "bin"); mkdirSync(projectBin);
  writeFileSync(join(projectBin, "git"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  expect(await readTaskShellDefaultBranch(f.project, { PATH: `${projectBin}:/usr/bin:/bin` }, () => true, f.project, "fixture/repo")).toBeUndefined();
}, 10_000);
