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
  const undone=await tasks.undoPlanning("claude",task.id,1).catch(()=>null);expect(undone).not.toBeNull();expect(undone).toMatchObject({state:"backlog",owner:null,reserved:null,planningRevision:2});
});


test("planner pull honors original person backlog reservations and pull-only offers (#263)", async () => {
  const {tasks,board,bus,capacity}=await rig();
  const reserved=await tasks.propose(USER,{title:"person reservation",class:"implement",backlog:true,owner:"codex"});
  capacity.codex=0;const alternative=new PullPeer("local");bus.add(alternative);await alternative.start();
  const before=board.get(reserved.id);
  await expect(tasks.pullPlanned("claude",{id:reserved.id,revision:0,reason:"try another owner"})).rejects.toThrow("person's reservation");expect(board.get(reserved.id)).toEqual(before);
  class PullOnlyPeer extends PullPeer {readonly pullOnly=true;deliveries=0;async deliver(_envs:Envelope[]){this.deliveries++;}}
  const kimi=new PullOnlyPeer("kimi");bus.add(kimi);await kimi.start();
  const task=await tasks.propose(USER,{title:"named pull-only work",class:"implement",backlog:true,owner:"kimi"});
  await expect(tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"named peer has room"})).resolves.toMatchObject({owner:"kimi",reserved:"kimi",state:"proposed"});
  await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("kimi");expect(bus.queued("kimi")).toBeGreaterThan(0);expect(kimi.deliveries).toBe(0);
});

test("declined planner pulls release the old WIP slot and reroute when another peer attaches", async () => {
 const {tasks,board,bus}=await rig(),task=await tasks.propose(USER,{title:"declined pull",class:"implement",backlog:true});
 await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("codex");
 await tasks.decline("codex",task.id,"cannot take it");expect(board.get(task.id)).toMatchObject({owner:null,reserved:null,state:"proposed"});expect(tasks.wip("codex")).toBe(0);
 const other=new PullPeer("kimi");bus.add(other);await other.start();await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("kimi");expect(tasks.wip("kimi")).toBe(1);
});

test("automatic offline rerouting of planner pulls respects destination WIP",async()=>{
 const {tasks,board,bus}=await rig();const task=await tasks.propose(USER,{title:"planned",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("codex");
 const local=new PullPeer("local");bus.add(local);await local.start();const busy=board.propose(USER,{title:"occupied",class:"implement"});board.update(busy.id,USER,"assigned",{owner:"local",state:"in_progress"});await bus.peers.get("codex")!.stop();
 await tasks.releaseFromGone("codex",1);expect(board.get(task.id)?.owner).toBe("codex");
 await tasks.assignTo(task.id,"local");expect(board.get(task.id)?.owner).toBe("local");
});

test("person reservation survives planner pull undo and a second pull",async()=>{
 const {tasks,board,bus,capacity}=await rig();const task=await tasks.propose(USER,{title:"reserved",class:"implement",backlog:true,owner:"codex"});/* Pre-#718 ownerless records retain undo compatibility. */board.pullPlanned(task.id,"claude","codex",0,"legacy unoffered pull");const undone=await tasks.undoPlanning("claude",task.id,1);expect(undone.reserved).toBe("codex");
 capacity.codex=0;const local=new PullPeer("local");bus.add(local);await local.start();await expect(tasks.pullPlanned("claude",{id:task.id,revision:2,reason:"second"})).rejects.toThrow("person's reservation");
});
test("accepted planner work remains unchanged when automatic handoffs have no capacity",async()=>{
 const {tasks,board,bus}=await rig();const task=await tasks.propose(USER,{title:"accepted planned",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await tasks.releaseReady();tasks.accept("codex",task.id);
 const local=new PullPeer("local");bus.add(local);await local.start();const busy=board.propose(USER,{title:"occupied",class:"implement"});board.update(busy.id,USER,"assigned",{owner:"local",state:"in_progress"});const before=board.get(task.id);
 expect(tasks.rosterPreview("codex").find(row=>row.id===task.id)?.to).toBeNull();expect(await tasks.reassignForRoster("codex")).toEqual([]);expect(board.get(task.id)).toEqual(before);
 expect(await tasks.reassignForPause("codex",undefined)).toEqual([]);expect(board.get(task.id)).toEqual(before);await bus.peers.get("codex")!.stop();expect(await tasks.releaseFromGone("codex",1)).toEqual([]);expect(board.get(task.id)).toEqual(before);
});

test("automatic rescreen admission retains planner WIP after privacy clears",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"ahub-planner-rescreen-")),board=new Board(join(dir,"hub.db")),bus=new Bus({batchMs:0}),routing=loadRouting(dir);let clear=false;
 const tasks=new Tasks({board,bus,cwd:dir,project:"rescreen",routing:()=>({...routing,signals:{...routing.signals,pii_screen:"local"}}),roles:{claude:["planner"]},notify:()=>{},piiScreen:async()=>clear?{label:"clear",ms:0}:{label:"unknown",miss:"failed",ms:0}});
 cleanup.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});for(const id of ["claude","codex","local"]){const peer=new PullPeer(id);bus.add(peer);await peer.start();}
 const task=await tasks.propose(USER,{title:"planned unknown",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});
 for(const owner of ["codex","local"]){const full=board.propose(USER,{title:"occupied",class:"implement"});board.update(full.id,USER,"assigned",{owner,state:"in_progress"});}
 clear=true;await tasks.rescreen();expect(board.get(task.id)?.signals).not.toContain("pii");expect(board.get(task.id)?.owner).toBeNull();
});

test("planner owner capacity never removes the required reviewer",async()=>{
 const {tasks,board}=await rig();const busy=board.propose(USER,{title:"reviewer owns work",class:"implement"});board.update(busy.id,USER,"assigned",{owner:"claude",state:"in_progress"});
 const task=await tasks.propose(USER,{title:"review required",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await tasks.releaseReady();expect(board.get(task.id)?.reviewer).toBe("claude");tasks.accept("codex",task.id);
 const done=await tasks.done("codex",task.id,"complete");expect(done.state).toBe("in_review");
});

test("ordinary backlog return restores pre-planner reservation provenance",async()=>{
 const {tasks,board,bus,capacity}=await rig();const task=await tasks.propose(USER,{title:"ordinary return",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"first"});const returned=await tasks.moveBacklog(USER,task.id,false);expect(returned.reserved).toBeNull();
 capacity.codex=0;const local=new PullPeer("local");bus.add(local);await local.start();const pulled=await tasks.pullPlanned("claude",{id:task.id,revision:returned.planningRevision??0,reason:"again"}).catch(()=>null);expect(pulled).not.toBeNull();expect(board.get(task.id)?.reserved).toBe("local");
});

test("declined planner redo returns to To Do and resumes after alternative WIP clears",async()=>{
 const {tasks,board,bus,capacity}=await rig();const task=await tasks.propose(USER,{title:"redo work",class:"implement",backlog:true});await tasks.pullPlanned("claude",{id:task.id,revision:0,reason:"ready"});await tasks.releaseReady();tasks.accept("codex",task.id);await tasks.done("codex",task.id,"first pass");board.update(task.id,"claude","changes_requested",{state:"changes_requested"},"redo");expect(board.get(task.id)?.state).toBe("changes_requested");
 const local=new PullPeer("local");bus.add(local);await local.start();const busy=await tasks.propose(USER,{title:"occupied local",class:"implement",owner:"local"});tasks.accept("local",busy.id);capacity.claude=0;await tasks.decline("codex",task.id,"cannot redo");expect(board.get(task.id)).toMatchObject({state:"proposed",owner:null,reserved:null});await tasks.releaseReady();expect(board.get(task.id)?.owner).toBeNull();
 await tasks.done("local",busy.id,"done");await tasks.review("claude",busy.id,"approved");await tasks.releaseReady();expect(board.get(task.id)?.owner).toBe("local");
});

for (const source of ["backlog owner", "planning reservation"] as const) {
  for (const reserved of [null, "local", "codex"] as const) {
    test(`planner cannot ${reserved === null ? "clear" : reserved === "codex" ? "reassert" : "replace"} a person's ${source} before pull (#378)`, async () => {
      const { tasks, board, bus, capacity } = await rig();
      const local = new PullPeer("local"); bus.add(local); await local.start();
      let task = await tasks.propose(USER, { title: "person reserved work", class: "implement", backlog: true, ...(source === "backlog owner" ? { owner: "codex" } : {}) });
      if (source === "planning reservation") task = await tasks.planBacklog(USER, { id: task.id, revision: 0, fields: { reserved: "codex" }, reason: "person selected owner" });
      const revision = task.planningRevision ?? 0;
      capacity.codex = 0;
      await expect(tasks.pullPlanned("claude", { id: task.id, revision, reason: "try available peer" })).rejects.toThrow("person's reservation");
      await expect(tasks.planBacklog("claude", { id: task.id, revision, fields: { reserved }, reason: "groom the reservation" })).rejects.toThrow("person's reservation");
      expect(board.get(task.id)).toEqual(task);
      await expect(tasks.pullPlanned("claude", { id: task.id, revision, reason: "retry available peer" })).rejects.toThrow("person's reservation");
    });
  }
}

for (const returnToBacklog of ["undo", "person return"] as const) {
  test(`person reservation remains protected from grooming after planner pull ${returnToBacklog} (#378)`, async () => {
    const { tasks, board, bus, capacity } = await rig();
    const local = new PullPeer("local"); bus.add(local); await local.start();
    const task = await tasks.propose(USER, { title: "restore person reservation", class: "implement", backlog: true, owner: "codex" });
    // Pre-#718 ownerless records retain person-reservation protection across return/undo.
    board.pullPlanned(task.id, "claude", "codex", 0, "legacy unoffered pull");
    const restored = returnToBacklog === "undo" ? await tasks.undoPlanning("claude", task.id, 1) : await tasks.moveBacklog(USER, task.id, false);
    expect(restored).toMatchObject({ state: "backlog", owner: null, reserved: "codex" });
    const revision = restored.planningRevision ?? 0;
    capacity.codex = 0;
    await expect(tasks.planBacklog("claude", { id: task.id, revision, fields: { reserved: null }, reason: "clear restored reservation" })).rejects.toThrow("person's reservation");
    expect(board.get(task.id)).toEqual(restored);
    await expect(tasks.pullPlanned("claude", { id: task.id, revision, reason: "try another owner" })).rejects.toThrow("person's reservation");
  });
}

test("planner-owned reservations remain editable and a person can override or clear them (#378)", async () => {
  const { tasks, board, bus, capacity } = await rig();
  const local = new PullPeer("local"); bus.add(local); await local.start();
  let task = await tasks.propose(USER, { title: "planner chooses owner", class: "implement", backlog: true });
  for (const reserved of ["codex", "codex", null, "local"] as const) {
    task = await tasks.planBacklog("claude", { id: task.id, revision: task.planningRevision ?? 0, fields: { reserved }, reason: "planner grooming" });
    expect(task.reserved).toBe(reserved);
  }
  task = await tasks.planBacklog(USER, { id: task.id, revision: task.planningRevision!, fields: { reserved: "codex" }, reason: "person override" });
  expect(task.reserved).toBe("codex");
  task = await tasks.planBacklog(USER, { id: task.id, revision: task.planningRevision!, fields: { reserved: null }, reason: "person releases reservation" });
  expect(task.reserved).toBeNull();
  task = await tasks.planBacklog("claude", { id: task.id, revision: task.planningRevision!, fields: { reserved: "codex" }, reason: "planner chooses again" });
  capacity.codex = 0;
  await expect(tasks.pullPlanned("claude", { id: task.id, revision: task.planningRevision!, reason: "reserved peer is full" })).rejects.toThrow("reserved peer codex");
  expect(board.get(task.id)).toEqual(task);
  task = await tasks.planBacklog("claude", { id: task.id, revision: task.planningRevision!, fields: { reserved: "local" }, reason: "explicitly select another eligible peer" });
  const pulled = await tasks.pullPlanned("claude", { id: task.id, revision: task.planningRevision!, reason: "offer amended reservation" });
  expect(pulled).toMatchObject({ state: "proposed", owner: "local", reserved: "local" });
  expect(board.get(task.id)?.reserved).toBe("local");
});
