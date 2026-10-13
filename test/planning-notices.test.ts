import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { USER, newEnvelope, type Envelope } from "../src/hub/envelope.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";

class NoticePeer extends BasePeer {
  async deliver(_envs: Envelope[]) {}
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  busy() { this.setState("busy"); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function rig(options: { secondPlanner?: boolean; queueCap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-planner-notices-")), board = new Board(join(dir, "hub.db"));
  const bus: Bus = new Bus({ batchMs: 0, ...(options.queueCap === undefined ? {} : { queueCap: options.queueCap }), rostered: peer => peer !== "kimi", relevant: (peer, env) => tasks.relevant(peer, env) });
  const roles = { claude: ["planner"], codex: ["implementer"], kimi: ["planner"], ...(options.secondPlanner ? { pi: ["planner"] } : {}) };
  const deps = { board, bus, roles, routing: () => { const routing = loadRouting(dir); if (options.secondPlanner) routing.classes.implement!.peers = []; return routing; }, cwd: dir, project: "notices", notify: () => {} };
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

test("reopened journal planner notices coalesce recovered backlog without duplicate copies", async () => {
  const { tasks, board, deps } = rig();
  const task = await tasks.propose(USER, { title: "durable staged work", class: "implement", backlog: true });
  const file = join(deps.cwd, "delivery.db");
  const options = { file, projectRoot: deps.cwd, projectId: "notices", instanceId: "before" };
  const source = new Bus({ batchMs: 0, journal: new DeliveryJournal(options) });
  const planner = new NoticePeer("claude"); source.add(planner); await planner.start(); planner.busy(); source.pause("claude");
  const original = newEnvelope("hub", `Backlog items #${task.id}.`, { to: ["claude"], kind: "task", refs: { backlog: [task.id] } });
  source.publish(original); source.closeJournal();
  const restored = new Bus({ batchMs: 0, journal: new DeliveryJournal({ ...options, instanceId: "after" }) });
  cleanup.push(() => restored.closeJournal());
  restored.setRecoveryHold(true);
  const restarted = new Tasks({ ...deps, board, bus: restored });
  const attached = new NoticePeer("claude"); restored.add(attached); await attached.start(); attached.busy();
  expect(restored.queueIds("claude")).toEqual([original.id]);
  expect(restarted.flushPlannerNotices()).toBe(0);
  expect(restored.queueIds("claude")).toEqual([original.id]);
  restored.setRecoveryHold(false); restored.resume("claude");
  expect(restored.pull("claude")!.map(env => env.id)).toEqual([original.id]);
  expect(restarted.flushPlannerNotices()).toBe(0);
});

test("planner overflow waits for a queue change instead of failing every scheduler tick", async () => {
  const { tasks, bus } = rig({ queueCap: 1 });
  const peer = new NoticePeer("claude"); bus.add(peer); await peer.start(); peer.busy(); bus.pause("claude");
  const task = await tasks.propose(USER, { title: "pressure work", class: "implement", backlog: true });
  bus.publish(newEnvelope(USER, "held important work", { to: ["claude"], priority: "important" }));
  let overflows = 0; bus.tap(event => { if (event.t === "overflow") overflows++; });
  expect(tasks.flushPlannerNotices()).toBe(1);
  for (let tick = 0; tick < 20; tick++) expect(tasks.flushPlannerNotices()).toBe(0);
  expect(overflows).toBe(1);
  bus.resume("claude"); expect(bus.pull("claude")).toHaveLength(1);
  expect(tasks.flushPlannerNotices()).toBe(1);
  expect(bus.pull("claude")![0]!.refs?.backlog).toEqual([task.id]);
  expect(tasks.flushPlannerNotices()).toBe(0);
});

test("recovery coalesces planner ids before a restored notice is consumed ahead of the first tick", async () => {
 const {tasks,bus,deps}=rig(),peer=new NoticePeer("claude");bus.add(peer);await peer.start();peer.busy();
 const task=await tasks.propose(USER,{title:"restored before scheduler",class:"implement",backlog:true});
 expect(tasks.flushPlannerNotices()).toBe(1);const restarted=new Tasks(deps);
 expect(bus.pull("claude")![0]!.refs?.backlog).toEqual([task.id]);
 expect(restarted.flushPlannerNotices()).toBe(0);expect(bus.pull("claude")).toEqual([]);
});

test("planner recovery coalesces unsettled journal originals without a queued copy", async () => {
 const {tasks,deps,board}=rig();const task=await tasks.propose(USER,{title:"uncertain staged notice",class:"implement",backlog:true});
 const options={file:join(deps.cwd,"uncertain.db"),projectRoot:deps.cwd,projectId:"notices",instanceId:"before"};
 const journal=new DeliveryJournal(options),env=newEnvelope("hub","Backlog items staged.",{to:["claude"],kind:"task",refs:{backlog:[task.id]}});
 journal.createDelivery({id:"uncertain-notice",peer:"claude",state:"accepted",createdAt:env.ts,originals:[env],out:[env]});journal.close();
 const reopened=new DeliveryJournal({...options,instanceId:"after"}),bus=new Bus({journal:reopened,batchMs:0});cleanup.push(()=>bus.closeJournal());
 const restarted=new Tasks({...deps,board,bus}),peer=new NoticePeer("claude");bus.add(peer);await peer.start();
 expect(bus.queueIds("claude")).toEqual([]);expect(reopened.get("uncertain-notice")!.state).toBe("needs_review");
 expect(restarted.flushPlannerNotices()).toBe(0);expect(bus.queueIds("claude")).toEqual([]);
 bus.resolveDelivery("uncertain-notice",reopened.get("uncertain-notice")!.revision,"completed","verified earlier consumption");
 expect(restarted.flushPlannerNotices()).toBe(0);expect(bus.queueIds("claude")).toEqual([]);
});

test("configured off-roster planners retain incoming ids until roster admission returns", async () => {
 const {deps,board}=rig({secondPlanner:true});let piRostered=false;let tasks:Tasks;
 const bus=new Bus({batchMs:0,rostered:peer=>peer!=="pi"||piRostered,relevant:(peer,env)=>tasks.relevant(peer,env)});tasks=new Tasks({...deps,board,bus});cleanup.push(()=>bus.closeJournal());
 for(const id of ["claude","pi"]){const peer=new NoticePeer(id);bus.add(peer);await peer.start();peer.busy()}
 const task=await tasks.propose(USER,{title:"staged during roster absence",class:"implement",backlog:true});
 expect(tasks.flushPlannerNotices()).toBe(1);expect(bus.pull("claude")![0]!.refs?.backlog).toEqual([task.id]);expect(bus.queued("pi")).toBe(0);
 piRostered=true;bus.rosterChanged("pi");expect(tasks.flushPlannerNotices()).toBe(1);
 expect(bus.pull("pi")![0]!.refs?.backlog).toEqual([task.id]);expect(bus.pull("claude")).toEqual([]);expect(tasks.flushPlannerNotices()).toBe(0);
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

test("a stale planner copy rebatches only for its recipient without repeating another planner's turn",async()=>{
 const {tasks,bus}=rig({secondPlanner:true});for(const id of ["claude","pi"]){const peer=new NoticePeer(id);bus.add(peer);await peer.start();peer.busy()}
 const first=await tasks.propose(USER,{title:"first staged",class:"implement",backlog:true});const second=await tasks.propose(USER,{title:"second staged",class:"implement",backlog:true});
 expect(tasks.flushPlannerNotices()).toBe(2);expect(bus.pull("claude")).toHaveLength(1);await tasks.moveBacklog(USER,first.id,true);expect(bus.pull("pi")).toEqual([]);
 expect(tasks.flushPlannerNotices()).toBe(1);expect(bus.pull("claude")).toEqual([]);const copy=bus.pull("pi")!;expect(copy).toHaveLength(1);expect(copy[0]!.to).toEqual(["pi"]);expect(copy[0]!.refs?.backlog).toEqual([second.id]);expect(tasks.flushPlannerNotices()).toBe(0);
});

test("an immediately evicted planner notice retains its ids until queue capacity is available",async()=>{
 const {tasks,bus}=rig({queueCap:1});const peer=new NoticePeer("claude");bus.add(peer);await peer.start();peer.busy();bus.pause("claude");
 const task=await tasks.propose(USER,{title:"staged after pressure",class:"implement",backlog:true});bus.publish(newEnvelope(USER,"important existing work",{to:["claude"],priority:"important"}));
 expect(tasks.flushPlannerNotices()).toBe(1);expect(bus.queued("claude")).toBe(1);bus.resume("claude");expect(bus.pull("claude")![0]!.body).toBe("important existing work");
 expect(tasks.flushPlannerNotices()).toBe(1);const copy=bus.pull("claude")!;expect(copy).toHaveLength(1);expect(copy[0]!.refs?.backlog).toEqual([task.id]);expect(tasks.flushPlannerNotices()).toBe(0);
});
