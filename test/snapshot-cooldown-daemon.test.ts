import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasePeer } from "../src/hub/peers.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { readEvents } from "../src/hub/events.ts";
import { SnapshotBudgetExceeded, SNAPSHOT_COOLDOWN_MS, snapshot, Turns } from "../src/hub/snapshots.ts";
import { realPath } from "../src/hub/project.ts";

class Peer extends BasePeer {
  readonly pullOnly = true;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver() {}
  begin() { this.setState("busy"); }
  finish() { this.setState("idle"); }
}
const io = () => new Promise<void>(resolve => setImmediate(resolve));

test("#1550 cooldown skips unknown boundaries and retries without losing later evidence", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-snapshot-cooldown-"))), stateDir = join(root, ".agenthub/state");
  const previous = { AGENTHUB_HOME: process.env.AGENTHUB_HOME, AMEM_HOME: process.env.AMEM_HOME };
  process.env.AGENTHUB_HOME = join(root, "home"); process.env.AMEM_HOME = join(root, "memory");
  let clock = 0, calls = 0, fail = true;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args]);
    expect(git("init", "-q").exitCode).toBe(0);
    writeFileSync(join(root, "file.txt"), "before\n");
    expect(git("add", "file.txt").exitCode).toBe(0); expect(git("commit", "-qm", "fixture").exitCode).toBe(0);
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      snapshotClock: () => clock, snapshot: (repo, budget) => { calls++; if (fail) throw new SnapshotBudgetExceeded(); return snapshot(repo, budget); },
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: true, keep: 20 }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    const peer = new Peer("kimi"); daemon.bus.add(peer); await peer.start();
    peer.begin(); await io(); peer.finish(); await io(); peer.begin(); await io();
    expect(calls).toBe(3);
    peer.finish(); await io(); peer.begin(); await io(); peer.finish(); await io();
    expect(calls).toBe(3);
    const turns = new Turns(join(stateDir, "hub.db"), true);
    try {
      const skipped = turns.list("kimi");
      expect(skipped.some(turn => turn.start_tree === null && turn.end_tree === null && turn.unobserved === undefined)).toBe(true);
      const events = readEvents(join(stateDir, "events.jsonl"));
      expect(events.filter(event => event.type === "turn_end").every(event => !("files" in event))).toBe(true);
      expect(events.filter(event => event.type === "conflict")).toEqual([]);
    } finally { turns.close(); }
    expect(readFileSync(join(stateDir, "hub.log"), "utf8").match(/snapshot unavailable: snapshot burst budget exhausted/g)).toHaveLength(1);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).toContain("inspect snapshots.enabled");
    clock += SNAPSHOT_COOLDOWN_MS;
    peer.begin(); await io(); expect(calls).toBe(4); peer.finish(); await io(); expect(calls).toBe(4);
    clock += SNAPSHOT_COOLDOWN_MS; fail = false;
    peer.begin(); await io(); writeFileSync(join(root, "file.txt"), "after\n"); peer.finish(); await io();
    expect(calls).toBe(6);
    const verified = new Turns(join(stateDir, "hub.db"), true);
    try { expect(verified.list("kimi")[0]).toMatchObject({ changed: ["file.txt"] }); } finally { verified.close(); }
    expect(readFileSync(join(stateDir, "hub.log"), "utf8").match(/snapshot unavailable: snapshot burst budget exhausted/g)).toHaveLength(2);
  } finally {
    await daemon?.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1550 several boundaries in one burst count once and produce no cooldown log", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-snapshot-cooldown-"))), stateDir = join(root, ".agenthub/state");
  const previous = { AGENTHUB_HOME: process.env.AGENTHUB_HOME, AMEM_HOME: process.env.AMEM_HOME };
  process.env.AGENTHUB_HOME = join(root, "home"); process.env.AMEM_HOME = join(root, "memory");
  let clock = 0, calls = 0, fail = true;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args]);
    expect(git("init", "-q").exitCode).toBe(0);
    writeFileSync(join(root, "file.txt"), "before\n");
    expect(git("add", "file.txt").exitCode).toBe(0); expect(git("commit", "-qm", "fixture").exitCode).toBe(0);
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false,
      snapshotClock: () => clock, snapshot: (repo, budget) => { calls++; if (fail) throw new SnapshotBudgetExceeded(); return snapshot(repo, budget); },
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, snapshots: { enabled: true, keep: 20 }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false } } });
    const peer = new Peer("kimi"); daemon.bus.add(peer); await peer.start();
    peer.begin(); peer.finish(); peer.begin(); peer.finish();
    expect(calls).toBe(4);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain("snapshot unavailable: snapshot burst budget exhausted");
    await io(); peer.begin(); peer.finish();
    expect(calls).toBe(6);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8")).not.toContain("snapshot unavailable: snapshot burst budget exhausted");
    await io(); peer.begin(); peer.finish();
    expect(calls).toBe(7);
    expect(readFileSync(join(stateDir, "hub.log"), "utf8").match(/snapshot unavailable: snapshot burst budget exhausted/g)).toHaveLength(1);
  } finally {
    await daemon?.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
