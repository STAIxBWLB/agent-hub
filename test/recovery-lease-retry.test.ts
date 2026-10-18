import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient, DAEMON_FEATURES } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";

for (const pending of [false, true]) test(`#478 expired lease retries a storage blip (${pending ? "deferred notice" : "empty FIFO"}) and releases after recovery`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-lease-retry-"));
  const set = globalThis.setTimeout;
  const timers: { fire: () => void; delay: number; handle: ReturnType<typeof setTimeout> }[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = set(...args);
    if (args[1] === 600_000 || args[1] === 1000) timers.push({ handle, delay: args[1], fire: () => { clearTimeout(handle); args[0](...args.slice(2)); } });
    return handle;
  }) as typeof setTimeout;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined;
  try {
    daemon = await startDaemon({ cwd: dir, stateDir: join(dir, "state"), projectId: "p-lease", instanceId: "lease-source", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false } } });
    client = await ControlClient.connect(join(dir, "state"), { role: "console" });
    expect((await client.request({ t: "recovery", op: "prepare", operationId: "lease-op", expectedInstanceId: "lease-source", targetFeatures: DAEMON_FEATURES })).ok).toBe(true);
    const notice = newEnvelope("hub", "retained during blip", { to: [], kind: "task" });
    if (pending) daemon.bus.publish(notice);
    const journal = (daemon.bus as unknown as { journal: DeliveryJournal }).journal;
    const persist = journal.persistBus;
    journal.persistBus = () => { throw new Error("temporary storage failure"); };
    daemon.bus.storageError = "delivery journal unavailable";
    timers.find(timer => timer.delay === 600_000)!.fire();
    expect(daemon.bus.isRecoveryHeld).toBe(true);
    const retry = timers.find(timer => timer.delay === 1000);
    expect(retry).toBeDefined();
    journal.persistBus = persist;
    retry!.fire();
    expect(daemon.bus.isRecoveryHeld).toBe(false);
    expect(daemon.bus.snapshot().deferredHub).toBeUndefined();
    expect((await client.request({ t: "send", body: "authority released after storage recovery" })).ok).toBe(true);
  } finally {
    globalThis.setTimeout = set;
    for (const timer of timers) clearTimeout(timer.handle);
    client?.close(); await daemon?.stop(); rmSync(dir, { recursive: true, force: true });
  }
});
