import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(_envs: Envelope[]) {}
}
test("board snapshot derives legend from live status and only authenticated console can pull or assign (#263)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-board-ui-"));
  const daemon = await startDaemon({ cwd: root, stateDir: join(root, "state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, batch_ms: 0 } });
  let console_: ControlClient | undefined, tools: ControlClient | undefined;
  try {
    const peer = new Peer("codex"); daemon.bus.add(peer); await peer.start();
    console_ = await ControlClient.connect(join(root, "state"), { role: "console" });
    tools = await ControlClient.connect(join(root, "state"), { role: "tools", peer: "codex" });
    const opened = await console_.request({ t: "ui" }), url = new URL(opened.url), origin = url.origin;
    const session = await fetch(origin + "/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const post = async (path: string, body: unknown = {}) => {
      const response = await fetch(origin + "/" + path, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      return response.json() as Promise<any>;
    };
    expect(await post("action", { action: "propose", title: "future", class: "implement", owner: "codex", backlog: true })).toMatchObject({ ok: true });
    const before = await post("snapshot");
    expect(before.boardCapabilities).toEqual({ backlog: true });
    expect(before.tasks[0]).toMatchObject({ state: "backlog", owner: null, reserved: "codex" });
    expect(before.boardLegend.find((row: any) => row.peer === "codex")).toMatchObject({ state: before.status.peers.codex.state, wip: 0, activeTasks: [], permissionMode: "ask" });
    for (const action of ["backlog_pull", "backlog_return", "assign"]) expect(await tools.request({ t: "ui_action", instanceId: before.instanceId, action: { action, id: 1, peer: "codex" } })).toMatchObject({ ok: false });
    expect((await post("snapshot")).tasks[0].state).toBe("backlog");
    expect(await post("action", { action: "backlog_pull", id: 1 })).toMatchObject({ ok: true });
    expect(await tools.request({ t: "task", op: "hub_task_accept", args: { id: 1 } })).toMatchObject({ ok: true });
    const active = await post("snapshot");
    expect(active.boardLegend.find((row: any) => row.peer === "codex")).toMatchObject({ wip: 1, activeTasks: [1], state: active.status.peers.codex.state });
    expect(await post("action", { action: "backlog_return", id: 1 })).toMatchObject({ ok: false });
    const marker = "patient 900101-1234567";
    expect(await post("action", { action: "propose", title: marker, class: "implement", backlog: true })).toMatchObject({ ok: true });
    const masked = await post("snapshot");
    expect(masked.tasks[1]).toMatchObject({ title: "[pii]", detail: "[pii]", state: "backlog" });
    expect(JSON.stringify(masked)).not.toContain(marker);
  } finally { tools?.close(); console_?.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);


test("dashboard release actions forward public ids through the authenticated HTTP path (#263)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-release-dashboard-")), stateDir = join(root, "state");
  const daemon = await startDaemon({ cwd: root, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, batch_ms: 0 } });
  const person = await ControlClient.connect(stateDir, { role: "console" });
  try {
    const opened = await person.request({ t: "ui" }), url = new URL(opened.url), origin = url.origin;
    const session = await fetch(origin + "/session", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ticket: url.hash.slice(1) }) });
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    const post = async (path: string, body: unknown = {}) => (await fetch(origin + "/" + path, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; releases: { id: number; name: string; state: string; revision: number; plannedStart: number | null; cut: number | null; ship: number | null }[] }>;
    expect(await post("action", { action: "release_new", name: "next", goal: "safe goal", order: 0 })).toMatchObject({ ok: true });
    const snapshot = await post("snapshot"), id = snapshot.releases[0]!.id;
    expect(await post("action", { action: "release_change", id, revision: 0, fields: { state: "active" } })).toMatchObject({ ok: true });
    expect(await post("action", { action: "release_change", id, revision: 1, fields: { plannedStart: 100, cut: 200, ship: 300 } })).toMatchObject({ ok: true });
    expect(await post("action", { action: "release_change", id, revision: 2, fields: { state: "frozen" } })).toMatchObject({ ok: true });
    expect(await post("action", { action: "release_change", id, revision: 3, fields: { state: "shipped" } })).toMatchObject({ ok: true });
    expect((await post("snapshot")).releases[0]).toMatchObject({ id, state: "shipped", plannedStart: 100, cut: 200, ship: 300, revision: 4 });
    expect(await post("action", { action: "release_new", name: "later", goal: "safe goal", order: 1 })).toMatchObject({ ok: true });
    const later = (await post("snapshot")).releases.find((release: { name: string }) => release.name === "later");
    expect(await post("action", { action: "release_change", id: later!.id, revision: 0, fields: { state: "dropped" } })).toMatchObject({ ok: true });
  } finally { person.close(); await daemon.stop(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
