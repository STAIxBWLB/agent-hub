import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
type Snapshot = { ok: boolean; tasks: { id: number; state: string; owner: string | null; reserved?: string | null; planningRevision: number }[]; boardLegend: { peer: string; wip: number; wipLimit: number }[]; status: { peers: Record<string, {wip: number; wipLimit: number}> } };
test("planner pull surfaces enforce role revisions and shared WIP status through HTTP (#263)", async () => {
  const root=mkdtempSync(join(tmpdir(),"ahub-pull-surfaces-")),stateDir=join(root,"state");
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
    expect(classifyPeerCommand("backlog",["pull-ready",String(id),"2","ready"])).toBe("console");expect(cliCommandLabel("backlog",["pull-ready","private"])).toBe("backlog pull-ready");
  } finally {other.close();planner.close();person.close();await daemon.stop();rmSync(root,{recursive:true,force:true});}
},20_000);
