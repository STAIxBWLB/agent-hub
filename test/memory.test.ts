import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, CandidateStore, CaptureStore } from "@staix/agent-mem";
import { MemoryClient } from "../src/memory/client.ts";
import { Capture } from "../src/memory/capture.ts";
import { Briefs, related } from "../src/memory/brief.ts";
import { recallFor } from "../src/memory/recall.ts";
import { ask, gather } from "../src/hub/ask.ts";
import { Board } from "../src/hub/board.ts";
const clean: (() => void)[] = [];
afterEach(() => { for (const f of clean.splice(0).reverse()) f(); });
function rig() {
 const home = mkdtempSync(join(tmpdir(), "ahub-amem-runtime-")); clean.push(() => rmSync(home,{recursive:true,force:true}));
 const store = new MemoryStore({home}), candidates = new CandidateStore({home}); clean.push(()=>store.close(),()=>candidates.close());
 let valid = true; const logs: string[]=[];
 const client = new MemoryClient({ project:"project-a",store,candidates,check(){if(!valid) throw Error("changed");},screen:rows=>rows.filter(v=>!`${v.title} ${v.text}`.includes("private-value")),publicText:t=>!t.includes("private-value"),capture:()=>({home}),log:l=>logs.push(l) });
 const note = (text:string,project="project-a") => store.note({op:"note",project,scope:"project",tier:"short",kind:"decision",text,about:[],peer:"kimi",source:"person"});
 return {home,store,candidates,client,note,logs,revoke(){valid=false;}};
}
test("published amem recall, briefs, ask and candidates operate without any worker request", async()=>{
 const r=rig(); let calls=0; const worker=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){calls++;return new Response("unexpected");}});clean.push(()=>worker.stop(true));
 const previous=globalThis.fetch; globalThis.fetch=((..._args:unknown[])=>{calls++;throw Error("network tripwire");}) as unknown as typeof fetch; clean.push(()=>{globalThis.fetch=previous;});
 const id=r.note("switchyard policy is curated"); r.note("private-value switchyard");r.note("foreign switchyard","project-b");
 expect(await r.client.health()).toEqual({ok:true,version:"0.6.0"});
 const recall=await recallFor("kimi",r.client,["ignored-legacy-name"],1000);expect(recall).toContain(id);expect(recall).not.toContain("private-value");
 const rows=await related(r.client,"project-b","switchyard");expect(rows.map(v=>v.id)).toEqual([`mem:${id}`]);
 const brief=await new Briefs(r.client,"project-b").forTask("codex",{id:1,title:"switchyard",refs:{}});expect(brief).toContain(`mem:${id}`);
 const board=new Board(join(r.home,"hub.db")); clean.push(()=>board.close());
 const evidence=await gather("switchyard",{board,isPii:()=>false,onCampus:async()=>false,memory:r.client,project:"project-b",logFile:join(r.home,"absent")});expect(evidence.evidence.some(v=>v.id===`mem:${id}`)).toBe(true);
 const answer=await ask("switchyard",{board,isPii:()=>false,onCampus:async()=>false,memory:r.client,project:"project-b",logFile:join(r.home,"absent"),inference:{complete:async()=>`The policy is curated [mem:${id}].`} as never});expect(answer.found).toBe(true);
 const saved=await r.client.save({project:"project-b",title:"ahub ask (model answer): switchyard",text:"switchyard fabricated answer",metadata:{peer:"hub"}});expect(saved).toMatchObject({status:"candidate"});expect(r.candidates.list({project:"project-a"})).toHaveLength(1);expect(JSON.stringify(r.candidates.list({project:"project-a"}))).toContain("Submitted metadata");expect(await r.client.search("fabricated","project-a")).not.toContain("fabricated");expect(calls).toBe(0);
});
test("capture is deterministic, screened before bounding, exactly once and excluded from curated evidence",async()=>{
 setSystemTime(new Date());clean.push(()=>setSystemTime());
 const r=rig(), capture=new Capture(r.client,{project:"spoof-project",cwd:r.home,deny:["private/"]}); capture.init("session-a","initial capture");
 const call={tool:"read",args:'{"path":"source.ts"}',output:"capture-only switchyard",id:"tool-a",paths:["source.ts"]};capture.observe(call);capture.observe(call);
 capture.observe({...call,id:"secret-tail",output:"public ".repeat(1000)+"private-value"});capture.observe({...call,id:"private-path",paths:["private/secret.ts"]});capture.observe({...call,id:"self-read",tool:"hub_memory_show"});capture.summarize("deterministic stop excerpt");capture.summarize("deterministic stop excerpt");await capture.end();
 const store=new CaptureStore({home:r.home,project:"project-a"});clean.push(()=>store.close());const rows=store.rows({limit:100});expect(rows.filter(v=>v.event==="PostToolUse")).toHaveLength(1);expect(rows.filter(v=>v.event==="Stop")).toHaveLength(2);expect(rows.some(v=>v.excerpt.includes("capture-only switchyard"))).toBe(true);expect(rows.every(v=>v.project==="project-a")).toBe(true);expect(JSON.stringify(rows)).not.toContain("private-value");expect(await related(r.client,"project-a","capture-only")).toEqual([]);
});
test("an unavailable or changed profile fails open without leaking content or writing a candidate/capture",async()=>{
 const r=rig();r.note("known note");r.revoke();expect(await r.client.search("known","project-a")).toBeUndefined();expect(await r.client.save({project:"project-a",text:"private-value",metadata:{}})).toBeUndefined();expect(await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",excerpt:"private-value"})).toBeUndefined();expect(await r.client.health()).toEqual({ok:false});expect(r.candidates.list({project:"project-a"})).toHaveLength(0);expect(r.logs.every(v=>v==="amem operation unavailable")).toBe(true);expect(await new MemoryClient().health()).toEqual({ok:false});
});


test("capture replays one host invocation once but keeps identical provider ids from different invocations at the same clock", async () => {
  setSystemTime(new Date()); clean.push(() => setSystemTime());
  const r = rig(), capture = new Capture(r.client, { project: "project-a", cwd: r.home });
  capture.init("same-session", "start");
  const call = { tool: "read", args: '{"path":"source.ts"}', output: "unchanged public file", id: "call_0", paths: ["source.ts"] };
  for (const sourceId of ["turn1.step0.0", "turn1.step0.0", "turn1.step1.1", "turn2.step0.0"]) capture.observe({ ...call, sourceId });
  await capture.end();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  expect(stored.rows().filter(v => v.event === "PostToolUse")).toHaveLength(3);
});
