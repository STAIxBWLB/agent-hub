import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { projectProfile, resolveProfile } from "../src/hub/profiles.ts";
import { MemoryStore, taskKey } from "../src/memory/store.ts";
import type { PiiVerdict, ScreenRecord } from "../src/hub/inference.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function rig(extra:Partial<TasksDeps>={}){
  const dir=mkdtempSync(join(tmpdir(),"ahub-split-")),board=new Board(join(dir,"hub.db")),bus=new Bus({batchMs:0});
  const deps={board,bus,cwd:dir,project:"split",roles:{claude:["planner"]},routing:()=>loadRouting(dir),notify:()=>{},...extra},tasks=new Tasks(deps);
  cleanup.push(()=>{bus.closeJournal();board.close();rmSync(dir,{recursive:true,force:true});});return {board,tasks,bus,dir,deps};
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
  const part=split.children[0]!,pulled=await tasks.pullPlanned("claude",{id:part.id,revision:part.planningRevision??0,reason:"required first"}).catch(()=>null);expect(pulled).not.toBeNull();expect(pulled).toMatchObject({state:"proposed",owner:null,reserved:"codex"});
  expect(board.get(parent.id)?.state).toBe("backlog");
});


test("split plans containing PII are private before any observer or public response (#263)",async()=>{
  const {board,tasks}=rig(),parent=await tasks.propose(USER,{title:"public parent",class:"implement",backlog:true}),seen:boolean[]=[];
  board.onChange=(task)=>{if(task.id!==parent.id)seen.push(tasks.isPii(task));};
  const split=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"first",plan:{signatures:["patient 900101-1234567"]}},{title:"second",plan:{symbols:["patient 900101-1234567"]}}],reason:"parts"});
  expect(seen.every(Boolean)).toBe(true);for(const child of split.children){expect(tasks.isPii(child)).toBe(true);expect(JSON.stringify(tasks.publicView(child))).not.toContain("900101");}
});
test("split prerequisites inherit the higher-ranked P0 goal ahead of unrelated work (#263)",async()=>{
  const {tasks,bus}=rig();class Peer extends BasePeer{async start(){this.setState("idle");}async stop(){}async deliver(_envs:Envelope[]){} }
  for(const id of ["codex","claude"]){const peer=new Peer(id);bus.add(peer);await peer.start();}
  const parent=await tasks.propose(USER,{title:"highest goal",class:"implement",backlog:true,urgent:true}),later=await tasks.propose(USER,{title:"lower goal",class:"implement",backlog:true,urgent:true});
  await tasks.planBacklog(USER,{id:parent.id,revision:0,fields:{rank:1,priority:0},reason:"first"});await tasks.planBacklog(USER,{id:later.id,revision:0,fields:{rank:2,priority:0},reason:"later"});
  const split=await tasks.splitBacklog("claude",{id:parent.id,revision:1,parts:[{title:"first"},{title:"second"}],reason:"parts"}),part=split.children[0]!;
  const pulled=await tasks.pullPlanned("claude",{id:part.id,revision:part.planningRevision??0,reason:"highest goal prerequisite"}).catch(()=>null);expect(pulled).not.toBeNull();expect(pulled).toMatchObject({owner:null,state:"proposed",reserved:"codex"});
});

test("split prerequisites retain P0 ordering after their blocked parent moves to To Do",async()=>{
 const {tasks,bus}=rig();class Peer extends BasePeer{async start(){this.setState("idle")}async stop(){}async deliver(_envs:Envelope[]){} }
 for(const id of ["codex","claude"]){const peer=new Peer(id);bus.add(peer);await peer.start()}
 const parent=await tasks.propose(USER,{title:"first goal",class:"implement",backlog:true,urgent:true}),later=await tasks.propose(USER,{title:"later goal",class:"implement",backlog:true,urgent:true});
 await tasks.planBacklog(USER,{id:parent.id,revision:0,fields:{rank:1,priority:0},reason:"first"});await tasks.planBacklog(USER,{id:later.id,revision:0,fields:{rank:2,priority:0},reason:"later"});
 const split=await tasks.splitBacklog(USER,{id:parent.id,revision:1,parts:[{title:"a"},{title:"b"}],reason:"parts"});await tasks.moveBacklog(USER,parent.id,true);
 const outcome=await tasks.pullPlanned("claude",{id:split.children[0]!.id,revision:split.children[0]!.planningRevision??0,reason:"prerequisite"}).then(row=>row.state,()=>null);expect(outcome).toBe("proposed");
});

test("split keeps sixty-four parent prerequisites transitively within every edge cap",async()=>{
 const {tasks,board}=rig(),deps:number[]=[];for(let i=0;i<64;i++)deps.push((await tasks.propose(USER,{title:`prerequisite ${i}`,class:"implement",backlog:true})).id);
 const parent=await tasks.propose(USER,{title:"integration",class:"implement",backlog:true,after:deps});
 const split=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b",afterParts:[0]}],reason:"parts"}).catch(()=>null);expect(split).not.toBeNull();if(!split)return;
 expect(split.parent.deps).toEqual(split.children.map(row=>row.id));expect(split.children[0]!.deps).toEqual(deps);expect(split.children[1]!.deps).toEqual([split.children[0]!.id]);
 await tasks.undoPlanning(USER,parent.id,1);expect(board.get(parent.id)!.deps).toEqual(deps);
});

test("split preserves custom dev metadata and stored research aliases across profile changes",async()=>{
 const custom=rig({profile:"dev",profileData:resolveProfile("dev",{classes:{implement:"implement"}})}),p=await custom.tasks.propose(USER,{title:"custom",class:"implement",backlog:true});
 const split=await custom.tasks.splitBacklog(USER,{id:p.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});for(const child of split.children)expect(child).toMatchObject({profile:"dev",profileClass:"implement"});
 const old=rig({profile:"research",profileData:projectProfile("research")}),parent=await old.tasks.propose(USER,{title:"stored research",class:"analyze",backlog:true}),current=new Tasks({...old.deps,profile:"dev",profileData:projectProfile("dev")});
 const result=await current.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b",class:"analyze"}],reason:"parts"}).catch(()=>({children:[]}));expect(result.children).toHaveLength(2);for(const child of result.children)expect(child).toMatchObject({profile:"research",profileClass:"analyze",class:parent.class});
});

test("split undo refuses dropped scope even for a person and refuses durable goal links",async()=>{
 const r=rig(),release=await r.tasks.newRelease(USER,{name:"drop-test",goal:"scope",order:0}),parent=await r.tasks.propose(USER,{title:"scoped",class:"implement",backlog:true});await r.tasks.planBacklog(USER,{id:parent.id,revision:0,fields:{release:release.id},reason:"scope"});
 await r.tasks.splitBacklog(USER,{id:parent.id,revision:1,parts:[{title:"a"},{title:"b"}],reason:"parts"});r.tasks.changeRelease(USER,{id:release.id,revision:0,state:"dropped"});await expect(r.tasks.undoPlanning(USER,parent.id,2)).rejects.toThrow("eligible");
 const other=rig(),store=new MemoryStore({home:join(other.dir,"home")});cleanup.push(()=>store.close());const tasks=new Tasks({...other.deps,store:{store,project:"split",repo:"owner/repo"}}),task=await tasks.propose(USER,{title:"linked",class:"implement",backlog:true});const parts=await tasks.splitBacklog(USER,{id:task.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});
 const goal=store.goal({project:"split",scope:"project",title:"goal",milestones:[],dependsOn:[],actor:"user"});tasks.linkGoal(USER,parts.children[0]!.id,goal);await expect(tasks.undoPlanning(USER,task.id,1)).rejects.toThrow("long-term");expect(other.board.get(parts.children[0]!.id)).toBeDefined();
});

test("split screens parts and reason concurrently and atomically retains each child verdict",async()=>{
 const f=rig();let on=false,active=0,peak=0;const records:ScreenRecord[]=[],notices:string[]=[];
 const tasks=new Tasks({...f.deps,routing:()=>{const r=f.deps.routing();return {...r,signals:{...r.signals,pii_screen:on?"local":"off"}}},recordScreen:record=>records.push(record),notify:text=>notices.push(text),piiScreen:async text=>{active++;peak=Math.max(peak,active);await Bun.sleep(5);active--;return text.includes("unknown-part")?{label:"unknown",miss:"failed",ms:5}:{label:"clear",ms:5}}});
 const parent=await tasks.propose(USER,{title:"screen parent",class:"implement",backlog:true});on=true;
 const split=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"clear-part"},{title:"unknown-part"}],reason:"parts"});
 expect(peak).toBe(3);for(const child of split.children)expect(child.history.some(entry=>entry.event==="screened")).toBe(true);
 expect(records.find(record=>record.task===split.children[0]!.id)).toMatchObject({label:"clear",source:"screen"});expect(records.find(record=>record.task===split.children[1]!.id)).toMatchObject({label:"pii",source:"unknown",miss:"failed"});expect(tasks.isPii(split.children[1]!)).toBe(true);expect(notices.some(line=>line.includes(`#${split.children[1]!.id}: the PII screen gave no verdict`))).toBe(true);
 await tasks.undoPlanning(USER,parent.id,1);expect(f.board.list()).toHaveLength(1);
});

test("split request deadline refuses before writes and late screen completion cannot commit",async()=>{
 const f=rig();let on=false;const pending:((verdict:PiiVerdict)=>void)[]=[];
 const tasks=new Tasks({...f.deps,routing:()=>{const r=f.deps.routing();return {...r,signals:{...r.signals,pii_screen:on?"local":"off"}}},piiScreen:()=>new Promise<PiiVerdict>(resolve=>pending.push(resolve))});
 const parent=await tasks.propose(USER,{title:"deadline parent",class:"implement",backlog:true});on=true;
 await expect(tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"})).rejects.toThrow("deadline");
 expect(f.board.list()).toEqual([parent]);for(const resolve of pending)resolve({label:"clear",ms:0});await Bun.sleep(0);expect(f.board.list()).toEqual([parent]);
},20000);

test("competing split prerequisites retain their person-ranked ancestor order",async()=>{
 const {tasks,bus}=rig();class Peer extends BasePeer{async start(){this.setState("idle")}async stop(){}async deliver(_envs:Envelope[]){} }
 for(const id of ["codex","claude"]){const peer=new Peer(id);bus.add(peer);await peer.start()}
 const first=await tasks.propose(USER,{title:"first goal",class:"implement",backlog:true,urgent:true}),second=await tasks.propose(USER,{title:"second goal",class:"implement",backlog:true,urgent:true});
 await tasks.planBacklog(USER,{id:first.id,revision:0,fields:{rank:1,priority:0},reason:"first"});await tasks.planBacklog(USER,{id:second.id,revision:0,fields:{rank:2,priority:0},reason:"second"});
 const a=await tasks.splitBacklog(USER,{id:first.id,revision:1,parts:[{title:"a"},{title:"b"}],reason:"parts"}),b=await tasks.splitBacklog(USER,{id:second.id,revision:1,parts:[{title:"c"},{title:"d"}],reason:"parts"});await tasks.moveBacklog(USER,first.id,true);
 await expect(tasks.pullPlanned("claude",{id:b.children[0]!.id,revision:b.children[0]!.planningRevision??0,reason:"lower prerequisite"})).rejects.toThrow("P0 backlog order");
 const permitted=await tasks.pullPlanned("claude",{id:a.children[0]!.id,revision:a.children[0]!.planningRevision??0,reason:"higher prerequisite"});expect(permitted.state).toBe("proposed");
});
test("deterministic private split parts never reach the model screener",async()=>{
 const f=rig();let on=false;const seen:string[]=[];
 const tasks=new Tasks({...f.deps,routing:()=>{const r=f.deps.routing();return {...r,signals:{...r.signals,pii_screen:on?"local":"off"}}},piiScreen:async text=>{seen.push(text);return {label:"clear",ms:0}}});
 const parent=await tasks.propose(USER,{title:"public parent",class:"implement",backlog:true});on=true;
 const result=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"patient 900101-1234567"},{title:"safe part"}],reason:"safe reason"});
 expect(seen.some(text=>text.includes("900101"))).toBe(false);expect(tasks.isPii(result.children[0]!)).toBe(true);expect(seen.some(text=>text.includes("safe part"))).toBe(true);
});
test("legacy split parents ignore later custom dev aliases",async()=>{
 const f=rig(),parent=await f.tasks.propose(USER,{title:"legacy",class:"implement",backlog:true});
 const tasks=new Tasks({...f.deps,profile:"dev",profileData:resolveProfile("dev",{classes:{custom:"implement"}})});
 await expect(tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a",class:"custom"},{title:"b"}],reason:"parts"})).rejects.toThrow();expect(f.board.list()).toHaveLength(1);
});

test("split undo refuses child-scoped memory entries",async()=>{
 const f=rig(),store=new MemoryStore({home:join(f.dir,"home")});cleanup.push(()=>store.close());const tasks=new Tasks({...f.deps,store:{store,project:"split",repo:"owner/repo"}}),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
 const result=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});await tasks.remember(USER,{text:"child note",task:result.children[0]!.id});await expect(tasks.undoPlanning(USER,parent.id,1)).rejects.toThrow("referenced");expect(f.board.get(result.children[0]!.id)).toBeDefined();
});
test("private parent split records inherited PII without invented regex verdicts",async()=>{
 const f=rig(),records:ScreenRecord[]=[];const tasks=new Tasks({...f.deps,routing:()=>({...f.deps.routing(),signals:{...f.deps.routing().signals,pii_screen:"local"}}),piiScreen:async()=>({label:"unknown",miss:"failed",ms:2}),recordScreen:record=>records.push(record)});
 const parent=await tasks.propose(USER,{title:"public words",class:"implement",backlog:true});const result=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});
 for(const child of result.children){expect(child.history.find(entry=>entry.event==="screened")?.note).toBe("pii: inherited");expect(records.find(record=>record.task===child.id)).toEqual({task:child.id,item:"task",label:"pii",source:"inherited"});}
});


test("split undo retains memory references when the native store is unavailable",async()=>{
 const f=rig(),store=new MemoryStore({home:join(f.dir,"home")});cleanup.push(()=>store.close());const tasks=new Tasks({...f.deps,store:{store,project:"split",repo:"owner/repo"}}),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
 const result=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});await tasks.remember(USER,{text:"child note",task:result.children[0]!.id});
 const withoutStore=new Tasks(f.deps);await expect(withoutStore.undoPlanning(USER,parent.id,1)).rejects.toThrow("memory");expect(f.board.get(result.children[0]!.id)).toBeDefined();
});
test("split undo retains legacy native entries without a board reference marker",async()=>{
 const f=rig(),store=new MemoryStore({home:join(f.dir,"home")});cleanup.push(()=>store.close());const tasks=new Tasks({...f.deps,store:{store,project:"split",repo:"owner/repo"}}),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
 const result=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});store.note({op:"note",project:"split",scope:"project",tier:"short",kind:"finding",peer:USER,text:"legacy child note",about:[],source:"person",task:taskKey("split",result.children[0]!)});
 await expect(tasks.undoPlanning(USER,parent.id,1)).rejects.toThrow("referenced");expect(f.board.get(result.children[0]!.id)).toBeDefined();
});

test("split undo retains parent-only memory while removing unused children",async()=>{
 const f=rig(),store=new MemoryStore({home:join(f.dir,"home")});cleanup.push(()=>store.close());const tasks=new Tasks({...f.deps,store:{store,project:"split",repo:"owner/repo"}}),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});
 await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});await tasks.remember(USER,{text:"parent note",task:parent.id});const undone=await tasks.undoPlanning(USER,parent.id,1).catch(()=>null);expect(undone).not.toBeNull();if(!undone)return;expect(undone.id).toBe(parent.id);expect(f.board.list()).toHaveLength(1);expect(store.hasTask(taskKey("split",parent))).toBe(true);
});

test("split retains stored task role ids when current catalog guidance disappears",async()=>{
 const f=rig(),catalog=(await import("../src/hub/roles.ts")).loadRoleCatalog();const tasks=new Tasks({...f.deps,catalog}),parent=await tasks.propose(USER,{title:"role parent",class:"implement",role:"backend-engineer",backlog:true});catalog.roles.delete("backend-engineer");
 const split=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"}).catch(()=>null);expect(split).not.toBeNull();if(!split)return;for(const child of split.children)expect(child.role).toBe("backend-engineer");
});

test("split undo retains children referenced by another task phase checklist",async()=>{
 const {tasks,board}=rig(),parent=await tasks.propose(USER,{title:"parent",class:"implement",backlog:true});const split=await tasks.splitBacklog(USER,{id:parent.id,revision:0,parts:[{title:"a"},{title:"b"}],reason:"parts"});const other=await tasks.propose(USER,{title:"phase integration",class:"implement",backlog:true});
 await tasks.moveBacklog(USER,other.id,true);tasks.recordLifecycle(USER,other.id,{phase:{id:"phase-one",tasks:[{id:split.children[0]!.id,after:[]}],criteria:[{id:"criterion-one",required:true,result:"unverified",refs:[]}]}});const before=JSON.stringify(board.list());await expect(tasks.undoPlanning(USER,parent.id,1)).rejects.toThrow("referenced by other work");expect(JSON.stringify(board.list())).toBe(before);
});
