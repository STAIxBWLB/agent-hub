import { expect, test } from "bun:test";
import { Board } from "../src/hub/board.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { Bus } from "../src/hub/bus.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dogfoodScorecard, source, missing, formatDogfood, type DogfoodInput } from "../src/hub/dogfood.ts";
import { dogfoodTasks, dogfoodEvents, dogfoodLines, dogfoodProjectProfile, readDogfood } from "../src/hub/dogfood-read.ts";
import type { StampedEvent } from "../src/hub/events.ts";
import type { ProfileTaskMetadata } from "../src/hub/dogfood-profile.ts";

const input = (): DogfoodInput => ({since:100,until:1000,projectProfile:source("writing"),tasks:source([]),events:source([]),prs:source([]),log:source([]),features:source([])});
const event = (at:number,value:object) => ({v:1,at:new Date(at).toISOString(),...((value as {type?:string}).type==="conflict" ? {concurrent:false} : {}),...value}) as StampedEvent;
const task = (id:number,profile:ProfileTaskMetadata["profile"]="writing",alias="draft",pii=false) => ({id,pii,history:[],profileMetadata:{profile,class:"implement",alias,history:[{at:10,event:"proposed"},{at:120,event:"accepted"},{at:150,event:"done"},{at:200,event:"changes_requested",criteria:["AC1"]},{at:250,event:"done"},{at:300,event:"approved"}]}});
function fixture() {const root=mkdtempSync(join(tmpdir(),"ahub-profile-report-"));return {root,close:()=>rmSync(root,{recursive:true,force:true})};}
const aggregate = (i:DogfoodInput,profile="writing") => dogfoodScorecard(i).profile!.rows.find(r=>r.profile===profile && r.alias===null)!;

test("writing and general fixture event logs add bound profile rows without PRs",()=>{
  const f=fixture();try {
    const file=join(f.root,"events.jsonl");
    writeFileSync(file,[event(120,{type:"task",id:1,event:"accepted",class:"implement",state:"in_progress",profile:"writing",profileClass:"draft",pii:false}),event(130,{type:"task",id:2,event:"proposed",class:"implement",state:"proposed",profile:"general",profileClass:"do",pii:false})].map(e=>JSON.stringify(e)).join("\n")+"\n");
    const i=input();i.projectProfile=source("dev");i.events=dogfoodEvents(dogfoodLines(file),i.since,i.until);i.tasks=source([task(1),task(2,"general","do")]);
    const r=dogfoodScorecard(i);expect(r.flow.prs).toEqual([]);
    expect(r.profile!.rows.map(r=>[r.profile,r.alias,r.baseClass])).toEqual([["general",null,null],["general","do","implement"],["writing",null,null],["writing","draft","implement"]]);
    expect(aggregate(i).flow).toMatchObject({proposed:0,accepted:1,approved:1,reviewRounds:2,firstPassApproval:0,proposeToApproveMs:{samples:1,p50:290,p90:290}});
    expect(aggregate(i).review).toEqual({changesRequested:1,checklistItems:null,criteria:[{id:"AC1",count:1}],privateCriteria:0});
  } finally {f.close();}
});

test("profile window retains proposal before window, excludes future verdicts and does not rebind stored profiles",()=>{
  const i=input();i.projectProfile=source("general");const t=task(1);t.profileMetadata.history.push({at:2000,event:"approved"});i.tasks=source([t,task(2,"general","do")]);
  expect(aggregate(i).flow.proposeToApproveMs.p90).toBe(290);
  expect(aggregate(i,"general").tasks).toEqual([2]);expect(aggregate(i).tasks).toEqual([1]);
  i.tasks.data.push({...task(3),profileMetadata:{...task(3).profileMetadata,history:[{at:50,event:"proposed"},{at:2000,event:"approved"}]}});
  expect(aggregate(i).tasks).toEqual([1]);
});

test("private aliases and criteria are counted without echoing syntactically valid private text",()=>{
  const i=input();const t=task(7,"writing","private_client",true);t.profileMetadata.history[3]!.criteria=["ClientIdentity"];i.tasks=source([t]);
  i.events=source([event(150,{type:"task",id:7,event:"done",state:"in_review",class:"implement",profile:"writing",profileClass:"private_client",pii:true,title:"PRIVATE_TITLE",paths:["PRIVATE_PATH"]})]);
  const r=dogfoodScorecard(i),text=JSON.stringify(r);
  expect(text).not.toMatch(/private_client|ClientIdentity|PRIVATE_/);
  expect(r.profile!.rows.find(r=>r.alias==="withheld")?.baseClass).toBe("implement");
  expect(aggregate(i).privacy.privateTasks).toBe(1);expect(aggregate(i).review.privateCriteria).toBe(1);expect(aggregate(i).review.criteria).toEqual([]);
});

test("public custom aliases retain distinct stored base groups after config change",()=>{
  const i=input();i.projectProfile=source("general");i.tasks=source([task(1,"writing","copyedit"),task(2,"writing","translate_client")]);
  expect(dogfoodScorecard(i).profile!.rows.filter(r=>r.baseClass).map(r=>r.alias)).toEqual(["copyedit","translate_client"]);
});

test("missing incomplete and unrecorded sources are unknown, including intact empty event logs",()=>{
  const i=input();i.tasks=source([task(1)],false);i.events=missing([]);
  const r=aggregate(i);expect(r.flow.accepted).toBeNull();expect(r.flow.proposeToApproveMs.samples).toBeNull();expect(r.snapshots.durationMs.samples).toBeNull();expect(r.review.criteria).toBeNull();expect(r.overlap.pathNotices).toBeNull();expect(r.cost.perTask![0]!.peers).toBeNull();
  i.tasks=source([task(1)]);i.events=source([]);
  const known=aggregate(i);expect(known.flow.accepted).toBe(1);expect(known.overlap.pathNotices).toBe(0);
  expect(known.undo).toEqual({requests:null,completed:null,guardRefused:null});expect(known.profileErrors).toEqual({unknownAlias:null,otherProfileAlias:null});
  expect(known.privacy).toMatchObject({refusals:null,memoryNotesDropped:null,observedPiiNoteScreens:null,captureRowsDropped:null});
  expect(known.deliverables).toEqual({recordedCount:null,changedSinceApproval:null,unknownStates:null});expect(known.snapshots.durationMs.p90).toBeNull();expect(formatDogfood(dogfoodScorecard(i)).join("\n")).toContain('"unknown"');
});

test("event-only profiles identify groups but cannot invent full task history or pre-window lead time",()=>{
  const i=input();i.tasks=missing([]);i.projectProfile=source("dev");i.events=source([event(120,{type:"task",id:4,class:"implement",profile:"general",profileClass:"do",event:"approved",state:"approved",pii:false})]);
  const r=aggregate(i,"general");expect(r.tasks).toEqual([4]);expect(r.flow.approved).toBe(1);expect(r.flow.scope).toBe("recorded_events");expect(r.flow.reviewRounds).toBe(1);expect(r.flow.firstPassApproval).toBeNull();expect(r.flow.proposeToApproveMs.p50).toBeNull();
});

test("overlap counters use recorded section prefix and later exact task-pair edit evidence without paths",()=>{
  const i=input();i.tasks=source([task(1),task(2)]);i.events=source([
    event(110,{type:"overlap",task:1,owner:"codex",others:[{task:2,owner:"claude",paths:["PRIVATE_PATH"],symbols:["section PRIVATE_ANCHOR"]}]}),
    event(105,{type:"conflict",task:1,other:2,paths:["PRIVATE_PATH"]}),event(130,{type:"conflict",task:1,other:3,paths:["PRIVATE_PATH"]}),
    event(140,{type:"conflict",task:2,other:1,paths:["different"]}),event(150,{type:"conflict",task:2,other:1,paths:["PRIVATE_PATH"]}),event(160,{type:"conflict",task:1,other:2,paths:["PRIVATE_PATH"]}),
  ]);
  expect(aggregate(i).overlap).toEqual({pathNotices:1,sectionNotices:1,observedPathEditPairs:1,sectionEditPairs:null});expect(JSON.stringify(dogfoodScorecard(i))).not.toMatch(/PRIVATE_/);
});

test("recorded snapshot duration and cost use actual task attribution and existing usage dedupe",()=>{
  const i=input();i.tasks=source([task(1),task(2)]);
  const usage=event(200,{type:"usage",peer:"codex",task:1,attribution:"delivery",source:"omniroute",id:"same",inputTokens:10,outputTokens:5,totalTokens:15,provider:"PRIVATE_PROVIDER"});
  i.events=source([usage,usage,event(210,{type:"tokens",peer:"codex",task:1,attribution:"delivery",n:15}),event(220,{type:"turn_end",peer:"codex",task:1,attribution:"delivery",ms:10,snapshotMs:8}),event(230,{type:"turn_end",peer:"codex",task:1,attribution:"unattributed",ms:5,snapshotMs:999})]);
  const r=aggregate(i);expect(r.snapshots).toEqual({budgetExhaustions:null,durationMs:{samples:1,p50:8,p90:8}});
  expect(r.cost.perTask).toEqual([{task:1,peers:{codex:{tokens:15,input:10,output:5,cacheRead:null,cacheWrite:null,total:15,records:1}}},{task:2,peers:null}]);expect(JSON.stringify(dogfoodScorecard(i))).not.toContain("PRIVATE_PROVIDER");
});

test("bounded readonly collector supports old tables and strips private aliases criteria and deliverable metadata",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT)");
    db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(1,"{}",'["pii_path"]',JSON.stringify([{at:120,event:"done",note:"PRIVATE_NOTE",deliverables:[{id:"d-123456789abc",path:"PRIVATE_PATH",format:"PRIVATE_FORMAT"}]},{at:140,event:"changes_requested",unmetCriteria:["ClientIdentity"]}]),"implement",'{"profile":"writing","profileClass":"private_client"}');db.close();
    const collected=dogfoodTasks(file);expect(collected.complete).toBe(true);expect(JSON.stringify(collected)).not.toMatch(/PRIVATE_|private_client|ClientIdentity/);
    const i=input();i.tasks=collected;expect(aggregate(i).deliverables.recordedCount).toBe(1);expect(aggregate(i).review.privateCriteria).toBe(1);
    const old=join(f.root,"old.db"),legacy=new Database(old);legacy.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT)");legacy.query("INSERT INTO tasks VALUES(1,'{}','[]','[]')").run();legacy.close();expect(dogfoodTasks(old)).toMatchObject({available:true,complete:true});
  } finally {f.close();}
});

test("profile config read is bounded data only, merges profile selection without executing module declarations",async()=>{
  const f=fixture();try {
    mkdirSync(join(f.root,".agenthub"));writeFileSync(join(f.root,".agenthub/config.json"),JSON.stringify({profile:"writing",adapter_modules:["./module.ts"]}));writeFileSync(join(f.root,"module.ts"),'throw new Error("MUST_NOT_EXECUTE")');
    writeFileSync(join(f.root,".agenthub/config.local.json"),'{"profile":"general"}');expect(dogfoodProjectProfile(f.root).data).toBe("general");
    const r=await readDogfood(f.root,f.root,100,1000,async()=>({code:1,stdout:""}));expect(r.profile!.rows[0]!.profile).toBe("general");expect(r.profile!.rows[0]!.flow.proposed).toBeNull();
    writeFileSync(join(f.root,".agenthub/config.local.json")," ".repeat(128*1024+1));expect(dogfoodProjectProfile(f.root).available).toBe(false);
    writeFileSync(join(f.root,".agenthub/config.local.json"),'{"profile":"private_client"}');expect(dogfoodProjectProfile(f.root).data).toBeNull();
  } finally {f.close();}
});

test("dev-only input never adds profile and historical dev golden remains byte-identical",()=>{
  const raw=readFileSync(join(import.meta.dir,"fixtures/dogfood-dev-input.json"),"utf8");const i=JSON.parse(raw) as DogfoodInput;
  const expected=readFileSync(join(import.meta.dir,"fixtures/dogfood-dev-scorecard.json"),"utf8");expect(JSON.stringify(dogfoodScorecard(i),null,2)+"\n").toBe(expected);
  expect(dogfoodScorecard({...i,projectProfile:source("dev")})).not.toHaveProperty("profile");
});

test("event-only unknown privacy withholds valid custom identifiers and ignores missing profile binding",()=>{
  const i=input();i.projectProfile=source("dev");i.tasks=missing([]);
  i.events=source([event(120,{type:"task",id:1,class:"implement",profile:"writing",profileClass:"client_identity",event:"proposed",state:"proposed"}),event(121,{type:"task",id:2,class:"implement",profileClass:"unbound_client",event:"proposed",state:"proposed",pii:false})]);
  const r=dogfoodScorecard(i);expect(JSON.stringify(r)).not.toMatch(/client_identity|unbound_client/);expect(r.profile!.rows.map(r=>r.alias)).toEqual([null,"withheld"]);expect(aggregate(i).flow.proposed).toBeNull();expect(aggregate(i).flow.scope).toBeNull();
});

test("legacy missing profile metadata and criteria remain unknown instead of fabricated empty totals",()=>{
  const i=input();i.tasks=source([{id:1,pii:false,history:[]}]);i.events=missing([]);
  expect(aggregate(i).flow.proposed).toBeNull();expect(dogfoodScorecard(i).profile!.sources.tasks.bindingsComplete).toBe(false);
  const t=task(1);delete t.profileMetadata.history[3]!.criteria;i.tasks=source([t]);
  expect(aggregate(i).review.criteria).toBeNull();expect(aggregate(i).review.privateCriteria).toBeNull();
});

test("collector detects oversized profile binding and malformed evidence without reading private prose into output",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT)");
    const insert=db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?)");insert.run(1,"{}","[]","[]","implement"," ".repeat(65537));
    insert.run(2,"{}","[]",JSON.stringify([{at:120,event:"changes_requested",unmetCriteria:["not a valid criterion"]}]),"implement",'{"profile":"writing","profileClass":"draft"}');db.close();
    const collected=dogfoodTasks(file);expect(collected.complete).toBe(false);expect(collected.data.find(t=>t.id===1)?.profileMetadata).toBeUndefined();
    const i=input();i.tasks=collected;i.events=missing([]);expect(aggregate(i).flow.proposed).toBeNull();expect(aggregate(i).review.criteria).toBeNull();
  } finally {f.close();}
});

test("deliverable IDs dedupe repeated done approval records and PII note screens stay generic",()=>{
  const i=input();const t=task(1);i.tasks=source([{...t,profileMetadata:{...t.profileMetadata,history:[...t.profileMetadata.history,{at:250,event:"done",deliverables:["d-123456789abc"]},{at:300,event:"approved",deliverables:["d-123456789abc"]}]}}]);
  i.events=source([event(150,{type:"pii_screen",task:1,item:"note",label:"pii",source:"screen"}),event(160,{type:"pii_screen",task:1,item:"note",label:"pii",source:"unknown"}),event(170,{type:"pii_screen",task:1,item:"note",label:"pii",source:"regex"}),event(180,{type:"pii_screen",task:1,item:"summary",label:"pii",source:"screen"})]);
  expect(aggregate(i).deliverables.recordedCount).toBe(1);expect(aggregate(i).privacy.observedPiiNoteScreens).toBe(3);expect(aggregate(i).privacy.memoryNotesDropped).toBeNull();
});

test("actual reviewer-less Tasks.done records approved state with only done history, counted once from production-shaped events",async()=>{
  const f=fixture(),file=join(f.root,"hub.db"),board=new Board(file),bus=new Bus({batchMs:0});
  const events:StampedEvent[]=[];
  board.onChange=(t,h)=>events.push(event(h.at,{type:"task",id:t.id,event:h.event,by:h.by,state:t.state,owner:t.owner,reviewer:t.reviewer,class:t.class,profile:t.profile,profileClass:t.profileClass,pii:t.signals.includes("pii")}));
  try {
    const t=board.propose("user",{title:"synthetic review fixture",class:"review",profile:"writing",profileClass:"review"});
    board.update(t.id,"user","accepted",{state:"in_progress",owner:"user"});
    const tasks=new Tasks({board,bus,routing:()=>loadRouting(f.root),cwd:f.root,project:"fixture",profile:"writing",notify:()=>{}});
    const done=await tasks.done("user",t.id,"synthetic result");expect(done.state).toBe("approved");expect(done.history.map(h=>h.event)).toEqual(["proposed","accepted","done"]);
    expect(events.findLast(e=>e.type==="task")).toMatchObject({event:"done",state:"approved"});
    const i=input();i.since=0;i.until=Date.now()+1000;i.tasks=dogfoodTasks(file);i.events=source([...events,...events]);
    const r=aggregate(i);expect(r.flow).toMatchObject({scope:"history",proposed:1,accepted:1,approved:1,reviewRounds:0,firstPassApproval:null,autoApprovalTransitions:{scope:"recorded_events",value:1}});expect(r.flow.proposeToApproveMs.samples).toBe(1);expect(r.flow.proposeToApproveMs.p50).not.toBeNull();
    i.events=missing([]);const absent=aggregate(i);expect(absent.flow.approved).toBeNull();expect(absent.flow.proposeToApproveMs).toEqual({samples:null,p50:null,p90:null});expect(absent.flow.reviewRounds).toBe(0);
    // The daemon retains the distinction this fixture observes; no new telemetry or runtime execution is needed.
    expect(readFileSync(join(import.meta.dir,"../src/hub/daemon.ts"),"utf8")).toContain('event({ type: "task", id: t.id, event: h.event, by: h.by, state: t.state');
  } finally {bus.closeJournal();board.close();f.close();}
});

test("event-only complete window counts supported milestones and explicit rounds, excludes automatic approval from review",()=>{
  const i=input();i.tasks=missing([]);
  const base={type:"task",class:"implement",profile:"writing",profileClass:"draft",pii:false};
  i.events=source([event(120,{...base,id:1,event:"proposed",state:"proposed"}),event(140,{...base,id:1,event:"accepted",state:"in_progress"}),event(160,{...base,id:1,event:"done",state:"approved"}),event(180,{...base,id:2,event:"changes_requested",state:"changes_requested"}),event(200,{...base,id:2,event:"approved",state:"approved"}),event(220,{...base,id:3,event:"cancelled",state:"cancelled"}),event(230,{...base,id:3,event:"escalated",state:"proposed"})]);
  const r=aggregate(i);expect(r.flow).toMatchObject({scope:"recorded_events",proposed:1,accepted:1,approved:2,cancelled:1,reviewRounds:2,escalations:1,firstPassApproval:null,autoApprovalTransitions:{value:1}});expect(r.flow.proposeToApproveMs).toEqual({samples:null,p50:null,p90:null});
  i.events.complete=false;expect(aggregate(i).flow).toMatchObject({scope:null,proposed:null,accepted:null,approved:null,reviewRounds:null});
});

test("complete empty event window reports recorded zero milestones while missing board history stays unknown",()=>{
  const i=input();i.tasks=missing([]);i.events=source([]);
  expect(aggregate(i).flow).toMatchObject({scope:"recorded_events",proposed:0,accepted:0,approved:0,cancelled:0,reviewRounds:0,firstPassApproval:null});expect(aggregate(i).flow.proposeToApproveMs.samples).toBeNull();
  i.events=missing([]);expect(aggregate(i).flow).toMatchObject({scope:null,proposed:null,approved:null,reviewRounds:null});
});

test("done in review never becomes approval and repeated board review rounds keep their recorded count",()=>{
  const i=input();const t=task(1);t.profileMetadata.history=[{at:10,event:"proposed"},{at:120,event:"accepted"},{at:150,event:"done"},{at:200,event:"changes_requested",criteria:["AC1"]},{at:200,event:"done"},{at:200,event:"changes_requested",criteria:["AC1"]}];i.tasks=source([t]);
  i.events=source([event(150,{type:"task",id:1,class:"implement",profile:"writing",profileClass:"draft",event:"done",state:"in_review",pii:false})]);
  const r=aggregate(i);expect(r.flow.approved).toBe(0);expect(r.flow.reviewRounds).toBe(2);expect(r.review.changesRequested).toBe(2);expect(r.flow.autoApprovalTransitions.value).toBe(0);
});

test("mixed profile and class overlap rows count only their own warned pairs from multi-other events",()=>{
  const i=input();const other=task(4,"general","check");other.profileMetadata.class="test";
  i.tasks=source([task(1,"general","do"),task(2,"writing","draft"),task(3,"general","do"),other]);
  i.events=source([event(110,{type:"overlap",task:1,owner:"codex",others:[{task:2,owner:"claude",paths:["writing_file"],symbols:["section writing_anchor"]},{task:3,owner:"local",paths:["general_file"]},{task:4,owner:"kimi",paths:["check_file"]}]}),event(150,{type:"conflict",task:1,other:3,paths:["general_file"]})]);
  const rows=dogfoodScorecard(i).profile!.rows;
  expect(aggregate(i).overlap).toMatchObject({pathNotices:1,sectionNotices:1,observedPathEditPairs:0});
  expect(aggregate(i,"general").overlap).toMatchObject({pathNotices:3,sectionNotices:1,observedPathEditPairs:1});
  expect(rows.find(r=>r.profile==="general" && r.alias==="check")!.overlap).toMatchObject({pathNotices:1,sectionNotices:0,observedPathEditPairs:0});
});

test("backlog pulled is a proposed milestone in history and recorded-event scopes",()=>{
  const i=input();const t=task(1);t.profileMetadata.history=[{at:10,event:"backlogged"},{at:120,event:"backlog pulled"},{at:200,event:"approved"}];i.tasks=source([t]);
  expect(aggregate(i).flow).toMatchObject({scope:"history",proposed:1,approved:1,proposeToApproveMs:{samples:1,p50:80,p90:80}});
  const base={type:"task",id:1,class:"implement",profile:"writing",profileClass:"draft",pii:false};i.events=source([event(120,{...base,event:"backlog pulled",state:"proposed"}),event(150,{...base,event:"backlog returned",state:"backlog"}),event(160,{...base,event:"backlog pulled",state:"proposed"})]);i.tasks=missing([]);
  expect(aggregate(i).flow).toMatchObject({scope:"recorded_events",proposed:1});
});

test("readonly collector refuses duplicate criterion IDs instead of counting a corrupt verdict twice",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT)");
    db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?)").run(1,"{}","[]",JSON.stringify([{at:120,event:"changes_requested",unmetCriteria:["AC1","AC1"]}]),"implement",'{"profile":"writing","profileClass":"draft"}');db.close();
    const collected=dogfoodTasks(file);expect(collected.complete).toBe(false);const i=input();i.tasks=collected;i.events=missing([]);expect(aggregate(i).review.criteria).toBeNull();expect(aggregate(i).review.changesRequested).toBeNull();
  } finally {f.close();}
});

test("readonly class and current-state caps mark source incomplete instead of certifying truncated metadata",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,state TEXT,project_profile TEXT)");
    const insert=db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)");
    insert.run(1,"{}","[]",JSON.stringify([{at:120,event:"done"}]),"x".repeat(49),"approved",'{"profile":"writing","profileClass":"draft"}');
    insert.run(2,"{}","[]",JSON.stringify([{at:120,event:"done"}]),"implement","x".repeat(33),'{"profile":"writing","profileClass":"draft"}');db.close();
    const collected=dogfoodTasks(file);expect(collected.complete).toBe(false);expect(collected.data.find(t=>t.id===1)?.profileMetadata).toBeUndefined();expect(collected.data.find(t=>t.id===2)?.profileMetadata?.state).toBeUndefined();
    const i=input();i.tasks=collected;i.events=missing([]);expect(aggregate(i).flow.approved).toBeNull();expect(aggregate(i).flow.proposeToApproveMs.samples).toBeNull();
  } finally {f.close();}
});

test("cost identity coverage is unknown when task and event sources are missing, known empty sources stay empty",()=>{
  const i=input();i.tasks=missing([]);i.events=missing([]);expect(aggregate(i).cost.perTask).toBeNull();
  i.tasks=source([]);expect(aggregate(i).cost.perTask).toEqual([]);
  i.tasks=missing([]);i.events=source([]);expect(aggregate(i).cost.perTask).toEqual([]);
});

test("stale unavailable or incomplete config data never selects a profile but bound non-dev evidence still does",()=>{
  const i=input();i.projectProfile=missing("writing");expect(dogfoodScorecard(i)).not.toHaveProperty("profile");
  i.projectProfile=source("writing",false);expect(dogfoodScorecard(i)).not.toHaveProperty("profile");
  i.tasks=source([task(1,"general","do")]);const r=dogfoodScorecard(i).profile!;expect(r.rows.map(r=>r.profile)).toEqual(["general","general"]);expect(r.sources.config).toEqual({available:true,complete:false});
  i.projectProfile=missing("writing");expect(dogfoodScorecard(i).profile!.rows.map(r=>r.profile)).toEqual(["general","general"]);
  i.projectProfile=source("writing");expect(dogfoodScorecard(i).profile!.rows.some(r=>r.profile==="writing")).toBe(true);
});

test("profile event binding cap bounds identities and aliases, preserves non-dev evidence beyond cap as unknown",()=>{
  const i=input();i.projectProfile=source("dev");i.tasks=missing([]);
  i.events=source([...Array.from({length:500},(_,index)=>event(120,{type:"task",id:index+1,event:"proposed",state:"proposed",class:"implement",profile:"dev",profileClass:`public_alias_${index}`,pii:false})),event(130,{type:"task",id:501,event:"proposed",state:"proposed",class:"implement",profile:"writing",profileClass:"beyond_cap_alias",pii:false})]);
  const r=dogfoodScorecard(i).profile!;expect(r.bindings).toEqual({limit:500,retained:500,complete:false});expect(r.rows.length).toBeLessThanOrEqual(504);
  expect(r.rows.every(r=>r.tasks.every(id=>id<=500))).toBe(true);expect(JSON.stringify(r)).not.toContain("beyond_cap_alias");
  const writing=r.rows.find(r=>r.profile==="writing")!;expect(writing).toBeDefined();expect(writing.tasks).toEqual([]);expect(writing.flow.proposed).toBeNull();expect(writing.snapshots.durationMs.samples).toBeNull();expect(writing.cost.perTask).toBeNull();
  expect(r.rows.every(r=>r.flow.proposed===null)).toBe(true);expect(r.sources.events.bindingsComplete).toBe(false);
});

test("profile collector and direct Source share fail-closed consumed-event validation with mixed valid evidence",()=>{
  const f=fixture();try {
    const file=join(f.root,"events.jsonl");
    const overlap={type:"overlap",task:1,owner:"codex",others:[{task:2,owner:"claude",paths:[],symbols:[]}]};
    const conflict={type:"conflict",task:1,other:2,paths:[],concurrent:false};
    const attributed={peer:"codex",task:1,attribution:"delivery",pii:false};
    const malformed:object[]=[
      {...overlap,others:"MALFORMED"},{...overlap,others:[{task:2,paths:"MALFORMED"}]},{...overlap,others:[{task:2,paths:[7]}]},
      {...overlap,others:[{task:2,paths:[],symbols:"MALFORMED"}]},{...overlap,others:[{task:0,paths:[]}]},{...overlap,others:[null]},
      {...conflict,paths:"MALFORMED"},{...conflict,other:0},{...conflict,task:"MALFORMED"},{...conflict,concurrent:"MALFORMED"},{...conflict,turns:["one"]},
      {type:"task",id:1,event:"proposed",state:"MALFORMED",class:"implement",profile:"writing",pii:false},
      {type:"task",id:1,event:"proposed",state:"proposed",class:"MALFORMED",profile:"writing",pii:false},
      {type:"task",id:1,event:"proposed",state:"proposed",class:"implement",profile:"MALFORMED",pii:false},
      {type:"task",id:1,event:"proposed",state:"proposed",class:"implement",profile:"writing",profileClass:[],pii:false},
      {type:"task",id:1,event:"proposed",state:"proposed",class:"implement",profile:"writing",pii:"MALFORMED"},
      {type:"tokens",...attributed,n:-1},{type:"tokens",...attributed,n:1,task:0},{type:"tokens",...attributed,n:1,attribution:"MALFORMED"},
      {type:"turn_end",...attributed,ms:10,snapshotMs:"MALFORMED"},{type:"turn_end",...attributed,ms:-1},{type:"turn_end",...attributed,ms:10,files:-1},
      {type:"usage",...attributed,source:"omniroute",id:"u",inputTokens:-1},{type:"usage",...attributed,source:"MALFORMED",id:"u"},
      {type:"usage",...attributed,source:"omniroute",id:"u",cacheReadTokens:"MALFORMED"},{type:"usage",...attributed,source:"omniroute",id:"u",measuredAt:"MALFORMED"},
      {type:"pii_screen",task:1,item:"note",label:"unknown",source:"screen"},{type:"pii_screen",task:1,item:"MALFORMED",label:"pii",source:"screen"},
      {type:"pii_screen",task:1,item:"note",label:"pii",source:"MALFORMED"},{type:"pii_screen",task:0,item:"note",label:"pii",source:"screen"},
      {type:"pii_screen",task:1,item:"note",label:"pii",source:"screen",ms:-1},{type:"pii_screen",task:1,item:"note",label:"pii",source:"screen",category:"MALFORMED"},
      {type:"pii_screen",task:1,item:"note",label:"pii",source:"screen",miss:"MALFORMED"},
    ];
    const valid=event(120,overlap);
    for (const value of malformed) {
      const bad=event(130,value);writeFileSync(file,[valid,bad].map(e=>JSON.stringify(e)).join("\n")+"\n");
      const collected=dogfoodEvents(dogfoodLines(file),100,1000);expect(collected.complete).toBe(false);expect(collected.data).toEqual([valid]);
      for (const events of [collected,source([valid,bad])]) {
        const i=input();i.tasks=source([task(1)]);i.events=events;
        const report=dogfoodScorecard(i).profile!,r=report.rows.find(r=>r.profile==="writing" && r.alias===null)!;
        expect(report.sources.events.complete).toBe(false);expect(r.overlap.pathNotices).toBeNull();expect(r.overlap.observedPathEditPairs).toBeNull();expect(r.snapshots.durationMs.samples).toBeNull();expect(r.cost.perTask![0]!.peers).toBeNull();
        expect(r.flow.accepted).toBe(1);expect(JSON.stringify(report)).not.toContain("MALFORMED");
      }
      // Direct-source validation neither mutates the caller's completeness claim nor deletes its rows.
      const direct=source([valid,bad]);const i=input();i.events=direct;dogfoodScorecard(i);expect(direct.complete).toBe(true);expect(direct.data).toHaveLength(2);
    }
  } finally {f.close();}
});

test("profile event validation accepts legacy optional privacy, unattributed records and conflict without task",()=>{
  const f=fixture();try {
    const file=join(f.root,"events.jsonl"),values=[
      event(120,{type:"task",id:1,event:"proposed",state:"proposed",class:"implement",profile:"research",profileClass:"analyze"}),
      event(130,{type:"conflict",other:2,paths:[],concurrent:false}),
      event(140,{type:"tokens",peer:"codex",n:5}),
      event(150,{type:"turn_end",peer:"codex",ms:10,attribution:"unattributed"}),
      event(160,{type:"pii_screen",item:"note",label:"pii",source:"unknown",miss:"failed",category:"other",ms:0}),
    ];
    writeFileSync(file,values.map(e=>JSON.stringify(e)).join("\n")+"\n");expect(dogfoodEvents(dogfoodLines(file),100,1000)).toMatchObject({available:true,complete:true,data:values});
    const i=input();i.projectProfile=source("research");i.tasks=missing([]);i.events=source(values);expect(aggregate(i,"research").flow.proposed).toBe(1);expect(aggregate(i,"research").cost.perTask![0]!.peers).toBeNull();
  } finally {f.close();}
});

test("research fixtures cover all shipped aliases and shared metric groups plus research evidence with explicit missing-source unknowns",()=>{
  const i=input();i.projectProfile=source("research");
  const aliases:[string,string][]=[["question","plan"],["survey","summarize"],["extract","bulk_edit"],["analyze","implement"],["synthesize","summarize"],["draft","implement"],["fact_check","test"],["review","review"],["triage","triage"]];
  i.tasks=source(aliases.map(([alias,base],index)=>({...task(index+1,"research",alias),profileMetadata:{...task(index+1,"research",alias).profileMetadata,class:base}})));
  const all=dogfoodScorecard(i).profile!.rows;expect(all).toHaveLength(10);expect(all.filter(r=>r.alias!==null).map(r=>[r.alias,r.baseClass])).toEqual(aliases);
  for (const row of all) {
    expect(Object.keys(row).filter(key=>!["profile","alias","baseClass","tasks"].includes(key))).toEqual(["research","flow","review","overlap","deliverables","privacy","undo","snapshots","profileErrors","cost"]);
    expect(row.flow.approved).toBe(row.alias===null?9:1);expect(row.undo.requests).toBeNull();expect(row.deliverables.changedSinceApproval).toBeNull();expect(row.profileErrors.unknownAlias).toBeNull();
  }
  i.tasks=source(i.tasks.data,false);i.events=missing([]);
  for (const row of dogfoodScorecard(i).profile!.rows) {
    expect(row.flow.proposed).toBeNull();expect(row.flow.proposeToApproveMs.samples).toBeNull();expect(row.review.changesRequested).toBeNull();expect(row.overlap.pathNotices).toBeNull();expect(row.deliverables.recordedCount).toBeNull();expect(row.privacy.privateTasks).toBeNull();expect(row.undo.requests).toBeNull();expect(row.snapshots.durationMs.samples).toBeNull();expect(row.profileErrors.unknownAlias).toBeNull();expect(row.cost.perTask!.every(t=>t.peers===null)).toBe(true);
  }
});

test("planning and memory note screens are indistinguishable classifications and never prove memory drops",()=>{
  const i=input();i.tasks=source([task(1)]);
  // Both Tasks.planBacklog(reason) and Tasks.remember(title/text) call withholds('note', ..., task).
  // ScreenRecord carries no operation identity, so these producer-shaped records cannot support a drop claim.
  const shape={type:"pii_screen",task:1,item:"note",label:"pii",source:"screen"};
  const planning=event(150,shape),memory=event(160,shape);
  const {at:planningAt,...planningRecord}=planning,{at:memoryAt,...memoryRecord}=memory;
  expect(planningRecord).toEqual(memoryRecord);expect(planningAt).not.toBe(memoryAt);
  i.events=source([planning,memory,event(170,{...shape,source:"regex"}),event(180,{...shape,source:"inherited"}),event(190,{...shape,item:"summary"}),event(200,{...shape,label:"clear"}),event(210,{type:"pii_screen",item:"note",label:"pii",source:"unknown"})]);
  const privacy=aggregate(i).privacy;expect(privacy.observedPiiNoteScreens).toBe(4);expect(privacy.memoryNotesDropped).toBeNull();expect(privacy.refusals).toBeNull();expect(privacy).not.toHaveProperty("observedMemoryNoteScreenDrops");
});


test("research declarations use bounded current-plan counts and opaque claim slots, never task approval as a verdict",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),board=new Board(file);
    const t=board.propose("user",{title:"PRIVATE_RESEARCH_TITLE",class:"test",profile:"research",profileClass:"fact_check",signals:["pii"]});
    board.update(t.id,"user","accepted",{state:"in_progress",plan:{sources:["PRIVATE_SOURCE"],claims:["PRIVATE_CLAIM_1","PRIVATE_CLAIM_2"]}});
    board.update(t.id,"hub","check passed",{},"PRIVATE_OUTPUT supported missing keys: 0");
    board.update(t.id,"hub","check failed",{},"PRIVATE_OUTPUT unsupported");
    board.update(t.id,"user","approved",{state:"approved"});board.close();
    const i=input();i.since=0;i.until=Date.now()+1000;i.projectProfile=source("research");i.tasks=dogfoodTasks(file);
    const r=aggregate(i,"research");
    expect(i.tasks.complete).toBe(true);
    expect(r.research!.declarations).toEqual({scope:"current_plan",perTask:[{task:t.id,sources:1,claims:2}]});
    expect(r.research!.claims).toEqual({reachedPersonVerdict:null,perTask:[{task:t.id,claims:[{slot:1,modelLabel:null,personVerdict:null,agreement:null},{slot:2,modelLabel:null,personVerdict:null,agreement:null}]}]});
    expect(r.research!.observedCheckOutcomes).toEqual({scope:"task_check_history",passed:1,failed:1});
    expect(r.research!.factCheck).toEqual({scope:null,selection:null,passed:null,failed:null,missingKeysPerRun:null,agreement:[{label:"supported",count:null},{label:"unsupported",count:null},{label:"unclear",count:null}]});
    expect(dogfoodScorecard(i).profile!.rows.find(r=>r.alias==="fact_check")!.research!.factCheck.passed).toBeNull();
    expect(JSON.stringify(dogfoodScorecard(i))).not.toMatch(/PRIVATE_|missing keys/);
    expect(formatDogfood(dogfoodScorecard(i)).join("\n")).toContain('"unknown"');
  } finally {f.close();}
});

test("research legacy and event-only plan evidence stays unknown while explicit empty plans count zero",()=>{
  const i=input();i.projectProfile=source("research");i.tasks=source([task(1,"research","fact_check")]);
  expect(aggregate(i,"research").research!.declarations.perTask).toEqual([{task:1,sources:null,claims:null}]);
  expect(aggregate(i,"research").research!.claims.perTask[0]!.claims).toBeNull();
  i.tasks.data[0]!.profileMetadata!.plan={sources:0,claims:0};
  expect(aggregate(i,"research").research!.claims.perTask[0]!.claims).toEqual([]);
  i.tasks.complete=false;
  expect(aggregate(i,"research").research!.declarations.perTask[0]!.claims).toBeNull();
  expect(aggregate(i,"research").research!.factCheck.passed).toBeNull();
  expect(aggregate(i,"research").research!.observedCheckOutcomes.passed).toBeNull();
});

test("research section overlap uses the same warning and edit evidence as writing",()=>{
  const i=input();i.projectProfile=source("research");i.tasks=source([task(1,"research","fact_check"),task(2,"research","draft")]);
  i.events=source([event(130,{type:"overlap",task:1,others:[{task:2,paths:["PRIVATE_PATH"],symbols:["section PRIVATE_SECTION"]}]}),event(140,{type:"conflict",task:1,other:2,paths:["PRIVATE_PATH"]})]);
  expect(aggregate(i,"research").overlap).toEqual({pathNotices:1,sectionNotices:1,observedPathEditPairs:1,sectionEditPairs:null});
  expect(JSON.stringify(dogfoodScorecard(i))).not.toMatch(/PRIVATE_/);
});

test("reader retains legacy task history when profile JSON or history metadata is malformed",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);
    db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT,plan TEXT)");
    const insert=db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)");
    insert.run(1,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"implement","{broken","{}");
    insert.run(2,"{}","[]",JSON.stringify([null,{at:120,event:"accepted"}]),"implement",JSON.stringify({profile:"research",profileClass:"draft"}),JSON.stringify({sources:[],claims:[]}));
    insert.run(3,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"implement",JSON.stringify({profile:"research",profileClass:"draft"}),JSON.stringify({claims:Array(51).fill("PRIVATE_CLAIM")}));
    insert.run(4,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"test",JSON.stringify({profile:"research",profileClass:"fact_check"}),JSON.stringify({sources:Array(50).fill("PRIVATE_SOURCE"),claims:[]}));
    insert.run(5,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"test",JSON.stringify({profile:"research",profileClass:"fact_check"})," ".repeat(65537));
    db.close();const collected=dogfoodTasks(file);
    expect(collected.complete).toBe(false);expect(collected.data.map(t=>t.id)).toEqual([5,4,3,2,1]);
    expect(collected.data.every(t=>t.history.length===1)).toBe(true);
    expect(collected.data.find(t=>t.id===1)!.profileMetadata).toBeUndefined();
    expect(collected.data.find(t=>t.id===2)!.profileMetadata!.plan).toEqual({sources:0,claims:0});
    expect(collected.data.find(t=>t.id===3)!.profileMetadata!.plan).toBeUndefined();
    expect(collected.data.find(t=>t.id===4)!.profileMetadata!.plan).toEqual({sources:50,claims:0});
    expect(collected.data.find(t=>t.id===5)!.profileMetadata!.plan).toBeUndefined();
    expect(JSON.stringify(collected)).not.toMatch(/PRIVATE_CLAIM|PRIVATE_SOURCE|broken/);
  } finally {f.close();}
});


test("research generic draft check outcomes never imply fact_check selection or results",()=>{
  const i=input();i.projectProfile=source("research");
  const t=task(1,"research","draft");
  t.profileMetadata.history.push({at:350,event:"check passed"},{at:400,event:"check failed"});
  i.tasks=source([t]);
  const rows=dogfoodScorecard(i).profile!.rows;
  for (const r of rows) {
    expect(r.research!.observedCheckOutcomes).toEqual({scope:"task_check_history",passed:1,failed:1});
    expect(r.research!.factCheck).toMatchObject({scope:null,selection:null,passed:null,failed:null,missingKeysPerRun:null});
  }
  expect(rows.find(r=>r.alias==="draft")).toBeDefined();
  expect(rows.find(r=>r.alias==="fact_check")).toBeUndefined();
});

test("a cut or malformed plan nulls only that task's declarations and keeps dev rows known",()=>{
  const f=fixture();try {
    const devRow=(plan:string)=>{const g=fixture();try {
      const file=join(g.root,"hub.db"),db=new Database(file);
      db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT,plan TEXT)");
      db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)").run(1,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"implement",null,plan);
      db.close();return dogfoodTasks(file);
    } finally {g.close();}};
    const cut=devRow(" ".repeat(65537));
    expect(cut.complete).toBe(true);
    expect(cut.data[0]!.profileMetadata).toBeDefined();
    expect(cut.data[0]!.profileMetadata!.plan).toBeUndefined();
    const malformed=devRow("[]");
    expect(malformed.complete).toBe(true);
    expect(malformed.data[0]!.profileMetadata!.plan).toBeUndefined();
    expect(JSON.stringify(cut)).not.toMatch(/PRIVATE_/);
  } finally {f.close();}
});

test("a parsed research plan counts an undeclared key as zero and a malformed list stays task-local",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);
    db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT,class TEXT,project_profile TEXT,plan TEXT)");
    const insert=db.query("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)");
    const research=JSON.stringify({profile:"research",profileClass:"fact_check"});
    insert.run(1,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"test",research,JSON.stringify({claims:["PRIVATE_CLAIM"]}));
    insert.run(2,"{}","[]",JSON.stringify([{at:120,event:"accepted"}]),"test",research,JSON.stringify({claims:"PRIVATE_CLAIM"}));
    db.close();const collected=dogfoodTasks(file);
    expect(collected.complete).toBe(true);
    expect(collected.data.find(t=>t.id===1)!.profileMetadata!.plan).toEqual({sources:0,claims:1});
    expect(collected.data.find(t=>t.id===2)!.profileMetadata!.plan).toBeUndefined();
    expect(JSON.stringify(collected)).not.toMatch(/PRIVATE_CLAIM/);
  } finally {f.close();}
});
