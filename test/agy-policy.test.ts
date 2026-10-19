import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, loadConfig, startDaemon } from "../src/hub/daemon.ts";

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, ".agenthub"));
  return root;
}

async function writeRouting(root: string): Promise<void> {
  const routing = (await Bun.file(join(import.meta.dir, "../templates/routing.toml")).text()).replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]')
    .replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(root, ".agenthub/routing.toml"), routing);
}

test("conductor cannot start agy through hub_peer_start", async () => {
  const root = project("ahub-agy-conductor-start-");
  await writeRouting(root);
  const opened: string[][] = [];
  const daemon = await startDaemon({ cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, roster: { agy: true }, roles: { ...DEFAULT_CONFIG.roles, claude: ["conductor"] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false, triage: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false },
      mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } },
    terminal: () => ({ available: () => ({ ok: true as const, via: "fixture" }), open: async (_title, argv) => { opened.push([...argv]); return { ok: true as const, via: "fixture" }; } }),
  });
  const claude = await ControlClient.connect(root, { role: "tools", peer: "claude" });
  try {
    const result = await claude.request({ t: "task", op: "hub_peer_start", args: { peer: "agy" } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("may be started by the conductor");
    expect(opened).toEqual([]);
  } finally { claude.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("unsupported agy role entries cannot block normal daemon hellos or exceed its role ceiling", async () => {
  const root = project("ahub-agy-role-ceiling-");
  await writeRouting(root);
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({
    roster: { agy: true },
    roles: { claude: ["conductor"], agy: ["implementer", "verifier", "reviewer", "planner", "conductor"] },
  }));
  const loaded = loadConfig(root);
  expect(loaded.roles.agy).toEqual(["implementer", "verifier"]);
  expect(loaded.retired).toContain("roles.agy: ignored roles outside the adapter ceiling");
  const daemon = await startDaemon({ cwd: root, stateDir: root, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...loaded, memory: { ...loaded.memory, enabled: false, native: false },
      inference: { ...loaded.inference, enabled: false, triage: false }, pi: { ...loaded.pi, enabled: false, auto_start: false },
      snapshots: { ...loaded.snapshots, enabled: false }, mlx: { ...loaded.mlx, enabled: false } },
  });
  let consoleClient: ControlClient | undefined, otherPeer: ControlClient | undefined;
  try {
    expect(readFileSync(join(root, "hub.log"), "utf8")).toContain("roles.agy: ignored roles outside the adapter ceiling");
    consoleClient = await ControlClient.connect(root, { role: "console" });
    otherPeer = await ControlClient.connect(root, { role: "peer", peer: "ordinary-peer", channel: false });
    expect(consoleClient.features).toContain("native_hook_launch");
    expect(otherPeer.features).toContain("native_hook_launch");
  } finally { otherPeer?.close(); consoleClient?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
});
