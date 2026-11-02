import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import type { PeerCapabilities } from "../src/hub/routing.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function capabilities(bashNetwork: boolean | "direct", repository = false) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-capabilities-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  if (repository) { // #1115: the hub makes the worktree for a sandboxed peer, so the capability is whether it can here
    const git = (...args: string[]) => { const run = hubGitSync(["-C", dir, "-c", "user.name=f", "-c", "user.email=f@f.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", timeout: 20_000 }); if (run.status !== 0) throw new Error(run.stderr); };
    git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "base");
  }
  const stateDir = join(dir, "state");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG,
    local: { ...DEFAULT_CONFIG.local, bash_network: bashNetwork, network_allow: [] }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  return (await client.request({ t: "status" })).status.taskCapabilities as Record<string, PeerCapabilities>;
}

test("outside a git repository the daemon reports no worktree for the hub-sandboxed peers, with the hub's cause and next step, and a worktree for the others (#1081, #1115)", async () => {
  const caps = await capabilities(false);
  for (const sandboxed of ["pi", "local"]) {
    expect(caps[sandboxed]!.worktree, sandboxed).toBe(false);
    expect(caps[sandboxed]!.worktreeReason).toContain("the hub cannot make a task worktree for it");
    expect(caps[sandboxed]!.worktreeReason).toContain("not a git repository");
    expect(caps[sandboxed]!.worktreeReason).toContain("git init");
  }
  for (const own of ["claude", "codex", "kimi"]) { expect(caps[own]!.worktree, own).toBe(true); expect(caps[own]!.worktreeReason).toBeUndefined(); }
});

test("in a git repository the daemon reports a worktree for the hub-sandboxed peers too, because the hub makes it (#1115)", async () => {
  const caps = await capabilities(false, true);
  for (const peer of ["pi", "local", "claude", "codex", "kimi"]) { expect(caps[peer]!.worktree, peer).toBe(true); expect(caps[peer]!.worktreeReason, peer).toBeUndefined(); }
});

test("a git-lfs style filter in the person's system and global git config does not turn the hub-made worktree off (F-worktree-config-scope)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-capabilities-lfs-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); // registered before anything can throw
  const file = join(dir, "gitconfig");
  writeFileSync(file, '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
  const saved = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL };
  cleanup.push(() => { for (const [key, value] of [["GIT_CONFIG_SYSTEM", saved.system], ["GIT_CONFIG_GLOBAL", saved.global]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.GIT_CONFIG_SYSTEM = file; process.env.GIT_CONFIG_GLOBAL = file;
  const caps = await capabilities(false, true);
  for (const peer of ["pi", "local"]) { expect(caps[peer]!.worktree, peer).toBe(true); expect(caps[peer]!.worktreeReason, peer).toBeUndefined(); }
});

test("the daemon reports network from the one sandbox setting: off is none with its setting named, a proxy or direct is some (#1081)", async () => {
  const off = await capabilities(false);
  for (const sandboxed of ["pi", "local"]) {
    expect(off[sandboxed]!.network, sandboxed).toBe(false);
    expect(off[sandboxed]!.networkReason).toContain("local.bash_network");
  }
  for (const own of ["claude", "codex", "kimi"]) expect(off[own]!.network, own).toBe(true);
  const direct = await capabilities("direct");
  for (const sandboxed of ["pi", "local"]) { expect(direct[sandboxed]!.network, sandboxed).toBe(true); expect(direct[sandboxed]!.networkReason).toBeUndefined(); }
});
