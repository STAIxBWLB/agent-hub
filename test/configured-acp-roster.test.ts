import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon, type HubConfig } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { isAcpPeer } from "../src/adapters/acp.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import type { Envelope } from "../src/hub/envelope.ts";

async function until(check: () => boolean | Promise<boolean>, label: string) {
  for (let attempt = 0; attempt < 500; attempt++) { if (await check()) return; await Bun.sleep(10); }
  expect(await check(), label).toBe(true);
}
class Replacement extends BasePeer {
  readonly received: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[], deliveryId?: string) {
    this.setState("busy"); this.received.push(...envs);
    if (deliveryId) { this.delivery({ id: deliveryId, state: "accepted" }); this.delivery({ id: deliveryId, state: "completed" }); }
    this.setState("idle");
  }
}
async function fixture(extra: boolean) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-configured-roster-"))), stateDir = join(root, "state"), home = join(root, "home"), peer = extra ? "fixture-worker" : "fixture";
  const oldHome = process.env.HOME, oldHubHome = process.env.AGENTHUB_HOME;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, client: ControlClient | undefined, actor: ControlClient | undefined;
  const close = async () => {
    try { actor?.close(); client?.close(); await daemon?.stop(); }
    finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldHubHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = oldHubHome;
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    mkdirSync(home); mkdirSync(join(root, ".agenthub")); process.env.HOME = home; process.env.AGENTHUB_HOME = join(home, "hub");
    const git = (...args: string[]) => {
      const result = hubGitSync(["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("configured roster fixture git failed");
    };
    git("init", "-q"); writeFileSync(join(root, ".gitignore"), ".agenthub/\nstate/\nhome/\n.worktrees/\n"); writeFileSync(join(root, "owned.txt"), "fixture\n");
    git("add", ".gitignore", "owned.txt"); git("commit", "-qm", "fixture");
    const worktree = join(root, ".worktrees", peer);
    if (extra) git("worktree", "add", "-b", "fixture-owner", worktree, "HEAD");
    const instances: NonNullable<HubConfig["instances"]> = extra ? { [peer]: { kind: "fixture", roles: ["implementer"], start_mode: "headless", worktree } } : {};
    const adapters: NonNullable<HubConfig["adapters"]> = { fixture: { transport: "acp", command: process.execPath, args: [join(import.meta.dir, "fakes/acp-server.ts"), "--agent-name", "Fixture ACP", "--agent-version", "1"], displayName: "Fixture ACP", roles: ["implementer"], identity: { name: "Fixture ACP", version: "1" }, permission: { ask: "default" } } };
    const local = { adapters, instances, roster: { fixture: !extra, ...(extra ? { [peer]: true } : {}), codex: true } };
    writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify(local));
    const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8").replaceAll('pi_backend = "mlx"', 'pi_backend = "dgx"').replace('[classes.implement]\npeers = ["pi", "local", "codex", "kimi"]', `[classes.implement]\npeers = ${JSON.stringify([peer, "codex"])}`);
    writeFileSync(join(root, ".agenthub/routing.toml"), routing);
    daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, ...local, batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
    client = await ControlClient.connect(stateDir, { role: "console", projectRoot: root });
    const replacement = new Replacement("codex"); await replacement.start(); daemon.bus.add(replacement);
    const started = await client.request({ t: "start", peer });
    if (started.ok !== true) throw new Error(`configured roster fixture native start failed: ${started.error}`);
    actor = await ControlClient.connect(stateDir, { role: "tools", peer, projectRoot: root });
    return { root, peer, daemon, client, actor, replacement, close };
  } catch (error) { await close(); throw error; }
}

for (const extra of [false, true]) test(`configured ${extra ? "instance" : "kind"} roster removal previews, confirms, withdraws approval, stops and hands off tasks`, async () => {
  const f = await fixture(extra);
  try {
    const owner = f.daemon.bus.peers.get(f.peer);
    if (!isAcpPeer(owner)) throw new Error("configured ACP fixture owner missing");
    const proposed = await f.client.request({ t: "task", op: "hub_task_propose", args: { title: "configured roster work", class: "implement", owner: f.peer, refs: { paths: ["owned.txt"] } } });
    expect(proposed.ok).toBe(true);
    const id = Number(proposed.text.match(/task #(\d+)/)?.[1]); expect(Number.isSafeInteger(id)).toBe(true);
    expect((await f.actor.request({ t: "task", op: "hub_task_accept", args: { id } })).ok).toBe(true);
    await until(() => owner.state === "idle" && !f.daemon.bus.hasInFlight(f.peer), "configured owner completed assignment notice");
    const key = `roster.${f.peer}`, preview = await f.client.request({ t: "settings_preview", key, value: false });
    expect(preview.ok).toBe(true); expect(preview.lines.join("\n")).toContain(`${f.peer}: on -> off roster`);
    expect(preview.confirm).toBe(f.peer); expect(preview.lines.join("\n")).toContain("owner offered to codex");
    expect((await f.client.request({ t: "settings_set", key, value: false })).ok).toBe(false);
    expect(f.daemon.bus.isRostered(f.peer)).toBe(true); expect(owner.state).toBe("idle");

    expect((await f.client.request({ t: "send", to: [f.peer], body: "PERMISSION ANNOUNCED configured-roster-removal" })).ok).toBe(true);
    let pendingId: string | undefined;
    await until(async () => {
      const snapshot = await f.client.request({ t: "ui_snapshot" });
      pendingId = snapshot.permissions.find((row: { peer: string }) => row.peer === f.peer)?.id;
      return typeof pendingId === "string" && owner.state === "busy";
    }, "configured owner pending approval");
    expect((await f.client.request({ t: "settings_set", key, value: false, confirm: f.peer })).ok).toBe(false);
    expect(f.daemon.bus.isRostered(f.peer)).toBe(true);
    const removed = await f.client.request({ t: "settings_set", key, value: false, confirm: f.peer, now: true });
    expect(removed).toMatchObject({ ok: true });
    expect(removed.handoff).toEqual(expect.arrayContaining([expect.objectContaining({ id, role: "owner", to: "codex" })]));
    expect(f.daemon.bus.isRostered(f.peer)).toBe(false); expect(owner.state).toBe("offline"); expect(owner.pendingOwnedProcess).toBe(false);
    const snapshot = await f.client.request({ t: "ui_snapshot" });
    expect(snapshot.permissions.some((row: { id: string }) => row.id === pendingId)).toBe(false);
    const shown = await f.client.request({ t: "task", op: "task_show", args: { id } });
    expect(JSON.parse(shown.text).owner).toBe("codex");
    await until(() => f.replacement.received.some(env => env.refs?.task === String(id)), "replacement receives configured task handoff");
    expect((await f.client.request({ t: "start", peer: f.peer })).ok).toBe(false);
    const stored = JSON.parse(readFileSync(join(f.root, ".agenthub/config.local.json"), "utf8"));
    expect(stored.roster[f.peer]).toBe(false);
  } finally { await f.close(); }
}, 20_000);
