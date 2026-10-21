import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADAPTERS } from "../../src/adapters/registry.ts";
import { DEFAULT_CONFIG, startDaemon } from "../../src/hub/daemon.ts";
import { ControlClient } from "../../src/hub/control-client.ts";
import { newEnvelope } from "../../src/hub/envelope.ts";
import { until } from "./kit.ts";

test("P4 Kimi TUI: its external pull-only channel queues work without fabricating driven occupancy", async () => {
  const definition = ADAPTERS.find(candidate => candidate.kind === "kimi")!;
  expect(definition.attach?.pullOnlyForms).toContain("tui");
  const dir = mkdtempSync(join(tmpdir(), "conformance-kimi-tui-")), stateDir = join(dir, "state");
  mkdirSync(join(dir, ".agenthub")); writeFileSync(join(dir, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const daemon = await startDaemon({ cwd: dir, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, peers: { kimi: { start_mode: "tui" } }, batch_ms: 0,
      kimi_cmd: [process.execPath, join(import.meta.dir, "../fakes/acp-server.ts")],
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    },
  });
  let channel: ControlClient | undefined, console_: ControlClient | undefined;
  const pushes: unknown[] = [];
  try {
    channel = await ControlClient.connect(stateDir, { role: "peer", peer: definition.kind, channel: false });
    channel.onPush = message => { if (message.t === "deliver") pushes.push(message); };
    await until(() => daemon.bus.stateOf(definition.kind) === "idle", "Kimi native pull channel admitted");
    const adapter = daemon.bus.peers.get(definition.kind)!;
    expect(adapter.pullOnly).toBe(true);
    const envelope = newEnvelope("user", "pull-only conformance work", { to: [definition.kind] });
    daemon.bus.publish(envelope); await new Promise<void>(resolve => setImmediate(resolve));
    expect(pushes).toEqual([]); expect(daemon.bus.queued(definition.kind)).toBe(1); expect(adapter.state).toBe("idle");
    const inbox = await channel.request({ t: "inbox" });
    expect(inbox.ok).toBe(true); expect(inbox.envs.some((entry: { id: string }) => entry.id === envelope.id)).toBe(true);
    expect(adapter.state).toBe("idle");
    expect((await channel.request({ t: "inbox" })).envs).toEqual([]);
    console_ = await ControlClient.connect(stateDir, { role: "console" });
    const watch = await console_.request({ t: "watch", peer: definition.kind });
    expect(watch.ok).toBe(false); expect(watch.error).toContain("pull-only TUI");
  } finally { channel?.close(); console_?.close(); await daemon.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
