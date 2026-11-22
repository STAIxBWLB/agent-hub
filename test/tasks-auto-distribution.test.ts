import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { type Envelope, USER } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

// #1626: automatic owner choices honour the owner's WIP cap, back off after a capacity decline, keep a pulled card's reservation and fill a freed slot.
class Quiet extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) { /* never answers */ }
  mark(state: "idle" | "busy") { this.setState(state); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const until = async (condition: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); return condition(); };
const settle = () => new Promise(resolve => setTimeout(resolve, 80));

async function rig(autoPull = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-auto-dist-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const roles: Record<string, string[]> = { claude: ["planner"], codex: ["implementer"], kimi: ["implementer"] };
  const flag = { on: autoPull };
  const tasks = new Tasks({ cwd, board, bus, roles, project: "fixture", notify: () => {}, autoPull: () => flag.on, wipLimit: () => 1, routing: () => loadRouting(cwd) });
  const peers = new Map<string, Quiet>();
  for (const id of Object.keys(roles)) { const peer = new Quiet(id); peers.set(id, peer); bus.add(peer); await peer.start(); }
  cleanup.push(() => { tasks.stopQueuePressureRechecks(); bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  /** A task `peer` holds and has accepted: it fills the peer's one planner slot. */
  const fill = (peer: string) => {
    const made = board.propose(USER, { title: `held by ${peer}`, class: "implement" });
    const owned = board.update(made.id, USER, "assigned", { owner: peer, reviewer: "claude" });
    return board.update(owned.id, peer, "accepted", { state: "in_progress" });
  };
  const owner = (task: Task) => board.get(task.id)?.owner ?? null;
  return { cwd, board, bus, tasks, flag, peers, fill, owner };
}

test("AC1: an owner chosen at propose time skips a peer at its WIP cap", async () => {
  const r = await rig(false);
  r.fill("codex");
  const task = await r.tasks.propose("claude", { title: "new work", class: "implement" });
  expect(task.owner).toBe("kimi");
});

test("AC1 and AC4: when the only candidate is full the task stays unowned, with no offer loop, and a freed slot offers it", async () => {
  const r = await rig(true);
  r.fill("codex"); r.fill("kimi");
  const task = await r.tasks.propose("claude", { title: "waits", class: "implement" });
  expect(task.owner).toBeNull();
  expect(r.board.get(task.id)?.history.filter(entry => entry.event === "assigned")).toHaveLength(0);
  // codex finishes its held task: the freed slot offers the waiting task.
  const held = r.board.list("in_progress").find(t => t.owner === "codex")!;
  r.board.update(held.id, "codex", "done", { state: "in_review" });
  await r.tasks.review(USER, held.id, "approved");
  expect(await until(() => r.owner(task) === "codex")).toBe(true);
});

test("AC1: the reroute after a decline skips a peer at its WIP cap", async () => {
  const r = await rig(false);
  r.fill("codex");
  const task = await r.tasks.propose("claude", { title: "reroute", class: "implement", owner: "kimi" });
  expect(task.owner).toBe("kimi");
  const back = await r.tasks.decline("kimi", task.id, "not mine");
  expect(back.owner).toBeNull();
});

test("AC2: an explicit person or conductor assignment is unchanged at the cap", async () => {
  const r = await rig(false);
  r.fill("codex");
  const task = r.board.propose(USER, { title: "explicit", class: "implement" });
  const assigned = await r.tasks.assignTo(task.id, "codex", USER);
  expect(assigned.owner).toBe("codex");
});

test("AC3: with auto_pull off a peer going idle is offered nothing", async () => {
  const r = await rig(false);
  r.fill("codex"); r.fill("kimi");
  const task = await r.tasks.propose("claude", { title: "waits", class: "implement" });
  r.peers.get("kimi")!.mark("busy"); r.peers.get("kimi")!.mark("idle");
  await settle();
  expect(r.owner(task)).toBeNull();
});

test("AC3: two peers freed at once are offered different tasks, and one task is never offered twice", async () => {
  const r = await rig(true);
  r.fill("codex"); r.fill("kimi");
  const a = await r.tasks.propose("claude", { title: "first", class: "implement" });
  const b = await r.tasks.propose("claude", { title: "second", class: "implement" });
  for (const held of r.board.list("in_progress")) r.board.update(held.id, held.owner!, "done", { state: "in_review" });
  for (const held of r.board.list("in_review")) r.board.update(held.id, USER, "approved", { state: "approved" });
  (r.tasks as unknown as { queueAutoPulls: (peers: Set<string>) => void }).queueAutoPulls(new Set(["codex", "kimi"]));
  expect(await until(() => r.owner(a) !== null && r.owner(b) !== null)).toBe(true);
  expect(new Set([r.owner(a), r.owner(b)]).size).toBe(2);
  const c = await r.tasks.propose("claude", { title: "third", class: "implement" });
  expect(c.owner).toBeNull();
  expect(r.board.get(a.id)!.history.filter(entry => entry.event === "assigned")).toHaveLength(1);
});

test("AC4b: after a capacity decline the hub offers that peer nothing until it is idle, then the first ready task", async () => {
  const r = await rig(true);
  r.fill("kimi");
  const mine = await r.tasks.propose("claude", { title: "mine", class: "implement", owner: "codex" });
  r.peers.get("codex")!.mark("busy"); // mid-turn: the decline is about load
  await r.tasks.decline("codex", mine.id, "finishing another task", true);
  expect(r.owner(mine)).toBeNull();
  const other = await r.tasks.propose("claude", { title: "other", class: "implement" });
  expect(other.owner).toBeNull(); // kimi is full and codex is backing off
  await settle();
  expect(r.owner(mine)).toBeNull();
  r.peers.get("codex")!.mark("idle");
  expect(await until(() => r.owner(mine) === "codex" || r.owner(other) === "codex")).toBe(true);
});

test("AC4c: a capacity decline of a pulled reserved card returns it to backlog with its reservation, a plain decline clears it", async () => {
  const r = await rig(false);
  const card = (reserved: string) => r.board.propose(USER, { title: "planned", class: "implement", backlog: true, planner: "claude", reserved });
  const kept = card("codex");
  await r.tasks.pullPlanned("claude", { id: kept.id, revision: kept.planningRevision ?? 0, reason: "pull" });
  expect(r.board.get(kept.id)!.owner).toBe("codex");
  await r.tasks.decline("codex", kept.id, "busy", true);
  const back = r.board.get(kept.id)!;
  expect(back.state).toBe("backlog"); expect(back.owner).toBeNull(); expect(back.reserved).toBe("codex");
  const dropped = card("kimi");
  await r.tasks.pullPlanned("claude", { id: dropped.id, revision: dropped.planningRevision ?? 0, reason: "pull" });
  expect(r.board.get(dropped.id)!.owner).toBe("kimi");
  await r.tasks.decline("kimi", dropped.id, "never mine");
  expect(r.board.get(dropped.id)!.reserved ?? null).toBeNull();
});

test("B: a freed slot is never offered a task of a class routing keeps that peer out of", async () => {
  const r = await rig(true);
  mkdirSync(join(r.cwd, ".agenthub"), { recursive: true });
  writeFileSync(join(r.cwd, ".agenthub", "routing.toml"), '[local]\nfixed_model = "fixture"\n[classes.implement]\npeers = ["codex", "kimi"]\n[classes.review]\npeers = ["kimi"]\n');
  r.fill("kimi");
  const review = await r.tasks.propose("claude", { title: "review cards go to kimi only", class: "review" });
  expect(review.owner).toBeNull(); // kimi is at its cap, and codex is not a review peer
  (r.tasks as unknown as { queueAutoPulls: (peers: Set<string>) => void }).queueAutoPulls(new Set(["codex"]));
  await settle();
  expect(r.owner(review)).toBeNull();
  const implement = await r.tasks.propose("claude", { title: "implement cards may go to codex", class: "implement" });
  expect(implement.owner).toBe("codex");
});
