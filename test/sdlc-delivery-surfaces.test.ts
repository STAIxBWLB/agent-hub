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
test("delivery queue RPC and dashboard readbacks are console-only and perform no task mutation (#257)",async()=>{
 const dir=root(),bin=join(dir,"bin"),record=join(dir,"calls");mkdirSync(bin);const program=join(bin,"gh");writeFileSync(program,'#!/bin/sh\nprintf call >> "'+record+'"\nprintf "[]\\n"\n');chmodSync(program,0o755);
 const old=process.env.PATH;process.env.PATH=bin+":"+old;cleanup.push(()=>{process.env.PATH=old});
 const stateDir=join(dir,"state"),daemon=await startDaemon({cwd:dir,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false},snapshots:{...DEFAULT_CONFIG.snapshots,enabled:false}}});cleanup.push(()=>daemon.stop());
 const client=await ControlClient.connect(stateDir,{role:"console"});cleanup.push(()=>client.close());
 const tools=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});cleanup.push(()=>tools.close());
 expect((await tools.request({t:"sdlc",op:"queue",repo:"owner/repo"})).ok).toBe(false);
 const before=await client.request({t:"task",op:"hub_task_list",args:{}});
 const queue=await client.request({t:"sdlc",op:"queue",repo:"owner/repo"});expect(queue.ok).toBe(true);expect(queue.report.rows).toEqual([]);expect(queue.report.complete).toBe(true);
 const status=(await client.request({t:"status"})).status;
 expect((await client.request({t:"ui_action",instanceId:status.instanceId,action:{action:"sdlc_queue",repo:"owner/repo"}})).ok).toBe(true);
 expect((await tools.request({t:"ui_action",instanceId:status.instanceId,action:{action:"sdlc_queue",repo:"owner/repo"}})).ok).toBe(false);
 expect(await client.request({t:"task",op:"hub_task_list",args:{}})).toMatchObject({text:before.text});
 expect(readFileSync(record,"utf8")).toBe("callcall");
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
  return{code:0,stdout:JSON.stringify({data:{repository:{pullRequest:{headRefOid:head,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}})};
 };
 const tasks=new Tasks({board,bus:new Bus({batchMs:0}),cwd:dir,project:"fixture",notify:()=>{},routing:()=>loadRouting(dir),sdlc:{config:()=>sdlcConfig({mode:"enforce",required_checks:["gate"]}),gh}});
 const report=await tasks.deliveryQueue("owner/repo");expect(report.complete).toBe(false);expect(report.order).toEqual([]);expect(report.unordered).toEqual([1]);expect(report.rows[0]?.blockers).toContain("board changed during delivery readback");
});
