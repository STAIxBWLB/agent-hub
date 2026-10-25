import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f()});
const root=()=>{const dir=mkdtempSync(join(tmpdir(),"ahub-delivery-surface-"));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));return dir};
test("delivery queue RPC is public while dashboard actions stay console-only and perform no task mutation (#257)",async()=>{
 const dir=root(),bin=mkdtempSync(join(tmpdir(),"ahub-delivery-host-gh-")),record=join(dir,"calls");cleanup.push(()=>rmSync(bin,{recursive:true,force:true}));const program=join(bin,"gh");writeFileSync(program,'#!/bin/sh\nprintf call >> "'+record+'"\nprintf "[]\\n"\n');chmodSync(program,0o755);
 const old=process.env.PATH;process.env.PATH=bin+":"+old;cleanup.push(()=>{process.env.PATH=old});
 mkdirSync(join(dir,".agenthub"));writeFileSync(join(dir,".agenthub/sdlc.toml"),'[repos."owner/repo"]\nrequired_checks = []\n');
 const stateDir=join(dir,"state"),daemon=await startDaemon({cwd:dir,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false},snapshots:{...DEFAULT_CONFIG.snapshots,enabled:false}}});cleanup.push(()=>daemon.stop());
 const client=await ControlClient.connect(stateDir,{role:"console"});cleanup.push(()=>client.close());
 const tools=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});cleanup.push(()=>tools.close());
 expect((await tools.request({t:"sdlc",op:"queue",repo:"owner/repo"})).ok).toBe(true);
 const before=await client.request({t:"task",op:"hub_task_list",args:{}});
 const queue=await client.request({t:"sdlc",op:"queue",repo:"owner/repo"});expect(queue.ok).toBe(true);expect(queue.report.rows).toEqual([]);expect(queue.report.complete).toBe(true);
 const status=(await client.request({t:"status"})).status;
 expect((await client.request({t:"ui_action",instanceId:status.instanceId,action:{action:"sdlc_queue",repo:"owner/repo"}})).ok).toBe(true);
 expect((await tools.request({t:"ui_action",instanceId:status.instanceId,action:{action:"sdlc_queue",repo:"owner/repo"}})).ok).toBe(false);
 expect(await client.request({t:"task",op:"hub_task_list",args:{}})).toMatchObject({text:before.text});
 expect(readFileSync(record,"utf8")).toBe("callcallcall");
});
test("queue board revision fence invalidates late evidence instead of offering stale merge readiness (#257)",async()=>{
 const dir=root(),board=new Board(join(dir,"hub.db"));cleanup.push(()=>board.close());const t=board.propose(USER,{title:"PRIVATE_TITLE_MARKER",class:"implement"});
 let changed=false;const gh:SdlcGh=async()=>{if(!changed){changed=true;board.update(t.id,USER,"changed",{owner:"codex"})}return{code:0,stdout:"[]"}};
 const tasks=new Tasks({board,bus:new Bus({batchMs:0}),cwd:dir,project:"fixture",notify:()=>{},routing:()=>loadRouting(dir),sdlc:{config:()=>sdlcConfig(undefined),gh}});
 const report=await tasks.deliveryQueue("owner/repo");expect(report.complete).toBe(false);expect(JSON.stringify(report)).not.toContain("PRIVATE_TITLE_MARKER");
});
test("board revision fence removes a previously ordered nonempty delivery result (#257)", async () => {
 const dir=root(),board=new Board(join(dir,"hub.db"));cleanup.push(()=>board.close());const t=board.propose(USER,{title:"fixture",class:"implement"}),head="a".repeat(40);
 board.update(t.id,USER,"lifecycle",{sdlc:{repo:"owner/repo",issue:273,pr:1,stage:"implement",reviewedHead:head,localHead:head,localResult:"passed"}});
 const gh:SdlcGh=async args=>{
  if(args[0]==="pr"&&args[1]==="list")return{code:0,stdout:JSON.stringify([{number:1,headRefOid:head,baseRefName:"main",baseRefOid:head}])};
  if(args[0]==="pr"){board.update(t.id,USER,"changed",{owner:"codex"});return{code:0,stdout:JSON.stringify({headRefOid:head,state:"OPEN",isDraft:false,baseRefName:"main",baseRefOid:head,changedFiles:1,files:[{path:"src/one.ts"}],statusCheckRollup:[{name:"gate",conclusion:"SUCCESS"}],reviewDecision:"APPROVED",reviewRequests:[]})}};
  if(args.some(arg=>arg.startsWith("query=")&&arg.includes("queue_p"))) {
    const gates = {
      headRefOid:head,state:"OPEN",isDraft:false,baseRefName:"main",baseRefOid:head,changedFiles:1,reviewDecision:"APPROVED",
      reviewRequests:{nodes:[],pageInfo:{hasNextPage:false}},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}},
      statusCheckRollup:{contexts:{nodes:[{name:"gate",conclusion:"SUCCESS"}],pageInfo:{hasNextPage:false}}},
    };
    return {code:0,stdout:JSON.stringify({data:{repository:{queue_p1:gates,pullRequests:{nodes:[{number:1,headRefOid:head,baseRefName:"main",baseRefOid:head}],pageInfo:{hasNextPage:false}}}}})};
  }
  return{code:0,stdout:JSON.stringify({data:{repository:{pullRequest:{headRefOid:head,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}})};
 };
 const tasks=new Tasks({board,bus:new Bus({batchMs:0}),cwd:dir,project:"fixture",notify:()=>{},routing:()=>loadRouting(dir),sdlc:{config:()=>sdlcConfig({mode:"enforce",required_checks:["gate"]}),gh}});
 const report=await tasks.deliveryQueue("owner/repo");expect(report.complete).toBe(false);expect(report.order).toEqual([]);expect(report.unordered).toEqual([1]);expect(report.rows[0]?.blockers).toContain("board changed during delivery readback");
});


test("aggregate lifecycle status excludes staged backlog without hiding executable work (#264 merge)", async () => {
  for (const mode of ["advise", "enforce"] as const) {
    const dir=root();mkdirSync(join(dir,".agenthub"));writeFileSync(join(dir,".agenthub/sdlc.toml"),`mode = "${mode}"\n`);
    const stateDir=join(dir,"state"),daemon=await startDaemon({cwd:dir,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,
      config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false},snapshots:{...DEFAULT_CONFIG.snapshots,enabled:false}}});cleanup.push(()=>daemon.stop());
    const client=await ControlClient.connect(stateDir,{role:"console"});cleanup.push(()=>client.close());
    expect((await client.request({t:"task",op:"hub_task_propose",args:{title:"future",class:"implement",backlog:true}})).ok).toBe(true);
    expect((await client.request({t:"task",op:"hub_task_propose",args:{title:"executable",class:"implement",after:[1]}})).ok).toBe(true);
    const status=await client.request({t:"sdlc",op:"status"});
    expect(status.ok).toBe(true);expect(status.mode).toBe(mode);expect(status.rows.map((row:any)=>row.id)).toEqual([2]);
    expect((await client.request({t:"sdlc",op:"explain",id:1})).ok).toBe(false);
    const listed=JSON.parse((await client.request({t:"task",op:"hub_task_list",args:{}})).text);
    expect(listed.map((task:any)=>[task.id,task.state])).toEqual([[1,"backlog"],[2,"proposed"]]);
  }
},20_000);


test("merge queue discards task associations when privacy policy changes during remote reads (#264 merge)", async () => {
  const dir=root(),board=new Board(join(dir,"hub.db"));cleanup.push(()=>board.close());
  const bus=new Bus({batchMs:0});cleanup.push(()=>bus.closeJournal());
  const routing=loadRouting(dir);routing.constraints.pii="off";
  const task=board.propose(USER,{title:"private marker",class:"implement",signals:["pii"]}),head="a".repeat(40);
  board.update(task.id,USER,"lifecycle",{sdlc:{repo:"owner/repo",pr:1,stage:"implement"}});
  const before=board.get(task.id)!;
  const gh:SdlcGh=async args=>{
    if(args[0]==="pr" && args[1]==="list"){
      routing.constraints.pii="local_only";
      return{code:0,stdout:JSON.stringify([{number:1,headRefOid:head,baseRefName:"main",baseRefOid:head}])};
    }
    if(args[0]==="pr")return{code:0,stdout:JSON.stringify({headRefOid:head,state:"OPEN",isDraft:false,baseRefName:"main",baseRefOid:head,changedFiles:1,files:[{path:"src/one.ts"}],statusCheckRollup:[],reviewDecision:"APPROVED",reviewRequests:[]})};
    return{code:0,stdout:"{}"};
  };
  const tasks=new Tasks({board,bus,cwd:dir,project:"fixture",notify:()=>{},routing:()=>routing,sdlc:{config:()=>sdlcConfig(undefined),gh}});
  expect(tasks.isPii(before)).toBe(false);
  const report=await tasks.deliveryQueue("owner/repo");
  expect(tasks.isPii(board.get(task.id)!)).toBe(true);expect(board.get(task.id)).toEqual(before);
  expect(report.complete).toBe(false);expect(report.rows).toEqual([]);expect(report.conflicts).toEqual([]);expect(report.order).toEqual([]);
  expect(JSON.stringify(report)).not.toContain(head);
});
