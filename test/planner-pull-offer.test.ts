import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { HUB, USER, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { AssignmentUndeliveredError, Tasks } from "../src/hub/tasks.ts";

class PullPeer extends BasePeer {
  readonly pullOnly = true;
  deliveries = 0;
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { this.deliveries++; }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-reserved-pull-")), file = join(dir, "hub.db");
  const board = new Board(file), roster = new Set(["claude", "codex", "local"]);
  const bus = new Bus({ batchMs: 0, rostered: peer => roster.has(peer) }), routing = loadRouting(dir);
  const roles: Record<string, string[]> = { claude: ["planner"] }, capacity: Record<string, number> = { codex: 1, local: 1, claude: 1 };
  const screen: { enabled: boolean; run: () => void } = { enabled: false, run: () => {} }, read = new Set<string>();
  const notices: string[] = [];
  const tasks = new Tasks({ board, bus, cwd: dir, project: "reserved-pull", repository: "fixture/reserved-pull", roles,
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: screen.enabled ? "local" : "off" } }),
    wipLimit: peer => capacity[peer] ?? 1, offerPullOnly: () => true, offerRead: (peer, id) => read.has(`${peer}:${id}`),
    piiScreen: async () => { screen.run(); return { label: "clear", ms: 0 }; }, notify: line => { notices.push(line); },
  });
  const peers: Record<string, PullPeer> = {};
  for (const id of roster) { const peer = new PullPeer(id); peers[id] = peer; bus.add(peer); await peer.start(); }
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { board, bus, tasks, peers, capacity, roles, roster, screen, notices,
    staleOffer(task: Task, peer: string) {
      const env = newEnvelope(HUB, `Task #${task.id} [implement] stale fixture owner request`, { to: [peer], kind: "task", refs: { task: String(task.id), taskRecipient: "owner", taskOffer: 42 } });
      bus.publish(env);
      const db = new Database(file);
      try { db.query("UPDATE tasks SET offer=? WHERE id=?").run(JSON.stringify({ envelopeId: env.id, owner: peer, assignmentFlowRevision: 42, pullOnly: true }), task.id); }
      finally { db.close(); }
      return env;
    },
    inbox(peer: string) { const envs = bus.pull(peer) ?? []; for (const env of envs) read.add(`${peer}:${env.id}`); return envs; },
  };
}
type Fixture = Awaited<ReturnType<typeof rig>>;
const offers = (f: Fixture, task: Task, peer: string) => f.bus.pendingEnvelopes(peer).filter(env => env.from === HUB && env.kind === "task" && env.refs?.task === String(task.id) && env.refs.taskRecipient === "owner");
async function reserved(f: Fixture, by = USER) {
  const task = await f.tasks.propose(USER, { title: "reserved backlog work", class: "implement", backlog: true });
  return f.tasks.planBacklog(by, { id: task.id, revision: task.planningRevision ?? 0, fields: { reserved: "codex" }, reason: "reserve exact peer" });
}
const pull = (f: Fixture, task: Task) => f.tasks.pullPlanned("claude", { id: task.id, revision: task.planningRevision ?? 0, reason: "offer reserved backlog work" });

for (const by of [USER, "claude"]) test(`reserved backlog pull immediately offers the exact peer and permits acceptance (${by})`, async () => {
  const f = await rig(), task = await reserved(f, by), pulled = await pull(f, task);
  expect(pulled).toMatchObject({ state: "proposed", owner: "codex", reserved: "codex", planningRevision: (task.planningRevision ?? 0) + 1 });
  const saved = f.board.get(task.id)!; expect(saved.offer).toBeDefined();
  expect(saved.offer).toMatchObject({ owner: "codex", pullOnly: true, assignmentFlowRevision: saved.history.length });
  const queued = offers(f, task, "codex"); expect(queued).toHaveLength(1); expect(queued[0]!.id).toBe(saved.offer!.envelopeId);
  expect(queued[0]!.refs?.taskOffer).toBe(saved.history.length); expect(offers(f, task, "local")).toEqual([]);
  expect(f.peers.codex!.deliveries).toBe(0); expect(f.tasks.wip("codex")).toBe(1);
  expect(f.inbox("codex").some(env => env.id === saved.offer!.envelopeId)).toBe(true);
  expect(f.tasks.accept("codex", task.id)).toMatchObject({ owner: "codex", state: "in_progress" });
  expect(f.board.get(task.id)!.history.some(entry => entry.event === "accepted" && entry.by === "codex")).toBe(true);
});

for (const former of ["codex", "local"]) test(`reserved pull replaces stale offer metadata and withdraws its unread ${former} request`, async () => {
  const f = await rig(), task = await reserved(f), stale = f.staleOffer(task, former);
  expect(offers(f, task, former).some(env => env.id === stale.id)).toBe(true);
  await pull(f, task);
  const saved = f.board.get(task.id)!; expect(saved.owner).toBe("codex"); expect(saved.offer?.owner).toBe("codex");
  expect(saved.offer?.envelopeId).not.toBe(stale.id);
  expect(f.bus.pendingEnvelopes(former).some(env => env.id === stale.id)).toBe(false);
  expect(offers(f, task, "codex")).toHaveLength(1);
  expect(offers(f, task, "codex")[0]!.id).toBe(saved.offer!.envelopeId);
  expect(offers(f, task, "local")).toEqual([]);
});

for (const unavailable of ["offline", "off-roster", "paused", "WIP full"] as const) test(`unavailable reserved peer (${unavailable}) refuses before every write and never falls back`, async () => {
  const f = await rig(), task = await reserved(f, "claude");
  if (unavailable === "offline") await f.peers.codex!.stop();
  if (unavailable === "off-roster") f.roster.delete("codex");
  if (unavailable === "paused") f.bus.pause("codex");
  if (unavailable === "WIP full") {
    const busy = f.board.propose(USER, { title: "occupied reserved slot", class: "implement" });
    f.board.update(busy.id, USER, "assigned", { owner: "codex", state: "in_progress" });
  }
  const before = f.board.get(task.id), revision = f.board.statusRevision();
  expect(f.bus.stateOf("local")).toBe("idle"); expect(f.capacity.local).toBe(1);
  await expect(pull(f, task)).rejects.toThrow();
  expect(f.board.get(task.id)).toEqual(before); expect(f.board.statusRevision()).toBe(revision);
  expect(offers(f, task, "local")).toEqual([]); expect(offers(f, task, "codex")).toEqual([]);
});

for (const drift of ["planner role", "reserved capacity"] as const) test(`reserved pull rechecks ${drift} after its asynchronous screen without mutation`, async () => {
  const f = await rig(), task = await reserved(f, "claude");
  const before = f.board.get(task.id), revision = f.board.statusRevision(); let screens = 0;
  f.screen.enabled = true; f.screen.run = () => { screens++; if (drift === "planner role") f.roles.claude = []; else f.capacity.codex = 0; };
  await expect(pull(f, task)).rejects.toThrow(); expect(screens).toBeGreaterThan(0);
  expect(f.board.get(task.id)).toEqual(before); expect(f.board.statusRevision()).toBe(revision);
  expect(offers(f, task, "codex")).toEqual([]); expect(offers(f, task, "local")).toEqual([]);
});

test("reserved pull delivery failure carries the saved owner in AssignmentUndeliveredError", async () => {
  const f = await rig(), task = await reserved(f), original = f.bus.publish.bind(f.bus);
  f.bus.publish = env => { if (env.refs?.task === String(task.id) && env.refs.taskRecipient === "owner") throw new Error("fixture publication failure"); return original(env); };
  let failure: unknown;
  try { await pull(f, task); } catch (error) { failure = error; } finally { f.bus.publish = original; }
  expect(failure).toBeInstanceOf(AssignmentUndeliveredError);
  if (!(failure instanceof AssignmentUndeliveredError)) throw new Error("missing typed saved-delivery failure");
  expect(failure.task).toMatchObject({ id: task.id, state: "proposed", owner: "codex", reserved: "codex" });
  expect(f.board.get(task.id)).toMatchObject({ owner: "codex", state: "proposed" });
  expect(failure.message).toContain("saved"); expect(offers(f, task, "local")).toEqual([]);
});

test("unreserved legacy planner pull remains lazy instead of creating an immediate offer", async () => {
  const f = await rig(), task = await f.tasks.propose(USER, { title: "unreserved legacy work", class: "implement", backlog: true });
  const pulled = await pull(f, task);
  expect(pulled).toMatchObject({ state: "proposed", owner: null, reserved: "codex" });
  expect(offers(f, task, "codex")).toEqual([]); expect(f.board.get(task.id)?.offer).toBeUndefined();
});

test("reserved pull and assignment roll back together when the owner write fails", async () => {
  const f = await rig(), task = await reserved(f), before = f.board.get(task.id), revision = f.board.statusRevision();
  const update = f.board.update.bind(f.board), changed: string[] = [];
  const prior = f.board.onChange;
  f.board.onChange = (row, entry) => { prior?.(row, entry); if (row.id === task.id) changed.push(entry.event); };
  f.board.update = (...args) => { if (args[0] === task.id && args[2] === "assigned") throw new Error("fixture owner write failed"); return update(...args); };
  await expect(pull(f, task)).rejects.toThrow("fixture owner write failed");
  expect(f.board.get(task.id)).toEqual(before); expect(f.board.statusRevision()).toBe(revision);
  expect(changed).toEqual([]); expect(offers(f, task, "codex")).toEqual([]);
});

test("reserved pull observers read the assigned owner only after the atomic handoff commits", async () => {
  const f = await rig(), task = await reserved(f), seen: (string | null | undefined)[] = [];
  const prior = f.board.onChange;
  f.board.onChange = (row, entry) => {
    prior?.(row, entry);
    if (row.id === task.id && ["backlog pulled", "assigned"].includes(entry.event)) seen.push(f.board.get(task.id)?.owner);
  };
  await pull(f, task);
  expect(seen).toEqual(["codex", "codex"]);
});
