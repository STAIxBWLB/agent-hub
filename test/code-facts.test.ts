import { expect,test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { parseRouting } from "../src/hub/routing.ts";
import { CodeFacts } from "../src/hub/code-facts.ts";
import { buildReviewBrief, withCodeSymbols, renderReviewBrief, type ReviewBrief } from "../src/hub/review-brief.ts";

function fixture() {
 const root=mkdtempSync(join(tmpdir(),"ahub-code-facts-test-")),repo=join(root,"repo"),bin=join(root,"bin"),record=join(root,"record");mkdirSync(repo);mkdirSync(bin);
 const git=(...args:string[])=>{const r=spawnSync("git",["-C",repo,...args],{encoding:"utf8",env:{...process.env,GIT_AUTHOR_NAME:"t",GIT_AUTHOR_EMAIL:"t@t",GIT_COMMITTER_NAME:"t",GIT_COMMITTER_EMAIL:"t@t"}});expect(r.status).toBe(0);return r.stdout.trim();};
 git("init","-qb","main");writeFileSync(join(repo,"a.ts"),"export function retained() {}\n");writeFileSync(join(repo,".gitattributes"),"a.ts filter=evil\n");git("add",".");git("commit","-qm","base");const base=git("rev-parse","HEAD");git("update-ref","refs/remotes/origin/main",base);
 git("checkout","-qb","work");writeFileSync(join(repo,"a.ts"),"export function retained() {}\nexport function added() {}\n");git("add",".");git("commit","-qm","head");const head=git("rev-parse","HEAD");git("checkout","-q","main");
 const command=join(bin,"ripwire");writeFileSync(command,`#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${join(import.meta.dir,"fakes/fake-ripwire.ts").replaceAll("'","'\\''")}' "$@"\n`);chmodSync(command,0o755);
 const env={...process.env,PATH:`${bin}:${process.env.PATH}`,FAKE_RIPWIRE_RECORD:record};
 const facts=(mode?:string,timeoutMs?:number)=>new CodeFacts({env:{...env,...(mode?{FAKE_RIPWIRE_MODE:mode}:{})},timeoutMs});
 return{root,repo,base,head,git,record,env,facts,close:()=>rmSync(root,{recursive:true,force:true})};
}

test("facts run only in a disposable exact tree, parse values and cache by SHA/query",async()=>{
 const f=fixture();try{
  const facts=f.facts(),a=await facts.changedSymbols(f.repo,f.base,f.head);expect(a.state).toBe("known");if(a.state!=="known")return;
  expect(a.value).toMatchObject([{name:"retained",kind:"fn",path:"a.ts",line:1,change:"unknown"},{name:"added"}]);
  expect(JSON.stringify(a)).not.toContain("fixture@example.test");
  const before=readFileSync(f.record,"utf8");a.value[0]!.name="poison";const cached=await facts.changedSymbols(f.repo,f.base,f.head);expect(JSON.stringify(cached)).not.toContain("poison");expect(readFileSync(f.record,"utf8")).toBe(before);
  const calls=before.trim().split("\n").map(line=>JSON.parse(line));expect(calls).toHaveLength(2);for(const call of calls){expect(call.cwd).not.toBe(f.repo);expect(existsSync(call.cwd)).toBe(false);}
  expect(f.git("worktree","list","--porcelain").match(/^worktree /gm)).toHaveLength(1);expect(f.git("rev-parse","HEAD")).toBe(f.base);
 }finally{f.close();}
},20000);

test("matching linked owners are isolated from untracked and dirty analysis inputs",async()=>{
 const f=fixture();try{
  const owner=join(f.root,"owner");f.git("worktree","add","--detach",owner,f.head);
  expect((await f.facts().changedSymbols(owner,f.base,f.head)).state).toBe("known");
  expect(readFileSync(f.record,"utf8")).not.toContain(owner);
  writeFileSync(join(owner,"untracked.ts"),"export function untracked() {}\n");
  expect(await f.facts().exists(owner,f.head,"untracked")).toEqual({state:"known",value:{exists:false,ambiguous:false}});
  writeFileSync(join(owner,"a.ts"),"dirty\n");writeFileSync(f.record,"");
  expect((await f.facts().changedSymbols(owner,f.base,f.head)).state).toBe("known");
  expect(readFileSync(f.record,"utf8")).not.toContain(owner);expect(readFileSync(join(owner,"a.ts"),"utf8")).toBe("dirty\n");
  f.git("worktree","remove","--force",owner);
 }finally{f.close();}
},20000);

test("the brief shows observed symbols and all plan lists through public metadata screening",async()=>{
 const f=fixture();try{
  const facts=await f.facts().changedSymbols(f.repo,f.base,f.head),brief=buildReviewBrief(f.repo,f.head,{privatePath:()=>false,nameable:()=>true}) as ReviewBrief;
  const out=renderReviewBrief(withCodeSymbols(brief,facts,["retained()","untouched"],s=>s!=="added"));
  expect(out).toContain("retained (fn");expect(out).toContain("change: unknown");expect(out).toContain("Changed and planned: retained");expect(out).toContain("Planned, not seen as changed: untouched");expect(out).not.toContain("added (fn");expect(out).toContain("does not report deleted symbols");
  expect(renderReviewBrief(withCodeSymbols(brief,facts,["retained","untouched"],()=>true))).toContain("Changed, not planned: added");
 }finally{f.close();}
},20000);

for(const mode of ["version","schema","truncated","error","overflow"])test(`optional ${mode} failure stays unknown and removes its worktree`,async()=>{
 const f=fixture();try{expect(await f.facts(mode).changedSymbols(f.repo,f.base,f.head)).toEqual({state:"unknown"});expect(f.git("worktree","list","--porcelain").match(/^worktree /gm)).toHaveLength(1);}finally{f.close();}
},20000);

test("missing tool and private work make no native query",async()=>{
 const f=fixture();try{
  const facts=new CodeFacts({env:{...f.env,PATH:f.root}});expect(await facts.changedSymbols(f.repo,f.base,f.head)).toEqual({state:"unknown"});
  expect(await f.facts().changedSymbols(f.repo,f.base,f.head,{private:true})).toEqual({state:"unknown"});expect(existsSync(f.record)).toBe(false);
 }finally{f.close();}
},20000);

test("a deadline stops the owned CLI and its descendant before worktree cleanup",async()=>{
 const f=fixture();try{
  const child=join(f.root,"child"),facts=new CodeFacts({env:{...f.env,FAKE_RIPWIRE_MODE:"timeout",FAKE_RIPWIRE_CHILD:child},timeoutMs:400});
  expect(await facts.changedSymbols(f.repo,f.base,f.head)).toEqual({state:"unknown"});expect(existsSync(child)).toBe(true);
  const pid=Number(readFileSync(child,"utf8"));const alive=spawnSync("ps",["-p",String(pid),"-o","stat="],{encoding:"utf8"});expect(alive.stdout.trim()===""||alive.stdout.trim().startsWith("Z")).toBe(true);
  expect(f.git("worktree","list","--porcelain").match(/^worktree /gm)).toHaveLength(1);
 }finally{f.close();}
},20000);

test("at, existence and callers/callees use their schema and distinguish missing from no callers",async()=>{
 const f=fixture();try{
  const facts=f.facts();expect(await facts.enclosing(f.repo,f.head,"a.ts",1)).toMatchObject({state:"known",value:[{name:"retained",line:1,endLine:3}]});
  expect(await facts.exists(f.repo,f.head,"retained")).toEqual({state:"known",value:{exists:true,ambiguous:false}});
  expect(await facts.exists(f.repo,f.head,"missing")).toEqual({state:"known",value:{exists:false,ambiguous:false}});
  expect(await facts.neighbours(f.repo,f.head,"retained")).toMatchObject({state:"known",value:{callers:[{name:"caller",ambiguous:false}],callees:[{name:"callee"}]}});
  expect(await f.facts("json-schema").neighbours(f.repo,f.head,"retained")).toEqual({state:"unknown"});
  expect(await f.facts("name").neighbours(f.repo,f.head,"retained")).toMatchObject({state:"known",value:{callers:[],callees:[],hiddenAmbiguous:2}});
 }finally{f.close();}
},20000);

test("raw blob materialization and native Git reads never execute repository filters",async()=>{
 const f=fixture();try{
  const sentinel=join(f.root,"filter-ran"),script=join(f.root,"filter");writeFileSync(script,`#!/bin/sh\ntouch '${sentinel}'\ncat\n`);chmodSync(script,0o755);
  f.git("config","filter.evil.clean",script);f.git("config","filter.evil.smudge",script);f.git("config","filter.evil.required","true");
  expect((await f.facts().changedSymbols(f.repo,f.base,f.head)).state).toBe("known");expect(existsSync(sentinel)).toBe(false);
 }finally{f.close();}
},20000);


test("native XML comments and graph floors do not confuse full definitions with changed symbols",async()=>{
 const f=fixture();try{expect((await f.facts("subset").changedSymbols(f.repo,f.base,f.head)).state).toBe("known");}finally{f.close();}
},20000);


test("a second distinct optional query stays unknown rather than waiting behind a busy analysis",async()=>{
 const f=fixture();try{
  const facts=f.facts("timeout",400);let settled=false;
  const first=facts.changedSymbols(f.repo,f.base,f.head).finally(()=>{settled=true;});
  expect(await facts.exists(f.repo,f.head,"retained")).toEqual({state:"unknown"});expect(settled).toBe(false);await first;
 }finally{f.close();}
},20000);

test("oversized optional symbol advice becomes unknown without changing file coverage",()=>{
 const f=fixture();try{
  const brief=buildReviewBrief(f.repo,f.head,{privatePath:()=>false,nameable:()=>true}) as ReviewBrief;
  const symbols=Array.from({length:100},(_,i)=>({name:`name${i}${"x".repeat(400)}`,kind:"fn",path:"a.ts",line:1,ambiguous:false,change:"unknown" as const}));
  const out=renderReviewBrief(withCodeSymbols(brief,{state:"known",value:symbols},[],()=>true));
  expect(out).toContain("advice exceeds 16000 bytes");expect(out).toContain("a.ts (M");expect(out).toContain("Coverage: pass hub_review");
 }finally{f.close();}
});

test("an exited CLI cannot leave its ignored-output descendant behind",async()=>{
 const f=fixture();try{
  const child=join(f.root,"orphan"),facts=new CodeFacts({env:{...f.env,FAKE_RIPWIRE_MODE:"orphan",FAKE_RIPWIRE_CHILD:child}});
  expect(await facts.changedSymbols(f.repo,f.base,f.head)).toEqual({state:"unknown"});expect(existsSync(child)).toBe(true);
  const stat=spawnSync("ps",["-p",readFileSync(child,"utf8"),"-o","stat="],{encoding:"utf8"}).stdout.trim();expect(stat===""||stat.startsWith("Z")).toBe(true);
  expect(f.git("worktree","list","--porcelain").match(/^worktree /gm)).toHaveLength(1);
 }finally{f.close();}
},20000);

test("closing the reader cancels and awaits its active analysis and tree cleanup",async()=>{
 const f=fixture();try{
  const child=join(f.root,"active"),facts=new CodeFacts({env:{...f.env,FAKE_RIPWIRE_MODE:"timeout",FAKE_RIPWIRE_CHILD:child}});
  const pending=facts.changedSymbols(f.repo,f.base,f.head);
  for(let i=0;i<200&&!existsSync(child);i++)await Bun.sleep(10);expect(existsSync(child)).toBe(true);
  await facts.close();expect(await pending).toEqual({state:"unknown"});
  const stat=spawnSync("ps",["-p",readFileSync(child,"utf8"),"-o","stat="],{encoding:"utf8"}).stdout.trim();expect(stat===""||stat.startsWith("Z")).toBe(true);
  expect(f.git("worktree","list","--porcelain").match(/^worktree /gm)).toHaveLength(1);
  const before=readFileSync(f.record,"utf8");expect(await facts.exists(f.repo,f.head,"retained")).toEqual({state:"unknown"});expect(readFileSync(f.record,"utf8")).toBe(before);
 }finally{f.close();}
},20000);


test("a failing optional metadata projection preserves the authoritative file brief",()=>{
 const f=fixture();try{
  const brief=buildReviewBrief(f.repo,f.head,{privatePath:()=>false,nameable:()=>true}) as ReviewBrief;
  const projected=withCodeSymbols(brief,{state:"known",value:[{name:"retained",kind:"fn",path:"a.ts",line:1,ambiguous:false,change:"unknown"}]},[],()=>{throw Error("metadata unavailable");});
  expect(projected.reviewable).toEqual(brief.reviewable);expect(projected.rules).toEqual(brief.rules);expect(renderReviewBrief(projected)).toContain("Changed symbols: unknown");
 }finally{f.close();}
});


test("off-mode completion-selected reviewer receives prepared fake-ripwire symbols", async () => {
 const f=fixture(),facts=f.facts(),board=new Board(join(f.root,"hub.db")),bus=new Bus({batchMs:0});
 const received:string[]=[];
 class Peer extends BasePeer {
  async start(){this.setState("idle");}
  async stop(){this.setState("offline");}
  async deliver(envs:{body:string}[]){received.push(...envs.map(env=>env.body));}
 }
 let symbols:Awaited<ReturnType<CodeFacts["changedSymbols"]>>={state:"unknown"};
 try {
  for(const id of ["codex","claude-review"]){const peer=new Peer(id,60000);bus.add(peer);await peer.start();}
  const tasks=new Tasks({board,bus,cwd:f.repo,project:"fixture",notify:()=>{},
   instances:()=>({"claude-review":{kind:"claude",roles:["reviewer"],start_mode:"headless"}}),roles:{"claude-review":["reviewer"]},
   review:{adaptive:false,min_reviews:5,pool:["claude"]},reviewOnly:()=>true,
   routing:()=>parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude", "codex"]\n'),
   prepareReviewBrief:async task=>{symbols=await facts.changedSymbols(f.repo,f.base,task.refs.commit!);},
   reviewBrief:task=>{const brief=buildReviewBrief(f.repo,task.refs.commit,{privatePath:()=>false,nameable:()=>true});return "unavailable" in brief?brief:withCodeSymbols(brief,symbols,task.plan?.symbols,()=>true);}});
  const task=board.propose("user",{title:"fixture",class:"summarize",refs:{commit:f.head}});
  board.update(task.id,"codex","accepted",{owner:"codex",state:"in_progress"});
  expect(board.get(task.id)!.reviewer).toBeNull();
  const done=await tasks.done("codex",task.id,"done");
  expect(done).toMatchObject({state:"in_review",reviewer:"claude-review"});
  for(let i=0;i<100&&!received.some(body=>body.startsWith("Review task"));i++)await Bun.sleep(10);
  const request=received.find(body=>body.startsWith("Review task"));
  expect(request).toContain("retained (fn");expect(request).toContain("added (fn");expect(symbols.state).toBe("known");
 } finally {await facts.close();bus.closeJournal();board.close();f.close();}
},20000);
