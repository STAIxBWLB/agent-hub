import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { CHARACTERS } from "../src/pet/characters.ts";
import { petPixels } from "../src/pet/pixels.ts";
import { needs } from "../src/ui/needs.ts";
import { Board } from "../src/hub/board.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";

class Node {
 children:Node[]=[];private text="";get textContent(){return this.text}set textContent(value:string){this.text=value;this.writes++}hidden=false;type="";dataset:Record<string,string>={};attrs:Record<string,string>={};handlers:Record<string,()=>void>={};writes=0;scrolls=0;focuses=0;
 append(...nodes:Node[]){this.children.push(...nodes);this.writes++}replaceChildren(...nodes:Node[]){this.children=nodes;this.writes++}
 setAttribute(key:string,value:string){this.attrs[key]=value}addEventListener(key:string,fn:()=>void){this.handlers[key]=fn}
 scrollIntoView(){this.scrolls++}focus(){this.focuses++}
}
function fixture(){
 const html=readFileSync(new URL("../src/ui/index.html",import.meta.url),"utf8"),code=html.slice(html.indexOf("const attentionBaseTitle ="),html.indexOf("function render(snapshot)"));
 const nodes=new Map<string,Node>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)!}, notices:string[]=[],views:string[]=[],permissions:Node[]=[];
 const context={document:{title:"agent-hub | Local dashboard",querySelectorAll:()=>permissions},Date:{now:()=>1000},$:get,el:(_tag:string,text?:string,cls?:string)=>{const n=new Node();n.textContent=text??"";n.attrs.class=cls??"";return n},needs,taskRows:new Map<number,Node>(),peerRows:new Map<string,Node>(),snapshotValid:true,switchView:(view:string)=>views.push(view),notice:(text:string)=>notices.push(text),action:()=>{throw new Error("attention navigation must not request an action")}};
 runInNewContext(code+'; globalThis.draw=renderNeedsAttention;globalThis.reach=reachAttention',context);
 return{get,context:context as typeof context & {draw:(s:unknown)=>void;reach:()=>void},notices,views,permissions,html};
}
const attention=()=>({approvals:[],defaults:[],tasks:[],peers:{},budget:{},storageBlocked:false});
test("dashboard attention uses shared body-free needs without rewriting an unchanged count",()=>{
 const f=fixture(),secret=()=>{throw new Error("private field read")},input={...attention(),tasks:[{id:14,state:"in_review",reviewer:"user",get title(){return secret()}}],get paths(){return secret()}};
 const snapshot={attention:input};f.context.draw(snapshot);
 const root=f.get("attention-badge"),writes=root.writes;expect(root.hidden).toBe(false);expect(root.textContent).toContain("1");
 expect(f.context.document.title).toBe("(1) agent-hub");f.context.draw(snapshot);expect(root.writes).toBe(writes);
 expect(f.html).not.toContain('id="pet-container"');expect(f.html).not.toContain('/* PET_MODEL */');expect(f.html).not.toContain('renderPetAttention');
});
test("dashboard attention activation reaches the exact visible need and rejects stale snapshots",()=>{
 const f=fixture(),row=new Node();f.context.taskRows.set(14,row);f.context.draw({attention:{...attention(),tasks:[{id:14,state:"in_review",reviewer:"user"}]}});
 f.context.reach();expect(row.scrolls).toBe(1);expect(row.focuses).toBe(1);expect(f.views).toEqual(["board"]);expect(f.notices).toEqual([]);
 f.context.taskRows.clear();f.context.reach();expect(f.get("tasks-title").scrolls).toBe(1);expect(f.notices).toEqual(["Attention: review 14"]);
 f.context.snapshotValid=false;f.context.reach();expect(f.views).toHaveLength(2);expect(f.notices).toHaveLength(1);
});
test("invalid attention resets the title and badge without a new timer or request",()=>{
 const f=fixture();for(const snapshot of [undefined,{}, {attention:{}},{attention:{...attention(),tasks:[null]}}]){expect(()=>f.context.draw(snapshot)).not.toThrow();expect(f.get("attention-badge").hidden).toBe(true);expect(f.context.document.title).toBe("agent-hub | Local dashboard")}
 const code=f.html.slice(f.html.indexOf('const attentionBaseTitle ='),f.html.indexOf('function render(snapshot)'));expect(code).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|action\(/);
});
test("dashboard approval badge selects an exact id without peer or first-row fallback",()=>{
 const f=fixture(),wrong=new Node(),exact=new Node();wrong.dataset.permissionId="other";exact.dataset.permissionId='approval:special';f.permissions.push(wrong,exact);
 f.context.draw({permissions:[{id:'approval:special',expiresAt:3000}],attention:{...attention(),approvals:[{id:'approval:special',peer:"codex",expiresAt:3000}]}});f.context.reach();
 expect(f.views).toEqual(["agents"]);expect(exact.scrolls).toBe(1);expect(exact.focuses).toBe(1);expect(wrong.scrolls).toBe(0);expect(f.get("agents-approval-count").textContent).toContain("1");
 f.permissions.pop();f.context.reach();expect(wrong.scrolls).toBe(0);expect(f.get("permissions-title").scrolls).toBe(1);expect(f.notices).toHaveLength(1);
});
test("dashboard approval count excludes pending defaults and expired approvals",()=>{
 const f=fixture();f.context.draw({permissions:[{id:"expired",expiresAt:900}],attention:{...attention(),defaults:[{peer:"codex"}],approvals:[{id:"expired",expiresAt:900}]}});
 expect(f.get("agents-approval-count").hidden).toBe(true);
 f.context.draw({permissions:[{id:"live",expiresAt:3000}],attention:{...attention(),approvals:[{id:"live",expiresAt:3000}]}});expect(f.get("agents-approval-count").hidden).toBe(false);expect(f.get("agents-approval-count").textContent).toContain("1");
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

test("pet review eyes retain a distinct lowercase mask",()=>{
 for(const character of Object.values(CHARACTERS)){
  const review=petPixels(character.frames.blocks.review.full),waiting=petPixels(character.frames.blocks.waiting.full),idle=petPixels(character.frames.blocks.idle.full);
  expect(review.pixels).not.toEqual(waiting.pixels);expect(review.pixels).not.toEqual(idle.pixels);
 }
});

test("dashboard pending defaults switch to Agents with heading guidance",()=>{
 const f=fixture(),row=new Node();f.context.peerRows.set("codex",row);
 f.context.draw({attention:{...attention(),defaults:[{peer:"codex"}]}});
 f.context.reach();expect(f.views).toEqual(["agents"]);expect(row.scrolls).toBe(0);expect(row.focuses).toBe(0);
 expect(f.get("peers-title").scrolls).toBe(1);expect(f.notices).toEqual(["Attention: default codex"]);
});

test("dashboard rasterizes every shipped non-space block glyph and preserves STAI raised arms",()=>{
 const glyphs=new Set(Object.values(CHARACTERS).flatMap(character=>Object.values(character.frames.blocks).flatMap(pose=>pose.full.flatMap(row=>[...row]))));
 glyphs.delete(" ");for(const glyph of glyphs)expect(petPixels([glyph]).pixels.length).toBeGreaterThan(0);
 const stai=CHARACTERS.stai.frames.blocks;
 expect(JSON.stringify(petPixels(stai.waiting.full).pixels)).not.toBe(JSON.stringify(petPixels(stai.idle.full).pixels));
 expect(petPixels(["-"]).pixels.length).toBe(5);
});
