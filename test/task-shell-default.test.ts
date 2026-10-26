import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTaskShellDefaultBranch } from "../src/hub/task-shell-default.ts";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { readProcessTable } from "../src/hub/child-process.ts";

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
  expect(call.env.GIT_CEILING_DIRECTORIES).toBe(call.cwd);
  expect(call.env.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
  for (const key of ["FIXTURE_SECRET", "GIT_DIR", "GIT_EXEC_PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HTTPS_PROXY", "GH_TOKEN", "BUN_OPTIONS"]) expect(call.env[key], key).toBeUndefined();
  expect(existsSync(call.cwd)).toBe(false);
  const rows = await readProcessTable(); expect(rows).toBeDefined(); expect(rows!.some(row => row.pgid === call.pid)).toBe(false);
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
