import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { classifyPeerCommand } from "../src/cli/identity.ts";
import { dogfoodScorecard, dogfoodSince, formatDogfood, source, missing, type DogfoodInput } from "../src/hub/dogfood.ts";
import { dogfoodLines, dogfoodEvents, dogfoodTasks, dogfoodPrs, dogfoodFeatures, dogfoodJournal, readDogfood } from "../src/hub/dogfood-read.ts";
import type { StampedEvent } from "../src/hub/events.ts";
import type { SdlcGh } from "../src/hub/sdlc.ts";

const input = (): DogfoodInput => ({since:0,until:10000,events:source([]),tasks:source([]),prs:source([]),log:source([]),features:source([])});
const event = (value: object) => ({v:1,at:new Date(5000).toISOString(),...value}) as StampedEvent;
function fixture() { const root=mkdtempSync(join(tmpdir(),"ahub-dogfood-")); return {root,close:()=>rmSync(root,{recursive:true,force:true})}; }

test("dogfood joins board and merged PR evidence, deduplicates findings, and reuses costMetrics",()=>{
  const i=input();
  i.tasks=source([{id:7,pii:false,repo:"O/R",pr:12,history:[
    {at:10,by:"hub",event:"proposed"},{at:20,by:"hub",event:"done",reviewCost:{review:{scope:"full",reviewers:1}}},
    {at:30,by:"hub",event:"changes_requested",reviewFindings:{items:[{id:"same",pass:"bugs",severity:"important",disposition:"open"}]}},
    {at:40,by:"hub",event:"escalated"},{at:50,by:"hub",event:"done",reviewCost:{review:{scope:"delta",reviewers:1}}},
    {at:60,by:"hub",event:"approved",reviewFindings:{items:[{id:"same",pass:"bugs",severity:"important",disposition:"fixed"}]}},
  ]}]);
  i.prs=source([{repo:"o/r",pr:12,state:"MERGED",mergedAt:70,complete:true,ciRuns:[{id:1,attempt:2}],reviews:2,firstPassCi:false,sameHeadReruns:1,connectorThreads:[59,61],bugIssues:[{id:9,at:71},{id:10,at:70+15*86400000}]}]);
  const r=dogfoodScorecard(i).flow.prs[0]!;
  expect(r).toMatchObject({tasks:[7],proposeToApproveMs:50,doneToMergeMs:20,reviewRounds:2,firstPassApproval:0,escalations:1,importantFindings:1,connectorThreadsAfterApproval:1,bugIssuesWithin14d:1,firstPassCi:0,ciRuns:1,ciReruns:1,sameHeadReruns:1});
});

test("dogfood never emits titles, notes, bodies, providers or models; PII counts never become PR readbacks",()=>{
  const i=input();
  i.tasks=source([{id:9,repo:"o/r",pr:88,pii:true,history:[{at:1,by:"hub",event:"proposed",note:"PRIVATE_NOTE"}]}]);
  i.events=source([event({type:"task",id:9,event:"approved",by:"hub",state:"approved",owner:"codex",reviewer:"claude",class:"implement",pii:true,title:"PRIVATE_TITLE"}),event({type:"usage",peer:"codex",task:9,pii:true,attribution:"delivery",source:"omniroute",id:"u",inputTokens:10,cacheReadTokens:4,provider:"PRIVATE_PROVIDER",requestedModel:"PRIVATE_MODEL"})]);
  i.prs=source([{repo:"o/r",pr:88,state:"MERGED",mergedAt:9,complete:true}]);
  i.log=source(["PRIVATE_LOG"]);
  const r=dogfoodScorecard(i), text=JSON.stringify(r);
  expect(text).not.toMatch(/PRIVATE_|"pr":88/);
  expect(r.piiTasks).toBe(1);
  expect(r.cost.perTask[0]).toMatchObject({task:9,pii:1,peers:{codex:{input:10,cacheRead:4,output:null}}});
});

test("dogfood treats missing and truncated sources as unknown, keeps unsupported telemetry unknown",()=>{
  const i=input();i.events=missing([]);i.tasks=missing([]);i.log=missing([]);
  const r=dogfoodScorecard(i);
  expect(r.delivery.overflow.value).toBeNull();expect(r.piiTasks).toBeNull();
  expect(r.performance.controlRequestMs.p95).toBeNull();expect(r.performance.cpu.p50).toBeNull();
  expect(r.quality.realBlockers).toBeNull();expect(formatDogfood(r).join("\n")).toContain('"unknown"');
  i.events=source([],false);expect(dogfoodScorecard(i).delivery.overflow.value).toBeNull();
  i.events=source([]);expect(dogfoodScorecard(i).delivery.overflow.value).toBe(0);
});

test("dogfood costs use report attribution and cache coverage; duplicate usage is not counted twice",()=>{
  const i=input();i.tasks=source([{id:2,repo:"o/r",pr:4,pii:false,history:[]}]);i.prs=source([{repo:"o/r",pr:4,state:"MERGED",mergedAt:9000,complete:false}]);
  const u=event({type:"usage",peer:"codex",task:2,attribution:"delivery",source:"omniroute",id:"usage",inputTokens:10,outputTokens:5,cacheReadTokens:3,totalTokens:15});
  i.events=source([event({type:"tokens",peer:"codex",task:2,attribution:"delivery",n:15}),u,u,event({type:"tokens",peer:"codex",attribution:"unattributed",n:6})]);
  const r=dogfoodScorecard(i);
  expect(r.cost.perTask[0]!.peers.codex).toMatchObject({tokens:15,cacheRead:3,records:1});
  expect(r.cost.perPr[0]!.peers?.codex).toMatchObject({tokens:15,cacheRead:3});
  expect(r.cost.unattributed.codex?.tokens).toBe(6);
});

test("dogfood counts fixed log classes only and adoption observes event presence separately from activation",()=>{
  const i=input();i.events=source([event({type:"overflow",id:"x",from:"codex",peer:"claude"})]);
  i.features=source([{id:1,types:["overflow"]},{id:2,types:null}]);
  i.log=source(["codex is polling an empty inbox with no task (3 empty reads in 0 min)","snapshot unavailable: shared snapshot Git budget exhausted", "control status database contention: secret"]);
  const r=dogfoodScorecard(i);
  expect(r.delivery.emptyInboxPollingStreaks.value).toBe(1);expect(r.performance.snapshotBudgetNotices.value).toBe(1);
  expect(r.performance.errors.database.value).toBe(1);expect(r.adoption).toEqual([{id:1,events:1},{id:2,events:null}]);
  expect(JSON.stringify(r)).not.toContain("secret");
});

test("bounded line and event reads detect partial, malformed, absent and capped sources",()=>{
  const f=fixture();try {
    const file=join(f.root,"events");writeFileSync(file,JSON.stringify(event({type:"overflow",id:"a",from:"x",peer:"y"}))+"\n");
    expect(dogfoodEvents(dogfoodLines(file),0,10000).data).toHaveLength(1);
    writeFileSync(file,"bad\n");expect(dogfoodEvents(dogfoodLines(file),0,10000).complete).toBe(false);
    writeFileSync(file,"one\ntwo\nthree\n");expect(dogfoodLines(file,8)).toMatchObject({complete:false,data:["three"]});
    writeFileSync(file,"one\ncut");expect(dogfoodLines(file).complete).toBe(false);
    expect(dogfoodLines(join(f.root,"missing")).available).toBe(false);
  } finally {f.close();}
});

test("read-only board collector keeps history metadata and never creates a missing database",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db");expect(dogfoodTasks(file).available).toBe(false);
    const db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT)");
    db.query("INSERT INTO tasks VALUES(?,?,?,?)").run(1,'{"repo":"o/r","pr":5}','["pii"]','[{"at":1,"by":"codex","event":"proposed","note":"SECRET"}]');db.close();
    const r=dogfoodTasks(file);expect(r.complete).toBe(true);expect(r.data[0]).toMatchObject({id:1,pii:true,pr:5});expect(JSON.stringify(r)).not.toContain("SECRET");
  } finally {f.close();}
});

test("GitHub collection is bounded, skips known PII PRs, and does not request bodies",async()=>{
  const calls:string[][]=[];
  const gh:SdlcGh=async(args,_t,_c,cap)=>{calls.push(args);expect(cap).toBeLessThanOrEqual(128*1024);
    if(args[0]==="pr")return{code:0,stdout:JSON.stringify([{number:1,mergedAt:new Date(5000).toISOString()},{number:2,mergedAt:new Date(5000).toISOString()}])};
    if(args[1]?.includes("actions/workflows"))return{code:0,stdout:'{"total_count":0,"workflow_runs":[]}'};
    return{code:1,stdout:""};
  };
  const r=await dogfoodPrs("o/r",source([{id:1,pii:true,repo:"o/r",pr:1,history:[]}]),0,10000,gh);
  expect(r.data.map(x=>x.pr)).toEqual([2]);expect(calls.flat().join(" ")).not.toMatch(/\bbody\b|number=1\b/);
  calls.length=0;expect((await dogfoodPrs("o/r",missing([]),0,10000,gh)).available).toBe(false);expect(calls).toHaveLength(0);
});

test("dogfood feature rows have ids for every documented row, without exporting prose",()=>{
  const f=dogfoodFeatures(join(import.meta.dir,"../docs/dogfood.md"));expect(f.available).toBe(true);expect(f.data.length).toBeGreaterThan(30);expect(JSON.stringify(f)).not.toContain("Message bus");
});

test("readDogfood handles wholly missing sources with an injected read-only GitHub port",async()=>{
  const f=fixture();try {const r=await readDogfood(f.root,f.root,0,10000,async()=>({code:1,stdout:""}));expect(r.sources.events!.available).toBe(false);expect(r.flow.prs).toEqual([]);expect(r.piiTasks).toBeNull();}finally{f.close();}
});

test("help advertises dogfood and report retains the read-only agent authority",()=>{
  expect(classifyPeerCommand("report",["--dogfood","--since","7d","--json"])).toBe("allowed");
  expect(readFileSync(join(import.meta.dir,"../src/cli/help.ts"),"utf8")).toContain("ahub report --dogfood [--since 7d|<iso>] [--json]");
  expect(readFileSync(join(import.meta.dir,"../src/cli/main.ts"),"utf8")).toContain('readDogfood(cwd, stateDir, from)');
});

test("dogfood CI metadata stays useful without a board link; a rerun does not invent first-pass success",()=>{
  const i=input();i.prs=source([{repo:"o/r",pr:3,state:"MERGED",mergedAt:9000,complete:true,ciRuns:[{id:9,attempt:2}],reviews:0,sameHeadReruns:1}]);
  const r=dogfoodScorecard(i).flow.prs[0]!;expect(r.tasks).toEqual([]);expect(r.firstPassApproval).toBeNull();expect(r.firstPassCi).toBeNull();expect(r.ciReruns).toBe(1);
});

test("GitHub complete metadata computes first CI result, same-head reruns and explicit bug references",async()=>{
  const at=(n:number)=>new Date(n).toISOString(), sha="a".repeat(40);
  const gh:SdlcGh=async(args)=>{
    if(args[0]==="pr")return{code:0,stdout:JSON.stringify([{number:2,createdAt:at(0),mergedAt:at(8000)}])};
    if(args[1]?.includes("actions/workflows"))return{code:0,stdout:JSON.stringify({total_count:2,workflow_runs:[{id:1,run_attempt:1,head_sha:sha,pull_requests:[{number:2}],created_at:at(1000),conclusion:"failure"},{id:2,run_attempt:2,head_sha:sha,pull_requests:[{number:2}],created_at:at(2000),conclusion:"success"}]})};
    const page=(nodes:unknown[])=>({nodes,pageInfo:{hasNextPage:false}});
    return{code:0,stdout:JSON.stringify({data:{repository:{pullRequest:{number:2,state:"MERGED",headRefOid:sha,mergedAt:at(8000),commits:page([{commit:{oid:sha}}]),reviews:page([]),reviewThreads:page([{comments:{nodes:[{createdAt:at(7000),author:{login:"chatgpt-codex-connector"}}]}}]),timelineItems:page([{source:{number:8,createdAt:at(9000),labels:page([{name:"bug"}])}}])}}}})};
  };
  const r=await dogfoodPrs("o/r",source([]),0,10000,gh);expect(r.data[0]).toMatchObject({firstPassCi:false,sameHeadReruns:1,connectorThreads:[7000],bugIssues:[{id:8,at:9000}]});
});

test("a PR with several tasks is approved only after its last linked member",()=>{
  const i=input();i.tasks=source([30,80].map((approval,index)=>({id:index+1,repo:"o/r",pr:3,pii:false,history:[{at:10+index,by:"hub",event:"proposed"},{at:approval-1,by:"hub",event:"done"},{at:approval,by:"hub",event:"approved"}]})));
  i.prs=source([{repo:"o/r",pr:3,state:"MERGED",mergedAt:90,complete:true,connectorThreads:[50,81]}]);
  expect(dogfoodScorecard(i).flow.prs[0]).toMatchObject({proposeToApproveMs:70,doneToMergeMs:11,connectorThreadsAfterApproval:1,firstPassApproval:1});
});

test("pii_path board tasks stay private before any GitHub detail read",async()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT)");
    db.query("INSERT INTO tasks VALUES(?,?,?,?)").run(1,'{"repo":"o/r","pr":5}','["pii_path"]','[]');db.close();
    const tasks=dogfoodTasks(file);expect(tasks.data[0]?.pii).toBe(true);
    let details=0;const gh:SdlcGh=async(args)=>{
      if(args[0]==="pr")return{code:0,stdout:JSON.stringify([{number:5,mergedAt:new Date(5000).toISOString()}])};
      if(args[1]?.includes("actions/workflows"))return{code:0,stdout:'{"total_count":0,"workflow_runs":[]}'};
      details++;return{code:1,stdout:""};
    };
    const prs=await dogfoodPrs("o/r",tasks,0,10000,gh);expect(prs.data).toEqual([]);expect(details).toBe(0);
  }finally{f.close();}
});

test("an intact event file does not certify missing usage or unattributed cost",()=>{
  const i=input();i.events=source([event({type:"tokens",peer:"codex",n:10,attribution:"unattributed"})]);
  const r=dogfoodScorecard(i);expect(r.cost.eventSourceComplete).toBe(true);expect(r.cost.usageComplete).toBe(false);expect(r.cost.attributionComplete).toBe(false);
});


test("journal digest and held counts are explicitly retained evidence with no body readback",()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE deliveries(state TEXT,out_json TEXT,created_at INTEGER)");
    db.query("INSERT INTO deliveries VALUES(?,?,?)").run("needs_review",JSON.stringify([{from:"digest",body:"SECRET_BODY"}]),100);db.close();
    const journal=dogfoodJournal(file,0,10000);expect(journal).toMatchObject({complete:true,data:{digests:1,held:1,rows:1}});
    const i=input();i.journal=journal;const r=dogfoodScorecard(i);expect(r.delivery.digests).toEqual({value:1,scope:"retained_journal"});expect(JSON.stringify(r)).not.toContain("SECRET_BODY");
  }finally{f.close();}
});


test("dogfood parser defaults to seven days and refuses conflicting report flags",()=>{
  expect(dogfoodSince(["--dogfood","--json"],7*86400000)).toBe(0);
  expect(dogfoodSince(["--dogfood","--since","1d"],2*86400000)).toBe(86400000);
  for(const args of [["--dogfood","--since"],["--dogfood","--by","task"],["--dogfood","--since","1d","--since","2d"],["--dogfood","--dogfood"]]) expect(()=>dogfoodSince(args)).toThrow("usage:");
});


test("S9 matches the real plan-entry notice without an advice token",()=>{
  const i=input();i.log=source(["2026-10-22T00:00:00.000Z task #12: plan not reviewed since proposal"]);
  expect(dogfoodScorecard(i).quality.adviseBlockers.S9?.value).toBe(1);
});

test("oversized private receipts make privacy inventory incomplete before GitHub reads",async()=>{
  const f=fixture();try {
    const file=join(f.root,"hub.db"),db=new Database(file);db.run("CREATE TABLE tasks(id INTEGER,sdlc TEXT,signals TEXT,history TEXT)");
    db.query("INSERT INTO tasks VALUES(?,?,?,?)").run(1,JSON.stringify({repo:"o/r",pr:5,padding:"x".repeat(65536)}),'["pii"]','[]');db.close();
    const tasks=dogfoodTasks(file);expect(tasks.complete).toBe(false);
    let calls=0;const r=await dogfoodPrs("o/r",tasks,0,10000,async()=>{calls++;return{code:1,stdout:""};});
    expect(r.available).toBe(false);expect(calls).toBe(0);
  }finally{f.close();}
});

test("CI reads a complete reporting window despite more than 100 lifetime workflow runs",async()=>{
  const since=1000,until=10000,at=(n:number)=>new Date(n).toISOString(),sha="b".repeat(40);
  const endpoints:string[]=[];
  let truncated=false,created=1500;
  const gh:SdlcGh=async(args)=>{
    if(args[0]==="pr")return{code:0,stdout:JSON.stringify([{number:3,createdAt:at(created),mergedAt:at(9000)}])};
    if(args[1]?.includes("actions/workflows")) {
      const endpoint=args[1];endpoints.push(endpoint);
      const scoped=endpoint.includes(`created=${at(since)}..${at(until)}`);
      return{code:0,stdout:JSON.stringify({total_count:scoped&&!truncated?1:1001,workflow_runs:[{id:11,run_attempt:1,head_sha:sha,pull_requests:[{number:3}],created_at:at(2000),conclusion:"success"}]})};
    }
    const page=(nodes:unknown[])=>({nodes,pageInfo:{hasNextPage:false}});
    return{code:0,stdout:JSON.stringify({data:{repository:{pullRequest:{number:3,state:"MERGED",headRefOid:sha,mergedAt:at(9000),commits:page([{commit:{oid:sha}}]),reviews:page([]),reviewThreads:page([]),timelineItems:page([])}}}})};
  };
  const prs=await dogfoodPrs("o/r",source([]),since,until,gh);
  expect(prs.data[0]).toMatchObject({complete:true,firstPassCi:true,sameHeadReruns:0,ciRuns:[{id:11,attempt:1}]});
  const i=input();i.since=since;i.until=until;i.prs=prs;
  expect(dogfoodScorecard(i).flow.prs[0]).toMatchObject({firstPassCi:1,ciRuns:1,ciReruns:0,sameHeadReruns:0});
  expect(endpoints).toHaveLength(1);expect(endpoints[0]).toContain("per_page=100");
  truncated=true;i.prs=await dogfoodPrs("o/r",source([]),since,until,gh);
  expect(dogfoodScorecard(i).flow.prs[0]).toMatchObject({firstPassCi:null,ciRuns:null,ciReruns:null,sameHeadReruns:null});
  truncated=false;created=500;
  expect((await dogfoodPrs("o/r",source([]),since,until,gh)).data[0]?.firstPassCi).toBeUndefined();
});

test("malformed log timestamps make counts unknown while out-of-window timestamps stay complete",async()=>{
  const f=fixture();try {
    const gh:SdlcGh=async()=>({code:1,stdout:""});
    writeFileSync(join(f.root,"hub.log"),"legacy undated evidence\n1970-01-01T00:00:20.000Z valid outside window\n");
    const r=await readDogfood(f.root,f.root,1000,10000,gh);
    expect(r.sources.log!.available).toBe(true);expect(r.sources.log!.complete).toBe(false);
    expect(r.delivery.emptyInboxPollingStreaks.value).toBeNull();expect(r.quality.adviseBlockers.S9?.value).toBeNull();
    writeFileSync(join(f.root,"hub.log"),"1970-01-01T00:00:20.000Z valid outside window\n");
    const clean=await readDogfood(f.root,f.root,1000,10000,gh);
    expect(clean.sources.log!.complete).toBe(true);expect(clean.delivery.emptyInboxPollingStreaks.value).toBe(0);
  }finally{f.close();}
});
