import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
const A = "a".repeat(40), B = "b".repeat(40), closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function rig(mode: "off" | "advise" | "enforce" = "enforce") {
 const cwd=mkdtempSync(join(tmpdir(),"ahub-plan-conformance-")),board=new Board(join(cwd,"hub.db")),bus=new Bus({batchMs:0}), routing=loadRouting(cwd);
 const state={mode,head:A,paths:["src/a.ts","src/extra.ts"],complete:true,changeType:"MODIFIED",queueList:false, calls:[] as string[][],gate:undefined as Promise<void>|undefined};
 const deps: TasksDeps={cwd,project:"fixture",repository:"o/r",board,bus,routing:()=>routing,notify:()=>{},sdlc:{config:()=>sdlcConfig({mode:state.mode,required_checks:["gate"]}),gh:async args=>{
 state.calls.push(args); await state.gate;
 if(state.queueList && args[0]==="pr" && args[1]==="list")return {code:0,stdout:JSON.stringify([{number:2,headRefOid:state.head,baseRefName:"main",baseRefOid:A}])};
 return {code:0,stdout:JSON.stringify(args[0]==="pr"?{headRefOid:state.head,state:"OPEN",reviewDecision:"APPROVED",reviewRequests:[],statusCheckRollup:[{name:"gate",conclusion:"SUCCESS"}],files:state.paths.map(path=>({path,changeType:state.changeType})),changedFiles:state.paths.length+(state.complete?0:1)}:{data:{repository:{pullRequest:{headRefOid:state.head,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}})};
 }}};
 const tasks=new Tasks(deps);
 const row=board.propose("user",{title:"conformance",class:"implement",plan:{paths:["src/a.ts","src/untouched.ts"]}});
 board.update(row.id,"user","accepted",{state:"in_progress",owner:"codex",reviewer:"claude"});
 board.update(row.id,"codex","done",{state:"in_review",refs:{commit:A},sdlc:{stage:"review",repo:"o/r",issue:1,pr:2,localHead:A,localResult:"passed"}});
 closes.push(()=>{bus.closeJournal();board.close();rmSync(cwd,{recursive:true,force:true});}); return {cwd,board,bus,tasks,deps,state,id:row.id};
}
test("S2 enforce refuses outside paths before verdict effects; amendment permits approval",async()=>{
 const r=rig(),before=r.board.get(r.id);
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan.*conformance|outside.*plan/i);
 expect(r.board.get(r.id)).toEqual(before);
 await r.tasks.review("user",r.id,"changes_requested","amend the plan");
 r.state.mode="off"; await r.tasks.acceptReviewed("codex",r.id,{paths:["src/"]}); r.state.mode="enforce";
 r.board.update(r.id,"codex","done",{state:"in_review"});
 expect((await r.tasks.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");
 expect(r.state.calls.flat().join(" ")).not.toMatch(/\bpatch\b|\bbody\b/);
});
test("S2 status reports outside and untouched; incomplete file readback is unknown",async()=>{
 const r=rig(); const report=await r.tasks.lifecycleStatus(r.id);
 expect((report as any).planConformance).toMatchObject({state:"departure",outside:["src/extra.ts"],untouched:["src/untouched.ts"]});
 r.state.complete=false;
 expect((await r.tasks.lifecycleStatus(r.id) as any).planConformance.state).toBe("unknown");
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan.*unknown/i);
});
test("S2 person acceptance is head plan link and full-inventory bound, agents cannot forge it",async()=>{
 const r=rig(); const accept=(by:string,head=A)=> (r.tasks as any).acceptPlanDeparture(by,r.id,head,"bounded exception");
 await expect(accept("claude")).rejects.toThrow(/person|console/i);
 await accept("user");
 r.state.paths.push("src/later.ts");
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan/i);
 r.state.paths.pop(); r.board.update(r.id,"codex","accepted",{plan:{paths:["src/a.ts"]}});
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan/i);
 await accept("user");
 expect((await r.tasks.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");
});
test("S2 acceptance refuses a wrong head or incomplete inventory before writes",async()=>{
 const r=rig(),before=r.board.get(r.id),accept=()=> (r.tasks as any).acceptPlanDeparture("user",r.id,B,"bounded exception");
 await expect(accept()).rejects.toThrow(/head/i); expect(r.board.get(r.id)).toEqual(before);
 r.state.complete=false;
 await expect((r.tasks as any).acceptPlanDeparture("user",r.id,A,"bounded exception")).rejects.toThrow(/unknown|complete/i);
 expect(r.board.get(r.id)).toEqual(before);
});
test("S2 advise reports departure but off adds no conformance gate",async()=>{
 for(const mode of ["advise","off"] as const){const r=rig(mode);expect((await r.tasks.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");}
});
test("S2 plan mutation during awaited approval cannot use stale coverage",async()=>{
 const r=rig();r.state.paths=["src/a.ts"];let release!:()=>void;r.state.gate=new Promise<void>(resolve=>{release=resolve});
 const pending=r.tasks.review("user",r.id,"approved",undefined,undefined,A).then(value=>({value}),error=>({error}));
 for(let i=0;i<30&&!r.state.calls.length;i++)await new Promise(resolve=>setImmediate(resolve));expect(r.state.calls.length).toBeGreaterThan(0);
 r.board.update(r.id,"codex","accepted",{plan:{paths:["elsewhere.ts"]}});release();const result=await pending;expect("error" in result && result.error.message).toMatch(/changed|identity/i);expect(r.board.get(r.id)?.state).toBe("in_review");
});
test("S2 host plan revisions and first observed push survive accepted plan changes",async()=>{
 const r=rig();const initial=await r.tasks.lifecycleStatus(r.id) as any;
 expect(initial.planConformance).toMatchObject({revisionsAfterFirstObservedPush:0,earlierPushes:"unknown"});
 const row=r.board.get(r.id)!;r.board.update(r.id,"codex","accepted",{plan:{...row.plan,paths:["src/"]}});
 expect((await r.tasks.lifecycleStatus(r.id) as any).planConformance.revisionsAfterFirstObservedPush).toBe(1);
 expect(r.board.get(r.id)?.history.some(h=>(h as any).planRevision)).toBe(true);
});

test("S2 a plan in another repository never covers identically named PR files",async()=>{
 const r=rig();r.state.paths=["src/a.ts"];
 r.board.update(r.id,"codex","accepted",{refs:{repo:"other/repository"},plan:{paths:["src/a.ts"]}});
 expect((await r.tasks.lifecycleStatus(r.id) as any).planConformance.state).toBe("unknown");
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance unknown/i);
 const report=await r.tasks.deliveryQueue("o/r");expect(report.rows.every(row=>!row.ready)).toBe(true);
});

test("S2 a changed plan cannot resurrect a departure receipt by reverting its text", async () => {
 const r=rig(),original=r.board.get(r.id)!.plan!;
 await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.board.update(r.id,"codex","accepted",{plan:{paths:["src/"]}});
 r.board.update(r.id,"codex","accepted",{plan:original});
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
});
test("S2 an observed head move away and back invalidates the previous acceptance", async () => {
 const r=rig();await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.state.head=B;await r.tasks.lifecycleStatus(r.id);r.state.head=A;
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
 await r.tasks.acceptPlanDeparture("user",r.id,A,"accept current inventory again");
 expect((await r.tasks.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");
});
test("S2 relinking away and back invalidates the previous acceptance", async () => {
 const r=rig();await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.tasks.recordLifecycle("user",r.id,{pr:3});r.tasks.recordLifecycle("user",r.id,{pr:2,localHead:A,localResult:"passed"});
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
});
test("S2 private acceptance refuses before any remote read and public view reveals only existence", async () => {
 const r=rig();await r.tasks.acceptPlanDeparture("user",r.id,A,"PRIVATE_REASON_CANARY");
 r.board.update(r.id,"user","private",{signals:["pii"]});r.state.calls=[];
 await expect(r.tasks.acceptPlanDeparture("user",r.id,A,"another reason")).rejects.toThrow(/private/i);
 expect(r.state.calls).toEqual([]);
 const view=r.tasks.publicView(r.board.get(r.id)!,true);
 expect(view.planDepartureAccepted).toBe(true);expect(JSON.stringify(view)).not.toContain("PRIVATE_REASON_CANARY");expect(JSON.stringify(view)).not.toContain("src/extra.ts");
});

test("S2 a positively observed inventory change cannot resurrect its old person receipt", async () => {
 const r=rig();await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.state.paths.push("src/new.ts");await r.tasks.lifecycleStatus(r.id);r.state.paths.pop();
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
});

test("S2 a restarted host cannot revive consent after an unpersisted refused-head observation", async () => {
 const r=rig();await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.state.head=B;await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow();
 r.state.head=A;const restarted=new Tasks(r.deps);
 await expect(restarted.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
 await restarted.acceptPlanDeparture("user",r.id,A,"person accepts in the new host lifetime");
 expect((await restarted.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");
});

test("S2 R1 lifecycle status reads never append history, including closed tasks", async () => {
 const r=rig(), before=r.board.get(r.id);
 await r.tasks.lifecycleStatus(r.id); await r.tasks.lifecycleStatus(r.id);
 expect(r.board.get(r.id)).toEqual(before);
 const closed=rig("advise");closed.board.update(closed.id,"user","approved",{state:"approved"});
 const saved=closed.board.get(closed.id);await closed.tasks.lifecycleStatus(closed.id);
 expect(closed.board.get(closed.id)).toEqual(saved);
});

test("S2 R1 advise transitions announce departure and unknown without refusing", async () => {
 for(const complete of [true,false]) {
  const r=rig("advise"), notices:string[]=[];r.deps.notify=notice=>{notices.push(notice);};r.state.complete=complete;
  expect((await r.tasks.review("user",r.id,"approved",undefined,undefined,A)).state).toBe("approved");
  expect(notices.some(notice=>notice.includes(complete?"changed files outside the plan":"plan conformance unknown"))).toBe(true);
 }
});

test("S2 R1 off-mode plans do not create content revision or observation metadata", async () => {
 const r=rig("off");r.board.update(r.id,"user","approved",{state:"approved"});
 const task=await r.tasks.propose("user",{title:"off-mode plan",class:"test",owner:"codex",plan:{paths:["src/a.ts"]}});
 r.board.update(task.id,"user","assigned",{owner:"codex"});
 const accepted=r.tasks.accept("codex",task.id,{paths:["src/extra.ts"]});
 expect(accepted.history.some(entry=>entry.planRevision || entry.planObservation)).toBe(false);
 const before=r.board.get(task.id);expect((await r.tasks.lifecycleStatus(task.id) as any).planConformance).toBeUndefined();
 expect(r.board.get(task.id)).toEqual(before);
});

test("S2 R1 status during an approval readback cannot perturb its history fence", async () => {
 const r=rig();r.state.paths=["src/a.ts"];
 let release!:()=>void;r.state.gate=new Promise<void>(resolve=>{release=resolve;});
 const pending=r.tasks.review("user",r.id,"approved",undefined,undefined,A).then(value=>({value}),error=>({error}));
 for(let i=0;i<30&&!r.state.calls.length;i++)await new Promise(resolve=>setImmediate(resolve));
 expect(r.state.calls.length).toBeGreaterThan(0);
 r.state.gate=undefined;
 try {await r.tasks.lifecycleStatus(r.id);} finally {release();}
 const result=await pending;expect("value" in result && result.value.state).toBe("approved");
});

test("S2 R1 off-mode plan edits cannot revive an earlier departure consent by reverting", async () => {
 const r=rig(), original=r.board.get(r.id)!.plan!;
 await r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure");
 r.state.mode="off";
 r.board.update(r.id,"codex","accepted",{plan:{paths:["src/"]}});
 r.board.update(r.id,"codex","accepted",{plan:original});
 r.state.mode="enforce";
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance/i);
});

test("S2 R1 a status observation persists only on the next review transition", async () => {
 const r=rig();await r.tasks.lifecycleStatus(r.id);
 expect(r.board.get(r.id)!.history.some(entry=>entry.planObservation)).toBe(false);
 r.board.update(r.id,"codex","accepted",{plan:{paths:["src/"]}});
 const saved=await r.tasks.review("user",r.id,"approved",undefined,undefined,A);
 expect(saved.history.find(entry=>entry.planObservation)?.planObservation?.revision).toBe(1);
 expect((await r.tasks.lifecycleStatus(r.id) as any).planConformance.revisionsAfterFirstObservedPush).toBe(1);
});

test("S2 R1 off-mode queue read captures no S2 head or revision", async () => {
 const r=rig("off");r.state.queueList=true;
 const before=r.board.get(r.id), report=await r.tasks.deliveryQueue("o/r");
 expect(report.rows[0]?.head).toBe(A);expect(report.rows[0]?.planConformance).toBeUndefined();
 expect((r.tasks as any).observedPlans.size).toBe(0);expect((r.tasks as any).planReads.size).toBe(0);
 expect(r.board.get(r.id)).toEqual(before);
});

for(const changeType of ["RENAMED","COPIED"])test(`S2 R1 ${changeType} refuses both approval and departure acceptance before writes`, async () => {
 const r=rig();r.state.changeType=changeType;const before=r.board.get(r.id);
 await expect(r.tasks.review("user",r.id,"approved",undefined,undefined,A)).rejects.toThrow(/plan conformance unknown/i);
 await expect(r.tasks.acceptPlanDeparture("user",r.id,A,"bounded departure")).rejects.toThrow(/inventory unknown/i);
 expect(r.board.get(r.id)).toEqual(before);
});
