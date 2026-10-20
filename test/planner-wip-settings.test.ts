import { runInNewContext } from "node:vm";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { checkSettingValue, parseSettingText, settingDef, settingRows, settingRefusal, writeConfigSetting } from "../src/hub/settings.ts";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";
import { hubGitSync } from "../src/hub/git.ts";

const cleanup: (() => void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
test("ordinary WIP settings can disable admission but cannot raise or uncover capacity",()=>{
 const def=settingDef("tasks.wip_limits.codex")!;
 expect(settingRefusal(def,0,"ordinary")).toBeUndefined();
 for(const value of [1,32,null]){const refusal=settingRefusal(def,value,"ordinary");expect(refusal).toBeDefined();expect(refusal).toContain("settings session");}
 expect(settingRefusal(def,32,"settings")).toBeUndefined();expect(settingRefusal(def,32,"terminal")).toBeUndefined();
});
test("normal status text includes planner WIP and capacity for retained peers",()=>{
 const text=renderStatus({peers:{codex:{state:"offline"}},taskWip:{codex:{wip:1,wipLimit:2}}},120,0).map(line=>paint(line,false)).join("\n");
 expect(text).toMatch(/codex planner WIP\s+1\/2/);
});
test("planner WIP settings use bounded integers and the existing local registry write (#263)", () => {
  const root=mkdtempSync(join(tmpdir(),"ahub-wip-settings-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,".agenthub"));
  const shared=JSON.stringify({memory:{enabled:false},inference:{enabled:false}});
  writeFileSync(join(root,".agenthub/config.json"),shared);
  const def=settingDef("tasks.wip_limits.codex");if(typeof def==="string")throw new Error(def);
  expect(def).toMatchObject({type:"integer",store:"config",applies:"live",min:0,max:32});
  expect(checkSettingValue(def,parseSettingText(def,"0"))).toBe(0);
  expect(checkSettingValue(def,parseSettingText(def,"32"))).toBe(32);
  expect(checkSettingValue(def,parseSettingText(def,"inherit"))).toBeNull();
  for(const value of [-1,33,1.5,"1",true,{},[]])expect(()=>checkSettingValue(def,value)).toThrow();
  expect(writeConfigSetting(root,join(root,"state"),def,2,loadConfig)).toBe(true);
  expect(loadConfig(root).tasks.wip_limits?.codex).toBe(2);
  expect(readFileSync(join(root,".agenthub/config.json"),"utf8")).toBe(shared);
  const rows=settingRows({cwd:root,routing:loadRouting(root),running:path=>path.join(".")==="tasks.wip_limits.codex"?1:undefined,next:path=>path.join(".")==="tasks.wip_limits.codex"?2:undefined,mode:()=>({value:"ask"})});
  expect(rows.find(row=>row.key===def.key)).toMatchObject({value:1,pending:2,min:0,max:32});
  expect(writeConfigSetting(root,join(root,"state"),def,null,loadConfig)).toBe(true);
  expect(loadConfig(root).tasks.wip_limits?.codex).toBeUndefined();
});


test("machine-local WIP settings retain every other shared peer capacity (#263)", () => {
  const root=mkdtempSync(join(tmpdir(),"ahub-wip-layers-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,".agenthub"));
  writeFileSync(join(root,".agenthub/config.json"),JSON.stringify({tasks:{wip_limits:{claude:3,codex:2}}}));
  const def=settingDef("tasks.wip_limits.codex");if(typeof def==="string")throw new Error(def);
  expect(writeConfigSetting(root,join(root,"state"),def,4,loadConfig)).toBe(true);expect(loadConfig(root).tasks.wip_limits).toEqual({claude:3,codex:4});
  expect(writeConfigSetting(root,join(root,"state"),def,null,loadConfig)).toBe(true);expect(loadConfig(root).tasks.wip_limits).toEqual({claude:3,codex:2});
});

test("#532 declared instance WIP settings retain builtin bounds, authority and exact config path", () => {
  const instances = { "codex-review": { kind: "codex" }, "kimi-worker": { kind: "kimi" } };
  for (const [peer, instance] of Object.entries(instances)) {
    const key = `tasks.wip_limits.${peer}`, def = settingDef(key, instances);
    const builtin = settingDef(`tasks.wip_limits.${instance.kind}`);
    expect(typeof def).toBe("object");
    if (typeof def === "string" || typeof builtin === "string") throw new Error(String(def));
    expect(def).toEqual({ ...builtin, key, label: `${peer}: planner WIP limit`, path: ["tasks", "wip_limits", peer] });
    expect(typeof settingDef(key)).toBe("string");
    expect(typeof settingDef(`tasks.wip_limits.${peer}-undeclared`, instances)).toBe("string");
    expect(checkSettingValue(def, 0)).toBe(0); expect(checkSettingValue(def, 32)).toBe(32);
    for (const value of [-1, 33, 1.5]) expect(() => checkSettingValue(def, value)).toThrow();
    expect(settingRefusal(def, 0, "ordinary")).toBeUndefined();
    expect(settingRefusal(def, 4, "ordinary")).toContain("settings session");
    expect(settingRefusal(def, 4, "terminal")).toBeUndefined();
  }
  const root = mkdtempSync(join(tmpdir(), "ahub-instance-wip-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  expect(hubGitSync(["-C", root, "init", "-q"], { encoding: "utf8" }).status).toBe(0);
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ tasks: { wip_limits: { codex: 2 } } }));
  writeFileSync(join(root, ".agenthub/config.local.json"), JSON.stringify({ instances }));
  const def = settingDef("tasks.wip_limits.codex-review", instances);
  if (typeof def === "string") throw new Error(def);
  expect(writeConfigSetting(root, join(root, "state"), def, 4, loadConfig)).toBe(true);
  const config = loadConfig(root);
  expect(config.instances).toMatchObject(instances);
  expect(config.tasks.wip_limits).toEqual({ codex: 2, "codex-review": 4 });
  const rows = settingRows({ cwd: root, instances, routing: loadRouting(root), running: path => path.join(".") === def.key ? 4 : undefined, next: path => path.join(".") === def.key ? 4 : undefined, mode: () => ({ value: "ask" }) });
  expect(rows.find(row => row.key === def.key)).toMatchObject({ value: 4, fileValue: 4, min: 0, max: 32, risk: "raises", applies: "live" });
});

test("dashboard WIP editor saves pending restart values including zero and inheritance",async()=>{
 const html=readFileSync(join(import.meta.dir,"../src/ui/index.html"),"utf8"),code=html.slice(html.indexOf("function settingRow("),html.indexOf("const settingSlots ="));
 class Node {
  children:Node[]=[];attrs:Record<string,string>={};listeners:Record<string,()=>unknown>={};dataset:Record<string,string>={};value="";id="";htmlFor="";
  constructor(public tag:string,public textContent=""){} append(...nodes:Node[]){this.children.push(...nodes)} setAttribute(key:string,value:string){this.attrs[key]=value} addEventListener(key:string,fn:()=>unknown){this.listeners[key]=fn} all():Node[]{return [this,...this.children.flatMap(node=>node.all())]}
 }
 for(const pending of [2,0,null,undefined]){
  const sent:unknown[]=[];const row={key:"tasks.wip_limits.codex",group:"Tasks",label:"codex WIP",type:"integer",value:1,pending,file:"config.local.json",source:"config.local.json",applies:"live",risk:"raises",min:0,max:32};
  const node=runInNewContext(`${code}; settingRow(row,true)`,{row,managerMode:false,snapshotValid:true,settingText:String,el:(tag:string,text?:string)=>new Node(tag,text),badge:(text:string)=>new Node("span",text),action:async(payload:unknown)=>{sent.push(payload)}}) as Node;
  const expected=pending===undefined ? 1 : pending;expect(node.all().find(n=>n.tag==="input")?.value).toBe(expected===null ? "" : String(expected));await node.all().find(n=>n.tag==="button")!.listeners.click!();expect(sent).toEqual([{action:"setting",key:row.key,value:expected}]);
 }
});
