import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks, type TasksDeps } from "../src/hub/tasks.ts";
import { requireConductor } from "../src/hub/conductor.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { realPath } from "../src/hub/project.ts";
import { sdlcConfig, type SdlcGh } from "../src/hub/sdlc.ts";
import type { Envelope } from "../src/hub/envelope.ts";

function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class Recorder extends BasePeer {
  got:Envelope[]=[];
  async start(){this.setState("idle");}
  async stop(){this.setState("offline");}
  async deliver(envs:Envelope[],id?:string){this.setState("busy");this.got.push(...envs);if(id)this.delivery({id,state:"completed"});this.setState("idle");}
}
async function fixture(extra:Partial<TasksDeps>={}) {
  const root=realPath(mkdtempSync(join(tmpdir(),"ahub-roster-authority-"))),board=new Board(join(root,"hub.db")),off=new Set<string>(),roles:Record<string,string[]>={codex:["conductor"]};
  const bus=new Bus({batchMs:0,rostered:peer=>!off.has(peer)}),peers=["kimi","local","codex","claude"].map(id=>new Recorder(id));
  for(const peer of peers){bus.add(peer);await peer.start();}
  const notices:string[]=[];
  const tasks=new Tasks({board,bus,cwd:root,project:"fixture",routing:()=>loadRouting(root),wipLimit:()=>3,notify:line=>{notices.push(line);},...extra});
  const current=()=>{if(off.has("codex"))throw new Error("initiating peer is off roster");requireConductor("codex",roles);};
  const owned=(title:string)=>{const row=board.propose("user",{title,class:"implement"});return board.update(row.id,"kimi","accepted",{owner:"kimi",reviewer:"claude",state:"in_progress"});};
  return {root,board,bus,tasks,off,roles,notices,current,owned,peers,async close(){bus.closeJournal();for(const peer of peers)await peer.stop();board.close();rmSync(root,{recursive:true,force:true});}};
}
const metadata=()=>({code:0,stdout:JSON.stringify({data:{repository:{issue:{number:1,state:"OPEN",createdAt:"2026-10-18T00:00:00Z",lastEditedAt:"2026-10-18T01:00:00Z"}}}})});

for(const revocation of ["role","membership"] as const)test(`roster handoff rechecks ${revocation} after actual plan-review metadata await before owner write`,async()=>{
  const entered=deferred<void>(),read=deferred<ReturnType<typeof metadata>>();
  const gh:SdlcGh=async()=>{entered.resolve();return read.promise;};
  const f=await fixture({sdlc:{config:()=>sdlcConfig({mode:"advise"}),gh}});
  let pending:Promise<unknown>|undefined;
  try {
    const row=f.owned("bounded plan read");
    const task=f.board.update(row.id,"user","lifecycle",{sdlc:{stage:"build",repo:"example/fixture",issue:1,planReview:{planner:"claude",planningRevision:0,recordedAt:1,issue:{repo:"example/fixture",issue:1,state:"OPEN",editedAt:"2026-10-18T01:00:00Z",lastEditedAt:"2026-10-18T01:00:00Z"}}}});
    f.off.add("kimi");pending=f.tasks.reassignForRoster("kimi",f.current);pending.catch(()=>{});
    await entered.promise;
    if(revocation==="role")f.roles.codex=[];else f.off.add("codex");
    read.resolve(metadata());await expect(pending).rejects.toThrow(revocation==="role"?"conductor role":"off roster");
    expect(f.board.get(task.id)).toEqual(task);expect(f.peers.flatMap(p=>p.got).some(e=>e.kind==="task")).toBe(false);
  } finally {read.resolve(metadata());await pending?.catch(()=>{});await f.close();}
});

for(const rejectBrief of [false,true])test(`roster brief ${rejectBrief?"rejection":"completion"} cannot swallow initiating revocation or continue another task`,async()=>{
  const entered=deferred<void>(),brief=deferred<string|undefined>();let calls=0;
  // This seam supplies brief data only. Authorization is the real mutable conductor/membership policy above.
  const briefSource={forTask:async()=>{calls++;entered.resolve();return brief.promise;}} satisfies Pick<NonNullable<TasksDeps["briefs"]>,"forTask">;
  const briefs=briefSource as unknown as TasksDeps["briefs"];
  const f=await fixture({briefs});let pending:Promise<unknown>|undefined;
  try {
    const first=f.owned("first saved assignment"),second=f.owned("second untouched assignment");f.off.add("kimi");
    pending=f.tasks.reassignForRoster("kimi",f.current);pending.catch(()=>{});await entered.promise;
    expect(f.board.get(first.id)!.owner).toBe("local");f.roles.codex=[];
    if(rejectBrief)brief.reject(new Error("brief unavailable"));else brief.resolve("fixture brief");
    await expect(pending).rejects.toThrow("conductor role");
    expect(f.board.get(first.id)!.history.filter(h=>h.event==="reassigned")).toHaveLength(1);
    expect(f.board.get(first.id)!.offer).toBeUndefined();expect(f.board.get(second.id)).toEqual(second);expect(calls).toBe(1);
    expect(f.notices.filter(line=>line.includes("assignment's delivery is not confirmed"))).toHaveLength(1);
    expect(f.peers.flatMap(p=>p.got).some(e=>e.kind==="task")).toBe(false);
  } finally {brief.resolve(undefined);await pending?.catch(()=>{});await f.close();}
});

test("roster revocation after the first actual publication retains that move but prevents the next owner and reviewer handoff",async()=>{
  const f=await fixture();try {
    const first=f.owned("first published assignment"),second=f.owned("second owner remains");
    const review=f.board.propose("user",{title:"reviewer remains",class:"implement"});f.board.update(review.id,"local","accepted",{owner:"local",reviewer:"kimi",state:"in_progress"});const reviewed=f.board.update(review.id,"local","done",{state:"in_review"});
    f.off.add("kimi");const publish=f.bus.publish.bind(f.bus),published:Envelope[]=[];
    f.bus.publish=env=>{published.push(env);const result=publish(env);if(env.kind==="task" && env.refs?.task===String(first.id))f.roles.codex=[];return result;};
    await expect(f.tasks.reassignForRoster("kimi",f.current)).rejects.toThrow("conductor role");
    expect(f.board.get(first.id)!.owner).toBe("local");expect(f.board.get(first.id)!.offer).toBeDefined();expect(f.board.get(second.id)).toEqual(second);expect(f.board.get(review.id)).toEqual(reviewed);
    expect(published.filter(e=>e.kind==="task").map(e=>e.refs?.task)).toEqual([String(first.id)]);expect(published.some(e=>e.kind==="review")).toBe(false);
    expect(f.notices.some(line=>line.includes("assignment's delivery is not confirmed"))).toBe(false);
  } finally {await f.close();}
});

test("roster reviewer write is fenced and a committed reviewer change cannot publish after revocation",async()=>{
  const f=await fixture();try {
    const row=f.board.propose("user",{title:"reviewer publication fence",class:"implement"});f.board.update(row.id,"local","accepted",{owner:"local",reviewer:"kimi",state:"in_progress"});f.board.update(row.id,"local","done",{state:"in_review"});f.off.add("kimi");
    const published:Envelope[]=[];const publish=f.bus.publish.bind(f.bus);f.bus.publish=env=>{published.push(env);return publish(env);};
    f.board.onChange=(_task,entry)=>{if(entry.event==="reviewer changed")f.roles.codex=[];};
    await expect(f.tasks.reassignForRoster("kimi",f.current)).rejects.toThrow("conductor role");
    expect(f.board.get(row.id)!.reviewer).toBe("claude");expect(f.board.get(row.id)!.history.filter(h=>h.event==="reviewer changed")).toHaveLength(1);expect(published.some(e=>e.kind==="review")).toBe(false);
  } finally {await f.close();}
});

test("roster and budget relays retain their normal positive behavior when no guard is supplied",async()=>{
  for(const kind of ["roster","budget"] as const){const f=await fixture();try {
    const first=f.owned(`${kind} first`),second=f.owned(`${kind} second`);f.off.add("kimi");
    const moved=kind==="roster"?await f.tasks.reassignForRoster("kimi"):await f.tasks.reassignForPause("kimi",undefined);
    expect(moved.map(m=>m.id)).toEqual([first.id,second.id]);expect(f.board.get(first.id)!.owner).toBe("local");expect(f.board.get(second.id)!.owner).toBe("local");
  } finally {await f.close();}}
});
