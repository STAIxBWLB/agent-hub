import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../src/hub/bus.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";
import { BasePeer } from "../src/hub/peers.ts";

class RetainedPlanner extends BasePeer {
  async deliver(): Promise<void> { throw new Error("the source planner stays offline under the recovery hold"); }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("#1350 ordinary startup durably releases hub task notices before Tasks exists and reaches authenticated readiness", async () => {
  const made = mkdtempSync(join(tmpdir(), "ahub-deferred-startup-"));
  cleanup.push(() => rmSync(made, { recursive: true, force: true }));
  const cwd = realPath(made), stateDir = join(cwd, "state"), projectId = "deferred-startup-fixture";
  const isolated = { HOME: join(cwd, "home"), AGENTHUB_HOME: join(cwd, "hub-home"), AMEM_HOME: join(cwd, "memory"),
    CLAUDE_CONFIG_DIR: join(cwd, "claude"), CODEX_HOME: join(cwd, "codex"), KIMI_CODE_HOME: join(cwd, "kimi") };
  const previous = Object.fromEntries(Object.keys(isolated).map(key => [key, process.env[key]]));
  cleanup.push(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  Object.assign(process.env, isolated);
  for (const folder of [stateDir, ...Object.values(isolated)]) mkdirSync(folder, { recursive: true });

  // Use the real hold/publication/checkpoint path, not hand-edited journal rows or a copied silence callback.
  const journal = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: cwd, projectId, instanceId: "source" });
  const source = new Bus({ journal, batchMs: 0, rostered: peer => peer === "claude" });
  source.add(new RetainedPlanner("claude"));
  const notices = ["first persisted workflow notice", "second persisted workflow notice"].map(body => newEnvelope(HUB, body, { to: ["claude"], kind: "task", priority: "status" }));
  try {
    source.setRecoveryHold(true, true);
    for (const notice of notices) source.publish(notice);
    expect(source.snapshot().deferredHub).toEqual(notices);
    expect(journal.transportSnapshot().bus.deferredHub).toEqual(notices);
  } finally { source.closeJournal(); }

  // No restart snapshot: the real ordinary-startup release runs before the daemon constructs Tasks.
  // Reopen twice to check that deferred -> queued is durable and does not duplicate the originals.
  for (const instanceId of ["first-start", "second-start"]) {
    const daemon = await startDaemon({ cwd, stateDir, projectId, instanceId, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, coordination: "advisory", batch_ms: 0,
        roster: { ...DEFAULT_CONFIG.roster, claude: true }, roles: { ...DEFAULT_CONFIG.roles, claude: ["planner", "reviewer"] },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, specs: { ...DEFAULT_CONFIG.specs, enabled: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, local: { ...DEFAULT_CONFIG.local, bash_network: false },
        approvals: { ...DEFAULT_CONFIG.approvals, notify: false },
      } });
    cleanup.push(() => daemon.stop());
    const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
    const ready = await client.request({ t: "status" });
    expect(ready.status.cwd).toBe(cwd); expect(ready.status.projectId).toBe(projectId);
    expect(daemon.bus.isRecoveryHeld).toBe(false);
    expect(daemon.bus.snapshot().deferredHub ?? []).toEqual([]);
    expect(daemon.bus.snapshot().queues.claude?.map(env => env.id)).toEqual(notices.map(env => env.id));
    client.close();
    await daemon.stop();
  }
}, 20_000);
