import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import type { PeerCapabilities } from "../src/hub/routing.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function capabilities(bashNetwork: boolean | "direct") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-capabilities-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = join(dir, "state");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG,
    local: { ...DEFAULT_CONFIG.local, bash_network: bashNetwork, network_allow: [] }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false },
    memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, research: { ...DEFAULT_CONFIG.research, enabled: false }, task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  return (await client.request({ t: "status" })).status.taskCapabilities as Record<string, PeerCapabilities>;
}

test("the daemon reports no worktree for the hub-sandboxed peers and a worktree for the others, naming #270 (#1081)", async () => {
  const caps = await capabilities(false);
  for (const sandboxed of ["pi", "local"]) {
    expect(caps[sandboxed]!.worktree, sandboxed).toBe(false);
    expect(caps[sandboxed]!.worktreeReason).toContain("git worktree add runs outside the sandbox");
    expect(caps[sandboxed]!.worktreeReason).toContain("#270");
  }
  for (const own of ["claude", "codex", "kimi"]) { expect(caps[own]!.worktree, own).toBe(true); expect(caps[own]!.worktreeReason).toBeUndefined(); }
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
