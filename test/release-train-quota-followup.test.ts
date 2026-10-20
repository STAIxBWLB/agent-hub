import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { ControlClient } from "../src/hub/control-client.ts";

async function rig(softLimit: number, run: (r: {
  daemon: Awaited<ReturnType<typeof startDaemon>>; person: ControlClient; board: Board; id: number;
  cut: () => Promise<any>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ahub-train-quota-")), stateDir = join(root, "state");
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, person: ControlClient | undefined, board: Board | undefined;
  try {
    mkdirSync(join(root, ".agenthub")); writeFileSync(join(root, ".agenthub/sdlc.toml"), 'mode = "advise"\n');
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      releaseHostAdmission: async () => ({ admitted: true, current: () => true, close: async () => {} }),
      config: { ...DEFAULT_CONFIG, batch_ms: 0, budget: { ...DEFAULT_CONFIG.budget, kimi_tokens_5h: softLimit },
        instances: { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } },
        roster: { claude: true, "claude-review": true, codex: true, kimi: true, qwen: true, jcode: true, pi: true, local: false },
        memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: false, keep: 1 },
        inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    person = await ControlClient.connect(stateDir, { role: "console" });
    board = new Board(join(stateDir, "hub.db"));
    const release = board.newRelease("quota", "Train", 1);
    board.updateRelease(release.id, { state: "active", train: { history: [] } }, 0);
    const task = board.propose("user", { title: "fix", class: "implement" });
    board.update(task.id, "user", "accepted", { state: "in_progress" }); board.update(task.id, "user", "approved", { state: "approved" });
    board.plan(task.id, "user", { release: release.id }, 0);
    await run({ daemon, person, board, id: release.id, cut: () => person!.request({ t: "task", op: "hub_release_cut", args: { id: release.id, revision: 1 } }) });
  } finally { board?.close(); person?.close(); await daemon?.stop(); rmSync(root, { recursive: true, force: true }); }
}

const idle = (id: string) => ({ id, state: "idle" as const, start: async () => {}, stop: async () => {}, deliver: async () => {} });

test("source-less builtins allow cut and recovery, real readers still need evidence, manual holds remain binding", async () => {
  await rig(0, async ({ daemon, person, board, id, cut }) => {
    for (const peer of ["kimi", "pi", "qwen", "jcode"]) daemon.bus.add(idle(peer));
    daemon.bus.add(idle("claude"));
    expect(await cut()).toMatchObject({ ok: false, error: expect.stringContaining("claude: quota window unknown") });
    daemon.bus.peers.delete("claude");
    expect(await person.request({ t: "pause", peer: "kimi" })).toMatchObject({ ok: true });
    const paused = await cut();
    expect(paused.error).toContain("ahub resume");
    expect(paused).toMatchObject({ ok: false, error: expect.stringContaining("manual pause") });
    expect(await person.request({ t: "resume", peer: "kimi" })).toMatchObject({ ok: true });
    expect(await cut()).toMatchObject({ ok: true });
    expect(board.release(id)?.state).toBe("frozen");
    expect(await person.request({ t: "pause", peer: "kimi" })).toMatchObject({ ok: true });
    const status = (await person.request({ t: "status" })).status;
    const operation = { t: "recovery", operationId: "source-less", expectedInstanceId: status.instanceId, targetFeatures: status.features };
    expect(await person.request({ ...operation, op: "prepare" })).toMatchObject({ ok: true });
    expect(await person.request({ ...operation, op: "commit" })).toMatchObject({ ok: true, committed: true });
    await daemon.stopped;
  });
});

test("enabled soft quota requires a reading and manual evidence can admit the train", async () => {
  await rig(1000, async ({ daemon, person, cut }) => {
    daemon.bus.add(idle("kimi"));
    const unknown = await cut();
    expect(unknown.error).toContain("ahub budget set");
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("kimi: quota window unknown") });
    expect(await person.request({ t: "budget", set: { peer: "kimi", used: 0.1, resetsInMs: 60_000 } })).toMatchObject({ ok: true });
    expect(await cut()).toMatchObject({ ok: true });
  });
});

test("a recorded account pause remains binding without a native quota source", async () => {
  await rig(0, async ({ daemon, person, cut }) => {
    daemon.bus.add(idle("pi"));
    expect(await person.request({ t: "budget", set: { peer: "pi", used: 0.99, resetsInMs: 60_000 } })).toMatchObject({ ok: true });
    let paused = false;
    for (let i = 0; i < 40 && !paused; i++) {
      paused = !!(await person.request({ t: "budget" })).budget.pi?.paused;
      if (!paused) await Bun.sleep(5);
    }
    expect(paused).toBe(true);
    const deferred = await cut();
    expect(deferred.error).toContain("ahub budget resume pi");
    expect(deferred.error).toContain("pi: no quota source");
    expect(deferred).toMatchObject({ ok: false, error: expect.stringContaining("paused quota window") });
  });
});

test("a headless reviewer retains its shared account quota source when the base peer is offline", async () => {
  await rig(0, async ({ daemon, person, cut }) => {
    daemon.bus.add(idle("claude-review"));
    expect(await cut()).toMatchObject({ ok: false, error: expect.stringContaining("claude-review: quota window unknown") });
    expect(await person.request({ t: "budget", set: { peer: "claude-review", used: 0.1, resetsInMs: 60_000 } })).toMatchObject({ ok: true });
    expect(await cut()).toMatchObject({ ok: true });
  });
});
