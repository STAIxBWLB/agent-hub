import {expect,test} from "bun:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DEFAULT_CONFIG,startDaemon} from "../src/hub/daemon.ts";
import {ControlClient} from "../src/hub/control-client.ts";
const ENTRY=join(import.meta.dir,"../src/cli/main.ts");
async function cli(root:string,args:string[]){const file=join(root,`cli-${crypto.randomUUID()}.ts`);writeFileSync(file,`for(const key of Object.keys(process.env))if(key.startsWith("AGENTHUB_")||["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID"].includes(key))delete process.env[key];process.env.AGENTHUB_HOME=${JSON.stringify(join(root,"home"))};process.argv=[process.execPath,${JSON.stringify(ENTRY)},...${JSON.stringify(args)}];await import(${JSON.stringify(ENTRY)});`);const child=Bun.spawn([process.execPath,file],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),timer=setTimeout(()=>child.kill("SIGKILL"),5000);try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}finally{clearTimeout(timer);}}
test("board release filters and columns are readonly and retain agent backlog floors (#263)",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ahub-board-flags-")),stateDir=join(root,".agenthub/state"),daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},batch_ms:0}}),person=await ControlClient.connect(stateDir,{role:"console"}),peer=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});
 try{
  const request=(client:ControlClient,op:string,args:unknown={})=>client.request({t:"task",op,args});
  const created=await request(person,"release_new",{name:"first",goal:"safe",order:0}),release=JSON.parse(created.text);
  expect(await request(person,"hub_task_propose",{title:"in first release",class:"implement",backlog:true})).toMatchObject({ok:true});
  const listed=await request(person,"hub_backlog_list"),id=JSON.parse(listed.text)[0].id;
  expect(await request(person,"hub_backlog_plan",{id,revision:0,fields:{release:release.id},reason:"scope"})).toMatchObject({ok:true});
  expect(await request(person,"hub_task_propose",{title:"outside release",class:"implement",backlog:true})).toMatchObject({ok:true});
  const filtered=await cli(root,["board","--release","first","--json"]);expect(filtered.code).toBe(0);expect(JSON.parse(filtered.stdout).map((task:{id:number})=>task.id)).toEqual([id]);
  const columns=await cli(root,["board","--columns","--release",`#${release.id}`]);expect(columns.code).toBe(0);expect(columns.stdout).toContain("Backlog");expect(columns.stdout).toContain("in first release");expect(columns.stdout).not.toContain("outside release");
  const grouped=await cli(root,["board","--columns","--release","first","--json"]);expect(grouped.code).toBe(0);const data=JSON.parse(grouped.stdout);expect(data.tasks.map((task:{id:number})=>task.id)).toEqual([id]);expect(data.columns[0].ready.map((card:{id:number})=>card.id)).toEqual([id]);expect(data.columns.slice(1).every((column:{ready:unknown[];waiting:unknown[]})=>!column.ready.length&&!column.waiting.length)).toBe(true);
  const denied=await request(peer,"hub_task_list",{release:"first"});expect(denied.ok).toBe(true);expect(JSON.parse(denied.text)).toEqual([]);
 }finally{peer.close();person.close();await daemon.stop();rmSync(root,{recursive:true,force:true});}
},20_000);
