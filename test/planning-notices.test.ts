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

class NoticePeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  busy() { this.setState("busy"); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-notices-")), board = new Board(join(dir, "hub.db"));
  const bus = new Bus({ batchMs: 0, rostered: peer => peer !== "kimi", relevant: (peer, env) => tasks.relevant(peer, env) });
  const roles = { claude: ["planner"], codex: ["implementer"], kimi: ["planner"] };
  const deps = { board, bus, roles, routing: () => loadRouting(dir), cwd: dir, project: "notices", notify: () => {} };
  const tasks = new Tasks(deps), notices: Envelope[] = [];
  bus.tap(event => { if (event.t === "envelope" && event.env.body.startsWith("Backlog items ")) notices.push(event.env); });
  cleanup.push(() => { bus.closeJournal(); board.close(); rmSync(dir, { recursive: true, force: true }); });
  return { tasks, board, bus, notices, deps };
}

test("incoming backlog notices batch ids only for attached rostered planners (#263)", async () => {
  const { tasks, board, bus, notices } = rig();
  const first = await tasks.propose(USER, { title: "public work", class: "implement", backlog: true });
  const privateTask = await tasks.propose(USER, { title: "patient 900101-1234567", class: "implement", backlog: true });
  const pulled = await tasks.propose(USER, { title: "pulled work", class: "implement", backlog: true });
  await tasks.moveBacklog(USER, pulled.id, true);
  expect(tasks.flushPlannerNotices()).toBe(0);
  for (const id of ["claude", "codex", "kimi"]) { const peer = new NoticePeer(id); bus.add(peer); await peer.start(); }
  expect(tasks.flushPlannerNotices()).toBe(2);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ from: "hub", kind: "task", to: ["claude"] });
  expect(notices[0]!.body).toContain(`#${first.id}, #${privateTask.id}`);
  expect(notices[0]!.body).not.toContain(`#${pulled.id}`);
  expect(notices[0]!.body).not.toContain("patient");
  expect(notices[0]!.body).not.toContain("900101");
  expect(board.get(privateTask.id)).toMatchObject({ state: "backlog", owner: null });
  expect(tasks.flushPlannerNotices()).toBe(0);
  expect(notices).toHaveLength(1);
});

test("planner notice batches are bounded and recover staged work on restart (#263)", async () => {
  const { tasks, bus, notices, deps } = rig();
  for (let i = 0; i < 65; i++) await tasks.propose(USER, { title: `future ${i}`, class: "implement", backlog: true });
  const restarted = new Tasks(deps), planner = new NoticePeer("claude"); bus.add(planner); await planner.start();
  expect(restarted.flushPlannerNotices()).toBe(64);
  expect(restarted.flushPlannerNotices()).toBe(1);
  expect(restarted.flushPlannerNotices()).toBe(0);
  expect(notices).toHaveLength(2);
  expect([...notices[0]!.body.matchAll(/#\d+/g)]).toHaveLength(64);
  expect([...notices[1]!.body.matchAll(/#\d+/g)]).toHaveLength(1);
});

test("person-returned ownerless work produces a planner notice without a restart (#263)",async()=>{
  const {tasks,bus,notices}=rig();
  const task=await tasks.propose(USER,{title:"returned work",class:"implement"});
  expect(task).toMatchObject({state:"proposed",owner:null});
  const planner=new NoticePeer("claude");bus.add(planner);await planner.start();
  expect(tasks.flushPlannerNotices()).toBe(0);
  await tasks.moveBacklog(USER,task.id,false);
  expect(tasks.flushPlannerNotices()).toBe(1);expect(notices).toHaveLength(1);
  expect(notices[0]!.body).toContain(`#${task.id}`);expect(notices[0]!.body).not.toContain("returned work");
  expect(tasks.flushPlannerNotices()).toBe(0);
});

test("queued planner batches omit pulled ids at delivery and rebatch remaining backlog",async()=>{
 const {tasks,bus}=rig();const planner=new NoticePeer("claude");bus.add(planner);await planner.start();planner.busy();
 const first=await tasks.propose(USER,{title:"private pulled marker",class:"implement",backlog:true});const second=await tasks.propose(USER,{title:"private remaining marker",class:"implement",backlog:true});
 expect(tasks.flushPlannerNotices()).toBe(2);expect(bus.queued("claude")).toBe(1);
 await tasks.moveBacklog(USER,first.id,true);expect(bus.pull("claude")).toEqual([]);expect(bus.queued("claude")).toBe(0);
 expect(tasks.flushPlannerNotices()).toBe(1);const delivered=bus.pull("claude")!;expect(delivered).toHaveLength(1);expect(delivered[0]!.refs?.backlog).toEqual([second.id]);expect(delivered[0]!.body).not.toContain(`#${first.id}`);expect(delivered[0]!.body).not.toContain("private");
 await tasks.moveBacklog(USER,second.id,true);expect(tasks.flushPlannerNotices()).toBe(0);
});
