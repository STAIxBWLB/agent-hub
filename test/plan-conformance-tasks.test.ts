import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { sdlcConfig } from "../src/hub/sdlc.ts";
const A = "a".repeat(40), B = "b".repeat(40), closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });
function rig(mode: "off" | "advise" | "enforce" = "enforce") {
 const cwd=mkdtempSync(join(tmpdir(),"ahub-plan-conformance-")),board=new Board(join(cwd,"hub.db")),bus=new Bus({batchMs:0}), routing=loadRouting(cwd);
 const state={mode,head:A,paths:["src/a.ts","src/extra.ts"],complete:true, calls:[] as string[][],gate:undefined as Promise<void>|undefined};
 const tasks=new Tasks({cwd,project:"fixture",repository:"o/r",board,bus,routing:()=>routing,notify:()=>{},sdlc:{config:()=>sdlcConfig({mode:state.mode,required_checks:["gate"]}),gh:async args=>{
 state.calls.push(args); await state.gate;
 return {code:0,stdout:JSON.stringify(args[0]==="pr"?{headRefOid:state.head,state:"OPEN",reviewDecision:"APPROVED",reviewRequests:[],statusCheckRollup:[{name:"gate",conclusion:"SUCCESS"}],files:state.paths.map(path=>({path})),changedFiles:state.paths.length+(state.complete?0:1)}:{data:{repository:{pullRequest:{headRefOid:state.head,reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}})};
 }}});
 const row=board.propose("user",{title:"conformance",class:"implement",plan:{paths:["src/a.ts","src/untouched.ts"]}});
 board.update(row.id,"user","accepted",{state:"in_progress",owner:"codex",reviewer:"claude"});
 board.update(row.id,"codex","done",{state:"in_review",refs:{commit:A},sdlc:{stage:"review",repo:"o/r",issue:1,pr:2,localHead:A,localResult:"passed"}});
 closes.push(()=>{bus.closeJournal();board.close();rmSync(cwd,{recursive:true,force:true});}); return {cwd,board,bus,tasks,state,id:row.id};
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
