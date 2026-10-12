import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { planningWipLimits } from "../src/hub/planning.ts";

class PullPeer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-pull-")), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 });
  const capacity = { codex: 1, claude: 1 }, routing = loadRouting(dir), screen = { enabled: false, run: () => {} };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "pull", routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: screen.enabled ? "local" : "off" } }), roles: { claude: ["planner"] }, wipLimit: peer => peer === "codex" ? capacity.codex : peer === "claude" ? capacity.claude : 1, notify: () => {}, piiScreen: async () => { screen.run(); return { label: "clear", ms: 0 }; } });
  for (const id of ["codex", "claude"]) { const peer = new PullPeer(id); bus.add(peer); await peer.start(); }
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board, bus, capacity, screen };
}

test("planner pull reserves WIP atomically and undo stops at owner assignment (#263)", async () => {
  const { tasks, board } = await rig();
  const first = await tasks.propose(USER, { title: "first", class: "implement", backlog: true });
  const second = await tasks.propose(USER, { title: "second", class: "implement", backlog: true });
  await expect(tasks.pullPlanned("codex", { id: first.id, revision: 0, reason: "ready" })).rejects.toThrow("planner role");
  const pulled = await tasks.pullPlanned("claude", { id: first.id, revision: 0, reason: "ready" });
  expect(pulled).toMatchObject({ state: "proposed", owner: null, reserved: "codex", planningRevision: 1 });
  expect(tasks.wip("codex")).toBe(1);
  await expect(tasks.pullPlanned("claude", { id: second.id, revision: 0, reason: "also ready" })).rejects.toThrow("WIP capacity");
  expect(board.get(second.id)).toEqual(second);
  const returned = await tasks.undoPlanning("claude", first.id, 1);
  expect(returned).toMatchObject({ state: "backlog", owner: null, reserved: null, planningRevision: 2 });
  expect(tasks.wip("codex")).toBe(0);
  await tasks.pullPlanned("claude", { id: second.id, revision: 0, reason: "next" });
  await tasks.releaseReady();
  expect(board.get(second.id)?.owner).toBe("codex");
  expect(tasks.wip("codex")).toBe(1);
  await expect(tasks.undoPlanning("claude", second.id, 1)).rejects.toThrow("stale");
});

test("planner pull rechecks capacity pins and dependency approval after screening (#263)", async () => {
  const { tasks, board, bus, capacity, screen } = await rig();
  const task = await tasks.propose(USER, { title: "future", class: "implement", backlog: true });
  capacity.codex=0;
  await expect(tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" })).rejects.toThrow("WIP capacity");
  expect(board.get(task.id)).toEqual(task);
  capacity.codex=1;bus.pause("codex");
  await expect(tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" })).rejects.toThrow("WIP capacity");
  bus.resume("codex");screen.enabled=true;screen.run=()=>{capacity.codex=0;};
  await expect(tasks.pullPlanned("claude", { id: task.id, revision: 0, reason: "ready" })).rejects.toThrow("WIP capacity");
  expect(board.get(task.id)).toEqual(task);
  screen.enabled=false;capacity.codex=1;
  await tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { pinned: true }, reason: "hold" });
  await expect(tasks.pullPlanned("claude", { id: task.id, revision: 1, reason: "ready" })).rejects.toThrow("pinned");
  const dependent = await tasks.propose(USER, { title: "depends", class: "implement", backlog: true, after: [task.id] });
  await expect(tasks.pullPlanned("claude", { id: dependent.id, revision: 0, reason: "ready" })).rejects.toThrow("dependency approval");
});

test("WIP capacities are bounded numeric settings and retain prototype-safe peer ids (#263)", () => {
  expect(planningWipLimits(undefined)).toEqual({});
  const limits=planningWipLimits({ codex: 0, claude: 32, constructor: 2 });
  expect(limits.codex).toBe(0);expect(limits[String("constructor")]).toBe(2);expect(Object.getPrototypeOf(limits)).toBeNull();
  for(const input of [null, [], {codex:-1}, {codex:33}, {codex:1.5}, {codex:"1"}, {"bad peer":1}])expect(()=>planningWipLimits(input)).toThrow();
});


test("planner pull preserves person P0 order and unavailable person reservations (#263)", async () => {
  const { tasks, capacity } = await rig();
  const first = await tasks.propose(USER, { title: "first urgent", class: "implement", backlog: true, urgent: true });
  const second = await tasks.propose(USER, { title: "second urgent", class: "implement", backlog: true, urgent: true });
  await tasks.planBacklog(USER, { id: first.id, revision: 0, fields: { rank: 1, reserved: "claude" }, reason: "person order" });
  await tasks.planBacklog(USER, { id: second.id, revision: 0, fields: { rank: 2 }, reason: "person order" });
  await expect(tasks.pullPlanned("claude", { id: second.id, revision: 1, reason: "skip ahead" })).rejects.toThrow("P0 backlog order");
  capacity.claude=0;
  await expect(tasks.pullPlanned("claude", { id: first.id, revision: 1, reason: "use another peer" })).rejects.toThrow("person's reservation");
});

test("planner offers recheck reserved capacity and refuse another peer's slot (#263)", async () => {
  const {tasks,board,capacity}=await rig();
  const task=await tasks.propose(USER,{title:"future",class:"implement",backlog:true});
  await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});
  capacity.codex=0;
  await tasks.releaseReady();expect(board.get(task.id)).toMatchObject({state:"proposed",owner:null,reserved:"codex"});
  capacity.codex=1;
  const previous=board.onChange;
  board.onChange=(changed,entry)=>{previous?.(changed,entry);if(changed.id===task.id&&entry.event==="ready")capacity.codex=0;};
  await tasks.releaseReady();expect(board.get(task.id)).toMatchObject({state:"proposed",owner:null,reserved:"codex"});
  board.onChange=previous;capacity.codex=1;
  await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("codex");
});

test("unoffered planner pull can undo after a hub readiness marker (#263)", async () => {
  const {tasks,board,capacity}=await rig();
  const task=await tasks.propose(USER,{title:"future",class:"implement",backlog:true});
  await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});
  board.onChange=(changed,entry)=>{if(changed.id===task.id&&entry.event==="ready")capacity.codex=0;};
  await tasks.releaseReady();expect(board.get(task.id)?.owner).toBeNull();expect(board.get(task.id)?.history.at(-1)?.event).toBe("ready");
  const undone=await tasks.undoPlanning("claude",task.id,1).catch(()=>null);expect(undone).toMatchObject({state:"backlog",owner:null,reserved:null,planningRevision:2});
});
