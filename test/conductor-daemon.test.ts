import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ConductorHolds } from "../src/hub/conductor.ts";
import { CONDUCTOR_TOOL_NAMES } from "../src/hub/hub-tools.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { HUB, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { readEvents } from "../src/hub/events.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
class QuietPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[], id?: string) { if (id) this.delivery({ id, state: "completed" }); }
}
async function fixture(conductor: "claude" | "codex" = "claude", feed: "off" | "all" = "off") {
  const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-daemon-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const routing = readFileSync(join(import.meta.dir, "../templates/routing.toml"), "utf8")
    .replace(/^pii_patterns = .*$/m, 'pii_patterns = ["PRIVATE-MARKER"]')
    .replace(/^pi_backend = "mlx"$/gm, 'pi_backend = "dgx"');
  writeFileSync(join(dir, ".agenthub", "routing.toml"), routing);
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0, permissionTimeoutMs: 300, config: {
    ...DEFAULT_CONFIG, roles: { ...DEFAULT_CONFIG.roles, [conductor]: ["conductor"] }, conductor: { feed, approval_wait_s: 0 }, batch_ms: 0,
    memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
    kimi_cmd: ["bun", join(import.meta.dir, "fakes/acp-server.ts")],
  } });
  cleanup.push(() => daemon.stop());
  const connect = async (peer?: string) => {
    const client = await ControlClient.connect(dir, peer ? { role: "tools", peer } : { role: "console" });
    cleanup.push(() => client.close()); return client;
  };
  return { dir, daemon, connect, lead: await connect(conductor), console_: await connect() };
}

test("Claude and Codex tools callers need their explicit conductor role, including unlisted peers", async () => {
  for (const id of ["claude", "codex"] as const) {
    const f = await fixture(id);
    expect((await f.lead.request({ t: "task", op: "hub_status", args: {} })).ok).toBe(true);
    const other = await f.connect("unlisted");
    for (const op of CONDUCTOR_TOOL_NAMES) expect((await other.request({ t: "task", op, args: {} })).ok).toBe(false);
    const preview = await f.lead.request({ t: "task", op: "hub_peer_start", args: { peer: "codex" } });
    expect(preview.ok).toBe(true); expect(JSON.parse(preview.text).command).toBe("ahub codex");
    expect(f.daemon.bus.peers.has("codex")).toBe(false);
    expect(readEvents(join(f.dir, "events.jsonl")).some(e => e.type === "conduct" && e.peer === id && e.action === "peer_start")).toBe(true);
  }
});

test("only accepted supervision followed by successful native completion counts, never failure-to-idle", async () => {
  class NativePeer extends BasePeer {
    deliveryId = "";
    async start() { this.setState("idle"); }
    async stop() { this.setState("offline"); }
    async deliver(_envs: Envelope[], id?: string) { this.setState("busy"); this.deliveryId = id!; this.delivery({ id: id!, state: "accepted" }); }
    finish(failed: boolean) {
      // Codex can go idle before emitting its failed receipt in the same stack.
      this.setState("idle");
      this.delivery({ id: this.deliveryId, state: failed ? "needs_review" : "completed" });
    }
  }
  for (const failed of [true, false]) {
    const f = await fixture("codex", "all");
    const peer = new NativePeer("codex"); f.daemon.bus.add(peer); await peer.start();
    f.daemon.bus.publish(newEnvelope(HUB, "supervision marker", { to: ["codex"], kind: "task", refs: { supervision: true, supervisionKey: "supervision:codex:fixture" } }));
    for (let n = 0; n < 100 && !peer.deliveryId; n++) await Bun.sleep(5);
    expect(peer.deliveryId).not.toBe("");
    expect(readEvents(join(f.dir, "events.jsonl")).filter(e => e.type === "supervision_turn")).toHaveLength(0);
    peer.finish(failed); await Bun.sleep(10);
    const counted = readEvents(join(f.dir, "events.jsonl")).filter(e => e.type === "supervision_turn");
    expect(counted).toHaveLength(failed ? 0 : 1);
    if (!failed) expect(counted[0]).not.toHaveProperty("tokens");
  }
});

test("conductor release preserves human holds; human resume can clear a departed conductor's hold", async () => {
  const f = await fixture();
  const peer = new QuietPeer("pi"); f.daemon.bus.add(peer); await peer.start();
  const tool = (op: string) => f.lead.request({ t: "task", op, args: { peer: "pi" } });
  expect((await tool("hub_peer_hold")).ok).toBe(true);
  expect((await f.console_.request({ t: "resume", peer: "pi" })).ok).toBe(true);
  expect((await tool("hub_peer_hold")).ok).toBe(true);
  expect((await f.console_.request({ t: "pause", peer: "pi" })).ok).toBe(true);
  expect((await tool("hub_peer_release")).ok).toBe(true);
  expect(f.daemon.bus.isPaused("pi")).toBe(true);
  expect((await f.console_.request({ t: "resume", peer: "pi" })).ok).toBe(true);
  expect(f.daemon.bus.isPaused("pi")).toBe(false);
  const holds = new ConductorHolds(join(f.dir, "hub.db"));
  try {
    holds.hold("pi", "codex"); expect((await tool("hub_peer_release")).ok).toBe(false);
    expect((await f.console_.request({ t: "resume", peer: "pi" })).ok).toBe(true);
    expect(holds.has("pi")).toBe(false);
  }
  finally { holds.close(); }
});

test("ordinary peer task show and conductor task show redact PII text and history", async () => {
  const f = await fixture();
  const created = await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "PRIVATE-MARKER title", detail: "private detail", class: "implement" } });
  expect(created.ok).toBe(true);
  const peer = await f.connect("unlisted");
  for (const [client, op] of [[peer, "task_show"], [f.lead, "hub_task_show"]] as const) {
    const result = await client.request({ t: "task", op, args: { id: 1 } });
    expect(result.ok).toBe(true); expect(result.text).not.toContain("PRIVATE-MARKER"); expect(result.text).not.toContain("private detail");
    expect(JSON.parse(result.text).title).toBe("[pii]");
  }
});

test("existing conductor task mutations get one ids-only conduct audit; task list polling gets none", async () => {
  const f = await fixture();
  const result = await f.lead.request({ t: "task", op: "hub_task_propose", args: { title: "AUDIT-PRIVATE-TITLE", detail: "AUDIT-PRIVATE-BODY", class: "implement" } });
  expect(result.ok).toBe(true);
  const events = () => readEvents(join(f.dir, "events.jsonl")).filter(e => e.type === "conduct");
  expect(events()).toHaveLength(1); expect(events()[0]).toMatchObject({ peer: "claude", action: "task_propose", task: 1 });
  expect(JSON.stringify(events())).not.toContain("AUDIT-PRIVATE");
  await f.lead.request({ t: "task", op: "hub_task_list", args: {} });
  expect(events()).toHaveLength(1);
});

test("startup refuses two conductors and new hello refreshes only roles/feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-conductor-reload-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const file = join(dir, ".agenthub", "config.json");
  const initial = { roles: { claude: ["conductor"] }, conductor: { feed: "off" }, memory: { enabled: false }, inference: { enabled: false }, mlx: { enabled: false } };
  writeFileSync(file, JSON.stringify({ ...initial, roles: { claude: ["conductor"], codex: ["conductor"] } }));
  await expect(startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 })).rejects.toThrow("at most one");
  writeFileSync(file, JSON.stringify(initial));
  const daemon = await startDaemon({ cwd: dir, stateDir: dir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 }); cleanup.push(() => daemon.stop());
  const lead = await ControlClient.connect(dir, { role: "tools", peer: "claude" }); cleanup.push(() => lead.close());
  expect((await lead.request({ t: "task", op: "hub_status", args: {} })).ok).toBe(true);
  writeFileSync(file, JSON.stringify({ ...initial, roles: { claude: [] }, mlx: "invalid unrelated new value" }));
  const reconnected = await ControlClient.connect(dir, { role: "tools", peer: "claude" }); cleanup.push(() => reconnected.close());
  expect((await reconnected.request({ t: "task", op: "hub_status", args: {} })).ok).toBe(false);
});

test("permission console answer and expiry close the card with ids-only surface/latency audit", async () => {
  const f = await fixture();
  const pushes: any[] = [];
  f.console_.onPush = msg => pushes.push(msg); f.console_.send({ t: "tail" });
  expect((await f.console_.request({ t: "start", peer: "kimi" })).ok).toBe(true);
  await f.console_.request({ t: "send", to: ["kimi"], body: "PERMISSION" });
  for (let n = 0; n < 100 && !pushes.some(p => p.t === "permission"); n++) await Bun.sleep(5);
  const card = pushes.find(p => p.t === "permission"); expect(card).toBeDefined(); expect(card.expiresAt).toBeGreaterThan(card.createdAt);
  const status = await f.lead.request({ t: "task", op: "hub_status", args: {} });
  const publicApproval = JSON.parse(status.text).approvals[0]; expect(Object.keys(publicApproval).sort()).toEqual(["ageMs", "peer", "tool"]);
  expect((await f.lead.request({ t: "permit", id: card.id, option: "yes" })).ok).toBe(false);
  expect((await f.console_.request({ t: "permit", id: card.id, option: "yes", surface: "console" })).ok).toBe(true);
  expect(pushes.some(p => p.t === "permission_closed" && p.id === card.id && p.outcome === "answered")).toBe(true);
  const answered = readEvents(join(f.dir, "events.jsonl")).find(e => e.type === "permission" && e.event === "answered");
  expect(answered).toMatchObject({ type: "permission", id: card.id, surface: "console" });
  expect(answered).not.toHaveProperty("title"); expect(answered).not.toHaveProperty("body");
  await f.console_.request({ t: "send", to: ["kimi"], body: "PERMISSION" });
  for (let n = 0; n < 200 && !pushes.some(p => p.t === "permission_closed" && p.reason === "expired"); n++) await Bun.sleep(5);
  expect(pushes.some(p => p.t === "permission_closed" && p.outcome === "cancelled" && p.reason === "expired")).toBe(true);
}, 20_000);
