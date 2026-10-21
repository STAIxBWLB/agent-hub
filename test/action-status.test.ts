import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

test("slice1 status never claims adapter enforcement before its pre-tool gate is wired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-action-status-")), stateDir = join(dir, "state");
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, snapshots: { enabled: false, keep: 1 } } });
  daemon.bus.add({ id: "claude", state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {} });
  let client: ControlClient | undefined;
  try {
    client = await ControlClient.connect(stateDir, { role: "console" });
    const { status } = await client.request({ t: "status" });
    expect(Object.keys(status.peers).length).toBeGreaterThan(0);
    for (const row of Object.values(status.peers) as any[]) {
      expect(row.actionPolicy).toMatchObject({ enabled: true, enforceable: false, sessionBound: false, limits: { publish: 1, destroy: 3, "external-write": 5, install: 2 } });
      expect(row.actionPolicy.note).toContain("always-ask not enforceable");
    }
    const text = renderStatus(status, 160).map(line => paint(line, false)).join("\n");
    expect(text).toContain("always-ask not enforceable");
  } finally { client?.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
});
