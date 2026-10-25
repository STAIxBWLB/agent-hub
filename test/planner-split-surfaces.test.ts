import {profileTaskTools} from "../src/hub/hub-tools.ts";
import { realPath } from "../src/hub/project.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
const ENTRY=join(import.meta.dir,"../src/cli/main.ts");
async function cli(root:string,args:string[]){
  const file=join(root,`cli-${crypto.randomUUID()}.ts`);writeFileSync(file,`for(const key of Object.keys(process.env))if(key.startsWith("AGENTHUB_")||["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID"].includes(key))delete process.env[key];process.env.AGENTHUB_HOME=${JSON.stringify(join(root,"home"))};process.argv=[process.execPath,${JSON.stringify(ENTRY)},...${JSON.stringify(args)}];await import(${JSON.stringify(ENTRY)});`);
  const child=Bun.spawn([process.execPath,file],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try{const [code,stdout]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout};}finally{clearTimeout(timer);}
}
test("split tools HTTP and CLI share role revision and unused-child undo (#263)",async()=>{
  const root=realPath(mkdtempSync(join(tmpdir(),"ahub-split-surfaces-"))),stateDir=join(root,".agenthub/state");
  const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},roles:{claude:["planner"],codex:["implementer"]},batch_ms:0}});
  const person=await ControlClient.connect(stateDir,{role:"console"}),planner=await ControlClient.connect(stateDir,{role:"tools",peer:"claude"}),other=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});
  try{
    const request=(client:ControlClient,op:string,args:unknown)=>client.request({t:"task",op,args});
    expect(await request(person,"hub_task_propose",{title:"parent",class:"implement",backlog:true})).toMatchObject({ok:true});const list=await request(planner,"hub_backlog_list",{}),id=JSON.parse(list.text)[0].id,parts=[{title:"first"},{title:"second",afterParts:[0]}];
    expect(await request(other,"hub_backlog_split",{id,revision:0,parts,reason:"parts"})).toMatchObject({ok:false});
    const result=await request(planner,"hub_backlog_split",{id,revision:0,parts,reason:"parts"});expect(result.ok).toBe(true);expect(JSON.parse(result.text).children).toHaveLength(2);
    expect(await request(person,"hub_backlog_undo",{id,revision:1})).toMatchObject({ok:true});
    const viaCli=await cli(root,["backlog","split",String(id),"2",JSON.stringify(parts),"parts via CLI","--json"]);expect(viaCli.code).toBe(0);expect(JSON.parse(viaCli.stdout).children).toHaveLength(2);
    expect(await request(person,"hub_backlog_undo",{id,revision:3})).toMatchObject({ok:true});
    const opened=await person.request({t:"ui"}),url=new URL(opened.url),origin=url.origin;
    const session=await fetch(origin+"/session",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({ticket:url.hash.slice(1)})});expect(session.status).toBe(200);const cookie=session.headers.get("set-cookie")!.split(";")[0]!;
    const reply=await fetch(origin+"/action",{method:"POST",headers:{origin,cookie,"content-type":"application/json"},body:JSON.stringify({action:"backlog_split",id,revision:4,parts,reason:"parts via dashboard"})});expect(await reply.json()).toMatchObject({ok:true});
    expect(await request(person,"hub_backlog_undo",{id,revision:5})).toMatchObject({ok:true});
  }finally{other.close();planner.close();person.close();await daemon.stop();rmSync(root,{recursive:true,force:true});}
},20_000);

test("split nested plan schema follows the selected project profile",()=>{
 const schema=profileTaskTools("research").find(tool=>tool.name==="hub_backlog_split")!.inputSchema.properties.parts as {items:{properties:{plan:{properties:Record<string,unknown>}}}};
 expect(Object.keys(schema.items.properties.plan.properties)).toContain("sources");expect(Object.keys(schema.items.properties.plan.properties)).toContain("sections");expect(Object.keys(schema.items.properties.plan.properties)).not.toContain("signatures");
});
