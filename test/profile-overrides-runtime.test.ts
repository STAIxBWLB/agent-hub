import { BasePeer } from "../src/hub/peers.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { init } from "../src/cli/init.ts";
import { loadConfig, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
async function fixture(profile:"dev"|"research"="research", custom=true) {
  const dir=realPath(mkdtempSync(join(tmpdir(),"ahub-override-runtime-"))),home=realPath(mkdtempSync(join(tmpdir(),"ahub-override-home-")));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}),()=>rmSync(home,{recursive:true,force:true}));init(dir,profile);
  const file=join(dir,".agenthub/config.local.json"), data={profile_overrides:{classes:{annotate:"bulk_edit",audit:"test"},plan_keys:["paths","sources"],role_text:{implementer:"CUSTOM_PROFILE_GUIDANCE"},catalog_roles:{kimi:["analyst"]},example_checks:["DO_NOT_RUN_EXAMPLE_COMMAND"]}};writeFileSync(file,JSON.stringify(custom?data:{}));const routing=join(dir,".agenthub/routing.toml");writeFileSync(routing,readFileSync(routing,"utf8").replace(/^pi_backend = "mlx"$/gm,'pi_backend = "dgx"'));
  const config=loadConfig(dir);config.memory.enabled=false;config.inference.enabled=false;config.mlx.enabled=false;config.snapshots.enabled=false;config.peers={kimi:{start_mode:"headless"}};config.kimi_cmd=[process.execPath,join(import.meta.dir,"fakes/acp-server.ts"),"--record-protocol",join(dir,"protocol.jsonl")];
  const state=join(dir,".agenthub/state"),daemon=await startDaemon({cwd:dir,stateDir:state,config,controlPort:0,codexAppPort:0,codexProxyPort:0});cleanup.push(()=>daemon.stop());const client=await ControlClient.connect(state,{role:"console"});cleanup.push(()=>client.close());
  const op=async(name:string,args:Record<string,unknown>)=>{const result=await client.request({t:"task",op:name,args},15000);expect(result.ok).toBe(true);return result;};return{dir,home,state,config,daemon,client,op};
}
async function cli(f:Awaited<ReturnType<typeof fixture>>,args:string[]){const entry=join(import.meta.dir,"../src/cli/main.ts"),file=join(f.home,"cli.ts");writeFileSync(file,`for(const key of ["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID","AGENTHUB_PEER_ID","AGENTHUB_CHANNEL","AGENTHUB_PROJECT_DIR","AGENTHUB_STATE_DIR","AGENTHUB_INSTANCE_ID","AGENTHUB_LAUNCH_ID"])delete process.env[key];process.env.AGENTHUB_HOME=${JSON.stringify(f.home)};process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`);const child=Bun.spawn([process.execPath,file],{cwd:f.dir,stdout:"pipe",stderr:"pipe"});const[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{out,err,code};}
test("project custom aliases reach real CLI Tasks routing and selected plan fields without executing examples (#259)",async()=>{
  const f=await fixture();const result=await cli(f,["task","propose","annotate","Custom task","--owner","user"]);expect(result.code).toBe(0);expect(result.err).toContain('"annotate" was taken as the class');
  const task=JSON.parse((await f.op("task_show",{id:1})).text);expect(task).toMatchObject({class:"bulk_edit",profile:"research",profileClass:"annotate"});
  await f.op("hub_task_propose",{title:"Selected plan",class:"audit",owner:"user",plan:{paths:["paper.txt"],sources:["source-1"],claims:["not-selected"]}});const planned=JSON.parse((await f.op("task_show",{id:2})).text);expect(planned.plan).toEqual({paths:["paper.txt"],sources:["source-1"]});
  expect((await f.op("route_explain",{class:"annotate",title:"route custom alias"})).text).toContain("base bulk_edit");expect(f.config.checks).not.toHaveProperty("annotate");expect(readFileSync(join(f.state,"hub.log"),"utf8")).not.toContain("DO_NOT_RUN_EXAMPLE_COMMAND");
});
test("dev custom aliases retain alias metadata while existing base meanings stay stable (#259)",async()=>{
  const f=await fixture("dev");await f.op("hub_task_propose",{title:"Custom dev task",class:"annotate",owner:"user"});const task=JSON.parse((await f.op("task_show",{id:1})).text);expect(task).toMatchObject({class:"bulk_edit",profile:"dev",profileClass:"annotate"});
  await f.op("hub_task_propose",{title:"Plain dev task",class:"implement",owner:"user"});const plain=JSON.parse((await f.op("task_show",{id:2})).text);expect(plain).toMatchObject({class:"implement",profile:"dev",profileClass:"implement"});
  const shipped=await fixture("dev",false);await shipped.op("hub_task_propose",{title:"Unmodified dev task",class:"implement",owner:"user"});expect(JSON.parse((await shipped.op("task_show",{id:1})).text).profileClass).toBeUndefined();
});
test("managed native preamble receives resolved guidance and catalog defaults once from project overrides (#259)",async()=>{
  const f=await fixture();expect((await f.client.request({t:"peer_start",peer:"kimi"},15000)).ok).toBe(true);expect((await f.client.request({t:"send",body:"override preamble probe",to:["kimi"]})).ok).toBe(true);
  const prompts=()=>{try{return readFileSync(join(f.dir,"protocol.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)).filter(item=>item.method==="session/prompt");}catch{return[];}};
  for(let i=0;i<200&&!prompts().length;i++)await Bun.sleep(5);expect(prompts().length).toBeGreaterThan(0);const body=JSON.stringify(prompts()[0]);expect(body).toContain("CUSTOM_PROFILE_GUIDANCE");expect(body).toContain("annotate=bulk_edit");expect(body).toContain("analyst [research, shipped");
});

test("custom dev document sections on ordinary base tasks preserve profile semantics and do not falsely overlap (#259)",async()=>{
  const f=await fixture("dev");await f.client.close();await f.daemon.stop();const local=join(f.dir,".agenthub/config.local.json");const data=JSON.parse(readFileSync(local,"utf8"));data.profile_overrides.plan_keys=["paths","sections"];writeFileSync(local,JSON.stringify(data));const config=loadConfig(f.dir);config.memory.enabled=false;config.inference.enabled=false;config.mlx.enabled=false;config.snapshots.enabled=false;
  const daemon=await startDaemon({cwd:f.dir,stateDir:f.state,config,controlPort:0,codexAppPort:0,codexProxyPort:0});cleanup.push(()=>daemon.stop());const client=await ControlClient.connect(f.state,{role:"console"});cleanup.push(()=>client.close());
  class Peer extends BasePeer {async start(){this.setState("idle");}async stop(){this.setState("offline");}async deliver(){}}
  for(const id of ["codex","kimi"]){const peer=new Peer(id);daemon.bus.add(peer);await peer.start();}
  await client.request({t:"task",op:"hub_task_propose",args:{title:"Methods",class:"implement",owner:"codex",plan:{paths:["report.md"],sections:["report.md#methods"]}}});await client.request({t:"task",op:"hub_task_propose",args:{title:"Results",class:"implement",owner:"kimi",plan:{paths:["report.md"],sections:["report.md#results"]}}});
  const shown=await client.request({t:"task",op:"task_show",args:{id:2}});expect(shown.ok).toBe(true);expect(JSON.parse(shown.text)).toMatchObject({profile:"dev",profileClass:"implement",plan:{sections:["report.md#results"]}});expect(readFileSync(join(f.state,"hub.log"),"utf8")).not.toContain("overlaps");
});
