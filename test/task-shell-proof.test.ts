import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hubGitArgv, hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { readTaskShellBinding, proveTaskShell, type TaskShellProofOptions } from "../src/hub/task-shell-proof.ts";
import { hostShellEnvironment } from "../src/local/shell-environment.ts";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";
import { hostShellPath } from "../src/hub/host-executable.ts";

function fixture() {
  const project = realPath(mkdtempSync(join(tmpdir(), "ahub-task-shell-proof-"))), root = join(project, ".worktrees", "worker");
  const hostBin = realPath(mkdtempSync(join(tmpdir(), "ahub-task-shell-host-")));
  for (const name of ["bun", "gh"]) writeFileSync(join(hostBin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = hostShellEnvironment({ HOME: hostBin, PATH: `${hostBin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
  const git = (...args: string[]) => {
    const out = hubGitSync(["-C", project, ...args], { env, encoding: "utf8", timeout: 1000 });
    expect(out.status, out.stderr).toBe(0); return out.stdout.trim();
  };
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("remote", "add", "origin", "https://github.com/fixture/repo.git"); git("worktree", "add", "-qb", "task/worker", root);
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(root, "test", "example.test.ts"), "fixture\n");
  const options: TaskShellProofOptions = { root, projectRoot: project, deny: [], protectInstructions: true, binding: { branch: "task/worker", defaultBranch: "main" }, env, repository: "fixture/repo", publicText: () => true };
  return { project, root, git, options, close: () => { rmSync(project, { recursive: true, force: true }); rmSync(hostBin, { recursive: true, force: true }); } };
}

test("#845 task proof binds real branch/default, literal paths, host argv and executable", () => {
  const f = fixture();
  try {
    expect(readTaskShellBinding(f.root, f.options.env, () => true, f.project, f.options.binding.defaultBranch)).toEqual(f.options.binding);
    for (const command of ["scripts/check.sh --changed", "bun run build", "bun test test/example.test.ts", "git add test/example.test.ts", "git commit -m 'fixture (Refs #845)'", "git push origin task/worker", "git push -u origin task/worker", "gh pr view task/worker", "gh pr checks task/worker", "gh pr create --base main --head task/worker --title fixture --body fixture"]) {
      const proof = proveTaskShell(command, f.options, () => true);
      expect(proof, command).toBeDefined(); expect(proof!.executable.startsWith("/")).toBe(true);
      if (proof!.program === "gh") expect(proof!.argv.slice(-2)).toEqual(["--repo", "https://github.com/fixture/repo"]);
      if (proof!.program === "git") expect(proof!.argv).toContain("core.hooksPath=/dev/null");
      expect(proof!.requiresSandbox, command).toBe(command.startsWith("scripts/check.sh") || command.startsWith("bun "));
    }
    const before = proveTaskShell("scripts/check.sh --changed", f.options, () => true)!;
    writeFileSync(join(f.root, "scripts", "check.sh"), "#!/bin/sh\nexit 7\n");
    expect(proveTaskShell("scripts/check.sh --changed", f.options, () => true)!.fingerprint).not.toBe(before.fingerprint);
  } finally { f.close(); }
});

test("#845 unknown/default/detached branches, protected paths, readonly policy and unstable evidence refuse", () => {
  const f = fixture();
  try {
    for (const command of ["bun test test/../outside.test.ts", "git push --force origin task/worker", "git push origin other", "git add .env", "git add AGENTS.md", "scripts/check.sh --changed && pwd"]) expect(proveTaskShell(command, f.options, () => true), command).toBeUndefined();
    expect(proveTaskShell("bun run build", { ...f.options, readOnly: ["data"] }, () => true)).toBeUndefined();
    expect(proveTaskShell("bun run build", f.options, () => false)).toBeUndefined();
    const outside = join(f.project, "outside.test.ts"); writeFileSync(outside, "outside\n"); symlinkSync(outside, join(f.root, "test", "escape.test.ts"));
    expect(proveTaskShell("bun test test/escape.test.ts", f.options, () => true)).toBeUndefined();
    expect(proveTaskShell("git add test", f.options, () => true)).toBeUndefined();
    writeFileSync(join(f.root, "scripts", ".env"), "fixture-private\n");
    expect(proveTaskShell("git add scripts", f.options, () => true)).toBeUndefined();
    expect(readTaskShellBinding(f.root, f.options.env, () => true, f.project)).toBeUndefined();
    expect(hubGitSync(["-C", f.root, "checkout", "--detach", "HEAD"], { encoding: "utf8" }).status).toBe(0);
    expect(readTaskShellBinding(f.root, f.options.env, () => true, f.project, f.options.binding.defaultBranch)).toBeUndefined();
  } finally { f.close(); }
});

test("#845 mutable origin HEAD cannot replace the host-pinned non-main default branch", () => {
  const f = fixture();
  try {
    f.git("update-ref", "refs/remotes/origin/release", "HEAD");
    f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
    const pinned = "release"; // Supplied by the separately tested remote host probe, never by local origin/HEAD.
    expect(pinned).toBe("release");
    f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(readTaskShellBinding(f.root, f.options.env, () => true, f.project, pinned)).toEqual({ branch: "task/worker", defaultBranch: "release" });
    expect(hubGitSync(["-C", f.root, "checkout", "-qb", "release"], { encoding: "utf8" }).status).toBe(0);
    expect(readTaskShellBinding(f.root, f.options.env, () => true, f.project, pinned)).toBeUndefined();
  } finally { f.close(); }
});

test("#845 privileged add/commit refuse configured filters, external drivers and partial clones", () => {
  const f = fixture();
  try {
    for (const key of ["filter.fixture.clean", "filter.fixture.smudge", "filter.fixture.process", "diff.fixture.command", "diff.fixture.textconv", "include.path", "includeIf.onbranch:task/**.path", "extensions.partialClone", "remote.origin.promisor"]) {
      f.git("config", key, key === "remote.origin.promisor" ? "true" : key === "extensions.partialClone" ? "origin" : "fixture-helper");
      for (const command of ["git add test/example.test.ts", "git commit -m fixture"]) expect(proveTaskShell(command, f.options, () => true), key).toBeUndefined();
      f.git("config", "--unset", key);
    }
    const proof = proveTaskShell("git commit -m fixture", f.options, () => true)!;
    expect(proof.requiresSandbox).toBe(false);
    for (const setting of ["core.hooksPath=/dev/null", "core.fsmonitor=false", "commit.gpgSign=false", "push.gpgSign=false", "gc.auto=0", "maintenance.auto=false"]) expect(proof.argv).toContain(setting);
  } finally { f.close(); }
});

test("#845 every origin push target is pinned; helper and implicit push effects cannot enlarge a grant", () => {
  const f = fixture();
  try {
    const proof = () => proveTaskShell("git push origin task/worker", f.options, () => true);
    expect(proof()).toBeDefined();
    f.git("config", "--add", "remote.origin.pushurl", "https://github.com/fixture/repo.git");
    f.git("config", "--add", "remote.origin.pushurl", "https://github.com/other/repo.git");
    expect(proof()).toBeUndefined();
    f.git("config", "--unset-all", "remote.origin.pushurl");
    f.git("config", "core.sshCommand", "fixture-helper"); expect(proof()).toBeUndefined();
    f.git("config", "--unset", "core.sshCommand");
    f.git("config", "push.followTags", "true");
    expect(proof()!.argv).toContain("push.followTags=false");
    expect(proveTaskShell("git push origin task/worker", { ...f.options, repository: "other/repo" }, () => true)).toBeUndefined();
  } finally { f.close(); }
});

test("#845 push uses one explicit same-branch refspec, and refuses configured refspecs or mirror even when false", () => {
  const f = fixture();
  try {
    const commands = ["git push origin task/worker", "git push -u origin task/worker"];
    for (const command of commands) {
      const proof = proveTaskShell(command, f.options, () => true)!;
      expect(proof).toBeDefined();
      expect(proof.argv.slice(proof.argv.indexOf("push"))).toEqual([
        "push", ...(command.includes(" -u ") ? ["-u"] : []), "origin", "refs/heads/task/worker:refs/heads/task/worker",
      ]);
      const expectedEnv = Object.fromEntries(Object.entries(hubGitEnv(f.options.env, { repositoryIsolation: true })).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      expect(proof.env).toEqual(expectedEnv);
    }
    for (const [key, value] of [["remote.origin.push", "+refs/heads/task/worker:refs/heads/main"], ["remote.origin.mirror", "true"], ["remote.origin.mirror", "false"]]) {
      f.git("config", key!, value!);
      for (const command of commands) expect(proveTaskShell(command, f.options, () => true), `${key}=${value}`).toBeUndefined();
      f.git("config", "--unset-all", key!);
    }
  } finally { f.close(); }
});

test("#845 gh child Git inherits the core hardening through the exact fingerprinted effective environment", () => {
  const f = fixture();
  try {
    const env = { ...f.options.env, GIT_DIR: "/fixture-poison", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/fixture-poison" };
    const proof = proveTaskShell("gh pr view task/worker", { ...f.options, env }, () => true)!;
    expect(proof).toBeDefined(); expect(proof.env.GIT_DIR).toBeUndefined();
    const configs: string[] = [];
    for (let index = 0; index < Number(proof.env.GIT_CONFIG_COUNT); index++) configs.push(`${proof.env[`GIT_CONFIG_KEY_${index}`]}=${proof.env[`GIT_CONFIG_VALUE_${index}`]}`);
    const core = hubGitArgv([]);
    expect(configs).toEqual(core.filter((_, index) => core[index - 1] === "-c"));
    expect(proof.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(proof.env.GIT_NO_REPLACE_OBJECTS).toBe("1");
    f.git("config", "core.hooksPath", "/fixture-poison");
    const executable = proveTaskShell("git add test/example.test.ts", f.options, () => true)!.executable;
    const inherited = spawnSync(executable, ["-C", f.root, "config", "--get", "core.hooksPath"], { env: proof.env, encoding: "utf8", timeout: 1000 });
    expect(inherited.status, inherited.stderr).toBe(0); expect(inherited.stdout.trim()).toBe("/dev/null");
    const language = proof.env.LANG === "C" ? "en_US.UTF-8" : "C";
    const changed = proveTaskShell("gh pr view task/worker", { ...f.options, env: { ...f.options.env, LANG: language } }, () => true)!;
    expect(changed.env.LANG).toBe(language);
    expect(changed.fingerprint).not.toBe(proof.fingerprint);
    expect(Object.isFrozen(proof.env)).toBe(true);
  } finally { f.close(); }
});

test("#845 body-file grants require a screened bounded regular file and execute its captured body bytes", () => {
  const f = fixture();
  try {
    const command = "gh pr create --base main --head task/worker --title fixture --body-file body.md";
    const publicBody = "Public review summary.\nRefs #845\n";
    writeFileSync(join(f.root, "body.md"), publicBody);
    expect(proveTaskShell(command, { ...f.options, publicText: undefined }, () => true)).toBeUndefined();
    expect(proveTaskShell(command, { ...f.options, publicText: () => false }, () => true)).toBeUndefined();
    const screened: string[] = [];
    const options = { ...f.options, publicText: (text: string) => { screened.push(text); return !text.includes("fixture-private"); } };
    const proof = proveTaskShell(command, options, () => true)!;
    expect(proof).toBeDefined(); expect(screened).toEqual([publicBody]);
    expect(proof.argv).not.toContain("--body-file"); expect(proof.argv).not.toContain("body.md");
    expect(proof.argv[proof.argv.indexOf("--body") + 1]).toBe(publicBody);
    writeFileSync(join(f.root, "body.md"), "fixture-private content changed after proof\n");
    expect(proof.argv[proof.argv.indexOf("--body") + 1]).toBe(publicBody);
    expect(proveTaskShell(command, options, () => true)).toBeUndefined();
    writeFileSync(join(f.root, "body.md"), "A different public body.");
    expect(proveTaskShell(command, options, () => true)!.fingerprint).not.toBe(proof.fingerprint);
    writeFileSync(join(f.root, "body.md"), "x".repeat(3001));
    expect(proveTaskShell(command, f.options, () => true)).toBeUndefined();
    rmSync(join(f.root, "body.md")); mkdirSync(join(f.root, "body.md"));
    expect(proveTaskShell(command, f.options, () => true)).toBeUndefined();
  } finally { f.close(); }
});

test("#845 a literal body-file flag in the title stays data while the actual body-file flag selects its path", () => {
  const f = fixture();
  try {
    const prefix = "gh pr create --base main --head task/worker --title '--body-file'";
    const literal = proveTaskShell(`${prefix} --body public`, { ...f.options, publicText: undefined }, () => true)!;
    expect(literal).toBeDefined();
    expect(literal.argv.slice(0, -2)).toEqual(["pr", "create", "--base", "main", "--head", "task/worker", "--title", "--body-file", "--body", "public"]);
    writeFileSync(join(f.root, "body.md"), "Screened public snapshot.\n");
    const screened: string[] = [];
    const captured = proveTaskShell(`${prefix} --body-file body.md`, { ...f.options, publicText: text => { screened.push(text); return true; } }, () => true)!;
    expect(captured).toBeDefined();
    expect(screened).toEqual(["Screened public snapshot.\n"]);
    expect(captured.argv.slice(0, -2)).toEqual(["pr", "create", "--base", "main", "--head", "task/worker", "--title", "--body-file", "--body", "Screened public snapshot.\n"]);
  } finally { f.close(); }
});

test("#845 shared host environment ignores native-style ambient selector variables", () => {
  const keys = ["GIT_DIR", "RIPGREP_CONFIG_PATH", "GH_REPO"], before = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "fixture-poison";
    const env = hostShellEnvironment({ AGENTHUB_PEER_ID: "claude-worker", HTTPS_PROXY: "http://127.0.0.1:1" });
    expect(Object.keys(env).sort()).toEqual(["AGENTHUB_PEER_ID", "HOME", "HTTPS_PROXY", "LANG", "PATH", "TERM"]);
    for (const key of keys) expect(env[key]).toBeUndefined();
  } finally { keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }); }
});

test("#845 metadata refuses a parent-project Git shadow before invoking it", () => {
  const f = fixture();
  try {
    const bin = join(f.project, "bin"), marker = join(f.project, "invoked"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf unsafe > ${shellQuote(marker)}\nexit 1\n`, { mode: 0o700 });
    const env = { ...f.options.env, PATH: `${bin}:/usr/bin:/bin` };
    expect(readTaskShellBinding(f.root, env, () => true, f.project, f.options.binding.defaultBranch)).toBeUndefined();
    expect(proveTaskShell("bun run build", { ...f.options, env }, () => true)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  } finally { f.close(); }
});

test("#845 target PATH removes project/worktree entries and directory symlink aliases", () => {
  const f = fixture();
  try {
    const primary = join(f.project, "bin"), nested = join(f.root, "bin"), outside = f.options.env.HOME!;
    mkdirSync(primary); mkdirSync(nested);
    const alias = join(outside, "project-alias"), insideAlias = join(f.project, "outside-alias");
    symlinkSync(primary, alias); symlinkSync(outside, insideAlias);
    const filtered = hostShellPath(f.project, f.root, [primary, nested, alias, insideAlias, outside, "/usr/bin", "/bin"].join(":"));
    expect(filtered?.split(":")).toEqual([...new Set([realPath(outside), realPath("/usr/bin"), realPath("/bin")])]);
    expect(hostShellPath(f.project, f.root, `${primary}:${nested}:${alias}`)).toBeUndefined();
    for (const value of ["", "relative:/usr/bin", "/usr/bin::/bin", "/usr/bin/../bin", "x".repeat(16385)]) expect(hostShellPath(f.project, f.root, value), value).toBeUndefined();
  } finally { f.close(); }
});
