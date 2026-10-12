import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function rig(){
  const dir=mkdtempSync(join(tmpdir(),"ahub-split-")),board=new Board(join(dir,"hub.db")),bus=new Bus({batchMs:0});
  const tasks=new Tasks({board,bus,cwd:dir,project:"split",roles:{claude:["planner"]},routing:()=>loadRouting(dir),notify:()=>{}});
  cleanup.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});return {board,tasks,bus};
}
test("backlog split commits a child DAG and undo provenance without partial callbacks (#263)",async()=>{
  const {board,tasks}=rig(),parent=await tasks.propose(USER,{title:"integration goal",class:"implement",backlog:true});
  const observed:number[]=[];board.onChange=()=>{observed.push(board.list().length);};
  const split=await tasks.splitBacklog("claude",{id:parent.id,revision:0,parts:[{title:"first"},{title:"second",afterParts:[0]}],reason:"small deliverable parts"});
  expect(split.children).toHaveLength(2);expect(split.parent.deps).toEqual(split.children.map(child=>child.id));expect(split.children[1]?.deps).toEqual([split.children[0]!.id]);
  expect(split.children.every(child=>child.state==="backlog"&&child.owner===null)).toBe(true);expect(observed.every(count=>count===3)).toBe(true);
  const publicView=tasks.publicView(split.parent,true);expect(JSON.stringify(publicView)).not.toContain('"previous"');expect(JSON.stringify(publicView)).toContain('"children"');
  const undone=await tasks.undoPlanning("claude",parent.id,1);expect(undone.deps).toEqual([]);expect(board.list().map(task=>task.id)).toEqual([parent.id]);
});
test("split rejects cyclic input and later child edits or external references (#263)",async()=>{
  const {board,tasks}=rig(),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
  await expect(tasks.splitBacklog("claude",{id:parent.id,revision:0,parts:[{title:"first",after:[parent.id]},{title:"second"}],reason:"invalid"})).rejects.toThrow("parent");expect(board.list()).toHaveLength(1);
  const split=await tasks.splitBacklog("claude",{id:parent.id,revision:0,parts:[{title:"first"},{title:"second"}],reason:"parts"});
  await tasks.planBacklog(USER,{id:split.children[0]!.id,revision:0,fields:{priority:1},reason:"person edit"});
  await expect(tasks.undoPlanning("claude",parent.id,1)).rejects.toThrow("child changed");expect(board.list()).toHaveLength(3);
});
test("split persistence rolls back children and parent and publishes no partial effects (#263)",()=>{
  const {board}=rig(),parent=board.propose(USER,{title:"parent",class:"implement",backlog:true}),events:number[]=[];board.onChange=task=>events.push(task.id);
  const propose=board.propose.bind(board);let count=0;board.propose=(...args)=>{if(++count===2)throw new Error("second write failed");return propose(...args);};
  expect(()=>board.splitBacklog(parent.id,USER,0,[{title:"first",class:"implement"},{title:"second",class:"implement"}],"parts")).toThrow("second write failed");
  expect(board.list()).toEqual([parent]);expect(events).toEqual([]);
});
test("split children retain parent privacy and planning phase (#263)",async()=>{
  const {board,tasks}=rig(),parent=await tasks.propose(USER,{title:"patient 900101-1234567",class:"implement",backlog:true});
  const release=await tasks.newRelease(USER,{name:"next",goal:"safe",order:0});await tasks.planBacklog(USER,{id:parent.id,revision:0,fields:{priority:1,release:release.id,due:200},reason:"phase"});
  const split=await tasks.splitBacklog(USER,{id:parent.id,revision:1,parts:[{title:"first private part"},{title:"second private part"}],reason:"parts"});
  for(const child of split.children){expect(tasks.isPii(child)).toBe(true);expect(child).toMatchObject({priority:1,release:release.id,due:200});expect(tasks.publicView(child).title).toBe("[pii]");}
  expect(board.list()).toHaveLength(3);
});

test("split undo refuses child references and invalid late writes stay atomic (#263)",async()=>{
  const {board,tasks}=rig(),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
  const split=await tasks.splitBacklog("claude",{id:parent.id,revision:0,parts:[{title:"first"},{title:"second"}],reason:"parts"});
  await tasks.propose(USER,{title:"external dependent",class:"implement",backlog:true,after:[split.children[0]!.id]});
  await expect(tasks.undoPlanning("claude",parent.id,1)).rejects.toThrow("referenced");expect(board.list()).toHaveLength(4);
});


test("person P0 integration order allows its split prerequisites first (#263)",async()=>{
  const {board,tasks,bus}=rig();
  class Peer extends BasePeer{async start(){this.setState("idle");}async stop(){}async deliver(_envs:Envelope[]){} }
  for(const id of ["codex","claude"]){const peer=new Peer(id);bus.add(peer);await peer.start();}
  const parent=await tasks.propose(USER,{title:"urgent integration",class:"implement",backlog:true,urgent:true});
  await tasks.planBacklog(USER,{id:parent.id,revision:0,fields:{rank:1,priority:0},reason:"person first goal"});
  const split=await tasks.splitBacklog("claude",{id:parent.id,revision:1,parts:[{title:"first"},{title:"second"}],reason:"prerequisites"});
  const part=split.children[0]!;expect(await tasks.pullPlanned("claude",{id:part.id,revision:part.planningRevision??0,reason:"required first"})).toMatchObject({state:"proposed",owner:null,reserved:"codex"});
  expect(board.get(parent.id)?.state).toBe("backlog");
});
