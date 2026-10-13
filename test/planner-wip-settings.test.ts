import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { checkSettingValue, parseSettingText, settingDef, settingRows, settingRefusal, writeConfigSetting } from "../src/hub/settings.ts";
import { renderStatus } from "../src/cli/output.ts";
import { paint } from "../src/cli/console-state.ts";

const cleanup: (() => void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
test("ordinary WIP settings can disable admission but cannot raise or uncover capacity",()=>{
 const def=settingDef("tasks.wip_limits.codex")!;
 expect(settingRefusal(def,0,"ordinary")).toBeUndefined();
 for(const value of [1,32,null])expect(settingRefusal(def,value,"ordinary")).toContain("settings session");
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
  expect(def).toMatchObject({type:"integer",store:"config",applies:"hub start",min:0,max:32});
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
