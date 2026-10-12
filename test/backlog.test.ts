import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { assign, loadRouting } from "../src/hub/routing.ts";
import { Tasks, AssignmentUndeliveredError } from "../src/hub/tasks.ts";
import { DEFAULT_TASK_SWEEP, nextSweep } from "../src/hub/task-sweep.ts";
import { taskProgress } from "../src/ui/task-progress.ts";
import { SupervisionFeed } from "../src/hub/supervision.ts";
import { classifyPeerCommand } from "../src/cli/identity.ts";

class Peer extends BasePeer {
  got: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() {}
  async deliver(envs: Envelope[]) { this.got.push(...envs); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
async function rig(ids = ["codex", "claude", "local"]) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-backlog-"));
  const bus = new Bus({ batchMs: 0, rostered: peer => ["codex", "claude", "local"].includes(peer) });
  const board = new Board(join(dir, "hub.db"));
  const peers = ids.map(id => new Peer(id));
  for (const p of peers) { bus.add(p); await p.start(); }
  const notices: string[] = [];
  const tasks = new Tasks({ board, bus, routing: () => loadRouting(dir), cwd: dir, project: "backlog-test", notify: line => notices.push(line), sweep: { ...DEFAULT_TASK_SWEEP, enabled: true } });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, board, bus, peers, tasks, notices };
}

test("backlog self nomination remains unoffered and invisible to sweeps and relays (#263)", async () => {
  const { tasks, board, peers, bus } = await rig();
  const t = await tasks.propose("codex", { title: "future parser", class: "implement", owner: "codex", backlog: true, urgent: true });
  expect(t).toMatchObject({ state: "backlog", owner: null, reviewer: null, reserved: "codex" });
  expect(assign(t, { codex: "idle" }, loadRouting("."), { namedOwner: "codex" }).owner).toBeUndefined();
  expect(nextSweep(t, { ...DEFAULT_TASK_SWEEP, enabled: true }, Date.now() + 100_000_000)).toBeUndefined();
  const history = board.get(t.id)!.history;
  await tasks.releaseReady(); await tasks.sweep(Date.now() + 100_000_000);
  await tasks.reassignForPause("codex", undefined); await tasks.reassignForRoster("codex");
  tasks.recoverIntegrations(); tasks.replayHeld("codex");
  expect(board.get(t.id)!.history).toEqual(history);
  expect(peers.flatMap(p => p.got)).toEqual([]);
  expect(Object.values(bus.snapshot(false).queues).flat()).toEqual([]);
  expect(() => tasks.accept("codex", t.id)).toThrow(/backlog/);
  await expect(tasks.assignTo(t.id, "codex")).rejects.toThrow(/backlog/);
  await expect(tasks.escalate(USER, t.id)).rejects.toThrow(/backlog/);
  await expect(tasks.done("codex", t.id, "premature")).rejects.toThrow(/backlog/);
  await expect(tasks.review(USER, t.id, "approved")).rejects.toThrow(/backlog/);
  expect(board.get(t.id)!.history).toEqual(history);
});

test("backlog transitions require a person and an ownerless eligible state (#263)", async () => {
  const { tasks, board } = await rig();
  const t = await tasks.propose("codex", { title: "later", class: "implement", owner: "codex", backlog: true });
  for (const by of ["codex", "claude", "hub"]) await expect(tasks.moveBacklog(by, t.id, true)).rejects.toThrow(/console/);
  for (const id of [[], {}, 0, -1, 1.5, "1junk"]) await expect(tasks.moveBacklog(USER, id, true)).rejects.toThrow(/task number/);
  expect(board.get(t.id)!.history).toHaveLength(1);
  const pulled = await tasks.moveBacklog(USER, t.id, true);
  expect(pulled).toMatchObject({ state: "proposed", owner: "codex", reserved: "codex" });
  await expect(tasks.moveBacklog(USER, t.id, false)).rejects.toThrow(/ownerless/);
  tasks.accept("codex", t.id);
  await expect(tasks.moveBacklog(USER, t.id, false)).rejects.toThrow(/ownerless/);
  expect(board.get(t.id)!.state).toBe("in_progress");
});

test("backlog pull preserves dependency blocking and return prevents later automatic offers (#263)", async () => {
  const { tasks, board } = await rig();
  const dep = await tasks.propose(USER, { title: "prerequisite", class: "implement", backlog: true });
  const t = await tasks.propose("codex", { title: "later", class: "implement", owner: "codex", after: [dep.id], backlog: true });
  expect(await tasks.moveBacklog(USER, t.id, true)).toMatchObject({ state: "proposed", owner: null, reserved: "codex", deps: [dep.id] });
  expect(board.get(t.id)!.history.at(-1)?.event).toBe("blocked");
  expect(await tasks.moveBacklog(USER, t.id, false)).toMatchObject({ state: "backlog", owner: null, reviewer: null });
  await tasks.releaseReady();
  expect(board.get(t.id)!.history.at(-1)?.event).toBe("backlog returned");
});

test("pulled ownerless backlog without dependencies is offered after peers attach (#263)", async () => {
  const { tasks, board, bus } = await rig([]);
  const t = await tasks.propose(USER, { title: "later", class: "implement", backlog: true });
  expect(await tasks.moveBacklog(USER, t.id, true)).toMatchObject({ state: "proposed", owner: null });
  const peer = new Peer("codex"); bus.add(peer); await peer.start();
  await tasks.releaseReady();
  expect(board.get(t.id)!.owner).toBe("codex");
  const history = board.get(t.id)!.history;
  await tasks.releaseReady();
  expect(board.get(t.id)!.history).toEqual(history);
});

test("backlog rejects malformed inputs before storing and hides PII from notices (#263)", async () => {
  const { tasks, board, notices } = await rig();
  for (const backlog of [null, "true", 1, [], {}]) await expect(tasks.propose("codex", { title: "future", class: "implement", backlog })).rejects.toThrow(/boolean/);
  await expect(tasks.propose("codex", { title: "future", class: "implement", backlog: true, owner: "ghost" })).rejects.toThrow(/roster/);
  await expect(tasks.propose("codex", { title: "future", class: "missing", backlog: true })).rejects.toThrow();
  expect(board.list()).toEqual([]);
  const marker = "patient 900101-1234567";
  const t = await tasks.propose("codex", { title: marker, class: "implement", backlog: true });
  expect(tasks.publicView(t)).toMatchObject({ title: "[pii]", state: "backlog" });
  expect(notices.join("\n")).not.toContain(marker);
});

test("board backlog survives restart while default proposal history stays unchanged (#263)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-backlog-store-")), file = join(dir, "hub.db");
  let board = new Board(file);
  try {
    const ordinary = board.propose("codex", { title: "ordinary", class: "implement" });
    const t = board.propose("codex", { title: "later", class: "implement", backlog: true });
    expect(ordinary.state).toBe("proposed");
    expect(ordinary.history).toEqual([{ at: ordinary.created, by: "codex", event: "proposed" }]);
    expect(() => board.update(t.id, USER, "assign", { owner: "codex" })).toThrow(/backlog/);
    expect(() => board.update(t.id, USER, "accept", { state: "in_progress" })).toThrow(/cannot move/);
    board.update(ordinary.id, USER, "assign", { owner: "codex" });
    expect(() => board.update(ordinary.id, USER, "backlog returned", { state: "backlog", owner: null })).toThrow(/owned/);
    board.close(); board = new Board(file);
    expect(board.get(t.id)).toEqual(t);
    expect(board.get(ordinary.id)!.state).toBe("proposed");
  } finally { board.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("backlog progress and supervision expose no executable assignment (#263)", async () => {
  const { tasks, board } = await rig();
  const t = await tasks.propose("claude", { title: "future", class: "implement", backlog: true });
  const emitted: unknown[] = [];
  const feed = new SupervisionFeed({ conductor: () => "claude", scope: () => "all", tasks: () => board.list(), publicTitle: tasks.publicTitle, isPrivate: tasks.isPii, emit: n => { emitted.push(n); } });
  expect(feed.includes(t)).toBe(false);
  feed.taskChanged(t, t.history[0]!); feed.milestone(t.id, "stuck"); feed.checkRound();
  expect(emitted).toEqual([]);
  const p = taskProgress([t]);
  expect(p.counts.backlog).toBe(1); expect(p.counts.proposed).toBe(0);
  expect(p.stages[0]).toEqual({ id: t.id, stage: 0, waiting: false, changes: false, label: "backlog (not offered)" });
  expect(taskProgress([]).counts).not.toHaveProperty("backlog");
  expect(classifyPeerCommand("backlog", ["pull", "1"])).toBe("console");
});

test("backlog pull keeps a saved assignment when its delivery is unconfirmed (#263)", async () => {
  const { tasks, board, bus, notices } = await rig();
  const t = await tasks.propose(USER, { title: "later", class: "implement", owner: "codex", backlog: true });
  const publish = bus.publish.bind(bus);
  bus.publish = () => { throw new Error("delivery unavailable"); };
  await expect(tasks.moveBacklog(USER, t.id, true)).rejects.toBeInstanceOf(AssignmentUndeliveredError);
  expect(board.get(t.id)).toMatchObject({ state: "proposed", owner: "codex" });
  expect(notices.filter(n => n.includes("delivery is not confirmed"))).toHaveLength(1);
  bus.publish = publish;
  const history = board.get(t.id)!.history;
  await tasks.releaseReady();
  expect(board.get(t.id)!.history).toEqual(history);
});
