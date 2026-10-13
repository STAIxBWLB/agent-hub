import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { CHARACTERS } from "../src/pet/characters.ts";
import { petPixels } from "../src/pet/pixels.ts";
import { needs, type NeedsInput } from "../src/ui/needs.ts";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

class Node {
  children:Node[]=[];textContent="";hidden=false;type="";attrs:Record<string,string>={};handlers:Record<string,()=>void>={};writes=0;scrolls=0;focuses=0;
  append(...nodes:Node[]){this.children.push(...nodes);this.writes++}replaceChildren(){this.children=[];this.writes++}
  setAttribute(key:string,value:string){this.attrs[key]=value}addEventListener(key:string,fn:()=>void){this.handlers[key]=fn}
  scrollIntoView(){this.scrolls++}focus(){this.focuses++}
}
function fixture(){
 const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8"),code=html.slice(html.indexOf("const petBaseTitle ="),html.indexOf("function render(snapshot)"));
 const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!}, notices:string[]=[];
 const context={document:{title:"agent-hub | Local dashboard",createElementNS:()=>new Node(),querySelector:()=>null},Date:{now:()=>1000},$:get,el:(_tag:string,text?:string,cls?:string)=>{const n=new Node();n.textContent=text??"";n.attrs.class=cls??"";return n},needs,petCharacters:CHARACTERS,petPixels,taskRows:new Map<number,Node>(),peerRows:new Map<string,Node>(),snapshotValid:true,notice:(text:string)=>notices.push(text),action:()=>{throw new Error("pet must not request an action")}};
 runInNewContext(code+'; globalThis.draw=renderPetAttention;globalThis.reach=reachPetNeed',context);
 return{get,context:context as typeof context & {draw:(s:unknown)=>void;reach:()=>void},notices,html};
}
const attention=()=>({approvals:[],defaults:[],tasks:[],peers:{},budget:{},storageBlocked:false});
test("dashboard pet uses shared body-free needs and pixels without rewriting an unchanged snapshot",()=>{
 const f=fixture(),secret=()=>{throw new Error("private field read")},input={...attention(),tasks:[{id:14,state:"in_review",reviewer:"user",get title(){return secret()}}],get paths(){return secret()}};
 const snapshot={pet:{enabled:true,character:"stai",blink:true},attention:input};f.context.draw(snapshot);
 const root=f.get("pet-container"),writes=root.writes;expect(root.hidden).toBe(false);expect(root.children[0]!.attrs['aria-label']).toBe("STAIx: review, 1 action, 0 watch");
 expect(f.context.document.title).toBe("(1) agent-hub");expect(root.children[0]!.children[0]!.children.length).toBeGreaterThan(0);
 f.context.draw(snapshot);expect(root.writes).toBe(writes);
});
test("dashboard pet activation reaches the exact visible need or heading and never invokes an action",()=>{
 const f=fixture(),row=new Node();f.context.taskRows.set(14,row);f.context.draw({pet:{enabled:true,character:"boxbot",blink:false},attention:{...attention(),tasks:[{id:14,state:"in_review",reviewer:"user"}]}});
 f.get("pet-container").children[0]!.handlers.click!();expect(row.scrolls).toBe(1);expect(row.focuses).toBe(1);expect(f.notices).toEqual([]);
 f.context.taskRows.clear();f.context.reach();expect(f.get("tasks-title").scrolls).toBe(1);expect(f.notices).toEqual(["Attention: review 14"]);
 f.context.snapshotValid=false;f.context.reach();expect(f.notices).toHaveLength(1);
});
test("legacy invalid and off attention stay unavailable and reset the title; reduced motion uses static CSS",()=>{
 const f=fixture();for(const snapshot of [undefined,{pet:{enabled:false}}, {pet:{enabled:true,character:"stai"},attention:{}},{pet:{enabled:true,character:"stai"},attention:{...attention(),tasks:[null]}}]){expect(()=>f.context.draw(snapshot)).not.toThrow();expect(f.get("pet-container").hidden).toBe(true);expect(f.context.document.title).toBe("agent-hub | Local dashboard")}
 expect(f.html).toContain('.pet-container[hidden]{display:none}');expect(f.html).toContain('@media(prefers-reduced-motion:reduce){.pet-waiting .pet-open,.pet-waiting .pet-blink{animation:none}}');
 const code=f.html.slice(f.html.indexOf('const petBaseTitle ='),f.html.indexOf('function render(snapshot)'));expect(code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|action\(/);
});

test("dashboard pixel frames stay inside their viewBox for every selected character and state",()=>{
 for(const character of Object.values(CHARACTERS))for(const sizes of Object.values(character.frames.blocks)) {
  const model=petPixels(sizes.full);expect(model.width).toBeLessThanOrEqual(60);expect(model.height).toBeLessThanOrEqual(64);expect(model.pixels.length).toBeGreaterThan(0);
  for(const [x,y] of model.pixels){expect(x).toBeGreaterThanOrEqual(0);expect(x).toBeLessThan(model.width);expect(y).toBeGreaterThanOrEqual(0);expect(y).toBeLessThan(model.height)}
 }
});

test("real dashboard snapshot projects structural attention without publishing its input in status",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ahub-dashboard-pet-")),stateDir=join(root,"state");mkdirSync(stateDir);mkdirSync(join(root,".agenthub"));
 writeFileSync(join(root,".agenthub/config.json"),JSON.stringify({pet:{character:"gyul",blink:false}}));
 const board=new Board(join(stateDir,"hub.db"));const task=board.propose("user",{title:"PRIVATE_PET_TITLE",class:"plan"});
 board.update(task.id,"user","assigned",{owner:"user",reviewer:"user"});board.update(task.id,"user","accepted",{state:"in_progress"});board.update(task.id,"user","done",{state:"in_review"});board.close();
 const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false}}});
 const client=await ControlClient.connect(stateDir,{role:"console"});
 try {
  const snapshot=await client.request({t:"ui_snapshot"});expect(snapshot.ok).toBe(true);expect(snapshot.pet).toEqual({enabled:true,character:"gyul",blink:false});
  expect(needs(snapshot.attention,Date.now())).toMatchObject({act:1,watch:0,state:"review",items:[{kind:"review",level:"act",id:task.id}]});
  expect(JSON.stringify(snapshot.attention)).not.toContain("PRIVATE_PET_TITLE");expect(snapshot.attention.tasks).toEqual([{id:task.id,state:"in_review",owner:"user",reviewer:"user"}]);
  expect((await client.request({t:"status"})).status).not.toHaveProperty("attentionInput");expect(JSON.parse(readFileSync(join(stateDir,"status.json"),"utf8"))).not.toHaveProperty("attentionInput");
 }finally{client.close();await daemon.stop();rmSync(root,{recursive:true,force:true})}
},20000);

test("dashboard blinking requires a live approval rather than a pending default",()=>{
 const f=fixture();const draw=(input:NeedsInput,blink=true)=>{f.context.draw({pet:{enabled:true,character:"stai",blink},attention:input});return f.get("pet-container").children[0]!};
 const pending=draw({...attention(),defaults:[{peer:"codex"}]});expect(pending.attrs.class).not.toContain("pet-waiting");expect(pending.children[0]!.children).toHaveLength(1);
 const live={...attention(),approvals:[{id:"approval-live",expiresAt:3000}]};const waiting=draw(live);expect(waiting.attrs.class).toContain("pet-waiting");expect(waiting.children[0]!.children).toHaveLength(2);
 const disabled=draw(live,false);expect(disabled.attrs.class).not.toContain("pet-waiting");expect(disabled.children[0]!.children).toHaveLength(1);
 const expired=draw({...attention(),approvals:[{id:"approval-expired",expiresAt:900}]});expect(expired.attrs.class).not.toContain("pet-waiting");expect(expired.children[0]!.children).toHaveLength(1);
});

test("dashboard review eyes retain a distinct lowercase mask and the leaf uses an existing theme tone",()=>{
 for(const character of Object.values(CHARACTERS)){
  const review=petPixels(character.frames.blocks.review.full),waiting=petPixels(character.frames.blocks.waiting.full),idle=petPixels(character.frames.blocks.idle.full);
  expect(review.pixels).not.toEqual(waiting.pixels);expect(review.pixels).not.toEqual(idle.pixels);
 }
 const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8");expect(html).toContain('.pet-accent{fill:var(--amber)}');expect(html).toMatch(/--amber:/);
});
