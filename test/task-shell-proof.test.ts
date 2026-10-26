import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { readTaskShellBinding, proveTaskShell, type TaskShellProofOptions } from "../src/hub/task-shell-proof.ts";
import { hostShellEnvironment } from "../src/local/shell-environment.ts";
import { realPath } from "../src/hub/project.ts";
import { shellQuote } from "../src/cli/shell-quote.ts";

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
  const options: TaskShellProofOptions = { root, projectRoot: project, deny: [], protectInstructions: true, binding: { branch: "task/worker", defaultBranch: "main" }, env, repository: "fixture/repo" };
  return { project, root, git, options, close: () => { rmSync(project, { recursive: true, force: true }); rmSync(hostBin, { recursive: true, force: true }); } };
}

test("#845 task proof binds real branch/default, literal paths, host argv and executable", () => {
  const f = fixture();
  try {
    expect(readTaskShellBinding(f.root, f.options.env, () => true)).toEqual(f.options.binding);
    for (const command of ["scripts/check.sh --changed", "bun run build", "bun test test/example.test.ts", "git add test/example.test.ts", "git commit -m 'fixture (Refs #845)'", "git push origin task/worker", "git push -u origin task/worker", "gh pr view task/worker", "gh pr checks task/worker", "gh pr create --base main --head task/worker --title fixture --body fixture"]) {
      const proof = proveTaskShell(command, f.options, () => true);
      expect(proof, command).toBeDefined(); expect(proof!.executable.startsWith("/")).toBe(true);
      if (proof!.program === "gh") expect(proof!.argv.slice(-2)).toEqual(["--repo", "https://github.com/fixture/repo"]);
      if (proof!.program === "git") expect(proof!.argv).toContain("core.hooksPath=/dev/null");
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
    f.git("symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    expect(readTaskShellBinding(f.root, f.options.env, () => true)).toBeUndefined();
    f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
    expect(readTaskShellBinding(f.root, f.options.env, () => true)).toBeUndefined();
    f.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect(hubGitSync(["-C", f.root, "checkout", "--detach", "HEAD"], { encoding: "utf8" }).status).toBe(0);
    expect(readTaskShellBinding(f.root, f.options.env, () => true)).toBeUndefined();
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
    expect(readTaskShellBinding(f.root, env, () => true, f.project)).toBeUndefined();
    expect(proveTaskShell("bun run build", { ...f.options, env }, () => true)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  } finally { f.close(); }
});
