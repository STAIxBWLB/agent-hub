import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { PeerAdapter } from "../src/hub/peers.ts";

const idlePeer = (id: string): PeerAdapter => ({ id, state: "idle", start: async () => {}, stop: async () => {}, deliver: async () => {} });
test("daemon release tools preserve planner identity and defer unknown peer quota before freezing", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-train-daemon-")), stateDir = join(root, "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, peer: ControlClient | undefined, closed = 0, board: Board | undefined, hostAllowed = true, closeFails = false, duringAdmission: (() => Promise<void>) | undefined;
  try {
    mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "advise"\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, switchyardPort: 0,
      releaseHostAdmission: async () => { await duringAdmission?.(); return { admitted: hostAllowed, ...(hostAllowed ? {} : { reason: "host slot held" }), current: () => true, close: async () => { closed++; if (closeFails) throw new Error("cleanup failed"); } }; },
      config: { ...DEFAULT_CONFIG, roles: { claude: ["planner"], codex: ["implementer"] }, batch_ms: 0,
        roster: { claude: true, codex: true, kimi: false, qwen: false, jcode: false, pi: false, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    peer = await ControlClient.connect(stateDir, { role: "tools", peer: "codex" });
    const op = (name: string, args: object) => person!.request({ t: "task", op: name, args });
    const created = await op("hub_release_new", { name: "train", goal: "Ship approved work", order: 1 });
    expect(created.ok).toBe(true); const release = JSON.parse(created.text);
    expect(await op("hub_release_configure", { id: release.id, revision: 0, cut: null })).toMatchObject({ ok: false, error: expect.stringContaining("positive safe UTC") });
    const future = JSON.parse((await op("hub_release_new", { name: "future", goal: "Next train", order: 2 })).text);
    expect(await op("hub_release_configure", { id: future.id, revision: 0 })).toMatchObject({ ok: true });
    const futureStatus = (await person.request({ t: "status" })).status;
    expect(await person.request({ t: "recovery", op: "inspect", expectedInstanceId: futureStatus.instanceId, targetFeatures: futureStatus.features.filter((feature: string) => feature !== "release_trains") })).toMatchObject({ ok: true });
    board = new Board(join(stateDir, "hub.db"));
    const task = board.propose("user", { title: "fix", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress" }); board.update(task.id, "user", "done", { state: "approved" });
    expect(await op("hub_release_assign", { id: task.id, revision: 0, release: release.id, reason: "scope" })).toMatchObject({ ok: true });
    expect(await op("hub_release_configure", { id: release.id, revision: 0, state: "active" })).toMatchObject({ ok: true });
    expect(await peer.request({ t: "task", op: "hub_release_cut", args: { id: release.id, revision: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("planner") });
    const activeStatus = (await person.request({ t: "status" })).status;
    expect(activeStatus.features).toContain("release_trains");
    expect(await person.request({ t: "recovery", op: "prepare", operationId: "old-active", expectedInstanceId: activeStatus.instanceId, targetFeatures: activeStatus.features.filter((feature: string) => feature !== "release_trains") })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    expect((await person.request({ t: "status" })).status.recovery?.operationId).toBeUndefined();
    expect(closed).toBe(0);
    daemon.bus.add(idlePeer("external-worker"));
    expect(await op("hub_release_cut", { id: release.id, revision: 1 })).toMatchObject({ ok: false, error: expect.stringContaining("quota window unknown") });
    expect(board.release(release.id)?.state).toBe("active");
    daemon.bus.peers.delete("external-worker"); daemon.bus.add(idlePeer("local"));
    expect(await op("hub_release_cut", { id: release.id, revision: 1 })).toMatchObject({ ok: true });
    const report = await op("hub_release_report", { id: release.id });
    expect(JSON.parse(report.text).readiness.tasks).toEqual([{ id: task.id, state: "approved", ready: true }]);
    expect(board.release(release.id)?.state).toBe("frozen"); expect(closed).toBe(2);
    const status = (await person.request({ t: "status" })).status;
    const operation = { t: "recovery", operationId: "train-upgrade", expectedInstanceId: status.instanceId, targetFeatures: status.features };
    const oldTarget = { ...operation, targetFeatures: status.features.filter((feature: string) => feature !== "release_trains") };
    expect(await person.request({ ...oldTarget, op: "inspect" })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    expect(await person.request({ ...oldTarget, op: "prepare" })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    expect((await person.request({ t: "status" })).status.recovery?.operationId).toBeUndefined();
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    expect(await person.request({ ...oldTarget, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("target lacks release_trains") });
    hostAllowed = false;
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("host slot held") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    hostAllowed = true;
    duringAdmission = async () => { expect(await person!.request({ ...operation, op: "abort" })).toMatchObject({ ok: true }); };
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("window changed") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    duringAdmission = undefined;
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    duringAdmission = async () => { daemon!.bus.add({ ...idlePeer("local"), state: "busy" }); };
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: false, error: expect.stringContaining("window changed") });
    expect((await person.request({ t: "status" })).status.stopping).toBe(false);
    daemon.bus.add(idlePeer("local"));
    expect(await person.request({ ...operation, op: "abort" })).toMatchObject({ ok: true });
    duringAdmission = undefined; closeFails = true;
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: true, committed: true });
    await daemon.stopped;

  } finally { board?.close(); peer?.close(); person?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
