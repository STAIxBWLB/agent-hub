import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BasePeer } from "../src/hub/peers.ts";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Turns } from "../src/hub/snapshots.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import type { Envelope } from "../src/hub/envelope.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
class PlainPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
async function fixture(configured = false) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-peer-revert-"))), stateDir = join(cwd, ".agenthub", "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  for (const args of [["init", "-q"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]]) {
    const out = hubGitSync(["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(out.status, out.stderr).toBe(0);
  }
  const id = configured ? "fixture" : "codex";
  const adapters: NonNullable<HubConfig["adapters"]> = configured ? { fixture: { transport: "acp", command: "fixture-never-started", args: [], displayName: "Fixture", roles: ["implementer"] } } : {};
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, snapshotClock: () => 0,
    config: { ...DEFAULT_CONFIG, adapters, batch_ms: 0, roster: { ...DEFAULT_CONFIG.roster, [id]: true }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanup.push(() => daemon.stop());
  const client = await ControlClient.connect(stateDir, { role: "console" }); cleanup.push(() => client.close());
  const owner = new PlainPeer(id); daemon.bus.add(owner); await owner.start();
  const writer = new Turns(join(stateDir, "hub.db"));
  try { writer.begin("fixture-turn", id, undefined); writer.native("fixture-turn", "native-fixture-turn"); writer.end("fixture-turn", undefined, [], 20); }
  finally { writer.close(); }
  const revert = () => client.request({ t: "task", op: "turn_revert", args: { turn: "fixture-turn" } });
  return { daemon, client, owner, id, revert };
}

test("#625 a fixed builtin plain peer reverts through its port while delivery is held", async () => {
  const f = await fixture(), calls: { turn: string; held: string }[] = [];
  Object.defineProperty(f.owner, "revertTurn", { value: async (turn: string) => { calls.push({ turn, held: f.daemon.bus.stateOf(f.id) }); } });
  expect(await f.revert()).toMatchObject({ ok: true, text: "Codex's conversation no longer holds turn fixture-turn" });
  expect(calls).toEqual([{ turn: "native-fixture-turn", held: "paused" }]);
  expect(f.daemon.bus.stateOf(f.id)).toBe("idle");
});

test("#625 a rejected generic native revert still releases the original delivery hold", async () => {
  const f = await fixture(); let called = 0;
  Object.defineProperty(f.owner, "revertTurn", { value: async () => { called++; throw new Error("fixture native revert refused"); } });
  expect(await f.revert()).toMatchObject({ ok: false, error: "fixture native revert refused" });
  expect(called).toBe(1); expect(f.daemon.bus.stateOf(f.id)).toBe("idle");
});

test("#625 absence of a revert port keeps the existing unattached refusal", async () => {
  const f = await fixture();
  expect(await f.revert()).toMatchObject({ ok: false, error: "codex is not attached" });
  expect(f.daemon.bus.stateOf(f.id)).toBe("idle");
});

test("#625 a configured peer cannot expose its revert getter through the native operation", async () => {
  const f = await fixture(true); let reads = 0;
  Object.defineProperty(f.owner, "revertTurn", { get: () => { reads++; throw new Error("foreign native proof getter must not be read"); } });
  expect(await f.revert()).toMatchObject({ ok: false, error: "turn fixture-turn has no Codex conversation turn to revert" });
  expect(reads).toBe(0); expect(f.daemon.bus.stateOf(f.id)).toBe("idle");
});
