import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { realPath } from "../src/hub/project.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class WaitingPeer extends BasePeer {
  async start() { this.setState("busy"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}

async function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-send-recipients-561-"))), stateDir = join(cwd, "state");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const daemon = await startDaemon({ cwd, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, agentDrift: false, snapshotClock: () => 0,
    config: { ...structuredClone(DEFAULT_CONFIG), batch_ms: 0, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
      inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, auto_start: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } });
  cleanup.push(() => daemon.stop());
  for (const id of ["claude", "kimi"]) {
    const peer = new WaitingPeer(id); daemon.bus.add(peer); await peer.start();
    cleanup.push(() => peer.stop());
  }
  const client = await ControlClient.connect(stateDir, { role: "console", projectRoot: cwd });
  cleanup.push(() => client.close());
  const published: Envelope[] = [];
  daemon.bus.tap(event => { if (event.t === "envelope") published.push(event.env); });
  const pending = (peer: string) => daemon.bus.pendingEnvelopes(peer).map(env => env.body);
  return { daemon, client, published, pending };
}

test("#963 a string recipient reaches only its named peer and valid arrays still deduplicate", async () => {
  const f = await fixture();
  expect(await f.client.request({ t: "send", body: "single recipient", to: "claude" })).toMatchObject({ t: "sent", ok: true, targets: ["claude"] });
  expect(f.pending("claude")).toContain("single recipient");
  expect(f.pending("kimi")).not.toContain("single recipient");
  expect(await f.client.request({ t: "send", body: "array recipient", to: ["claude", "claude"] })).toMatchObject({ ok: true, targets: ["claude"] });
  expect(f.pending("claude").filter(body => body === "array recipient")).toHaveLength(1);
  expect(f.pending("kimi")).not.toContain("array recipient");
});

test("#963 malformed recipient shapes are refused before any publication", async () => {
  const f = await fixture();
  const invalid = [null, "", 7, false, {}, { peer: "claude" }, [""], [null], [7], ["claude", null], ["claude", ""], ["claude", {}]];
  for (const [index, to] of invalid.entries()) {
    const before = f.published.length;
    expect(await f.client.request({ t: "send", body: `invalid ${index}`, to })).toMatchObject({ t: "sent", ok: false, error: "to must be an array of peer ids" });
    expect(f.published).toHaveLength(before);
    expect(f.pending("claude")).not.toContain(`invalid ${index}`);
    expect(f.pending("kimi")).not.toContain(`invalid ${index}`);
  }
});

test("#963 missing recipients and an empty array retain broadcast semantics", async () => {
  const f = await fixture();
  for (const [body, recipients] of [["omitted recipients", {}], ["empty recipients", { to: [] }]] as const) {
    const reply = await f.client.request({ t: "send", body, ...recipients });
    expect(reply.ok).toBe(true);
    expect([...reply.targets].sort()).toEqual(["claude", "kimi"]);
    expect(f.pending("claude")).toContain(body);
    expect(f.pending("kimi")).toContain(body);
  }
});

test("#963 reply inheritance stays targeted and malformed to cannot bypass refusal through reply_to", async () => {
  const f = await fixture();
  const question = newEnvelope("kimi", "question", { to: ["claude"] });
  f.daemon.bus.publish(question);
  expect(await f.client.request({ t: "send", body: "inherited reply", to: [], reply_to: question.id })).toMatchObject({ ok: true, targets: ["kimi"] });
  expect(f.pending("kimi")).toContain("inherited reply");
  expect(f.pending("claude")).not.toContain("inherited reply");
  const before = f.published.length;
  expect(await f.client.request({ t: "send", body: "invalid reply", to: null, reply_to: question.id })).toMatchObject({ ok: false, error: "to must be an array of peer ids" });
  expect(f.published).toHaveLength(before);
});
