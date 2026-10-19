import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";

test("person upgrade bypasses release resource gates with an active train and quota-paused peer, retaining target compatibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-upgrade-ruling-")), stateDir = join(root, "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, board: Board | undefined, hostCalls = 0;
  try {
    mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "enforce"\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      releaseHostAdmission: async () => { hostCalls++; return { admitted: false, reason: "host resource controller unavailable" }; },
      config: { ...DEFAULT_CONFIG, batch_ms: 0,
        roster: { claude: false, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    board = new Board(join(stateDir, "hub.db"));
    const release = board.newRelease("active", "Train", 1);
    board.updateRelease(release.id, { state: "active", train: { history: [] } }, 0);
    const task = board.propose("user", { title: "fix", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress" }); board.update(task.id, "user", "approved", { state: "approved" });
    board.plan(task.id, "user", { release: release.id }, 0);
    daemon.bus.add({ id: "codex", state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {} });
    expect(await person.request({ t: "budget", set: { peer: "codex", used: 0.99, resetsInMs: 7 * 24 * 3_600_000, window: "week" } })).toMatchObject({ ok: true });
    let paused = false;
    for (let i = 0; i < 40 && !paused; i++) {
      paused = !!(await person.request({ t: "budget" })).budget.codex?.paused;
      if (!paused) await Bun.sleep(5);
    }
    expect(paused).toBe(true);
    expect(await person.request({ t: "task", op: "hub_release_cut", args: { id: release.id, revision: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("host resource controller unavailable") });
    expect(hostCalls).toBe(1);
    const status = (await person.request({ t: "status" })).status;
    const operation = { t: "recovery", operationId: "ungated-upgrade", expectedInstanceId: status.instanceId, targetFeatures: status.features };
    const oldTarget = { ...operation, targetFeatures: status.features.filter((feature: string) => feature !== "release_trains") };
    expect(await person.request({ ...oldTarget, op: "prepare" })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    expect(await person.request({ ...oldTarget, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: true, committed: true });
    expect(hostCalls).toBe(1);
    await daemon.stopped;
  } finally { board?.close(); person?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
