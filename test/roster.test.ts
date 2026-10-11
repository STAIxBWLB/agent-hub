import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { KNOWN_PEERS } from "../src/hub/peer-catalog.ts";
import { newEnvelope, USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { realPath } from "../src/hub/project.ts";

async function legacyHub(root: string, enabled: boolean) {
  const stateDir = join(root, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ cwd: root, stateDir, projectId: "roster-legacy-project", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, batch_ms: 0, pi: { ...DEFAULT_CONFIG.pi, enabled, auto_start: false },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      omniroute: { ...DEFAULT_CONFIG.omniroute, urls: [] } } });
  const client = await ControlClient.connect(stateDir, { role: "console" });
  return { daemon, client, stateDir, async close() { client.close(); await daemon.stop(); } };
}

for (const enabled of [false, true]) test(`no roster preserves lazy status, start catalog and native hello admission with pi.enabled=${enabled} (#315)`, async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-legacy-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const hub = await legacyHub(root, enabled), peers: ControlClient[] = [];
  try {
    expect(Object.keys((await hub.client.request({ t: "status" })).status.peers)).toEqual([]);
    const url = new URL((await hub.client.request({ t: "ui" })).url);
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url.origin}${path}`, { method: "POST",
      headers: { origin: url.origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const cookie = (await post("/session", { ticket: url.hash.slice(1) })).headers.get("set-cookie")!.split(";")[0]!;
    const snapshot = await (await post("/snapshot", { after: 0 }, cookie)).json() as any;
    expect(snapshot.starts.map((row: any) => row.peer)).toEqual(KNOWN_PEERS.filter(peer => peer !== "pi" || enabled));
    // Claude and unrelated external ids use the existing channel; managed native ids stay reserved.
    for (const peer of KNOWN_PEERS.filter(peer => peer !== "claude")) {
      await expect(ControlClient.connect(hub.stateDir, { role: "peer", peer })).rejects.toMatchObject({ code: 4403 });
    }
    for (const peer of ["claude", "external"]) peers.push(await ControlClient.connect(hub.stateDir, { role: "peer", peer }));
    let status: any;
    for (let n = 0; n < 100; n++) {
      status = (await hub.client.request({ t: "status" })).status;
      if (status.peers.claude?.state === "idle" && status.peers.external?.state === "idle") break;
    }
    expect(status.peers.claude.state).toBe("idle"); expect(status.peers.external.state).toBe("idle");
    expect(Object.keys(status.peers).sort()).toEqual(["claude", "external"]);
  } finally {
    for (const peer of peers) peer.close(); await hub.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});

class OfflineLegacyPeer extends BasePeer {
  async deliver(_envs: Envelope[]) { throw new Error("an offline fixture is never dispatched"); }
  async start() {}
  async stop() { this.setState("offline"); }
}

test("no roster keeps a retained Pi queue row visible after restart even when Pi is disabled (#315)", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roster-retained-"))), previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = join(root, "home");
  const first = await legacyHub(root, true); let second: Awaited<ReturnType<typeof legacyHub>> | undefined;
  try {
    first.daemon.bus.add(new OfflineLegacyPeer("pi"));
    first.daemon.bus.publish(newEnvelope(USER, "retained work", { to: ["pi"] }));
    expect((await first.client.request({ t: "status" })).status.peers.pi.queued).toBe(1);
    await first.close(); second = await legacyHub(root, false);
    const status = (await second.client.request({ t: "status" })).status;
    expect(status.peers.pi).toMatchObject({ state: "offline", queued: 1 });
    expect(status.peers.pi.rostered).toBeUndefined(); // no new label in an unconfigured legacy project
    expect(second.daemon.bus.queueList("pi")).toHaveLength(1);
  } finally {
    await second?.close(); await first.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
  }
});
