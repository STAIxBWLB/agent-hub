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
