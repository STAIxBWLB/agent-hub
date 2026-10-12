import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { BasePeer } from "../src/hub/peers.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { classifyPeerCommand, cliCommandLabel } from "../src/cli/identity.ts";

class Peer extends BasePeer {
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(_envs: Envelope[]) {}
}
async function cli(root: string, args: string[]) {
  const file=join(root,`cli-${crypto.randomUUID()}.ts`),entry=join(import.meta.dir,"../src/cli/main.ts");
  writeFileSync(file,`for(const key of Object.keys(process.env))if(key.startsWith("AGENTHUB_")||["CODEX_THREAD_ID","CLAUDECODE","CLAUDE_CODE_SESSION_ID"].includes(key))delete process.env[key];process.env.AGENTHUB_HOME=${JSON.stringify(join(root,"home"))};process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`);
  const child=Bun.spawn([process.execPath,file],{cwd:root,stdin:"ignore",stdout:"pipe",stderr:"pipe"}),timer=setTimeout(()=>child.kill("SIGKILL"),5000);
  try {const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}finally{clearTimeout(timer);}
}
type Snapshot = { ok: boolean; tasks: { id: number; state: string; owner: string | null; reserved?: string | null; planningRevision: number }[]; boardLegend: { peer: string; wip: number; wipLimit: number }[]; status: { peers: Record<string, {wip: number; wipLimit: number}> } };
test("planner pull surfaces enforce role revisions and shared WIP status through HTTP (#263)", async () => {
  const root=mkdtempSync(join(tmpdir(),"ahub-pull-surfaces-")),stateDir=join(root,".agenthub/state");
  const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,config:{...DEFAULT_CONFIG,memory:{...DEFAULT_CONFIG.memory,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false},tasks:{...DEFAULT_CONFIG.tasks,wip_limits:{codex:1,claude:0}},roles:{claude:["planner"],codex:["implementer"]},batch_ms:0}});
  const person=await ControlClient.connect(stateDir,{role:"console"}),planner=await ControlClient.connect(stateDir,{role:"tools",peer:"claude"}),other=await ControlClient.connect(stateDir,{role:"tools",peer:"codex"});
  try {
    const peer=new Peer("codex");daemon.bus.add(peer);await peer.start();
    const opened=await person.request({t:"ui"}),url=new URL(opened.url),origin=url.origin;
    const session=await fetch(origin+"/session",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({ticket:url.hash.slice(1)})});expect(session.status).toBe(200);
    const cookie=session.headers.get("set-cookie")!.split(";")[0]!;
    const post=async(path:string,body:unknown={})=>(await fetch(origin+"/"+path,{method:"POST",headers:{origin,cookie,"content-type":"application/json"},body:JSON.stringify(body)})).json() as Promise<Snapshot>;
    expect(await post("action",{action:"propose",title:"first",class:"implement",backlog:true})).toMatchObject({ok:true});
    const id=(await post("snapshot")).tasks[0]!.id;
    expect(await other.request({t:"task",op:"hub_backlog_pull",args:{id,revision:0,reason:"ready"}})).toMatchObject({ok:false});
    expect(await planner.request({t:"task",op:"hub_backlog_pull",args:{id,revision:0,reason:"ready"}})).toMatchObject({ok:true});
    const reserved=await post("snapshot");expect(reserved.tasks[0]).toMatchObject({state:"proposed",owner:null,reserved:"codex",planningRevision:1});
    expect(reserved.boardLegend.find(row=>row.peer==="codex")).toMatchObject({wip:1,wipLimit:1});expect(reserved.status.peers.codex).toMatchObject({wip:1,wipLimit:1});
    expect(await post("action",{action:"planning_undo",id,revision:1})).toMatchObject({ok:true});
    expect(await post("action",{action:"planner_pull",id,revision:2,reason:"person queued ready work"})).toMatchObject({ok:true});
    expect(await post("action",{action:"planner_pull",id,revision:2,reason:"stale"})).toMatchObject({ok:false});
    expect(await post("action",{action:"planning_undo",id,revision:3})).toMatchObject({ok:true});
    const pulled=await cli(root,["backlog","pull-ready",String(id),"4","person queued via CLI"]);expect(pulled.code).toBe(0);expect(JSON.parse(pulled.stdout)).toMatchObject({id,state:"proposed",owner:null,reserved:"codex",planningRevision:5});
    expect(classifyPeerCommand("backlog",["pull-ready",String(id),"2","ready"])).toBe("console");expect(cliCommandLabel("backlog",["pull-ready","private"])).toBe("backlog pull-ready");
  } finally {other.close();planner.close();person.close();await daemon.stop();rmSync(root,{recursive:true,force:true});}
},20_000);
