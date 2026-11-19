import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";

test("#1555 injected merge settlement trigger is owned and stopped", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-merge-trigger-"));
  let tick: (() => void) | undefined, stopped = false;
  const daemon = await startDaemon({ cwd: root, stateDir: join(root, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
    mergeReadbackTrigger: fn => { tick = fn; return () => { stopped = true; }; },
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
  try { expect(tick).toBeDefined(); tick!(); } finally { await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
  expect(stopped).toBe(true);
});
