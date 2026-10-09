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
import { Board } from "../src/hub/board.ts";

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

test("public task history screens private done/review notes and profile while console keeps the original", async () => {
  const f = await fixture();
  const board = new Board(join(f.dir, "hub.db"));
  let id: number;
  try {
    const task = board.propose("claude", { title: "ordinary parser task", class: "implement" }); id = task.id;
    board.update(id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "claude" });
    board.update(id, "codex", "done", { state: "in_review" }, "PRIVATE-MARKER done summary");
    board.update(id, "claude", "approved", { state: "approved" }, "PRIVATE-MARKER review note", {
      profile: "PRIVATE-MARKER profile",
      sweep: { kind: "idle-owner", activity: 1, step: 1, at: 1, unexpected: "PRIVATE-MARKER history extra" } as any,
    });
    for (let n = 0; n < 7; n++) board.update(id, "claude", "approved", {}, `public audit entry ${n}`);
  } finally { board.close(); }
  const raw = await f.console_.request({ t: "task", op: "task_show", args: { id } });
  expect(raw.ok).toBe(true); expect(raw.text).toContain("PRIVATE-MARKER done summary"); expect(raw.text).toContain("PRIVATE-MARKER review note"); expect(raw.text).toContain("PRIVATE-MARKER profile"); expect(raw.text).toContain("PRIVATE-MARKER history extra");
  const peer = await f.connect("unlisted");
  for (const [client, op] of [[peer, "task_show"], [f.lead, "hub_task_show"]] as const) {
    const shown = await client.request({ t: "task", op, args: { id } });
    expect(shown.ok).toBe(true); expect(shown.text).not.toContain("PRIVATE-MARKER");
    const view = JSON.parse(shown.text); expect(view.title).toBe("ordinary parser task"); expect(view.history).toHaveLength(JSON.parse(raw.text).history.length);
    expect(view.history.find((h: any) => h.event === "done").note).toContain("withheld");
    const review = view.history.find((h: any) => h.profile); expect(review.note).toContain("withheld"); expect(review.profile).toContain("withheld"); expect(review.sweep).not.toHaveProperty("unexpected");
  }
});

test("a task's owner and reviewer read its done summary and check line; other peers are refused and PII stays a stub (#208)", async () => {
  const f = await fixture();
  const board = new Board(join(f.dir, "hub.db"));
  let id: number, pii: number;
  try {
    id = board.propose("claude", { title: "ordinary parser task", class: "implement" }).id;
    board.update(id, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "kimi" });
    board.update(id, "codex", "done (checking)", {}, "parser fixed, bun test passed");
    board.update(id, "hub", "check passed", {}, "scripts/check.sh -> exit 0\ncheck: OK");
    board.update(id, "codex", "done", { state: "in_review" }, "parser fixed, bun test passed\nCheck: scripts/check.sh -> exit 0");
    pii = board.propose("claude", { title: "PRIVATE-MARKER task", detail: "PRIVATE-MARKER body", class: "implement", signals: ["pii"] }).id;
    board.update(pii, "codex", "accepted", { state: "in_progress", owner: "codex", reviewer: "kimi" }, "PRIVATE-MARKER note");
  } finally { board.close(); }
  const owner = await f.connect("codex"), reviewer = await f.connect("kimi"), other = await f.connect("pi");
  for (const client of [owner, reviewer]) {
    const shown = await client.request({ t: "task", op: "hub_task_show", args: { id } });
    expect(shown.ok).toBe(true);
    const history = JSON.parse(shown.text).history as { event: string; note?: string }[];
    expect(history.findLast(h => h.event === "done")!.note).toContain("parser fixed");
    expect(history.find(h => h.event === "check passed")!.note).toContain("scripts/check.sh -> exit 0");
    const stub = await client.request({ t: "task", op: "hub_task_show", args: { id: pii } });
    expect(stub.ok).toBe(true); expect(stub.text).not.toContain("PRIVATE-MARKER");
    expect(JSON.parse(stub.text)).toMatchObject({ title: "[pii]", detail: "[pii]", history: [] });
  }
  for (const target of [id, pii]) {
    const refused = await other.request({ t: "task", op: "hub_task_show", args: { id: target } });
    expect(refused.ok).toBe(false); expect(refused.error).toContain("explicit conductor role");
  }
  // A read by the task's own people is no conductor action.
  expect(readEvents(join(f.dir, "events.jsonl")).some(e => e.type === "conduct")).toBe(false);
});

test("the proposer redirects its own unaccepted task without the role; other peers and accepted tasks stay the conductor's (#207)", async () => {
  const f = await fixture("codex");
  for (const name of ["kimi", "pi"]) { const peer = new QuietPeer(name); f.daemon.bus.add(peer); await peer.start(); }
  const planner = await f.connect("claude"), kimi = await f.connect("kimi"), pi = await f.connect("pi");
  const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args });
  const shown = async (id: number) => JSON.parse((await op(f.console_, "task_show", { id })).text);
  expect((await op(planner, "hub_task_propose", { title: "first", class: "implement" })).ok).toBe(true);
  expect((await shown(1)).owner).toBe("pi"); // the first idle peer in the class order
  const notMine = await op(pi, "hub_task_assign", { id: 1, peer: "kimi" });
  expect(notMine.ok).toBe(false); expect(notMine.error).toContain("explicit conductor role");
  const redirected = await op(planner, "hub_task_assign", { id: 1, peer: "kimi" });
  expect(redirected.ok).toBe(true); expect(JSON.parse(redirected.text)).toMatchObject({ owner: "kimi", state: "proposed" });
  expect((await shown(1)).history.at(-1)).toMatchObject({ event: "reassigned", by: "claude", reason: "manual", owner: "kimi" });
  expect((await op(kimi, "hub_task_accept", { id: 1 })).ok).toBe(true);
  expect((await op(planner, "hub_task_assign", { id: 1, peer: "pi" })).ok).toBe(false); // accepted: the conductor's now
  // A waiting task: the owner named with after is reserved, and its proposer redirects the reservation.
  expect((await op(planner, "hub_task_propose", { title: "second", class: "implement", owner: "pi", after: [1] })).ok).toBe(true);
  expect(await shown(2)).toMatchObject({ owner: null, reserved: "pi" });
  expect((await op(pi, "hub_task_assign", { id: 2, peer: "pi" })).ok).toBe(false);
  expect(JSON.parse((await op(planner, "hub_task_assign", { id: 2, peer: "kimi" })).text)).toMatchObject({ owner: null, reserved: "kimi" });
  // The conductor still may, and only its moves are conduct events.
  expect((await op(f.lead, "hub_task_assign", { id: 2, peer: "pi" })).ok).toBe(true);
  expect((await shown(2)).reserved).toBe("pi");
  expect(readEvents(join(f.dir, "events.jsonl")).filter(e => e.type === "conduct").map(e => e.peer)).toEqual(["codex"]);
});

test("a person's console assign or reservation stands against the proposer; digit-string ids reach the task's own people (#207, #208)", async () => {
  const f = await fixture("codex");
  for (const name of ["kimi", "pi"]) { const peer = new QuietPeer(name); f.daemon.bus.add(peer); await peer.start(); }
  const planner = await f.connect("claude"), pi = await f.connect("pi");
  const op = (client: ControlClient, name: string, args: Record<string, unknown>) => client.request({ t: "task", op: name, args });
  expect((await op(planner, "hub_task_propose", { title: "first", class: "implement" })).ok).toBe(true); // routed to pi
  expect((await op(pi, "hub_task_show", { id: "1" })).ok).toBe(true); // the owner, with the id as a digit string
  expect((await op(f.console_, "task_assign", { id: 1, peer: "kimi" })).ok).toBe(true);
  const refused = await op(planner, "hub_task_assign", { id: "1", peer: "pi" });
  expect(refused.ok).toBe(false); expect(refused.error).toContain("explicit conductor role");
  expect((await op(planner, "hub_task_propose", { title: "second", class: "implement", owner: "pi", after: [1] })).ok).toBe(true);
  expect((await op(planner, "hub_task_assign", { id: "2", peer: "kimi" })).ok).toBe(true); // its own reservation: a digit string works
  expect((await op(f.console_, "task_assign", { id: 2, peer: "pi" })).ok).toBe(true);
  expect((await op(planner, "hub_task_assign", { id: 2, peer: "kimi" })).ok).toBe(false);
  // The conductor path is unchanged, and once the conductor moved it the proposer may again.
  expect((await op(f.lead, "hub_task_assign", { id: 2, peer: "kimi" })).ok).toBe(true);
  expect((await op(planner, "hub_task_assign", { id: 2, peer: "pi" })).ok).toBe(true);
  expect(JSON.parse((await op(f.console_, "task_show", { id: 2 })).text)).toMatchObject({ owner: null, reserved: "pi" });
});

test("peer route explain and quota reads work while quota mutations remain human-only", async () => {
  const f = await fixture();
  const peer = await f.connect("unlisted");
  const created = await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "PRIVATE-MARKER routing task", class: "implement" } }); expect(created.ok).toBe(true);
  const explained = await peer.request({ t: "task", op: "route_explain", args: { id: 1 } }); expect(explained.ok).toBe(true); expect(explained.text).not.toContain("PRIVATE-MARKER");
  const read = await peer.request({ t: "budget" }); expect(read.ok).toBe(true); expect(read.budget).toEqual({});
  expect((await peer.request({ t: "budget", set: { peer: "pi", used: 0.5 } })).ok).toBe(false);
  expect((await peer.request({ t: "budget", resume: "pi" })).ok).toBe(false);
});

test("manual assignment persists a structured reason and production task changes include it in the feed", async () => {
  const f = await fixture("claude", "all");
  for (const name of ["claude", "codex", "pi"]) { const peer = new QuietPeer(name); f.daemon.bus.add(peer); await peer.start(); }
  const notices: string[] = [];
  const untap = f.daemon.bus.tap(event => { if (event.t === "envelope" && event.env.from === HUB && event.env.refs?.supervision) notices.push(event.env.body); }); cleanup.push(untap);
  expect((await f.console_.request({ t: "task", op: "hub_task_propose", args: { title: "ordinary task", owner: "codex", class: "implement" } })).ok).toBe(true);
  expect((await f.lead.request({ t: "task", op: "hub_task_assign", args: { id: 1, peer: "pi" } })).ok).toBe(true);
  const shown = await f.console_.request({ t: "task", op: "task_show", args: { id: 1 } });
  expect(JSON.parse(shown.text).history.at(-1)).toMatchObject({ event: "reassigned", by: "claude", reason: "manual", owner: "pi" });
  expect(notices.some(body => body.includes("moved") && body.includes("reason manual"))).toBe(true);
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
  const log = readFileSync(join(f.dir, "hub.log"), "utf8");
  expect(log).toContain(`permission ${card.id} from kimi answered option allow_once by console`);
  expect(log).not.toContain(card.title);
  await f.console_.request({ t: "send", to: ["kimi"], body: "PERMISSION" });
  for (let n = 0; n < 100 && pushes.filter(p => p.t === "permission").length < 2; n++) await Bun.sleep(5);
  const denied = pushes.filter(p => p.t === "permission")[1]; expect(denied).toBeDefined();
  expect((await f.console_.request({ t: "permit", id: denied.id, surface: "console" })).ok).toBe(true);
  const cancelled = readEvents(join(f.dir, "events.jsonl")).find(e => e.type === "permission" && e.id === denied.id && e.event === "cancelled");
  expect(cancelled).toMatchObject({ surface: "console" }); expect((cancelled as any).latencyMs).toBeGreaterThanOrEqual(0);
  expect(readFileSync(join(f.dir, "hub.log"), "utf8")).toContain(`permission ${denied.id} from kimi cancelled option none by console`);
  await f.console_.request({ t: "send", to: ["kimi"], body: "PERMISSION" });
  for (let n = 0; n < 200 && !pushes.some(p => p.t === "permission_closed" && p.reason === "expired"); n++) await Bun.sleep(5);
  expect(pushes.some(p => p.t === "permission_closed" && p.outcome === "cancelled" && p.reason === "expired")).toBe(true);
  const expired = readEvents(join(f.dir, "events.jsonl")).find(e => e.type === "permission" && e.event === "expired");
  expect(expired).not.toHaveProperty("surface"); expect((expired as any).latencyMs).toBeGreaterThanOrEqual(0);
}, 20_000);
