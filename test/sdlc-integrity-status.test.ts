import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

test("S4 control status screens a receipt stored before the current private-path policy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-integrity-status-")), stateDir = join(dir, "state");
  mkdirSync(stateDir);
  const board = new Board(join(stateDir, "hub.db"));
  const task = board.propose("user", { title: "ordinary task", class: "implement" });
  const check = "test/private.test.ts";
  board.update(task.id, "user", "lifecycle", { sdlc: { stage: "implement", redFirst: {
    red: { source: "local", head: "b".repeat(40), check, result: "failed" },
    green: { source: "local", head: "a".repeat(40), check, result: "passed" },
  } } });
  board.close();
  let client: ControlClient | undefined;
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, pii: { ...DEFAULT_CONFIG.pii, paths: [check] },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      snapshots: { enabled: false, keep: 1 } } });
  try {
    client = await ControlClient.connect(stateDir, { role: "console" });
    const result = await client.request({ t: "sdlc", op: "status", id: task.id });
    expect(result.ok).toBe(true);
    expect(result.rows[0].receipt.stage).toBe("implement");
    expect(result.rows[0].receipt).not.toHaveProperty("redFirst");
    expect(JSON.stringify(result)).not.toContain(check);
  } finally { client?.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
});
