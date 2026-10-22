import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type Task } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { realPath } from "../src/hub/project.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { ReviewBrief } from "../src/hub/review-brief.ts";
import { HOST_CODE_SYMBOLS, buildTaskCodeSymbols } from "../src/hub/task-code-symbols.ts";
const HEAD="a".repeat(40), OTHER="b".repeat(40), BASE="c".repeat(40);
const cleanup:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function until(condition:()=>boolean){for(let i=0;i<300&&!condition();i++)await Bun.sleep(10);expect(condition()).toBe(true);}
function brief(head=HEAD,name="Alpha.first"):ReviewBrief {
 return {head,base:"origin/main",mergeBase:BASE,reviewable:[{path:"a.ts",status:"M"}],excluded:[],withheld:0,rules:[],rulesMissing:[],ruleGroups:[],unlisted:[],symbols:{state:"known",complete:true,planned:[],unplanned:[],unseen:[],files:[{path:"a.ts",symbols:[{path:"a.ts",name,kind:"fn",line:1,ambiguous:false,change:"unknown"}]}]}};
}
async function rig(extra:Partial<TasksDeps>={}) {
 const cwd=mkdtempSync(join(tmpdir(),"ahub-task-symbol-flow-")),board=new Board(join(cwd,"hub.db")),bus=new Bus({batchMs:0}),seen:{peer:string;body:string}[]=[];
 cleanup.push(()=>{board.close();rmSync(cwd,{recursive:true,force:true});});
 class Peer extends BasePeer {async start(){this.setState("idle");}async stop(){this.setState("offline");}async deliver(envs:{body:string}[]){seen.push(...envs.map(env=>({peer:this.id,body:env.body})));}}
 for(const id of ["codex","claude","kimi"]){const peer=new Peer(id,60000);bus.add(peer);await peer.start();cleanup.push(()=>peer.stop());}
 cleanup.push(()=>bus.closeJournal());
 let prepared=false;
 const tasks=new Tasks({cwd,board,bus,project:"fixture",notify:()=>{},routing:()=>loadRouting(cwd),prepareReviewBrief:async()=>{prepared=true;},reviewBrief:task=>{const out=brief(task.refs.commit,task.owner==="kimi"?"Beta.second":"Alpha.first");if(!prepared)out.symbols!.state="unknown";return out;},...extra});
 const add=(owner="codex",head=HEAD,refs={})=>{const t=board.propose("user",{title:"fixture",class:"implement",refs:{paths:["a.ts"],commit:head,...refs}});return board.update(t.id,owner,"accepted",{state:"in_progress",owner,reviewer:"claude"});};
 return {cwd,board,bus,tasks,add,seen};
}

test("admitted done stores screened current-head observations without extra history, and public reads are readonly",async()=>{
 const f=await rig(),task=f.add(),before=f.board.get(task.id)!.history.length;
 const done=await f.tasks.done("codex",task.id,"done");
 expect(done.codeSymbols).toMatchObject({head:HEAD,state:"known",complete:true,symbols:[{id:"symbol:Alpha.first@a.ts",path:"a.ts",name:"Alpha.first",kind:"fn"}]});
 expect(done.history).toHaveLength(before+1);
 const view=f.tasks.publicView(done);expect(view.codeSymbols).toBeDefined();expect(JSON.stringify(view.codeSymbols)).not.toContain("repositoryKey");expect(JSON.stringify(view.codeSymbols)).not.toContain("line");
 expect(f.board.get(task.id)!.history).toHaveLength(before+1);
 f.tasks.publicMetadataText=text=>!text.includes("Alpha");
 expect(f.tasks.publicView(done).codeSymbols).toMatchObject({complete:false,symbols:[]});
});

test("completion without a reviewer still prepares optional observations without adding a review gate",async()=>{
 const f=await rig(),task=f.add();f.board.update(task.id,"user","reviewer cleared",{reviewer:null});
 const done=await f.tasks.done("codex",task.id,"done");
 expect(done.state).toBe("approved");expect(done.codeSymbols).toMatchObject({head:HEAD,state:"known",complete:true});
});

test("completed notice uses current disjoint observations while retaining the review instruction",async()=>{
 const f=await rig(),other=f.add("kimi",OTHER);await f.tasks.done("kimi",other.id,"first done");
 f.board.update(other.id,"claude","changes_requested",{state:"changes_requested"});
 const mine=f.add();await f.tasks.done("codex",mine.id,"second done");
 await until(()=>f.seen.some(e=>e.peer==="kimi"&&e.body.startsWith(`Task #${mine.id} (owner codex)`)));
 const notice=f.seen.find(e=>e.peer==="kimi"&&e.body.startsWith(`Task #${mine.id} (owner codex)`))!.body;
 expect(notice).toContain("same file, different symbols");expect(notice).toContain("observed names only");expect(notice).toContain("Check your work against it");
});

test("stale or currently withheld observations preserve the plain completed-change notice",async()=>{
 for(const mode of ["stale","withheld"]){
  const f=await rig(),other=f.add("kimi",OTHER);await f.tasks.done("kimi",other.id,"first done");
  f.board.update(other.id,"claude","changes_requested",{state:"changes_requested"});
  if(mode==="stale")f.board.update(other.id,"kimi","new head",{refs:{commit:BASE}});
  else f.tasks.publicMetadataText=text=>!text.includes("Beta");
  const mine=f.add();await f.tasks.done("codex",mine.id,"second done");
  await until(()=>f.seen.some(e=>e.peer==="kimi"&&e.body.startsWith(`Task #${mine.id} (owner codex)`)));
  expect(f.seen.find(e=>e.peer==="kimi"&&e.body.startsWith(`Task #${mine.id} (owner codex)`))!.body).not.toContain("same file, different symbols");
 }
});

test("a pre-effect enforce refusal neither stores metadata nor invokes the optional projection",async()=>{
 let projections=0;
 const f=await rig({sdlc:{config:()=>sdlcConfig({mode:"enforce"})},reviewBrief:()=>{projections++;return brief();}}),task=f.add(),before=f.board.get(task.id)!.history.length;
 await expect(f.tasks.done("codex",task.id,"done")).rejects.toThrow();
 expect(f.board.get(task.id)!.history).toHaveLength(before);expect(f.board.get(task.id)!.codeSymbols).toBeUndefined();expect(projections).toBe(0);
});

test("a task moved during synchronous optional projection cannot write a done or old-head observation",async()=>{
 let mutate:undefined|(()=>void);
 const f=await rig({reviewBrief:task=>{mutate?.();mutate=undefined;return brief(task.refs.commit);}}),task=f.add();
 mutate=()=>{f.board.update(task.id,"codex","head moved",{refs:{commit:OTHER}});};
 await expect(f.tasks.done("codex",task.id,"done")).rejects.toThrow("flow revision changed");
 expect(f.board.get(task.id)!.history.some(entry=>entry.event==="done")).toBe(false);expect(f.board.get(task.id)!.codeSymbols).toBeUndefined();expect(f.board.get(task.id)!.refs.commit).toBe(OTHER);
});

test("delayed completion checks retain the admitted head observation through the final done",async()=>{
 let finish!:(value:{code:number;tail:string;timedOut:boolean})=>void;
 const f=await rig({check:()=>"fixture check",runCheck:()=>new Promise(resolve=>{finish=resolve;})}),task=f.add();
 const checking=await f.tasks.done("codex",task.id,"done");expect(checking.codeSymbols?.head).toBe(HEAD);expect(checking.state).toBe("in_progress");
 await until(()=>!!finish);finish({code:0,tail:"check passed",timedOut:false});
 await until(()=>f.board.get(task.id)?.state==="in_review" && f.board.get(task.id)?.codeSymbols?.head===HEAD);
 expect(f.tasks.isChecking(task.id)).toBe(false);expect(f.board.get(task.id)!).toMatchObject({state:"in_review",codeSymbols:{head:HEAD,state:"known"}});
});

test("lifecycle and task repository disagreement cannot populate or publicly expose local symbols",async()=>{
 const f=await rig(),task=f.add();
 f.board.update(task.id,"user","lifecycle linked",{sdlc:{stage:"build",repo:"other/repo"}});
 const done=await f.tasks.done("codex",task.id,"done");expect(done.codeSymbols).toBeUndefined();
 const other=f.add();const local=await f.tasks.done("codex",other.id,"done");expect(local.codeSymbols).toBeDefined();
 expect(f.tasks.publicView({...local,sdlc:{stage:"review",repo:"other/repo"}}).codeSymbols).toBeUndefined();
});

test("foreign repository and private task observations remain absent",async()=>{
 let queries=0;
 const f=await rig({reviewBrief:task=>{queries++;return brief(task.refs.commit);}}),foreign=f.add("codex",HEAD,{repo:"other/repo"});
 await f.tasks.done("codex",foreign.id,"done");expect(f.board.get(foreign.id)!.codeSymbols).toBeUndefined();
 const privateTask=f.board.propose("user",{title:"private",class:"implement",signals:["pii_path"],refs:{commit:HEAD}});
 f.board.update(privateTask.id,"local","accepted",{state:"in_progress",owner:"local",reviewer:"user"});
 const before=queries;await f.tasks.done("local",privateTask.id,"done");expect(queries).toBe(before);expect(f.board.get(privateTask.id)!.codeSymbols).toBeUndefined();expect(f.tasks.publicView(f.board.get(privateTask.id)!).codeSymbols).toBeUndefined();
});

const freePort=()=>{const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response()}),port=server.port!;server.stop(true);return port;};
test("console task detail and UI snapshot carry only public head-bound symbol metadata",async()=>{
 const cwd=realPath(mkdtempSync(join(tmpdir(),"ahub-code-symbol-snapshot-"))),stateDir=join(cwd,".agenthub/state");mkdirSync(stateDir,{recursive:true});
 const board=new Board(join(stateDir,"hub.db")),task=board.propose("user",{title:"public fixture",class:"implement",refs:{commit:HEAD,paths:["a.ts"]}});
 const other=board.propose("user",{title:"other public fixture",class:"implement",refs:{commit:OTHER,paths:["a.ts"]}});
 board.update(other.id,"user","fixture",{owner:"kimi",state:"in_progress",codeSymbols:buildTaskCodeSymbols(brief(OTHER,"Beta.second"),`path:${cwd}`,()=>true)},undefined,{},undefined,HOST_CODE_SYMBOLS);
 const privateOther=board.propose("user",{title:"private fixture",class:"implement",signals:["pii_path"],refs:{commit:BASE,paths:["a.ts"]}});
 board.update(privateOther.id,"user","fixture",{owner:"local",state:"in_progress"});
 board.update(task.id,"user","fixture",{owner:"codex",state:"in_progress",codeSymbols:buildTaskCodeSymbols(brief(),`path:${cwd}`,()=>true)},undefined,{},undefined,HOST_CODE_SYMBOLS);board.close();
 const daemon=await startDaemon({cwd,stateDir,controlPort:0,codexAppPort:freePort(),codexProxyPort:freePort(),config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false,native:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},snapshots:{...DEFAULT_CONFIG.snapshots,enabled:false},task_sweep:{...DEFAULT_CONFIG.task_sweep,enabled:false},pi:{...DEFAULT_CONFIG.pi,enabled:false,auto_start:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false}}});
 let client:ControlClient|undefined;
 try {
  client=await ControlClient.connect(stateDir,{role:"console",projectRoot:cwd});
  const snapshot=await client.request({t:"ui_snapshot",after:0});
  expect(snapshot.tasks.find((t:Task)=>t.id===task.id).codeSymbols).toMatchObject({head:HEAD,symbols:[{name:"Alpha.first"}]});
  const detail=await client.request({t:"task",op:"task_show",args:{id:task.id}});
  expect(detail.ok).toBe(true);
  expect(JSON.parse(detail.text).symbolOverlaps).toEqual([{task:other.id,files:["a.ts"],sameFileDifferentSymbols:true}]);
  const privateDetail=await client.request({t:"task",op:"task_show",args:{id:privateOther.id}});
  expect(JSON.parse(privateDetail.text).symbolOverlaps).toEqual([]);
  expect(detail.text).toContain("Alpha.first");expect(detail.text).not.toContain("repositoryKey");expect(JSON.stringify(snapshot.tasks)).not.toContain("repositoryKey");
 } finally {client?.close();await daemon.stop();rmSync(cwd,{recursive:true,force:true});}
},20000);


test("short or mismatched brief heads stay optional instead of refusing completion",async()=>{
 for(const [requested,observed] of [[HEAD.slice(0,7),HEAD],[HEAD,OTHER]] as const){
  const f=await rig({reviewBrief:()=>brief(observed)}),task=f.add("codex",requested);
  const done=await f.tasks.done("codex",task.id,"done");
  expect(done.state).toBe("in_review");expect(done.codeSymbols).toBeUndefined();
 }
});

function storeSymbols(f: Awaited<ReturnType<typeof rig>>, task: Task, name: string, complete = true) {
 const observed = brief(task.refs.commit, name); observed.symbols!.complete = complete;
 f.board.update(task.id,"user","fixture observation",{codeSymbols:buildTaskCodeSymbols(observed,`path:${realPath(f.cwd)}`,()=>true)},undefined,{},undefined,HOST_CODE_SYMBOLS);
 return f.board.get(task.id)!;
}

test("symbol overlaps project current screened pair evidence without changing history",async()=>{
 const f=await rig(),left=f.add(),right=f.add("kimi",OTHER);
 const mine=storeSymbols(f,left,"Alpha.first");storeSymbols(f,right,"Beta.second");
 const before=f.board.list().map(t=>t.history),seen=f.seen.length;
 expect(f.tasks.symbolOverlaps(mine)).toEqual([{task:right.id,files:["a.ts"],sameFileDifferentSymbols:true}]);
 expect(f.board.list().map(t=>t.history)).toEqual(before);expect(f.seen).toHaveLength(seen);
 // The current screen, not the earlier capture policy, decides whether this claim is safe.
 f.tasks.publicMetadataText=text=>!text.includes("Beta");
 expect(f.tasks.symbolOverlaps(mine)).toEqual([{task:right.id,files:["a.ts"],sameFileDifferentSymbols:false}]);
 f.tasks.publicMetadataText=text=>!text.includes("a.ts");
 expect(f.tasks.symbolOverlaps(mine)).toEqual([{task:right.id,files:[],sameFileDifferentSymbols:false}]);
});

test("symbol overlaps keep ordinary overlap for unknown incomplete shared and stale observations",async()=>{
 const f=await rig(),left=f.add(),right=f.add("kimi",OTHER),mine=storeSymbols(f,left,"Alpha.first");
 const plain=[{task:right.id,files:["a.ts"],sameFileDifferentSymbols:false}];
 expect(f.tasks.symbolOverlaps(mine)).toEqual(plain);
 storeSymbols(f,right,"Beta.second",false);expect(f.tasks.symbolOverlaps(mine)).toEqual(plain);
 storeSymbols(f,right,"Alpha.first");expect(f.tasks.symbolOverlaps(mine)).toEqual(plain);
 storeSymbols(f,right,"Beta.second");f.board.update(right.id,"kimi","new head",{refs:{commit:BASE}});
 expect(f.tasks.symbolOverlaps(mine)).toEqual(plain);
});

test("symbol overlaps exclude private tasks on either side and different repositories",async()=>{
 const f=await rig(),left=f.add(),right=f.add("kimi",OTHER),mine=storeSymbols(f,left,"Alpha.first");storeSymbols(f,right,"Beta.second");
 f.board.update(right.id,"user","private",{signals:["pii_path"]});expect(f.tasks.symbolOverlaps(mine)).toEqual([]);
 f.board.update(right.id,"user","public",{signals:[]});
 expect(f.tasks.symbolOverlaps({...mine,signals:["pii_path"]})).toEqual([]);
 f.board.update(right.id,"user","other repo",{refs:{repo:"other/repo"}});expect(f.tasks.symbolOverlaps(mine)).toEqual([]);
});
