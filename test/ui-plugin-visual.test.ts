import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider, parseVisualAssetId, visualAssetId } from "../src/ui/plugin.ts";
import { visualSnapshotSelector, type Lifecycle, type ProjectRecord } from "../src/hub/manager.ts";
import { PROTOCOL } from "../src/hub/control-client.ts";
import type { VisualFile } from "../src/hub/visual.ts";

const ID = "12345678-1234-1234-1234-123456789abc";
const roots: string[] = [], servers: { stop(force?: boolean): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(),"ahub-visual-provider-")); roots.push(home);
  const projects = ["p1","p2"].map(id => ({id,root:join(home,id),stateDir:join(home,id,"state"),basePort:4700,instanceId:"i1",pid:42}) as ProjectRecord);
  const registry = { get: (id: string) => projects.find(row=>row.id===id),list:()=>projects,close(){} } as any;
  const lifecycle: Lifecycle = { inspectProject: async () => ({state:"running",status:{instanceId:"i1",peers:{}}}),startProject:async()=>({}),stopProject:async()=>{} };
  const data = new Uint8Array([137,80,78,71,13,10,26,10,0]);
  let visible = true, mutate = false, privateFile = false;
  const requests: Record<string,unknown>[] = [];
  for (const project of projects) {
    mkdirSync(project.stateDir,{recursive:true}); writeFileSync(join(project.root,"image.png"),data);
    const file: VisualFile = {asset:`${ID}:before`,path:"image.png",sha256:createHash("sha256").update(data).digest("hex"),bytes:data.length,mime:"image/png"};
    const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(req,server){if(server.upgrade(req))return;return new Response("no",{status:400});},websocket:{message(ws,raw){
      const input=JSON.parse(String(raw));
      if(input.t==="hello") return void ws.send(JSON.stringify({rid:input.rid,t:"welcome",cwd:project.root,projectId:project.id,instanceId:"i1"}));
      requests.push(input);
      const visual={id:ID,from:"codex",created:1,task:7,kind:"beforeAfter",title:"Public image",payload:{kind:"beforeAfter",before:{asset:`${ID}:before`,alt:"Before"},after:{text:"After"}}};
      ws.send(JSON.stringify({rid:input.rid,ok:true,...(input.visual ? {visual:visible?visual:null}:input.visualAsset?{visualAsset:visible?{id:ID,task:7,from:"codex",created:1,file:{...file,...(mutate?{sha256:"0".repeat(64)}:{})}}:null}:{visuals:[{id:ID,task:7,kind:"beforeAfter",title:"Public image"}]})}));
    }}}); servers.push(server);
    writeFileSync(join(project.stateDir,"status.json"),JSON.stringify({pid:process.pid,controlPort:server.port,cwd:project.root,projectId:project.id,instanceId:"i1",protocol:PROTOCOL}));
    writeFileSync(join(project.stateDir,"control-token"),"fixture-token");
  }
  const options={home,registry,lifecycle,visualPolicy:async(cwd:string)=>({cwd,deny:[],private:()=>privateFile})};
  return {projects,requests,data,options,provider:createProvider(options),hide:()=>{visible=false;},change:()=>{mutate=true;},private:()=>{privateFile=true;}};
}
test("manager forwards only one closed visual read selector without caller paths or policy",()=>{
  expect(visualSnapshotSelector({visual:ID,path:"private",deny:[]})).toEqual({visual:ID});
  expect(visualSnapshotSelector({visualAsset:`${ID}:after`})).toEqual({visualAsset:`${ID}:after`});
  expect(visualSnapshotSelector({visualTask:7})).toEqual({visualTask:7});
  for(const input of [{visual:"../path"},{visualTask:0},{visualTask:"7"},{visual:ID,visualTask:7},{visualAsset:`${ID}:unknown`}])expect(()=>visualSnapshotSelector(input)).toThrow();
});
test("project snapshot namespaces assets even when two project DBs contain the same visual UUID",async()=>{
  const f=fixture();
  const values=[];
  for(const project of f.projects){const reply=await f.provider.snapshot({after:0,panel:"stream",projectId:project.id,instanceId:"i1",visual:ID});values.push((reply.visual as any).payload.before.asset);}
  expect(values[0]).not.toBe(values[1]);
  expect(parseVisualAssetId(values[0])).toEqual({projectId:"p1",instanceId:"i1",asset:`${ID}:before`});
  expect(f.requests.every(row=>row.visual===ID)).toBe(true);
});
test("asset provider serves freshly guarded original bytes and refuses a changed image",async()=>{
  const f=fixture(),id=visualAssetId("p1","i1",`${ID}:before`);
  expect((await f.provider.asset!({id}))?.bytes).toEqual(f.data);
  writeFileSync(join(f.projects[0]!.root,"image.png"),new Uint8Array([...f.data,1]));
  await expect(f.provider.asset!({id})).rejects.toThrow("visual asset changed since posted or no longer allowed; post the visual again using a current public file");
  expect(await f.provider.asset!({id:`${ID}:before`})).toBeNull();
});
for(const fault of ["privacy","metadata","instance","project"] as const)test(`asset ${fault} changed during guarded read cannot publish bytes`,async()=>{
  const f=fixture(); let release:()=>void=()=>{},entered:()=>void=()=>{};
  const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const provider=createProvider({...f.options,visualRead:async()=>{entered();await blocked;return{bytes:f.data,mime:"image/png" as const,name:"image.png"};}});
  const answer=provider.asset!({id:visualAssetId("p1","i1",`${ID}:before`)});await started;
  if(fault==="privacy")f.hide();else if(fault==="metadata")f.change();else if(fault==="instance")f.projects[0]!.instanceId="i2";else f.projects[0]!.root=join(f.projects[0]!.root,"changed");
  release();expect(await answer).toBeNull();
});
test("new local private-file policy refuses asset bytes after a read",async()=>{
  const f=fixture(),provider=createProvider({...f.options,visualRead:async()=>{f.private();return{bytes:f.data,mime:"image/png" as const,name:"image.png"};}});
  expect(await provider.asset!({id:visualAssetId("p1","i1",`${ID}:before`)})).toBeNull();
});


test("recognized asset read failure exposes only a fixed cause and next step",async()=>{
  const f=fixture(),canary="/private/canary-source.png contains private fixture text";
  const provider=createProvider({...f.options,visualRead:async()=>{throw new Error(canary);}});
  const failure=await provider.asset!({id:visualAssetId("p1","i1",`${ID}:before`)}).then(()=>null,error=>error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure?.message).toBe("visual asset changed since posted or no longer allowed; post the visual again using a current public file");
  expect(failure?.message).not.toContain(canary);
});
