import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { readEvents } from "../src/hub/events.ts";
import { BasePeer } from "../src/hub/peers.ts";

class FakePeer extends BasePeer {
  async start() {}
  async stop() {}
  async deliver() {}
}

test("#1555 suppressed quota rows still update live budget and flush at clean stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-quota-rows-")), stateDir = join(root, "state"), originalNow = Date.now;
  let now = Date.UTC(2026, 0, 1), daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    Date.now = () => now;
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
    daemon.bus.add(new FakePeer("codex"));
    client = await ControlClient.connect(stateDir, { role: "console" });
    expect((await client.request({ t: "budget", set: { peer: "codex", used: 0.2, window: "5h", resetsInMs: 3_600_000 } })).ok).toBe(true);
    now += 60_000;
    expect((await client.request({ t: "budget", set: { peer: "codex", used: 0.202, window: "5h", resetsInMs: 3_540_000 } })).ok).toBe(true);
    expect((await client.request({ t: "budget" })).budget.codex.windows[0].used).toBe(0.202);
    expect(JSON.parse(readFileSync(join(stateDir, "status.json"), "utf8")).budget.codex.windows[0].used).toBe(0.202);
    expect(readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "quota" && e.peer === "codex")).toHaveLength(1);
    client.close(); client = undefined;
    await daemon.stop(); daemon = undefined;
    expect(readEvents(join(stateDir, "events.jsonl")).filter(e => e.type === "quota" && e.peer === "codex")).toHaveLength(2);
  } finally {
    client?.close(); await daemon?.stop(); Date.now = originalNow; rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
