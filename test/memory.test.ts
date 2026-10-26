import { withoutPii } from "../src/hub/memory-policy.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { afterEach, expect, test, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, CandidateStore, CaptureStore, writeCaptureConfigFile } from "@staix/agent-mem";
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
 clean.push(() => client.close());
 const note = (text:string,project="project-a") => store.note({op:"note",project,scope:"project",tier:"short",kind:"decision",text,about:[],peer:"kimi",source:"person"});
 return {home,store,candidates,client,note,logs,revoke(){valid=false;}};
}
test("published amem recall, briefs, ask and candidates operate without any worker request", async()=>{
 const r=rig(); let calls=0; const worker=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){calls++;return new Response("unexpected");}});clean.push(()=>worker.stop(true));
 const previous=globalThis.fetch; globalThis.fetch=((..._args:unknown[])=>{calls++;throw Error("network tripwire");}) as unknown as typeof fetch; clean.push(()=>{globalThis.fetch=previous;});
 const id=r.note("switchyard policy is curated"); r.note("private-value switchyard");r.note("foreign switchyard","project-b");
 expect(await r.client.health()).toEqual({ok:true,version:"0.9.1"});
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

function actualTextPolicyRig() {
  const r = rig(), hidden = "private\nfolder", baseRouting = loadRouting(r.home);
  const routing = { ...baseRouting, signals: { ...baseRouting.signals, pii_patterns: ["private\\s+folder"] } };
  const permitted = (text: string) => withoutPii([{ title: "", text }], routing, r.home, []).length === 1;
  const client = new MemoryClient({ project: "project-a", store: r.store, candidates: r.candidates, check() {},
    screen: rows => withoutPii(rows, routing, r.home, []), publicText: permitted, capture: () => ({ home: r.home }) });
  // Positive/negative controls exercise the actual valid routing-pattern policy, not a test-only substring screen.
  expect(permitted(`${hidden}/record.txt`)).toBe(false);
  expect(permitted("public/record.txt")).toBe(true);
  return { ...r, client, hidden };
}

test("actual whitespace PII policy screens a raw capture path before JSON encoding and still accepts public capture", async () => {
  const r = actualTextPolicyRig();
  expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", tool: "read", paths: ["public/record.txt"], excerpt: "public capture control" })).toHaveProperty("id");
  expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", tool: "read", paths: [`${r.hidden}/record.txt`], excerpt: "apparently public excerpt" })).toBeUndefined();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  const rows = stored.rows(); expect(rows).toHaveLength(1);
  expect(rows[0]!.paths).toEqual(["public/record.txt"]); expect(rows[0]!.excerpt).toBe("public capture control");
  expect(JSON.stringify(rows)).not.toContain("private\\nfolder");
});

for (const field of ["nested string", "property key"] as const) test(`actual whitespace PII policy decodes authoritative tool-input JSON ${field} before capture`, async () => {
  const r = actualTextPolicyRig();
  const input = field === "nested string" ? JSON.stringify({ payload: { target: `${r.hidden}/record.txt` } })
    : JSON.stringify({ [`${r.hidden}/record.txt`]: { opaque: "public-looking value" } });
  // The path exists only inside escaped JSON, not the raw excerpt or paths array.
  expect(input).not.toContain(r.hidden); expect(JSON.parse(input)).toBeDefined();
  expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", input: '{"payload":{"target":"public/record.txt"}}', excerpt: "public input control" })).toHaveProperty("id");
  expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", input, paths: [], excerpt: "public-looking result" })).toBeUndefined();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  expect(stored.rows().map(row => row.excerpt)).toEqual(["public input control"]);
});

test("actual whitespace PII policy screens the raw candidate title before encoding but keeps a public candidate", async () => {
  const r = actualTextPolicyRig();
  expect(await r.client.save({ project: "project-a", title: "public candidate", text: "public candidate control", metadata: { peer: "codex" } })).toMatchObject({ status: "candidate" });
  expect(await r.client.save({ project: "project-a", title: `${r.hidden}/record.txt`, text: "apparently public candidate", metadata: { peer: "codex" } })).toBeUndefined();
  const rows = r.candidates.list({ project: "project-a" }); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ input: { kind: "memory", title: "public candidate" } }); expect(JSON.stringify(rows)).not.toContain("private\\nfolder");
});

test("actual whitespace PII policy sees complete original JSON tool output beyond 4000 chars before storage bounding", async () => {
  const r = actualTextPolicyRig(), capture = new Capture(r.client, { project: "project-a", cwd: r.home });
  capture.init("raw-json-output-session", "public capture start");
  const output = (path: string) => JSON.stringify({ padding: "public ".repeat(700), payload: { target: path } });
  const privateOutput = output(`${r.hidden}/record.txt`), publicOutput = output("public/record.txt");
  expect(privateOutput.length).toBeGreaterThan(4000);
  expect(privateOutput.indexOf("private")).toBeGreaterThan(4000);
  expect(privateOutput).not.toContain(r.hidden); expect(JSON.parse(privateOutput).payload.target).toBe(`${r.hidden}/record.txt`);
  expect(() => JSON.parse(privateOutput.slice(0, 4000))).toThrow(); // A pre-policy slice destroys the only authoritative JSON view.
  const base = { tool: "read", args: '{"path":"public.txt"}', paths: ["public.txt"] };
  capture.observe({ ...base, output: publicOutput, id: "public-large", sourceId: "public-large-source" });
  capture.observe({ ...base, output: privateOutput, id: "private-large", sourceId: "private-large-source" });
  await capture.end();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  const tools = stored.rows().filter(row => row.event === "PostToolUse");
  expect(tools).toHaveLength(1); // Public output larger than 4000 remains capturable; private tail rejects the entire other event.
  expect(tools[0]!.excerpt).toContain("public.txt"); expect(tools[0]!.excerpt).toContain("padding");
  expect(stored.rows().map(row => row.event)).toEqual(expect.arrayContaining(["SessionStart", "PostToolUse", "SessionEnd"]));
  expect(JSON.stringify(stored.rows())).not.toContain("private\\nfolder");
});


test("capture checks complete custom deny paths with spaces before splitting tokens", async () => {
  const r = rig(), capture = new Capture(r.client, { project: "project-a", cwd: r.home, deny: ["private folder/"] });
  capture.init("deny-space-session", "start");
  capture.observe({ tool: "read", args: "{}", output: "public control", id: "public", paths: ["public/file.txt"] });
  capture.observe({ tool: "read", args: "{}", output: "hidden file metadata", id: "hidden", paths: ["private folder/record.txt"] });
  await capture.end();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  expect(stored.rows().filter(v => v.event === "PostToolUse")).toHaveLength(1);
});


test("capture ignores non-persisted host cwd when screening a valid private-path policy", async () => {
  const r = rig(), routing = loadRouting(r.home);
  const client = new MemoryClient({ project: "project-a", check() {}, screen: rows => rows,
    publicText: text => withoutPii([{ title: "", text }], routing, r.home, ["private folder"]).length === 1,
    capture: () => ({ home: r.home }) });
  const capture = new Capture(client, { project: "project-a", cwd: r.home });
  capture.init("valid-private-policy", "public start");
  capture.observe({ tool: "read", args: "{}", output: "public control", id: "public", paths: ["public/file.txt"] });
  capture.observe({ tool: "read", args: "{}", output: "private result", id: "private", paths: ["private folder/record.txt"] });
  await capture.end();
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  expect(stored.rows().filter(v => v.event === "PostToolUse")).toHaveLength(1);
  expect(stored.rows().map(v => v.event)).toEqual(expect.arrayContaining(["SessionStart", "PostToolUse", "SessionEnd"]));
});


test("the built-in secret screen sees decoded JSON key/value pairs before capture or candidates", async () => {
  const r = rig();
  expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", excerpt: "public control", input: '{"path":"public.txt"}' })).toHaveProperty("id");
  for (const password of ["ordinary-private-password", 12345678]) for (const field of ["input", "output"]) expect(await r.client.appendCapture({ project: "project-a", agent: "local", event: "PostToolUse", excerpt: "public prefix", [field]: JSON.stringify({ password }) })).toBeUndefined();
  expect(await r.client.save({ project: "project-a", text: "public candidate", metadata: { peer: "codex" } })).toMatchObject({ status: "candidate" });
  for (const password of ["ordinary-private-password", 12345678]) expect(await r.client.save({ project: "project-a", text: "public prefix", metadata: { password } })).toBeUndefined();
  expect(r.candidates.list({ project: "project-a" })).toHaveLength(1);
  const stored = new CaptureStore({ home: r.home, project: "project-a" }); clean.push(() => stored.close());
  expect(stored.rows()).toHaveLength(1);
});


test("capture persists only relative file paths while commands remain screened input", async () => {
 const r=rig(), capture=new Capture(r.client,{project:"project-a",cwd:r.home}); capture.init("paths","public prompt");
 capture.observe({tool:"read",args:JSON.stringify({path:join(r.home,"src/file.ts")}),output:"public",id:"read",paths:[join(r.home,"src/file.ts")],sourceId:"read"});
 capture.observe({tool:"write",args:'{"path":"relative.txt"}',output:"public",id:"write",paths:["relative.txt"],sourceId:"write"});
 capture.observe({tool:"bash",args:'{"command":"echo public"}',output:"public",id:"bash",paths:["echo public"],sourceId:"bash"});
 capture.observe({tool:"git",args:'{"args":["status"]}',output:"public",id:"git",paths:["status"],sourceId:"git"});
 capture.observe({tool:"read",args:'{"path":"../outside.txt"}',output:"public",id:"outside",paths:["../outside.txt"],sourceId:"outside"});
 await capture.end();
 const store=new CaptureStore({home:r.home,project:"project-a"});clean.push(()=>store.close());
 const rows=store.rows({limit:100}).filter(row=>row.event==="PostToolUse");
 expect(rows).toHaveLength(5);
 expect(rows.find(row=>row.tool==="write")!.paths).toEqual(["relative.txt"]);
 expect(rows.find(row=>row.tool==="read"&&row.paths.length)!.paths).toEqual(["src/file.ts"]);
 expect(rows.filter(row=>row.tool==="bash"||row.tool==="git").every(row=>row.paths.length===0)).toBe(true);
 expect(rows.flatMap(row=>row.paths).every(name=>!name.startsWith("/")&&!name.includes(".."))).toBe(true);
});

test("capture reuses one handle until a binding refusal or explicit close releases it", async () => {
 const r=rig();
 await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",excerpt:"first"});
 // Observe teardown at the published store boundary, without replacing its persistence behavior.
 const original=CaptureStore.prototype.close;let closes=0;
 CaptureStore.prototype.close=function(){closes++;return original.call(this);};
 try {
   await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",excerpt:"second"});
   expect(closes).toBe(0);
   r.revoke();expect(await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",excerpt:"refused"})).toBeUndefined();
   expect(closes).toBe(1);r.client.close();r.client.close();expect(closes).toBe(1);
   expect(await r.client.health()).toEqual({ok:false});
 } finally {CaptureStore.prototype.close=original;}
 const store=new CaptureStore({home:r.home,project:"project-a"});clean.push(()=>store.close());expect(store.rows().map(row=>row.excerpt).sort()).toEqual(["first","second"]);
});


test("cached capture adopts changed home R6 bounds at the next append", async () => {
 const r=rig();const original=CaptureStore.prototype.close;let closes=0;
 CaptureStore.prototype.close=function(){closes++;return original.call(this);};
 try {
   expect(await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",at:new Date(Date.now()-2*86400000).toISOString(),excerpt:"old retained row"})).toHaveProperty("id");
   expect(closes).toBe(0);
   writeCaptureConfigFile(join(r.store.dir,"capture-config.json"),{capMb:1,retentionDays:1});
   expect(await r.client.appendCapture({project:"project-a",agent:"local",event:"PostToolUse",excerpt:"current row"})).toHaveProperty("id");
   expect(closes).toBe(1);
 } finally {CaptureStore.prototype.close=original;}
 const store=new CaptureStore({home:r.home,project:"project-a"});clean.push(()=>store.close());
 expect(store.rows().map(row=>row.excerpt)).toEqual(["current row"]);expect(store.stats()).toMatchObject({capMb:1,retentionDays:1});
});
