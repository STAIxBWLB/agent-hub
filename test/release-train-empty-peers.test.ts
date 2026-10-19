import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";

test("empty attached-peer set admits release cut and recovery but retains cut host and recovery busy fences", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-train-empty-")), stateDir = join(root, "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, board: Board | undefined;
  let hostAllowed = false;
  try {
    mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "advise"\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
      releaseHostAdmission: async () => { return { admitted: hostAllowed, ...(hostAllowed ? {} : { reason: "host slot held" }), current: () => true, close: async () => {} }; },
      config: { ...DEFAULT_CONFIG, batch_ms: 0,
        roster: { claude: false, codex: false, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    const op = (name: string, args: object) => person!.request({ t: "task", op: name, args });
    const release = JSON.parse((await op("hub_release_new", { name: "empty", goal: "Ship approved work", order: 1 })).text);
    board = new Board(join(stateDir, "hub.db"));
    const task = board.propose("user", { title: "fix", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress" }); board.update(task.id, "user", "done", { state: "approved" });
    expect(await op("hub_release_assign", { id: task.id, revision: 0, release: release.id, reason: "scope" })).toMatchObject({ ok: true });
    expect(await op("hub_release_configure", { id: release.id, revision: 0, state: "active" })).toMatchObject({ ok: true });
    expect([...daemon.bus.peers.values()].filter(peer => peer.state !== "offline")).toHaveLength(0);
    expect(await op("hub_release_cut", { id: release.id, revision: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("host slot held") });
    expect(board.release(release.id)?.state).toBe("active");
    hostAllowed = true;
    expect(await op("hub_release_cut", { id: release.id, revision: 1 })).toMatchObject({ ok: true });
    expect(board.release(release.id)?.state).toBe("frozen");
    const status = (await person.request({ t: "status" })).status;
    const operation = { t: "recovery", operationId: "empty-upgrade", expectedInstanceId: status.instanceId, targetFeatures: status.features };
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    hostAllowed = false;
    daemon.bus.add({ id: "external-worker", state: "busy", start: async () => {}, stop: async () => {}, deliver: async () => {} });
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("recovery is not ready") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    daemon.bus.peers.delete("external-worker");
    daemon.bus.add({ id: "local", state: "busy", start: async () => {}, stop: async () => {}, deliver: async () => {} });
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("recovery is not ready") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    daemon.bus.peers.delete("local");
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: true, committed: true });
    await daemon.stopped;
  } finally { board?.close(); person?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
