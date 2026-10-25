import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAvailable } from "../src/local/sandbox.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import type { PiPeer } from "../src/adapters/pi.ts";
import { ShellExecutionProofs } from "../src/hub/read-only-shell-proof.ts";
import { realPath } from "../src/hub/project.ts";
import { startFakeModelServer, toolCall } from "./fakes/model-server.ts";

const cleanup:(()=>unknown)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function until(check:()=>boolean){for(let n=0;n<150&&!check();n++)await Bun.sleep(5);expect(check()).toBe(true);}
async function rig(peer:"pi"|"local",unattended=false,rebind=false){
  const root=realPath(mkdtempSync(join(tmpdir(),"ahub-readonly-permit-"))),stateDir=join(root,"state");cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const oldHome=process.env.HOME;process.env.HOME=root;cleanup.push(()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;});
  expect(hubGitSync(["init","-q",root],{encoding:"utf8"}).status).toBe(0);
  mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.txt"),"synthetic public input\n");
  const oldKey=process.env.OMNIROUTE_API_KEY;process.env.OMNIROUTE_API_KEY="readonly-fixture-key";cleanup.push(()=>{if(oldKey===undefined)delete process.env.OMNIROUTE_API_KEY;else process.env.OMNIROUTE_API_KEY=oldKey;});
  let command="pwd",seq=0;
  const model=startFakeModelServer({key:"readonly-fixture-key",script:body=>body.messages.at(-1)?.role==="tool"?{content:`result: ${body.messages.at(-1)?.content}`}:{tool_calls:[toolCall("bash",{command,timeout_s:1})]}});cleanup.push(model.stop);
  let rebound=false;
  if(rebind){
    const record=ShellExecutionProofs.prototype.readonly;
    ShellExecutionProofs.prototype.readonly=function(...args){record.apply(this,args);if(!rebound){rebound=true;renameSync(join(root,"src"),join(root,"old-src"));mkdirSync(join(root,"src"));writeFileSync(join(root,"src/a.txt"),"replacement\n");}};
    cleanup.push(()=>{ShellExecutionProofs.prototype.readonly=record;});
  }
  const daemon=await startDaemon({cwd:root,stateDir,controlPort:0,codexAppPort:0,codexProxyPort:0,permissionTimeoutMs:700,unattended,notifier:()=>{},
    config:{...DEFAULT_CONFIG,batch_ms:0,memory:{...DEFAULT_CONFIG.memory,enabled:false,native:false},snapshots:{...DEFAULT_CONFIG.snapshots,enabled:false},inference:{...DEFAULT_CONFIG.inference,enabled:false,triage:false},mlx:{...DEFAULT_CONFIG.mlx,enabled:false},omniroute:{...DEFAULT_CONFIG.omniroute,urls:[model.url],access_hosts:[]},pi:{...DEFAULT_CONFIG.pi,enabled:peer==="pi",auto_start:false,cmd:[process.execPath,join(import.meta.dir,"fakes/pi-rpc.ts")]}}});cleanup.push(()=>daemon.stop());
  const client=await ControlClient.connect(stateDir,{role:"console"});cleanup.push(()=>client.close());const asks:any[]=[],answers:string[]=[];
  client.onPush=row=>{if(row.t==="permission")asks.push(row);};client.send({t:"tail"});daemon.bus.tap(event=>{if(event.t==="envelope"&&event.env.from===peer)answers.push(event.env.body);});
  expect((await client.request({t:"start",peer,args:peer==="pi"?{mode:"headless"}:{model:"vllm/test"}})).ok).toBe(true);await until(()=>daemon.bus.stateOf(peer)==="idle");
  const mode=async(value:string)=>expect((await client.request({t:"permission",peer,mode:value,confirmed:true})).permissionMode).toBe(value);
  const call=async(value:string)=>{
    command=value;
    if(peer==="pi"){
      const pi=daemon.bus.peers.get(peer) as PiPeer,bridge=(pi as any).tuiLaunch.env;
      return (await fetch(`${bridge.AGENTHUB_PI_BRIDGE_URL}/tool`,{method:"POST",headers:{authorization:`Bearer ${bridge.AGENTHUB_PI_BRIDGE_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({name:"bash",args:{command:value,timeout_s:1},toolCallId:`readonly-${++seq}`,sessionId:pi.recoveryMetadata().sessionId,generation:(pi as any).budgetGeneration})})).json() as Promise<{text:string}>;
    }
    const n=answers.length;expect((await client.request({t:"send",body:`read-only fixture ${++seq}`,to:[peer]})).ok).toBe(true);await until(()=>answers.length>n&&daemon.bus.stateOf(peer)==="idle");return{text:answers.at(-1)!};
  };
  const deny=async(pending:Promise<{text:string}>,n:number)=>{await until(()=>asks.length===n+1);expect((await client.request({t:"permit",id:asks[n].id,option:"deny",surface:"console"})).ok).toBe(true);expect((await pending).text).toContain("did not approve");};
  return{root,stateDir,daemon,client,asks,mode,call,deny};
}

for(const peer of ["pi","local"] as const)test(`${peer} host permit automatically grants safe reads only in ask-when-needed and keeps unsafe forms asking`,async()=>{
  const r=await rig(peer);await r.mode("ask-when-needed");
  for(const command of ["pwd","cat src/a.txt","head -n 1 src/a.txt","tail -n 1 src/a.txt","wc -l src/a.txt","ls -la src","grep -n synthetic src/a.txt","find src -type f -print","stat src/a.txt","file src/a.txt","git status --short","git log --oneline -n 1","git rev-parse --show-toplevel","git ls-files","git branch --list","git describe --always","git cat-file -t HEAD","git diff --no-ext-diff --no-textconv","git show --no-ext-diff --no-textconv HEAD"]){const before=r.asks.length,result=await r.call(command);expect(r.asks,command).toHaveLength(before);
    for(const refusal of ["approval expired","approval withdrawn","turn cancelled","proof remained unstable"])expect(result.text,command).not.toContain(refusal);
    if(!sandboxAvailable())expect(result.text,command).toContain("needs macOS sandbox-exec");
    else if(command==="cat src/a.txt"){expect(result.text).toContain("synthetic public input");expect(result.text).toContain("(exit 0)");}}
  for(const command of ["cat /etc/passwd","find src -delete","git -c core.fsmonitor=x status","git commit -m x","ls --unknown","sh -c pwd","cat src/a.txt | wc -l","cat src/a.txt > output"]){const n=r.asks.length;await r.deny(r.call(command),n);}
  await r.mode("ask");await r.deny(r.call("cat src/a.txt"),r.asks.length);
  await r.mode("never-ask");const n=r.asks.length;await r.call("printf ordinary");expect(r.asks).toHaveLength(n);
  const publicEvents=readFileSync(join(r.stateDir,"events.jsonl"),"utf8");expect(publicEvents).not.toContain("synthetic public input");
});

for(const peer of ["pi","local"] as const)test(`${peer} changed read proof asks a person even unattended, initial unattended behavior stays unchanged`,async()=>{
  const r=await rig(peer,true,true);await r.mode("ask-when-needed");
  await r.deny(r.call("cat src/a.txt"),0);expect(r.asks[0].classed).not.toBe(true);
  await r.mode("ask");const n=r.asks.length;await r.call("pwd");expect(r.asks).toHaveLength(n);
});
