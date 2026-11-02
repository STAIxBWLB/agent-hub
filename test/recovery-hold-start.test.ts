import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";

// #1088: while recovery holds mutations, a start request used to be refused with only "recovery is holding mutations". A person who asked to start a peer that already runs could not tell
// whether the peer was down or what to do. The refusal now names the hold, whether the peer already runs, and the step that works.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function rig() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-recovery-hold-start-"))), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const instanceId = crypto.randomUUID();
  const daemon = await startDaemon({ cwd, stateDir, projectId: "hold-start-fixture", instanceId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0,
      kimi_cmd: [process.execPath, join(import.meta.dir, "fakes/acp-server.ts")],
      peers: { kimi: { start_mode: "headless" } },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
    } });
  cleanup.push(() => daemon.stop());
  const person = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => person.close());
  return { daemon, person, instanceId };
}

test("a start request during a recovery hold says the peer already runs and what to do, and a stopped peer gets its start command (#1088)", async () => {
  const h = await rig();
  expect((await h.person.request({ t: "start", peer: "kimi" })).ok).toBe(true); // kimi runs before the hold
  const operationId = crypto.randomUUID();
  expect((await h.person.request({ t: "recovery", op: "prepare", expectedInstanceId: h.instanceId, operationId, targetFeatures: DAEMON_FEATURES })).ok).toBe(true);

  const running = await h.person.request({ t: "start", peer: "kimi" });
  expect(running.ok).toBe(false);
  expect(running.error).toContain("recovery is holding mutations");          // the cause, still first
  expect(running.error).toContain("kimi is already running");                // the state of the peer
  expect(running.error).toContain("ahub recovery status");                   // the step that works
  expect(running.error).toContain("ahub recovery reattach <operation-id> kimi"); // and the repair path for a blocked one
  // the peer was not touched
  expect(h.daemon.bus.peers.get("kimi")?.state).not.toBe("offline");

  // the conductor-side start (hubStart) refuses with the same words
  const viaPeerStart = await h.person.request({ t: "peer_start", peer: "kimi" });
  expect(viaPeerStart.ok).toBe(false);
  expect(viaPeerStart.error).toContain("kimi is already running");

  // a peer that is not running is told how to start it once the hold ends, never "already running"
  const stopped = await h.person.request({ t: "start", peer: "codex" });
  expect(stopped.ok).toBe(false);
  expect(stopped.error).toContain("recovery is holding mutations");
  expect(stopped.error).toContain("codex was not started");
  expect(stopped.error).toContain("ahub codex");
  expect(stopped.error).not.toContain("already running");

  // an id that is not a peer id never reaches a lookup, and nothing about it is echoed
  const bogus = await h.person.request({ t: "peer_start", peer: "../x" });
  expect(bogus.ok).toBe(false);

  // the hold ends and the refusal is gone: whatever a start says now, it is not the hold
  expect((await h.person.request({ t: "recovery", op: "abort", expectedInstanceId: h.instanceId, operationId })).ok).toBe(true);
  const after = await h.person.request({ t: "peer_start", peer: "kimi" });
  expect(String(after.error ?? "")).not.toContain("recovery is holding mutations");
}, 30_000);
